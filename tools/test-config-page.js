'use strict';
// 「配置」页可编辑表单渲染自测：假 DOM 里跑真实 app.js，注入 /api/config 与
// /api/console-config 的响应，检查 cfgCardHtml() 吐出来的 HTML。
//
// 验的是「页面这一半」：字段顺序、回填值、环境变量锁定的禁用态、致命问题的红条、
// 以及读接口挂掉时不炸整个页面。校验/落盘那半在 test-console-config.js 里。
//
// 用法：node tools/test-config-page.js
const assert = require('assert');
const { loadApp } = require('./lib/fake-dom');

let pass = 0;
const fails = [];
function check(name, fn) {
  try { fn(); pass++; console.log('  ✓ ' + name); }
  catch (e) { fails.push(name + ' —— ' + e.message); console.log('  ✗ ' + name + ' —— ' + e.message); }
}

const tick = () => new Promise((r) => setImmediate(r));

// GET /api/config 的最小可用响应（配置页下面三张只读卡片用）
const gameConfig = {
  serverConfigPath: 'C:\\CoopData\\DedicatedServer\\server-config.json',
  modConfigPath: 'C:\\CoopData\\mod-config.json',
  serverConfig: { saveName: 'Autosave0', autosaveMinutes: 5, port: 4200 },
  coopSettings: { blockAiWarDeclarationsOnOfflinePlayers: true },
  paths: { consoleDir: 'F:\\...\\web-console', coopData: 'C:\\CoopData' },
};

// GET /api/console-config 的正常响应
function consoleConfig(over) {
  return Object.assign({
    ok: true,
    file: 'F:\\Games\\Bannerlord\\web-console\\config.json',
    exists: false,
    fields: [
      { key: 'root', label: '服务端安装目录', hint: '含 DedicatedServer 的那层', kind: 'path' },
      { key: 'serverDir', label: '服务端目录', hint: '留空=root\\DedicatedServer', kind: 'path' },
      { key: 'coopData', label: '存档/配置根目录', hint: 'CoopData', kind: 'path' },
      { key: 'savesDir', label: '存档目录', hint: '留空=默认', kind: 'path' },
      { key: 'backupDir', label: '备份目录', hint: '留空=控制台目录\\backups', kind: 'path' },
      { key: 'port', label: '控制台端口', hint: '默认 7788', kind: 'number' },
      { key: 'host', label: '监听地址', hint: '127.0.0.1 / auto / 0.0.0.0', kind: 'text' },
      { key: 'gamePort', label: '游戏端口', hint: '默认 4200', kind: 'number' },
    ],
    values: {
      root: 'F:\\Games\\Bannerlord',
      serverDir: 'F:\\Games\\Bannerlord\\DedicatedServer',
      coopData: 'C:\\Users\\玩家\\Documents\\Mount and Blade II Bannerlord\\CoopData',
      savesDir: '', backupDir: '', port: 7788, host: '127.0.0.1', gamePort: 4200,
    },
    envLocked: [],
    issues: [],
    requiresRestart: true,
  }, over || {});
}

function mount(ccResponse) {
  return loadApp({
    fetch: (u) => {
      if (u.indexOf('/api/console-config') >= 0) return ccResponse;
      if (u.indexOf('/api/config') >= 0) return gameConfig;
      return null;
    },
    // 表单取值用：模拟页面上三个被填过的 input
    querySelectorAll: (sel) => (sel.indexOf('.cfg-fields') >= 0
      ? [
        { dataset: { key: 'root' }, value: '  D:\\Game  ', disabled: false },
        { dataset: { key: 'port' }, value: '7801', disabled: false },
        { dataset: { key: 'host' }, value: '', disabled: false },
      ]
      : []),
  });
}

