'use strict';
// 玩家详情：读服务端 CoopPlayerCard 模块每 15 秒落盘的 playercards.json。
//
// 为什么需要这份文件：
//   等级 / 金币 / 家族 / 装备 / 坐骑 / 部队 / 技能加点全在 .sav 的压缩世界里，明文搜不到，
//   游戏自带的 campaign.export_* 又被 "Cheat mode is disabled!" 挡掉。所以只能在服务端
//   进程内把 Campaign 对象图读出来（Modules/Coop 里那个只读模块），外部再解析这份 JSON。
//
// 数据归属要说清：
//   - 本文件的数字来自**游戏进程内的实时快照**，不是存档配对 json，所以刷新节奏是 15 秒一次，
//     比 /api/players 里那些「跟着存档走」的数据要新。
//   - 模块刻意不导出家族成员列表（需求就是不要家族成员），这里也就没有。
const fs = require('fs');
const path = require('path');
const config = require('./config');
const l10n = require('./l10n');

// 装备槽位的展示顺序：先武器、再护甲、最后坐骑。
// 这个顺序由模块里的 SlotKeyOf 决定，两边要一起改。
const SLOT_ORDER = [
  'weapon0', 'weapon1', 'weapon2', 'weapon3', 'banner',
  'head', 'body', 'cape', 'gloves', 'leg', 'horse', 'harness',
];

// 物品类型 → 中文。模块给的是 ItemType 枚举名，没覆盖到的原样显示。
const ITEM_TYPE_ZH = {
  OneHandedWeapon: '单手武器',
  TwoHandedWeapon: '双手武器',
  Polearm: '长杆武器',
  Bow: '弓',
  Crossbow: '弩',
  Arrows: '箭矢',
  Bolts: '弩矢',
  Shield: '盾牌',
  Thrown: '投掷武器',
  HeadArmor: '头盔',
  Helmet: '头盔',
  BodyArmor: '身甲',
  LegArmor: '腿甲',
  HandArmor: '手甲',
  Cape: '披风',
  Horse: '坐骑',
  HorseHarness: '马具',
  Saddle: '马鞍',
  Banner: '旗帜',
  Book: '书籍',
  Good: '货物',
  Animal: '牲畜',
  UnusedHead: '未用头盔',
};

// 技能 id → 中文。模块给的是 Hero 的技能 StringId，固定那一批，可以直接查表；
// 查不到就退回英文 id（绝不乱猜）。
const SKILL_ZH = {
  OneHanded: '单手',
  TwoHanded: '双手',
  Polearm: '长杆',
  Bow: '弓术',
  Crossbow: '弩术',
  Throwing: '投掷',
  Riding: '骑术',
  Athletics: '奔跑',
  Smithing: '锻造',
  Tactics: '战术',
  Leadership: '统御',
  Steward: '管理',
  Medicine: '医术',
  Engineering: '工程',
  Scouting: '侦察',
  Roguery: '劫掠',
  Charm: '魅力',
  Trade: '交易',
  Crafting: '锻造',
};

// 属性 id → 中文。模块给的 id 是小写（vigor），名字是大写开头（Vigor），
// 所以下面这几个查表函数一律按小写比较。
const ATTR_ZH = {
  Vigor: '活力',
  Control: '控制',
  Endurance: '耐力',
  Cunning: '狡诈',
  Social: '社交',
  Intelligence: '智力',
};

function lookupZh(map, ...candidates) {
  for (const c of candidates) {
    if (!c) continue;
    const s = String(c);
    if (map[s]) return map[s];
    const lower = s.toLowerCase();
    for (const k of Object.keys(map)) {
      if (k.toLowerCase() === lower) return map[k];
    }
  }
  return '';
}

function itemTypeLabel(type) {
  const t = String(type || '');
  return lookupZh(ITEM_TYPE_ZH, t) || t.replace(/([a-z])([A-Z])/g, '$1 $2');
}

function skillLabel(id, fallback) {
  return lookupZh(SKILL_ZH, id) || fallback || id;
}

function attrLabel(id, fallback) {
  return lookupZh(ATTR_ZH, id, fallback) || fallback || id;
}

// ————————————————————— 读文件（带 mtime 缓存） —————————————————————

