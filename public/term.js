'use strict';
// 一个够用的 ANSI 屏幕缓冲区，专门用来镜像 Bannerlord Coop 服务端的 TUI。
// 只实现服务端实际会发的那几类序列（已用真实 100s 输出统计过）：
//   CSI ... m  (SGR 颜色) / H f (定位) / K (擦行) / J (擦屏) / C A B D (移动)
//   ?25 h l (光标显隐)   OSC ... BEL (标题，忽略)
// 其他序列一律安全跳过，不报错。

const ESC = '\u001b';

const PALETTE = {
  30: '#2a3440', 31: '#ef6b6b', 32: '#4fce8a', 33: '#e8b451', 34: '#5a9bf0',
  35: '#c98ce8', 36: '#4dc9d6', 37: '#cfd9e4',
  90: '#5b6b7d', 91: '#ff9b9b', 92: '#79e2ab', 93: '#ffd479', 94: '#82b6ff',
  95: '#dfa6ff', 96: '#82e3ec', 97: '#ffffff',
};
const BG_PALETTE = {
  40: '#2a3440', 41: '#ef6b6b', 42: '#4fce8a', 43: '#e8b451', 44: '#5a9bf0',
  45: '#c98ce8', 46: '#4dc9d6', 47: '#cfd9e4',
  100: '#5b6b7d', 101: '#ff9b9b', 102: '#79e2ab', 103: '#ffd479', 104: '#82b6ff',
  105: '#dfa6ff', 106: '#82e3ec', 107: '#ffffff',
};

function isWide(cp) {
  return (
    (cp >= 0x1100 && cp <= 0x115f) ||
    (cp >= 0x2e80 && cp <= 0xa4cf) ||
    (cp >= 0xac00 && cp <= 0xd7a3) ||
    (cp >= 0xf900 && cp <= 0xfaff) ||
    (cp >= 0xfe30 && cp <= 0xfe6f) ||
    (cp >= 0xff00 && cp <= 0xff60) ||
    (cp >= 0xffe0 && cp <= 0xffe6)
  );
}

class Term {
  constructor(el, cols, rows) {
    this.el = el;
    this.cols = cols || 160;
    this.rows = rows || 45;
    this.styles = [];
    this.styleMap = new Map();
    this.pending = '';
    this.rowEls = [];
    this.rowHtml = new Array(this.rows).fill(null);
    this.dirty = new Set();
    this.reset();
    this.buildDom();
  }

  buildDom() {
    this.el.innerHTML = '';
    this.rowEls = [];
    for (let y = 0; y < this.rows; y++) {
      const d = document.createElement('div');
      d.className = 'row';
      this.el.appendChild(d);
      this.rowEls.push(d);
    }
    this.rowHtml.fill(null);
  }

  reset() {
    this.grid = new Array(this.rows);
    for (let y = 0; y < this.rows; y++) this.grid[y] = new Array(this.cols).fill(null);
    this.x = 0;
    this.y = 0;
    this.attr = { fg: null, bg: null, bold: false, dim: false, underline: false, inverse: false };
    this.curStyle = 0;
    this.styles = ['{}'];
    this.styleMap = new Map([['{}', 0]]);
    this.cursorVisible = false;
    this.markAllDirty();
  }

  markAllDirty() {
    for (let y = 0; y < this.rows; y++) this.dirty.add(y);
  }

  // —— 样式内联 ——
  internStyle() {
    const a = this.attr;
    const key = [a.fg || '', a.bg || '', a.bold ? 1 : 0, a.dim ? 1 : 0, a.underline ? 1 : 0, a.inverse ? 1 : 0].join('|');
    let idx = this.styleMap.get(key);
    if (idx === undefined) {
      idx = this.styles.length;
      this.styles.push(key);
      this.styleMap.set(key, idx);
    }
    return idx;
  }

  cssFor(idx) {
    if (idx === 0) return '';
    const key = this.styles[idx];
    if (key === '{}') return '';
    const [fg, bg, bold, dim, underline, inverse] = key.split('|');
    let color = fg;
    let back = bg;
    if (inverse === '1') { const t = color || '#cfd9e4'; color = back || '#0a0f14'; back = t; }
    let css = '';
    if (color) css += 'color:' + color + ';';
    else if (dim === '1') css += 'color:#6d7f92;';
    if (back) css += 'background:' + back + ';';
    if (bold === '1') css += 'font-weight:700;';
    if (underline === '1') css += 'text-decoration:underline;';
    return css;
  }

