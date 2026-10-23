'use strict';
// Bannerlord Coop 专用服务器 —— Web 控制台
// 零框架：http + SSE，唯一外部依赖是 node-pty（承载服务端 TUI）。
const http = require('http');
const fs = require('fs');
const path = require('path');
const url = require('url');
const os = require('os');

const config = require('./lib/config');
const consoleConfig = require('./lib/console-config');
const { ServerProcess } = require('./lib/server-process');
const { LogTailer } = require('./lib/log-tailer');
const { parseJsonc } = require('./lib/jsonc');
const saves = require('./lib/saves');
const procs = require('./lib/procs');
const playersLib = require('./lib/players');
const playercards = require('./lib/playercards');
const mapLib = require('./lib/map');

const PUBLIC_DIR = path.join(__dirname, 'public');

// ——————————————— 监听地址 ———————————————
// COOP_CONSOLE_HOST 支持三种写法：
//   0.0.0.0                   全网卡（默认）—— 谁能连上这台机器就能打开面板
//   127.0.0.1                 只本机
//   auto  /  127.0.0.1,192.168.1.10   按列表逐个 bind
// auto = 回环 + 所有「私有网段」IPv4（ZeroTier/WLAN/企业内网），公网网卡不 bind。
// 默认值就是 0.0.0.0，不做来源过滤 —— 需要收紧的场合自己改成 auto 或具体地址。
const LOOPBACK_HOSTS = ['127.0.0.1', 'localhost', '::1'];

function isPrivateV4(ip) {
  const p = ip.split('.').map(Number);
  if (p.length !== 4) return false;
  if (p[0] === 10) return true;
  if (p[0] === 192 && p[1] === 168) return true;
  if (p[0] === 172 && p[1] >= 16 && p[1] <= 31) return true;
  if (p[0] === 100 && p[1] >= 64 && p[1] <= 127) return true; // CGNAT，ZeroTier 常用
  return false;
}

function autoHosts() {
  const out = ['127.0.0.1'];
  const ifaces = os.networkInterfaces();
  for (const name of Object.keys(ifaces)) {
    for (const i of ifaces[name] || []) {
      if (i.family !== 'IPv4' || i.internal) continue;
      if (i.address.startsWith('169.254.')) continue;
      if (!isPrivateV4(i.address)) continue;
      if (!out.includes(i.address)) out.push(i.address);
    }
  }
  return out;
}

function resolveHosts() {
  const raw = String(config.httpHost || '127.0.0.1').trim();
  if (raw === 'auto') return autoHosts();
  if (raw === '0.0.0.0') return ['0.0.0.0'];
  return raw.split(',').map((s) => s.trim()).filter(Boolean);
}

const BIND_HOSTS = resolveHosts();
const EXPOSED = BIND_HOSTS.some((h) => !LOOPBACK_HOSTS.includes(h));

// ——————————————— 访问口令（默认关闭）———————————————
// 默认无口令：这套东西跑在 ZeroTier / 内网里，都是自己人。
// 万一哪天要放到不受信任的网络，设 COOP_CONSOLE_TOKEN 即可开启校验，
// 同时支持 ?token= / Cookie / X-Console-Token 头三种带法。
const TOKEN = (process.env.COOP_CONSOLE_TOKEN || '').trim();
const COOKIE_NAME = 'coop_console_token';

function cookieValue(req, name) {
  const raw = req.headers.cookie || '';
  for (const part of raw.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    if (part.slice(0, i).trim() !== name) continue;
    return decodeURIComponent(part.slice(i + 1).trim());
  }
  return '';
}

function loginPage() {
  return `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8">
<title>需要口令 · Bannerlord Coop 控制台</title>
<style>
  body{margin:0;height:100vh;display:grid;place-items:center;background:#0d1117;color:#dfe7ef;
       font-family:'Segoe UI','Microsoft YaHei',system-ui,sans-serif}
  .box{width:340px;padding:26px;border:1px solid #24313f;border-radius:12px;background:#161e28}
  h1{margin:0 0 6px;font-size:16px}
  p{margin:0 0 18px;font-size:12.5px;color:#93a3b5;line-height:1.7}
  input{width:100%;padding:9px 12px;border-radius:7px;border:1px solid #24313f;background:#0e151d;
        color:#dfe7ef;outline:none;box-sizing:border-box;font-size:13px}
  input:focus{border-color:#4dc9d6}
  button{margin-top:12px;width:100%;padding:9px;border-radius:7px;border:1px solid #2f9aa8;
         background:linear-gradient(180deg,#2a8f9c,#1f7480);color:#eafcff;font-weight:600;cursor:pointer;font-size:13px}
  code{font-family:Consolas,monospace;color:#8fd4ff}
</style></head><body>
<div class="box">
  <h1>需要访问口令</h1>
  <p>这个控制台能起停服务器、恢复存档，所以对外监听时必须带口令。<br>
     口令是启动控制台时通过 <code>COOP_CONSOLE_TOKEN</code> 环境变量设的那个值。</p>
  <form method="GET" action="/">
    <input name="token" placeholder="粘贴口令" autofocus autocomplete="off">
    <button type="submit">进入控制台</button>
  </form>
</div></body></html>`;
}

