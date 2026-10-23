'use strict';
// 控制台自身配置（服务端目录 / 存档目录 / 端口…）的「可编辑」支持：
//   describe()  当前生效值 + 哪些项被环境变量锁住 + 自检问题
//   validate()  校验一份待保存的值，返回致命错误/警告（不落盘）
//   save()      校验通过后写入 web-console/config.json（保留文件里其他键）
//
// 注意：只写控制台的 config.json，不碰游戏侧的 server-config.json。
// 写入后必须重启控制台才生效 —— lib/config.js 在 require 时就固化成常量了。
const fs = require('fs');
const path = require('path');
const config = require('./config');
const { parseJsonc } = require('./jsonc');

// 允许在页面上编辑的键（其余键保留原样不动）
const FIELDS = [
  { key: 'root', label: '服务端安装目录', hint: '含 DedicatedServer 子目录的那层；留空=自动探测', env: 'COOP_ROOT', kind: 'path' },
  { key: 'serverDir', label: '服务端目录', hint: '留空=root\\DedicatedServer；服务端单独放别处时填这里', env: 'COOP_SERVER_DIR', kind: 'path' },
  { key: 'coopData', label: '存档/配置根目录', hint: 'CoopData（Game Saves、server-config.json 在它下面）', env: 'COOP_DATA_DIR', kind: 'path' },
  { key: 'savesDir', label: '存档目录', hint: '留空=coopData\\DedicatedServer\\Game Saves', env: 'COOP_SAVES_DIR', kind: 'path' },
  { key: 'backupDir', label: '备份目录', hint: '留空=控制台目录\\backups', env: 'COOP_BACKUP_DIR', kind: 'path' },
  { key: 'port', label: '控制台端口', hint: '默认 7788；改完重启控制台生效', env: 'COOP_CONSOLE_PORT', kind: 'number' },
  { key: 'host', label: '监听地址', hint: '0.0.0.0=所有网卡（默认，不按来源 IP 过滤）/ 127.0.0.1=只本机 / auto=局域网+ZeroTier（不含公网网卡）', env: 'COOP_CONSOLE_HOST', kind: 'text' },
  { key: 'gamePort', label: '游戏端口', hint: '默认 4200（防火墙要放行 UDP）', env: 'COOP_GAME_PORT', kind: 'number' },
];
const EDITABLE = FIELDS.map((f) => f.key);

// 配置文件里的键名 ↔ config.js 导出的属性名不一致的两项：
// 文件里写 "port"/"host"（历史命名），config.js 里是 httpPort/httpHost
const VALUE_SOURCE = { port: 'httpPort', host: 'httpHost' };

function isDir(p) { try { return fs.statSync(p).isDirectory(); } catch (_) { return false; } }
function isFile(p) { try { return fs.statSync(p).isFile(); } catch (_) { return false; } }

// 当前生效值（来自 lib/config.js：env > config.json > 探测）
function currentValues() {
  const v = {};
  for (const f of FIELDS) {
    const src = VALUE_SOURCE[f.key] || f.key;
    v[f.key] = config[src] === undefined || config[src] === null ? '' : config[src];
  }
  return v;
}

// 哪些键被环境变量锁住了 —— 页面上要提示「改了文件也不生效」
function envLocked() {
  return FIELDS.filter((f) => process.env[f.env]).map((f) => f.key);
}

function describe() {
  return {
    ok: true,
    file: config.configFile,
    // 实时 stat，不用 config.configFileExists —— 那是控制台启动那一刻的快照，
    // 页面上点了保存之后文件才出现，用快照的话标签会一直停在「尚未创建」
    exists: isFile(config.configFile),
    fields: FIELDS,
    values: currentValues(),
    // 端口/地址当前生效值的来源（环境变量 / config.json / 命令行兜底 / 内置默认）
    sources: { port: config.httpPortSource, host: config.httpHostSource },
    envLocked: envLocked(),
    issues: config.check(),
    requiresRestart: true,
  };
}

