"use strict";
// Cut the Moonpad mark out onto transparency and write the sizes a browser
// actually asks for.   node tools/favicon.js
//
// The mark is authored on a 16x16 grid, so every size here is a whole-number
// multiple of it. Scaling by 2, 3, 8 and 32 keeps every pixel square; asking a
// browser to resize 512 down to 16 would blur the terminator into a smudge,
// which is the one edge the shape depends on.
const fs = require("fs");
const path = require("path");
const png = require(path.join(process.env.HOME, "cookers", "lib", "png.js"));

const OUT = path.join(__dirname, "..", "app", "public", "art");

const LIT = [201, 245, 63];    // the lit crescent
const BODY = [74, 92, 33];     // the rest of the disc

// The same drawing as tools/pfp.js, expressed as fractions of the grid so it can
// be laid out at whatever resolution a size needs. Drawing a 32-grid shape and
// scaling it down to 16 would drop every other row and take the crescent with
// it — at these sizes the geometry moves, not the pixels.
const SHAPE = { r: 11 / 32, biteDx: 7.6 / 32, biteR: 9.4 / 32 };

function inCircle(x, y, cx, cy, r) {
  const dx = x + 0.5 - cx, dy = y + 0.5 - cy;
  return dx * dx + dy * dy <= r * r;
}

function cells(G) {
  const c = G / 2;
  const r = SHAPE.r * G, bx = c + SHAPE.biteDx * G, br = SHAPE.biteR * G;
  const g = [];
  for (let y = 0; y < G; y++) {
    g.push([]);
    for (let x = 0; x < G; x++) {
      if (!inCircle(x, y, c, c, r)) { g[y].push(null); continue; }
      g[y].push(inCircle(x, y, bx, c, br) ? BODY : LIT);
    }
  }
  return g;
}

function render(W) {
  const G16 = cells(W);
  const im = png.blank(W, W);
  for (let y = 0; y < W; y++) {
    for (let x = 0; x < W; x++) {
      const c = G16[y][x];
      const d = (y * W + x) * 4;
      if (!c) { im.data[d] = 0; im.data[d + 1] = 0; im.data[d + 2] = 0; im.data[d + 3] = 0; continue; }
      im.data[d] = c[0]; im.data[d + 1] = c[1]; im.data[d + 2] = c[2]; im.data[d + 3] = 255;
    }
  }
  return im;
}

// 180 is not a multiple of 16, and Apple's touch icon is the one place a solid
// backdrop is required — iOS composites onto white otherwise and the dark body
// vanishes. Drawn at 176 and centred on an ink tile.
function touchIcon() {
  const W = 180, m = render(176);
  const im = png.blank(W, W);
  for (let i = 0; i < im.data.length; i += 4) {
    im.data[i] = 11; im.data[i + 1] = 13; im.data[i + 2] = 16; im.data[i + 3] = 255;
  }
  const off = (W - m.width) / 2;
  for (let y = 0; y < m.height; y++) {
    for (let x = 0; x < m.width; x++) {
      const s = (y * m.width + x) * 4;
      if (!m.data[s + 3]) continue;
      const d = ((y + off) * W + x + off) * 4;
      im.data[d] = m.data[s]; im.data[d + 1] = m.data[s + 1]; im.data[d + 2] = m.data[s + 2];
    }
  }
  return im;
}

fs.mkdirSync(OUT, { recursive: true });
[16, 32, 192, 512].forEach(function (n) {
  png.write(path.join(OUT, "moon-" + n + ".png"), render(n));
  console.log("  moon-" + n + ".png");
});
png.write(path.join(OUT, "moon-touch.png"), touchIcon());
console.log("  moon-touch.png  180 on ink");
