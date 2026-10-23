'use strict';
/* Bannerlord Coop 服务器控制台 —— 前端逻辑
   传输：SSE 下行（结构化事件 / TUI 原始流），fetch 上行。没有 WebSocket，没有构建步骤。 */

const $ = (s) => document.querySelector(s);
const $$ = (s) => Array.from(document.querySelectorAll(s));

const state = {
  snap: null,
  logfile: '',
  commands: { builtin: [], game: [] },
  players: [],
  history: [],
  histIdx: -1,
  captureUntil: 0,
  version: '',
};

// ————————————————————— 小工具 —————————————————————

function toast(text, type = '', ms = 3600) {
  const el = document.createElement('div');
  el.className = 'toast ' + type;
  el.textContent = text;
  $('#toasts').appendChild(el);
  setTimeout(() => {
    el.style.transition = 'opacity .25s';
    el.style.opacity = '0';
    setTimeout(() => el.remove(), 260);
  }, ms);
}

let confirmResolve = null;
function confirmDialog(title, bodyHtml, okText = '确定', danger = true) {
  $('#dlg-title').textContent = title;
  $('#dlg-body').innerHTML = bodyHtml;
  $('#dlg-ok').textContent = okText;
  $('#dlg-ok').className = 'btn ' + (danger ? 'danger' : 'primary');
  $('#overlay').classList.add('show');
  return new Promise((resolve) => { confirmResolve = resolve; });
}
$('#dlg-cancel').onclick = () => { $('#overlay').classList.remove('show'); if (confirmResolve) confirmResolve(false); };
$('#dlg-ok').onclick = () => { $('#overlay').classList.remove('show'); if (confirmResolve) confirmResolve(true); };
$('#overlay').onclick = (e) => { if (e.target.id === 'overlay') $('#dlg-cancel').click(); };

async function api(path, opts = {}) {
  const res = await fetch(path, Object.assign({ headers: { 'Content-Type': 'application/json' } }, opts));
  let data = null;
  try { data = await res.json(); } catch (_) {}
  if (!res.ok) {
    const msg = (data && data.error) || ('HTTP ' + res.status);
    throw new Error(msg);
  }
  return data;
}

function fmtBytes(n) {
  if (!n) return '0 B';
  const u = ['B', 'KB', 'MB', 'GB'];
  let i = 0;
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
  return (i === 0 ? n : n.toFixed(1)) + ' ' + u[i];
}

function fmtDuration(ms) {
  if (!ms || ms < 0) return '—';
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h) return `${h}h ${String(m).padStart(2, '0')}m`;
  if (m) return `${m}m ${String(sec).padStart(2, '0')}s`;
  return sec + 's';
}

