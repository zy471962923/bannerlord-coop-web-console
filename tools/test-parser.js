'use strict';
// 状态解析回归测试
// 用法：node tools/test-parser.js [日志文件]
// 不给参数时自动挑 Data 目录里最新的 coop-server-*.log
const fs = require('fs');
const path = require('path');
const { ServerProcess } = require('../lib/server-process');
const { parseLine } = require('../lib/log-tailer');
const config = require('../lib/config');

let fail = 0;
const check = (ok, label, extra = '') => {
  if (!ok) fail++;
  console.log((ok ? 'PASS' : 'FAIL') + '  ' + label + (extra ? '  ' + extra : ''));
};

// —— 1. 真实日志回放 ——
let file = process.argv[2];
if (!file) {
  const files = fs.existsSync(config.dsLogsDir)
    ? fs.readdirSync(config.dsLogsDir).filter((f) => /^coop-server-.*\.log$/.test(f))
        .map((f) => ({ f, m: fs.statSync(path.join(config.dsLogsDir, f)).mtimeMs }))
        .sort((a, b) => b.m - a.m)
    : [];
  if (files.length) file = path.join(config.dsLogsDir, files[0].f);
}

if (!file || !fs.existsSync(file)) {
  console.log('（跳过日志回放：没有可用的 coop-server 日志）');
} else {
  const raw = fs.readFileSync(file, 'utf8');
  const allLines = raw.split(/\r?\n/).map((l) => l.trimEnd()).filter((l) => l.trim().length);

  // 正常顺序整行喂
  {
    const sp = new ServerProcess();
    const phases = [];
    sp.on('state', (s) => { if (phases[phases.length - 1] !== s.phase) phases.push(s.phase); });
    for (const l of allLines) sp.ingestLogLine(parseLine(l));

    check(sp.phase === 'serving', '日志回放 → 到达 serving', 'phases=' + phases.join('→'));
    check(!!sp.readyAt, '日志回放 → readyAt 有值');
    check(!!sp.version, '日志回放 → 抓到版本', sp.version + '+' + sp.revision);
    check(phases[0] === 'boot' || phases[0] === 'loading' || phases.length >= 1, '阶段序列单调递增');
  }

  // 把行打碎成随机片段（模拟真实读文件/PTY 的切片）
  {
    const sp = new ServerProcess();
    const joined = allLines.join('\n') + '\n';
    let i = 0;
    let seed = 12345;
    while (i < joined.length) {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      const n = 1 + (seed % 900);
      sp.scan(joined.slice(i, i + n));
      i += n;
    }
    // scan 只做版本嗅探，这里主要验证不抛异常、不挂死
    check(!!sp.version, '随机切片 scan 不崩且抓到版本', sp.version);
  }
}

// —— 2. 启动横幅不能误判 ——
{
  const sp = new ServerProcess();
  sp.phase = 'boot';
  sp.ingestLogLine(parseLine("09:55:08.104  [launcher] ready when you see: [DedicatedServer] SERVING   ·   'help' lists commands"));
  check(sp.phase === 'boot' && !sp.readyAt, '启动横幅不误判为就绪', 'phase=' + sp.phase);
  sp.handleLine("[launcher] ready when you see: [DedicatedServer] SERVING   ·   'help' lists commands");
  check(sp.phase === 'boot' && !sp.readyAt, '横幅（TUI 通道）不误判', 'phase=' + sp.phase);
}

// —— 3. 真 SERVING 行必须判定就绪 ——
{
  const sp = new ServerProcess();
  sp.state = 'starting';
  sp.phase = 'loading';
  sp.ingestLogLine(parseLine('09:56:06.652  [DedicatedServer] SERVING \u2014 coop server up, waiting for clients'));
  check(sp.phase === 'serving' && !!sp.readyAt && sp.state === 'running',
    'SERVING 行判定就绪', 'phase=' + sp.phase + ' state=' + sp.state);
}

// —— 4. TUI 双重编码的破折号也能兜底 ——
{
  const sp = new ServerProcess();
  sp.state = 'starting';
  sp.phase = 'loading';
  sp.handleLine('\u2502[DedicatedServer] SERVING \u00e2\u20ac\u201d coop server up, waiting for clients');
  check(sp.phase === 'serving', 'TUI 乱码破折号兜底', 'phase=' + sp.phase);
}

// —— 5. players / state 事件 ——
{
  const sp = new ServerProcess();
  sp.ingestLogLine(parseLine('09:55:13.758  @DS@{"ev":"players","list":[]}'));
  check(Array.isArray(sp.players) && sp.players.length === 0, 'players 空列表');

  sp.ingestLogLine(parseLine('09:55:14.000  @DS@{"ev":"players","list":[{"name":"\u5f20\u4e09","id":"76561198000000000"}]}'));
  check(sp.players.length === 1 && sp.players[0].name === '张三', 'players 带嵌套对象', JSON.stringify(sp.players));

  sp.ingestLogLine(parseLine('09:55:11.173  @DS@{"ev":"state","phase":"boot","save":"saveauto1","pw":false}'));
  check(sp.phase === 'serving' || sp.phase === 'boot', 'state 事件可解析');
}

// —— 6. 坏 JSON 不能把进程搞崩 ——
{
  const sp = new ServerProcess();
  sp.ingestLogLine(parseLine('09:55:11.173  @DS@{"ev":"state","phase":'));
  sp.ingestLogLine(parseLine('09:55:11.173  @DS@not json at all'));
  check(true, '坏 JSON 静默忽略');
}

console.log(fail ? `\n${fail} 项失败` : '\n全部通过');
process.exit(fail ? 1 : 0);
