'use strict';
// 玩家档案：把「存档配对文件」里的 per-hero 记录整理成可展示的玩家卡片数据。
//
// 数据来源与边界（很重要，别在这里编数据）：
//   1. saveauto1.json（与 saveauto1.sav 同名的配对文件）—— 服务端每次存档都会重写它。
//      里面按 HeroId 分块记录每个玩家的锻造/交易/库存/社交数据，这是唯一可信的玩家维度数据源。
//   2. .sav 本体 —— 4 字节长度 + 825 字节模块清单 + 压缩二进制世界，等级/金币/部队人数
//      全在压缩体里，没有官方读取接口。所以这里**不展示**这些字段，也不去猜。
//   3. @DS@ players 事件 —— 只表示「此刻连着谁」，字段结构没在无人进服时验证到，
//      因此用「把整条记录拍平成字符串再模糊匹配」的方式认人，字段叫什么都能对上。
//
// 换句话说：卡片里每个数字都来自文件，没有的字段就留空并注明来源，不拿估算值充数。
const fs = require('fs');
const path = require('path');
const config = require('./config');
const { parseJsonc } = require('./jsonc');
const playercards = require('./playercards');

// —— 锻造模板 / 物品 id 转成人话 ——
const TEMPLATE_LABEL = {
  OneHandedSword: '单手剑',
  TwoHandedSword: '双手剑',
  OneHandedAxe: '单手斧',
  TwoHandedAxe: '双手斧',
  Mace: '单手锤',
  TwoHandedMace: '双手锤',
  Dagger: '匕首',
  ThrowingKnife: '飞刀',
  ThrowingAxe: '飞斧',
  Javelin: '标枪',
  Pike: '长枪',
  TwoHandedPolearm: '双手长杆',
  Bow: '弓',
  Crossbow: '弩',
  Arrows: '箭矢',
  Bolts: '弩矢',
  Shield: '盾牌',
};

function templateLabel(key) {
  const bare = String(key).replace(/^CraftingTemplate_/, '');
  return TEMPLATE_LABEL[bare] || bare;
}

// 常见货物的中文名。地图上几百种物品，这里只覆盖玩家交易榜里高频出现的那批，
// 剩下的退回清洗后的英文 id —— 宁可显示 "pomegranate" 也别乱猜一个中文名。
const ITEM_ZH = {
  grain: '谷物',
  hardwood: '硬木',
  iron: '铁矿石',
  ironIngot1: '铁锭',
  grape: '葡萄',
  butter: '黄油',
  beer: '啤酒',
  fish: '鱼',
  date_fruit: '椰枣',
  olive: '橄榄',
  clay: '黏土',
  linen: '亚麻',
  wool: '羊毛',
  leather: '皮革',
  fur: '毛皮',
  salt: '盐',
  silver: '银矿石',
  silk: '丝绸',
  velvet: '天鹅绒',
  spice: '香料',
  honey: '蜂蜜',
  cheese: '奶酪',
  oil: '油',
  pottery: '陶器',
  tools: '工具',
  sumpter_horse: '驮马',
  mule: '骡子',
  old_horse: '老马',
  saddle_horse: '骑乘马',
  desert_horse: '沙漠马',
  steppe_horse: '草原马',
  war_horse: '战马',
};

function itemLabel(key) {
  const bare = String(key).replace(/^ItemObject_/, '').replace(/^CraftingPiece_/, '');
  if (ITEM_ZH[bare]) return ITEM_ZH[bare];
  return bare.replace(/_/g, ' ');
}

// 稳定的色相：同一个 players 名每次打开颜色一样，看着才像「这个人的头像」
function hueOf(text) {
  let h = 0;
  for (let i = 0; i < text.length; i++) h = (h * 31 + text.charCodeAt(i)) % 360;
  return h;
}

function initialsOf(name) {
  const s = String(name || '?').replace(/[^\p{L}\p{N}]/gu, '');
  if (!s) return '?';
  return s.slice(0, 2).toUpperCase();
}

// ————————————————————— 读存档配对文件 —————————————————————

function readSaveName() {
  try {
    const raw = fs.readFileSync(config.serverConfig, 'utf8');
    const cfg = parseJsonc(raw);
    const n = cfg && (cfg.saveName || cfg.SaveName);
    if (n && typeof n === 'string') return n.trim();
  } catch (_) {}
  return 'saveauto1';
}

