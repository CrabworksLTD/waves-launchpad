"use strict";
const fs = require("fs");
const { PNG } = require("pngjs");

function read(file) {
  const png = PNG.sync.read(fs.readFileSync(file));
  return { width: png.width, height: png.height, data: png.data };
}

function write(file, img) {
  const png = new PNG({ width: img.width, height: img.height });
  img.data.copy(png.data);
  fs.writeFileSync(file, PNG.sync.write(png));
}

function blank(width, height) {
  return { width, height, data: Buffer.alloc(width * height * 4, 0) };
}

// Straight alpha "source-over". Layers are expected to be pre-aligned and the
// same dimensions, which validate() enforces before we ever get here.
function over(base, layer) {
  const b = base.data, l = layer.data;
  for (let i = 0; i < b.length; i += 4) {
    const la = l[i + 3];
    if (la === 0) continue;
    if (la === 255) {
      b[i] = l[i]; b[i + 1] = l[i + 1]; b[i + 2] = l[i + 2]; b[i + 3] = 255;
      continue;
    }
    const a = la / 255, ba = b[i + 3] / 255;
    const outA = a + ba * (1 - a);
    for (let c = 0; c < 3; c++) {
      b[i + c] = Math.round((l[i + c] * a + b[i + c] * ba * (1 - a)) / outA);
    }
    b[i + 3] = Math.round(outA * 255);
  }
  return base;
}

// Nearest-neighbor only. Any smoothing here would destroy the pixel art.
function scale(img, factor) {
  if (factor === 1) return img;
  const w = img.width * factor, h = img.height * factor;
  const out = blank(w, h);
  for (let y = 0; y < h; y++) {
    const sy = (y / factor) | 0;
    for (let x = 0; x < w; x++) {
      const sx = (x / factor) | 0;
      const s = (sy * img.width + sx) * 4, d = (y * w + x) * 4;
      out.data[d] = img.data[s];
      out.data[d + 1] = img.data[s + 1];
      out.data[d + 2] = img.data[s + 2];
      out.data[d + 3] = img.data[s + 3];
    }
  }
  return out;
}

function flatten(img, hex) {
  const r = parseInt(hex.slice(1, 3), 16),
        g = parseInt(hex.slice(3, 5), 16),
        b = parseInt(hex.slice(5, 7), 16);
  const d = img.data;
  for (let i = 0; i < d.length; i += 4) {
    const a = d[i + 3] / 255;
    d[i] = Math.round(d[i] * a + r * (1 - a));
    d[i + 1] = Math.round(d[i + 1] * a + g * (1 - a));
    d[i + 2] = Math.round(d[i + 2] * a + b * (1 - a));
    d[i + 3] = 255;
  }
  return img;
}

module.exports = { read, write, blank, over, scale, flatten };
