'use strict';
// 「配置页手动编辑」自测：lib/console-config.js 的 validate() / save() / describe()
//
// 重点验证四件事：
//   1. 空值 = 删掉这一项（回退到默认/自动探测），不是写空字符串
//   2. 校验不过（端口越界、服务端 exe 不存在）时绝不落盘
//   3. 保存只动可编辑的 8 个键，文件里其他键原样保留
//   4. 写出来的文件仍是带注释的合法 JSON（jsonc 能读回）
//
// 为什么全在子进程里跑：lib/config.js 在 require 时就把 configFile 固化下来了，
// 同一进程里改 COOP_CONSOLE_CONFIG 不会重新解析 —— 每个场景起一个新进程最干净，
// 也保证不会碰到真实的 config.json。
//
// 用法：node tools/test-console-config.js
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

let pass = 0;
const fails = [];
function check(name, fn) {
  try { fn(); pass++; console.log('  ✓ ' + name); }
  catch (e) { fails.push(name + ' —— ' + e.message); console.log('  ✗ ' + name + ' —— ' + e.message); }
}

const CONSOLE_DIR = path.resolve(__dirname, '..');
const CC = path.join(CONSOLE_DIR, 'lib', 'console-config.js');
const JSONC = path.join(CONSOLE_DIR, 'lib', 'jsonc.js');

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'coopcc-'));

// 子进程里跑一段代码，要求它 print 一个 JSON
function child(env, code) {
  const base = Object.assign({}, process.env);
  // 先把可能污染结果的 COOP_* 清空（空字符串在 pick()/envLocked() 里都算 falsy）
  for (const k of ['COOP_ROOT', 'COOP_SERVER_DIR', 'COOP_DATA_DIR', 'COOP_SAVES_DIR',
    'COOP_BACKUP_DIR', 'COOP_CONSOLE_PORT', 'COOP_CONSOLE_HOST', 'COOP_GAME_PORT']) base[k] = '';
  const out = execFileSync(process.execPath, ['-e', code], {
    env: Object.assign(base, env), encoding: 'utf8',
  });
  return JSON.parse(out);
}

// 每个场景一个独立的 config.json，互不干扰
let seq = 0;
function freshConfig(initial) {
  const f = path.join(tmpRoot, 'cfg' + (++seq) + '.json');
  if (initial !== undefined) fs.writeFileSync(f, initial, 'utf8');
  return f;
}

function validate(env, input) {
  return child(env, 'const cc=require(' + JSON.stringify(CC) + ');'
    + 'process.stdout.write(JSON.stringify(cc.validate(' + JSON.stringify(input) + ')))');
}

function save(env, input) {
  return child(env, 'const cc=require(' + JSON.stringify(CC) + ');'
    + 'process.stdout.write(JSON.stringify(cc.save(' + JSON.stringify(input) + ')))');
}

function describeOn(env) {
  return child(env, 'const cc=require(' + JSON.stringify(CC) + ');'
    + 'process.stdout.write(JSON.stringify(cc.describe()))');
}

