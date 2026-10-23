// 标定第四步：用人工确认的锚点做最小二乘拟合，输出标定参数，
// 并把全部 120 个聚落投影画到图上生成验证叠图。
// 用法：node calibrate-step4.js
const fs = require('fs');
const path = require('path');
const jpeg = require('jpeg-js');

const ROOT = path.join(__dirname, '..');
// 原始底图 iVP5g.jpg（4000x3200 暗色版）不随仓库分发，默认放 tmp/calradia/；
// 换机器时用环境变量 CALRADIA_TMP 指向实际目录。
const TMP = process.env.CALRADIA_TMP || path.join(ROOT, 'tmp', 'calradia');
const MAP = require(path.join(ROOT, 'lib', 'map'));
const SRC = path.join(TMP, 'iVP5g.jpg');

// 目检确认的锚点：场景坐标 → 图片像素（圆心）
const ANCHORS = [
  ['Galend', 107.500, 411.689, 529, 1511],
  ['Tyal', 647.079, 569.108, 3073, 765],
  ['Ocs Hall', 181.800, 495.300, 875, 1117],
  ['Pravend', 139.205, 475.542, 674, 1211],
  ['Varcheg', 361.256, 554.313, 1722, 837],
  ['Sanala', 401.068, 207.927, 1919, 2473],
  ['Danustica', 661.200, 276.500, 3145, 2156],
];

const n = ANCHORS.length;
let stx = 0, stx2 = 0, spx = 0, stxx = 0;
let sty = 0, sty2 = 0, spy = 0, styy = 0;
for (const [, tx, ty, px, py] of ANCHORS) {
  stx += tx; stx2 += tx * tx; spx += px; stxx += tx * px;
  sty += ty; sty2 += ty * ty; spy += py; styy += ty * py;
}
const sx = (n * stxx - stx * spx) / (n * stx2 - stx * stx);
const ox = (spx - sx * stx) / n;
const sy = (n * styy - sty * spy) / (n * sty2 - sty * sty);
const oy = (spy - sy * sty) / n;
console.log(`affine: pixel_x = ${sx.toFixed(4)} * scene_x + ${ox.toFixed(1)}`);
console.log(`        pixel_y = ${sy.toFixed(4)} * scene_y + ${oy.toFixed(1)}`);

// 锚点残差
let maxErr = 0;
for (const [name, tx, ty, px, py] of ANCHORS) {
  const e = Math.hypot(tx * sx + ox - px, ty * sy + oy - py);
  maxErr = Math.max(maxErr, e);
  console.log(`  ${name}: err=${e.toFixed(1)}px`);
}
console.log('max anchor err:', maxErr.toFixed(1), 'px');

// 反变换：图片左上角 (0,0)、右下角 (W,H) 对应的场景坐标（给 SVG 用）
const W = 4000, H = 3200;
const sceneLeft = (0 - ox) / sx, sceneRight = (W - ox) / sx;
const sceneTop = (H - oy) / sy, sceneBottom = (0 - oy) / sy;
console.log(`image covers scene x[${sceneLeft.toFixed(1)}, ${sceneRight.toFixed(1)}] y[${sceneTop.toFixed(1)}, ${sceneBottom.toFixed(1)}]`);

// 验证叠图：120 聚落全部投影，城镇画红十字+圈、城堡画绿十字
const img = jpeg.decode(fs.readFileSync(SRC), { maxMemoryUsageInMB: 2048 });
const data = MAP.load();
const put = (x, y, r, g, b) => {
  for (let dy = -7; dy <= 7; dy++) for (let dx = -7; dx <= 7; dx++) {
    const px = Math.round(x + dx), py = Math.round(y + dy);
    if (px < 0 || py < 0 || px >= W || py >= H) continue;
    if (Math.abs(dx) <= 1 || Math.abs(dy) <= 1 || dx * dx + dy * dy <= 49) {
      if (dx * dx + dy * dy > 49) continue;
      const i = (py * W + px) * 4;
      img.data[i] = r; img.data[i + 1] = g; img.data[i + 2] = b;
    }
  }
};
for (const s of data.settlements) {
  const px = s.x * sx + ox, py = s.y * sy + oy;
  if (px < 0 || py < 0 || px >= W || py >= H) { console.log('OUT OF RANGE:', s.nameEn, px | 0, py | 0); continue; }
  if (s.kind === 'town') put(px, py, 255, 60, 60);
  else put(px, py, 80, 255, 120);
}
const S = 0.45, ow = (W * S) | 0, oh = (H * S) | 0;
const out = Buffer.alloc(ow * oh * 4);
for (let y = 0; y < oh; y++) for (let x = 0; x < ow; x++) {
  const sxi = (x / S) | 0, syi = (y / S) | 0, si = (syi * W + sxi) * 4, di = (y * ow + x) * 4;
  out[di] = img.data[si]; out[di + 1] = img.data[si + 1]; out[di + 2] = img.data[si + 2]; out[di + 3] = 255;
}
fs.writeFileSync(path.join(TMP, 'overlay-verify.jpg'), jpeg.encode({ data: out, width: ow, height: oh }, 85).data);
console.log('overlay written');
fs.writeFileSync(path.join(__dirname, 'calibration.json'), JSON.stringify({
  source: 'iVP5g.jpg', credit: 'Map by Vesper (Calradia 1084, January 2021, taleworlds forums)',
  sx, ox, sy, oy, imgW: W, imgH: H, anchors: n, maxAnchorErr: maxErr,
  scene: { left: sceneLeft, right: sceneRight, top: sceneTop, bottom: sceneBottom },
}, null, 2));
console.log('calibration.json written');
