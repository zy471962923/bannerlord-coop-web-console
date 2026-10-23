// 标定第二步：自动检测图上的城镇白圆，与 settlements 场景坐标 RANSAC 配对，
// 拟合「场景坐标 → 图片像素」的仿射变换（无旋转，x/y 各自缩放）。
// 用法：node calibrate-step2.js
const fs = require('fs');
const path = require('path');
const jpeg = require('jpeg-js');

const ROOT = path.join(__dirname, '..');
// 原始底图 iVP5g.jpg（4000x3200 暗色版）不随仓库分发，默认放 tmp/calradia/；
// 换机器时用环境变量 CALRADIA_TMP 指向实际目录。
const TMP = process.env.CALRADIA_TMP || path.join(ROOT, 'tmp', 'calradia');
const MAP = require(path.join(ROOT, 'lib', 'map'));
const SRC = path.join(TMP, 'iVP5g.jpg');

// ---------- 1. 检测白色圆斑 ----------
function detectTowns(img) {
  const { width: W, height: H, data } = img;
  const isWhite = (i) => data[i] > 205 && data[i + 1] > 205 && data[i + 2] > 205;
  const mask = new Uint8Array(W * H);
  for (let p = 0; p < W * H; p++) if (isWhite(p * 4)) mask[p] = 1;

  const seen = new Uint8Array(W * H);
  const blobs = [];
  const stack = new Int32Array(W * H);
  for (let p0 = 0; p0 < W * H; p0++) {
    if (!mask[p0] || seen[p0]) continue;
    let sp = 0;
    stack[sp++] = p0;
    seen[p0] = 1;
    let minX = W, maxX = 0, minY = H, maxY = 0, cnt = 0;
    while (sp > 0) {
      const p = stack[--sp];
      const x = p % W, y = (p / W) | 0;
      cnt++;
      if (x < minX) minX = x; if (x > maxX) maxX = x;
      if (y < minY) minY = y; if (y > maxY) maxY = y;
      // 4 邻域
      if (x > 0 && mask[p - 1] && !seen[p - 1]) { seen[p - 1] = 1; stack[sp++] = p - 1; }
      if (x < W - 1 && mask[p + 1] && !seen[p + 1]) { seen[p + 1] = 1; stack[sp++] = p + 1; }
      if (y > 0 && mask[p - W] && !seen[p - W]) { seen[p - W] = 1; stack[sp++] = p - W; }
      if (y < H - 1 && mask[p + W] && !seen[p + W]) { seen[p + W] = 1; stack[sp++] = p + W; }
    }
    const bw = maxX - minX + 1, bh = maxY - minY + 1;
    // 城镇白圆：直径约 14~24px，接近正方形，填充率 > 0.55（文字填充率低会被滤掉）
    if (bw < 13 || bw > 28 || bh < 13 || bh > 28) continue;
    const aspect = bw / bh;
    if (aspect < 0.75 || aspect > 1.33) continue;
    if (cnt / (bw * bh) < 0.55) continue;
    // 排除左上角图例区（含示例圆点）
    if (maxX < 260 && maxY < 260) continue;
    blobs.push({ x: (minX + maxX) / 2, y: (minY + maxY) / 2, size: bw });
  }
  return blobs;
}

// ---------- 2. RANSAC 拟合 ----------
function fit(blobs, towns) {
  // 候选按 x 排序索引，加速近邻查询
  let best = null;
  const B = blobs.length, T = towns.length;
  const rand = () => Math.floor(Math.random() * 1e9);
  for (let iter = 0; iter < 60000; iter++) {
    const a = towns[rand() % T], b = towns[rand() % T];
    if (a === b || Math.abs(a.x - b.x) < 150 || Math.abs(a.y - b.y) < 150) continue;
    const p = blobs[rand() % B], q = blobs[rand() % B];
    if (p === q) continue;
    const dxs = b.x - a.x, dys = b.y - a.y;
    const sx = (q.x - p.x) / dxs, sy = (q.y - p.y) / dys;
    if (!isFinite(sx) || !isFinite(sy)) continue;
    if (Math.abs(sx) < 4 || Math.abs(sx) > 7 || Math.abs(sy) < 4 || Math.abs(sy) > 7) continue;
    if (sx * sy > 0) continue; // 场景 y 向上、图片 y 向下，必须异号
    const ox = p.x - a.x * sx, oy = p.y - a.y * sy;
    // 评分：多少城镇在 30px 内有候选圆
    let score = 0;
    for (const t of towns) {
      const px = t.x * sx + ox, py = t.y * sy + oy;
      for (const bl of blobs) {
        const d2 = (bl.x - px) ** 2 + (bl.y - py) ** 2;
        if (d2 < 900) { score++; break; }
      }
    }
    if (!best || score > best.score) best = { score, sx, sy, ox, oy };
  }
  return best;
}