let cache = { file: '', mtimeMs: 0, size: 0, data: null };

// 模块用 File.Move 原子替换，所以这里不会读到半份文件；但 BOM/padding 还是防一手。
function parseCards(file) {
  const raw = fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '');
  return JSON.parse(raw);
}

function load() {
  const file = config.playercardsFile;
  let st;
  try {
    st = fs.statSync(file);
  } catch (e) {
    return {
      file,
      error: '还没读到 ' + path.basename(file) + '（模块没加载，或服务端还没跑到第一次落盘）',
      data: null,
    };
  }

  if (cache.file === file && cache.mtimeMs === st.mtimeMs && cache.size === st.size && cache.data) {
    return { file, mtimeMs: st.mtimeMs, data: cache.data };
  }
  try {
    const data = parseCards(file);
    cache = { file, mtimeMs: st.mtimeMs, size: st.size, data };
    return { file, mtimeMs: st.mtimeMs, data };
  } catch (e) {
    return { file, error: '解析失败：' + e.message + '（写盘瞬间恰好被读到？下一次刷新会自愈）', data: null };
  }
}

// ————————————————————— 字段整理 —————————————————————

// 存档配对文件里是 Hero_Player / Hero_Player2863，模块输出的是 Player / Player2863
// （Hero 的 StringId 不带 Hero_ 前缀）。比对前统一去掉前缀并转小写。
function normHeroId(id) {
  return String(id || '').replace(/^Hero_/i, '').trim().toLowerCase();
}

function sortEquipment(list) {
  const arr = Array.isArray(list) ? list.slice() : [];
  const rank = (e) => {
    const i = SLOT_ORDER.indexOf(slotKeyOf(e));
    return i < 0 ? SLOT_ORDER.length : i;
  };
  return arr.sort((a, b) => rank(a) - rank(b)).map((e) => {
    const key = slotKeyOf(e);
    return {
      key,
      slotIndex: Number(e.slotIndex) || 0,
      slotLabel: SLOT_LABEL[key] || e.slotLabel || e.slotEnum || '槽位',
      name: zhName(e),
      // 英文原名留着做 title，看到中文名对不上攻略时还能对照
      nameEn: e.name || '',
      id: e.id || '',
      type: e.type || '',
      typeLabel: itemTypeLabel(e.type),
      tier: Number(e.tier) || 0,
      modifier: String(e.modifier || '').trim(),
    };
  });
}

// 槽位 key → 中文。模块也会给 slotLabel，但这里自己有一份：
// 万一模块版本老了只有类型没有 key（早期版本头盔落在 5 号位时就没有 key），
// 也能靠物品类型反推出正确的中文和排序位置。
const SLOT_LABEL = {
  weapon0: '武器 1', weapon1: '武器 2', weapon2: '武器 3', weapon3: '武器 4',
  banner: '旗帜', head: '头盔', body: '身甲', cape: '披风',
  gloves: '护手', leg: '靴子', horse: '坐骑', harness: '马具',
};

// 物品类型 → 槽位 key。装备类型不会因为枚举别名变化，用它兜底最稳。
const TYPE_KEY = {
  Helmet: 'head',
  HeadArmor: 'head',
  BodyArmor: 'body',
  Cape: 'cape',
  HandArmor: 'gloves',
  LegArmor: 'leg',
  Horse: 'horse',
  HorseHarness: 'harness',
  Banner: 'banner',
};

function slotKeyOf(e) {
  if (!e) return 'slot0';
  const k = String(e.key || '');
  if (SLOT_ORDER.indexOf(k) >= 0) return k;
  const byType = TYPE_KEY[e.type];
  if (byType) return byType;
  const i = Number(e.slotIndex);
  if (Number.isFinite(i)) {
    if (i >= 0 && i <= 3) return 'weapon' + i;
    if (i === 4) return 'banner';
  }
  return k || 'slot' + (Number.isFinite(i) ? i : 0);
}

function findSlot(equipment, key) {
  for (const e of equipment) if (e.key === key) return e;
  return null;
}

