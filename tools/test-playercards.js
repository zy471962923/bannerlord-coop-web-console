'use strict';
// 玩家详情数据层自测（lib/playercards.js）。
//
// 重点是那几处「踩过坑」的地方：
//   - HeroId 前缀：存档配对文件写 Hero_Player，模块写 Player
//   - 装备槽位：EquipmentIndex 别名会让名字不可靠，只能按数值 + 物品类型判
//   - 部队汇总：人数/伤员/等级构成要能对上
//   - 属性点 id 是小写，中文表是大写开头
//
// 用法：node tools/test-playercards.js
const assert = require('assert');
const fs = require('fs');
const pc = require('../lib/playercards');
const config = require('../lib/config');

let pass = 0;
const fails = [];
function check(name, fn) {
  try { fn(); pass++; console.log('  ✓ ' + name); }
  catch (e) { fails.push(name + ' —— ' + e.message); console.log('  ✗ ' + name + ' —— ' + e.message); }
}

console.log('');
console.log('  玩家详情数据层自测');
console.log('');

check('HeroId 归一：Hero_ 前缀去掉、大小写无关', () => {
  assert.strictEqual(pc.normHeroId('Hero_Player'), 'player');
  assert.strictEqual(pc.normHeroId('Player2863'), 'player2863');
  assert.strictEqual(pc.normHeroId('hero_Player2863'), 'player2863');
  assert.strictEqual(pc.normHeroId(''), '');
  assert.strictEqual(pc.normHeroId(null), '');
});

check('槽位判定：有 key 用 key，没 key 靠物品类型反推', () => {
  assert.strictEqual(pc.slotKeyOf({ key: 'head', type: 'HeadArmor', slotIndex: 5 }), 'head');
  // 早期版本头盔落在 5 号位但没 key —— 只能靠类型
  assert.strictEqual(pc.slotKeyOf({ type: 'HeadArmor', slotIndex: 5 }), 'head');
  assert.strictEqual(pc.slotKeyOf({ type: 'Horse', slotIndex: 10 }), 'horse');
  assert.strictEqual(pc.slotKeyOf({ type: 'HorseHarness', slotIndex: 11 }), 'harness');
  // 武器没有专门类型，退回数值
  assert.strictEqual(pc.slotKeyOf({ type: 'Polearm', slotIndex: 0 }), 'weapon0');
  assert.strictEqual(pc.slotKeyOf({ type: 'Banner', slotIndex: 4 }), 'banner');
  assert.strictEqual(pc.slotKeyOf({ type: 'Thrown', slotIndex: 3 }), 'weapon3');
});

check('装备排序：武器 → 旗帜 → 头/身/披/手/腿 → 马 → 马具', () => {
  const messy = [
    { key: 'harness', slotLabel: '马具', name: 'Saddle' },
    { key: 'body', slotLabel: '身甲', name: 'Armor' },
    { key: 'weapon0', slotLabel: '武器 1', name: 'Sword' },
    { key: 'horse', slotLabel: '坐骑', name: 'Horse' },
    { key: 'head', slotLabel: '头盔', name: 'Helmet' },
    { key: 'weapon3', slotLabel: '武器 4', name: 'Javelin' },
    { key: 'cape', slotLabel: '披风', name: 'Cape' },
    { key: 'leg', slotLabel: '靴子', name: 'Boots' },
    { key: 'gloves', slotLabel: '护手', name: 'Mittens' },
    { key: 'banner', slotLabel: '旗帜', name: 'Flag' },
    { key: 'weapon1', slotLabel: '武器 2', name: 'Shield' },
    { key: 'weapon2', slotLabel: '武器 3', name: 'Bow' },
  ];
  const sorted = pc.sortEquipment(messy);
  assert.deepStrictEqual(sorted.map((e) => e.key), pc.SLOT_ORDER);
  assert.strictEqual(sorted[0].slotLabel, '武器 1');
  assert.strictEqual(sorted[sorted.length - 1].slotLabel, '马具');
});

