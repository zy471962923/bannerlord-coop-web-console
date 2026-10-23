// 抹除底图上的全部英文标注（标题/图例面板、城镇名、城堡名、村庄名、白色符号），
// 抹完由前端 SVG 自己画中文标注。
// 用法：node erase-labels.js [输入] [输出]
// 原理：
//   1) 白色像素做掩膜（文字/符号都是亮白，地形/边界是暗色）
//   2) 掩膜做连通域，丢掉大块（北边雪地是白的，不能抹）
//   3) 左上角「Map by Vesper / Calradia 1084」标题+图例面板整块填掉
//      （面板里的彩色势力色块不是白色，单靠白掩膜抹不干净）
//   4) 迭代修复：从掩膜边缘向内，用已填邻居的均值一层层填进去，再轻模糊
const fs = require('fs');
const path = require('path');
const jpeg = require('jpeg-js');

const ROOT = path.join(__dirname, '..');
// 原始底图 iVP5g.jpg（4000x3200 暗色版）不随仓库分发，默认放 tmp/calradia/；
// 换机器时用环境变量 CALRADIA_TMP 指向实际目录。
const TMP = process.env.CALRADIA_TMP || path.join(ROOT, 'tmp', 'calradia');

const SRC = process.argv[2] || path.join(TMP, 'iVP5g.jpg');
const DST = process.argv[3] || path.join(TMP, 'calradia-clean.jpg');

// 图例图标窄条（彩色势力方块 + 训练场/城镇/城堡/村庄符号都在这一竖条里，
// 四周全是海面；文字部分由白色掩膜自动处理，不能整块填面板——
// 面板矩形会压到 Vlandia 红色领土，BFS 会把陆地颜色拖进海里形成污渍）
const PANEL = { x0: 76, y0: 320, x1: 126, y1: 965 };
// 大标题区（「Calradia 1084」字号太大，连通域超过白名单尺寸会被当雪地保护，
// 必须显式矩形抹掉；这一片也全是海面）
const TITLE = { x0: 25, y0: 35, x1: 1250, y1: 295 };
// 面板填充色采样点（仅日志参考；实际填充色来自 BFS 周围像素）
const PANEL_SEA_SAMPLE = { x: 200, y: 640 };

const img = jpeg.decode(fs.readFileSync(SRC), { maxMemoryUsageInMB: 2048 });
const W = img.width, H = img.height, d = img.data;
console.log('image:', W, 'x', H);

// ---------- 1. 白色掩膜 ----------
const white = new Uint8Array(W * H);
for (let p = 0; p < W * H; p++) {
  const i = p * 4;
  if (d[i] > 190 && d[i + 1] > 190 && d[i + 2] > 190) white[p] = 1;
}

// ---------- 2. 连通域过滤：只保留小斑块（文字/符号），丢弃雪地等大块 ----------
const keep = new Uint8Array(W * H);
const seen = new Uint8Array(W * H);
const stack = new Int32Array(W * H);
const MAX_DIM = 60;
let blobsKept = 0, blobsDropped = 0;
for (let p0 = 0; p0 < W * H; p0++) {
  if (!white[p0] || seen[p0]) continue;
  let sp = 0; stack[sp++] = p0; seen[p0] = 1;
  const comp = [];
  let minX = W, maxX = 0, minY = H, maxY = 0;
  while (sp > 0) {
    const p = stack[--sp];
    comp.push(p);
    const x = p % W, y = (p / W) | 0;
    if (x < minX) minX = x; if (x > maxX) maxX = x;
    if (y < minY) minY = y; if (y > maxY) maxY = y;
    if (x > 0 && white[p - 1] && !seen[p - 1]) { seen[p - 1] = 1; stack[sp++] = p - 1; }
    if (x < W - 1 && white[p + 1] && !seen[p + 1]) { seen[p + 1] = 1; stack[sp++] = p + 1; }
    if (y > 0 && white[p - W] && !seen[p - W]) { seen[p - W] = 1; stack[sp++] = p - W; }
    if (y < H - 1 && white[p + W] && !seen[p + W]) { seen[p + W] = 1; stack[sp++] = p + W; }
  }
  if (maxX - minX + 1 <= MAX_DIM && maxY - minY + 1 <= MAX_DIM) {
    blobsKept++;
    for (const p of comp) keep[p] = 1;
  } else {
    blobsDropped++;
  }
}
console.log('blobs kept(erase):', blobsKept, ' dropped(protect):', blobsDropped);

// ---------- 3. 标题+图例面板整块入掩膜 ----------
const seaI = (PANEL_SEA_SAMPLE.y * W + PANEL_SEA_SAMPLE.x) * 4;
const sea = [d[seaI], d[seaI + 1], d[seaI + 2]];
console.log('panel sea sample:', sea.join(','));
let panelPx = 0;
for (let y = PANEL.y0; y < PANEL.y1; y++) {
  for (let x = PANEL.x0; x < PANEL.x1; x++) {
    if (!keep[y * W + x]) { keep[y * W + x] = 1; panelPx++; }
  }
}
for (let y = TITLE.y0; y < TITLE.y1; y++) {
  for (let x = TITLE.x0; x < TITLE.x1; x++) {
    if (!keep[y * W + x]) { keep[y * W + x] = 1; panelPx++; }
  }
}
console.log('panel extra px:', panelPx);