// 校验待保存值。空字符串 = 不写这一项（走默认/自动探测）。
function validate(raw) {
  const input = raw || {};
  const issues = [];
  const clean = {};
  for (const f of FIELDS) {
    if (!(f.key in input)) continue;
    let v = input[f.key];
    if (v === null || v === undefined) continue;
    v = String(v).trim();
    if (v === '') continue; // 留空 = 用默认
    if (f.kind === 'number') {
      const n = Number(v);
      if (!Number.isInteger(n) || n < 1 || n > 65535) {
        issues.push({ key: f.key, level: 'fatal', msg: f.label + ' 必须是 1~65535 的整数' });
        continue;
      }
      clean[f.key] = n;
    } else {
      clean[f.key] = v;
    }
  }

  // 路径是否存在：只有「服务端能起得来」的那几项算致命
  const root = clean.root !== undefined ? clean.root : config.root;
  const serverDir = clean.serverDir !== undefined ? clean.serverDir
    : (clean.root !== undefined ? '' : config.serverDir);
  const exe = serverDir
    ? path.join(serverDir, 'BannerlordCoopServer.exe')
    : (root ? path.join(root, 'DedicatedServer', 'BannerlordCoopServer.exe') : '');
  const exeAlt = root ? path.join(root, 'BannerlordCoopServer.exe') : '';
  if (clean.serverDir || clean.root) {
    if (!isFile(exe) && !(exeAlt && isFile(exeAlt))) {
      issues.push({ key: clean.serverDir ? 'serverDir' : 'root', level: 'fatal',
        msg: '服务端可执行文件不存在：' + (isFile(exeAlt) ? exeAlt : exe),
      });
    }
  }
  if (clean.coopData && !isDir(clean.coopData)) {
    issues.push({ key: 'coopData', level: 'fatal',
      msg: '存档/配置根目录不存在：' + clean.coopData + '（先启动过一次服务端，或填对路径）' });
  }
  if (clean.savesDir && !isDir(clean.savesDir)) {
    issues.push({ key: 'savesDir', level: 'warn', msg: '存档目录还不存在：' + clean.savesDir });
  }
  if (clean.backupDir && !isDir(clean.backupDir)) {
    issues.push({ key: 'backupDir', level: 'warn', msg: '备份目录还不存在（第一次备份时会自动创建）' });
  }
  if (clean.host !== undefined && !/^(auto|[\d.]+,?)+$/i.test(clean.host) && clean.host !== 'localhost') {
    issues.push({ key: 'host', level: 'warn', msg: '监听地址不常见：' + clean.host + '（支持 127.0.0.1 / auto / 0.0.0.0 / 逗号列表）' });
  }

  return { ok: !issues.some((i) => i.level === 'fatal'), values: clean, issues };
}

// 写 config.json：只更新可编辑键，文件里其他键原样保留
function save(raw) {
  const v = validate(raw);
  if (!v.ok) return { ok: false, file: config.configFile, values: v.values, issues: v.issues };

  let existing = {};
  try {
    existing = parseJsonc(fs.readFileSync(config.configFile, 'utf8').replace(/^\uFEFF/, '')) || {};
  } catch (e) {
    if (e.code !== 'ENOENT') {
      return { ok: false, file: config.configFile, issues: [{ key: 'file', level: 'fatal', msg: '现有 config.json 解析失败：' + e.message }] };
    }
  }
  const merged = Object.assign({}, existing);
  for (const f of FIELDS) {
    if (f.key in raw || (raw && raw[f.key] === '')) {
      if (f.key in v.values) merged[f.key] = v.values[f.key];
      else delete merged[f.key];
    }
  }

  const header = '// Bannerlord Coop 控制台配置（本文件由控制台的「配置」页生成，也可手改）\n'
    + '// 优先级：环境变量 > 本文件 > 自动探测。改完重启控制台生效。\n';
  fs.writeFileSync(config.configFile, header + JSON.stringify(merged, null, 2) + '\n', 'utf8');
  return {
    ok: true,
    file: config.configFile,
    values: v.values,
    persisted: merged,
    issues: v.issues,
    requiresRestart: true,
    // 环境变量锁住的项：写进去了也不生效，得先取消环境变量
    lockedIgnored: envLocked().filter((k) => k in merged),
  };
}

module.exports = { FIELDS, EDITABLE, describe, validate, save, currentValues, envLocked };

if (require.main === module) {
  const d = describe();
  console.log('配置文件:', d.file, d.exists ? '(已存在)' : '(未创建)');
  console.log('被环境变量锁定:', d.envLocked.length ? d.envLocked.join(', ') : '无');
  for (const f of d.fields) console.log('  ' + f.key.padEnd(16) + String(d.values[f.key]));
  console.log('自检问题:', d.issues.length ? JSON.stringify(d.issues, null, 2) : '无');
}
