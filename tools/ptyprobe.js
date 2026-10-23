// 探针：验证 node-pty 能否承载真实服务端 TUI 并跑到 SERVING
// 用法：node tools/ptyprobe.js [秒数，默认 90]
const path = require('path');
const fs = require('fs');
const pty = require('node-pty');

const SECONDS = Number(process.argv[2] || 90);
// 服务端目录跟着 config.json / 自动探测走，不要把盘符写死在这里
const ROOT = require(path.join(__dirname, '..', 'lib', 'config')).serverDir;
const EXE = path.join(ROOT, 'BannerlordCoopServer.exe');
const OUT = path.join(__dirname, '..', 'data', 'ptyprobe.log');

const p = pty.spawn(EXE, [], {
  name: 'xterm-256color',
  cols: 160,
  rows: 45,
  cwd: ROOT,
  env: { ...process.env, TERM: 'xterm-256color' },
});

let raw = '';
let serving = false;
let exitCode = null;

p.onData((d) => {
  raw += d;
  if (!serving && d.includes('SERVING')) {
    serving = true;
    console.log('[PROBE] SERVING detected at ' + new Date().toISOString());
  }
});

p.onExit((e) => {
  exitCode = e.exitCode;
  console.log('[PROBE] exited code=' + exitCode);
  finish();
});

function finish() {
  fs.writeFileSync(OUT, raw, 'utf8');
  console.log('[PROBE] raw bytes=' + Buffer.byteLength(raw) + ' -> ' + OUT);
  console.log('[PROBE] SERVING=' + serving);
  // 打印前 600 字节的可读形式，看 TUI 到底发了什么转义序列
  console.log('[PROBE] head repr: ' + JSON.stringify(raw.slice(0, 600)));
  process.exit(0);
}

setTimeout(() => {
  console.log('[PROBE] timeout; sending stop');
  try { p.write('stop\r'); } catch (e) { console.log('[PROBE] write failed: ' + e.message); }
  setTimeout(() => { try { p.kill(); } catch (e) {} finish(); }, 8000);
}, SECONDS * 1000);