function summarizeParty(party) {
  if (!party || typeof party !== 'object') return null;

  const troops = (Array.isArray(party.troops) ? party.troops : [])
    .filter((t) => t && Number(t.count) > 0)
    .map((t) => ({
      name: zhName(t, t.id || '未知兵种'),
      nameEn: t.name || '',
      id: t.id || '',
      count: Number(t.count) || 0,
      wounded: Number(t.wounded) || 0,
      tier: Number(t.tier) || 0,
    }))
    // 高级兵在前，同级按人数多的在前 —— 看部队强弱一眼就够
    .sort((a, b) => (b.tier - a.tier) || (b.count - a.count));

  // 按兵种等级汇总，给前端画构成条
  const tierMap = new Map();
  let men = 0;
  let wounded = 0;
  for (const t of troops) {
    men += t.count;
    wounded += t.wounded;
    const g = tierMap.get(t.tier) || { tier: t.tier, count: 0 };
    g.count += t.count;
    tierMap.set(t.tier, g);
  }
  const tiers = Array.from(tierMap.values()).sort((a, b) => a.tier - b.tier);

  return {
    name: party.name || '',
    // 地图坐标（Calradia 世界系，与 settlements.xml 同一坐标系）—— 画实时位置图用
    x: Number(party.x) || 0,
    y: Number(party.y) || 0,
    hasPosition: Number.isFinite(Number(party.x)) && Number.isFinite(Number(party.y))
      && (Number(party.x) !== 0 || Number(party.y) !== 0),
    manCount: Number(party.manCount) || men,
    men,
    wounded: Number(party.wounded) || wounded,
    prisoners: Number(party.prisoners) || 0,
    morale: Number(party.morale) || 0,
    inSettlement: party.inSettlement || '',
    troops,
    troopKinds: troops.length,
    tiers,
    maxTier: tiers.reduce((m, t) => Math.max(m, t.tier), 0),
  };
}

// 中文包里有些名字是**模板**，不能直接显示：
//   英雄本人（玩家在部队列表里自己那一行）  nameId=genericcharactername → `{CHARACTER_NAME}`
//   同伴 / 流浪者                          → `“求知客”{FIRSTNAME}`
// 服务端以英文运行，`{CHARACTER_NAME}` 可以直接用英文原名填（那就是英雄名）；
// `{FIRSTNAME}` 要的是「名」单独一段译文，得靠模块额外导出的 firstNameId（见 SubModule）。
//
// 兜底原则：填不干净就返回空，让调用方退回英文。宁可显示英文，
// 也不能把 `{FIRSTNAME}` 这种花括号漏到界面上。
const PLACEHOLDER_RE = /\{[A-Za-z][A-Za-z_0-9]*\}/;

function fillTemplate(cn, en, firstNameZh) {
  if (!cn || !PLACEHOLDER_RE.test(cn)) return cn || '';
  let out = cn
    .replace(/\{CHARACTER_NAME\}/g, String(en || '').trim())
    .replace(/\{FIRSTNAME\}/g, String(firstNameZh || '').trim());
  return PLACEHOLDER_RE.test(out) ? '' : out;
}

// 物品/兵种/perk 的名字都走这条：
//   1. 有字符串 id → 查官方中文包（Modules/*/Languages/CNs）
//   2. 查不到 → 用游戏原本给的名字（英文）。打造物品的名字是玩家客户端生成的，
//      存进存档时已经是中文，这种没有 id 可查，直接用原文
function zhName(obj, fallback) {
  const o = obj || {};
  const en = o.name || fallback || o.id || '';
  return fillTemplate(l10n.zh(o.nameId), en, l10n.zh(o.firstNameId)) || String(en || '');
}

function sortSkills(skills) {
  const arr = Array.isArray(skills) ? skills.slice() : [];
  return arr
    .map((s) => ({
      id: s.id || '',
      // 优先级：官方中文包（按 nameId）→ 自建小表 → 英文原名。
      // 这里不能直接套 zhName()：它的 fallback 会把英文原名排在自建表前面，
      // 老版本 DLL 没有 nameId 时就永远显示英文，小表等于白写。
      name: l10n.zh(s.nameId) || skillLabel(s.id, s.name),
      rawName: s.name || s.id || '',
      nameId: s.nameId || '',
      value: Number(s.value) || 0,
      focus: Number(s.focus) || 0,
      xp: Number(s.xp) || 0,
    }))
    .sort((a, b) => (b.value - a.value) || (b.focus - a.focus));
}

