'use strict';
// 给文档截控制台界面图。用 Edge 的 DevTools 协议（CDP）而不是 --screenshot：
//   --screenshot 在 load 事件后立刻拍，而我们的页面数据是异步 fetch 的，
//   拍出来经常是空壳（玩家档案、地图尤其明显）。
//   CDP 可以先 Runtime.evaluate 轮询「内容到位了没」，再 Page.captureScreenshot。
//
// 另：不能用 --virtual-time-budget —— 页面有常驻 SSE（/api/events），
//   永远有 pending 请求，虚拟时间不会推进，截图就永远不落盘（踩过）。
//
// 用法：node tools/screenshots.js [输出目录]
//   默认输出 docs/shots，需要控制台正在运行（默认 http://127.0.0.1:7788）
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const PORT = 9333;
const BASE = process.env.SHOT_BASE || 'http://127.0.0.1:7788/';
const OUT_DIR = path.resolve(process.argv[2] || path.join(__dirname, '..', 'docs', 'shots'));
const W = Number(process.env.SHOT_W || 1600);
const H = Number(process.env.SHOT_H || 1000);
const SCALE = Number(process.env.SHOT_SCALE || 1.5);

// 每张图：等到 innerText 长度够了再拍（比 fixed sleep 稳，且换机器不会抖）
const SHOTS = [
  { name: '01-log', hash: 'log', min: 800, settle: 900 },
  { name: '02-tui', hash: 'tui', min: 400, settle: 1200 },
  { name: '03-players', hash: 'players', min: 400, settle: 1600 },
  { name: '04-map', hash: 'map', min: 60, settle: 2200, extra: "!!document.querySelector('#map-view svg .lbl-town')" },
  { name: '05-cmd', hash: 'cmd', min: 600, settle: 900 },
  { name: '06-saves', hash: 'saves', min: 150, settle: 1200 },
  { name: '07-changelog', hash: 'changelog', min: 300, settle: 1200 },
  { name: '08-config', hash: 'config', min: 400, settle: 1000, extra: "document.querySelectorAll('.cfg-fields input').length === 8" },
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function httpJson(url) {
  return new Promise((resolve, reject) => {
    require('http').get(url, (res) => {
      let s = '';
      res.on('data', (d) => { s += d; });
      res.on('end', () => { try { resolve(JSON.parse(s)); } catch (e) { reject(e); } });
    }).on('error', reject);
  });
}

async function waitForDevtools(timeoutMs) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    try {
      const list = await httpJson('http://127.0.0.1:' + PORT + '/json/list');
      const page = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
      if (page) return page;
    } catch (_) {}
    await sleep(250);
  }
  throw new Error('Edge 没起来（DevTools 端口 ' + PORT + ' 无响应）');
}

// —— 极简 CDP 客户端（Node 22 内置 WebSocket）——
class Cdp {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    this.handlers = new Map();
    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject, method } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(method + ' → ' + msg.error.message));
        else resolve(msg.result);
      } else if (msg.method) {
        const fn = this.handlers.get(msg.method);
        if (fn) fn(msg.params);
      }
    });
  }
  send(method, params) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject, method });
      this.ws.send(JSON.stringify({ id, method, params: params || {} }));
    });
  }
  on(method, fn) { this.handlers.set(method, fn); }
}

async function main() {
  if (!fs.existsSync(EDGE)) throw new Error('找不到 Edge：' + EDGE);
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'coop-shot-'));

  const child = spawn(EDGE, [
    '--headless=new', '--disable-gpu', '--no-sandbox', '--hide-scrollbars',
    '--disable-extensions', '--no-first-run', '--mute-audio',
    '--remote-debugging-port=' + PORT,
    '--user-data-dir=' + profile,
    'about:blank',
  ], { stdio: 'ignore' });

  let exitCode = 0;
  try {
    const page = await waitForDevtools(20000);
    const ws = new WebSocket(page.webSocketDebuggerUrl);
    await new Promise((res, rej) => {
      ws.addEventListener('open', res, { once: true });
      ws.addEventListener('error', rej, { once: true });
    });
    const cdp = new Cdp(ws);
    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');
    await cdp.send('Emulation.setDeviceMetricsOverride', {
      width: W, height: H, deviceScaleFactor: SCALE, mobile: false,
    });

    const ONLY = process.env.SHOT_ONLY || '';
    const list = ONLY ? SHOTS.filter((x) => x.name.indexOf(ONLY) >= 0) : SHOTS;
    for (const s of list) {
      // 带 query 参数强制真加载：#切页是同文档导航，不会有 load 事件
      const url = BASE + '?shot=' + encodeURIComponent(s.name) + '#' + s.hash;
      const loaded = new Promise((res) => {
        cdp.on('Page.loadEventFired', () => res());
        setTimeout(res, 8000);
      });
      await cdp.send('Page.navigate', { url });
      await loaded;

      // 轮询等内容
      const t0 = Date.now();
      let ok = false;
      while (Date.now() - t0 < 25000) {
        const expr = "(()=>{try{"
          + "var t=document.querySelector('#tab-" + s.hash + "');"
          + "var n=t?t.innerText.length:0;"
          + "var x=" + (s.extra || 'true') + ";"
          + "return n+'|'+x;}catch(e){return '0|false'}})()";
        let r;
        try {
          r = await cdp.send('Runtime.evaluate', { expression: expr, returnByValue: true });
        } catch (e) {
          console.error('   表达式：' + expr);
          throw e;
        }
        const v = String(r.result.value || '0|false').split('|');
        if (Number(v[0]) >= s.min && v[1] === 'true') { ok = true; break; }
        await sleep(300);
      }
      if (!ok) console.warn('  ! ' + s.name + ' 等待超时，仍按现状截图');
      await sleep(s.settle);

      const shot = await cdp.send('Page.captureScreenshot', { format: 'png', fromSurface: true });
      const file = path.join(OUT_DIR, s.name + '.png');
      fs.writeFileSync(file, Buffer.from(shot.data, 'base64'));
      console.log('  ' + (ok ? '✓' : '?') + ' ' + s.name + '.png  '
        + (fs.statSync(file).size / 1024).toFixed(0) + ' KB');
    }

    ws.close();
  } catch (e) {
    console.error('  截图失败：' + e.message);
    exitCode = 1;
  } finally {
    try { child.kill(); } catch (_) {}
    await sleep(500);
    try { fs.rmSync(profile, { recursive: true, force: true }); } catch (_) {}
  }
  process.exit(exitCode);
}

main();