// 找配对的 json：优先 <saveName>.json；找不到就取存档目录里最新的非 TransferSave 的 json。
function findCompanionJson() {
  const want = readSaveName() + '.json';
  const direct = path.join(config.savesDir, want);
  try {
    if (fs.existsSync(direct)) return direct;
  } catch (_) {}

  let best = null;
  try {
    for (const f of fs.readdirSync(config.savesDir)) {
      if (!/\.json$/i.test(f)) continue;
      if (/^TransferSave/i.test(f)) continue; // 转档文件，不代表当前世界
      const st = fs.statSync(path.join(config.savesDir, f));
      if (!best || st.mtimeMs > best.mtimeMs) best = { file: path.join(config.savesDir, f), mtimeMs: st.mtimeMs };
    }
  } catch (_) {}
  return best ? best.file : '';
}

// saveauto1.json 带 UTF-8 BOM，直接 JSON.parse 会炸在 "Unexpected token ''"。
// 这个坑踩过一次，别把 .replace 去掉。
function parseJsonFile(file) {
  const raw = fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '');
  return JSON.parse(raw);
}

let cache = { file: '', mtimeMs: 0, size: 0, parsed: null };

function loadCompanion() {
  const file = findCompanionJson();
  if (!file) return { file: '', error: '没找到与当前存档配对的 .json 文件' };

  let st;
  try { st = fs.statSync(file); } catch (e) { return { file, error: e.message }; }

  if (cache.file === file && cache.mtimeMs === st.mtimeMs && cache.size === st.size && cache.parsed) {
    return { file, mtimeMs: st.mtimeMs, data: cache.parsed };
  }
  try {
    const data = parseJsonFile(file);
    cache = { file, mtimeMs: st.mtimeMs, size: st.size, parsed: data };
    return { file, mtimeMs: st.mtimeMs, data };
  } catch (e) {
    return { file, error: '解析失败：' + e.message };
  }
}

// ————————————————————— 单项统计 —————————————————————

function sumValues(obj) {
  let t = 0;
  for (const k of Object.keys(obj || {})) t += Number(obj[k]) || 0;
  return t;
}

function countKeys(obj) {
  return Object.keys(obj || {}).length;
}

// 某玩家的「锻造」数据块
function buildCrafting(data, heroId) {
  const xpMap = (data.PlayerOpenNewPartXpDictionary || {})[heroId] || {};
  const partsMap = (data.PlayerOpenedPartsDictionary || {})[heroId] || {};
  const history = (data.PlayerCraftedItemsHistory || {})[heroId] || [];

  const templates = Object.keys(xpMap).map((k) => ({
    key: k,
    label: templateLabel(k),
    xp: Number(xpMap[k]) || 0,
  })).sort((a, b) => b.xp - a.xp);

  let unlockedParts = 0;
  for (const k of Object.keys(partsMap)) {
    const arr = partsMap[k];
    if (Array.isArray(arr)) unlockedParts += arr.length;
  }

  const crafted = Array.isArray(history) ? history : [];
  return {
    totalXp: Number(sumValues(xpMap).toFixed(1)),
    templates,
    unlockedParts,
    craftedItems: crafted.length,
    // 最近打造的东西：历史数组末尾那几条
    recentCrafted: crafted.slice(-5).reverse().map(itemLabel),
  };
}

// 交易：卖过/买过多少种东西、总量、榜上前几
function buildTrade(data, heroId) {
  const t = (data.PlayerItemsTradeData || {})[heroId] || {};
  const rows = Object.keys(t).map((k) => {
    const v = t[k] || {};
    return { key: k, label: itemLabel(k), units: Number(v.Item2) || 0, price: Number(v.Item1) || 0 };
  });
  const units = rows.reduce((s, r) => s + r.units, 0);
  return {
    kinds: rows.length,
    units,
    top: rows.sort((a, b) => b.units - a.units).slice(0, 5),
  };
}

function buildInventory(data, heroId) {
  const lock = (data.PlayerInventoryLocks || {})[heroId];
  return {
    locked: Array.isArray(lock) ? lock.length : 0,
    lockedSamples: Array.isArray(lock) ? lock.slice(0, 6).map(itemLabel) : [],
  };
}

function buildSocial(data, heroId) {
  const met = (data.PlayerLastMeetingTimes || {})[heroId] || {};
  const v = (data.PlayerInteractedVillagers || {})[heroId] || {};
  const c = (data.PlayerInteractedCaravans || {})[heroId] || {};
  const b = (data.PlayerInteractedBandits || {})[heroId] || {};
  const arenamasters = (data.PlayerMetArenaMasters || {})[heroId];
  const knowsTournament = (data.PlayerKnowTournaments || {})[heroId];
  return {
    metHeroes: countKeys(met),
    villagers: countKeys(v),
    caravans: countKeys(c),
    bandits: countKeys(b),
    arenaMasters: Array.isArray(arenamasters) ? arenamasters.length : 0,
    knowsTournament: !!knowsTournament,
  };
}

