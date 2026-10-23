'use strict';
// 玩家详情页渲染自测（含技能树）。
//
// 和 test-players-view.js 一样：这台机器截不出图，所以在假 DOM 里把真实 app.js
// 跑起来，直接检查 renderPlayerDetail 吐出来的 HTML。
//
// 技能树的数据是异步取的（/api/perks），所以这里给假 fetch 塞一份真实目录，
// 先把「目录还没到」的降级分支验一遍，再等 promise 落地验技能树本身。
//
// 用法：node tools/test-detail-view.js
const assert = require('assert');
const { loadApp } = require('./lib/fake-dom');
const playersLib = require('../lib/players');
const playercardsLib = require('../lib/playercards');
const mapLib = require('../lib/map');

let pass = 0;
const fails = [];
function check(name, fn) {
  try { fn(); pass++; console.log('  ✓ ' + name); }
  catch (e) { fails.push(name + ' —— ' + e.message); console.log('  ✗ ' + name + ' —— ' + e.message); }
}

const tick = () => new Promise((r) => setImmediate(r));
// 专精已按用户要求从页面上全部移除（卡片与详情页统一只显示技能）
const SKILL_PROF_HAS = null;

(async function main() {
  console.log('');
  console.log('  玩家详情页渲染自测（假 DOM 里跑真实 app.js）');
  console.log('');

  const snap = playersLib.snapshot({ onlineList: [], world: null });
  if (!snap.ok) {
    console.error('  数据层没读出来，先跑 test-players.js：' + snap.error);
    process.exit(1);
  }

  const perks = playercardsLib.perkCatalog();
  const mapData = mapLib.load();
  const { sandbox, el } = loadApp({
    fetch: (url) => {
      if (String(url).indexOf('/api/perks') >= 0) return perks;
      if (String(url).indexOf('/api/map') >= 0) return mapData;
      return null;
    },
  });

  const withDetail = snap.players.filter((p) => p.hasDetail);
  if (!withDetail.length) {
    console.error('  没有玩家带详情数据 —— 服务端 CoopPlayerCard 模块还没落盘，先启动服务端再跑');
    process.exit(1);
  }
  const p0 = withDetail[0];
  const d0 = p0.detail;
  const html = () => el('#player-detail').innerHTML;

  check('详情渲染函数都在（app.js 没有顶层崩溃）', () => {
    for (const fn of ['renderPlayerDetail', 'openPlayerDetail', 'closePlayerDetail',
      'pdEquipmentRows', 'pdSkillsSection', 'pdSkillTree', 'pdSkillButton',
      'showPerkTip', 'hidePerkTip', 'selectDetailSkill', 'pdParty', 'pdMount', 'pdModifier',
      'loadMap', 'nearestSettlement', 'renderMapTab', 'startMapTimer', 'stopMapTimer']) {
      assert.strictEqual(typeof sandbox[fn], 'function', fn + ' 未定义');
    }
  });

  check('perk 目录可用（18 个技能 / 300+ 个 perk，带中文说明）', () => {
    assert.ok(perks.ok, perks.error);
    assert.ok(perks.count > 300, 'perk 数量太少：' + perks.count);
    assert.strictEqual(perks.skills.length, 18, '技能数量不对');
    const riding = perks.skills.find((s) => s.id === 'Riding');
    assert.ok(riding && riding.tiers.length >= 10, '骑术的档位不对');
    const first = riding.tiers[0].perks[0];
    assert.ok(/[\u4e00-\u9fa5]/.test(first.name), 'perk 名字没有中文化：' + first.name);
    assert.ok(/[\u4e00-\u9fa5]/.test(first.desc), 'perk 说明没有中文化：' + first.desc);
    assert.ok(!/\{[A-Za-z_0-9]+\}/.test(first.desc), 'perk 说明里漏出了占位符：' + first.desc);
  });

  check('头部：玩家名 / 等级 / 金币 / 生命 / 返回按钮齐全', () => {
    sandbox.renderPlayerDetail(p0);
    const h = html();
    assert.ok(h.includes(p0.platformName), '缺玩家名');
    assert.ok(h.includes('>' + p0.initials + '<'), '缺头像缩写');
    assert.ok(h.includes('pd-portrait'), '缺头像块');
    assert.ok(h.includes(d0.level ? String(d0.level) : '—'), '缺等级');
    assert.ok(h.includes('等级'), '等级没有标签');
    assert.ok(h.includes('金币'), '缺金币标签');
    assert.ok(h.includes('生命'), '缺生命标签');
    assert.ok(h.includes('pd-back'), '缺返回按钮');
    assert.ok(h.includes('返回名册'), '返回按钮没有文字');
    assert.ok(!/undefined|NaN/.test(h), 'HTML 里漏出了 undefined/NaN');
  });

  check('装备：战斗与平民两栏都在，槽位名用中文且按顺序', () => {
    const h = html();
    assert.ok(h.includes('战斗装备'), '缺战斗装备栏');
    assert.ok(h.includes('平民装备'), '缺平民装备栏');
    for (const e of d0.equipment.battle) {
      assert.ok(h.includes(e.name), '缺装备 ' + e.name);
    }
    for (const want of ['武器 1', '头盔', '身甲']) {
      assert.ok(h.includes(want), '槽位中文名缺失：' + want);
    }
    assert.ok(!h.includes('槽位 5'), '还有没识别的槽位（槽位 5 就是头盔）');
    assert.ok(h.includes('pd-eq'), '没有装备行样式');
  });

  check('装备与兵种名字都换成了中文（不再满屏英文）', () => {
    const h = html();
    const cn = (s) => /[\u4e00-\u9fa5]/.test(s);
    const translated = d0.equipment.battle.filter((e) => cn(e.name)).length;
    assert.ok(translated >= Math.min(3, d0.equipment.battle.length),
      '装备名基本还是英文，只译了 ' + translated + ' 件');
    if (d0.party) {
      const tCn = d0.party.troops.filter((t) => cn(t.name)).length;
      assert.ok(tCn >= Math.ceil(d0.party.troops.length * 0.8),
        '兵种名译得太少：' + tCn + '/' + d0.party.troops.length);
    }
  });

  check('坐骑：马名、马具、类型标签都在', () => {
    const h = html();
    if (!d0.mount) {
      assert.ok(h.includes('没有马'), '没有坐骑时应该说明原因');
      return;
    }
    assert.ok(h.includes(d0.mount.name), '缺坐骑名 ' + d0.mount.name);
    assert.ok(h.includes('pd-mount'), '缺坐骑卡');
    assert.ok(h.includes(d0.mount.typeLabel), '缺坐骑类型');
    if (d0.mount.harness) assert.ok(h.includes(d0.mount.harness.name), '缺马具名');
  });

  check('部队：总兵力 / 兵种数 / 俘虏 / 士气 + 等级构成条 + 兵种明细', () => {
    const h = html();
    if (!d0.party) {
      assert.ok(h.includes('没有带队'), '没有部队时应该说明原因');
      return;
    }
    for (const k of ['总兵力', '兵种', '俘虏', '士气']) assert.ok(h.includes(k), '缺 ' + k);
    assert.ok(h.includes('pd-mix'), '缺等级构成条');
    assert.ok(h.includes('pd-troop'), '缺兵种明细行');
    for (const t of d0.party.troops.slice(0, 8)) {
      assert.ok(h.includes(t.name), '兵种明细里缺 ' + t.name);
    }
    assert.ok(h.includes(String(Math.round(d0.party.morale * 10) / 10)), '士气精度丢了');
  });

  check('等级构成条的宽度加起来接近 100%', () => {
    const h = html();
    const seg = Array.from(h.matchAll(/pd-mix-seg[^"]*" style="width:(\d+)%"/g)).map((m) => Number(m[1]));
    assert.ok(seg.length > 0, '构成条没有分段');
    const sum = seg.reduce((a, b) => a + b, 0);
    assert.ok(sum >= 95 && sum <= 105, '构成条总宽 ' + sum + '% 不接近 100%');
  });

  check('perk 目录还没到时：先画技能条 + 说明「加载中」，不空白', () => {
    const h = html();
    assert.ok(h.includes('加载中') || h.includes('读取失败'), '没有降级提示');
    assert.ok(h.includes('pd-skill'), '降级时连技能条都没画');
    assert.ok(h.includes('pd-skill-bar'), '降级时没有熟练度条');
    for (const s of d0.skills) assert.ok(h.includes(s.name), '缺技能 ' + s.name);
  });

  // —— 等 /api/perks 落地后重画 ——
  await tick();
  await tick();
  sandbox.renderPlayerDetail(p0);

  // 地图底图数据（/api/map）是异步的：先拉到缓存，后面的位置区块才能同步断言
  await sandbox.loadMap();
  sandbox.renderPlayerDetail(p0);

  check('技能树：左边技能列表 + 右边树，技能数量对得上', () => {
    const h = html();
    assert.ok(h.includes('pd-tree-wrap'), '没有技能树布局');
    assert.ok(h.includes('pd-skill-list'), '没有左侧技能列表');
    assert.ok(h.includes('pd-tree'), '没有右侧技能树');
    const btns = (h.match(/class="pd-sk[^"]*" data-skill=/g) || []).length;
    assert.strictEqual(btns, d0.skills.length, '技能按钮数量不对');
    for (const s of d0.skills) assert.ok(h.includes('data-skill="' + s.id + '"'), '缺技能按钮 ' + s.id);
  });

  check('技能树：默认展开熟练度最高且确实有树的那一项', () => {
    const h = html();
    const active = (h.match(/class="pd-sk is-active" data-skill="([^"]+)"/) || [])[1];
    assert.ok(active, '没有默认展开的技能');
    const withTree = d0.skills.filter((s) => perks.skills.some((c) => c.id === s.id));
    assert.strictEqual(active, withTree[0].id, '默认展开的不是最高熟练度且有树的技能');
  });

  check('技能树：档位行数、perk 数量与目录一致，锁定档位有标记', () => {
    const h = html();
    const active = (h.match(/class="pd-sk is-active" data-skill="([^"]+)"/) || [])[1];
    const cat = perks.skills.find((s) => s.id === active);
    const skill = d0.skills.find((s) => s.id === active);

    const rows = (h.match(/class="pd-tier-row/g) || []).length;
    assert.strictEqual(rows, cat.tiers.length, '档位行数不对');

    const chips = (h.match(/class="pd-perk[^"]*" data-perk=/g) || []).length;
    assert.strictEqual(chips, cat.count, 'perk 按钮数量不对');

    const locked = (h.match(/class="pd-tier-row is-locked"/g) || []).length;
    const expectLocked = cat.tiers.filter((t) => skill.value < t.req).length;
    assert.strictEqual(locked, expectLocked, '锁定档位数量不对');

    for (const t of cat.tiers.slice(0, 5)) {
      assert.ok(h.includes('>' + t.req + '<'), '缺档位刻度 ' + t.req);
    }
  });

  check('技能树：已点亮的 perk 高亮，数量与该技能的已学数一致', () => {
    const h = html();
    const active = (h.match(/class="pd-sk is-active" data-skill="([^"]+)"/) || [])[1];
    const cat = perks.skills.find((s) => s.id === active);
    const taken = new Set(d0.perks || []);
    const expect = cat.tiers.reduce((n, t) => n + t.perks.filter((p) => taken.has(p.id)).length, 0);

    const on = (h.match(/class="pd-perk is-on"/g) || []).length;
    assert.strictEqual(on, expect, '高亮的 perk 数量不对（期望 ' + expect + '）');
    if (expect > 0) {
      assert.ok(h.includes('pd-perk-check'), '高亮的 perk 没有勾');
      assert.ok(h.includes('已学 ' + expect + ' / ' + cat.count), '「已学 x / y」不对');
    }
  });

  check('技能树：perk 按钮带 data-perk，鼠标说明能取到数据', () => {
    const h = html();
    const id = (h.match(/data-perk="([^"]+)"/) || [])[1];
    assert.ok(id, '没有 data-perk');

    // 造一个假元素，直接调 showPerkTip
    const fake = {
      dataset: { perk: id, taken: '0' },
      classList: { contains: () => false },
      textContent: '',
    };
    sandbox.showPerkTip(fake, { clientX: 100, clientY: 100 });
    const tip = el('#pd-tip').innerHTML;
    assert.ok(tip.includes('pd-tip-head'), '说明框没有标题');
    assert.ok(tip.includes('pd-tip-desc'), '说明框没有正文');
    assert.ok(tip.length > 40, '说明框内容太少：' + tip);
    assert.ok(!/\{[A-Za-z_0-9]+\}/.test(tip), '说明里漏出了占位符');

    sandbox.hidePerkTip();
    assert.strictEqual(el('#pd-tip').hidden, true, '说明框没被收起');
  });

  check('页面上不再出现「武器专精」（卡片与详情页统一为技能）', () => {
    sandbox.renderPlayerDetail(p0);
    const h = html();
    assert.ok(!h.includes('武器专精'), '详情页还有专精区块（应已移除）');
    assert.ok(!h.includes('对应的武器专精'), '缺「移除干净」的确认');
    assert.ok(h.includes('pd-tree-wrap'), '技能树还在');
  });

  check('详情页不再包含位置地图（已挪到独立的「地图」菜单）', () => {
    sandbox.renderPlayerDetail(p0);
    const h = html();
    assert.ok(!h.includes('pd-map'), '详情页里还有地图区块（应已挪走）');
    assert.ok(!h.includes('位置'), '详情页里还有「位置」区块标题');
    // 卡片位置行照旧保留（那是名册，不是详情）
  });

  check('换一个玩家，详情跟着换（不残留上一个人的数据）', () => {
    if (withDetail.length < 2) {
      assert.ok(true, '只有一个玩家有详情，跳过');
      return;
    }
    const p1 = withDetail[1];
    sandbox.renderPlayerDetail(p1);
    const h = html();
    assert.ok(h.includes(p1.platformName), '没渲染第二个玩家');
    assert.ok(h.includes(String(p1.detail.level)) || p1.detail.level === d0.level, '等级没换成第二个人的');
  });

  check('详情数据缺失时给可操作的提示，而不是空白', () => {
    sandbox.renderPlayerDetail({ platformName: 'Nobody', heroId: 'Hero_X', initials: 'NO', hue: 200, detail: null });
    const h = html();
    assert.ok(h.includes('还没有详情数据'), '缺提示标题');
    assert.ok(h.includes('CoopPlayerCard') || h.includes('服务端'), '缺数据来源说明');
    assert.ok(h.includes('重启一次控制台'), '缺「重启控制台」这条关键提示');
    assert.ok(!/undefined|NaN/.test(h), 'HTML 里漏出了 undefined/NaN');
  });

  check('空壳详情（没装备没部队没技能）不崩也不漏 undefined', () => {
    sandbox.renderPlayerDetail({
      platformName: 'Ghost', heroId: 'Hero_Ghost', initials: 'GH', hue: 12, online: false,
      detail: {
        heroId: 'Ghost', name: 'Ghost', level: 1, gold: 0, age: 0, hitPoints: 0,
        clan: { name: '', id: '', tier: 0, influence: 0, renown: 0, kingdom: '' },
        culture: '', skills: [], attributes: [], perks: [],
        equipment: { battle: [], civilian: [] }, mount: null, party: null,
        generatedAt: '', excludes: ['家族成员'],
      },
    });
    const h = html();
    assert.ok(h.includes('战斗套装是空的'), '空装备没给说明');
    assert.ok(h.includes('没有马'), '没坐骑没给说明');
    assert.ok(h.includes('没有带队'), '没部队没给说明');
    assert.ok(h.includes('还没有可读的技能'), '没技能没给说明');
    assert.ok(!/undefined|NaN/.test(h), 'HTML 里漏出了 undefined/NaN');
  });

  check('物品修饰标签不会跟中文译名重复', () => {
    assert.strictEqual(sandbox.pdModifier({ name: 'Winds Fury', modifier: 'Fine' }), '<em>Fine</em>');
    assert.strictEqual(sandbox.pdModifier({ name: 'Fine Winds Fury', modifier: 'Fine' }), '');
    assert.strictEqual(sandbox.pdModifier({ name: '裂开的锻造了 双手长杆', modifier: 'Cracked' }), '');
    assert.strictEqual(sandbox.pdModifier({ name: 'X', modifier: '' }), '');
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
})();