function sortAttributes(attrs) {
  const arr = Array.isArray(attrs) ? attrs.slice() : [];
  return arr.map((a) => ({
    id: a.id || '',
    // 同 sortSkills：官方中文包 → 自建小表 → 英文
    name: l10n.zh(a.nameId) || attrLabel(a.id, a.name),
    value: Number(a.value) || 0,
  }));
}

// 把模块输出的一条记录整理成前端直接可渲染的详情
function buildDetail(card, meta) {
  if (!card || typeof card !== 'object') return null;

  const battle = sortEquipment(card.battleEquipment);
  const civilian = sortEquipment(card.civilianEquipment);
  const horse = findSlot(battle, 'horse') || findSlot(civilian, 'horse');
  const harness = findSlot(battle, 'harness') || findSlot(civilian, 'harness');

  return {
    heroId: card.heroId || '',
    name: card.name || '',
    level: Number(card.level) || 0,
    gold: Number(card.gold) || 0,
    age: Number(card.age) || 0,
    isFemale: !!card.isFemale,
    hitPoints: Number(card.hitPoints) || 0,
    clan: {
      name: card.clan || '',
      id: card.clanId || '',
      tier: Number(card.clanTier) || 0,
      influence: Number(card.influence) || 0,
      renown: Number(card.renown) || 0,
      kingdom: card.kingdom || '',
    },
    culture: card.culture || '',
    skills: sortSkills(card.skills),
    attributes: sortAttributes(card.attributes),
    equipment: { battle, civilian },
    mount: horse ? Object.assign({}, horse, { harness: harness || null }) : null,
    party: summarizeParty(card.party),
    // 已点亮的 perk id 列表（技能树里高亮哪些）
    perks: Array.isArray(card.perks) ? card.perks.slice() : [],
    generatedAt: (meta && meta.generatedAt) || '',
    // 模块只导玩家英雄本人，家族成员本来就不在这个列表里
    excludes: ['家族成员'],
  };
}

// ————————————————————— 技能树 —————————————————————

// ————————————————————— perk 说明文本 —————————————————————

// 说明的组装方式（踩过坑，别乱改）：
//   perk.Description 只是一句模板 `{STR1}{newline} {newline}{STR2}`，中文包里同样是
//   一句纯模板，直接显示就是一堆花括号。真正的文案在
//   PrimaryDescription / SecondaryDescription 里，各自还带一个 {VALUE} 参数。
//
// 所以：拿效果文本的字符串 id 去中文包查 → 用英文已渲染好的文本里那个数字替换 {VALUE}
// → {newline} 换成换行 → 剩下的未知占位符一律删掉（宁可少点字，也别把 {STR1} 漏给用户）。
function firstNumber(text) {
  const m = String(text || '').match(/[+-]?\d+(?:\.\d+)?/);
  return m ? m[0] : '';
}

