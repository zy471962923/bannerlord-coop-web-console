'use strict';
// 玩家档案前端渲染自测。
//
// 这台机器上无头浏览器截不出图（见 tools/lib/fake-dom.js 里的说明），
// 所以改成在假 DOM 里把 app.js 真正跑一遍，检查渲染函数产出的 HTML。
//
// 用法：node tools/test-players-view.js
//   —— 先跑 node tools/test-players.js 确认数据层，再看这一层。
const assert = require('assert');
const { loadApp } = require('./lib/fake-dom');
const playersLib = require('../lib/players');

let pass = 0;
const fails = [];
function check(name, fn) {
  try { fn(); pass++; console.log('  ✓ ' + name); }
  catch (e) { fails.push(name + ' —— ' + e.message); console.log('  ✗ ' + name + ' —— ' + e.message); }
}

console.log('');
console.log('  玩家档案渲染自测（假 DOM 里跑真实 app.js）');
console.log('');

const { sandbox, el } = loadApp();
const snap = playersLib.snapshot({ onlineList: [], world: null });
if (!snap.ok) {
  console.error('  数据层没读出来，先跑 test-players.js：' + snap.error);
  process.exit(1);
}

check('app.js 能在假 DOM 里加载完（没有顶层崩溃）', () => {
  for (const fn of ['renderPlayerCards', 'renderRealmBar', 'renderPlayersNote', 'fmtNum', 'fmtAgo']) {
    assert.strictEqual(typeof sandbox[fn], 'function', fn + ' 未定义');
  }
});

check('数字格式：上万自动缩成 k，不留一长串', () => {
  assert.strictEqual(sandbox.fmtNum(693.6), '693.6');
  assert.strictEqual(sandbox.fmtNum(1511), '1511');
  assert.strictEqual(sandbox.fmtNum(23300), '23.3k');
  assert.strictEqual(sandbox.fmtNum(undefined), '0');
  assert.strictEqual(sandbox.fmtNum(NaN), '0');
});

check('「多久以前」显示成人话', () => {
  assert.strictEqual(sandbox.fmtAgo(5000), '5 秒前');
  assert.strictEqual(sandbox.fmtAgo(3 * 60000), '3 分钟前');
  assert.strictEqual(sandbox.fmtAgo(2 * 3600000), '2 小时前');
  assert.strictEqual(sandbox.fmtAgo(0), '—');
});

check('渲染世界状态条：日期 / 时间流逝 / 在线数 / 部队数都在', () => {
  const world = {
    date: 'Autumn 19, 1087', timeMode: 'Stop', players: 1,
    parties: 1511, mapEvents: 9, mainParty: { x: 657.95, y: 279.08 }, at: Date.now(),
  };
  // 在线数取自在线列表（world.players 只是服务端自报，不参与展示）
  const live = playersLib.snapshot({
    onlineList: [{ playerName: snap.players[0].platformName }],
    world,
  });
  sandbox.renderRealmBar(world, live);
  const html = el('#realm-bar').innerHTML;
  assert.ok(html.includes('Autumn 19, 1087'), '缺游戏内日期');
  assert.ok(html.includes('暂停'), 'timeMode=Stop 应该显示「暂停」');
  assert.ok(html.includes('<b>1</b>'), '在线数没显示');
  assert.ok(html.includes(live.total + ' 名玩家'), '玩家总数没显示');
  assert.ok(html.includes('1511'), '全图部队数没显示');
  assert.ok(!/undefined|NaN/.test(html), 'HTML 里漏出了 undefined/NaN');
});

check('world 缺失时显示占位符而不是崩掉', () => {
  sandbox.renderRealmBar(null, snap);
  const html = el('#realm-bar').innerHTML;
  assert.ok(html.includes('—'), '没给占位符');
  assert.ok(!/undefined|NaN/.test(html), 'HTML 里漏出了 undefined/NaN');
});