function esc(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// ————————————————————— 顶栏状态 —————————————————————

const PHASE_TEXT = { boot: '启动中', loading: '载入存档', serving: '对外服务中', stopped: '未运行' };

function renderStatus(snap) {
  state.snap = snap;
  const pillState = $('#pill-state');
  const running = snap.running || snap.external;
  const phase = snap.phase || '';

  if (snap.external) {
    pillState.className = 'pill err';
    pillState.innerHTML = '<i class="dot"></i><span>外部实例</span>';
  } else if (snap.state === 'stopping') {
    pillState.className = 'pill busy';
    pillState.innerHTML = '<i class="dot"></i><span>停止中</span>';
  } else if (snap.state === 'starting') {
    pillState.className = 'pill busy';
    pillState.innerHTML = '<i class="dot"></i><span>启动中</span>';
  } else if (running) {
    pillState.className = 'pill on';
    pillState.innerHTML = '<i class="dot"></i><span>运行中</span>';
  } else {
    pillState.className = 'pill off';
    pillState.innerHTML = '<i class="dot"></i><span>未运行</span>';
  }

  $('#pill-phase').innerHTML = '<b>' + (PHASE_TEXT[phase] || '—') + '</b>';
  $('#pill-players').innerHTML = '<b>' + (snap.players ? snap.players.length : 0) + '</b> 在线';
  $('#pill-uptime').innerHTML = '<b>' + (running ? fmtDuration(snap.uptimeMs) : '—') + '</b>';
  if (snap.version) {
    state.version = snap.version;
    $('#pill-version').innerHTML = '<b>v' + esc(snap.version) + '</b>';
  }

  $('#btn-start').disabled = !!running || snap.state === 'starting' || snap.state === 'stopping';
  $('#btn-stop').disabled = !snap.running || snap.state === 'stopping';
  $('#btn-kill').disabled = !running;

  renderPlayers(snap.players || []);
}

function renderPlayers(players) {
  state.players = players;
  const sel = $('#kick-player');
  if (!players.length) {
    sel.innerHTML = '<option value="">（暂无在线玩家）</option>';
    return;
  }
  sel.innerHTML = players.map((p) => {
    const name = p.name || p.playerName || p.steamName || p.id || JSON.stringify(p);
    return '<option value="' + esc(name) + '">' + esc(name) + '</option>';
  }).join('');
}

// ————————————————————— SSE —————————————————————

let es = null;
let esRetry = 0;

function connectEvents() {
  if (es) es.close();
  es = new EventSource('/api/events');

  es.addEventListener('hello', (e) => {
    const d = JSON.parse(e.data);
    renderStatus(d.state);
    if (d.logfile) { state.logfile = d.logfile; $('#log-file').textContent = d.logfile; }
    $('#log-view').innerHTML = '';
    if (d.lines && d.lines.length) appendLines(d.lines);
    esRetry = 0;
  });

  es.addEventListener('state', (e) => {
    const before = (state.snap && state.snap.players ? state.snap.players.length : 0);
    renderStatus(JSON.parse(e.data));
    const after = state.snap && state.snap.players ? state.snap.players.length : 0;
    // 有人进出服时，档案卡上的在线标记要跟着翻，不然得手动点刷新
    if (before !== after && $('#tab-players').classList.contains('active')) loadPlayers();
  });

  // 世界心跳（游戏内日期 / 时间流逝状态 / 全图部队数）
  es.addEventListener('world', (e) => {
    const w = JSON.parse(e.data);
    if (state.snap) state.snap.world = w;
    if ($('#tab-players').classList.contains('active')) renderRealmBar(w, playersData);
  });

  es.addEventListener('log', (e) => {
    const lines = JSON.parse(e.data);
    appendLines(lines);
    if (Date.now() < state.captureUntil) appendCmdOut(lines);
  });

  es.addEventListener('console', (e) => {
    const d = JSON.parse(e.data);
    appendCmdOut([{ time: d.time, msg: d.msg, level: 'console' }]);
  });

  es.addEventListener('logfile', (e) => {
    const d = JSON.parse(e.data);
    state.logfile = d.name;
    $('#log-file').textContent = d.name;
  });

  es.addEventListener('notice', (e) => {
    const d = JSON.parse(e.data);
    toast(d.text, d.type || '');
  });

  es.addEventListener('commands', (e) => {
    state.commands = JSON.parse(e.data);
    renderCommandChips();
  });

  es.onerror = () => {
    esRetry++;
    $('#log-file').textContent = '事件流断开，重连中…';
    es.close();
    setTimeout(connectEvents, Math.min(1000 * esRetry, 8000));
  };
}

// ————————————————————— 实时日志 —————————————————————

const MAX_LINES = 4000;

function appendLines(lines) {
  const view = $('#log-view');
  const frag = document.createDocumentFragment();
  const atBottom = view.scrollHeight - view.scrollTop - view.clientHeight < 60;

  for (const l of lines) {
    frag.appendChild(makeLineEl(l));
  }
  view.appendChild(frag);

  while (view.childElementCount > MAX_LINES) view.removeChild(view.firstElementChild);

  $('#log-count').textContent = view.childElementCount + ' 行';

  if ($('#log-follow').checked && atBottom) view.scrollTop = view.scrollHeight;
}

let filterTerms = [];
let filterLevel = 'all';
// 服务端每分钟重试 telemetry 上传失败，吐一坨 .NET 堆栈；后端已标成 noise，默认折叠
let hideEngine = true;

function passFilter(el) {
  const lv = el.dataset.lv;
  const txt = el.dataset.t;

  if (filterLevel === 'important' && !(lv === 'warn' || lv === 'error' || lv === 'ok')) return false;
  if (filterLevel === 'warn' && !(lv === 'warn' || lv === 'error')) return false;
  if (filterLevel === 'error' && lv !== 'error') return false;

  if (hideEngine && lv === 'noise') return false;

  for (const term of filterTerms) {
    if (term.startsWith('-')) {
      if (txt.includes(term.slice(1))) return false;
    } else if (!txt.includes(term)) {
      return false;
    }
  }
  return true;
}

function makeLineEl(l) {
  const el = document.createElement('div');
  el.className = 'logline lv-' + (l.level || 'info');
  el.dataset.t = (l.msg || '').toLowerCase();
  el.dataset.lv = l.level || 'info';

  const t = document.createElement('span');
  t.className = 't';
  t.textContent = l.time || '';
  const m = document.createElement('span');
  m.className = 'm';
  m.textContent = l.msg || '';
  el.appendChild(t);
  el.appendChild(m);

  el.style.display = passFilter(el) ? '' : 'none';
  return el;
}

function reapplyFilter() {
  const view = $('#log-view');
  let shown = 0;
  for (const el of view.children) {
    const ok = passFilter(el);
    el.style.display = ok ? '' : 'none';
    if (ok) shown++;
  }
  $('#log-count').textContent = shown + ' / ' + view.childElementCount;
}

let filterTimer = null;
$('#log-filter').addEventListener('input', () => {
  clearTimeout(filterTimer);
  filterTimer = setTimeout(() => {
    filterTerms = $('#log-filter').value.toLowerCase().split(/\s+/).filter(Boolean);
    reapplyFilter();
  }, 180);
});
$('#log-level').addEventListener('change', () => { filterLevel = $('#log-level').value; reapplyFilter(); });
$('#log-hide-engine').addEventListener('change', () => { hideEngine = $('#log-hide-engine').checked; reapplyFilter(); });
$('#log-clear').onclick = () => { $('#log-view').innerHTML = ''; $('#log-count').textContent = '0 行'; };
$('#log-download').onclick = () => {
  if (!state.logfile) return toast('还没有日志文件', 'warn');
  window.open('/api/logs/download?file=' + encodeURIComponent(state.logfile), '_blank');
};

// ————————————————————— TUI 镜像 —————————————————————

let term = null;
let tuiES = null;
let tuiPending = [];
let tuiRaf = null;
let lastTuiActivity = 0;

function ensureTerm() {
  if (term) return term;
  const cols = (state.snap && state.snap.ptyCols) || 160;
  const rows = (state.snap && state.snap.ptyRows) || 45;
  term = new Term($('#tui'), cols, rows);
  fitTui();
  return term;
}

function fitTui() {
  const wrap = $('#tui-wrap');
  const inner = $('#tui-inner');
  if (!term) return;
  if (!$('#tui-fit').checked) { inner.style.transform = ''; return; }

  // 用一个看不见的探针量出单元格宽度，再整体缩放
  const probe = document.createElement('span');
  probe.style.cssText = 'position:absolute;visibility:hidden;white-space:pre;font-family:var(--mono);font-size:13px';
  probe.textContent = 'M'.repeat(50);
  document.body.appendChild(probe);
  const cellW = probe.getBoundingClientRect().width / 50;
  probe.remove();

  const need = term.cols * cellW;
  const avail = wrap.clientWidth - 20;
  const scale = Math.min(1, avail / need);
  inner.style.transform = scale < 1 ? `scale(${scale})` : '';
}

$('#tui-fit').addEventListener('change', fitTui);
window.addEventListener('resize', () => { if (term) fitTui(); });

$('#tui-reset').onclick = () => { if (term) { term.reset(); term.flush(); } };

function connectTui() {
  if (tuiES) return;
  ensureTerm();
  tuiES = new EventSource('/api/tui');

  tuiES.addEventListener('seed', (e) => {
    if (!term) return;
    term.reset();
    feedTui(atob(e.data));
  });

  tuiES.addEventListener('tui', (e) => {
    feedTui(atob(e.data));
  });

  tuiES.onerror = () => {
    if (tuiES) { tuiES.close(); tuiES = null; }
    setTimeout(() => { if ($('#tab-tui').classList.contains('active')) connectTui(); }, 2000);
  };
}

function disconnectTui() {
  if (tuiES) { tuiES.close(); tuiES = null; }
}

function feedTui(b64OrText) {
  // base64 → UTF-8 字符串（需要处理多字节字符被切断的情况，用流式解码）
  let text;
  try {
    const bin = atob(b64OrText);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    text = tuiDecoder.decode(bytes, { stream: true });
  } catch (_) {
    text = b64OrText;
  }
  tuiPending.push(text);
  if (tuiRaf) return;
  tuiRaf = requestAnimationFrame(() => {
    tuiRaf = null;
    if (!term) return;
    let chunk = tuiPending.join('');
    tuiPending = [];
    // launcher 把非 ASCII 二次编码了，先修回来再画
    if (window.repairMojibake) chunk = repairMojibake(chunk);
    term.feed(chunk);
    term.flush();
  });
}

const tuiDecoder = new TextDecoder('utf-8');

// ————————————————————— 玩家档案 —————————————————————

// 数据边界写在前面，免得以后有人以为这里少写了等级/金币：
// 存档配对文件 saveauto1.json 只记录每个 hero 的锻造/交易/库存/社交数据，
// 等级、金币、影响力、部队人数都在 saveauto1.sav 的压缩世界里，没有官方读取接口。
// 所以卡片只展示文件里真有的数字，缺的字段在页脚如实说明，不拿 0 或估算值糊弄。

const TIMEMODE_TEXT = {
  Stop: '暂停',
  Pause: '暂停',
  Play: '正常',
  Play_1x: '1 倍速',
  Play_2x: '2 倍速',
  Play_4x: '4 倍速',
  FastForward: '快进',
};

function fmtNum(n) {
  const v = Number(n) || 0;
  if (Math.abs(v) >= 10000) return (v / 1000).toFixed(1) + 'k';
  return String(Math.round(v * 10) / 10);
}

function fmtAgo(ms) {
  if (!ms || ms < 0) return '—';
  const s = Math.floor(ms / 1000);
  if (s < 60) return s + ' 秒前';
  const m = Math.floor(s / 60);
  if (m < 60) return m + ' 分钟前';
  return Math.floor(m / 60) + ' 小时前';
}

let playersData = null;
let playersTimer = null;

function renderRealmBar(world, data) {
  const bar = $('#realm-bar');
  const w = world || {};
  const online = data && typeof data.online === 'number' ? data.online : 0;
  const total = data && typeof data.total === 'number' ? data.total : 0;

  const cell = (k, v, dim) => `<div class="rb-cell"><div class="rb-k">${k}</div>
    <div class="rb-v${dim ? ' dim' : ''}">${v}</div></div>`;

  bar.innerHTML =
    cell('游戏内时间', w.date ? esc(w.date) : '—', !w.date) +
    cell('时间流逝', w.timeMode ? (TIMEMODE_TEXT[w.timeMode] || esc(w.timeMode)) : '—', !w.timeMode) +
    cell('在线', '<b>' + online + '</b><span class="sep">/</span>' + total + ' 名玩家', false) +
    cell('全图部队', w.parties ? fmtNum(w.parties) : '—', !w.parties) +
    cell('地图事件', w.mapEvents !== undefined ? fmtNum(w.mapEvents) : '—', w.mapEvents === undefined) +
    cell('心跳', w.at ? fmtAgo(Date.now() - w.at) : '—', !w.at);
}

function renderPlayerCards(list, world) {
  const grid = $('#player-grid');
  if (!list || !list.length) {
    grid.innerHTML = '<div class="pw-empty">这份存档里还没有玩家档案。<br>' +
      '有人进服并完成一次自动存档后，这里就会出现他们的卡片。</div>';
    return;
  }

  // 卡片上的技能条按「该玩家自己的最高技能」归一 —— 和详情页 pdSkillsSection 的算法一致，
  // 这样卡片和下钻后的技能树看起来是同一套数
  grid.innerHTML = list.map((p) => {
    const hue = p.hue;
    // 技能（与详情页同一数据源 playercards.json）：取前 5 项，按熟练度降序。
    // 模块还没落盘时 detail 是空的，如实提示，不摆一个 0 冒充。
    const skills = (p.detail && p.detail.skills) || [];
    const maxSkill = Math.max(1, ...skills.map((s) => s.value));
    const bars = skills.slice(0, 5).map((s, i) => {
      const pct = Math.max(3, Math.round((s.value / maxSkill) * 100));
      return `<div class="pw-bar${i === 0 ? ' is-top' : ''}"><i style="width:${pct}%"></i>
        <em title="${esc(s.rawName)}">${esc(s.name)}</em><b>${fmtInt(s.value)}</b></div>`;
    }).join('') || '<div class="note">服务端跑起来并完成一次落盘后，这里会出现技能数据</div>';

    // 位置行：有坐标就给「坐标 + 附近地标」（地标要等 /api/map 到货，没到只显示坐标）
    const party = p.detail && p.detail.party;
    let posLine = '<div class="note">暂无位置数据</div>';
    if (party && party.hasPosition) {
      const near = nearestSettlement(party.x, party.y);
      const nearText = near ? ' · 附近 ' + esc(near.name) : '';
      posLine = `<div class="pw-pos">📍 <b>${party.x.toFixed(1)}, ${party.y.toFixed(1)}</b>${nearText}` +
        (party.inSettlement ? ' · 在 ' + esc(party.inSettlement) : '') + '</div>';
    }

    const tradeChips = p.trade.top.length
      ? p.trade.top.map((t) => `<span class="pw-chip">${esc(t.label)} <b>×${fmtNum(t.units)}</b></span>`).join('')
      : '<span class="pw-chip off">还没跑过商</span>';

    const sub = [
      p.detail && p.detail.clan.name
        ? esc(p.detail.clan.name) + (p.detail.clan.tier ? ' T' + p.detail.clan.tier : '')
        : (p.clanId ? '家族 ' + esc(p.clanId) : ''),
      p.controllerId ? (p.steamUrl
        ? `<a href="${esc(p.steamUrl)}" target="_blank" rel="noopener">${esc(p.controllerId)}</a>`
        : esc(p.controllerId)) : '',
    ].filter(Boolean).join(' · ');

    const lv = p.detail && p.detail.level
      ? `<span class="pw-lv">Lv ${p.detail.level}</span>`
      : '';

    return `<article class="pw-card${p.online ? ' is-online' : ''}" style="--hue:${hue}"
        data-hero="${esc(p.heroId || p.platformName)}" tabindex="0" role="button"
        aria-label="查看 ${esc(p.platformName)} 的详情">
      <div class="pw-top">
        <div class="pw-portrait">${esc(p.initials)}<i class="pw-dot"></i></div>
        <div class="pw-id">
          <div class="pw-name" title="${esc(p.platformName)}">${esc(p.platformName)}${lv}</div>
          <div class="pw-sub">${sub || '—'}</div>
        </div>
        <span class="pw-tag">${p.online ? '在线' : '离线'}</span>
      </div>

      <div class="pw-hero">
        <div class="pw-score"><b>${fmtNum(p.crafting.totalXp)}</b><span>锻造总熟练</span></div>
        <div class="pw-tiles">
          <div><b>${fmtNum(p.crafting.unlockedParts)}</b><span>解锁部件</span></div>
          <div><b>${fmtNum(p.crafting.craftedItems)}</b><span>亲手打造</span></div>
          <div><b>${fmtNum(p.social.metHeroes)}</b><span>见过人物</span></div>
        </div>
      </div>

      <div class="pw-sec">
        <h4>技能 <span class="pw-hint">与详情页技能树同源 · 点卡片看完整技能树</span></h4>
        ${bars}
      </div>

      <div class="pw-sec">
        <h4>当前位置 <span class="pw-hint">15 秒一刷</span></h4>
        ${posLine}
      </div>

      <div class="pw-sec">
        <h4>行商</h4>
        <div class="pw-chips">
          <span class="pw-chip">交易 <b>${fmtNum(p.trade.kinds)}</b> 种 · <b>${fmtNum(p.trade.units)}</b> 件</span>
          ${tradeChips}
        </div>
      </div>

      <div class="pw-sec">
        <h4>往来与家底</h4>
        <div class="pw-chips">
          <span class="pw-chip">村民 <b>${fmtNum(p.social.villagers)}</b></span>
          <span class="pw-chip">商队 <b>${fmtNum(p.social.caravans)}</b></span>
          <span class="pw-chip">剿匪 <b>${fmtNum(p.social.bandits)}</b></span>
          <span class="pw-chip">竞技场 <b>${fmtNum(p.social.arenaMasters)}</b></span>
          <span class="pw-chip ${p.social.knowsTournament ? 'ok' : 'off'}">竞技大会 ${p.social.knowsTournament ? '已开放' : '未开放'}</span>
          <span class="pw-chip">锁定物品 <b>${fmtNum(p.inventory.locked)}</b> 件</span>
          <span class="pw-chip">工坊 <b>${fmtNum(p.economy.workshops)}</b> 处</span>
        </div>
      </div>

      <div class="pw-foot">
        <span>${esc(p.heroId)}</span>
        <span class="spacer">${p.illDays >= 0 ? '病中 ' + p.illDays + ' 天' : ''}</span>
        <span class="pw-cta">查看详情 →</span>
      </div>
    </article>`;
  }).join('');
}

function renderPlayersNote(data) {
  const note = $('#players-note');
  if (!data) { note.innerHTML = ''; return; }

  if (!data.ok) {
    note.innerHTML = `<div class="pw-note"><b>读不到玩家档案</b><br>${esc(data.error || '未知原因')}<br>
      档案来自存档目录里的 <code>${esc(data.savesDir || '')}</code>，需要与 <code>.sav</code>
      同名的 <code>.json</code> 配对文件。</div>`;
    return;
  }

  const cards = data.cards || {};
  const cardState = cards.ok
    ? `<code>playercards.json</code>（每 15 秒一次快照${cards.generatedAt ? '，最近 ' + fmtAgo(cards.ageMs) : ''}）`
    : '未就绪 —— ' + esc(cards.error || '服务端还没落盘');

  note.innerHTML = `<div class="pw-note">
    <b>数据来自两块，别混着看：</b><br>
    ① 存档配对文件 <code>${esc((data.file || '').split(/[\\/]/).pop())}</code>
       —— 锻造 / 交易 / 社交 / 库存，服务端每次自动存档都会重写它，刷新节奏跟着存档走。<br>
    ② 服务端模块导出的实时快照 ${cardState}
       —— 等级 / 金币 / 家族 / 装备 / 坐骑 / 部队 / 技能加点。<br>
    点任意一张卡片可以进详情页，看装备、坐骑、部队编制与技能加点（不含家族成员）。<br><br>
    <b>确实拿不到的字段：</b>${esc((data.missing || []).join('、'))}<br>
    ${esc(data.missingReason || '')} —— 拿不到就留空，不拿估算值充数。
  </div>`;
}

// ————————————————————— 玩家详情 —————————————————————
//
// 点卡片进来，展示装备 / 坐骑 / 部队 / 技能加点。
// 数据来自服务端模块在游戏进程内导出的快照（每 15 秒），所以这里比卡片上的
// 「锻造/交易」那批数据更新 —— 后者跟着存档走。
// 明确不含家族成员：模块本身就没导出，这里也不去拼。

let detailHeroId = '';

function fmtInt(n) {
  const v = Math.round(Number(n) || 0);
  return v.toLocaleString('zh-CN');
}

// 物品修饰（"Loose " / "Cracked " 之类）单独做小字标签。
// 两种情况不显示：
//   1. 名字里本来就含这段原文（游戏会把修饰串进名字）
//   2. 名字是中文 —— 说明游戏已经把它揉进译名了（"Cracked" + "锻造了 双手长杆"
//      显示成「裂开的锻造了 双手长杆」），再贴个 Cracked 标签是重复信息
function pdModifier(item) {
  const m = String(item.modifier || '').trim();
  if (!m) return '';
  const name = String(item.name || '');
  if (name.toLowerCase().includes(m.toLowerCase())) return '';
  if (/[\u4e00-\u9fa5]/.test(name)) return '';
  return `<em>${esc(m)}</em>`;
}

function pdEquipmentRows(list, emptyText) {
  if (!list || !list.length) return `<div class="pd-empty">${emptyText}</div>`;
  return list.map((e) => {
    // 类型名和槽位名一样时（头盔/头盔、身甲/身甲）就别重复标了，省得右边一排同义词
    const typeBadge = e.typeLabel && e.typeLabel !== e.slotLabel
      ? `<span class="pd-type">${esc(e.typeLabel)}</span>`
      : '';
    return `<div class="pd-eq">
      <span class="pd-slot">${esc(e.slotLabel)}</span>
      <span class="pd-item" title="${esc(e.id)}">${esc(e.name)}${pdModifier(e)}</span>
      ${typeBadge}
    </div>`;
  }).join('');
}

// 坐骑和马具有自己的卡片（详见「坐骑」区），装备清单里就不再列一遍
function withoutMount(list) {
  return (list || []).filter((e) => e.key !== 'horse' && e.key !== 'harness');
}

function pdMount(mount) {
  if (!mount) {
    return '<div class="pd-empty">战斗装备里没有马。可能是徒步、或者马在物品栏里没骑上。</div>';
  }
  const harness = mount.harness
    ? `<div class="pd-mount-sub">马具 ${esc(mount.harness.name)}</div>`
    : '<div class="pd-mount-sub">没有配马具</div>';
  return `<div class="pd-mount">
      <div class="pd-mount-name">${esc(mount.name)}</div>
      <div class="pd-mount-tags">
        <span class="pd-chip">${esc(mount.typeLabel)}</span>
        ${mount.tier ? `<span class="pd-chip">T${mount.tier}</span>` : ''}
        ${pdModifier(mount) ? `<span class="pd-chip">${pdModifier(mount)}</span>` : ''}
      </div>
      ${harness}
    </div>`;
}

function pdParty(party) {
  if (!party) {
    return '<div class="pd-empty">这名英雄当前没有带队（可能被俘、在城里待命，或队伍已解散）。</div>';
  }

  const maxCount = Math.max(1, ...party.troops.map((t) => t.count));
  const mix = party.tiers.map((t) => {
    const pct = party.manCount ? Math.round((t.count / party.manCount) * 100) : 0;
    return `<span class="pd-mix-seg t${Math.min(t.tier, 6)}" style="width:${pct}%"
      title="${t.tier === 0 ? '英雄与同伴' : 'T' + t.tier} ×${t.count}"></span>`;
  }).join('');

  const rows = party.troops.map((t) => {
    const pct = Math.max(3, Math.round((t.count / maxCount) * 100));
    return `<div class="pd-troop">
        <span class="pd-tier${t.tier === 0 ? ' is-hero' : ' t' + Math.min(t.tier, 6)}">${t.tier === 0 ? '英' : 'T' + t.tier}</span>
        <span class="pd-troop-name" title="${esc(t.id)}">${esc(t.name)}</span>
        <span class="pd-troop-bar"><i style="width:${pct}%"></i></span>
        <b>${fmtInt(t.count)}</b>
        ${t.wounded ? `<span class="pd-wound">伤 ${t.wounded}</span>` : ''}
      </div>`;
  }).join('');

  return `<div class="pd-tiles">
      <div><b>${fmtInt(party.manCount)}</b><span>总兵力</span></div>
      <div><b>${fmtInt(party.troopKinds)}</b><span>兵种</span></div>
      <div><b>${fmtInt(party.wounded)}</b><span>伤员</span></div>
      <div><b>${fmtInt(party.prisoners)}</b><span>俘虏</span></div>
      <div><b>${(Math.round(party.morale * 10) / 10)}</b><span>士气</span></div>
    </div>
    <div class="pd-mix">${mix}</div>
    <div class="pd-mix-legend">
      <span>等级构成：</span>
      ${party.tiers.map((t) => `<span class="pd-mix-key t${Math.min(t.tier, 6)}">${t.tier === 0 ? '英雄' : 'T' + t.tier} ${t.count}</span>`).join('')}
    </div>
    <div class="pd-troops">${rows}</div>
    ${party.inSettlement ? `<div class="pd-fine">当前位于 ${esc(party.inSettlement)}</div>` : ''}`;
}

// ————————————————————— 技能与技能树 —————————————————————
//
// 左边列出全部技能（熟练度条 + 专注点 + 已学 perk 数），点谁就在右边画谁的技能树。
// 技能树按「需求熟练度」分档（25/50/75…），每档里的几个 perk 通常二选一。
// 已点亮的 perk 标金色勾，鼠标停上去弹说明。
//
// perk 目录不跟着玩家数据走（那是全服共用的一份），走 /api/perks 单独取一次。

let perksData = null;          // { ok, count, skills:[{id,name,count,tiers:[{req,perks:[]}]}] }
let perksIndex = new Map();    // perkId → perk（带所属技能名），给悬浮说明用
let perkSkillIds = new Set();  // 哪些技能有技能树
let perksLoading = false;
let detailSkill = '';          // 当前展开的技能
let detailProfile = null;      // 当前详情页对应的人（perk 异步到达后要重渲染）

function perksReady() {
  return !!(perksData && perksData.ok && perksData.skills && perksData.skills.length);
}

async function loadPerks() {
  if (perksLoading) return;
  perksLoading = true;
  try {
    const d = await api('/api/perks');
    perksData = d && d.ok === true ? d : { ok: false, error: (d && d.error) || '接口没返回数据', skills: [] };
  } catch (e) {
    perksData = { ok: false, error: e.message, skills: [] };
  } finally {
    perksLoading = false;
    perksIndex = new Map();
    perkSkillIds = new Set();
    if (perksReady()) {
      for (const s of perksData.skills) {
        perkSkillIds.add(s.id);
        for (const t of s.tiers) {
          for (const p of t.perks) {
            perksIndex.set(p.id, Object.assign({}, p, { skill: s.id, skillName: s.name }));
          }
        }
      }
    }
    // 目录晚到一步时，把已经打开的详情页重画一遍
    if (detailHeroId && detailProfile) renderPlayerDetail(detailProfile);
  }
}

function pdSkillDots(focus) {
  return Array.from({ length: 5 }, (_, i) => `<i class="${i < focus ? 'on' : ''}"></i>`).join('');
}

function skillLearned(cat, taken) {
  if (!cat) return 0;
  let n = 0;
  for (const t of cat.tiers) for (const p of t.perks) if (taken.has(p.id)) n++;
  return n;
}

function pdSkillButton(s, active, max, taken) {
  const pct = Math.max(3, Math.round((s.value / max) * 100));
  const cat = perksReady() ? perksData.skills.find((x) => x.id === s.id) : null;
  const right = cat ? `${skillLearned(cat, taken)}/${cat.count}` : '—';
  return `<button class="pd-sk${active ? ' is-active' : ''}${cat ? '' : ' is-nomap'}" data-skill="${esc(s.id)}"
      title="${esc(s.rawName || s.id)}">
      <span class="pd-sk-top"><em>${esc(s.name)}</em><b>${fmtInt(s.value)}</b></span>
      <span class="pd-sk-mid">
        <span class="pd-focus" title="专注 ${s.focus} 点">${pdSkillDots(s.focus)}</span>
        <span class="pd-sk-perks">${right}</span>
      </span>
      <span class="pd-sk-bar"><i style="width:${pct}%"></i></span>
    </button>`;
}

function pdSkillTree(d, skillId) {
  const skill = (d.skills || []).find((s) => s.id === skillId);
  const cat = perksReady() ? perksData.skills.find((s) => s.id === skillId) : null;
  if (!skill) return '<div class="pd-empty">这个技能没有熟练度记录，看在技能树也没意义。</div>';
  if (!cat) {
    return `<div class="pd-empty">「${esc(skill.name)}」没有导出技能树数据（模块目录里没有这个技能的 perk）。</div>`;
  }

  const taken = new Set(d.perks || []);
  const rows = cat.tiers.map((t) => {
    const locked = skill.value < t.req;
    const perks = t.perks.map((p) => {
      const on = taken.has(p.id);
      return `<button class="pd-perk${on ? ' is-on' : ''}" data-perk="${esc(p.id)}" data-taken="${on ? 1 : 0}">
          ${on ? '<i class="pd-perk-check">✓</i>' : ''}${esc(p.name)}
        </button>`;
    }).join('');
    return `<div class="pd-tier-row${locked ? ' is-locked' : ''}">
        <span class="pd-tier-lv" title="需要熟练度 ${t.req}">${t.req}</span>
        <div class="pd-tier-perks">${perks}</div>
      </div>`;
  }).join('');

  return `<div class="pd-tree-head">
      <b>${esc(skill.name)}</b>
      <span class="pd-tree-val">熟练度 ${fmtInt(skill.value)}</span>
      <span class="pd-tree-learned">已学 ${skillLearned(cat, taken)} / ${cat.count}</span>
    </div>
    <div class="pd-tree-rows">${rows}</div>
    <div class="pd-tree-foot">灰色档位是熟练度还不够的。鼠标停在 perk 上看具体效果。</div>`;
}

// 默认展开哪个技能：优先上次选的，否则挑熟练度最高且确实有技能树的那一项
function pickDetailSkill(d) {
  const skills = d.skills || [];
  if (detailSkill && perkSkillIds.has(detailSkill)) return detailSkill;
  const hit = skills.find((s) => perkSkillIds.has(s.id));
  return hit ? hit.id : (skills[0] ? skills[0].id : '');
}

// 说明（防再混淆，虽然界面上不显示专精了）：
// 技能「长杆」和打铁的「双手长杆」是两套系统 —— 技能是角色战斗等级（playercards.json），
// 专精是打造武器攒的熟练度（存档 CraftingPlayerData）。用户已要求页面上不展示专精，
// 卡片和详情页统一只显示技能；两者数值无关的完整解释在 README 第十节。
function pdSkillsSection(d) {
  const skills = d.skills || [];
  if (!skills.length) return '<div class="pd-empty">还没有可读的技能数据。</div>';

  const attrHtml = (d.attributes && d.attributes.length)
    ? `<div class="pd-attrs">${d.attributes.map((a) =>
        `<span class="pd-attr"><b>${a.value}</b>${esc(a.name)}</span>`).join('')}</div>`
    : '';

  const taken = new Set(d.perks || []);
  const max = Math.max(1, ...skills.map((s) => s.value));

  // perk 目录还没到：先把技能条画出来，别让整块空着，同时去取目录
  if (!perksReady()) {
    loadPerks();
    const rows = skills.map((s) => {
      const pct = Math.max(3, Math.round((s.value / max) * 100));
      return `<div class="pd-skill">
          <div class="pd-skill-top">
            <em title="${esc(s.rawName)}">${esc(s.name)}</em>
            <span class="pd-focus">${pdSkillDots(s.focus)}</span>
            <b>${fmtInt(s.value)}</b>
          </div>
          <div class="pd-skill-bar"><i style="width:${pct}%"></i></div>
        </div>`;
    }).join('');
    const why = (perksData && perksData.error) ? '技能树读取失败：' + perksData.error : '技能树加载中…';
    return `<div class="pd-skill-note">${esc(why)}</div>
      ${attrHtml}
      <div class="pd-skills">${rows}</div>`;
  }

  const active = pickDetailSkill(d);
  const list = skills.map((s) => pdSkillButton(s, s.id === active, max, taken)).join('');

  return `<div class="pd-skill-note">
      左边点技能，右边就是它的技能树。金色 = 已经点亮，灰色档位 = 熟练度还不够。
    </div>
    ${attrHtml}
    <div class="pd-tree-wrap">
      <div class="pd-skill-list" id="pd-skill-list">${list}</div>
      <div class="pd-tree" id="pd-tree">${pdSkillTree(d, active)}</div>
    </div>`;
}

function selectDetailSkill(skillId) {
  const d = detailProfile && detailProfile.detail;
  if (!d || !skillId) return;
  detailSkill = skillId;

  const btns = $$('#pd-skill-list [data-skill]');
  for (const b of btns) b.classList.toggle('is-active', b.dataset && b.dataset.skill === skillId);

  const tree = $('#pd-tree');
  if (tree) tree.innerHTML = pdSkillTree(d, skillId);
  hidePerkTip();
}

// ————————————————————— perk 悬浮说明 —————————————————————

function showPerkTip(el, ev) {
  const tip = $('#pd-tip');
  if (!tip || !el) return;

  const id = (el.dataset && el.dataset.perk) || '';
  const p = perksIndex.get(id);
  if (!p) return;

  const taken = el.dataset && el.dataset.taken === '1';
  const skill = (detailProfile && detailProfile.detail
    && (detailProfile.detail.skills || []).find((s) => s.id === p.skill)) || null;
  const cur = skill ? skill.value : 0;

  let state;
  if (taken) state = '<span class="pd-tip-ok">已点亮</span>';
  else if (cur >= p.req) state = '<span class="pd-tip-ready">可以点（熟练度已达标）</span>';
  else state = `<span class="pd-tip-lock">还差 ${p.req - cur} 点熟练度</span>`;

  tip.innerHTML = `<div class="pd-tip-head">
      <b>${esc(p.name)}</b>
      <span class="pd-tip-req">${esc(p.skillName || p.skill)} ${p.req}</span>
    </div>
    <div class="pd-tip-desc">${esc(p.desc || '（这一版没有导出说明文本）')}</div>
    <div class="pd-tip-state">${state}</div>`;

  tip.hidden = false;
  tip.classList.add('show');

  // 跟着鼠标走，同时别顶出窗口
  const x = ev && typeof ev.clientX === 'number' ? ev.clientX : 0;
  const y = ev && typeof ev.clientY === 'number' ? ev.clientY : 0;
  const vw = (window && window.innerWidth) || 1280;
  const vh = (window && window.innerHeight) || 800;
  tip.style.left = Math.max(8, Math.min(x + 16, vw - 340)) + 'px';
  tip.style.top = Math.max(8, Math.min(y + 16, vh - 200)) + 'px';
}

function hidePerkTip() {
  const tip = $('#pd-tip');
  if (!tip) return;
  tip.classList.remove('show');
  tip.hidden = true;
}


// ————————————————————— Calradia 地图页 —————————————————————

// 城镇/城堡坐标来自 /api/map（settlements.xml，与模块导出的 party.x/y 同一坐标系）。
// 加载一次就缓存；地图页和名册卡片的「附近地标」共用。
let mapData = null;

async function loadMap() {
  if (mapData && mapData.ok) return mapData;
  try {
    mapData = await api('/api/map');
  } catch (e) {
    mapData = { ok: false, error: e.message, settlements: [] };
  }
  // 地图是异步到的：到了之后把名册卡片上的位置行补全（附近地标那半截）
  if (mapData.ok && $('#tab-players').classList.contains('active') && playersData) {
    renderPlayerCards(playersData.players || [], (state.snap && state.snap.world) || playersData.world);
  }
  return mapData;
}

// 直线距离最近的地标。游戏里走路是绕路的，所以文案说「附近」不说「距离」
function nearestSettlement(x, y) {
  if (!mapData || !mapData.ok) return null;
  let best = null;
  let bestD2 = Infinity;
  for (const s of mapData.settlements) {
    const dx = s.x - x, dy = s.y - y;
    const d2 = dx * dx + dy * dy;
    if (d2 < bestD2) { bestD2 = d2; best = s; }
  }
  return best ? { name: best.name, kind: best.kind, distance: Math.round(Math.sqrt(bestD2) * 10) / 10 } : null;
}

// 独立的「地图」菜单：一屏标出所有玩家的实时位置，带真实底图（可缩放/拖动）。
// 数据每 15 秒随 playercards.json 刷新，本页 30 秒轮询一次（切走就停）。
let mapTimer = null;

function stopMapTimer() {
  if (mapTimer) { clearInterval(mapTimer); mapTimer = null; }
}

// 场景 y 轴向北递增，SVG 的 y 轴向下 —— 所有 y 都要翻转，否则地图南北颠倒。
// 翻转在 [minY, maxY] 区间内做镜射，viewBox 的 y 范围不用变。
function mapFlipK() {
  const b = mapData && mapData.bounds;
  return b ? b.minY + b.maxY : 0;
}

// 默认视野：有真实底图时以底图为准（看得到完整岛屿），否则退回聚落范围。
// 视图区的宽高比通常和底图不一样（底图 5:4，屏幕多半 16:9），这时**把短边扩出去**
// ——多出来的部分是海面同色（见 rect 的 fill），看上去就是一片海，
// 而不是把底图缩到中间留两条空边。
function mapDefaultView() {
  const b = mapData.bounds;
  const bg = mapData.bg;
  const pad = 10;
  let x0, x1, y0, y1;
  if (bg) {
    // 底图四角的场景坐标（bg.top > bg.bottom，因为 y 轴相反）
    x0 = bg.left; x1 = bg.right;
    y0 = mapFlipK() - bg.top; y1 = mapFlipK() - bg.bottom;
  } else {
    x0 = b.minX; x1 = b.maxX; y0 = b.minY; y1 = b.maxY;
  }
  let w = Math.abs(x1 - x0) + pad * 2;
  let h = Math.abs(y1 - y0) + pad * 2;
  const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;
  const ar = mapViewAR || (w / h);
  if (w / h < ar) w = h * ar; else h = w / ar;
  return { x: cx - w / 2, y: cy - h / 2, w, h };
}

// 视图状态（缩放/平移），30 秒自动重渲染后依然保留；null = 默认全景
let mapView = null;
let mapViewAR = null; // 视口宽高比，取自默认视图，缩放时保持不变

function currentMapView() {
  const def = mapDefaultView();
  if (!mapViewAR) mapViewAR = def.w / def.h;
  if (!mapView) return def;
  return { x: mapView.x, y: mapView.y, w: mapView.w, h: mapView.w / mapViewAR };
}

const MAP_ZOOM_MIN = 12; // 最多放大到全景的 1/12

function clampMapView(v) {
  const def = mapDefaultView();
  const w = Math.min(def.w, Math.max(def.w / MAP_ZOOM_MIN, v.w));
  const h = w / mapViewAR;
  // 中心不许跑出底图（或聚落范围）外一圈，防止把地图拖丢
  const cx = Math.min(def.x + def.w, Math.max(def.x, v.x + w / 2));
  const cy = Math.min(def.y + def.h, Math.max(def.y, v.y + h / 2));
  return { x: cx - w / 2, y: cy - h / 2, w, h };
}

function writeMapSvgViewBox(svg) {
  const v = currentMapView();
  const s = `${v.x} ${v.y} ${v.w} ${v.h}`;
  if (svg && typeof svg.setAttribute === 'function') {
    svg.setAttribute('viewBox', s);
    // 缩放分级：全景时藏城堡标注（太密），放大后出现。CSS 按 data-zoom 显隐
    const def = mapDefaultView();
    svg.setAttribute('data-zoom', v.w > def.w * 0.5 ? 'far' : 'near');
  }
  return s;
}

// 滚轮缩放：factor<1 放大、>1 缩小，锚点 (ax,ay) 是 viewBox 坐标下的鼠标位置
function applyMapZoom(factor, ax, ay) {
  const v = currentMapView();
  const nw = Math.min(v.w * factor, mapDefaultView().w);
  const k = nw / v.w;
  mapView = clampMapView({ x: ax - (ax - v.x) * k, y: ay - (ay - v.y) * k, w: nw });
  return writeMapSvgViewBox(document.querySelector && document.querySelector('#map-view svg'));
}

// 拖拽平移：dx/dy 是 viewBox 坐标下的位移（拖内容 = 视野反向移动）
function applyMapPan(dx, dy) {
  const v = currentMapView();
  mapView = clampMapView({ x: v.x - dx, y: v.y - dy, w: v.w });
  return writeMapSvgViewBox(document.querySelector && document.querySelector('#map-view svg'));
}

function resetMapView() {
  mapView = null;
  const host = $('#map-view');
  const svg = host && host.querySelector ? host.querySelector('svg') : null;
  writeMapSvgViewBox(svg);
}

async function renderMapTab() {
  const host = $('#map-view');
  if (!host) return;

  await Promise.all([loadMap(), playersData ? Promise.resolve() : loadPlayers()]);

  const upd = $('#map-updated');
  if (upd) {
    upd.textContent = playersData && playersData.updatedAt
      ? '位置更新于 ' + new Date(playersData.updatedAt).toLocaleString('zh-CN')
        + '（' + fmtAgo(Date.now() - new Date(playersData.updatedAt).getTime()) + '）'
      : '';
  }

  const players = (playersData && playersData.players || []).filter(
    (p) => p.detail && p.detail.party && p.detail.party.hasPosition
  );

  if (!mapData.ok) {
    host.innerHTML = '<div class="pw-note"><b>地图底图没加载出来</b><br>'
      + esc(mapData.error || '未知原因') + '</div>';
    return;
  }

  const K = mapFlipK();

  // 底图：真实 Calradia 地图（已按 7 个城镇圆心标定，与场景坐标重合）；
  // 没有底图数据时退回「城镇点 + 名字」的纯点阵画法
  let under = '';
  let dots = '';
  if (mapData.bg) {
    const bg = mapData.bg;
    // 图片顶边在场景 y = bg.top（北），翻转后放在 K-bg.top（屏幕上方）
    under = `<image href="${bg.file}" x="${bg.left}" y="${(K - bg.top).toFixed(1)}"
        width="${(bg.width / bg.sx).toFixed(1)}" height="${(bg.height / -bg.sy).toFixed(1)}"
        preserveAspectRatio="none"/>`;
  }
  const dots2 = mapData.settlements.map((s) => {
    const isTown = s.kind === 'town';
    return `<circle cx="${s.x}" cy="${K - s.y}" r="${isTown ? 3.2 : 2.1}"
        fill="${isTown ? '#ffd9a0' : '#d8c9a8'}" fill-opacity=".85"
        stroke="#1a1408" stroke-width=".6"><title>${esc(s.name)}${s.nameEn ? '（' + esc(s.nameEn) + '）' : ''} · ${isTown ? '城镇' : '城堡'}</title></circle>`;
  }).join('');

  // 中文地名标注：底图上的英文已经全部抹掉，地名由页面自己标。
  // 城镇常显，城堡放大后才出现（data-zoom 分级，CSS 控制显隐）。
  const labels = mapData.settlements.map((s) => {
    const isTown = s.kind === 'town';
    return `<text class="${isTown ? 'lbl-town' : 'lbl-castle'}" x="${s.x}" y="${K - s.y + (isTown ? 8.2 : 6.8)}"
        font-size="${isTown ? 5.2 : 4.4}" text-anchor="middle" fill="#ffedc9"
        stroke="#10151b" stroke-width="1.7" paint-order="stroke"><title>${esc(s.name)}${s.nameEn ? '（' + esc(s.nameEn) + '）' : ''}</title>${esc(s.name)}</text>`;
  }).join('');
  dots = under + dots2 + labels;

  // 玩家标记：颜色跟卡片同一套 hue（直接算 hsl，SVG 属性里用着比 CSS 变量稳），
  // 在线的高亮 + 名牌，离线的降饱和。悬停看坐标/兵力/附近地标，点名字跳玩家档案。
  const marks = players.map((p) => {
    const party = p.detail.party;
    const hue = p.hue || 220;
    const color = p.online ? `hsl(${hue},62%,55%)` : `hsl(${hue},25%,45%)`;
    const near = nearestSettlement(party.x, party.y);
    const tip = [p.platformName,
      '坐标 ' + party.x.toFixed(1) + ', ' + party.y.toFixed(1),
      near ? '附近 ' + near.name : '',
      party.inSettlement ? '在 ' + party.inSettlement : '野外行军',
      '部队 ' + (party.manCount || 0) + ' 人',
      p.online ? '在线' : '离线',
    ].filter(Boolean).join('\n');
    return `<g>
        <circle cx="${party.x}" cy="${K - party.y}" r="10" fill="none" stroke="${color}" stroke-opacity=".4" stroke-width="1.5"/>
        <circle cx="${party.x}" cy="${K - party.y}" r="4.5" fill="${color}"
          stroke="#10151b" stroke-width="1"><title>${esc(tip)}</title></circle>
        <text x="${party.x + 8}" y="${K - party.y - 6}" font-size="10.5" font-weight="600" data-map-name="${esc(p.platformName)}"
          fill="#ffffff" stroke="#10151b" stroke-width="2.2" paint-order="stroke">${esc(p.platformName)}${p.online ? '' : '（离线）'}</text>
      </g>`;
  }).join('');

  const legend = `<div class="map-legend">
      <span><i style="background:#ffd9a0"></i>城镇</span>
      <span><i style="background:#d8c9a8"></i>城堡</span>
      <span><i class="dot-on"></i>在线玩家</span>
      <span><i class="dot-off"></i>离线玩家</span>
      <span class="map-legend-note">滚轮缩放 · 拖动平移 · 双击复位 · 悬停看地名 · 点玩家名字去玩家档案${mapData.bg ? ' · 底图 ' + esc(mapData.bg.credit || '') : ''}</span>
    </div>`;

  const vb = currentMapView();
  host.innerHTML = `<div class="map-wrap">
      <svg class="map-svg" viewBox="${vb.x} ${vb.y} ${vb.w} ${vb.h}" role="img" aria-label="Calradia 玩家位置图"
        preserveAspectRatio="xMidYMid meet">
        <rect x="${vb.x}" y="${vb.y}" width="${vb.w}" height="${vb.h}" fill="#1d384f"/>
        ${dots}
        ${marks}
      </svg>
      ${legend}
    </div>`;

  syncMapAspect();   // 量出真实视图区比例，把 viewBox 调成一致（否则两侧留空）
  bindMapSvgEvents();
  bindMapNameClicks(players);
}

// 视图区的实际宽高比和底图不一样（5:4 vs 16:9）。svg 按 100% 填满容器后，
// 把 viewBox 比例对齐容器比例，多出来的方向就是「海」（rect 填了海面同色），
// 这样地图铺满整个视图区，不会在中间缩成一块。
function syncMapAspect() {
  const host = $('#map-view');
  if (!host || !host.querySelector) return null;
  const svg = host.querySelector('svg');
  if (!svg || typeof svg.getBoundingClientRect !== 'function') return null; // 假 DOM 里量不到
  const r = svg.getBoundingClientRect();
  if (!r || !r.width || !r.height) return null;
  const ar = r.width / r.height;
  if (!isFinite(ar) || ar <= 0) return null;
  mapViewAR = ar;
  writeMapSvgViewBox(svg);
  return ar;
}

if (typeof window !== 'undefined' && window.addEventListener) {
  let mapResizeTimer = null;
  window.addEventListener('resize', () => {
    if (mapResizeTimer) clearTimeout(mapResizeTimer);
    mapResizeTimer = setTimeout(() => {
      if (mapData && mapData.ok && $('#tab-map') && $('#tab-map').classList.contains('active')) syncMapAspect();
    }, 150);
  });
}

// 缩放/拖动事件绑在 svg 上。每次重渲染都会重建 svg，所以每次都要重绑；
// 视野状态存模块级 mapView，重渲染不丢。
function bindMapSvgEvents() {
  const host = $('#map-view');
  if (!host || !host.querySelector) return;
  const svg = host.querySelector('svg');
  if (!svg || typeof svg.addEventListener !== 'function') return;

  svg.addEventListener('wheel', (ev) => {
    if (ev.preventDefault) ev.preventDefault();
    const r = typeof svg.getBoundingClientRect === 'function' ? svg.getBoundingClientRect() : null;
    const v = currentMapView();
    let ax = v.x + v.w / 2, ay = v.y + v.h / 2;
    if (r && r.width) {
      ax = v.x + ((ev.clientX || 0) - r.left) / r.width * v.w;
      ay = v.y + ((ev.clientY || 0) - r.top) / r.height * v.h;
    }
    const factor = (ev.deltaY || 0) > 0 ? 1.25 : 0.8;
    applyMapZoom(factor, ax, ay);
  });

  let dragging = null;
  svg.addEventListener('mousedown', (ev) => {
    dragging = { cx: ev.clientX, cy: ev.clientY };
    if (svg.style && typeof svg.style === 'object') svg.style.cursor = 'grabbing';
  });
  svg.addEventListener('mousemove', (ev) => {
    if (!dragging) return;
    const r = typeof svg.getBoundingClientRect === 'function' ? svg.getBoundingClientRect() : null;
    if (!r || !r.width) return;
    const v = currentMapView();
    // 抓取语义：内容跟着鼠标走 —— 鼠标右移 dx，视野就要往左挪 dx
    applyMapPan((ev.clientX - dragging.cx) * v.w / r.width,
      (ev.clientY - dragging.cy) * v.h / r.height);
    dragging = { cx: ev.clientX, cy: ev.clientY };
  });
  const endDrag = () => {
    dragging = null;
    if (svg.style && typeof svg.style === 'object') svg.style.cursor = 'grab';
  };
  svg.addEventListener('mouseup', endDrag);
  svg.addEventListener('mouseleave', endDrag);
  svg.addEventListener('dblclick', () => resetMapView());
}

// 点玩家名字跳到他的档案详情（事件在假 DOM 里测不了，绑定前做能力探测）
function bindMapNameClicks(players) {
  const host = $('#map-view');
  if (!host || typeof host.getElementsByTagName !== 'function') return;
  Array.from(host.getElementsByTagName('text')).forEach((t) => {
    const name = (t.getAttribute && t.getAttribute('data-map-name')) || '';
    if (!name) return; // 底图/聚落名字不跳转
    t.style.cursor = 'pointer';
    t.onclick = () => {
      const target = players.find((p) => p.platformName === name);
      if (target) { switchTab('players'); openPlayerDetail(target.heroId || target.platformName); }
    };
  });
}

function startMapTimer() {
  stopMapTimer();
  mapTimer = setInterval(() => {
    if ($('#tab-map').classList.contains('active')) {
      playersData = null; // 强制重新拉档案，位置才算真「刷」了
      renderMapTab();
    }
  }, 30000);
}

// 手动刷新按钮：底图 settlements 不变可以吃缓存，但玩家位置必须重拉
$('#map-refresh').onclick = () => {
  playersData = null;
  renderMapTab();
  toast('已刷新玩家位置', 'ok', 2000);
};

// 视野复位按钮
$('#map-reset').onclick = () => {
  resetMapView();
  toast('已复位地图视野', 'ok', 2000);
};

function renderPlayerDetail(p) {  const host = $('#player-detail');
  if (!host) return;

  // 记住当前这个人：perk 目录是异步来的，到货后要用同一份数据重画
  detailProfile = p && p.detail ? p : null;

  const d = p && p.detail;
  const back = '<button class="btn sm ghost" id="pd-back">← 返回名册</button>';

  if (!d) {
    const err = (playersData && playersData.cards && (playersData.cards.error || '')) || '';
    host.innerHTML = `<div class="pd">
      <div class="pd-bar">${back}<span class="pd-bar-hint">模块数据未就绪</span></div>
      <div class="pw-note"><b>这名玩家还没有详情数据</b><br>
        等级 / 装备 / 部队 / 技能由服务端模块（CoopPlayerCard）在游戏进程内导出，
        每 15 秒落一次 <code>playercards.json</code>，需要服务端跑到读档完成之后才会有。<br>
        ${err ? esc(err) : ''}<br>
        <b>如果服务端明明在对外服务却还是这句提示：</b>多半是这个控制台进程还是改代码之前启动的
        —— 后端模块没重新加载。重启一次控制台就好。</div>
    </div>`;
    bindDetailBack();
    return;
  }

  const hue = p.hue || 220;

  // 标签去重：王国和文化经常同名（都是 Battania），重复贴两遍很傻
  const tagItems = [];
  const addTag = (text, cls) => {
    const t = String(text || '').trim();
    if (!t) return;
    if (tagItems.some((x) => x.text === t)) return;
    tagItems.push({ text: t, cls: cls || '' });
  };
  addTag(p.online ? '在线' : '离线', p.online ? 'is-on' : '');
  if (d.name && d.name !== p.platformName) addTag(d.name);
  if (d.clan.name) addTag(d.clan.name + (d.clan.tier ? ' T' + d.clan.tier : ''));
  addTag(d.clan.kingdom);
  addTag(d.culture);
  if (d.isFemale) addTag('女');
  const tags = tagItems
    .map((t) => `<span class="pd-tag ${t.cls}">${esc(t.text)}</span>`)
    .join('');

  const kv = [
    ['家族', d.clan.name || '—'],
    ['家族等级', d.clan.tier ? 'T' + d.clan.tier : '—'],
    ['影响力', fmtNum(d.clan.influence)],
    ['家族声望', fmtNum(d.clan.renown)],
    ['王国', d.clan.kingdom || '无'],
    ['文化', d.culture || '—'],
    ['英雄 ID', d.heroId || p.heroId || '—'],
  ].map(([k, v]) => `<div class="pd-kv"><span>${esc(k)}</span><b>${esc(String(v))}</b></div>`).join('');

  host.innerHTML = `<div class="pd" style="--hue:${hue}">
    <div class="pd-bar">
      ${back}
      <span class="pd-bar-hint">
        装备 / 部队 / 技能由服务端模块实时导出 · 不含家族成员
        ${d.generatedAt ? '· 快照 ' + fmtAgo(Date.now() - new Date(d.generatedAt).getTime()) : ''}
      </span>
    </div>

    <header class="pd-head">
      <div class="pd-portrait">${esc(p.initials)}<i class="pw-dot"></i></div>
      <div class="pd-id">
        <h2>${esc(p.platformName)}</h2>
        <div class="pd-tags">${tags}</div>
      </div>
      <div class="pd-stats">
        <div><b>${fmtInt(d.level)}</b><span>等级</span></div>
        <div><b>${fmtInt(d.gold)}</b><span>金币</span></div>
        <div><b>${d.age ? (Math.round(d.age * 10) / 10) : '—'}</b><span>年龄</span></div>
        <div><b>${fmtInt(d.hitPoints)}</b><span>生命</span></div>
      </div>
    </header>

    <div class="pd-grid">
      <section class="pd-sec">
        <h3>战斗装备 <span class="hint">${withoutMount(d.equipment.battle).length} 件</span></h3>
        ${pdEquipmentRows(withoutMount(d.equipment.battle), '战斗套装是空的。')}
      </section>

      <section class="pd-sec">
        <h3>平民装备 <span class="hint">${withoutMount(d.equipment.civilian).length} 件</span></h3>
        ${pdEquipmentRows(withoutMount(d.equipment.civilian), '没有单独配平民装，进城沿用战斗装备。')}
      </section>

      <section class="pd-sec">
        <h3>坐骑</h3>
        ${pdMount(d.mount)}
      </section>

      <section class="pd-sec">
        <h3>身份与家族</h3>
        <div class="pd-kvs">${kv}</div>
      </section>

      <section class="pd-sec pd-wide">
        <h3>部队 <span class="hint">${d.party ? d.party.manCount + ' 人' : '无'}</span></h3>
        ${pdParty(d.party)}
      </section>

      <section class="pd-sec pd-wide">
        <h3>技能与技能树
          <span class="hint">${d.skills.length} 项技能${d.perks && d.perks.length ? ' · 已点亮 ' + d.perks.length + ' 个 perk' : ''}</span>
        </h3>
        ${pdSkillsSection(d)}
      </section>
    </div>
  </div>`;

  bindDetailBack();
}

function bindDetailBack() {
  const b = $('#pd-back');
  if (b) b.onclick = closePlayerDetail;
}

function openPlayerDetail(heroId) {
  const next = String(heroId || '');
  // 换人时把技能树回到默认（每人熟练度不同，停在上一个人的技能上很怪）
  if (next !== detailHeroId) detailSkill = '';
  detailHeroId = next;
  const p = (playersData && playersData.players || []).find(
    (x) => x.heroId === detailHeroId || x.platformName === detailHeroId
  );
  if (p) renderPlayerDetail(p);
  syncDetailLayout();
  const sc = $('#players-scroll');
  if (sc) sc.scrollTop = 0;
}

function closePlayerDetail() {
  detailHeroId = '';
  detailProfile = null;
  detailSkill = '';
  hidePerkTip();
  const host = $('#player-detail');
  if (host) host.innerHTML = '';
  syncDetailLayout();
}

// 详情打开时把名册收起来 —— 一屏只给一个人
function syncDetailLayout() {
  const open = !!detailHeroId;
  const host = $('#player-detail');
  const grid = $('#player-grid');
  const note = $('#players-note');
  const bar = $('#realm-bar');
  if (host) host.classList.toggle('open', open);
  for (const n of [grid, note, bar]) {
    if (!n) continue;
    n.style.display = open ? 'none' : '';
  }
}


async function loadPlayers() {
  let d;
  try {
    d = await api('/api/players');
  } catch (e) {
    $('#players-note').innerHTML = '<div class="pw-note"><b>请求失败</b><br>' + esc(e.message) + '</div>';
    return;
  }
  playersData = d;

  $('#players-source').textContent = d.file ? '存档：' + d.file.split(/[\\/]/).pop() : '存档：未找到配对文件';
  $('#players-updated').textContent = d.updatedAt
    ? '档案更新于 ' + new Date(d.updatedAt).toLocaleString('zh-CN') + '（' + fmtAgo(d.ageMs) + '）'
    : '';
  $('#badge-players').textContent = d.online || 0;

  const world = (state.snap && state.snap.world) || d.world;
  renderRealmBar(world, d);
  renderPlayerCards(d.players || [], world);
  renderPlayersNote(d);

  // 轮询刷新时详情页要跟着更新；如果这个人已经不在名单里就退回名册
  if (detailHeroId) {
    const p = (d.players || []).find(
      (x) => x.heroId === detailHeroId || x.platformName === detailHeroId
    );
    if (p) renderPlayerDetail(p);
    else closePlayerDetail();
  }

  // 位置地图的底图数据是异步的：第一次进玩家页时拉一次就缓存
  loadMap();
}

$('#players-refresh').onclick = () => {
  loadPlayers();
  toast('已重新读取存档档案', 'ok', 2000);
};

// 卡片点击 → 详情。事件委托挂在网格上，卡片重渲染不用重新绑。
// 卡片里还有 Steam 链接，点链接时放过、不要抢走。
(function bindPlayerGridEvents() {
  const grid = $('#player-grid');
  if (!grid || !grid.addEventListener) return;

  grid.addEventListener('click', (e) => {
    const card = e.target.closest && e.target.closest('article.pw-card');
    if (!card) return;
    if (e.target.closest && e.target.closest('a')) return;
    openPlayerDetail(card.dataset ? card.dataset.hero : '');
  });

  // 键盘也能进：卡片带 tabindex/role=button，回车或空格都算点击
  grid.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    const card = e.target.closest && e.target.closest('article.pw-card');
    if (!card) return;
    e.preventDefault();
    openPlayerDetail(card.dataset ? card.dataset.hero : '');
  });
})();