check('物品 / 技能 / 属性都有中文名，查不到不硬编', () => {
  assert.strictEqual(pc.itemTypeLabel('HeadArmor'), '头盔');
  assert.strictEqual(pc.itemTypeLabel('Horse'), '坐骑');
  assert.strictEqual(pc.itemTypeLabel('WeirdNewType'), 'Weird New Type');
  assert.strictEqual(pc.skillLabel('Riding'), '骑术');
  assert.strictEqual(pc.skillLabel('riding'), '骑术');
  assert.strictEqual(pc.skillLabel('UnknownSkill', 'UnknownSkill'), 'UnknownSkill');
  // 模块给的属性 id 是小写 vigor，中文表 key 是大写开头
  assert.strictEqual(pc.attrLabel('vigor', 'Vigor'), '活力');
  assert.strictEqual(pc.attrLabel('Intelligence', 'Intelligence'), '智力');
});

check('部队汇总：人数 / 伤员 / 俘虏 / 等级构成都对得上', () => {
  const party = pc.summarizeParty({
    name: "艾德's Party",
    manCount: 64, wounded: 0, prisoners: 16, morale: 61.08, inSettlement: '',
    troops: [
      { name: 'Battanian Fian Champion', id: 'x1', count: 17, wounded: 0, tier: 6 },
      { name: '艾德', id: 'Player', count: 1, wounded: 0, tier: 0 },
      { name: 'Battanian Hero', id: 'x2', count: 15, wounded: 2, tier: 4 },
      { name: 'Battanian Fian', id: 'x3', count: 9, wounded: 0, tier: 5 },
      { name: '零人兵种', id: 'x4', count: 0, wounded: 0, tier: 3 },
    ],
  });
  assert.strictEqual(party.troopKinds, 4, '人数为 0 的兵种不该算进来');
  assert.strictEqual(party.men, 42, '人数汇总不对');
  assert.strictEqual(party.wounded, 2, '伤员汇总不对');
  assert.strictEqual(party.prisoners, 16);
  assert.strictEqual(party.troops[0].tier, 6, '高级兵应该排前面');
  assert.strictEqual(party.maxTier, 6);
  // 等级构成：T0=1, T4=15, T5=9, T6=17
  const total = party.tiers.reduce((s, t) => s + t.count, 0);
  assert.strictEqual(total, 42);
});

check('没有部队 / 没有装备时不崩，返回 null 或空数组', () => {
  assert.strictEqual(pc.summarizeParty(null), null);
  assert.deepStrictEqual(pc.sortEquipment(null), []);
  const d = pc.buildDetail({ heroId: 'Player', name: 'X' }, {});
  assert.strictEqual(d.party, null);
  assert.deepStrictEqual(d.equipment.battle, []);
  assert.strictEqual(d.mount, null);
});

check('技能按熟练度降序，专注点原样保留', () => {
  const d = pc.buildDetail({
    heroId: 'Player',
    skills: [
      { id: 'Trade', name: 'Trade', value: 18, focus: 0, xp: 10 },
      { id: 'Riding', name: 'Riding', value: 146, focus: 5, xp: 8469 },
      { id: 'Athletics', name: 'Athletics', value: 99, focus: 3, xp: 1503 },
    ],
    attributes: [{ id: 'vigor', name: 'Vigor', value: 2 }],
  }, {});
  assert.deepStrictEqual(d.skills.map((s) => s.id), ['Riding', 'Athletics', 'Trade']);
  assert.strictEqual(d.skills[0].name, '骑术');
  assert.strictEqual(d.skills[0].focus, 5);
  assert.strictEqual(d.attributes[0].name, '活力');
});

