// 临时工具：裁图目检（复用 step3 的裁剪逻辑，独立小脚本）
const fs = require('fs');
const jpeg = require('jpeg-js');
const SRC = process.argv[2];
const OUT = process.argv[3];
const CX = Number(process.argv[4]), CY = Number(process.argv[5]);
const HALF = Number(process.argv[6] || 150), ZOOM = Number(process.argv[7] || 3);

const img = jpeg.decode(fs.readFileSync(SRC), { maxMemoryUsageInMB: 2048 });
const w = HALF * 2, h = HALF * 2;
const out = Buffer.alloc(w * ZOOM * h * ZOOM * 4);
for (let y = 0; y < h * ZOOM; y++) {
  const sy = Math.min(img.height - 1, Math.max(0, Math.round(CY - HALF + y / ZOOM)));
  for (let x = 0; x < w * ZOOM; x++) {
    const sx = Math.min(img.width - 1, Math.max(0, Math.round(CX - HALF + x / ZOOM)));
    const si = (sy * img.width + sx) * 4, di = (y * w * ZOOM + x) * 4;
    out[di] = img.data[si]; out[di + 1] = img.data[si + 1];
    out[di + 2] = img.data[si + 2]; out[di + 3] = 255;
  }
}
fs.writeFileSync(OUT, jpeg.encode({ data: out, width: w * ZOOM, height: h * ZOOM }, 90).data);
console.log('crop', CX, CY, '->', OUT);