// 对外监听时，把本机所有非回环 IPv4 列出来，方便直接抄地址
function lanAddresses() {
  const out = [];
  const ifaces = os.networkInterfaces();
  for (const name of Object.keys(ifaces)) {
    for (const info of ifaces[name] || []) {
      if (info.family !== 'IPv4' || info.internal) continue;
      if (info.address.startsWith('169.254.')) continue; // APIPA
      out.push({ name, address: info.address });
    }
  }
  return out;
}

const server = new ServerProcess();
const tailer = new LogTailer(config.dsLogsDir, 6000);

// ——————————————————————————— SSE 客户端池 ———————————————————————————

const sseClients = new Set();   // 结构化事件
const tuiClients = new Set();   // 原始 TUI 数据

function sseWrite(res, event, data) {
  try {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  } catch (_) {}
}

function broadcast(event, data) {
  for (const res of sseClients) sseWrite(res, event, data);
}

// —— TUI 原始数据：攒 120ms 再发，避免每个字节都推一次 ——
let tuiBuf = [];
let tuiTimer = null;

function pushTui(chunk) {
  if (tuiClients.size === 0) return;
  tuiBuf.push(Buffer.from(chunk, 'utf8'));
  if (tuiTimer) return;
  tuiTimer = setTimeout(() => {
    tuiTimer = null;
    if (!tuiBuf.length) return;
    const payload = Buffer.concat(tuiBuf).toString('base64');
    tuiBuf = [];
    for (const res of tuiClients) {
      try { res.write(`event: tui\ndata: ${payload}\n\n`); } catch (_) {}
    }
  }, 120);
}

server.on('data', pushTui);
server.on('state', (s) => broadcast('state', s));
server.on('world', (w) => broadcast('world', w));
server.on('log', (line) => {
  broadcast('console', { time: new Date().toTimeString().slice(0, 8), msg: line });
});
server.on('commands', (ev) => {
  // 服务端每次启动会自报命令表，顺手更新本地 commands.json 的 game 段
  try {
    if (Array.isArray(ev.game) && ev.game.length) {
      const file = path.join(config.dataDir, 'commands.json');
      const cur = JSON.parse(fs.readFileSync(file, 'utf8'));
      cur.builtin = Array.isArray(ev.builtin) && ev.builtin.length ? ev.builtin : cur.builtin;
      cur.game = ev.game;
      cur.updatedAt = new Date().toISOString();
      fs.writeFileSync(file, JSON.stringify(cur, null, 1), 'utf8');
      broadcast('commands', cur);
    }
  } catch (e) {
    console.warn('[console] 更新 commands.json 失败: ' + e.message);
  }
});

tailer.on('lines', (lines) => {
  // 状态/玩家/命令表都以日志文件为准（PTY 流里 @DS@ 不出现，破折号还被二次编码）
  for (const l of lines) server.ingestLogLine(l);
  broadcast('log', lines);
});
tailer.on('file', (name) => broadcast('logfile', { name }));

// ——————————————————————————— 工具函数 ———————————————————————————

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
};

function sendJson(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

function readBody(req, limit = 1024 * 256) {
  return new Promise((resolve) => {
    let buf = '';
    req.on('data', (c) => {
      buf += c;
      if (buf.length > limit) { req.destroy(); resolve({}); }
    });
    req.on('end', () => {
      try { resolve(buf ? JSON.parse(buf) : {}); } catch (_) { resolve({}); }
    });
  });
}

function serveStatic(req, res, pathname) {
  const rel = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
  const full = path.join(PUBLIC_DIR, rel);
  if (!full.startsWith(PUBLIC_DIR)) { res.writeHead(403); return res.end('forbidden'); }
  fs.readFile(full, (err, data) => {
    if (err) { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); return res.end('404'); }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(full).toLowerCase()] || 'application/octet-stream',
      'Cache-Control': 'no-cache',
    });
    res.end(data);
  });
}

