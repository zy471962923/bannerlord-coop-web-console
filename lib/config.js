'use strict';
// 统一路径与常量。分发给别人用时，只改 config.json 就能跑。
//
// 配置来源优先级（后者覆盖前者）：
//   1. 自动探测 / 内置默认值   —— 控制台自身位置推算 + 常见安装位置扫描
//   2. config.json             —— 默认在 web-console/config.json，
//                                 可用 COOP_CONSOLE_CONFIG 指定别的文件；
//                                 允许 // 注释和尾逗号（用 lib/jsonc 解析）
//   3. 环境变量                —— COOP_ROOT / COOP_SERVER_DIR / COOP_DATA_DIR /
//                                 COOP_CONSOLE_PORT / COOP_CONSOLE_HOST / COOP_GAME_PORT ...
//
// 改完要重启控制台才生效（本文件是常驻模块）。
//
// 自检：node lib/config.js        打印解析结果 + 每项是否存在 + 问题提示
//       node lib/config.js --init 按当前探测结果生成 config.json（已存在则不动）
const fs = require('fs');
const os = require('os');
const path = require('path');
const { parseJsonc } = require('./jsonc');

// —— 控制台自身位置：路径全部相对它推算，所以整个目录可以随便搬到哪 ——
const CONSOLE_DIR = path.resolve(__dirname, '..');
const CONFIG_FILE = process.env.COOP_CONSOLE_CONFIG || path.join(CONSOLE_DIR, 'config.json');

function readConfigFile(file) {
  try {
    const raw = fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '');
    const obj = parseJsonc(raw);
    return obj && typeof obj === 'object' ? obj : {};
  } catch (e) {
    if (e.code !== 'ENOENT') {
      console.warn('[config] ' + file + ' 解析失败：' + e.message + '（改用自动探测）');
    }
    return {};
  }
}
const file = readConfigFile(CONFIG_FILE);

function isFile(p) {
  try { return fs.statSync(p).isFile(); } catch (_) { return false; }
}
function isDir(p) {
  try { return fs.statSync(p).isDirectory(); } catch (_) { return false; }
}

// 环境变量 > config.json > 默认值
function pick(envKey, fileKey, fallback) {
  if (process.env[envKey]) return process.env[envKey];
  const v = file[fileKey];
  if (v !== undefined && v !== null && v !== '') return String(v);
  return fallback;
}

// —— 命令行参数（start-console.bat 用）——
// 为什么不再用环境变量：环境变量在优先级链最顶端，一旦 bat 里 set 了，
// 控制台「配置」页写进 config.json 的端口/监听地址就永远被压住、改了也不生效
// （页面上那两栏还会置灰显示「环境变量锁定」）。
//
// 按「表达的是什么」分两类，优先级不同：
//   明确给了值： --port 7790 / --host 1.2.3.4   —— 这一次启动就要这个，压过 config.json
//   只表达意图： --lan / --local                —— 只是兜底默认，config.json 写了就以文件为准
// 这样「双击 bat 走配置」和「start-console.bat lan 7790 开副面板」两种用法都不打架。
const ARGV = process.argv.slice(2);
function hasFlag(names) {
  return names.some((n) => ARGV.some((a) => a.toLowerCase() === n));
}
function argvOpt(name) {
  const eq = '--' + name + '=';
  for (let i = 0; i < ARGV.length; i++) {
    const a = ARGV[i];
    if (a.indexOf(eq) === 0) return a.slice(eq.length);
    if (a === '--' + name) return ARGV[i + 1] || '';
  }
  return '';
}
const ARG_PORT = argvOpt('port');
const ARG_HOST = argvOpt('host');
const ARG_LAN = hasFlag(['--lan', 'lan']);
const ARG_LOCAL = hasFlag(['--local', 'local']);
const ARG_HOST_MODE = ARG_LAN ? 'auto' : ARG_LOCAL ? '127.0.0.1' : '';

// 把三个来源摆成一条有序链，取第一个有值的，顺带记下来源（启动日志/页面会显示）
function srcEnv(k) { return { v: process.env[k] || '', src: '环境变量 ' + k }; }
function srcArg(v, label) { return { v: v || '', src: '命令行 ' + label }; }
function srcFile(k) {
  const v = file[k];
  return { v: v === undefined || v === null ? '' : String(v), src: 'config.json 的 "' + k + '"' };
}
function firstOf(cands, fallback) {
  for (const c of cands) if (c.v !== '') return c;
  return { v: String(fallback), src: '内置默认值' };
}

function toPort(v, def) {
  const n = Number(v);
  if (!Number.isFinite(n) || n < 1 || n > 65535) {
    console.warn('[config] 端口取值不合法：' + v + '（应为 1~65535），改用 ' + def);
    return def;
  }
  return n;
}