// 详情页里的事件：点左边技能切技能树，鼠标停在 perk 上出说明。
// 挂在 #player-detail 上（这个元素不会被替换），里面重渲染多少次都不用重新绑。
(function bindDetailEvents() {
  const host = $('#player-detail');
  if (!host || !host.addEventListener) return;

  host.addEventListener('click', (e) => {
    const t = e.target;
    if (!t || !t.closest) return;
    const sk = t.closest('[data-skill]');
    if (sk && sk.dataset) { selectDetailSkill(sk.dataset.skill); return; }
    if (t.closest('#pd-back')) closePlayerDetail();
  });

  host.addEventListener('mouseover', (e) => {
    const t = e.target;
    if (!t || !t.closest) return;
    const perk = t.closest('[data-perk]');
    if (perk) showPerkTip(perk, e);
  });

  host.addEventListener('mouseout', (e) => {
    const t = e.target;
    if (!t || !t.closest) return;
    if (t.closest('[data-perk]')) hidePerkTip();
  });

  // 滚走的时候说明框不能留在原地
  const scroller = $('#players-scroll');
  if (scroller && scroller.addEventListener) scroller.addEventListener('scroll', hidePerkTip);
})();

if (document.addEventListener) {
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && detailHeroId) closePlayerDetail();
  });
}

