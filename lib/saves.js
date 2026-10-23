'use strict';
// 存档备份 / 恢复 / 列表 / 删除
// 备份格式：backups/web-console/<时间戳>[_标签]/{manifest.json, *.sav, *.json}
// 用「复制整个 Game Saves」而不是增量，因为一次存档只有 4 个文件约 26MB，简单可靠。
const fs = require('fs');
const path = require('path');
const config = require('./config');

function stamp(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

function fmtDate(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

function dirSize(dir) {
  let total = 0;
  let st;
  try { st = fs.statSync(dir); } catch (_) { return 0; }
  if (st.isFile()) return st.size;
  let names;
  try { names = fs.readdirSync(dir); } catch (_) { return 0; }
  for (const n of names) total += dirSize(path.join(dir, n));
  return total;
}

const SAVE_FILE_RE = /\.(sav|json)$/i;

function listSaveFiles() {
  let names;
  try { names = fs.readdirSync(config.savesDir); } catch (_) { return []; }
  return names
    .filter((n) => SAVE_FILE_RE.test(n) && /^save|^TransferSave/i.test(n))
    .map((n) => {
      const full = path.join(config.savesDir, n);
      let st;
      try { st = fs.statSync(full); } catch (_) { return null; }
      return { name: n, size: st.size, mtime: st.mtimeMs };
    })
    .filter(Boolean)
    .sort((a, b) => b.mtime - a.mtime);
}

function listBackups() {
  let names;
  try { names = fs.readdirSync(config.backupDir); } catch (_) { return []; }
  const out = [];
  for (const n of names) {
    const full = path.join(config.backupDir, n);
    let st;
    try { st = fs.statSync(full); } catch (_) { continue; }
    if (!st.isDirectory()) continue;
    let manifest = null;
    try { manifest = JSON.parse(fs.readFileSync(path.join(full, 'manifest.json'), 'utf8')); } catch (_) {}
    out.push({
      id: n,
      createdAt: st.mtimeMs,
      createdAtText: fmtDate(new Date(st.mtimeMs)),
      size: dirSize(full),
      files: (manifest && manifest.files) || [],
      note: (manifest && manifest.note) || '',
      kind: (manifest && manifest.kind) || 'manual',
      triggers: (manifest && manifest.triggers) || [],
    });
  }
  return out.sort((a, b) => b.createdAt - a.createdAt);
}

function safeBackupPath(id) {
  const full = path.resolve(config.backupDir, id);
  const base = path.resolve(config.backupDir);
  if (!full.startsWith(base + path.sep)) throw new Error('非法备份标识：' + id);
  return full;
}

function copySaveFiles(intoDir) {
  fs.mkdirSync(intoDir, { recursive: true });
  const copied = [];
  for (const f of listSaveFiles()) {
    const from = path.join(config.savesDir, f.name);
    const to = path.join(intoDir, f.name);
    fs.copyFileSync(from, to);
    copied.push({ name: f.name, size: f.size, mtime: f.mtime });
  }
  return copied;
}

// kind: manual | pre-restore | auto
function createBackup({ note = '', kind = 'manual', triggers = [] } = {}) {
  const label = kind === 'pre-restore' ? 'pre-restore' : kind === 'auto' ? 'auto' : 'manual';
  let id = `${stamp()}_${label}`;
  let n = 1;
  while (fs.existsSync(path.join(config.backupDir, id))) id = `${stamp()}_${label}_${++n}`;

  const dir = path.join(config.backupDir, id);
  const files = copySaveFiles(dir);
  const manifest = {
    id,
    kind,
    note,
    triggers,
    createdAt: new Date().toISOString(),
    source: config.savesDir,
    files,
    totalBytes: files.reduce((s, f) => s + f.size, 0),
  };
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf8');
  return { id, dir, files, totalBytes: manifest.totalBytes };
}

function restoreBackup(id) {
  const dir = safeBackupPath(id);
  if (!fs.existsSync(dir)) throw new Error('备份不存在：' + id);

  // 先把当前状态另存一份，误恢复还能退回来
  const guard = createBackup({ kind: 'pre-restore', note: '恢复 ' + id + ' 之前的现场', triggers: [id] });

  const names = fs.readdirSync(dir).filter((n) => SAVE_FILE_RE.test(n));
  const restored = [];
  for (const n of names) {
    fs.copyFileSync(path.join(dir, n), path.join(config.savesDir, n));
    restored.push(n);
  }
  return { restored, guard: guard.id };
}

function deleteBackup(id) {
  const dir = safeBackupPath(id);
  if (!fs.existsSync(dir)) throw new Error('备份不存在：' + id);
  fs.rmSync(dir, { recursive: true, force: true });
  // 清掉可能的空父目录（不会删到 backupDir 本身）
  return true;
}

module.exports = {
  fmtDate,
  stamp,
  dirSize,
  listSaveFiles,
  listBackups,
  createBackup,
  restoreBackup,
  deleteBackup,
};