// —— 自动探测服务端安装目录 ——
// 从 web-console 往上最多 5 层，找含 DedicatedServer\BannerlordCoopServer.exe 的那层；
// 也接受“这层本身就是服务端目录”（BannerlordCoopServer.exe 直接在下面）。
function looksLikeRoot(dir) {
  return isFile(path.join(dir, 'DedicatedServer', 'BannerlordCoopServer.exe'))
    || isFile(path.join(dir, 'BannerlordCoopServer.exe'));
}
function detectRoot() {
  let d = CONSOLE_DIR;
  for (let i = 0; i < 5; i++) {
    if (looksLikeRoot(d)) return d;
    const up = path.dirname(d);
    if (up === d) break;
    d = up;
  }
  return '';
}

const ROOT = pick('COOP_ROOT', 'root', detectRoot());

// 服务端目录：可以直接给 serverDir（有人不爱用 root/DedicatedServer 这层）
let SERVER_DIR = pick('COOP_SERVER_DIR', 'serverDir', '');
if (!SERVER_DIR && ROOT) {
  SERVER_DIR = isFile(path.join(ROOT, 'BannerlordCoopServer.exe'))
    ? ROOT
    : path.join(ROOT, 'DedicatedServer');
}

// 存档/配置目录：默认跟着 Windows 的「文档」走，不写死用户名
const COOP_DATA = pick('COOP_DATA_DIR', 'coopData',
  path.join(os.homedir(), 'Documents', 'Mount and Blade II Bannerlord', 'CoopData'));
const DS_DATA = pick('COOP_DS_DATA_DIR', 'dsData', path.join(COOP_DATA, 'DedicatedServer'));

// 备份目录：兼容老布局（root/backups/web-console），否则放控制台自己旁边
const LEGACY_BACKUP = ROOT ? path.join(ROOT, 'backups', 'web-console') : '';
const BACKUP_DIR = pick('COOP_BACKUP_DIR', 'backupDir',
  LEGACY_BACKUP && isDir(LEGACY_BACKUP) ? LEGACY_BACKUP : path.join(CONSOLE_DIR, 'backups'));

// 端口：环境变量 > --port（显式值） > config.json > 内置默认
const PORT_PICK = firstOf([
  srcEnv('COOP_CONSOLE_PORT'), srcArg(ARG_PORT, '--port'), srcFile('port'),
], 7788);
// 监听地址：环境变量 > --host（显式值） > config.json > --lan/--local（模式兜底） > 内置默认
// 默认 0.0.0.0：发布版要的是「解压就能用、别人能打开」，全网卡监听最省事。
// 只放本机用 start-console.bat local（或页面里把地址改成 127.0.0.1）。
const HOST_PICK = firstOf([
  srcEnv('COOP_CONSOLE_HOST'), srcArg(ARG_HOST, '--host'), srcFile('host'),
  srcArg(ARG_HOST_MODE, ARG_LAN ? '--lan' : '--local'),
], '0.0.0.0');

const config = {
  // —— 配置文件本身（给 /api/config 和启动日志显示）——
  configFile: CONFIG_FILE,
  configFileExists: isFile(CONFIG_FILE),

  // —— 服务端本体 ——
  root: ROOT,
  serverDir: SERVER_DIR,
  serverExe: path.join(SERVER_DIR, 'BannerlordCoopServer.exe'),

  // —— 数据目录（server-config.json 里 "data :" 打印的就是这里）——
  coopData: COOP_DATA,
  dsData: DS_DATA,
  serverConfig: pick('COOP_SERVER_CONFIG', 'serverConfig', path.join(DS_DATA, 'server-config.json')),
  modConfig: pick('COOP_MOD_CONFIG', 'modConfig', path.join(COOP_DATA, 'mod-config.json')),
  savesDir: pick('COOP_SAVES_DIR', 'savesDir', path.join(DS_DATA, 'Game Saves')),
  dsLogsDir: pick('COOP_LOGS_DIR', 'dsLogsDir', path.join(DS_DATA, 'logs')),

  // —— 玩家详情导出（由 CoopPlayerCard 模块每 15 秒落盘）——
  // 工作目录 = engine/bin/Win64_Shipping_Server，不是 Modules/Coop/bin/...，别改错
  playercardsFile: pick('COOP_PLAYERCARDS_FILE', 'playercardsFile', SERVER_DIR
    ? path.join(SERVER_DIR, 'engine', 'bin', 'Win64_Shipping_Server', 'playercards', 'playercards.json')
    : ''),

  // —— 本控制台（相对自身，可整体搬走）——
  consoleDir: CONSOLE_DIR,
  dataDir: pick('COOP_CONSOLE_DATA_DIR', 'dataDir', path.join(CONSOLE_DIR, 'data')),
  backupDir: BACKUP_DIR,

  // —— 运行时 ——
  httpPort: toPort(PORT_PICK.v, 7788),
  httpHost: HOST_PICK.v,
  // 这两个值是从哪来的：启动日志会打出来，排查「改了怎么没生效」用
  httpPortSource: PORT_PICK.src,
  httpHostSource: HOST_PICK.src,
  gamePort: toPort(pick('COOP_GAME_PORT', 'gamePort', 4200), 4200),

  // PTY 尺寸：与服务端 TUI 排版匹配
  ptyCols: Number(pick('COOP_PTY_COLS', 'ptyCols', 160)),
  ptyRows: Number(pick('COOP_PTY_ROWS', 'ptyRows', 45)),

  // 停止服务器时，等它自己退出的最长时间（毫秒），超时强杀
  stopGraceMs: Number(pick('COOP_STOP_GRACE_MS', 'stopGraceMs', 45000)),
};