// 面板开着时每 20 秒兜底刷一次；存档一写盘 mtime 就变，数字跟着走
function startPlayersTimer() {
  stopPlayersTimer();
  playersTimer = setInterval(() => {
    if ($('#tab-players').classList.contains('active')) loadPlayers();
  }, 20000);
}
function stopPlayersTimer() {
  if (playersTimer) { clearInterval(playersTimer); playersTimer = null; }
}

// ————————————————————— 命令台 —————————————————————

const BASIC = [
  { cmd: 'status', label: 'status — 状态' },
  { cmd: 'players', label: 'players — 在线玩家' },
  { cmd: 'save', label: 'save — 立即存档' },
  { cmd: 'help', label: 'help — 命令帮助' },
];

const SAY_PRESETS = [
  '服务器将在 5 分钟后重启，请注意存档',
  '欢迎加入，有问题在聊天里喊一声',
  '本轮存档已完成',
];

// 注意：这里刻意不放「加金币 / 加兵 / 解锁锻造部件」那类快捷按钮。
// 一键就改档会直接影响联机平衡，运维面板不该鼓励这种点法。
// 真要调档请去下面「命令全集」里按名字找，或直接在输入框敲 —— 多一道门槛是好事。

function renderCommandChips() {
  $('#chips-basic').innerHTML = BASIC.map((c) =>
    `<button class="chip" data-cmd="${esc(c.cmd)}">${esc(c.label)}</button>`).join('');

  $('#chips-say').innerHTML = SAY_PRESETS.map((t) =>
    `<button class="chip" data-cmd="say ${esc(t)}">${esc(t)}</button>`).join('');

  const game = state.commands.game || [];
  $('#cmds-total').textContent = game.length + ' 条游戏命令 + ' + (state.commands.builtin || []).length + ' 条内置命令';
  renderAllCommands(game);
}