check('渲染玩家卡：名字 / 缩写 / 家族 / 主数值齐全', () => {
  sandbox.renderPlayerCards(snap.players, { date: 'Autumn 19, 1087' });
  const html = el('#player-grid').innerHTML;
  assert.strictEqual((html.match(/class="pw-card/g) || []).length, snap.players.length, '卡片数量不对');
  for (const p of snap.players) {
    assert.ok(html.includes(p.platformName), '缺玩家名 ' + p.platformName);
    assert.ok(html.includes('>' + p.initials + '<'), '缺头像缩写 ' + p.initials);
    // 有详情时家族优先显示游戏里的真名（史塔克 T2），没有才退回 Clan_xxx
    const clanText = p.detail && p.detail.clan.name ? p.detail.clan.name : p.clanId;
    assert.ok(html.includes(clanText), '缺家族 ' + clanText);
    assert.ok(html.includes('data-hero="'), '卡片没有记下 heroId，点了进不了详情');
  }
  assert.ok(html.includes('锻造总熟练'), '缺主数值区');
  // 专精已按用户要求下线：卡片技能区必须与详情页同源（playercards.json 的 detail.skills），
  // 不能再出现打铁的「武器专精」字样
  assert.ok(!html.includes('武器专精'), '专精区块还在（应已移除）');
  assert.ok(html.includes('技能'), '缺技能区');
  assert.ok(html.includes('pw-bar'), '没有技能条');
  assert.ok(html.includes('查看详情'), '卡片上没有进详情的入口提示');
  assert.ok(!/undefined|NaN/.test(html), 'HTML 里漏出了 undefined/NaN');
});

check('卡片技能与详情页同源：名字和数值都对得上', () => {
  const html = el('#player-grid').innerHTML;
  for (const p of snap.players) {
    const skills = (p.detail && p.detail.skills) || [];
    if (!skills.length) continue;
    // 卡片取前 5 项（已按熟练度降序），名字用中文名，数值与 detail 一致
    for (const s of skills.slice(0, 5)) {
      assert.ok(html.includes('>' + s.name + '<'), '缺技能名 ' + s.name);
      assert.ok(html.includes('>' + s.value + '<'), '缺技能数值 ' + s.name + ' ' + s.value);
    }
  }
});

check('技能条宽度合法，最高那条满格并高亮', () => {
  const html = el('#player-grid').innerHTML;
  const widths = Array.from(html.matchAll(/<i style="width:(\d+)%"/g)).map((m) => Number(m[1]));
  assert.ok(widths.length > 0, '一条进度条都没渲染');
  for (const w of widths) assert.ok(w >= 3 && w <= 100, '宽度越界：' + w + '%');
  assert.strictEqual(Math.max(...widths), 100, '最高的那条应该是 100%');
  assert.ok(html.includes('pw-bar is-top'), '最高项没有高亮');
});

check('Steam 主页链接可点且开新窗', () => {
  const html = el('#player-grid').innerHTML;
  assert.ok(html.includes('steamcommunity.com/profiles/'), '缺 Steam 主页链接');
  assert.ok(html.includes('target="_blank"'), 'Steam 链接没开新窗');
});

check('离线玩家标离线，没有在线样式', () => {
  const html = el('#player-grid').innerHTML;
  assert.ok(html.includes('离线'), '应有离线标记');
  assert.ok(!html.includes('pw-card is-online'), '没人上线却出现了在线样式');
});

check('在线玩家标在线、加在线样式、排到最前', () => {
  const victim = snap.players[snap.players.length - 1]; // 故意选一个原本排后面的
  const online = playersLib.snapshot({
    onlineList: [{ playerName: victim.platformName, ping: 42 }],
    world: null,
  });
  sandbox.renderPlayerCards(online.players, null);
  const html = el('#player-grid').innerHTML;
  assert.ok(html.includes('pw-card is-online'), '在线样式没生效');
  assert.ok(html.includes('>在线<'), '缺在线标记');
  assert.strictEqual(online.players[0].platformName, victim.platformName, '在线玩家没排到最前');
});

check('空名单给出人话提示而不是空白', () => {
  sandbox.renderPlayerCards([], null);
  const html = el('#player-grid').innerHTML;
  assert.ok(html.includes('pw-empty'), '空状态没有占位样式');
  assert.ok(html.includes('还没有玩家档案'), '空状态没有说明文字');
});

check('页脚如实说明缺失字段与数据来源', () => {
  sandbox.renderPlayersNote(snap);
  const html = el('#players-note').innerHTML;
  for (const k of snap.missing) assert.ok(html.includes(k), '页脚没提 ' + k);
  assert.ok(html.includes('.json'), '页脚没说数据来自哪个文件');
  assert.ok(html.includes('不是估算') || html.includes('估算'), '页脚没强调不编数字');
});

check('读不到文件时给出可操作的错误说明', () => {
  sandbox.renderPlayersNote({ ok: false, error: '没有找到与当前存档配对的 .json 文件', savesDir: 'X:/Game Saves' });
  const html = el('#players-note').innerHTML;
  assert.ok(html.includes('读不到玩家档案'), '缺错误标题');
  assert.ok(html.includes('没有找到'), '缺错误正文');
  assert.ok(html.includes('X:/Game Saves'), '缺存档目录提示');
});

console.log('');
if (fails.length) {
  console.log('  ' + pass + ' 项通过，' + fails.length + ' 项失败');
  for (const f of fails) console.log('    - ' + f);
  process.exitCode = 1;
} else {
  console.log('  ' + pass + ' 项全部通过');
  console.log('');
}
