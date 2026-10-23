'use strict';
// 配置层自测：验证「环境变量 > config.json > 自动探测」的优先级、自动探测、
// 以及缺路径时 check() 是否给出人话提示。
//
// 为什么用子进程：config.js 在 require 时就解析并存成常量（常驻模块的常规做法），
// 同一进程里改环境变量不会重新解析，只能起新进程。
//
// 用法：node tools/test-config.js
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
const CONFIG_JS = path.join(CONSOLE_DIR, 'lib', 'config.js');

// 起一个子进程解析配置，返回 JSON
function resolve(env) {
  const out = execFileSync(process.execPath, ['-e',
    'process.stdout.write(JSON.stringify(require(' + JSON.stringify(CONFIG_JS) + ')))',
  ], { env: Object.assign({}, process.env, env), encoding: 'utf8' });
  return JSON.parse(out);
}

// check() 是函数，JSON 序列化会丢掉 —— 要在子进程里调完再带出来
function resolveWithChecks(env) {
  const out = execFileSync(process.execPath, ['-e',
    'const c=require(' + JSON.stringify(CONFIG_JS) + ');'
    + 'process.stdout.write(JSON.stringify({cfg:c,issues:c.check()}))',
  ], { env: Object.assign({}, process.env, env), encoding: 'utf8' });
  return JSON.parse(out);
}

// 带命令行参数解析：config.js 在 require 时读 process.argv，所以先摆好再 require
function resolveArgv(env, args) {
  const out = execFileSync(process.execPath, ['-e',
    'process.argv=' + JSON.stringify(['node', 'server.js'].concat(args)) + ';'
    + 'process.stdout.write(JSON.stringify(require(' + JSON.stringify(CONFIG_JS) + ')))',
  ], { env: Object.assign({}, process.env, env), encoding: 'utf8' });
  return JSON.parse(out);
}

// 造一个假的安装目录：<tmp>/Game/DedicatedServer/BannerlordCoopServer.exe
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'coopcfg-'));
const fakeRoot = path.join(tmpRoot, 'Game');
const fakeServer = path.join(fakeRoot, 'DedicatedServer');
fs.mkdirSync(fakeServer, { recursive: true });
fs.writeFileSync(path.join(fakeServer, 'BannerlordCoopServer.exe'), 'stub');
const fakeCoopData = path.join(tmpRoot, 'CoopData');
fs.mkdirSync(fakeCoopData, { recursive: true });

console.log('');
console.log('  配置层自测（子进程里跑真实 lib/config.js）');
console.log('');

check('默认：控制台自定位，服务端目录自动探测到上一层的 DedicatedServer', () => {
  const c = resolve({ COOP_ROOT: '', COOP_SERVER_DIR: '' });
  assert.strictEqual(c.consoleDir, CONSOLE_DIR, 'consoleDir 应等于 web-console 目录');
  assert.ok(c.serverDir && /DedicatedServer$/.test(c.serverDir), 'serviceDir 没探测到: ' + c.serverDir);
  // 数据目录用系统文档目录，不写死用户名
  assert.ok(c.coopData.indexOf(os.homedir()) === 0, 'coopData 应基于 homedir: ' + c.coopData);
});

check('COOP_ROOT 环境变量优先于自动探测', () => {
  const c = resolve({ COOP_ROOT: fakeRoot, COOP_DATA_DIR: fakeCoopData, COOP_SERVER_DIR: '' });
  assert.strictEqual(c.serverDir, fakeServer, 'serverDir 应指到假目录: ' + c.serverDir);
  assert.strictEqual(c.coopData, fakeCoopData);
});

check('root 直接就是服务端目录时不再多拼一层 DedicatedServer', () => {
  const c = resolve({ COOP_ROOT: fakeServer, COOP_SERVER_DIR: '', COOP_DATA_DIR: fakeCoopData });
  assert.strictEqual(c.serverDir, fakeServer, 'root==服务端目录时 serverDir 应等于 root: ' + c.serverDir);
});