function buildCaravans(data, heroId) {
  const y = (data.PlayerWarehouseRosterPerSettlement || {})[heroId];
  let workshops = 0;
  if (Array.isArray(y)) {
    for (const e of y) if (e && e.Key) workshops++;
  }
  const prohibited = (data.PlayerProhibitedKingdomsForPlayerCaravans || {})[heroId];
  return {
    workshops,
    prohibitedKingdoms: Array.isArray(prohibited) ? prohibited.length : 0,
  };
}

// ————————————————————— 在线玩家：字段未知也能认人 —————————————————————

// @DS@ players 的每条记录字段名没验证过（空列表时看不到结构）。
// 这里把整条记录递归拍平成字符串集合，再用 platformName / controllerId / heroId
// 去比对 —— 无论它把这些叫 name / playerName / steamName / displayName，都能命中。
function flattenStrings(value, out, depth = 0) {
  if (depth > 4 || value === null || value === undefined) return out;
  if (typeof value === 'string' || typeof value === 'number') {
    out.push(String(value).toLowerCase());
    return out;
  }
  if (Array.isArray(value)) {
    for (const v of value) flattenStrings(v, out, depth + 1);
    return out;
  }
  if (typeof value === 'object') {
    for (const k of Object.keys(value)) flattenStrings(value[k], out, depth + 1);
  }
  return out;
}

function buildOnlineIndex(onlineList) {
  const idx = new Map(); // 小写 token → 原始记录
  for (const entry of onlineList || []) {
    const tokens = flattenStrings(entry, []);
    for (const t of tokens) if (t) idx.set(t, entry);
  }
  return idx;
}

