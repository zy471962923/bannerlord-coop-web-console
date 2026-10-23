'use strict';
// 极简假 DOM：在 Node 里把 public/app.js 跑起来，好让渲染函数产出真实 HTML。
//
// 为什么要这个：这台机器上 Edge / Chromium 的 --screenshot 与 --dump-dom 都是零字节
// 输出，截图验证这条路走不通。于是退一步 —— 给 app.js 一套够用的假 document/window，
// 把 renderPlayerCards 这类函数原样跑一遍，检查它们吐出来的 HTML 字符串。
//
// 只实现 app.js 真正用到的成员。别把它做成 jsdom，多余的能力只会掩盖问题。
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const PUBLIC_DIR = path.join(__dirname, '..', '..', 'public');

function makeEl(id) {
  return {
    id,
    innerHTML: '',
    textContent: '',
    className: '',
    value: '',
    checked: false,
    disabled: false,
    dataset: {},
    style: {},
    scrollTop: 0,
    scrollHeight: 0,
    clientHeight: 0,
    clientWidth: 0,
    childElementCount: 0,
    children: [],
    classList: {
      _s: new Set(),
      add(c) { this._s.add(c); },
      remove(c) { this._s.delete(c); },
      contains(c) { return this._s.has(c); },
      toggle(c, on) { if (on === undefined) on = !this._s.has(c); if (on) this._s.add(c); else this._s.delete(c); },
    },
    addEventListener() {},
    removeEventListener() {},
    appendChild() { this.childElementCount++; },
    removeChild() { this.childElementCount--; },
    remove() {},
    focus() {},
    removeAttribute() {},
    setAttribute() {},
    getBoundingClientRect() { return { width: 100, height: 20 }; },
    querySelector() { return makeEl('sub'); },
    querySelectorAll() { return []; },
    closest() { return null; },
  };
}

// 返回 { sandbox, el } —— el(selector) 拿到的是稳定复用的假元素，
// 所以 render 完之后读 el('#player-grid').innerHTML 就是页面上的样子。
//
// opts.fetch(url) 可以给某个接口塞一份真实响应：技能树那块的目录是异步取的，
// 不塞的话只会走到「加载中」分支，验不到树本身。
function loadApp(opts = {}) {
  const appSrc = fs.readFileSync(path.join(PUBLIC_DIR, 'app.js'), 'utf8');

  const els = new Map();
  function el(sel) {
    if (!els.has(sel)) els.set(sel, makeEl(sel));
    return els.get(sel);
  }

  const sandbox = {
    console,
    document: {
      querySelector: (s) => el(s),
      // 默认空数组；想验证 $$() 的取值逻辑（比如表单 collect）就传 opts.querySelectorAll
      querySelectorAll: (s) => (typeof opts.querySelectorAll === 'function' ? (opts.querySelectorAll(s) || []) : []),
      createElement: (t) => makeEl(t),
      addEventListener: () => {},
      body: makeEl('body'),
    },
    window: { addEventListener: () => {}, repairMojibake: null },
    location: { hash: '#players' },
    history: { replaceState: () => {} },
    navigator: { userAgent: 'node-fake-dom' },
    setTimeout: () => 0,
    clearTimeout: () => {},
    setInterval: () => 0,
    clearInterval: () => {},
    requestAnimationFrame: () => 0,
    cancelAnimationFrame: () => {},
    fetch: (url) => {
      if (typeof opts.fetch === 'function') {
        const canned = opts.fetch(String(url));
        if (canned !== undefined && canned !== null) {
          return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(canned) });
        }
      }
      return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({}) });
    },
    EventSource: class {
      constructor() { this.listeners = {}; }
      addEventListener(k, fn) { this.listeners[k] = fn; }
      close() {}
    },
    TextDecoder,
    TextEncoder,
    atob: (s) => Buffer.from(s, 'base64').toString('binary'),
    btoa: (s) => Buffer.from(s, 'binary').toString('base64'),
    AbortController,
    Promise, Math, Date, JSON, Object, Array, String, Number, Error,
    isNaN, parseInt, parseFloat,
    encodeURIComponent, decodeURIComponent,
  };
  sandbox.globalThis = sandbox;
  sandbox.self = sandbox;

  vm.createContext(sandbox);
  vm.runInContext(appSrc, sandbox, { filename: 'app.js' });
  return { sandbox, el };
}

module.exports = { loadApp, makeEl, PUBLIC_DIR };