let allCmdFilter = '';
function renderAllCommands(game) {
  const list = game && game.length ? game : (state.commands.game || []);
  const f = allCmdFilter.toLowerCase();
  const shown = f ? list.filter((c) => c.toLowerCase().includes(f)) : list;
  $('#chips-all').innerHTML = shown.map((c) =>
    `<button class="chip" data-fill="${esc(c)}">${esc(c)}</button>`).join('') ||
    '<span class="note">没有匹配的命令</span>';
}

$('#cmd-search').addEventListener('input', (e) => {
  allCmdFilter = e.target.value.trim();
  renderAllCommands();
});

document.addEventListener('click', (e) => {
  const btn = e.target.closest('.chip');
  if (!btn) return;

  if (btn.dataset.action === 'backup-now') return doBackup(true);
  if (btn.dataset.fill !== undefined) {
    $('#cmd-input').value = btn.dataset.fill + ' ';
    $('#cmd-input').focus();
    return;
  }
  const cmd = btn.dataset.cmd;
  if (!cmd) return;

  if (btn.dataset.confirm) {
    confirmDialog('确认执行', `<b>${esc(cmd)}</b><br>${esc(btn.dataset.confirm)}`, '执行').then((ok) => {
      if (ok) sendCommand(cmd);
    });
    return;
  }
  sendCommand(cmd);
});

