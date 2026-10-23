// 标定第三步：投影引导迭代。
//   1) 打出某场景坐标附近的城镇名（核对身份）
//   2) 用当前仿射投影指定城镇，裁出放大图供目检
// 用法：node calibrate-step3.js [query|crop] [args...]
//   node calibrate-step3.js query 181 495        :: 查这个场景坐标附近是谁
//   node calibrate-step3.js crop                 :: 按 ANCHORS 里列的城镇投影裁图
const fs = require('fs');
const path = require('path');
const jpeg = require('jpeg-js');

const ROOT = path.join(__dirname, '..');
// 原始底图 iVP5g.jpg（4000x3200 暗色版）不随仓库分发，默认放 tmp/calradia/；
// 换机器时用环境变量 CALRADIA_TMP 指向实际目录。
const TMP = process.env.CALRADIA_TMP || path.join(ROOT, 'tmp', 'calradia');
const MAP = require(path.join(ROOT, 'lib', 'map'));
const SRC = path.join(TMP, 'iVP5g.jpg');
const OUT = path.join(TMP, 'crops2');

// 初始仿射（Galend、Tyal 两锚点算出，随迭代更新）
const AFF = { sx: 4.7150, ox: 22.1, sy: -4.7390, oy: 3462.1 };

// 待验证锚点（名字必须能在 settlements 里唯一匹配）
const NAMES = ['Pravend', 'Varcheg', 'Sanala', 'Vostrum', 'Charas', 'Lycaron', 'Qasira', 'Ocs Hall', 'Sargot', 'Seonon', 'Epicrotea', 'Danustica'];

function findTown(name) {
  const data = MAP.load();
  return data.settlements.filter((s) => s.nameEn.toLowerCase().includes(name.toLowerCase()));
}

function crop(img, cx, cy, half, zoom) {
  const w = half * 2, h = half * 2;
  const out = Buffer.alloc(w * zoom * h * zoom * 4);
  for (let y = 0; y < h * zoom; y++) {
    const sy = Math.min(img.height - 1, Math.max(0, Math.round(cy - half + y / zoom)));
    for (let x = 0; x < w * zoom; x++) {
      const sx = Math.min(img.width - 1, Math.max(0, Math.round(cx - half + x / zoom)));
      const si = (sy * img.width + sx) * 4, di = (y * w * zoom + x) * 4;
      out[di] = img.data[si]; out[di + 1] = img.data[si + 1];
      out[di + 2] = img.data[si + 2]; out[di + 3] = 255;
    }
  }
  return { data: out, width: w * zoom, height: h * zoom };
}

const mode = process.argv[2] || 'crop';
if (mode === 'query') {
  const qx = Number(process.argv[3]), qy = Number(process.argv[4]);
  const data = MAP.load();
  const near = data.settlements
    .map((s) => ({ s, d: Math.hypot(s.x - qx, s.y - qy) }))
    .sort((a, b) => a.d - b.d).slice(0, 6);
  for (const { s, d } of near) console.log(`${s.nameEn} (${s.kind}) scene=(${s.x.toFixed(1)},${s.y.toFixed(1)}) d=${d.toFixed(1)}`);
} else {
  fs.mkdirSync(OUT, { recursive: true });
  const img = jpeg.decode(fs.readFileSync(SRC), { maxMemoryUsageInMB: 2048 });
  for (const name of NAMES) {
    const hits = findTown(name);
    if (hits.length !== 1) { console.log(name, '->', hits.length, 'matches, skip'); continue; }
    const t = hits[0];
    const px = t.x * AFF.sx + AFF.ox, py = t.y * AFF.sy + AFF.oy;
    console.log(`${t.nameEn}: scene(${t.x.toFixed(1)},${t.y.toFixed(1)}) -> pixel(${px.toFixed(0)},${py.toFixed(0)})`);
    fs.writeFileSync(path.join(OUT, t.nameEn.replace(/\s+/g, '') + '.jpg'),
      jpeg.encode(crop(img, px, py, 140, 2), 88).data);
  }
  console.log('crops ->', OUT);
}