check('config.json 覆盖自动探测，且环境变量再覆盖 config.json', () => {
  const cfg = path.join(tmpRoot, 'cfg.json');
  fs.writeFileSync(cfg, `{
    // jsonc 注释也要能解析
    "root": "${fakeRoot.replace(/\\/g, '\\\\')}",
    "coopData": "${fakeCoopData.replace(/\\/g, '\\\\')}",
    "port": 7799,
  }`);
  const c1 = resolve({ COOP_CONSOLE_CONFIG: cfg, COOP_ROOT: '', COOP_CONSOLE_PORT: '' });
  assert.strictEqual(c1.serverDir, fakeServer, 'config.json 的 root 没生效: ' + c1.serverDir);
  assert.strictEqual(c1.httpPort, 7799, 'config.json 的 port 没生效: ' + c1.httpPort);
  const c2 = resolve({ COOP_CONSOLE_CONFIG: cfg, COOP_CONSOLE_PORT: '7801' });
  assert.strictEqual(c2.httpPort, 7801, '环境变量应压过 config.json: ' + c2.httpPort);
  assert.strictEqual(c2.configFileExists, true, 'configFileExists 应为 true');
});

check('路径缺失时 check() 给出可执行的提示', () => {
  const { issues } = resolveWithChecks({
    COOP_ROOT: path.join(tmpRoot, '不存在的目录'),
    COOP_SERVER_DIR: '', COOP_DATA_DIR: path.join(tmpRoot, '也没有'),
  });
  assert.ok(issues.length >= 1, 'should report issues');
  const keys = issues.map((i) => i.key);
  assert.ok(keys.indexOf('serverDir') >= 0, '应该报 serverDir');
  assert.ok(issues.every((i) => i.msg && i.hint), '每条问题都要带 msg + hint');
});

check('--local 只是模式兜底：config.json 没写 host 时才生效', () => {
  const empty = path.join(tmpRoot, 'empty.json');
  fs.writeFileSync(empty, '{}\n');
  const b = resolveArgv({ COOP_CONSOLE_CONFIG: empty, COOP_CONSOLE_PORT: '', COOP_CONSOLE_HOST: '' }, ['--local']);
  assert.strictEqual(b.httpHost, '127.0.0.1');
  assert.ok(b.httpHostSource.indexOf('命令行') === 0, '来源应标成命令行: ' + b.httpHostSource);
  // 什么都不传时用内置默认 0.0.0.0（发布版：解压就能被别人打开）
  const c = resolveArgv({ COOP_CONSOLE_CONFIG: empty, COOP_CONSOLE_PORT: '', COOP_CONSOLE_HOST: '' }, []);
  assert.strictEqual(c.httpHost, '0.0.0.0', '无参数时应监听所有网卡: ' + c.httpHost);
  assert.strictEqual(c.httpHostSource, '内置默认值');
});

check('--lan 已废弃：传了也不该改变监听地址（默认本来就是 0.0.0.0）', () => {
  const empty = path.join(tmpRoot, 'empty.json');
  fs.writeFileSync(empty, '{}\n');
  const a = resolveArgv({ COOP_CONSOLE_CONFIG: empty, COOP_CONSOLE_PORT: '', COOP_CONSOLE_HOST: '' }, ['--lan']);
  assert.strictEqual(a.httpHost, '0.0.0.0', '--lan 不该再缩窄范围: ' + a.httpHost);
  assert.strictEqual(a.httpHostSource, '内置默认值', '--lan 不该产生地址来源: ' + a.httpHostSource);
});

check('--port 是显式值：压过 config.json（开副面板就靠这个）', () => {
  const f = path.join(tmpRoot, 'hasport.json');
  fs.writeFileSync(f, '{"port": 8080}\n');
  const a = resolveArgv({ COOP_CONSOLE_CONFIG: f, COOP_CONSOLE_PORT: '', COOP_CONSOLE_HOST: '' },
    ['--local', '--port', '7790']);
  assert.strictEqual(a.httpPort, 7790, '--port 该赢过文件里的 8080: ' + a.httpPort);
  assert.ok(a.httpPortSource.indexOf('命令行') === 0, '来源应为命令行: ' + a.httpPortSource);
  const b = resolveArgv({ COOP_CONSOLE_CONFIG: f, COOP_CONSOLE_PORT: '', COOP_CONSOLE_HOST: '' },
    ['--port=7791']);
  assert.strictEqual(b.httpPort, 7791, '--port=N 写法没生效: ' + b.httpPort);
  // 不带 --port 时文件说了算
  const c = resolveArgv({ COOP_CONSOLE_CONFIG: f, COOP_CONSOLE_PORT: '', COOP_CONSOLE_HOST: '' }, ['--local']);
  assert.strictEqual(c.httpPort, 8080, '文件端口该赢过默认值: ' + c.httpPort);
  assert.ok(c.httpPortSource.indexOf('config.json') === 0, '来源应为 config.json: ' + c.httpPortSource);
});

