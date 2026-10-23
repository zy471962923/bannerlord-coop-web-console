'use strict';
// 实时日志尾部读取器
// 为什么要读日志文件而不是直接读 PTY：日志文件里是逐行纯文本（带时间戳、无 ANSI 重绘），
// 适合做可搜索、可下载的干净视图；PTY 输出留给「TUI 镜像」用。
const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');

const utf8Decoder = new TextDecoder('utf-8');
let gbkDecoder = null;
try { gbkDecoder = new TextDecoder('gbk'); } catch (_) { /* 无 full-icu */ }

// 引擎部分子进程输出是 GBK，日志文件里就成了乱码字节；先按 UTF-8 解，坏了再用 GBK 重解
function decodeLine(buf) {
  const s = buf.toString('utf8');
  if (s.includes('\uFFFD') && gbkDecoder) {
    try { return gbkDecoder.decode(buf); } catch (_) { /* 保留 UTF-8 结果 */ }
  }
  return s;
}

// 载入期会刷 700+ 条同类告警，属于引擎内部簿记，不是可操作信息 → 归到 noise
const NOISE_PATTERNS = [
  /\["ObjectManager"\] Failed to get id for object/,
  /^\s*Loading xml file/,
  /^\s*Loading module/,
];

const LEVEL_PATTERNS = [
  { level: 'error', re: /\b(ERROR|FATAL|Exception|Unhandled|StackTrace|System\.\w+Exception)\b/ },
  { level: 'warn', re: /\b(WARN|WARNING|deprecated|failed|Failed|refused|cannot|could not)\b/ },
  { level: 'ok', re: /(SERVING|verified against release pins|harmony bootstrapped|\[CoopSmithingFix\] loaded)/ },
];

function classify(msg) {
  if (NOISE_PATTERNS.some((r) => r.test(msg))) return 'noise';
  for (const p of LEVEL_PATTERNS) if (p.re.test(msg)) return p.level;
  if (msg.startsWith('@DS@')) return 'ds';
  if (/\[launcher\]/.test(msg)) return 'launcher';
  return 'info';
}

// 日志行形如：09:55:08.104  [DedicatedServer] xxx
function parseLine(raw) {
  const m = raw.match(/^(\d{2}:\d{2}:\d{2}\.\d{3})\s+(.*)$/);
  const time = m ? m[1] : '';
  const msg = m ? m[2] : raw;
  return { time, msg, level: classify(msg), raw };
}

class LogTailer extends EventEmitter {
  constructor(dir, maxLines = 6000) {
    super();
    this.dir = dir;
    this.maxLines = maxLines;
    this.buffer = [];
    this.file = null;
    this.offset = 0;
    this.pending = Buffer.alloc(0);
    this.timer = null;
    this.busy = false;
    this.inStack = false;
  }

  newestLog() {
    let best = null;
    let bestTime = 0;
    let files;
    try { files = fs.readdirSync(this.dir); } catch (_) { return null; }
    for (const f of files) {
      if (!/^coop-server-.*\.log$/i.test(f)) continue;
      const full = path.join(this.dir, f);
      let st;
      try { st = fs.statSync(full); } catch (_) { continue; }
      const key = st.mtimeMs;
      if (key > bestTime) { bestTime = key; best = { name: f, full, size: st.size, mtime: st.mtimeMs }; }
    }
    return best;
  }

  start() {
    if (this.timer) return;
    this.poll();
    this.timer = setInterval(() => this.poll(), 400);
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  history(n = 400) {
    return this.buffer.slice(-n);
  }

  push(lines) {
    if (!lines.length) return;
    this.tagStackBlocks(lines);
    for (const l of lines) this.buffer.push(l);
    if (this.buffer.length > this.maxLines) {
      this.buffer.splice(0, this.buffer.length - this.maxLines);
    }
    this.emit('lines', lines);
  }

  // 服务端每分钟重试一次 telemetry 上传，每次都吐一坨 .NET 堆栈（已确认失败 60 次/小时）。
  // 这些行对运维毫无价值，标成 noise 让前端默认折叠，别把真正的错误淹了。
  tagStackBlocks(lines) {
    for (const l of lines) {
      const msg = l.msg || '';
      if (/Reporting server telemetry failed/.test(msg)) {
        l.level = 'warn';
        this.inStack = true;
        continue;
      }
      if (this.inStack && /^(at |--->|--- End of|System\.|Inner Exception)/.test(msg)) {
        l.level = 'noise';
        continue;
      }
      this.inStack = false;
    }
  }

  // 切换到（新出现的）日志文件：回放末尾若干行作为历史
  switchTo(info, replayLines) {
    this.file = info.name;
    this.pending = Buffer.alloc(0);
    this.buffer = [];
    this.offset = 0;

    if (replayLines > 0) {
      let fd;
      try {
        fd = fs.openSync(info.full, 'r');
        const size = fs.fstatSync(fd).size;
        const readLen = Math.min(size, 512 * 1024);
        const start = size - readLen;
        const buf = Buffer.alloc(readLen);
        fs.readSync(fd, buf, 0, readLen, start);
        let lines = decodeLine(buf).split('\n');
        // 从文件中间开始读，第一行可能是半截，丢掉
        if (start > 0) lines = lines.slice(1);
        const parsed = lines
          .map((l) => l.replace(/\r$/, ''))
          .filter((l) => l.trim().length)
          .slice(-replayLines)
          .map(parseLine);
        this.offset = size;
        this.push(parsed);
      } catch (_) {
        this.offset = info.size;
      } finally {
        if (fd !== undefined) { try { fs.closeSync(fd); } catch (_) {} }
      }
    } else {
      this.offset = 0;
    }

    this.emit('file', info.name);
  }

  poll() {
    if (this.busy) return;
    this.busy = true;
    try {
      const info = this.newestLog();
      if (!info) return;
      if (info.name !== this.file) {
        const isFirst = this.file === null;
        this.switchTo(info, isFirst || this.file ? 600 : 0);
      }
      this.readFrom(info);
    } finally {
      this.busy = false;
    }
  }

  readFrom(info) {
    let st;
    try { st = fs.statSync(info.full); } catch (_) { return; }
    if (st.size < this.offset) this.offset = st.size; // 被截断/重写
    if (st.size === this.offset) return;

    const len = st.size - this.offset;
    const buf = Buffer.alloc(len);
    let fd;
    try {
      fd = fs.openSync(info.full, 'r');
      fs.readSync(fd, buf, 0, len, this.offset);
    } catch (_) {
      return;
    } finally {
      if (fd !== undefined) { try { fs.closeSync(fd); } catch (_) {} }
    }
    this.offset = st.size;

    let data = Buffer.concat([this.pending, buf]);
    const lines = [];
    let idx;
    while ((idx = data.indexOf(0x0a)) >= 0) {
      const lineBuf = data.subarray(0, idx);
      data = data.subarray(idx + 1);
      const text = decodeLine(lineBuf).replace(/\r$/, '');
      if (text.trim().length) lines.push(parseLine(text));
    }
    this.pending = data.length > 65536 ? Buffer.alloc(0) : data;
    this.push(lines);
  }
}

module.exports = { LogTailer, parseLine };
