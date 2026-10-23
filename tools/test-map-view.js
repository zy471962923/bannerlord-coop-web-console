'use strict';
// 「地图」菜单自测：独立标签页，一屏标出所有玩家位置。
//
// 和 test-detail-view 一个套路：假 DOM 里跑真实 app.js，fetch 注入
// /api/perks、/api/map 和 /api/players 的真实数据，检查 renderMapTab 画出来的 SVG。
//
// 用法：node tools/test-map-view.js
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

(async function main() {
  console.log('');
  console.log('  地图菜单渲染自测（假 DOM 里跑真实 app.js）');
  console.log('');

  const snap = playersLib.snapshot({ onlineList: [], world: null });
  if (!snap.ok) {
    console.error('  数据层没读出来：' + snap.error);
    process.exit(1);
  }
  const withPos = snap.players.filter((p) => p.detail && p.detail.party && p.detail.party.hasPosition);
  if (!withPos.length) {
    console.error('  没有玩家带坐标 —— CoopPlayerCard 模块还是旧版，先部署再跑');
    process.exit(1);
  }

  const perks = playercardsLib.perkCatalog();
  const mapData = mapLib.load();
  assert.ok(mapData.ok, 'settlements.xml 没解析出来：' + mapData.error);

  const { sandbox, el } = loadApp({
    fetch: (url) => {
      const u = String(url);
      if (u.indexOf('/api/perks') >= 0) return perks;
      if (u.indexOf('/api/map') >= 0) return mapData;
      if (u.indexOf('/api/players') >= 0) return snap;
      return null;
    },
  });
  const html = () => el('#map-view').innerHTML;

  // 拉底图 + 档案（renderMapTab 里 playersData 为空时会自己 loadPlayers）
  await sandbox.loadMap();
  await tick(); await tick();
  await sandbox.renderMapTab();
  await tick(); await tick();

  check('SVG 地图画出来了：底图城镇数量与 /api/map 一致', () => {
    const h = html();
    assert.ok(h.includes('map-svg'), '缺 SVG 地图');
    const circles = (h.match(/<circle cx="/g) || []).length;
    assert.ok(circles >= mapData.settlements.length, '城镇点数量不对：' + circles);
    // 城镇带中文名
    assert.ok(h.includes(mapData.settlements.find((s) => s.kind === 'town').name), '缺城镇名字');
  });

  check('所有带坐标的玩家都标在图上，一个不落', () => {
    const h = html();
    for (const p of withPos) {
      assert.ok(h.includes('data-map-name="' + p.platformName + '"'), '缺玩家标记 ' + p.platformName);
      assert.ok(h.includes(p.detail.party.x.toFixed(1) + ', ' + p.detail.party.y.toFixed(1)),
        p.platformName + ' 的坐标没出现在悬停提示里');
    }
    const marks = (h.match(/data-map-name=/g) || []).length;
    assert.strictEqual(marks, withPos.length, '玩家标记数不对：' + marks + ' != ' + withPos.length);
  });

  check('在线/离线玩家视觉上有区分（颜色饱和度不同 + 离线后缀）', () => {
    const h = html();
    const online = withPos.find((p) => p.online);
    const offline = withPos.find((p) => !p.online);
    if (online) assert.ok(h.includes('hsl(' + online.hue + ',62%,55%)'), '在线玩家的亮色标记不对');
    if (offline) {
      assert.ok(h.includes('hsl(' + offline.hue + ',25%,45%)'), '离线玩家的暗色标记不对');
      assert.ok(h.includes(offline.platformName + '（离线）'), '离线玩家没带（离线）后缀');
    }
  });

  check('悬停提示带坐标 / 附近地标 / 兵力', () => {
    const h = html();
    const p = withPos[0];
    const party = p.detail.party;
    assert.ok(h.includes('坐标 ' + party.x.toFixed(1) + ', ' + party.y.toFixed(1)), '缺坐标');
    assert.ok(h.includes('部队 ' + (party.manCount || 0) + ' 人'), '缺兵力');
    const near = sandbox.nearestSettlement(party.x, party.y);
    assert.ok(near && near.name, '最近地标没算出来');
  });

  check('图例齐全（城镇/城堡/在线/离线）', () => {
    const h = html();
    for (const t of ['城镇', '城堡', '在线玩家', '离线玩家', '点玩家名字去玩家档案']) {
      assert.ok(h.includes(t), '图例缺「' + t + '」');
    }
  });

  check('工具栏显示位置更新时间', () => {
    const upd = el('#map-updated');
    assert.ok(upd && /位置更新于/.test(upd.textContent || ''), '缺「位置更新于」时间戳');
  });

  check('真实底图已叠加（标定过的 calradia.jpg + 署名）', () => {
    const h = html();
    assert.ok(mapData.bg, '/api/map 应带 bg 标定参数');
    assert.ok(h.includes('<image href="img/calradia.jpg"'), '缺底图 <image>');
    // 底图尺寸换算：4000/4.7262 ≈ 846.3 场景单位宽
    assert.ok(h.includes('width="846.3"'), '底图宽度换算不对');
    assert.ok(h.includes('底图 Map by Vesper'), '图例缺底图署名');
  });

  check('中文地名标注：城镇常显、城堡分级的页面元素（不再用图上的英文）', () => {
    const h = html();
    const towns = mapData.settlements.filter((s) => s.kind === 'town');
    const castles = mapData.settlements.filter((s) => s.kind === 'castle');
    const lblTown = (h.match(/class="lbl-town"/g) || []).length;
    const lblCastle = (h.match(/class="lbl-castle"/g) || []).length;
    assert.strictEqual(lblTown, towns.length, '城镇中文标注数量不对: ' + lblTown);
    assert.strictEqual(lblCastle, castles.length, '城堡中文标注数量不对: ' + lblCastle);
    // 标注文本就是中文名（l10n 译文），悬停 title 带英文原名
    const t = towns[0];
    assert.ok(h.includes('>' + t.name + '</text>'), '标注文本不是中文: ' + t.name);
    assert.ok(h.includes(t.name + '（' + t.nameEn + '）'), '悬停提示缺英文原名');
  });

  check('y 轴翻转修正：北方城镇（Varcheg）画在南方城镇（Sanala）上面', () => {
    const h = html();
    const cy = (x) => {
      const m = h.match(new RegExp('cx="' + x + '[0-9]*" cy="(-?[\\d.]+)"'));
      return m ? Number(m[1]) : null;
    };
    const varcheg = cy('361.25'), sanala = cy('401.06');
    assert.ok(varcheg !== null && sanala !== null, '没找到两城的位置点');
    assert.ok(varcheg < sanala, '南北颠倒：Varcheg(' + varcheg + ') 应比 Sanala(' + sanala + ') 更靠上');
  });

  check('滚轮缩放：以锚点为中心缩小视野，且放大有下限', () => {
    sandbox.resetMapView();
    const v0 = sandbox.currentMapView();
    const after = sandbox.applyMapZoom(0.8, v0.x + v0.w / 2, v0.y + v0.h / 2);
    const w1 = Number(after.split(' ')[2]);
    assert.ok(w1 < v0.w && Math.abs(w1 - v0.w * 0.8) < 1, '缩放后视野宽不对: ' + w1);
    // 连续放大到下限，不能比全景的 1/12 更小
    let last = after;
    for (let i = 0; i < 40; i++) last = sandbox.applyMapZoom(0.8, v0.x + 10, v0.y + 10);
    const wMin = Number(last.split(' ')[2]);
    assert.ok(wMin >= v0.w / 12 - 1, '放大突破下限: ' + wMin);
    sandbox.resetMapView();
  });

  check('拖拽平移：视野随位移反向移动，复位后回全景', () => {
    sandbox.resetMapView();
    const v0 = sandbox.currentMapView();
    const after = sandbox.applyMapPan(50, 30);
    const p = after.split(' ').map(Number);
    assert.ok(Math.abs(p[0] - (v0.x - 50)) < 1 && Math.abs(p[1] - (v0.y - 30)) < 1,
      '平移量不对: ' + p[0] + ',' + p[1]);
    const back = sandbox.resetMapView();
    // resetMapView 返回 undefined 时直接比 currentMapView
    const v1 = sandbox.currentMapView();
    assert.ok(Math.abs(v1.x - v0.x) < 1 && Math.abs(v1.y - v0.y) < 1, '复位没回到全景');
  });

  check('默认视野完整包含整张底图（视图区变宽靠扩海，不裁底图）', () => {
    sandbox.resetMapView();
    const v = sandbox.currentMapView();
    const bg = mapData.bg;
    const K = mapData.bounds.minY + mapData.bounds.maxY;
    const imgTop = K - bg.top, imgBottom = K - bg.bottom;
    assert.ok(v.x <= bg.left + 1 && v.x + v.w >= bg.right - 1,
      '横向没盖住底图: [' + v.x.toFixed(1) + ',' + (v.x + v.w).toFixed(1) + '] vs [' + bg.left.toFixed(1) + ',' + bg.right.toFixed(1) + ']');
    assert.ok(v.y <= Math.min(imgTop, imgBottom) + 1 && v.y + v.h >= Math.max(imgTop, imgBottom) - 1,
      '纵向没盖住底图: [' + v.y.toFixed(1) + ',' + (v.y + v.h).toFixed(1) + ']');
  });

  // 说明：renderMapTab 的「底图加载失败」分支没法在这儿测 ——
  // app.js 顶层的 let mapData 在 vm 里不挂到 sandbox 上，测试侧改不到内部缓存。

  console.log('');
  if (fails.length) {
    console.log('  ' + pass + ' 项通过，' + fails.length + ' 项失败');
    for (const f of fails) console.log('    - ' + f);
    process.exitCode = 1;
  } else {
    console.log('  ' + pass + ' 项全部通过');
  }
})();