// ---------- 3.2 图例文字块：整块填平 ----------
// 图例文字带透明度、深色描边，逐像素抹会留「鬼影」（修复色被描边拉暗）。
// 这片全是均匀海面，直接整块填掉最干净。两块矩形拼 L 形：
// 右下角收窄避开 Vlandia 红色海岸（real y>925 后陆地北界左移到 x≈440）。
const GHOST_A = { x0: 85, y0: 295, x1: 445, y1: 925 };
const GHOST_B = { x0: 85, y0: 925, x1: 425, y1: 1005 };
let ghostPx = 0;
for (const G of [GHOST_A, GHOST_B]) {
  for (let y = G.y0; y < G.y1; y++) {
    for (let x = G.x0; x < G.x1; x++) {
      const p = y * W + x;
      if (!keep[p]) { keep[p] = 1; ghostPx++; }
    }
  }
}
console.log('legend block px:', ghostPx);

// ---------- 3.5 掩膜膨胀 4px：吃掉文字的深色描边和抗锯齿边缘 ----------
// （白心抹掉后，深色描边会留成可读的「鬼影」，膨胀掩膜连描边一起抹）
for (let round = 0; round < 2; round++) {
  const grow = new Uint8Array(keep);
  for (let y = 0; y < H; y++) {
    const row = y * W;
    for (let x = 0; x < W; x++) {
      const p = row + x;
      if (keep[p]) continue;
      if ((x > 0 && keep[p - 1]) || (x < W - 1 && keep[p + 1]) ||
          (y > 0 && keep[p - W]) || (y < H - 1 && keep[p + W])) grow[p] = 1;
    }
  }
  keep.set(grow);
}
console.log('mask dilated +4px');

// ---------- 4. 迭代修复：BFS 从边缘向内填 ----------
// mask 中值为 2 = 待填；边界外一圈视为已填来源
const dist = new Int16Array(W * H).fill(-1);
let frontier = [];
for (let p = 0; p < W * H; p++) {
  if (keep[p]) dist[p] = -2; // 待填
}
const filled = new Uint8Array(W * H);
for (let p = 0; p < W * H; p++) {
  if (keep[p]) continue;
  const x = p % W, y = (p / W) | 0;
  // 非掩膜像素是「已填」；找到与掩膜相邻的，作为第一层来源
  if ((x > 0 && keep[p - 1]) || (x < W - 1 && keep[p + 1]) ||
      (y > 0 && keep[p - W]) || (y < H - 1 && keep[p + W])) {
    dist[p] = 0;
  }
}
// 多源 BFS：距离场从非掩膜区域向掩膜内扩散
let queue = [];
for (let p = 0; p < W * H; p++) if (dist[p] === 0) queue.push(p);
let head = 0;
let maxDist = 0;
while (head < queue.length) {
  const p = queue[head++];
  const x = p % W, y = (p / W) | 0;
  const nb = [];
  if (x > 0) nb.push(p - 1);
  if (x < W - 1) nb.push(p + 1);
  if (y > 0) nb.push(p - W);
  if (y < H - 1) nb.push(p + W);
  for (const q of nb) {
    if (keep[q] && dist[q] === -2) {
      dist[q] = dist[p] + 1;
      if (dist[q] > maxDist) maxDist = dist[q];
      queue.push(q);
    }
  }
}
console.log('max inpaint radius:', maxDist, 'px');

// 按距离从小到大填色：每个待填像素取「距离更小且已填」邻居的均值
const order = queue; // BFS 序本身就是距离序
for (const p of order) {
  if (!keep[p]) continue;
  const x = p % W, y = (p / W) | 0;
  let r = 0, g = 0, b = 0, n = 0;
  const nb = [];
  if (x > 0) nb.push(p - 1);
  if (x < W - 1) nb.push(p + 1);
  if (y > 0) nb.push(p - W);
  if (y < H - 1) nb.push(p + W);
  // 斜向也纳入，填得更平顺
  if (x > 0 && y > 0) nb.push(p - W - 1);
  if (x < W - 1 && y > 0) nb.push(p - W + 1);
  if (x > 0 && y < H - 1) nb.push(p + W - 1);
  if (x < W - 1 && y < H - 1) nb.push(p + W + 1);
  for (const q of nb) {
    if (!keep[q] || dist[q] < dist[p]) {
      const i = q * 4;
      r += d[i]; g += d[i + 1]; b += d[i + 2]; n++;
    }
  }
  if (n) {
    const i = p * 4;
    d[i] = r / n; d[i + 1] = g / n; d[i + 2] = b / n;
  }
}

// ---------- 5. 掩膜区域轻模糊（2 遍 3x3），把填色痕迹揉开 ----------
for (let pass = 0; pass < 2; pass++) {
  const src = Buffer.from(d);
  for (let p = 0; p < W * H; p++) {
    if (!keep[p]) continue;
    const x = p % W, y = (p / W) | 0;
    let r = 0, g = 0, b = 0, n = 0;
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      const qx = x + dx, qy = y + dy;
      if (qx < 0 || qy < 0 || qx >= W || qy >= H) continue;
      const i = (qy * W + qx) * 4;
      r += src[i]; g += src[i + 1]; b += src[i + 2]; n++;
    }
    const i = p * 4;
    d[i] = r / n; d[i + 1] = g / n; d[i + 2] = b / n;
  }
}

// ---------- 6. 输出 ----------
fs.writeFileSync(DST, jpeg.encode(img, 85).data);
console.log('written:', DST, (fs.statSync(DST).size / 1024).toFixed(0) + 'KB');