(async () => {
  const data = MAP.load();
  const towns = data.settlements.filter((s) => s.kind === 'town');
  console.log('scene towns:', towns.length);

  const img = jpeg.decode(fs.readFileSync(SRC), { maxMemoryUsageInMB: 2048 });
  const blobs = detectTowns(img);
  console.log('detected white blobs:', blobs.length);

  const best = fit(blobs, towns);
  console.log('RANSAC best:', JSON.stringify(best));

  // 精化：用内点做最小二乘（固定配对关系重新算 ox/oy）
  const pairs = [];
  for (const t of towns) {
    const px = t.x * best.sx + best.ox, py = t.y * best.sy + best.oy;
    let bd = Infinity, bb = null;
    for (const bl of blobs) {
      const d2 = (bl.x - px) ** 2 + (bl.y - py) ** 2;
      if (d2 < bd) { bd = d2; bb = bl; }
    }
    if (bd < 1600) pairs.push({ t, b: bb, d: Math.sqrt(bd) }); // 40px 内收
  }
  console.log('inlier pairs:', pairs.length, '/', towns.length);
  const n = pairs.length;
  const sx = pairs.reduce((s, p) => s + (p.b.x - pairs[0] && 0), 0); // 占位
  // 直接解两个一元回归：px = sx*tx + ox
  let stx = 0, stx2 = 0, spx = 0, stxx = 0;
  let sty = 0, sty2 = 0, spy = 0, styy = 0;
  for (const p of pairs) {
    stx += p.t.x; stx2 += p.t.x * p.t.x; spx += p.b.x; stxx += p.t.x * p.b.x;
    sty += p.t.y; sty2 += p.t.y * p.t.y; spy += p.b.y; styy += p.t.y * p.b.y;
  }
  const Sx = (n * stxx - stx * spx) / (n * stx2 - stx * stx);
  const Ox = (spx - Sx * stx) / n;
  const Sy = (n * styy - sty * spy) / (n * sty2 - sty * sty);
  const Oy = (spy - Sy * sty) / n;
  console.log('refined: sx=%s ox=%s sy=%s oy=%s', Sx.toFixed(4), Ox.toFixed(1), Sy.toFixed(4), Oy.toFixed(1));
  const errs = pairs.map((p) => Math.hypot(p.t.x * Sx + Ox - p.b.x, p.t.y * Sy + Oy - p.b.y));
  errs.sort((a, b) => a - b);
  console.log('err max/median: %s / %s', errs[errs.length - 1].toFixed(1), errs[(n / 2) | 0].toFixed(1));
  // 打出配对明细（按误差降序前 12）供人工核查
  pairs.sort((a, b) => Math.hypot(a.t.x * Sx + Ox - a.b.x, a.t.y * Sy + Oy - a.b.y) - Math.hypot(b.t.x * Sx + Ox - b.b.x, b.t.y * Sy + Oy - b.b.y));
  console.log('--- worst pairs ---');
  for (const p of pairs.slice(-12)) {
    console.log('%s (%s,%s) -> blob(%s,%s) err=%s', p.t.nameEn, p.t.x.toFixed(0), p.t.y.toFixed(0), p.b.x.toFixed(0), p.b.y.toFixed(0), Math.hypot(p.t.x * Sx + Ox - p.b.x, p.t.y * Sy + Oy - p.b.y).toFixed(1));
  }
  fs.writeFileSync(path.join(__dirname, 'calibration.json'), JSON.stringify({ src: 'iVP5g.jpg (Map by Vesper, Calradia 1084 Jan 2021)', sx: Sx, ox: Ox, sy: Sy, oy: Oy, pairs: n, errMax: errs[errs.length - 1] }, null, 2));
})();
