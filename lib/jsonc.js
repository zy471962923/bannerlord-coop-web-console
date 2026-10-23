'use strict';
// 读取允许 // 注释与尾逗号的 JSON（server-config.json / mod-config.json 都是这种格式）
function stripJsonc(text) {
  let out = '';
  let inStr = false;
  let inLine = false;
  let inBlock = false;
  let esc = false;

  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    const n = text[i + 1];

    if (inLine) {
      if (c === '\n') { inLine = false; out += c; }
      continue;
    }
    if (inBlock) {
      if (c === '*' && n === '/') { inBlock = false; i++; }
      continue;
    }
    if (inStr) {
      out += c;
      if (esc) { esc = false; continue; }
      if (c === '\\') { esc = true; continue; }
      if (c === '"') { inStr = false; }
      continue;
    }
    if (c === '"') { inStr = true; out += c; continue; }
    if (c === '/' && n === '/') { inLine = true; i++; continue; }
    if (c === '/' && n === '*') { inBlock = true; i++; continue; }
    out += c;
  }

  // 去掉尾逗号：  , }   , ]
  return out.replace(/,(\s*[}\]])/g, '$1');
}

function parseJsonc(text) {
  return JSON.parse(stripJsonc(text.replace(/^\uFEFF/, '')));
}

module.exports = { stripJsonc, parseJsonc };