// 在线记录里能拿到的只有「游戏内角色名」（例如 {"name":"某某领主","state":"on map"}），
// 而存档里只有 PlatformName（平台名）/ ControllerId / HeroId —— 两边没有共同字段。
// 角色名只有 playercards 导出的 detail.name 里有，所以匹配时必须把它也算进去，
// 否则人在游戏里跑图，页面永远显示离线（踩过）。
function findOnline(onlineIndex, player, detail) {
  const keys = [player.platformName, player.controllerId, player.heroId];
  if (detail) {
    if (detail.name) keys.push(detail.name);
    // 「某某领主's Party」这种队伍名去掉后缀也是同一个角色名，多一条冗余键不亏
    const pn = detail.party && detail.party.name;
    if (pn) keys.push(String(pn).replace(/['\u2019]s Party$/i, ''));
  }
  for (const k of keys) {
    if (!k) continue;
    const hit = onlineIndex.get(String(k).toLowerCase());
    if (hit) return hit;
  }
  return null;
}

// ————————————————————— 组装 —————————————————————

function buildProfiles(data, onlineList, cardIndex) {
  const players = Array.isArray(data.Players) ? data.Players : [];
  const onlineIndex = buildOnlineIndex(onlineList || []);

  return players
    .filter((p) => p && (p.HeroId || p.PlatformName))
    .map((p) => {
      const heroId = p.HeroId || '';
      const platformName = p.PlatformName || heroId || '未知玩家';
      const controllerId = String(p.ControllerId || '');

      const flat = Object.assign({}, data, {
        PlayerOpenNewPartXpDictionary: data.CraftingPlayerData && data.CraftingPlayerData.PlayerOpenNewPartXpDictionary,
        PlayerOpenedPartsDictionary: data.CraftingPlayerData && data.CraftingPlayerData.PlayerOpenedPartsDictionary,
        PlayerCraftedItemsHistory: data.CraftingPlayerData && data.CraftingPlayerData.PlayerCraftedItemsHistory,
        PlayerItemsTradeData: data.TradePlayerData && data.TradePlayerData.PlayerItemsTradeData,
        PlayerInventoryLocks: data.InventoryPlayerData && data.InventoryPlayerData.PlayerInventoryLocks,
        PlayerLastMeetingTimes: data.HeroMeetingData && data.HeroMeetingData.PlayerLastMeetingTimes,
        PlayerInteractedVillagers: data.InteractionsPlayerData && data.InteractionsPlayerData.PlayerInteractedVillagers,
        PlayerInteractedCaravans: data.InteractionsPlayerData && data.InteractionsPlayerData.PlayerInteractedCaravans,
        PlayerInteractedBandits: data.InteractionsPlayerData && data.InteractionsPlayerData.PlayerInteractedBandits,
        PlayerMetArenaMasters: data.InteractionsPlayerData && data.InteractionsPlayerData.PlayerMetArenaMasters,
        PlayerKnowTournaments: data.InteractionsPlayerData && data.InteractionsPlayerData.PlayerKnowTournaments,
        PlayerWarehouseRosterPerSettlement:
          data.WorkshopPlayerData && data.WorkshopPlayerData.PlayerWarehouseRosterPerSettlement,
        PlayerProhibitedKingdomsForPlayerCaravans:
          data.CaravansPlayerData && data.CaravansPlayerData.PlayerProhibitedKingdomsForPlayerCaravans,
        PlayerIsIllDays: data.AgingPlayerData && data.AgingPlayerData.PlayerIsIllDays,
      });

      const profile = {
        platformName,
        controllerId,
        heroId,
        clanId: p.ClanId || '',
        partyId: p.MobilePartyId || '',
        initials: initialsOf(platformName),
        hue: hueOf(platformName),
        steamUrl: /^\d{17}$/.test(controllerId)
          ? 'https://steamcommunity.com/profiles/' + controllerId
          : '',
        online: false,
        onlineRaw: null,
        illDays: (flat.PlayerIsIllDays || {})[heroId],
        crafting: buildCrafting(flat, heroId),
        trade: buildTrade(flat, heroId),
        inventory: buildInventory(flat, heroId),
        social: buildSocial(flat, heroId),
        economy: buildCaravans(flat, heroId),
      };

      // 详情（等级/金币/家族/装备/坐骑/部队/技能）来自模块实时导出，可能暂时没有。
      // 必须在 findOnline 之前算：在线记录只有角色名，而角色名就在 detail 里。
      profile.detail = playercards.lookup(cardIndex, profile);
      profile.hasDetail = !!profile.detail;

      const hit = findOnline(onlineIndex, profile, profile.detail);
      if (hit) {
        profile.online = true;
        profile.onlineRaw = hit;
      }
      return profile;
    })
    .sort((a, b) => {
      if (a.online !== b.online) return a.online ? -1 : 1;
      return b.crafting.totalXp - a.crafting.totalXp;
    });
}

// ————————————————————— 对外接口 —————————————————————

function snapshot({ onlineList = [], world = null } = {}) {
  const cards = playercards.snapshot();
  const loaded = loadCompanion();
  if (loaded.error) {
    return {
      ok: false,
      error: loaded.error,
      file: loaded.file || '',
      savesDir: config.savesDir,
      players: [],
      online: (onlineList || []).length,
      world,
      cards: cardsMeta(cards),
    };
  }

  const profiles = buildProfiles(loaded.data, onlineList, cards.index);
  const withDetail = profiles.filter((p) => p.hasDetail).length;

  // 哪些字段确实拿不到 —— 跟着模块有没有落盘动态变，别写死
  const missing = [];
  if (!withDetail) {
    missing.push('角色等级', '金币', '影响力', '部队人数', '装备与技能');
  }
  missing.push('领地');

  return {
    ok: true,
    file: loaded.file,
    saveId: loaded.data.UniqueGameId || '',
    updatedAt: loaded.mtimeMs || 0,
    ageMs: loaded.mtimeMs ? Date.now() - loaded.mtimeMs : 0,
    players: profiles,
    online: profiles.filter((p) => p.online).length,
    total: profiles.length,
    world,
    cards: cardsMeta(cards),
    missing,
    missingReason: withDetail
      ? '领地明细在存档压缩体里，没有官方读取接口；其余字段均由服务端 CoopPlayerCard 模块在' +
        '游戏进程内实时导出，每 15 秒刷新一次。'
      : '这些字段只存在于 saveauto1.sav 的压缩世界里，没有官方读取接口；' +
        '本面板只展示存档配对文件里真实记录的玩家数据，不拿估算值充数。',
  };
}

function cardsMeta(cards) {
  return {
    ok: !!cards.ok,
    file: cards.file || config.playercardsFile,
    error: cards.error || '',
    generatedAt: cards.generatedAt || '',
    ageMs: cards.ageMs || 0,
    count: cards.count || 0,
  };
}

module.exports = { snapshot, findCompanionJson, parseJsonFile, templateLabel, itemLabel, hueOf };