function readServerConfig() {
  try {
    const raw = fs.readFileSync(config.serverConfig, 'utf8');
    return parseJsonc(raw);
  } catch (e) {
    return { _error: e.message };
  }
}

function readModConfig() {
  try {
    return parseJsonc(fs.readFileSync(config.modConfig, 'utf8'));
  } catch (e) {
    return { _error: e.message };
  }
}

let cachedCommands = null;
function readCommands() {
  if (cachedCommands) return cachedCommands;
  try {
    cachedCommands = JSON.parse(fs.readFileSync(path.join(config.dataDir, 'commands.json'), 'utf8'));
  } catch (_) {
    cachedCommands = { builtin: [], game: [] };
  }
  return cachedCommands;
}

// ——————————————————————————— 路由 ———————————————————————————

const serverInfo = () => new Promise(async (resolve) => {
  const snap = server.snapshot();
  const port = await procs.probeGamePort(config.gamePort);
  // 端口被占但本控制台没进程 → 是外部启动的实例
  const external = !snap.running && port.bound;
  resolve(Object.assign({}, snap, {
    external,
    externalPid: external ? port.pid : 0,
    externalName: external ? port.name : '',
    gamePort: config.gamePort,
    httpPort: config.httpPort,
    consolePid: process.pid,
  }));
});