check('坐骑与马具单独拎出来，方便详情页做「马」那张卡', () => {
  const d = pc.buildDetail({
    heroId: 'Player',
    battleEquipment: [
      { key: 'horse', slotLabel: '坐骑', name: 'Palmatian', type: 'Horse', tier: 4 },
      { key: 'harness', slotLabel: '马具', name: 'Rough Cavalry Saddle', type: 'HorseHarness' },
      { key: 'body', slotLabel: '身甲', name: 'Armor', type: 'BodyArmor' },
    ],
  }, {});
  assert.ok(d.mount, '应该有坐骑');
  assert.strictEqual(d.mount.name, 'Palmatian');
  assert.strictEqual(d.mount.typeLabel, '坐骑');
  assert.ok(d.mount.harness, '马具应该挂在坐骑下面');
  assert.strictEqual(d.mount.harness.name, 'Rough Cavalry Saddle');
});

check('明确声明不含家族成员', () => {
  const d = pc.buildDetail({ heroId: 'Player', name: 'X' }, {});
  assert.deepStrictEqual(d.excludes, ['家族成员']);
});

// —— 集成：真文件存在就顺带验一遍 ——
if (fs.existsSync(config.playercardsFile)) {
  check('读真实 playercards.json：解析、索引、按 HeroId 查得到', () => {
    const s = pc.snapshot();
    assert.ok(s.ok, s.error);
    assert.ok(s.count > 0, '一个玩家都没导出来');
    assert.ok(s.index instanceof Map);

    // 存档配对文件里的 HeroId 是 Hero_Player，要靠归一化对上
    const hit = pc.lookup(s.index, { heroId: 'Hero_Player' });
    assert.ok(hit, 'Hero_Player 没对上模块导出的 Player');
    assert.ok(hit.level >= 0, '等级没读到');
    assert.ok(hit.equipment.battle.length > 0, '战斗装备一件都没有');

    const keys = hit.equipment.battle.map((e) => e.key);
    assert.ok(keys.includes('horse'), '战斗装备里应该有坐骑（' + keys.join(',') + '）');
    assert.ok(!keys.includes('slot5'), '还有没识别的槽位：' + keys.join(','));

    const order = keys.map((k) => pc.SLOT_ORDER.indexOf(k));
    for (let i = 1; i < order.length; i++) {
      assert.ok(order[i] > order[i - 1], '槽位顺序乱了：' + keys.join(','));
    }
  });

  check('真实数据里部队人数与兵种明细加得上', () => {
    const s = pc.snapshot();
    for (const p of s.index.values()) {
      if (!p.party) continue;
      const sum = p.party.troops.reduce((a, t) => a + t.count, 0);
      assert.strictEqual(sum, p.party.men, p.name + ' 的兵种明细加起来不等于总人数');
      assert.ok(p.party.manCount >= p.party.men, p.name + ' 总兵力小于明细人数');
    }
  });
} else {
  console.log('  · 跳过真实文件校验（' + config.playercardsFile + ' 不存在，服务端还没落盘）');
}

// —— 中文词典 ——————————————————————————————————————

check('中文包能解析出条目（UTF-16 大端 / 小端 / UTF-8 三种都要认）', () => {
  const l10n = require('../lib/l10n');
  const stats = l10n.stats();
  assert.ok(stats.files > 0, '一个中文包都没找到：' + stats.modulesDir);
  assert.ok(stats.entries > 5000, '中文条目太少：' + stats.entries);

  // 大端：FE FF 开头，字符高位在前
  const be = Buffer.from([0xfe, 0xff, 0x00, 0x3c, 0x00, 0x61, 0x00, 0x3e]);
  assert.strictEqual(l10n.decodeXml(be), '<a>');
  // 小端：FF FE 开头
  const le = Buffer.from([0xff, 0xfe, 0x3c, 0x00, 0x61, 0x00, 0x3e, 0x00]);
  assert.strictEqual(l10n.decodeXml(le), '<a>');
  // UTF-8 带 BOM
  const u8 = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('<a>', 'utf8')]);
  assert.strictEqual(l10n.decodeXml(u8), '<a>');
});

