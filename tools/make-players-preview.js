'use strict';
// 生成「玩家档案 + 玩家详情」的静态快照。
//
// 用途：不想开控制台也能看效果 / 发给朋友看 / 改完样式快速对比。
// 实现：借 tools/lib/fake-dom.js 把 public/app.js 的渲染函数真跑一遍，
//       再把产出的 HTML 连同 public/style.css 一起内联成单文件。
//       所以快照里的卡片、详情和真实页面是同一份代码画出来的，不是另写一份。
//
// 用法：node tools/make-players-preview.js [输出目录]
//   产出：preview/players-preview.html         名册
//         preview/players-detail-preview.html  第一个有详情的人
const fs = require('fs');
const path = require('path');
const http = require('http');
const { loadApp, PUBLIC_DIR } = require('./lib/fake-dom');
const playersLib = require('../lib/players');
const playercardsLib = require('../lib/playercards');
const mapLib = require('../lib/map');
const config = require('../lib/config');

const OUT_DIR = process.argv[2] || path.join(__dirname, '..', 'preview');
const OUT_LIST = path.join(OUT_DIR, 'players-preview.html');
const OUT_DETAIL = path.join(OUT_DIR, 'players-detail-preview.html');
const OUT_MAP = path.join(OUT_DIR, 'map-preview.html');

// 同时在跑的实例可能不止一个（7788 主实例、7790 只读镜像）。
// 老实例的 node 进程里还是旧代码，/api/players 里没有 detail ——
// 所以三个端口都问一遍，挑「带详情最多」的那份，而不是谁先响应就用谁。
const PROBE_PORTS = [7788, 7790, 7799];

function getJson(port, p) {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port, path: p, timeout: 1200 }, (res) => {
      let b = '';
      res.on('data', (c) => (b += c));
      res.on('end', () => {
        try { resolve(JSON.parse(b)); } catch (_) { resolve(null); }
      });
    });
    req.on('timeout', () => { req.destroy(); resolve(null); });
    req.on('error', () => resolve(null));
  });
}

// 控制台没开时，直接从最新日志里捞最后一条 pulse，世界状态条不至于空着
function lastPulseFromLogs() {
  let newest = '';
  let mtime = 0;
  try {
    for (const f of fs.readdirSync(config.dsLogsDir)) {
      if (!/\.log$/i.test(f)) continue;
      const st = fs.statSync(path.join(config.dsLogsDir, f));
      if (st.mtimeMs > mtime) { mtime = st.mtimeMs; newest = path.join(config.dsLogsDir, f); }
    }
  } catch (_) { return null; }
  if (!newest) return null;

  let tail = '';
  try {
    const st = fs.statSync(newest);
    const fd = fs.openSync(newest, 'r');
    const len = Math.min(st.size, 200000);
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, st.size - len);
    fs.closeSync(fd);
    tail = buf.toString('utf8');
  } catch (_) { return null; }

  const lines = tail.split(/\r?\n/).filter((l) => l.indexOf('pulse:') >= 0);
  if (!lines.length) return null;
  const m = lines[lines.length - 1].match(
    /pulse:\s*time=(.+?)\s+timeMode=(\w+)\s+players=(\d+)\s+parties=(\d+)\s+mapEvents=(\d+)\s+mainParty=(-?[\d.]+),(-?[\d.]+)/
  );
  if (!m) return null;
  return {
    date: m[1].trim(), timeMode: m[2], players: Number(m[3]),
    parties: Number(m[4]), mapEvents: Number(m[5]),
    mainParty: { x: Number(m[6]), y: Number(m[7]) }, at: mtime,
  };
}

const SNAP_CSS = `
/* —— 只属于快照的几条：把「静态」这件事说清楚，别让人以为按钮能点 —— */
.snap-flag {
  margin-left: 10px; padding: 3px 9px; border-radius: 999px;
  font-size: 11px; color: var(--warn);
  border: 1px solid rgba(232,180,81,.4); background: rgba(232,180,81,.1);
}
.snap-hint {
  margin: 0 0 14px; padding: 9px 14px;
  border: 1px dashed var(--line); border-radius: 8px;
  font-size: 12px; color: var(--text-faint); background: #10171f;
}
.snap-hint code { font-family: var(--mono); color: #8fd4ff; }
`;