(async function main() {
  console.log('');
  console.log('  配置页可编辑表单渲染自测（假 DOM 里跑真实 app.js）');
  console.log('');

  // —————————————————— 正常渲染 ——————————————————
  {
    const { sandbox, el } = mount(consoleConfig());
    await sandbox.loadConfig();
    await tick();
    const h = el('#config-view').innerHTML;

    check('8 个字段全部渲染，顺序与 /api/console-config 一致', () => {
      const keys = (h.match(/data-key="([^"]+)"/g) || []).map((s) => s.slice(10, -1));
      assert.deepStrictEqual(keys,
        ['root', 'serverDir', 'coopData', 'savesDir', 'backupDir', 'port', 'host', 'gamePort'],
        '字段顺序不对：' + keys.join(','));
    });

    check('当前生效值回填到 input，路径反斜杠原样保住', () => {
      assert.ok(h.includes('value="F:\\Games\\Bannerlord"'), 'root 没回填');
      assert.ok(h.includes('value="127.0.0.1"'), 'host 没回填');
      assert.ok(h.includes('value="4200"'), 'gamePort 没回填');
      assert.ok(h.includes('value="F:\\Games\\Bannerlord\\DedicatedServer"'), 'serverDir 没回填');
      // 空值也要是空字符串，不能渲染成 "undefined"
      assert.ok(!h.includes('value="undefined"'), '有空值渲染成 undefined 了');
      assert.ok(!h.includes('value="null"'), '有空值渲染成 null 了');
    });

    check('端口类字段用 number 输入框，路径类用 text', () => {
      assert.strictEqual((h.match(/type="number"/g) || []).length, 2, 'port / gamePort 应是 number');
      assert.strictEqual((h.match(/type="text"/g) || []).length, 6, '其余 6 项应是 text');
    });

    check('每行都带 label 和 hint，用户不用猜填什么', () => {
      for (const label of ['服务端安装目录', '控制台端口', '监听地址', '游戏端口']) {
        assert.ok(h.includes(label), '缺 label：' + label);
      }
      assert.ok(h.includes('含 DedicatedServer 的那层'), '缺 hint');
      assert.ok((h.match(/class="cfg-hint"/g) || []).length === 8, 'hint 数量应为 8');
    });

    check('写明「重启控制台生效」和优先级，别让用户以为存完立刻变', () => {
      assert.ok(h.includes('重启控制台后生效'), '缺重启提示');
      assert.ok(h.includes('环境变量'), '缺优先级说明');
    });

    check('三个按钮齐了，未创建时提示「保存时才写」', () => {
      assert.ok(h.includes('id="cfg-save"'), '缺保存按钮');
      assert.ok(h.includes('id="cfg-check"'), '缺只校验按钮');
      assert.ok(h.includes('id="cfg-restore"'), '缺还原按钮');
      assert.ok(h.includes('尚未创建，保存时才写'), '缺未创建提示');
    });

    check('下面三张只读卡片还在（没被新表单挤掉）', () => {
      assert.ok(h.includes('server-config.json'), '缺 server-config.json 卡');
      assert.ok(h.includes('mod-config.json'), '缺 mod-config.json 卡');
      assert.ok(h.includes('Autosave0'), '缺 serverConfig 内容');
      assert.ok(h.includes('blockAiWarDeclarationsOnOfflinePlayers'), '缺 coop 设置内容');
    });

    check('cfgCollect() 取到输入框的值，且不做 trim（trim 交给服务端）', () => {
      // 注意：对象来自 vm 沙箱，原型链不同，deepStrictEqual 会误报，逐项比
      const v = sandbox.cfgCollect();
      assert.strictEqual(v.root, '  D:\\Game  ', 'root 的值应原样带出（含首尾空格）');
      assert.strictEqual(v.port, '7801');
      assert.strictEqual(v.host, '');
      assert.strictEqual(Object.keys(v).length, 3);
    });

    check('cfgFill() 跳过被禁用的输入框（环境变量锁住的不能被「还原」覆盖）', () => {
      const inputs = [
        { dataset: { key: 'root' }, value: 'old', disabled: true },
        { dataset: { key: 'port' }, value: 'old', disabled: false },
      ];
      const { sandbox: s2 } = loadApp({
        fetch: (u) => (u.indexOf('/api/console-config') >= 0 ? consoleConfig() : gameConfig),
        querySelectorAll: (sel) => (sel.indexOf('.cfg-fields') >= 0 ? inputs : []),
      });
      s2.cfgFill({ root: 'NEW-ROOT', port: 7801 });
      assert.strictEqual(inputs[0].value, 'old', '禁用项不该被改写');
      assert.strictEqual(inputs[1].value, '7801', '可用项应回填成字符串');
      // 传空值 → 清空输入框（不是显示 null）
      s2.cfgFill({ root: 'x', port: null });
      assert.strictEqual(inputs[1].value, '', '空值应渲染成空字符串');
    });
  }

  // —————————————————— 环境变量锁定 ——————————————————
  {
    const { sandbox, el } = mount(consoleConfig({ envLocked: ['port'], values: Object.assign({}, consoleConfig().values, { port: 7999 }) }));
    await sandbox.loadConfig();
    await tick();
    const h = el('#config-view').innerHTML;

    check('被环境变量锁住的字段渲染成 disabled + 打标，并统一在顶部警告一次', () => {
      assert.ok(/data-key="port"[^>]*disabled/.test(h), 'port 应是 disabled');
      assert.ok(h.includes('环境变量锁定'), '缺锁定标');
      assert.ok(h.includes('页面上改了也不生效'), '缺顶部警告');
      assert.ok(h.includes('7999'), '应显示环境变量那个生效值');
    });
  }

  // —————————————————— 致命问题 ——————————————————
  {
    const { sandbox, el } = mount(consoleConfig({
      issues: [
        { key: 'serverDir', fatal: true, msg: '服务端可执行文件不存在：X', hint: '检查 config.json' },
        { key: 'savesDir', fatal: false, msg: '存档目录不存在', hint: '跑一次就有' },
      ],
    }));
    await sandbox.loadConfig();
    await tick();
    const h = el('#config-view').innerHTML;

    check('config.check() 的 {fatal,hint} 被归一化成 fatal/warn 两档红黄条', () => {
      assert.ok(h.includes('cfg-issue fatal'), '缺 fatal 样式');
      assert.ok(h.includes('cfg-issue warn'), '缺 warn 样式');
      assert.ok(h.includes('✗ 服务端可执行文件不存在'), '致命条目应以 ✗ 开头');
      assert.ok(h.includes('检查 config.json'), 'hint 要一起显示出来');
    });
  }

  // —————————————————— 接口挂掉 ——————————————————
  {
    const { sandbox, el } = loadApp({
      fetch: (u) => (u.indexOf('/api/config') >= 0 ? gameConfig : null),
      querySelectorAll: () => [],
    });
    // 只让 /api/console-config 挂掉：/api/config 正常，页面骨架要照常出来
    sandbox.fetch = (u) => (String(u).indexOf('/api/console-config') >= 0
      ? Promise.reject(new Error('HTTP 500'))
      : Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(gameConfig) }));

    let threw = null;
    try { await sandbox.loadConfig(); } catch (e) { threw = e; }
    await tick();

    check('读配置接口报错时页面不炸，给出可读提示', () => {
      assert.strictEqual(threw, null, 'loadConfig 不该往外抛：' + (threw && threw.message));
      const h = el('#config-view').innerHTML;
      assert.ok(h.includes('读不到配置接口'), '缺错误提示卡');
      assert.ok(h.includes('server-config.json'), '只读卡片应该还在');
    });
  }

  console.log('');
  if (fails.length) {
    console.log('  ' + pass + ' 项通过，' + fails.length + ' 项失败');
    for (const f of fails) console.log('    - ' + f);
    process.exitCode = 1;
  } else {
    console.log('  ' + pass + ' 项全部通过');
  }
})();