  // —— 写入 ——
  feed(text) {
    this.pending += text;
    const s = this.pending;
    let i = 0;
    const n = s.length;
    while (i < n) {
      const c = s[i];
      if (c === ESC) {
        const r = this.consumeEscape(s, i);
        if (r === -1) { this.pending = s.slice(i); return; } // 序列不完整，留到下次
        i = r;
        continue;
      }
      if (c === '\r') { this.x = 0; i++; continue; }
      if (c === '\n') { this.lineFeed(); i++; continue; }
      if (c === '\b') { if (this.x > 0) this.x--; i++; continue; }
      if (c === '\t') { this.x = Math.min(this.cols - 1, (Math.floor(this.x / 8) + 1) * 8); i++; continue; }
      if (c === '\u0007' || c === '\u0000' || c === '\u000e' || c === '\u000f') { i++; continue; }
      const cp = s.codePointAt(i);
      const ch = String.fromCodePoint(cp);
      this.put(ch, isWide(cp) ? 2 : 1);
      i += ch.length;
    }
    this.pending = '';
  }

  put(ch, w) {
    if (this.x >= this.cols) { this.x = 0; this.lineFeed(); }
    const row = this.grid[this.y];
    const style = this.internStyle();
    row[this.x] = { ch, s: style, h: w };
    if (w === 2 && this.x + 1 < this.cols) row[this.x + 1] = { skip: true, s: style };
    this.dirty.add(this.y);
    this.x += w;
  }

  lineFeed() {
    if (this.y === this.rows - 1) this.scrollUp();
    else this.y++;
  }

  scrollUp() {
    this.grid.shift();
    this.grid.push(new Array(this.cols).fill(null));
    this.markAllDirty();
  }

  consumeEscape(s, i) {
    const n = s.length;
    const next = s[i + 1];
    if (next === undefined) return -1;

    if (next === '[') {
      let j = i + 2;
      while (j < n && !/[@-~]/.test(s[j])) j++;
      if (j >= n) return -1; // 未收完
      const params = s.slice(i + 2, j);
      const final = s[j];
      this.csi(params, final);
      return j + 1;
    }
    if (next === ']') {
      // OSC：到 BEL 或 ESC \ 结束
      let j = i + 2;
      while (j < n) {
        if (s[j] === '\u0007') return j + 1;
        if (s[j] === ESC && s[j + 1] === '\\') return j + 2;
        j++;
      }
      return -1;
    }
    if (next === '(' || next === ')') {
      if (i + 2 >= n) return -1;
      return i + 3;
    }
    // 单字符序列
    return i + 2;
  }

