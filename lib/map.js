'use strict';
// Calradia 地图数据：从游戏自带的 settlements.xml 解析城镇/城堡坐标，
// 给前端画「玩家实时位置」的地图用。
//
// 文件在 DedicatedServer\engine\Modules\SandBox\ModuleData\settlements.xml，
// 明文 XML（UTF-8 带 BOM），每个 Settlement 长这样：
//   <Settlement id="town_EN1" name="{=Settlements.Settlement.name.town_EN1}Epicrotia"
//               owner="..." posX="..." posY="..." culture="...">
// posX/posY 与游戏内世界坐标（也就是模块导出的 party.x/y）是**同一坐标系**，
// 所以玩家点和城镇点能直接叠在一张图上。
//
// 只取城镇 + 城堡（约 120 个）：村庄 330+ 个画在图上密得没法看，
// 而且找「最近地标」用城镇就够了。中文名用 lib/l10n 按字符串 id 查（全覆盖）。
const fs = require('fs');
const path = require('path');
const config = require('./config');
const l10n = require('./l10n');

const FILE = path.join(config.serverDir, 'engine', 'Modules', 'SandBox', 'ModuleData', 'settlements.xml');

// 真实底图（public/img/calradia.jpg，Map by Vesper「Calradia 1084」）的标定参数。
// 标定方法：图上 7 个城镇的圆心像素坐标 vs settlements.xml 场景坐标做最小二乘，
// 最大残差 6.5px（图宽 4000px 的 0.16%）。场景 y 轴向北，图片 y 轴向下，所以 sy 为负。
// 前端把 <image> 按 x=ox2/sx… 摆进场景坐标系即可与聚落点完美重合：
//   图片像素 (px,py) = (sx*场景x + ox,  sy*场景y + oy)
const BG = {
  file: 'img/calradia.jpg',
  width: 4000,
  height: 3200,
  sx: 4.7262, ox: 18.0,
  sy: -4.7332, oy: 3460.6,
  credit: 'Map by Vesper — Calradia 1084 (taleworlds 论坛)',
};

// 图片四角对应的场景坐标（给前端摆 <image> 用；top>bottom 正是因为 y 轴相反）
function bgSceneRect() {
  return {
    left: (0 - BG.ox) / BG.sx,
    right: (BG.width - BG.ox) / BG.sx,
    top: (0 - BG.oy) / BG.sy,      // 图片顶边（北）对应的场景 y
    bottom: (BG.height - BG.oy) / BG.sy, // 图片底边（南）
  };
}

// 按枚举顺序匹配属性，别用跨标签的 [\s\S]*? —— 那会吞进子元素的 name 属性，
// 上次就因此多匹配出几百条假记录
const RE = /<Settlement\s+id="([^"]+)"\s+name="\{=([^}]+)\}([^"]*)"\s+owner="[^"]*"\s+posX="(-?[\d.]+)"\s+posY="(-?[\d.]+)"/g;

let cache = { mtimeMs: 0, size: 0, data: null };

function load() {
  let st;
  try {
    st = fs.statSync(FILE);
  } catch (e) {
    return { ok: false, error: '找不到 ' + path.basename(FILE) + '（游戏文件被移动了？）', settlements: [] };
  }
  if (cache.data && cache.mtimeMs === st.mtimeMs && cache.size === st.size) return cache.data;

  let txt;
  try {
    txt = fs.readFileSync(FILE, 'utf8').replace(/^\uFEFF/, '');
  } catch (e) {
    return { ok: false, error: '读取失败：' + e.message, settlements: [] };
  }

  const out = [];
  let m;
  while ((m = RE.exec(txt)) !== null) {
    const id = m[1];
    const kind = id.indexOf('town_') === 0 ? 'town' : id.indexOf('castle_') === 0 ? 'castle' : 'village';
    if (kind === 'village') continue; // 图上只画城镇和城堡
    out.push({
      id,
      kind,
      nameId: m[2],
      // 中文名：查官方中文包，查不到就用英文原名（目前 493 条全覆盖，这里只是兜底）
      name: l10n.zh(m[2]) || m[3] || id,
      nameEn: m[3] || '',
      x: Number(m[4]),
      y: Number(m[5]),
    });
  }

  // 给前端算「最近城镇」用：按 id 排序保证输出稳定
  out.sort((a, b) => a.id.localeCompare(b.id));
  const data = {
    ok: out.length > 0,
    count: out.length,
    error: out.length ? '' : 'settlements.xml 里没解析出城镇（格式变了？）',
    settlements: out,
    // 顺手给出坐标范围，前端画 SVG 的 viewBox 直接用
    bounds: out.length
      ? {
          minX: Math.min(...out.map((s) => s.x)),
          maxX: Math.max(...out.map((s) => s.x)),
          minY: Math.min(...out.map((s) => s.y)),
          maxY: Math.max(...out.map((s) => s.y)),
        }
      : null,
    // 真实底图标定（没有时前端退回纯点阵画法）
    bg: out.length ? Object.assign(bgSceneRect(), BG) : null,
    generatedAt: new Date().toISOString(),
  };
  cache = { mtimeMs: st.mtimeMs, size: st.size, data };
  return data;
}

// 最近地标：给一个 (x, y)，返回直线距离最近的城镇/城堡。
// 地图上直线距离和游戏里走路的路径不一样，所以文案写「附近」而不是「距离」。
function nearest(x, y) {
  const d = load();
  if (!d.ok) return null;
  let best = null;
  let bestD2 = Infinity;
  for (const s of d.settlements) {
    const dx = s.x - x;
    const dy = s.y - y;
    const d2 = dx * dx + dy * dy;
    if (d2 < bestD2) { bestD2 = d2; best = s; }
  }
  if (!best) return null;
  return {
    name: best.name,
    nameEn: best.nameEn,
    kind: best.kind,
    // 保留 1 位小数就够辨认了
    distance: Math.round(Math.sqrt(bestD2) * 10) / 10,
  };
}

module.exports = { load, nearest };

// 直接跑：node lib/map.js  —— 看解析出多少城镇
if (require.main === module) {
  const d = load();
  console.log('城镇/城堡 :', d.count, '个');
  console.log('坐标范围  :', JSON.stringify(d.bounds));
  console.log('样例      :', d.settlements.slice(0, 3).map((s) => s.name + '(' + s.x + ',' + s.y + ')').join(' '));
  console.log('最近测试  :', JSON.stringify(nearest(600, 280)));
}
