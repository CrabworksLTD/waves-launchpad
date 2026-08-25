"use strict";
// The Moonpad profile picture.   node tools/pfp.js
//
// The site mark is drawn on a 16x16 grid and deliberately sits left of centre —
// it is a nav mark that pairs with a wordmark, so its optical weight is placed
// against the text beside it. A profile picture has nothing beside it and gets
// cropped to a circle, so it needs its own drawing: centred on the true middle,
// on an even grid, with room between the moon and the crop edge.
const fs = require("fs");
const path = require("path");
const png = require(path.join(process.env.HOME, "cookers", "lib", "png.js"));

const OUT = path.join(__dirname, "..", "app", "public", "art");

const G = 32;                 // even, so the centre falls on a grid line
const C = G / 2;              // 16, the true middle
const R = 11;                 // moon radius: 22 of 32 across, ~69% of the frame
// Crescent width is dx - r + R. At 6.2/9.9 that was 7.3 of a 22px disc, which
// holds at 400px and disappears in a 48px timeline avatar. 7.6/9.4 gives 9.2.
const BITE = { dx: 7.6, r: 9.4 };

const LIT = [201, 245, 63];   // the site accent, --phos
const BODY = [74, 92, 33];
const INK = [8, 9, 13];

function inCircle(x, y, cx, cy, r) {
  const dx = x + 0.5 - cx, dy = y + 0.5 - cy;
  return dx * dx + dy * dy <= r * r;
}

function cells() {
  const g = [];
  for (let y = 0; y < G; y++) {
    g.push([]);
    for (let x = 0; x < G; x++) {
      if (!inCircle(x, y, C, C, R)) { g[y].push(null); continue; }
      g[y].push(inCircle(x, y, C + BITE.dx, C, BITE.r) ? BODY : LIT);
    }
  }
  return g;
}

const grid = cells();

// Prove it is centred rather than trusting the arithmetic: the drawn pixels
// should be symmetric about the middle, vertically for certain, and the
// horizontal extents should be equal distances from it.
(function check() {
  let minX = G, maxX = -1, minY = G, maxY = -1;
  for (let y = 0; y < G; y++) {
    for (let x = 0; x < G; x++) {
      if (!grid[y][x]) continue;
      if (x < minX) minX = x; if (x > maxX) maxX = x;
      if (y < minY) minY = y; if (y > maxY) maxY = y;
    }
  }
  const leftGap = minX, rightGap = G - 1 - maxX;
  const topGap = minY, bottomGap = G - 1 - maxY;
  console.log("  extents   x " + minX + "–" + maxX + "   y " + minY + "–" + maxY);
  console.log("  margins   left " + leftGap + "  right " + rightGap +
    "   top " + topGap + "  bottom " + bottomGap);
  if (leftGap !== rightGap || topGap !== bottomGap) {
    throw new Error("not centred: margins differ");
  }
  console.log("  centred   yes, " + leftGap + "px clear on every side");
})();

function render(size, bg) {
  const scale = size / G;
  if (scale !== Math.round(scale)) throw new Error(size + " is not a whole multiple of " + G);
  const im = png.blank(size, size);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const cell = grid[(y / scale) | 0][(x / scale) | 0];
      const d = (y * size + x) * 4;

      if (cell) {
        im.data[d] = cell[0]; im.data[d + 1] = cell[1]; im.data[d + 2] = cell[2];
        im.data[d + 3] = 255;
        continue;
      }

      // Outside the moon: a soft halo, computed at full resolution rather than
      // per grid cell. The glyph stays hard-edged pixel art and the light around
      // it is smooth — the same split the banner uses, where a blocky glow would
      // read as a mistake rather than as light.
      const gx = (x + 0.5) / scale, gy = (y + 0.5) / scale;
      const dist = Math.hypot(gx - C, gy - C);
      // The banner glows into a large empty field. Here the moon takes 69% of
      // the frame, so the same strength floods the margin and reads as blur
      // rather than light. Tighter falloff, a fifth of the intensity.
      const t = Math.max(0, Math.min(1, Math.exp(-(dist - R) / 1.6)));
      const glow = t * 0.22;

      if (bg === null) {
        im.data[d] = LIT[0]; im.data[d + 1] = LIT[1]; im.data[d + 2] = LIT[2];
        im.data[d + 3] = Math.round(glow * 255);
      } else {
        im.data[d] = Math.round(bg[0] + (LIT[0] - bg[0]) * glow);
        im.data[d + 1] = Math.round(bg[1] + (LIT[1] - bg[1]) * glow);
        im.data[d + 2] = Math.round(bg[2] + (LIT[2] - bg[2]) * glow);
        im.data[d + 3] = 255;
      }
    }
  }
  return im;
}

fs.mkdirSync(OUT, { recursive: true });
[[1024, "moonpad-pfp"], [512, "moonpad-pfp-512"], [256, "moonpad-pfp-256"]].forEach(function (p) {
  png.write(path.join(OUT, p[1] + ".png"), render(p[0], INK));
  console.log("  " + p[1] + ".png  " + p[0] + "×" + p[0]);
});
// transparent, for anywhere that is not a circle on ink
png.write(path.join(OUT, "moonpad-pfp-alpha.png"), render(1024, null));
console.log("  moonpad-pfp-alpha.png  1024×1024, transparent");