const routes = [
  ['GET', /^\/api\/status$/, async (req, res) => {
    sendJson(res, 200, await serverInfo());
  }],

  ['GET', /^\/api\/config$/, (req, res) => {
    const sc = readServerConfig();
    const mc = readModConfig();
    sendJson(res, 200, {
      serverConfig: sc,
      serverConfigPath: config.serverConfig,
      modConfigPath: config.modConfig,
      coopSettings: (mc && mc.modOptions) || {},
      paths: {
        serverDir: config.serverDir,
        savesDir: config.savesDir,
        logsDir: config.dsLogsDir,
        backupDir: config.backupDir,
        playercardsFile: config.playercardsFile,
      },
      // 配置来源与自检（换机/分发时先看这里）
      configFile: config.configFile,
      configFileExists: config.configFileExists,
      issues: config.check(),
    });
  }],

  // —— 控制台自身配置的读写（配置页表单用）——
  ['GET', /^\/api\/console-config$/, (req, res) => {
    try { sendJson(res, 200, consoleConfig.describe()); }
    catch (e) { sendJson(res, 500, { ok: false, error: e.message }); }
  }],

  ['POST', /^\/api\/console-config$/, async (req, res) => {
    const body = await readBody(req);
    try {
      // dryRun：只校验不落盘，页面用来实时提示
      if (body && body.dryRun) {
        const v = consoleConfig.validate(body.values || body);
        return sendJson(res, 200, { ok: v.ok, values: v.values, issues: v.issues });
      }
      const r = consoleConfig.save(body && body.values ? body.values : body);
      // 400 时前端要能显示原因：补一个 error 摘要（issues 里是明细）
      if (!r.ok) {
        const fatals = (r.issues || []).filter((i) => i.level === 'fatal');
        r.error = fatals.length ? fatals[0].msg : '配置校验未通过';
      }
      sendJson(res, r.ok ? 200 : 400, r);
    } catch (e) {
      sendJson(res, 500, { ok: false, error: e.message });
    }
  }],

  ['POST', /^\/api\/start$/, async (req, res) => {
    const port = await procs.probeGamePort(config.gamePort);
    if (!server.running && port.bound) {
      return sendJson(res, 409, {
        ok: false,
        error: '游戏端口 ' + config.gamePort + ' 已被占用（PID ' + port.pid + (port.name ? ' ' + port.name : '') +
          '），说明服务器已在别处运行。要么先用那个窗口关掉它，要么在控制台点「强制结束」。',
      });
    }
    const r = server.start();
    procs.invalidate();
    sendJson(res, r.ok ? 200 : 500, r);
  }],

  ['POST', /^\/api\/stop$/, async (req, res) => {
    const body = await readBody(req);
    const r = await server.stop({ force: !!body.force });
    procs.invalidate();
    sendJson(res, r.ok ? 200 : 400, r);
  }],

  ['POST', /^\/api\/kill$/, async (req, res) => {
    // 本控制台没在跑，但端口被占 → 杀掉外部实例
    if (!server.running) {
      const port = await procs.probeGamePort(config.gamePort);
      if (!port.bound) return sendJson(res, 400, { ok: false, error: '没有发现占用端口的进程' });
      await procs.killTree(port.pid);
      procs.invalidate();
      return sendJson(res, 200, { ok: true, killedPid: port.pid });
    }
    const r = await server.forceKill();
    procs.invalidate();
    sendJson(res, r.ok ? 200 : 400, r);
  }],

  ['POST', /^\/api\/command$/, async (req, res) => {
    const body = await readBody(req);
    const cmds = Array.isArray(body.cmds) ? body.cmds : [body.cmd];
    const results = [];
    for (const c of cmds) {
      if (typeof c !== 'string' || !c.trim()) continue;
      results.push(Object.assign({ cmd: c }, server.send(c)));
      if (body.delay) await new Promise((r) => setTimeout(r, Number(body.delay) || 300));
    }
    sendJson(res, 200, { ok: results.every((r) => r.ok), results });
  }],

  ['GET', /^\/api\/events$/, (req, res) => {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.write(': connected\n\n');
    sseClients.add(res);
    sseWrite(res, 'hello', {
      state: server.snapshot(),
      logfile: tailer.file,
      lines: tailer.history(300),
    });
    const ping = setInterval(() => { try { res.write(': ping\n\n'); } catch (_) {} }, 20000);
    req.on('close', () => { clearInterval(ping); sseClients.delete(res); });
  }],

  ['GET', /^\/api\/tui$/, (req, res) => {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.write(': connected\n\n');
    tuiClients.add(res);
    // 先给最近的一段屏幕内容做初始填充，避免刚连上看到空白
    if (server.ring) {
      const seed = Buffer.from(server.ring.slice(-200000), 'utf8').toString('base64');
      res.write(`event: seed\ndata: ${seed}\n\n`);
    }
    const ping = setInterval(() => { try { res.write(': ping\n\n'); } catch (_) {} }, 20000);
    req.on('close', () => { clearInterval(ping); tuiClients.delete(res); });
  }],

  ['GET', /^\/api\/logs\/history$/, (req, res) => {
    const q = url.parse(req.url, true).query;
    const n = Math.min(Number(q.lines) || 800, tailer.maxLines);
    sendJson(res, 200, { file: tailer.file, lines: tailer.history(n) });
  }],

  ['GET', /^\/api\/logs\/files$/, (req, res) => {
    let files = [];
    try {
      files = fs.readdirSync(config.dsLogsDir)
        .filter((f) => /\.log$/i.test(f))
        .map((f) => {
          const st = fs.statSync(path.join(config.dsLogsDir, f));
          return { name: f, size: st.size, mtime: st.mtimeMs };
        })
        .sort((a, b) => b.mtime - a.mtime);
    } catch (_) {}
    sendJson(res, 200, { dir: config.dsLogsDir, files });
  }],

  ['GET', /^\/api\/logs\/download$/, (req, res) => {
    const q = url.parse(req.url, true).query;
    const name = path.basename(String(q.file || ''));
    const full = path.join(config.dsLogsDir, name);
    if (!full.startsWith(config.dsLogsDir) || !fs.existsSync(full)) {
      res.writeHead(404); return res.end('404');
    }
    res.writeHead(200, {
      'Content-Type': 'text/plain; charset=utf-8',
      'Content-Disposition': `attachment; filename="${name}"`,
    });
    fs.createReadStream(full).pipe(res);
  }],

  ['GET', /^\/api\/saves$/, (req, res) => {
    const backups = saves.listBackups();
    sendJson(res, 200, {
      savesDir: config.savesDir,
      current: saves.listSaveFiles(),
      backups,
      backupDir: config.backupDir,
      totalBackupBytes: backups.reduce((s, b) => s + b.size, 0),
      currentBytes: saves.listSaveFiles().reduce((s, f) => s + f.size, 0),
    });
  }],

  ['POST', /^\/api\/saves\/backup$/, async (req, res) => {
    const body = await readBody(req);
    try {
      // triggerSave=true 时先让服务器自己存档，再复制文件（保证备份是最新世界）
      let saveTriggered = false;
      if (body.triggerSave) {
        if (server.running) {
          server.send('save');
          await new Promise((r) => setTimeout(r, Number(body.waitMs) || 6000));
          saveTriggered = true;
        }
      }
      const r = saves.createBackup({
        note: body.note || (saveTriggered ? '先 save 再打包' : '直接打包现有文件'),
        kind: 'manual',
      });
      broadcast('notice', { type: 'ok', text: '备份完成：' + r.id });
      sendJson(res, 200, Object.assign({ ok: true, saveTriggered }, r));
    } catch (e) {
      sendJson(res, 500, { ok: false, error: e.message });
    }
  }],

  ['POST', /^\/api\/saves\/restore$/, async (req, res) => {
    const body = await readBody(req);
    if (server.running) {
      return sendJson(res, 409, { ok: false, error: '请先停止服务器再恢复存档（运行中覆盖文件会把世界写乱）' });
    }
    try {
      const r = saves.restoreBackup(body.id);
      sendJson(res, 200, Object.assign({ ok: true }, r));
    } catch (e) {
      sendJson(res, 500, { ok: false, error: e.message });
    }
  }],

  ['DELETE', /^\/api\/saves\/(.+)$/, (req, res, m) => {
    try {
      saves.deleteBackup(decodeURIComponent(m[1]));
      sendJson(res, 200, { ok: true });
    } catch (e) {
      sendJson(res, 500, { ok: false, error: e.message });
    }
  }],

  ['GET', /^\/api\/commands$/, (req, res) => {
    sendJson(res, 200, readCommands());
  }],

  // 玩家档案：存档配对文件里的 per-hero 记录 + 当前在线列表 + 世界心跳
  ['GET', /^\/api\/players$/, (req, res) => {
    const snap = server.snapshot();
    try {
      sendJson(res, 200, playersLib.snapshot({ onlineList: snap.players, world: snap.world }));
    } catch (e) {
      sendJson(res, 200, { ok: false, error: e.message, players: [] });
    }
  }],

  // 技能树目录：全部 perk 按技能/需求熟练度分档。
  // 单独一个接口而不是塞进 /api/players：这份目录一次就够（19KB 级），
  // 没必要跟着 20 秒一次的玩家轮询反复传。
  ['GET', /^\/api\/perks$/, (req, res) => {
    try {
      // 注意：perkCatalog 在 lib/playercards.js 里（它读 playercards.json），
      // 不在 lib/players.js —— 玩家名册和技能树目录是两个不同的数据源
      sendJson(res, 200, playercards.perkCatalog());
    } catch (e) {
      sendJson(res, 200, { ok: false, error: e.message, skills: [], count: 0 });
    }
  }],

  // Calradia 地图底图数据：城镇/城堡坐标（含中文名）。一次取够（约 60KB），
  // 前端拿到后就不必再请求；settlements.xml 游戏更新才会变，mtime 缓存着呢
  ['GET', /^\/api\/map$/, (req, res) => {
    try {
      sendJson(res, 200, mapLib.load());
    } catch (e) {
      sendJson(res, 200, { ok: false, error: e.message, settlements: [] });
    }
  }],

  ['GET', /^\/api\/changelog$/, (req, res) => {
    try {
      const d = JSON.parse(fs.readFileSync(path.join(config.dataDir, 'changelog.json'), 'utf8'));
      sendJson(res, 200, d);
    } catch (e) {
      sendJson(res, 200, { releases: [], _error: e.message });
    }
  }],

  ['POST', /^\/api\/changelog\/refresh$/, async (req, res) => {
    try {
      const { fetchChangelog } = require('./tools/fetch-changelog');
      const d = await fetchChangelog({ quiet: true });
      sendJson(res, 200, { ok: true, count: d.releases.length, fetchedAt: d.fetchedAt });
    } catch (e) {
      sendJson(res, 500, { ok: false, error: e.message });
    }
  }],
];