  csi(params, final) {
    if (params.startsWith('?')) {
      const on = params.endsWith('h');
      const nums = params.slice(1, -1).split(';').map(Number);
      if (nums.includes(25)) this.cursorVisible = on;
      if (nums.includes(1049)) { this.reset(); }
      return;
    }
    const ps = params.length ? params.split(';').map((v) => (v === '' ? 0 : Number(v))) : [0];

    switch (final) {
      case 'm': this.sgr(ps); break;
      case 'H':
      case 'f': {
        const r = (ps[0] || 1) - 1;
        const c = (ps[1] || 1) - 1;
        this.y = Math.max(0, Math.min(this.rows - 1, r));
        this.x = Math.max(0, Math.min(this.cols - 1, c));
        break;
      }
      case 'A': this.y = Math.max(0, this.y - (ps[0] || 1)); break;
      case 'B': this.y = Math.min(this.rows - 1, this.y + (ps[0] || 1)); break;
      case 'C': this.x = Math.min(this.cols - 1, this.x + (ps[0] || 1)); break;
      case 'D': this.x = Math.max(0, this.x - (ps[0] || 1)); break;
      case 'G': this.x = Math.max(0, Math.min(this.cols - 1, (ps[0] || 1) - 1)); break;
      case 'd': this.y = Math.max(0, Math.min(this.rows - 1, (ps[0] || 1) - 1)); break;
      case 'K': this.eraseLine(ps[0] || 0); break;
      case 'J': this.eraseDisplay(ps[0] || 0); break;
      case 'X': {
        const cnt = ps[0] || 1;
        for (let k = 0; k < cnt && this.x + k < this.cols; k++) this.grid[this.y][this.x + k] = null;
        this.dirty.add(this.y);
        break;
      }
      case 'P': {
        const cnt = ps[0] || 1;
        const row = this.grid[this.y];
        row.splice(this.x, cnt);
        while (row.length < this.cols) row.push(null);
        this.dirty.add(this.y);
        break;
      }
      case '@': {
        const cnt = ps[0] || 1;
        const row = this.grid[this.y];
        row.splice(this.x, 0, ...new Array(cnt).fill(null));
        row.length = this.cols;
        this.dirty.add(this.y);
        break;
      }
      case 'L':
      case 'M': {
        const cnt = ps[0] || 1;
        for (let k = 0; k < cnt; k++) {
          this.grid.splice(this.y, final === 'L' ? 0 : 1, new Array(this.cols).fill(null));
        }
        this.grid.length = this.rows;
        this.markAllDirty();
        break;
      }
      case 'S': this.scrollUp(); break;
      case 'T': {
        const cnt = ps[0] || 1;
        for (let k = 0; k < cnt; k++) {
          this.grid.pop();
          this.grid.unshift(new Array(this.cols).fill(null));
        }
        this.markAllDirty();
        break;
      }
      default: break;
    }
  }

  sgr(ps) {
    const a = this.attr;
    for (let i = 0; i < ps.length; i++) {
      const p = ps[i];
      if (p === 0) { a.fg = null; a.bg = null; a.bold = false; a.dim = false; a.underline = false; a.inverse = false; }
      else if (p === 1) a.bold = true;
      else if (p === 2) a.dim = true;
      else if (p === 4) a.underline = true;
      else if (p === 7) a.inverse = true;
      else if (p === 22) { a.bold = false; a.dim = false; }
      else if (p === 24) a.underline = false;
      else if (p === 27) a.inverse = false;
      else if (p === 39) a.fg = null;
      else if (p === 49) a.bg = null;
      else if (PALETTE[p]) a.fg = PALETTE[p];
      else if (BG_PALETTE[p]) a.bg = BG_PALETTE[p];
      else if (p === 38 || p === 48) {
        // 扩展色：5;n 或 2;r;g;b
        const target = p === 38 ? 'fg' : 'bg';
        if (ps[i + 1] === 5) {
          a[target] = color256(ps[i + 2]);
          i += 2;
        } else if (ps[i + 1] === 2) {
          a[target] = `rgb(${ps[i + 2] || 0},${ps[i + 3] || 0},${ps[i + 4] || 0})`;
          i += 4;
        }
      }
    }
    this.curStyle = this.internStyle();
  }

  eraseLine(mode) {
    const row = this.grid[this.y];
    if (mode === 0) for (let x = this.x; x < this.cols; x++) row[x] = null;
    else if (mode === 1) for (let x = 0; x <= this.x && x < this.cols; x++) row[x] = null;
    else if (mode === 2) for (let x = 0; x < this.cols; x++) row[x] = null;
    this.dirty.add(this.y);
  }

  eraseDisplay(mode) {
    if (mode === 0) {
      this.eraseLine(0);
      for (let y = this.y + 1; y < this.rows; y++) this.grid[y] = new Array(this.cols).fill(null);
    } else if (mode === 1) {
      this.eraseLine(1);
      for (let y = 0; y < this.y; y++) this.grid[y] = new Array(this.cols).fill(null);
    } else {
      for (let y = 0; y < this.rows; y++) this.grid[y] = new Array(this.cols).fill(null);
    }
    this.markAllDirty();
  }

