'use strict';
// 玩家档案自测：直接吃真实的 saveauto1.json，验证每个字段都能被算出来。
// 用法：node tools/test-players.js
// 判定标准全部基于「文件里确实有这些数据」，不依赖服务端是否在跑。
const assert = require('assert');
const path = require('path');
const playersLib = require('../lib/players');
const config = require('../lib/config');

let pass = 0;
const fails = [];

function check(name, fn) {
  try {
    fn();
    pass++;
    console.log('  ✓ ' + name);
  } catch (e) {
    fails.push(name + ' —— ' + e.message);
    console.log('  ✗ ' + name + ' —— ' + e.message);
  }
}

console.log('');
console.log('  玩家档案自测');
console.log('  存档目录 : ' + config.savesDir);
console.log('');

const file = playersLib.findCompanionJson();
console.log('  配对文件 : ' + (file || '（未找到）'));
console.log('');

check('能找到与存档配对的 .json', () => {
  assert.ok(file, '没有找到配对 json');
  assert.ok(/\.json$/i.test(file));
});

check('BOM 不影响解析（存档文件带 UTF-8 BOM）', () => {
  const raw = require('fs').readFileSync(file, 'utf8');
  assert.strictEqual(raw.charCodeAt(0), 0xfeff, '这个文件现在没有 BOM 了，测试前提变了');
  const data = playersLib.parseJsonFile(file); // 内部已剥离 BOM
  assert.ok(data && typeof data === 'object');
});

const s = playersLib.snapshot({ onlineList: [], world: null });

check('snapshot 读取成功', () => {
  assert.strictEqual(s.ok, true, s.error);
  assert.ok(Array.isArray(s.players));
});

check('每个玩家都有稳定的展示身份', () => {
  assert.ok(s.players.length > 0, '存档里一个玩家都没有');
  for (const p of s.players) {
    assert.ok(p.platformName, '缺 platformName');
    assert.ok(/^\d{17}$/.test(p.controllerId), 'ControllerId 不是 SteamID64: ' + p.controllerId);
    assert.ok(p.steamUrl.startsWith('https://steamcommunity.com/profiles/'), '缺 Steam 链接');
    assert.ok(p.initials && p.initials.length <= 2, '头像缩写异常: ' + p.initials);
    assert.ok(p.hue >= 0 && p.hue < 360, '色相越界');
  }
});

check('锻造数据可聚合（熟练度 / 已解锁部件 / 打造件数）', () => {
  for (const p of s.players) {
    assert.ok(p.crafting.templates.length > 0, p.platformName + ' 没有任何锻造模板');
    assert.ok(p.crafting.totalXp > 0, p.platformName + ' 锻造熟练度为 0');
    assert.ok(p.crafting.unlockedParts >= 0);
    // 模板列表必须按熟练度降序，卡片进度条依赖这个顺序
    const xps = p.crafting.templates.map((t) => t.xp);
    const sorted = xps.slice().sort((a, b) => b - a);
    assert.deepStrictEqual(xps, sorted, '模板没有按熟练度降序');
    for (const t of p.crafting.templates) {
      assert.ok(!/^CraftingTemplate_/.test(t.label), '模板名没转成中文: ' + t.label);
    }
  }
});

check('交易数据可聚合', () => {
  for (const p of s.players) {
    assert.ok(p.trade.kinds >= 0);
    assert.ok(p.trade.units >= 0);
    assert.ok(p.trade.top.length <= 5, '交易榜最多 5 条');
    for (const t of p.trade.top) assert.ok(!/^ItemObject_/.test(t.label), '物品名没清洗: ' + t.label);
  }
});

check('社交 / 库存 / 工坊字段都有默认值，不会 undefined', () => {
  for (const p of s.players) {
    for (const k of ['metHeroes', 'villagers', 'caravans', 'bandits', 'arenaMasters']) {
      assert.strictEqual(typeof p.social[k], 'number', k + ' 不是数字');
    }
    assert.strictEqual(typeof p.social.knowsTournament, 'boolean');
    assert.strictEqual(typeof p.inventory.locked, 'number');
    assert.strictEqual(typeof p.economy.workshops, 'number');
  }
});

check('在线状态：空列表时全部离线', () => {
  for (const p of s.players) assert.strictEqual(p.online, false);
  assert.strictEqual(s.online, 0);
});

