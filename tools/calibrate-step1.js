// 标定第一步：按视觉预估位置裁出锚点城镇的放大图，供人工确认精确像素坐标。
// 用法：node calibrate-step1.js
// 预估坐标来自 iVP5g.jpg（4000x3200 暗色版）缩小到 1080 宽后的目测值 * 3.704。
const fs = require('fs');
const path = require('path');
const jpeg = require('jpeg-js');

const ROOT = path.join(__dirname, '..');
const MAP = require(path.join(ROOT, 'lib', 'map'));
const SRC = 'C:/Users/admin/AppData/Local/Temp/calradia/iVP5g.jpg';
const OUT = 'C:/Users/admin/AppData/Local/Temp/calradia/crops';

// 视觉预估：城镇名 → 图片像素（中心附近即可，允许 ±80px 误差）
const GUESSES = {
  Sargot:   [852, 1119],
  Galend:   [537, 1497],
  Pravend:  [1130, 1096],
  Varcheg:  [1815, 889],
  Tyal:     [3019, 778],
  Sanala:   [1537, 2452],
  Vostrum:  [2648, 2333],
  Charas:   [1445, 1871],
  Lycaron:  [2371, 1167],
  Qasira:   [3260, 1315],
};

function crop(img, W, cx, cy, half, zoom) {
  const w = half * 2, h = half * 2;
  const out = Buffer.alloc(w * zoom * h * zoom * 4);
  for (let y = 0; y < h * zoom; y++) {
    const sy = Math.min(img.height - 1, Math.max(0, cy - half + Math.floor(y / zoom)));
    for (let x = 0; x < w * zoom; x++) {
      const sx = Math.min(img.width - 1, Math.max(0, cx - half + Math.floor(x / zoom)));
      const si = (sy * img.width + sx) * 4, di = (y * w * zoom + x) * 4;
      out[di] = img.data[si]; out[di + 1] = img.data[si + 1];
      out[di + 2] = img.data[si + 2]; out[di + 3] = 255;
    }
  }
  return { data: out, width: w * zoom, height: h * zoom };
}

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const data = MAP.load();
  const byName = {};
  for (const s of data.settlements) byName[s.nameEn.replace(/\s+/g, '')] = s;
  console.log(' settlements:', data.settlements.length);

  // 场景坐标参考（供核对名字）
  for (const k of Object.keys(GUESSES)) {
    const hit = data.settlements.find((s) => s.nameEn.toLowerCase().includes(k.toLowerCase()));
    console.log('anchor', k, '->', hit ? `${hit.nameEn} kind=${hit.kind} scene=(${hit.x}, ${hit.y})` : 'NOT FOUND');
  }

  const raw = fs.readFileSync(SRC);
  const img = jpeg.decode(raw, { maxMemoryUsageInMB: 2048 });
  console.log(' image:', img.width, 'x', img.height);

  for (const [k, [cx, cy]] of Object.entries(GUESSES)) {
    const c = crop(img, img.width, cx, cy, 90, 3); // 180x180 区域放大 3 倍
    fs.writeFileSync(path.join(OUT, k + '.jpg'),
      jpeg.encode(c, 90).data);
  }
  console.log(' crops written to', OUT);
})();
