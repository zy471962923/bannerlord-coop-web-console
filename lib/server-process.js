'use strict';
// 服务端进程管理器：用真 PTY 承载 launcher 的 TUI。
//
// 为什么必须用 PTY（踩过的坑，写在这里免得以后重犯）：
//   1. 服务端 TUI 与「stdin/stdout 被重定向」互斥。用 child_process.spawn + pipe
//      抓输出，launcher 会自动进入 --no-tui 模式，而这个模式在本机永远到不了
//      SERVING（日志停在 ~1228 字节、UDP 端口却已绑定，极具误导性）。
//   2. 所以既要拿到 TUI 输出、又要能下发控制台命令，只能给它一个真正的伪终端。
//      node-pty(ConPTY) 实测可以：launcher → dotnet starter 全程正常，约 60s 到 SERVING。
const { EventEmitter } = require('events');
const fs = require('fs');
const pty = require('node-pty');
const config = require('./config');
const procs = require('./procs');

const RING_MAX = 512 * 1024;

class ServerProcess extends EventEmitter {
  constructor() {
    super();
    this.pty = null;
    this.state = 'stopped'; // stopped | starting | running | stopping
    this.phase = null;      // boot | loading | serving（来自 @DS@ state 事件）
    this.players = [];
    this.startedAt = null;
    this.exitCode = null;
    this.lastError = null;
    this.ring = '';
    this.readyAt = null;
    this.version = '';
    this.revision = '';
    this.lineBuf = '';
    // 世界心跳：日志里每 ~14 秒一条 "pulse: time=... timeMode=... players=N parties=..."
    // 这是唯一能拿到「游戏内日期 / 时间是否在流逝 / 全图部队数」的地方，玩家面板顶栏要用
    this.world = null;
  }

  get running() { return !!this.pty; }
  get pid() { return this.pty ? this.pty.pid : 0; }

  snapshot() {
    return {
      state: this.state,
      phase: this.phase,
      running: this.running,
      pid: this.pid,
      startedAt: this.startedAt,
      readyAt: this.readyAt,
      uptimeMs: this.startedAt ? Date.now() - this.startedAt : 0,
      exitCode: this.exitCode,
      lastError: this.lastError,
      players: this.players,
      version: this.version,
      revision: this.revision,
      world: this.world,
      ptyCols: config.ptyCols,
      ptyRows: config.ptyRows,
    };
  }

  setState(s, extra) {
    if (this.state === s && !extra) return;
    this.state = s;
    this.emit('state', this.snapshot());
  }

  start() {
    if (this.pty) return { ok: false, error: '服务器已在运行' };
    if (!fs.existsSync(config.serverExe)) {
      return { ok: false, error: '找不到启动器：' + config.serverExe };
    }

    this.exitCode = null;
    this.lastError = null;
    this.phase = 'boot';
    this.players = [];
    this.world = null;
    this.readyAt = null;
    this.ring = '';
    this.lineBuf = '';
    this.startedAt = Date.now();
    this.setState('starting');

    try {
      this.pty = pty.spawn(config.serverExe, [], {
        name: 'xterm-256color',
        cols: config.ptyCols,
        rows: config.ptyRows,
        cwd: config.serverDir,
        env: Object.assign({}, process.env, { TERM: 'xterm-256color' }),
        useConpty: true,
      });
    } catch (e) {
      this.pty = null;
      this.startedAt = null;
      this.lastError = e.message;
      this.setState('stopped');
      return { ok: false, error: e.message };
    }

    this.emit('log', '[console] 已启动服务端进程 pid=' + this.pty.pid);

    this.pty.onData((d) => {
      this.ring += d;
      if (this.ring.length > RING_MAX) this.ring = this.ring.slice(-RING_MAX);
      this.emit('data', d);
      this.scan(d);
    });

    this.pty.onExit((e) => {
      const code = e && typeof e.exitCode === 'number' ? e.exitCode : -1;
      this.exitCode = code;
      this.pty = null;
      this.phase = 'stopped';
      this.players = [];
      this.world = null;
      this.startedAt = null;
      this.readyAt = null;
      this.emit('log', '[console] 服务端进程已退出，退出码 ' + code);
      this.setState('stopped');
      procs.invalidate();
    });

    return { ok: true, pid: this.pty.pid };
  }

  // 从原始输出里嗅探阶段、版本与玩家列表。
  // 按「完整行」解析而不是按 chunk 里的花括号找 —— PTY 切片是任意的，
  // 之前按 chunk 直接找 '}' 会把跨片的 JSON 全部丢掉（表现为 phase 永远停在 boot）。
  scan(chunk) {
    this.lineBuf += chunk;
    if (this.lineBuf.length > 65536) this.lineBuf = this.lineBuf.slice(-32768);

    let idx;
    while ((idx = this.lineBuf.search(/[\r\n]/)) >= 0) {
      // Windows 换行可能是 \r\n，先吃掉 \r
      let skip = 1;
      if (this.lineBuf[idx] === '\r' && this.lineBuf[idx + 1] === '\n') skip = 2;
      const line = this.lineBuf.slice(0, idx);
      this.lineBuf = this.lineBuf.slice(idx + skip);
      if (line) this.handleLine(line);
    }
  }