check('在线匹配：字段名换成任意写法都能认出来', () => {
  const victim = s.players[0];
  // 模拟服务端推的两种可能的 schema：一种叫 name，一种叫 playerName+steamId
  const variants = [
    [{ name: victim.platformName }],
    [{ playerName: victim.platformName, ping: 32 }],
    [{ displayName: victim.platformName.toUpperCase(), partySize: 47 }],
    [{ controllerId: victim.controllerId }],
    [{ steamId: victim.controllerId, heroId: victim.heroId }],
    [{ nested: { who: victim.platformName } }],
  ];
  for (const list of variants) {
    const snap = playersLib.snapshot({ onlineList: list, world: null });
    const hit = snap.players.find((p) => p.platformName === victim.platformName);
    assert.ok(hit, '没匹配到 ' + victim.platformName);
    assert.strictEqual(hit.online, true, '匹配到了却没标在线：' + JSON.stringify(list));
    assert.strictEqual(snap.online, 1, '在线人数统计不对');
  }
});

check('世界心跳字段透传', () => {
  const w = { date: 'Autumn 19, 1087', timeMode: 'Stop', players: 1, parties: 1511, mapEvents: 9, mainParty: { x: 1, y: 2 } };
  const snap = playersLib.snapshot({ onlineList: [], world: w });
  assert.deepStrictEqual(snap.world, w);
});

check('缺失字段如实声明，不编数字', () => {
  // 详情模块在跑的时候，等级/金币/部队这些已经能拿到了，missing 只该剩「领地」；
  // 模块没落盘的时候才需要把这些列进 missing。两种状态都必须诚实。
  assert.ok(s.missing.includes('领地'), 'missing 里应该列出 领地');
  assert.ok(s.missingReason && s.missingReason.length > 10);
  const hasDetail = s.players.some((p) => p.hasDetail);
  if (hasDetail) {
    assert.ok(!s.missing.includes('角色等级'),
      '详情已经有了却还把 角色等级 列为缺失');
  } else {
    for (const k of ['角色等级', '金币', '影响力', '部队人数']) {
      assert.ok(s.missing.includes(k), '模块没落盘时 missing 应该列出 ' + k);
    }
  }
});

// —— 在线识别：服务端只给「游戏内角色名」，存档里只有 PlatformName ——
// 这两个名字完全不同（袁本初 ↔ Corvus.Jazz），靠 detail.name 才能对上。
// 这条断言就是那天"人在游戏里跑图、地图上却显示离线"的回归。
check('在线记录只给角色名时也能认出是谁（袁本初 ↔ Corvus.Jazz）', () => {
  if (!s.ok) return;
  const target = s.players.find((p) => p.detail && p.detail.name);
  assert.ok(target, '没有带 detail.name 的玩家，无法验证（先让 CoopPlayerCard 落一次盘）');
  const online = [{ id: 0, name: target.detail.name, state: 'on map', addr: '10.0.0.9:1234' }];
  const s2 = playersLib.snapshot({ onlineList: online, world: null });
  const hit = s2.players.find((p) => p.platformName === target.platformName);
  assert.ok(hit.online, target.platformName + ' 应当被认成在线');
  assert.strictEqual(hit.onlineRaw.name, target.detail.name, 'onlineRaw 应保留原始在线记录');
  // 不能因为名字模糊匹配把别人也点亮
  const others = s2.players.filter((p) => p.platformName !== target.platformName && p.online);
  assert.strictEqual(others.length, 0, '不该把其他玩家也判成在线');
});

console.log('');
if (fails.length) {  console.log('  ' + pass + ' 项通过，' + fails.length + ' 项失败');
  for (const f of fails) console.log('    - ' + f);
  process.exitCode = 1;
} else {
  console.log('  ' + pass + ' 项全部通过');
}

// 打印一份人看的摘要，方便肉眼确认数字对不对
if (s.ok) {
  console.log('');
  console.log('  —— 实际抓到的数据 ——');
  for (const p of s.players) {
    console.log('  ' + p.platformName + '  (' + p.heroId + ' · ' + p.clanId + ')');
    console.log('    锻造 : 熟练 ' + p.crafting.totalXp + ' · 已解锁部件 ' + p.crafting.unlockedParts +
      ' · 亲手打造 ' + p.crafting.craftedItems);
    console.log('    专精 : ' + p.crafting.templates.slice(0, 4).map((t) => t.label + ' ' + t.xp).join(' / '));
    console.log('    交易 : ' + p.trade.kinds + ' 种 · 共 ' + p.trade.units + ' 件');
    console.log('    社交 : 见过 ' + p.social.metHeroes + ' 人 · 村民 ' + p.social.villagers +
      ' · 商队 ' + p.social.caravans + ' · 竞技大会 ' + (p.social.knowsTournament ? '会' : '不会'));
    console.log('    其他 : 库存锁定 ' + p.inventory.locked + ' 件 · 工坊 ' + p.economy.workshops + ' 处');
    console.log('');
  }
  console.log('  档案更新时间 : ' + new Date(s.updatedAt).toLocaleString('zh-CN'));
  console.log('');
}
