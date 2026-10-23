'use strict';
// TUI 模拟器（public/term.js）的无浏览器测试
// 用假 DOM 实例化 Term，喂真实 PTY 抓下来的原始字节流，把它还原成的屏幕文本打出来对比。
// 用法：node tools/test-term.js [原始流文件，默认 data/tui.raw]
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const COLS = 160;
const ROWS = 45;

// —— 极简 DOM 垫片 ——
function makeEl() {
  return {
    className: '',
    innerHTML: '',
    style: {},
    children: [],
    appendChild(c) { this.children.push(c); return c; },
    removeChild(c) { this.children = this.children.filter((x) => x !== c); },
    querySelector() { return makeEl(); },
    getBoundingClientRect() { return { width: 100 }; },
    clientWidth: 1200,
  };
}

const sandbox = {
  window: {},
  document: {
    createElement: makeEl,
    querySelector: () => makeEl(),
  },
  requestAnimationFrame: (cb) => setTimeout(cb, 16),
  TextDecoder,
  atob: (s) => Buffer.from(s, 'base64').toString('binary'),
  console,
};
sandbox.globalThis = sandbox;
vm.createContext(sandbox);

const src = fs.readFileSync(path.join(__dirname, '..', 'public', 'term.js'), 'utf8');
vm.runInContext(src, sandbox);

const Term = sandbox.window.Term;
const repair = sandbox.window.repairMojibake;
if (!Term) { console.error('term.js 没有导出 Term'); process.exit(1); }

let fail = 0;
const check = (ok, label, extra = '') => {
  if (!ok) fail++;
  console.log((ok ? 'PASS' : 'FAIL') + '  ' + label + (extra ? '  ' + extra : ''));
};

// —— 1. 乱码修复 ——
check(repair('SERVING \u00e2\u20ac\u201d coop') === 'SERVING \u2014 coop', '乱码修复：â€” → —', JSON.stringify(repair('SERVING \u00e2\u20ac\u201d coop')));
check(repair('pure ascii') === 'pure ascii', '乱码修复：纯 ASCII 不动');
check(repair('中文正常') === '中文正常', '乱码修复：正常中文不动');
check(repair('\u2502\u2500\u250c\u2510') === '\u2502\u2500\u250c\u2510', '乱码修复：制表符不动');

// —— 2. 屏幕仿真 ——
const file = process.argv[2] || path.join(__dirname, '..', 'data', 'tui.raw');
if (!fs.existsSync(file)) {
  console.log('\n（跳过屏幕仿真：没有 ' + file + '）');
  console.log(fail ? `${fail} 项失败` : '全部通过');
  process.exit(fail ? 1 : 0);
}

const raw = fs.readFileSync(file, 'utf8');
const term = new Term(makeEl(), COLS, ROWS);

// 按 2KB 随机切片喂，模拟 SSE 分片
let i = 0;
let seed = 987654321;
while (i < raw.length) {
  seed = (seed * 1103515245 + 12345) % 2147483648;
  const n = 64 + (seed % 2048);
  const chunk = raw.slice(i, i + n);
  term.feed(repair(chunk));
  i += n;
}
term.flush();

const rowsText = [];
for (let y = 0; y < ROWS; y++) {
  let s = '';
  for (let x = 0; x < COLS; x++) {
    const c = term.grid[y][x];
    if (c && c.skip) continue;
    s += c ? c.ch : ' ';
  }
  rowsText.push(s.replace(/\s+$/, ''));
}

console.log('\n———— 还原出的屏幕 ————');
console.log(rowsText.join('\n').replace(/^$/gm, ''));
console.log('———————————————————————\n');

const screen = rowsText.join('\n');
check(!/\u001b/.test(screen), '屏上无残留 ESC');
check(/[┌┐└┘│─]/.test(screen), '画出了边框字符');
check(screen.length > 800, '屏幕有实质内容', 'chars=' + screen.length);

// 右下角状态栏（F10 Stop │ ... port 4200 ...）应落在最后几行
check(/4200/.test(screen), '状态栏出现端口 4200');
check(/players/i.test(screen), '出现 players 面板');

console.log(fail ? `\n${fail} 项失败` : '\n全部通过');
process.exit(fail ? 1 : 0);
