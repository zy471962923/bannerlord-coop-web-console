'use strict';
// 中文本地化词典：字符串 id → 中文译文。
//
// 为什么需要它：服务端以英文语种运行，`TextObject.ToString()` 拿到的永远是英文
// （"Plumed Nomad Helmet"、"Battanian Fian Champion"）。但这**不是占位名**，
// 只是没取到译文。
//
// 官方中文包就在服务端目录里：
//   Modules/<模块>/ModuleData/Languages/CNs/std_*-zho-CN.xml
// 它们按「字符串 id」存译文，例如物品 `name="{=m3Nv9rt2}Plumed Nomad Helmet"`
// 对应的就是 <string id="m3Nv9rt2" text="…"/>。
// 包里**只有译文、没有英文原文**，所以只能在采集端把 id 带出来（模块输出的 nameId），
// 这里拿 id 查中文。查不到就老实用英文，不猜。
//
// 两个编码坑：
//   1. 这些文件是 UTF-16，而且是 **大端**（BOM = FE FF）。直接 toString('utf16le')
//      会得到一串乱码汉字，必须 swap16() 之后再解。
//   2. 有少数文件是 UTF-8 带 BOM，得按 BOM 分辨，不能写死一种编码。
const fs = require('fs');
const path = require('path');
const config = require('./config');

const MODULES_DIR = path.join(config.serverDir, 'engine', 'Modules');

function decodeXml(buf) {
  let text;
  if (buf.length >= 2 && buf[0] === 0xfe && buf[1] === 0xff) {
    // UTF-16BE：换字节序后按 LE 解。
    // 注意 swap16() 会把 BOM FE FF 翻成 FF FE，解出来开头就多一个 \uFEFF，末尾统一剥掉。
    const copy = Buffer.from(buf);
    if (copy.length % 2) return buf.toString('utf8');
    copy.swap16();
    text = copy.toString('utf16le');
  } else if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) {
    text = buf.toString('utf16le');
  } else {
    text = buf.toString('utf8');
  }
  // 三种编码都可能带 BOM，统一去掉，否则 `<string` 正则还好（前面只是空白/BOM 字符），
  // 但调用方拿到的首字符就是 \uFEFF，很难排查。
  return text.replace(/^\uFEFF/, '');
}

function unescapeXml(s) {
  return String(s)
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&amp;/g, '&'); // & 必须最后换，否则 &amp;lt; 会被二次解码
}

// 找出所有 CNs 目录下的 xml
function listFiles() {
  const out = [];
  let mods = [];
  try { mods = fs.readdirSync(MODULES_DIR); } catch (_) { return out; }

  for (const mod of mods) {
    const dir = path.join(MODULES_DIR, mod, 'ModuleData', 'Languages', 'CNs');
    let names = [];
    try { names = fs.readdirSync(dir); } catch (_) { continue; }
    for (const n of names) {
      if (!/\.xml$/i.test(n)) continue;
      const p = path.join(dir, n);
      try { out.push({ file: p, mtimeMs: fs.statSync(p).mtimeMs, size: fs.statSync(p).size }); } catch (_) {}
    }
  }
  return out.sort((a, b) => a.file.localeCompare(b.file));
}

let cache = { sig: '', map: null };

function signature(files) {
  return files.map((f) => f.file + ':' + f.mtimeMs + ':' + f.size).join('|');
}

// 返回 Map<id, 中文>。文件没变就复用上次解析结果（约 7000+ 条，别每次请求都重解 1MB XML）
function load() {
  const files = listFiles();
  const sig = signature(files);
  if (cache.map && cache.sig === sig) return cache.map;

  const map = new Map();
  const perFile = [];
  for (const f of files) {
    let txt;
    try { txt = decodeXml(fs.readFileSync(f.file)); } catch (_) { continue; }

    const re = /<string\s+id="([^"]+)"\s+text="([^"]*)"/g;
    let m;
    let n = 0;
    while ((m = re.exec(txt)) !== null) {
      // 先出现的优先：Native → SandBoxCore → SandBox 的官方译文，别被后加载的覆盖
      if (!map.has(m[1])) map.set(m[1], unescapeXml(m[2]));
      n++;
    }
    perFile.push({ file: path.basename(f.file), entries: n });
  }

  cache = { sig, map, perFile, files, loadedAt: Date.now() };
  return map;
}

function zh(id) {
  const key = String(id || '').trim();
  if (!key) return '';
  const map = load();
  return map.get(key) || '';
}

// 取中文，取不到就退回原文（原文可能是英文，也可能本来就是中文 —— 打造物品名字是玩家
// 客户端生成的，存进存档时已经是中文，这种就没有 id 可查）
function zhOr(id, fallback) {
  return zh(id) || String(fallback || '');
}

function stats() {
  const map = load();
  return {
    files: (cache.files || []).length,
    perFile: cache.perFile || [],
    entries: map.size,
    loadedAt: cache.loadedAt || 0,
    modulesDir: MODULES_DIR,
  };
}

module.exports = { zh, zhOr, load, stats, decodeXml, listFiles };

// 直接跑：node lib/l10n.js [id ...]  —— 手工验证某个 id 有没有译文
if (require.main === module) {
  const ids = process.argv.slice(2);
  const s = stats();
  console.log('模块目录 :', s.modulesDir);
  console.log('语言包   :', s.files, '个文件，去重后', s.entries, '条');
  for (const f of s.perFile) console.log('   ', String(f.entries).padStart(6), f.file);
  for (const id of ids) console.log('   ', id, '->', zh(id) || '(没有译文)');
}