function cleanEffect(text, enRendered, bonus) {
  if (!text) return '';
  // 数值优先取英文渲染结果里的（那是游戏算好的真实值），取不到才退回 bonus
  const value = firstNumber(enRendered) || (Number(bonus) ? String(Math.round(Number(bonus) * 100) / 100) : '');

  return String(text)
    .replace(/\{VALUE\}/gi, value)
    .replace(/\{newline\}/gi, '\n')
    .replace(/\{[A-Za-z_0-9]+\}/g, '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function perkEffect(descId, enRendered, bonus) {
  const cn = l10n.zh(descId);
  if (cn) return cleanEffect(cn, enRendered, bonus);
  // 没有译文就用游戏给的英文（已经是渲染好的，不需要替换参数）
  return cleanEffect(enRendered, enRendered, bonus);
}

function perkDescription(p) {
  const parts = [perkEffect(p.e1Id, p.e1, p.b1), perkEffect(p.e2Id, p.e2, p.b2)]
    .filter((s) => s && s.length > 0);
  if (parts.length) return parts.join('\n\n');
  // 两个效果都读不到时，退回那句模板（大概率是空的，但至少不编内容）
  return '';
}

// 全服共用的 perk 目录 → 按技能分组、再按需求熟练度分档。
// 模块在顶层导了一份 perkCatalog（不是每人都来一份），这里只是把它整理成前端好画的样子。
function perkCatalog() {
  const loaded = load();
  if (loaded.error || !loaded.data) {
    return { ok: false, error: loaded.error || '未知原因', skills: [], count: 0 };
  }

  const raw = Array.isArray(loaded.data.perkCatalog) ? loaded.data.perkCatalog : [];
  if (!raw.length) {
    return {
      ok: false,
      error: '模块没有导出 perk 目录（DLL 版本旧了？重装一次 Modules/Coop 里的 CoopPlayerCard.dll）',
      skills: [],
      count: 0,
    };
  }

  const bySkill = new Map();
  for (const p of raw) {
    const sid = p.skill || 'Unknown';
    if (!bySkill.has(sid)) bySkill.set(sid, []);
    bySkill.get(sid).push({
      id: p.id || '',
      name: zhName({ nameId: p.nameId, name: p.name }, p.id),
      nameEn: p.name || '',
      desc: perkDescription(p),
      descEn: [p.e1, p.e2].filter(Boolean).join('\n\n') || p.desc || '',
      alt: p.alt || '',
      req: Number(p.req) || 0,
    });
  }

  const skills = Array.from(bySkill.entries()).map(([id, list]) => {
    // 同一档（同 req）里通常是「二选一」的两个 perk，保持模块给的原始顺序
    list.sort((a, b) => a.req - b.req);
    const tiers = [];
    for (const p of list) {
      let t = tiers.find((x) => x.req === p.req);
      if (!t) { t = { req: p.req, perks: [] }; tiers.push(t); }
      t.perks.push(p);
    }
    tiers.sort((a, b) => a.req - b.req);
    return { id, name: skillLabel(id), count: list.length, tiers };
  }).sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'));

  return {
    ok: true,
    count: raw.length,
    generatedAt: loaded.data.generatedAt || '',
    ageMs: loaded.mtimeMs ? Date.now() - loaded.mtimeMs : 0,
    skills,
  };
}

// heroId（已归一化）→ 详情
function indexByHero(data) {
  const map = new Map();
  const list = data && Array.isArray(data.players) ? data.players : [];
  for (const card of list) {
    const d = buildDetail(card, data);
    if (!d) continue;
    const key = normHeroId(d.heroId);
    if (key) map.set(key, d);
    // 名字也进索引：存档里的 HeroId 与模块的 StringId 万一对不上，
    // 还能靠英雄名兜底（同名概率极低，且只做兜底不覆盖 id 命中）
    if (d.name) map.set('name:' + d.name.toLowerCase(), d);
  }
  return map;
}

// 给 /api/players 用的整体入口：一次读文件，返回 { ok, file, generatedAt, index, error }
function snapshot() {
  const loaded = load();
  if (loaded.error || !loaded.data) {
    return {
      ok: false,
      file: loaded.file,
      error: loaded.error || '未知原因',
      generatedAt: '',
      ageMs: 0,
      count: 0,
      index: new Map(),
    };
  }
  return {
    ok: true,
    file: loaded.file,
    generatedAt: loaded.data.generatedAt || '',
    ageMs: loaded.mtimeMs ? Date.now() - loaded.mtimeMs : 0,
    count: (loaded.data.players || []).length,
    scannedHeroes: loaded.data.scannedHeroes || 0,
    index: indexByHero(loaded.data),
  };
}

// 按玩家档案（HeroId 形如 Hero_Player / platformName）取详情
function lookup(index, profile) {
  if (!index) return null;
  const id = normHeroId(profile && profile.heroId);
  if (id && index.has(id)) return index.get(id);
  const name = String((profile && profile.platformName) || '').toLowerCase();
  if (name && index.has('name:' + name)) return index.get('name:' + name);
  return null;
}

module.exports = {
  snapshot,
  lookup,
  normHeroId,
  itemTypeLabel,
  skillLabel,
  attrLabel,
  perkCatalog,
  // 下面几个导出只给自测用（tools/test-playercards.js 要单独验排序/汇总逻辑）
  buildDetail,
  sortEquipment,
  summarizeParty,
  slotKeyOf,
  SLOT_ORDER,
};