check('按字符串 id 查得到中文（物品 / 兵种）', () => {
  const l10n = require('../lib/l10n');
  assert.strictEqual(l10n.zh('m3Nv9rt2'), '缨饰游牧盔');       // Plumed Nomad Helmet
  assert.strictEqual(l10n.zh('1zObCG2o'), '巴旦尼亚费奥纳冠军'); // Battanian Fian Champion
  assert.strictEqual(l10n.zh('这个id不存在'), '');
  assert.strictEqual(l10n.zhOr('', 'fallback'), 'fallback');
});

check('装备/兵种的中文名靠 nameId 自动换上', () => {
  const d = pc.buildDetail({
    heroId: 'Player',
    battleEquipment: [
      { key: 'head', type: 'HeadArmor', name: 'Plumed Nomad Helmet', nameId: 'm3Nv9rt2' },
      { key: 'body', type: 'BodyArmor', name: 'No Id Armor' },
    ],
    party: { manCount: 1, troops: [{ name: 'Battanian Fian Champion', nameId: '1zObCG2o', count: 1, tier: 6 }] },
  }, {});
  assert.strictEqual(d.equipment.battle[0].name, '缨饰游牧盔');
  assert.strictEqual(d.equipment.battle[0].nameEn, 'Plumed Nomad Helmet');
  assert.strictEqual(d.equipment.battle[1].name, 'No Id Armor', '没有 id 的应该保持原文');
  assert.strictEqual(d.party.troops[0].name, '巴旦尼亚费奥纳冠军');
});

// —— 技能树 ——————————————————————————————————————

if (fs.existsSync(config.playercardsFile)) {
  check('技能树目录：18 个技能、300+ perk、按需求熟练度分档', () => {
    const cat = pc.perkCatalog();
    assert.ok(cat.ok, cat.error);
    assert.ok(cat.count > 300, 'perk 太少：' + cat.count);
    assert.strictEqual(cat.skills.length, 18);
    for (const s of cat.skills) {
      assert.ok(s.tiers.length >= 5, s.id + ' 的档位太少');
      const reqs = s.tiers.map((t) => t.req);
      for (let i = 1; i < reqs.length; i++) assert.ok(reqs[i] > reqs[i - 1], s.id + ' 档位没排序');
      for (const t of s.tiers) {
        assert.ok(t.perks.length >= 1, s.id + ' T' + t.req + ' 一个 perk 都没有');
      }
    }
  });

  check('perk 说明：中文、带具体数值、不漏占位符', () => {
    const cat = pc.perkCatalog();
    let cn = 0;
    let withNumber = 0;
    for (const s of cat.skills) {
      for (const t of s.tiers) {
        for (const p of t.perks) {
          assert.ok(!/\{[A-Za-z_0-9]+\}/.test(p.desc), p.id + ' 的说明漏出了占位符：' + p.desc);
          if (/[\u4e00-\u9fa5]/.test(p.name)) cn++;
          if (/\d/.test(p.desc)) withNumber++;
        }
      }
    }
    assert.ok(cn > cat.count * 0.9, 'perk 名字中文化不足：' + cn + '/' + cat.count);
    assert.ok(withNumber > cat.count * 0.5, '说明里带数值的太少：' + withNumber + '/' + cat.count);
  });

  check('已点亮的 perk 来自真实数据（数量合理）', () => {
    const s = pc.snapshot();
    for (const p of s.index.values()) {
      assert.ok(Array.isArray(p.perks), p.name + ' 的 perks 不是数组');
      assert.ok(p.perks.length < 200, p.name + ' 的 perks 数量离谱：' + p.perks.length);
    }
  });
}

console.log('');
if (fails.length) {
  console.log('  ' + pass + ' 项通过，' + fails.length + ' 项失败');
  for (const f of fails) console.log('    - ' + f);
  process.exitCode = 1;
} else {
  console.log('  ' + pass + ' 项全部通过');
  console.log('');
}