function appendCmdOut(lines) {
  const out = $('#cmd-out');
  for (const l of lines) {
    const div = document.createElement('div');
    const msg = l.msg || '';
    let cls = 'out';
    if (l.level === 'console') cls = 'e';
    else if (l.level === 'error') cls = 'err';
    else if (l.level === 'ok') cls = 'ok';
    div.className = cls;
    div.textContent = (l.time ? l.time + '  ' : '') + msg;
    out.appendChild(div);
  }
  while (out.childElementCount > 600) out.removeChild(out.firstElementChild);
  out.scrollTop = out.scrollHeight;
}

async function sendCommand(cmd) {
  if (!state.snap || (!state.snap.running)) {
    toast('服务器没在运行，命令无处可发', 'warn');
    return;
  }
  try {
    const r = await api('/api/command', { method: 'POST', body: JSON.stringify({ cmd }) });
    if (!r.ok) {
      toast(r.results.map((x) => x.error).join('；'), 'err');
      return;
    }
    state.captureUntil = Date.now() + 2500;
    if (state.history[0] !== cmd) state.history.unshift(cmd);
    state.history = state.history.slice(0, 100);
    state.histIdx = -1;
  } catch (e) {
    toast('发送失败：' + e.message, 'err');
  }
}

$('#cmd-send').onclick = () => {
  const v = $('#cmd-input').value.trim();
  if (!v) return;
  sendCommand(v);
  $('#cmd-input').value = '';
};
$('#cmd-input').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { $('#cmd-send').click(); return; }
  if (e.key === 'ArrowUp') {
    e.preventDefault();
    if (!state.history.length) return;
    state.histIdx = Math.min(state.histIdx + 1, state.history.length - 1);
    $('#cmd-input').value = state.history[state.histIdx];
  }
  if (e.key === 'ArrowDown') {
    e.preventDefault();
    state.histIdx = Math.max(state.histIdx - 1, -1);
    $('#cmd-input').value = state.histIdx < 0 ? '' : state.history[state.histIdx];
  }
});