  // TUI 流只用来做版本嗅探；阶段/玩家一律以日志文件为准（见 ingestLogLine）。
  handleLine(line) {
    this.detectVersion(line);

    // 启动横幅里也有一句 "ready when you see: [DedicatedServer] SERVING"，
    // 直接 includes('SERVING') 会在第 0 秒就误判就绪。而且 TUI 流里的破折号
    // 被 launcher 双重编码成了 "â€”"，所以这里只做保守兜底：必须不是 launcher 横幅。
    if (this.phase !== 'serving' && !/\[launcher\]|ready when you see/.test(line) &&
        /\[DedicatedServer\] SERVING\b/.test(line)) {
      this.markServing();
    }
  }

  detectVersion(text) {
    if (this.version) return;
    const mv = text.match(/BannerlordCoop build ([\d.]+)\+([0-9a-f]{6,})/);
    if (!mv) return;
    this.version = mv[1];
    this.revision = mv[2].slice(0, 7);
    this.emit('state', this.snapshot());
  }

  // 日志文件是权威来源：干净 UTF-8、逐行、带时间戳，@DS@ 事件与 SERVING 都在这里
  ingestLogLine(line) {
    const msg = typeof line === 'string' ? line : (line && line.msg) || '';
    if (!msg) return;
    this.detectVersion(msg);

    if (this.phase !== 'serving' && /\[DedicatedServer\] SERVING\b/.test(msg) &&
        !/\[launcher\]|ready when you see/.test(msg)) {
      this.markServing();
    }

    // pulse 行没有 @DS@ 前缀，必须在下面那个 early return 之前处理
    if (msg.indexOf('pulse:') >= 0) this.ingestPulse(msg);

    const at = msg.indexOf('@DS@');
    if (at < 0) return;
    const brace = msg.indexOf('{', at);
    if (brace < 0) return;
    const end = msg.lastIndexOf('}');
    if (end <= brace) return;
    let ev;
    try { ev = JSON.parse(msg.slice(brace, end + 1)); } catch (_) { return; }
    this.applyEvent(ev);
  }

  // pulse: time=Autumn 19, 1087 timeMode=Stop players=0 parties=1511 mapEvents=9 mainParty=657.95,279.08
  // 游戏内日期本身带逗号和空格，所以 time 用非贪婪匹配到 " timeMode=" 为止
  ingestPulse(msg) {
    const m = String(msg).match(
      /pulse:\s*time=(.+?)\s+timeMode=(\w+)\s+players=(\d+)\s+parties=(\d+)\s+mapEvents=(\d+)\s+mainParty=(-?[\d.]+),(-?[\d.]+)/
    );
    if (!m) return;
    const next = {
      date: m[1].trim(),
      timeMode: m[2],
      players: Number(m[3]),
      parties: Number(m[4]),
      mapEvents: Number(m[5]),
      mainParty: { x: Number(m[6]), y: Number(m[7]) },
      at: Date.now(),
    };
    const prev = this.world;
    this.world = next;
    // 只在「看得出变化」时推一次，避免每 14 秒无谓刷屏
    if (!prev || prev.date !== next.date || prev.timeMode !== next.timeMode || prev.players !== next.players) {
      this.emit('world', next);
    }
  }

  markServing() {
    this.phase = 'serving';
    if (!this.readyAt) this.readyAt = Date.now();
    if (this.state === 'starting') this.state = 'running';
    this.emit('log', '[console] 服务端已就绪（SERVING）');
    this.emit('state', this.snapshot());
  }

  applyEvent(ev) {
    if (ev.ev === 'state') {
      const changed = ev.phase !== this.phase;
      this.phase = ev.phase;
      if (ev.phase === 'serving') {
        if (!this.readyAt) this.readyAt = Date.now();
        if (this.state === 'starting') this.state = 'running';
      }
      if (changed) this.emit('state', this.snapshot());
    } else if (ev.ev === 'players') {
      this.players = Array.isArray(ev.list) ? ev.list : [];
      this.emit('state', this.snapshot());
    } else if (ev.ev === 'commands') {
      this.emit('commands', ev);
    }
  }

  // 下发控制台命令（自动补 \r）
  send(cmd) {
    if (!this.pty) return { ok: false, error: '服务器未运行' };
    const line = String(cmd).replace(/[\r\n]+$/, '');
    if (!line.trim()) return { ok: false, error: '空命令' };
    this.pty.write(line + '\r');
    this.emit('log', '[console] → ' + line);
    return { ok: true };
  }

  // 先礼后兵：发 stop，等它自己退；超时强杀整棵进程树
  async stop({ force = false } = {}) {
    if (!this.pty) return { ok: false, error: '服务器未运行' };
    if (this.state === 'stopping') return { ok: true, note: '正在停止' };
    const pid = this.pty.pid;
    this.setState('stopping');

    if (force) {
      this.emit('log', '[console] 强制结束进程树 pid=' + pid);
      await procs.killTree(pid);
      return { ok: true, forced: true };
    }

    try { this.pty.write('stop\r'); } catch (_) {}
    this.emit('log', '[console] → stop（等待服务器自行退出）');

    const deadline = Date.now() + config.stopGraceMs;
    while (this.pty && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 400));
    }
    if (this.pty) {
      this.emit('log', '[console] 等待超时，强制结束进程树 pid=' + pid);
      await procs.killTree(pid);
      return { ok: true, forced: true };
    }
    return { ok: true };
  }

  async forceKill() {
    const pid = this.pid;
    if (!pid) return { ok: false, error: '服务器未运行' };
    await procs.killTree(pid);
    return { ok: true };
  }
}

module.exports = { ServerProcess };