check('config.json 的 host 压过 --local（模式参数压不过文件）', () => {
  const f = path.join(tmpRoot, 'hashost.json');
  fs.writeFileSync(f, '{"host": "127.0.0.1"}\n');
  const c = resolveArgv({ COOP_CONSOLE_CONFIG: f, COOP_CONSOLE_PORT: '', COOP_CONSOLE_HOST: '' },
    ['--local', '--host', '192.168.1.10']);
  assert.strictEqual(c.httpHost, '192.168.1.10', '--host 是显式值，该压过文件: ' + c.httpHost);
  const d = resolveArgv({ COOP_CONSOLE_CONFIG: f, COOP_CONSOLE_PORT: '', COOP_CONSOLE_HOST: '' },
    ['--local']);
  assert.strictEqual(d.httpHost, '127.0.0.1', '文件里的 host 该赢过 --local: ' + d.httpHost);
  assert.ok(d.httpHostSource.indexOf('config.json') === 0, '来源应为 config.json: ' + d.httpHostSource);
});

check('环境变量仍然压过 config.json 和命令行', () => {
  const f = path.join(tmpRoot, 'hashost.json');
  const c = resolveArgv({ COOP_CONSOLE_CONFIG: f, COOP_CONSOLE_PORT: '9090', COOP_CONSOLE_HOST: 'auto' },
    ['--local', '--port', '7790']);
  assert.strictEqual(c.httpPort, 9090, '环境变量端口该赢: ' + c.httpPort);
  assert.strictEqual(c.httpHost, 'auto', '环境变量地址该赢: ' + c.httpHost);
  assert.ok(c.httpPortSource.indexOf('环境变量') === 0, '来源应标成环境变量: ' + c.httpPortSource);
});

check('非法端口不会把控制台拖死，回落到默认值', () => {
  const empty = path.join(tmpRoot, 'empty.json');
  const c = resolveArgv({ COOP_CONSOLE_CONFIG: empty, COOP_CONSOLE_PORT: 'abc', COOP_CONSOLE_HOST: '' }, []);
  assert.strictEqual(c.httpPort, 7788, '非法端口应回落 7788: ' + c.httpPort);
});

check('--init 生成模板，且不覆盖已有 config.json', () => {
  const tmpConsole = path.join(tmpRoot, 'console-copy');
  fs.mkdirSync(path.join(tmpConsole, 'lib'), { recursive: true });
  // 复制配置模块和它依赖的 jsonc，模拟“别人拷过去的控制台”
  fs.copyFileSync(CONFIG_JS, path.join(tmpConsole, 'lib', 'config.js'));
  fs.copyFileSync(path.join(CONSOLE_DIR, 'lib', 'jsonc.js'), path.join(tmpConsole, 'lib', 'jsonc.js'));
  const env = { COOP_ROOT: fakeRoot, COOP_DATA_DIR: fakeCoopData };
  execFileSync(process.execPath, [path.join(tmpConsole, 'lib', 'config.js'), '--init'],
    { env: Object.assign({}, process.env, env), encoding: 'utf8' });
  const cfgPath = path.join(tmpConsole, 'config.json');
  assert.ok(fs.existsSync(cfgPath), '没生成 config.json');
  const txt = fs.readFileSync(cfgPath, 'utf8');
  assert.ok(txt.indexOf('serverDir') >= 0 && txt.indexOf('//') >= 0, '模板应带注释与关键字段');
  // 再跑一次：不能覆盖
  fs.writeFileSync(cfgPath, '// 用户自己改过的\n{"port": 7999}\n');
  execFileSync(process.execPath, [path.join(tmpConsole, 'lib', 'config.js'), '--init'],
    { env: Object.assign({}, process.env, env), encoding: 'utf8' });
  assert.strictEqual(fs.readFileSync(cfgPath, 'utf8'), '// 用户自己改过的\n{"port": 7999}\n', '不该覆盖已有配置');
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