// —— 自检：返回「哪项不存在 + 该怎么填」 ——
// fatal 的项会让控制台根本没法起服；其余只是功能缺一块（比如还没部署模块）。
config.check = function check() {
  const issues = [];
  if (!config.serverDir) {
    issues.push({ key: 'serverDir', fatal: true,
      msg: '没找到服务端目录（自动探测失败）',
      hint: '在 config.json 里写 "serverDir": "D:\\你的路径\\DedicatedServer"' });
  } else if (!isFile(config.serverExe)) {
    issues.push({ key: 'serverDir', fatal: true,
      msg: '服务端可执行文件不存在：' + config.serverExe,
      hint: '检查 config.json 的 "root" 或 "serverDir"' });
  }
  if (!isDir(config.coopData)) {
    issues.push({ key: 'coopData', fatal: true,
      msg: '数据目录不存在：' + config.coopData,
      hint: '先启动过一次服务端，或在 config.json 里写 "coopData"' });
  }
  if (!isDir(config.savesDir)) {
    issues.push({ key: 'savesDir', fatal: false,
      msg: '存档目录不存在：' + config.savesDir,
      hint: '服务端跑过一次并保存后会自动出现；也可在 config.json 里写 "savesDir"' });
  }
  if (!isDir(config.dsLogsDir)) {
    issues.push({ key: 'dsLogsDir', fatal: false,
      msg: '日志目录不存在：' + config.dsLogsDir,
      hint: '服务端启动过一次就会出现；也可写 "dsLogsDir"' });
  }
  if (!config.playercardsFile || !isFile(config.playercardsFile)) {
    issues.push({ key: 'playercardsFile', fatal: false,
      msg: '玩家详情导出文件还没出现（玩家档案/地图会空）',
      hint: 'CoopPlayerCard 模块部署过且服务端跑到读档完成后才会有；路径不对就写 "playercardsFile"' });
  }
  return issues;
};

// —— 生成 config.json 模板（--init）——
config.template = function template() {
  const j = (v) => JSON.stringify(v);
  return `// Bannerlord Coop 控制台配置。改完重启控制台生效。
// 相对路径会按控制台所在目录解析；Windows 路径里的反斜杠要写成 \\\\。
{
  // 服务端安装目录（含 DedicatedServer 子目录的那层）
  "root": ${j(config.root)},
  // 服务端目录；留空则用 root\\\\DedicatedServer
  "serverDir": ${j(config.serverDir)},
  // 存档/配置所在（Windows「文档」下），换机器一定要改
  "coopData": ${j(config.coopData)},
  // 控制台监听端口与地址：127.0.0.1 只本机；auto = 回环 + 私有网段
  "port": ${config.httpPort},
  "host": ${j(config.httpHost)},
  // 游戏端口（防火墙要放行的那个）
  "gamePort": ${config.gamePort}
}
`;
};

module.exports = config;

// —— CLI：node lib/config.js [--init] ——
if (require.main === module) {
  const wantInit = process.argv.includes('--init');
  if (wantInit) {
    if (config.configFileExists) {
      console.log('已存在，不覆盖：' + CONFIG_FILE);
    } else {
      fs.writeFileSync(CONFIG_FILE, config.template(), 'utf8');
      console.log('已生成：' + CONFIG_FILE + '（按需修改后重启控制台）');
    }
  }
  const rows = [
    ['配置文件', config.configFile, config.configFileExists],
    ['服务端目录', config.serverDir, isDir(config.serverDir)],
    ['服务端 exe', config.serverExe, isFile(config.serverExe)],
    ['数据目录', config.coopData, isDir(config.coopData)],
    ['存档目录', config.savesDir, isDir(config.savesDir)],
    ['日志目录', config.dsLogsDir, isDir(config.dsLogsDir)],
    ['玩家卡导出', config.playercardsFile, isFile(config.playercardsFile)],
    ['备份目录', config.backupDir, isDir(config.backupDir)],
    ['监听', config.httpHost + ':' + config.httpPort
      + '   ← 地址来自 ' + config.httpHostSource + '，端口来自 ' + config.httpPortSource, true],
  ];
  console.log('');
  console.log('  路径解析结果（✓ 存在 / ✗ 不存在）');
  console.log('');
  const pad = Math.max(...rows.map((r) => r[0].length)) + 2;
  for (const [k, v, ok] of rows) {
    console.log('  ' + (ok ? '✓' : '✗') + ' ' + k.padEnd(pad) + v);
  }
  const issues = config.check();
  if (issues.length) {
    console.log('');
    for (const i of issues) {
      console.log('  ' + (i.fatal ? '✗' : '⚠') + ' ' + i.msg);
      console.log('    → ' + i.hint);
    }
  }
  console.log('');
}