function shell({ title, css, online, toolbar, body }) {
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${title} · 静态快照</title>
<style>
${css}
${SNAP_CSS}
</style>
</head>
<body>
<header>
  <div class="brand">
    <div class="brand-mark">BC</div>
    <div class="brand-text"><b>Bannerlord Coop</b><span>Dedicated Server Console</span></div>
  </div>
  <div class="pills">
    <span class="pill on"><i class="dot"></i><span>运行中</span></span>
    <span class="pill"><b>对外服务中</b></span>
    <span class="pill"><b>${online}</b> 在线</span>
    <span class="pill snap-flag">静态快照 · ${new Date().toLocaleString('zh-CN')}</span>
  </div>
  <div class="spacer"></div>
</header>

<nav class="tabs">
  <button>实时日志</button>
  <button>TUI 镜像</button>
  <button>玩家档案 <span class="badge">${online}</span></button>
  <button class="active">${title.includes('地图') ? '地图' : '玩家档案'} </button>
  <button>命令台</button>
  <button>存档备份</button>
  <button>更新日志</button>
  <button>配置</button>
</nav>

<main>
  <section class="tab active">
    <div class="toolbar">${toolbar}</div>
    <div id="players-scroll">
${body}
    </div>
  </section>
</main>
</body>
</html>`;
}

(async function main() {
  // 三个端口都问，挑带详情最多的那份
  const probed = await Promise.all(PROBE_PORTS.map((p) => getJson(p, '/api/players')));

  // 玩家列表**一律用本地库现算**，不直接用活实例的 payload。
  // 原因：老实例的 node 进程里还是旧代码（require 缓存），它给出的 detail 没有
  // nameId / firstNameId，物品和兵种会整片停留在英文 —— 快照就白拍了。
  // 本地库读的是同一份 playercards.json 和存档配对文件，代码永远是最新的。
  // 只有「世界时间 / 谁在线」这种纯运行时状态才需要问活着的实例。
  const live = probed.filter((d) => d && d.ok && Array.isArray(d.players))[0] || null;
  let world = (live && live.world) || null;
  if (!world) world = lastPulseFromLogs();
  const data = playersLib.snapshot({ onlineList: [], world });
  const fromLive = !!live;

  if (!data.ok) {
    console.error('读不到存档档案：' + data.error);
    process.exitCode = 1;
    return;
  }

  // 技能树是异步取 /api/perks 的：快照里也得把这份目录喂进去，
  // 否则详情页只会停在「技能树加载中」的降级态（等于没拍出技能树）。
  // 目录本身来自同一份 playercards.json，和 /api/players 的 detail 是同源的。
  const perks = playercardsLib.perkCatalog();
  const mapData = mapLib.load();
  const { sandbox, el } = loadApp({
    fetch: (url) => {
      const u = String(url);
      if (u.indexOf('/api/perks') >= 0) return perks;
      if (u.indexOf('/api/map') >= 0) return mapData;
      // 地图页的 renderMapTab 在 playersData 为空时会自己走 loadPlayers()：
      // 这里把本地现算的 data 注入回去，快照就不是空图了
      if (u.indexOf('/api/players') >= 0) return data;
      return null;
    },
  });
  const tick = () => new Promise((r) => setImmediate(r));
  // 位置地图的底图在 app 内部是异步缓存的：先拉到，名册卡片的位置行才有「附近地标」，
  // 后面的「地图」页快照也靠它
  await sandbox.loadMap();
  sandbox.renderRealmBar(world, data);
  sandbox.renderPlayerCards(data.players, world);
  sandbox.renderPlayersNote(data);

  const css = fs.readFileSync(path.join(PUBLIC_DIR, 'style.css'), 'utf8');
  const online = data.online || 0;
  const saveName = (data.file || '').split(/[\\/]/).pop();
  const stamp = data.updatedAt ? new Date(data.updatedAt).toLocaleString('zh-CN') : '—';

  const listHtml = shell({
    title: '玩家档案',
    css,
    online,
    toolbar:
      `<span class="label">存档：${saveName}</span>` +
      `<span class="label spacer">档案更新于 ${stamp}（${sandbox.fmtAgo(data.ageMs)}）</span>`,
    body:
      `      <div id="realm-bar">${el('#realm-bar').innerHTML}</div>\n` +
      `      <div id="player-grid">${el('#player-grid').innerHTML}</div>\n` +
      `      <div id="players-note">${el('#players-note').innerHTML}</div>`,
  });

  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(OUT_LIST, listHtml, 'utf8');

  // —— 详情快照：第一个能拿到 detail 的玩家 ——
  const withDetail = data.players.filter((p) => p.hasDetail);
  let detailOut = '';
  if (withDetail.length) {
    const target = withDetail[0];
    sandbox.renderPlayerDetail(target);
    // 技能树是异步的：第一次渲染只会停在「加载中」的降级态，
    // 等 /api/perks 落地后必须再画一次才能把树拍进去（和 test-detail-view 同一套时序）
    await tick();
    await tick();
    sandbox.renderPlayerDetail(target);
    await tick();
    const detailHtml = shell({
      title: '玩家详情 · ' + target.platformName,
      css,
      online,
      toolbar:
        `<span class="label">${target.platformName} 的详情</span>` +
        `<span class="label spacer">存档：${saveName} · 快照 ${stamp}</span>`,
      body:
        `      <p class="snap-hint">这是点开 <b>${target.platformName}</b> 卡片后看到的页面。` +
        `真实页面上点左上角「← 返回名册」、或者按 <code>Esc</code> 回到名册。</p>\n` +
        `      <div id="player-detail" class="open">${el('#player-detail').innerHTML}</div>`,
    });
    fs.writeFileSync(OUT_DETAIL, detailHtml, 'utf8');
    detailOut = OUT_DETAIL;
  }

  // —— 地图页快照：renderMapTab 在 playersData 为空时会自己走 loadPlayers（fetch 已注入本地现算数据）——
  let mapOut = '';
  if (mapData.ok) {
    await sandbox.renderMapTab();
    await tick();
    const mapHtml = shell({
      title: '地图',
      // 线上 #map-view 是 .tab 里的 flex:1 容器、svg 高 100%；快照页没有那个
      // 布局上下文，必须给个定高壳子，否则 .map-svg 的 height:100% 会塌成 0
      css: css + `
.snap-map { height: 720px; display: flex; flex-direction: column; min-height: 0; }
.snap-map #map-view { flex: 1 1 auto; min-height: 0; display: flex; flex-direction: column; padding: 0; }
.snap-map .map-wrap { flex: 1 1 auto; min-height: 0; }
.snap-map .map-svg { flex: 1 1 auto; min-height: 0; }
`,
      online,
      toolbar:
        `<span class="label">Calradia 实时态势 · 全部玩家位置</span>` +
        `<span class="label spacer">存档：${saveName} · 快照 ${stamp}</span>`,
      body:
        `      <p class="snap-hint">这是「地图」菜单的整屏画面：底图上的英文标注已全部抹除，` +
        `地名由页面用中文标注（悬停看中英文，城堡名放大后出现）；` +
        `彩色圆点是各位玩家的实时位置（在线亮色、离线灰色），悬停看坐标与兵力，点名字跳玩家档案。</p>\n` +
        `      <div class="snap-map"><div id="map-view">${el('#map-view').innerHTML}</div></div>`,
    });
    fs.writeFileSync(OUT_MAP, mapHtml, 'utf8');
    mapOut = OUT_MAP;
  }

  console.log('');
  console.log('  玩家档案静态快照已生成');
  console.log('  名册 : ' + OUT_LIST + '  (' + (Buffer.byteLength(listHtml) / 1024).toFixed(1) + ' KB)');
  if (detailOut) {
    console.log('  详情 : ' + detailOut + '  (' + (Buffer.byteLength(fs.readFileSync(detailOut, 'utf8')) / 1024).toFixed(1) + ' KB)');
  } else {
    console.log('  详情 : 跳过（还没有玩家带 detail 数据）');
  }
  if (mapOut) {
    console.log('  地图 : ' + mapOut + '  (' + (Buffer.byteLength(fs.readFileSync(mapOut, 'utf8')) / 1024).toFixed(1) + ' KB)');
  } else {
    console.log('  地图 : 跳过（settlements.xml 没解析出来）');
  }
  console.log('  玩家 : ' + data.players.length + ' 人（在线 ' + online + '，带详情 ' + withDetail.length + '）');
  console.log('  数据 : ' + (fromLive ? '本地现算（世界心跳取自运行中的控制台）' : '本地现算（没连上控制台）'));
  console.log('  技能 : ' + (perks.ok ? perks.skills.length + ' 个技能 / ' + perks.count + ' 个 perk 已注入' : '没拿到 perk 目录：' + perks.error));
  console.log('  世界 : ' + (world ? world.date + ' · ' + world.timeMode : '没拿到心跳'));
  console.log('');
})();