// 读回写出来的文件（用控制台自己的 jsonc 解析，顺带验证注释不破坏解析）
function readBack(file) {
  const { parseJsonc } = require(JSONC);
  return parseJsonc(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
}

// 造一个假安装目录，用于「路径合法」的场景
const fakeRoot = path.join(tmpRoot, 'Game');
const fakeServer = path.join(fakeRoot, 'DedicatedServer');
fs.mkdirSync(fakeServer, { recursive: true });
fs.writeFileSync(path.join(fakeServer, 'BannerlordCoopServer.exe'), 'stub');
const fakeCoopData = path.join(tmpRoot, 'CoopData');
fs.mkdirSync(fakeCoopData, { recursive: true });

console.log('');
console.log('  配置页可编辑表单自测（子进程里跑真实 lib/console-config.js）');
console.log('');

// —————————————————— validate ——————————————————

check('留空的项被剔除，不会被当成「要写空字符串」', () => {
  const r = validate({ COOP_CONSOLE_CONFIG: freshConfig() }, { root: '', port: '', host: '  auto  ' });
  assert.strictEqual(r.ok, true, '不该有致命问题');
  assert.deepStrictEqual(r.values, { host: 'auto' }, '应只保留 host 且去掉首尾空格: ' + JSON.stringify(r.values));
});

check('端口越界 / 非数字 → fatal', () => {
  for (const bad of ['0', '70000', 'abc', '-1', '12.5']) {
    const r = validate({ COOP_CONSOLE_CONFIG: freshConfig() }, { port: bad });
    assert.strictEqual(r.ok, false, 'port=' + bad + ' 应判致命');
    assert.ok(r.issues.some((i) => i.key === 'port' && i.level === 'fatal'), 'port=' + bad + ' 没报 fatal');
    assert.ok(!('port' in r.values), 'port=' + bad + ' 不该进 values');
  }
  const okNum = validate({ COOP_CONSOLE_CONFIG: freshConfig() }, { port: '7801', gamePort: 4300 });
  assert.deepStrictEqual(okNum.values, { port: 7801, gamePort: 4300 }, '合法端口应转成数字');
});

check('服务端 exe 不存在 → fatal，且提示里带出真实路径', () => {
  const r = validate({ COOP_CONSOLE_CONFIG: freshConfig() }, { root: path.join(tmpRoot, '不存在的目录') });
  assert.strictEqual(r.ok, false);
  const i = r.issues.find((x) => x.key === 'root');
  assert.ok(i, '应报 root');
  assert.ok(i.msg.indexOf('BannerlordCoopServer.exe') >= 0, '提示里要带 exe 路径: ' + i.msg);
});

check('路径合法时无致命问题（root 指向含 DedicatedServer 的目录）', () => {
  const r = validate({ COOP_CONSOLE_CONFIG: freshConfig() },
    { root: fakeRoot, coopData: fakeCoopData });
  assert.strictEqual(r.ok, true, '不该有致命问题: ' + JSON.stringify(r.issues));
});

check('存档/备份目录不存在只是 warn，不挡保存', () => {
  const r = validate({ COOP_CONSOLE_CONFIG: freshConfig() }, {
    root: fakeRoot, coopData: fakeCoopData,
    savesDir: path.join(tmpRoot, '还没建'), backupDir: path.join(tmpRoot, '也没有'),
  });
  assert.strictEqual(r.ok, true, 'warn 不该让 ok=false');
  assert.ok(r.issues.filter((i) => i.level === 'warn').length >= 2, '应至少两条 warn');
});

// —————————————————— save ——————————————————

check('保存只改可编辑键，文件里其他键原样保留', () => {
  const f = freshConfig('{"customKey":1,"port":7799,"note":"手写的"}\n');
  const r = save({ COOP_CONSOLE_CONFIG: f }, { host: 'auto' });
  assert.strictEqual(r.ok, true, '应保存成功: ' + JSON.stringify(r.issues));
  const back = readBack(f);
  assert.strictEqual(back.customKey, 1, 'customKey 被吞了');
  assert.strictEqual(back.note, '手写的', 'note 被吞了');
  assert.strictEqual(back.port, 7799, '没提交的 port 应保持不变');
  assert.strictEqual(back.host, 'auto', 'host 没写进去');
});

check('提交空值 = 从文件里删掉这个键（回退默认）', () => {
  const f = freshConfig('{"port":7799,"customKey":1}\n');
  const r = save({ COOP_CONSOLE_CONFIG: f }, { port: '' });
  assert.strictEqual(r.ok, true);
  const back = readBack(f);
  assert.ok(!('port' in back), 'port 应被删掉: ' + JSON.stringify(back));
  assert.strictEqual(back.customKey, 1, 'customKey 应仍在');
});

check('校验不过时一个字都不写', () => {
  const before = '{"port":7799}\n';
  const f = freshConfig(before);
  const r = save({ COOP_CONSOLE_CONFIG: f }, { port: '70000' });
  assert.strictEqual(r.ok, false, '应判失败');
  assert.strictEqual(fs.readFileSync(f, 'utf8'), before, '文件不该被改');
});

check('现有 config.json 语法坏了 → 拒绝覆盖（别把用户文件清空）', () => {
  const before = '{ 这不是 json\n';
  const f = freshConfig(before);
  const r = save({ COOP_CONSOLE_CONFIG: f }, { host: 'auto' });
  assert.strictEqual(r.ok, false, '应拒绝写入');
  assert.strictEqual(fs.readFileSync(f, 'utf8'), before, '坏文件不该被覆盖');
});

check('文件不存在时自动创建，且带注释头、能被 jsonc 读回', () => {
  const f = path.join(tmpRoot, 'brand-new.json');
  const r = save({ COOP_CONSOLE_CONFIG: f }, { gamePort: 4300, root: fakeRoot });
  assert.strictEqual(r.ok, true);
  const txt = fs.readFileSync(f, 'utf8');
  assert.ok(txt.indexOf('//') === 0, '应以注释开头');
  const back = readBack(f);
  assert.strictEqual(back.gamePort, 4300);
  assert.strictEqual(back.root, fakeRoot, 'Windows 反斜杠要原样保住');
});

// —————————————————— describe ——————————————————

check('describe() 给出 8 个可编辑字段 + 当前生效值 + 需重启标记', () => {
  const d = describeOn({ COOP_CONSOLE_CONFIG: freshConfig('{"port":7801,"host":"auto"}\n') });
  assert.strictEqual(d.ok, true);
  assert.strictEqual(d.fields.length, 8, '字段数应为 8，实际 ' + d.fields.length);
  assert.deepStrictEqual(d.fields.map((x) => x.key),
    ['root', 'serverDir', 'coopData', 'savesDir', 'backupDir', 'port', 'host', 'gamePort']);
  assert.strictEqual(d.values.port, 7801, 'port 要从 config.json 读出来（映射到 httpPort）');
  assert.strictEqual(d.values.host, 'auto', 'host 要从 config.json 读出来（映射到 httpHost）');
  assert.strictEqual(d.requiresRestart, true);
  assert.ok(Array.isArray(d.issues), 'issues 应是数组');
});

check('被环境变量锁住的项会被标出来（页面要提示改了不生效）', () => {
  const f = freshConfig('{"port":7801}\n');
  const d = describeOn({ COOP_CONSOLE_CONFIG: f, COOP_CONSOLE_PORT: '7999' });
  assert.ok(d.envLocked.indexOf('port') >= 0, 'port 应被标成环境变量锁定: ' + JSON.stringify(d.envLocked));
  assert.strictEqual(d.values.port, 7999, '生效值应该是环境变量那个');
  // 存进去也不生效 —— 要能告诉用户
  const r = save({ COOP_CONSOLE_CONFIG: f, COOP_CONSOLE_PORT: '7999' }, { port: '7802' });
  assert.strictEqual(r.ok, true, '文件还是要写（用户可能只是临时用环境变量调试）');
  assert.ok(r.lockedIgnored.indexOf('port') >= 0, 'lockedIgnored 应包含 port: ' + JSON.stringify(r.lockedIgnored));
  assert.strictEqual(readBack(f).port, 7802, '文件里应是用户填的 7802');
});

check('保存后 describe().exists 立刻变 true（实时 stat，不用重启）', () => {
  const f = path.join(tmpRoot, 'timing.json');
  assert.ok(!fs.existsSync(f), '前提：文件还不存在');
  assert.strictEqual(describeOn({ COOP_CONSOLE_CONFIG: f }).exists, false, '没文件时应报 false');
  const r = save({ COOP_CONSOLE_CONFIG: f }, { host: 'auto' });
  assert.strictEqual(r.ok, true);
  assert.ok(fs.existsSync(f), '文件应已写出');
  assert.strictEqual(describeOn({ COOP_CONSOLE_CONFIG: f }).exists, true,
    'describe() 应实时 stat，否则页面会一直显示「尚未创建」');
});

// 清理：只清自己造的临时目录
try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch (_) {}

console.log('');
if (fails.length) {
  console.log('  ' + pass + ' 项通过，' + fails.length + ' 项失败');
  for (const f of fails) console.log('    - ' + f);
  process.exitCode = 1;
} else {
  console.log('  ' + pass + ' 项全部通过');
}