$('#say-send').onclick = () => {
  const v = $('#say-text').value.trim();
  if (!v) return toast('先写点要说的', 'warn');
  sendCommand('say ' + v);
  $('#say-text').value = '';
};
$('#say-text').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('#say-send').click(); });

$('#kick-send').onclick = () => {
  const p = $('#kick-player').value;
  if (!p) return toast('没有可选玩家', 'warn');
  confirmDialog('踢出玩家', `确定把 <b>${esc(p)}</b> 踢下线？`, '踢出').then((ok) => {
    if (ok) sendCommand('kick ' + p);
  });
};

// ————————————————————— 启动 / 停止 —————————————————————

$('#btn-start').onclick = async () => {
  $('#btn-start').disabled = true;
  try {
    await api('/api/start', { method: 'POST' });
    toast('已启动，首次载入约 30–60 秒；日志出现 SERVING 才算真的起来了', 'ok', 6000);
    switchTab('log');
  } catch (e) {
    toast(e.message, 'err', 9000);
  }
  refreshStatus();
};

$('#btn-stop').onclick = async () => {
  const ok = await confirmDialog('停止服务器',
    '会先发 <b>stop</b> 让服务器存盘后自行退出，最多等 45 秒。<br>正在玩的玩家会被断开。', '停止');
  if (!ok) return;
  $('#btn-stop').disabled = true;
  try {
    const r = await api('/api/stop', { method: 'POST', body: JSON.stringify({}) });
    toast(r.forced ? '等待超时，已强制结束进程树' : '服务器已停止', r.forced ? 'warn' : 'ok');
  } catch (e) {
    toast(e.message, 'err');
  }
  refreshStatus();
};

$('#btn-kill').onclick = async () => {
  const ok = await confirmDialog('强制结束',
    '直接 <b>taskkill /T /F</b> 整棵进程树，不会存盘。<br>仅在「停止」无效或要清掉外部启动的实例时使用。', '强制结束');
  if (!ok) return;
  try {
    const r = await api('/api/kill', { method: 'POST' });
    toast('已结束 PID ' + (r.killedPid || '') , 'warn');
  } catch (e) {
    toast(e.message, 'err');
  }
  refreshStatus();
};

async function refreshStatus() {
  try {
    const s = await api('/api/status');
    renderStatus(s);
  } catch (_) {}
}

setInterval(refreshStatus, 3000);
setInterval(() => {
  if (state.snap && state.snap.running && state.snap.startedAt) {
    $('#pill-uptime').innerHTML = '<b>' + fmtDuration(Date.now() - state.snap.startedAt) + '</b>';
  }
}, 1000);

// ————————————————————— 存档备份 —————————————————————

async function loadSaves() {
  let d;
  try { d = await api('/api/saves'); } catch (e) { return toast('读取存档失败：' + e.message, 'err'); }

  $('#save-dir').textContent = d.savesDir;
  $('#badge-backups').textContent = d.backups.length;
  $('#save-current-hint').textContent = d.current.length + ' 个文件 · ' + fmtBytes(d.currentBytes || 0) +
    '　备份共 ' + d.backups.length + ' 份 · 占 ' + fmtBytes(d.totalBackupBytes || 0);

  const cur = $('#save-current');
  cur.innerHTML = '<tr><th>文件</th><th>大小</th><th>修改时间</th></tr>' +
    (d.current.length
      ? d.current.map((f) => `<tr><td>${esc(f.name)}</td><td class="num">${fmtBytes(f.size)}</td>
          <td class="num">${new Date(f.mtime).toLocaleString('zh-CN')}</td></tr>`).join('')
      : '<tr><td colspan="3" class="empty">存档目录里没有文件</td></tr>');

  const bk = $('#save-backups');
  bk.innerHTML = '<tr><th>备份</th><th>时间</th><th>大小</th><th>备注</th><th></th></tr>' +
    (d.backups.length
      ? d.backups.map((b) => `<tr>
          <td>${esc(b.id)}</td>
          <td class="num">${esc(b.createdAtText)}</td>
          <td class="num">${fmtBytes(b.size)}</td>
          <td>${esc(b.note || '—')}</td>
          <td class="actions">
            <button class="btn sm ghost" data-restore="${esc(b.id)}">恢复</button>
            <button class="btn sm danger" data-del="${esc(b.id)}">删除</button>
          </td></tr>`).join('')
      : '<tr><td colspan="5" class="empty">还没有备份。点左上角「立即备份」建立第一份。</td></tr>');
}

$('#save-refresh').onclick = loadSaves;

async function doBackup(silent) {
  const note = $('#save-note') ? $('#save-note').value.trim() : '';
  const triggerSave = $('#save-trigger') ? $('#save-trigger').checked : false;
  if (triggerSave && state.snap && state.snap.running) {
    toast('正在让服务器存档，约 6 秒后打包…', '', 3000);
  }
  try {
    const r = await api('/api/saves/backup', {
      method: 'POST',
      body: JSON.stringify({ note, triggerSave }),
    });
    toast('备份完成：' + r.id + '（' + fmtBytes(r.totalBytes) + '）', 'ok');
    $('#save-note').value = '';
    loadSaves();
  } catch (e) {
    toast('备份失败：' + e.message, 'err', 8000);
  }
}

$('#save-backup').onclick = () => doBackup();

document.addEventListener('click', async (e) => {
  const rBtn = e.target.closest('[data-restore]');
  if (rBtn) {
    const id = rBtn.dataset.restore;
    if (state.snap && state.snap.running) {
      return toast('请先停止服务器再恢复存档', 'warn', 6000);
    }
    const ok = await confirmDialog('恢复存档',
      `把 <b>${esc(id)}</b> 的文件覆盖回 Game Saves。<br>当前现场会先自动备份一份，误操作可退回。`, '恢复');
    if (!ok) return;
    try {
      const r = await api('/api/saves/restore', { method: 'POST', body: JSON.stringify({ id }) });
      toast('已恢复 ' + r.restored.length + ' 个文件，恢复前现场存为 ' + r.guard, 'ok', 7000);
      loadSaves();
    } catch (err) {
      toast('恢复失败：' + err.message, 'err');
    }
    return;
  }

  const dBtn = e.target.closest('[data-del]');
  if (dBtn) {
    const id = dBtn.dataset.del;
    const ok = await confirmDialog('删除备份', `永久删除备份 <b>${esc(id)}</b>？此操作不可撤销。`, '删除');
    if (!ok) return;
    try {
      await api('/api/saves/' + encodeURIComponent(id), { method: 'DELETE' });
      toast('已删除 ' + id, 'ok');
      loadSaves();
    } catch (err) {
      toast('删除失败：' + err.message, 'err');
    }
  }
});

// ————————————————————— 更新日志 —————————————————————