async function handleRequest(req, res) {
  const parsed = url.parse(req.url, true);
  const pathname = decodeURIComponent(parsed.pathname || '/');

  if (TOKEN) {
    const fromQuery = parsed.query.token;
    const provided = fromQuery || cookieValue(req, COOKIE_NAME) || req.headers['x-console-token'];
    if (provided !== TOKEN) {
      if (req.method === 'GET' && (pathname === '/' || pathname === '/index.html')) {
        res.writeHead(401, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
        return res.end(loginPage());
      }
      res.writeHead(401, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('需要口令：在本页地址后加 ?token=…，或先访问 / 用表单登录。');
    }
    // 口令从 URL 带上来的话，换成 Cookie，后续 fetch / EventSource 就不用再拼参数
    if (fromQuery === TOKEN) {
      res.setHeader('Set-Cookie',
        `${COOKIE_NAME}=${encodeURIComponent(TOKEN)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=31536000`);
    }
  }

  for (const [method, re, handler] of routes) {
    if (req.method !== method) continue;
    const m = pathname.match(re);
    if (!m) continue;
    try {
      await handler(req, res, m);
    } catch (e) {
      console.error('[console] ' + pathname + ' 处理失败: ' + e.stack);
      if (!res.headersSent) sendJson(res, 500, { ok: false, error: e.message });
    }
    return;
  }

  if (req.method === 'GET') return serveStatic(req, res, pathname);
  res.writeHead(404); res.end('404');
}

// ——————————————————————————— 启动 ———————————————————————————

tailer.start();

const listeners = [];
let pending = BIND_HOSTS.length;

for (const host of BIND_HOSTS) {
  const s = http.createServer(handleRequest);
  s.on('error', (e) => {
    console.error('  ✗ 无法监听 ' + host + ':' + config.httpPort + ' —— ' + e.message);
    if (--pending === 0) printBanner();
  });
  s.listen(config.httpPort, host, () => {
    listeners.push(host);
    if (--pending === 0) printBanner();
  });
}

function printBanner() {
  const q = TOKEN ? '?token=' + TOKEN : '';
  const wildcard = listeners.some((h) => h === '0.0.0.0' || h === '::');
  const nics = lanAddresses();
  // 0.0.0.0 / :: 是通配监听，本身不是能在浏览器里敲的地址。听全部网卡时就把本机每一张
  // 网卡的 IP 列出来（谁连得上哪张就抄哪行），千万别把 0.0.0.0 当网址发给别人。
  const shown = wildcard ? nics : nics.filter((a) => listeners.indexOf(a.address) >= 0);
  const tail = wildcard
    ? '（' + (nics.length ? '全网卡，' + nics.length + ' 个可访问地址' : '全网卡，但没有可用的网卡地址') + '）'
    : (shown.length ? '（' + shown.length + ' 个对外地址）' : '（仅本机）');
  console.log('');
  console.log('  Bannerlord Coop 服务器控制台');
  console.log('  监听      : ' + (listeners.length ? listeners.join(', ') : '（全部失败）') + ':' + config.httpPort + tail);
  console.log('  监听来源  : 地址 = ' + config.httpHostSource + '，端口 = ' + config.httpPortSource +
    '（改 config.json 后重启生效）');
  console.log('  本机打开  : http://127.0.0.1:' + config.httpPort + '/' + q);
  for (const a of shown) {
    const tag = /zerotier/i.test(a.name) ? 'ZeroTier' : '局域网  ';
    console.log('  ' + tag + ' : http://' + a.address + ':' + config.httpPort + '/' + q + (a.name ? '   [' + a.name + ']' : ''));
  }
  if (TOKEN) console.log('  访问口令  : 已启用（来自 COOP_CONSOLE_TOKEN）');
  console.log('  服务端目录 : ' + config.serverDir);
  console.log('  存档目录   : ' + config.savesDir);
  console.log('  日志目录   : ' + config.dsLogsDir);
  console.log('  备份目录   : ' + config.backupDir);
  console.log('  配置文件   : ' + (config.configFileExists ? config.configFile : '未创建（用自动探测值，可 node lib/config.js --init 生成）'));
  // 路径自检：分发/换机时最常见的问题就是路径不对，别等点「启动」才报错
  const pathIssues = config.check();
  if (pathIssues.length) {
    console.log('');
    for (const i of pathIssues) {
      console.log('  ' + (i.fatal ? '✗' : '⚠') + ' ' + i.msg);
      console.log('     → ' + i.hint);
    }
  }
  console.log('');
  if (EXPOSED && !TOKEN) {
    console.log('  ⚠ 正在对外监听且未设口令：同网段的人打开地址就能起停服务器、恢复存档。');
    console.log('    都是自己人的网络就不用管；要加就把 COOP_CONSOLE_TOKEN 设个值再启动。');
  }
  console.log('  ⚠ 服务端跑在本控制台的伪终端里：关掉这个窗口 = 服务器一起停。');
  console.log('    要长期挂机请直接用 start-server.bat，本控制台仍可当只读面板看日志。');
  console.log('');
}

process.on('SIGINT', () => {
  console.log('\n[console] 关闭控制台；伪终端随之关闭，服务端进程也会结束。');
  tailer.stop();
  process.exit(0);
});