  escapeHtml(s) {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  renderRow(y) {
    const row = this.grid[y];
    let html = '';
    let run = '';
    let curStyle = -1;
    let curCss = '';
    for (let x = 0; x < this.cols; x++) {
      const cell = row[x];
      if (cell && cell.skip) continue;
      const st = cell ? cell.s : 0;
      if (st !== curStyle) {
        if (run) html += curCss ? `<span style="${curCss}">${this.escapeHtml(run)}</span>` : this.escapeHtml(run);
        run = '';
        curStyle = st;
        curCss = this.cssFor(st);
      }
      run += cell ? cell.ch : ' ';
    }
    if (run) html += curCss ? `<span style="${curCss}">${this.escapeHtml(run)}</span>` : this.escapeHtml(run);
    return html;
  }

  // 只把真正变化的行写进 DOM
  flush() {
    if (!this.dirty.size) return;
    for (const y of this.dirty) {
      if (y < 0 || y >= this.rows) continue;
      const html = this.renderRow(y);
      if (this.rowHtml[y] !== html) {
        this.rowHtml[y] = html;
        this.rowEls[y].innerHTML = html;
      }
    }
    this.dirty.clear();
  }
}

function color256(n) {
  n = Number(n);
  if (Number.isNaN(n)) return '#cfd9e4';
  if (n < 16) {
    const base = {
      0: '#0a0f14', 1: '#ef6b6b', 2: '#4fce8a', 3: '#e8b451', 4: '#5a9bf0', 5: '#c98ce8', 6: '#4dc9d6', 7: '#cfd9e4',
      8: '#5b6b7d', 9: '#ff9b9b', 10: '#79e2ab', 11: '#ffd479', 12: '#82b6ff', 13: '#dfa6ff', 14: '#82e3ec', 15: '#ffffff',
    };
    return base[n] || '#cfd9e4';
  }
  if (n < 232) {
    const i = n - 16;
    const r = Math.floor(i / 36);
    const g = Math.floor((i % 36) / 6);
    const b = i % 6;
    const f = (v) => (v === 0 ? 0 : 55 + v * 40);
    return `rgb(${f(r)},${f(g)},${f(b)})`;
  }
  const v = 8 + (n - 232) * 10;
  return `rgb(${v},${v},${v})`;
}

// —— 乱码修复 ——
// launcher 把 UTF-8 字节当 ANSI 写进控制台，控制台再按 UTF-8 编出来，
// 于是 "—"(E2 80 94) 变成 "â€”"(C3 A2 E2 82 AC E2 80 9D)。
// 这里把这段可逆变换倒回去：字符 → cp1252 字节 → 按 UTF-8 解。
const CP1252_REV = {
  '\u20AC': 0x80, '\u201A': 0x82, '\u0192': 0x83, '\u201E': 0x84, '\u2026': 0x85,
  '\u2020': 0x86, '\u2021': 0x87, '\u02C6': 0x88, '\u2030': 0x89, '\u0160': 0x8A,
  '\u2039': 0x8B, '\u0152': 0x8C, '\u017D': 0x8E, '\u2018': 0x91, '\u2019': 0x92,
  '\u201C': 0x93, '\u201D': 0x94, '\u2022': 0x95, '\u2013': 0x96, '\u2014': 0x97,
  '\u02DC': 0x98, '\u2122': 0x99, '\u0161': 0x9A, '\u203A': 0x9B, '\u0153': 0x9C,
  '\u017E': 0x9E, '\u0178': 0x9F,
};
const SUSPECT = /[\u0080-\u009F\u20AC\u201A\u0192\u201E\u2026\u2020\u2021\u02C6\u2030\u0160\u2039\u0152\u017D\u2018\u2019\u201C\u201D\u2022\u2013\u2014\u02DC\u2122\u0161\u203A\u0153\u017E\u0178]/;
let strictDecoder = null;
try { strictDecoder = new TextDecoder('utf-8', { fatal: true }); } catch (_) {}

function repairMojibake(text) {
  if (!strictDecoder || !SUSPECT.test(text)) return text;
  const bytes = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code < 0x100) bytes[i] = code;
    else if (CP1252_REV[text[i]] !== undefined) bytes[i] = CP1252_REV[text[i]];
    else return text; // 出现无法回退的字符，说明不是这种乱码，原样返回
  }
  try {
    return strictDecoder.decode(bytes);
  } catch (_) {
    return text;
  }
}

window.Term = Term;
window.repairMojibake = repairMojibake;