function mdToHtml(md) {
  const lines = String(md || '').replace(/\r/g, '').split('\n');
  let html = '';
  let inList = false;
  const inline = (s) => esc(s)
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>')
    .replace(/\[([^\]]+)\]\((https?:[^)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>')
    .replace(/(^|[\s(])(https?:\/\/[^\s<)]+)/g, '$1<a href="$2" target="_blank" rel="noopener">$2</a>');

  for (const raw of lines) {
    const line = raw.trimEnd();
    const h = line.match(/^(#{1,6})\s+(.*)$/);
    if (h) {
      if (inList) { html += '</ul>'; inList = false; }
      const lvl = Math.min(h[1].length + 1, 4);
      html += `<h${lvl}>${inline(h[2])}</h${lvl}>`;
      continue;
    }
    if (/^(-{3,}|\*{3,}|_{3,})$/.test(line.trim())) {
      if (inList) { html += '</ul>'; inList = false; }
      html += '<hr>';
      continue;
    }
    const li = line.match(/^\s*[-*+]\s+(.*)$/);
    if (li) {
      if (!inList) { html += '<ul>'; inList = true; }
      html += `<li>${inline(li[1])}</li>`;
      continue;
    }
    if (inList) { html += '</ul>'; inList = false; }
    if (!line.trim()) continue;
    html += `<p>${inline(line)}</p>`;
  }
  if (inList) html += '</ul>';
  return html;
}

async function loadChangelog(force) {
  if (force) {
    toast('正在从 GitHub 抓取…', '', 2500);
    try { await api('/api/changelog/refresh', { method: 'POST' }); } catch (e) { toast('抓取失败：' + e.message, 'err'); }
  }
  let d;
  try { d = await api('/api/changelog'); } catch (e) { return toast('读取失败：' + e.message, 'err'); }

  $('#changelog-source').textContent = d.source || 'https://github.com/Bannerlord-Coop-Team/BannerlordCoop/releases';
  $('#changelog-time').textContent = d.fetchedAt ? '抓取于 ' + new Date(d.fetchedAt).toLocaleString('zh-CN') : '';

  const curTag = 'v' + (state.version || '0.1.6');
  const view = $('#changelog-view');
  if (!d.releases || !d.releases.length) {
    view.innerHTML = '<div class="empty">没有抓到版本信息。检查网络后点「从 GitHub 重新抓取」。</div>';
    return;
  }

  view.innerHTML = d.releases.map((r) => {
    const isCur = r.tag === curTag;
    return `<article class="release">
      <header>
        <h2>${esc(r.name)}</h2>
        <span class="meta">${esc(r.tag)} · ${(r.publishedAt || '').slice(0, 10)}</span>
        ${isCur ? '<span class="tag-cur">当前运行版本</span>' : ''}
        ${r.prerelease ? '<span class="tag-pre">预发布</span>' : ''}
        <span style="margin-left:auto"><a class="btn sm ghost" href="${esc(r.url)}" target="_blank" rel="noopener">GitHub ↗</a></span>
      </header>
      <div class="md">${mdToHtml(r.body)}</div>
    </article>`;
  }).join('');
}

$('#changelog-refresh').onclick = () => loadChangelog(true);

// ————————————————————— 配置 —————————————————————

function valClass(v) {
  if (v === true) return 'val-true';
  if (v === false) return 'val-false';
  if (typeof v === 'number') return 'val-num';
  return 'val-str';
}

function kvHtml(obj, order) {
  const keys = order ? order.filter((k) => k in obj) : Object.keys(obj);
  const rest = Object.keys(obj).filter((k) => !keys.includes(k));
  return keys.concat(rest).map((k) => {
    const v = obj[k];
    const disp = v === '' ? '（空）' : typeof v === 'object' && v !== null ? JSON.stringify(v) : String(v);
    return `<div>${esc(k)}</div><div class="${valClass(v)}">${esc(disp)}</div>`;
  }).join('');
}

// —— 控制台自身配置（可编辑）：GET/POST /api/console-config ——
// 页面只在内存里保留一份最近结果，改完点保存才落盘；重启控制台后生效。
let cfgData = null;

// config.check() 用 {fatal:bool,hint}，validate() 用 {level}，这里统一成 {level,msg,hint}
function cfgNormIssues(list) {
  return (list || []).map((i) => ({
    key: i.key,
    level: i.level || (i.fatal ? 'fatal' : 'warn'),
    msg: i.msg || '',
    hint: i.hint || '',
  }));
}

function cfgIssuesHtml(list) {
  return cfgNormIssues(list).map((i) => `<div class="cfg-issue ${i.level}">${i.level === 'fatal' ? '✗' : '!'} ${esc(i.msg)}`
    + (i.hint ? `<span class="cfg-hint-t"> · ${esc(i.hint)}</span>` : '') + '</div>').join('');
}

function cfgFieldHtml(f) {
  const locked = (cfgData.envLocked || []).indexOf(f.key) >= 0;
  const raw = cfgData.values ? cfgData.values[f.key] : undefined;
  const disp = raw === undefined || raw === null ? '' : String(raw);
  const isNum = f.kind === 'number';
  // 端口/监听地址会带上「当前值从哪来」，省得反复猜「我改了怎么没生效」
  const src = cfgData.sources ? cfgData.sources[f.key] : '';
  const hint = (f.hint || '') + (src ? ' · 当前值来自' + src : '');
  return `<label class="cfg-row${locked ? ' locked' : ''}">
      <span class="cfg-name">${esc(f.label)}${locked ? '<i>环境变量锁定</i>' : ''}</span>
      <input type="${isNum ? 'number' : 'text'}" data-key="${esc(f.key)}" value="${esc(disp)}"
        placeholder="${isNum ? '默认' : '（留空 = 自动探测）'}" spellcheck="false" autocomplete="off"${locked ? ' disabled' : ''}>
      <span class="cfg-hint">${esc(hint)}</span>
    </label>`;
}

function cfgCardHtml() {
  const d = cfgData;
  if (!d || !d.ok) {
    return `<div class="card" style="margin-bottom:16px">
      <h3>控制台配置（可编辑）</h3>
      <div class="body"><div class="cfg-issue fatal">✗ 读不到配置接口：${esc((d && d.error) || '未知错误')}</div></div>
    </div>`;
  }
  const envWarn = (d.envLocked || []).length
    ? `<div class="cfg-issue warn">! 这些项被环境变量锁住了，页面上改了也不生效：${esc(d.envLocked.join('、'))}
        <span class="cfg-hint-t"> · 先去系统环境变量或启动脚本里删掉</span></div>` : '';
  return `<div class="card cfg-card" style="margin-bottom:16px">
    <h3>控制台配置（可编辑） <span class="hint">${esc(d.file)}${d.exists ? '' : ' · 尚未创建，保存时才写'}</span></h3>
    <div class="body">
      <div class="note">改完点「校验并保存」写入上面的 config.json，<b>重启控制台后生效</b>（游戏服务端会跟着停，需要重新启动）。
        留空的项 = 用默认值或自动探测。优先级：环境变量 &gt; config.json &gt; 自动探测。</div>
      ${envWarn}
      <div class="cfg-fields">${(d.fields || []).map(cfgFieldHtml).join('')}</div>
      <div id="cfg-issues">${cfgIssuesHtml(d.issues)}</div>
      <div class="row-inline" style="gap:8px;align-items:center;flex-wrap:wrap">
        <button class="btn sm" id="cfg-save">校验并保存</button>
        <button class="btn sm ghost" id="cfg-check">只校验</button>
        <button class="btn sm ghost" id="cfg-restore">还原当前值</button>
        <span class="cfg-status" id="cfg-status"></span>
      </div>
    </div>
  </div>`;
}

function cfgCollect() {
  const out = {};
  $$('.cfg-fields input[data-key]').forEach((el) => { out[el.dataset.key] = el.value; });
  return out;
}

function cfgFill(values) {
  $$('.cfg-fields input[data-key]').forEach((el) => {
    if (el.disabled) return;
    const v = values[el.dataset.key];
    el.value = v === undefined || v === null ? '' : String(v);
  });
}

// 保存/校验都自己发 fetch：400 时也要读 body 里的 issues，不能走 api() 抛错
async function cfgPost(dryRun) {
  const res = await fetch('/api/console-config', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ values: cfgCollect(), dryRun: !!dryRun }),
  });
  let r = null;
  try { r = await res.json(); } catch (_) {}
  return { status: res.status, body: r || { ok: false, issues: [], error: 'HTTP ' + res.status } };
}

function cfgBind() {
  const saveBtn = $('#cfg-save');
  if (!saveBtn) return;
  const statusEl = $('#cfg-status');
  const issuesEl = $('#cfg-issues');
  const say = (t, cls) => { statusEl.textContent = t; statusEl.className = 'cfg-status ' + (cls || ''); };

  saveBtn.onclick = async () => {
    say('保存中…');
    try {
      const { status, body } = await cfgPost(false);
      issuesEl.innerHTML = cfgIssuesHtml(body.issues);
      if (status === 200 && body.ok) {
        if ((body.lockedIgnored || []).length) {
          say('已写入，但 ' + body.lockedIgnored.join('、') + ' 被环境变量覆盖', 'warn');
        } else {
          say('已写入 ' + body.file, 'ok');
        }
        toast('配置已保存，重启控制台后生效', 'ok');
        // 重新拉一次：让「未创建」变「已创建」、生效值同步
        try { cfgData = await api('/api/console-config'); } catch (_) {}
      } else {
        const fatal = (body.issues || []).filter((i) => (i.level || (i.fatal ? 'fatal' : 'warn')) === 'fatal');
        say(fatal.length ? '校验没通过，未写入' : ('保存失败：' + (body.error || 'HTTP ' + status)), 'err');
        toast(fatal.length ? '有 ' + fatal.length + ' 项致命问题，没有写入' : ('保存失败：' + (body.error || status)), 'err');
      }
    } catch (e) {
      say('保存失败：' + e.message, 'err');
    }
  };

  $('#cfg-check').onclick = async () => {
    say('校验中…');
    try {
      const { body } = await cfgPost(true);
      issuesEl.innerHTML = cfgIssuesHtml(body.issues);
      const bad = cfgNormIssues(body.issues).filter((i) => i.level === 'fatal');
      say(body.ok ? (bad.length ? '' : '校验通过，可以保存') : ('有 ' + bad.length + ' 项致命问题'), body.ok ? 'ok' : 'err');
    } catch (e) {
      say('校验失败：' + e.message, 'err');
    }
  };

  $('#cfg-restore').onclick = () => {
    if (!cfgData || !cfgData.values) return;
    cfgFill(cfgData.values);
    issuesEl.innerHTML = cfgIssuesHtml(cfgData.issues);
    say('已还原为当前生效值');
  };
}

async function loadConfig() {
  let d;
  try { d = await api('/api/config'); } catch (e) { return toast('读取配置失败：' + e.message, 'err'); }
  try { cfgData = await api('/api/console-config'); }
  catch (e) { cfgData = { ok: false, error: e.message, fields: [], values: {}, envLocked: [], issues: [] }; }

  const sc = d.serverConfig || {};
  const coop = d.coopSettings || {};

  $('#config-view').innerHTML = cfgCardHtml() + `
    <div class="card" style="margin-bottom:16px">
      <h3>server-config.json <span class="hint">${esc(d.serverConfigPath)}</span></h3>
      <div class="body tight">
        <div class="kv">${kvHtml(sc, ['saveName', 'autosaveMinutes', 'port', 'password', 'steam', 'logFile', 'traceTick', 'tracePublish', 'traceBandits'])}</div>
      </div>
    </div>

    <div class="card" style="margin-bottom:16px">
      <h3>Coop 玩法设置（mod-config.json · modOptions） <span class="hint">${esc(d.modConfigPath)}</span></h3>
      <div class="body tight">
        <div class="kv">${kvHtml(coop, ['blockAiWarDeclarationsOnOfflinePlayers'])}</div>
      </div>
    </div>

    <div class="card">
      <h3>路径</h3>
      <div class="body tight"><div class="kv">${kvHtml(d.paths)}</div></div>
    </div>`;

  cfgBind();
}

$('#config-refresh').onclick = loadConfig;

// ————————————————————— 标签页切换 —————————————————————

function switchTab(name) {
  $$('nav.tabs button').forEach((b) => b.classList.toggle('active', b.dataset.tab === name));
  $$('.tab').forEach((t) => t.classList.toggle('active', t.id === 'tab-' + name));
  if (location.hash.slice(1) !== name) history.replaceState(null, '', '#' + name);

  if (name === 'saves') loadSaves();
  if (name === 'changelog') loadChangelog(false);
  if (name === 'config') loadConfig();
  if (name === 'players') { loadPlayers(); startPlayersTimer(); syncDetailLayout(); } else stopPlayersTimer();
  if (name === 'map') { renderMapTab(); startMapTimer(); } else stopMapTimer();
  if (name === 'tui') { ensureTerm(); connectTui(); fitTui(); }
  else disconnectTui();
  if (name === 'cmd') {
    renderCommandChips();
    // 命令表平时靠 SSE 的 commands 事件推过来；直接用 #cmd 打开（或事件流还没连上）时
    // 会是空的，这里补一次主动拉取
    if (!(state.commands.game || []).length) {
      api('/api/commands')
        .then((d) => { state.commands = d || {}; renderCommandChips(); })
        .catch(() => {});
    }
    $('#cmd-input').focus();
  }
}

$$('nav.tabs button').forEach((b) => {
  b.onclick = () => switchTab(b.dataset.tab);
});

// ————————————————————— 启动 —————————————————————

(async function boot() {
  renderCommandChips();
  const initial = location.hash.slice(1);
  refreshStatus().then(() => {
    // 版本兜底：从已加载的日志行里抓 “BannerlordCoop build x.y.z”
    setTimeout(() => {
      if (state.version) return;
      for (const el of $$('#log-view .logline')) {
        const m = (el.textContent || '').match(/BannerlordCoop build ([\d.]+)/);
        if (m) { state.version = m[1]; $('#pill-version').innerHTML = '<b>v' + esc(m[1]) + '</b>'; break; }
      }
    }, 2500);
  });
  connectEvents();
  if (initial && initial !== 'log') switchTab(initial);
})();
