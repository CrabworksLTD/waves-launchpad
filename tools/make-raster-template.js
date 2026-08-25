"use strict";
// A raster template: layered space landscapes, drawn at 512px.
//
//   node tools/make-raster-template.js
//
// Same file format as the pixel templates — a .moonpad.json the builder opens
// as an ordinary project — but canvas.mode is "raster", because this art is
// everything pixel mode cannot do: vertical gradients, radial falloff, soft
// glows, a horizon with haze on it. Every layer above the sky carries real
// alpha, so the builder composites them the way the generator will.
const fs = require("fs");
const path = require("path");
const zlib = require("zlib");

const N = 512;
const OUT = path.join(__dirname, "..", "app", "public", "templates");

// ---------------------------------------------------------------- png
function crc32(buf) {
  let c, table = [];
  for (let n = 0; n < 256; n++) {
    c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  let crc = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i++) crc = table[(crc ^ buf[i]) & 0xFF] ^ (crc >>> 8);
  return (crc ^ 0xFFFFFFFF) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}
function png(rgba) {
  // Paeth filtering per row: gradients deflate to a tenth of what filter-0
  // manages, and this file ships to every builder visitor.
  const raw = Buffer.alloc((N * 4 + 1) * N);
  const bpp = 4;
  for (let y = 0; y < N; y++) {
    raw[y * (N * 4 + 1)] = 4;                    // Paeth
    for (let x = 0; x < N * 4; x++) {
      const i = y * N * 4 + x;
      const a = x >= bpp ? rgba[i - bpp] : 0;
      const b = y > 0 ? rgba[i - N * 4] : 0;
      const c = x >= bpp && y > 0 ? rgba[i - N * 4 - bpp] : 0;
      const pp = a + b - c;
      const pa = Math.abs(pp - a), pb = Math.abs(pp - b), pc = Math.abs(pp - c);
      const pred = pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      raw[y * (N * 4 + 1) + 1 + x] = (rgba[i] - pred) & 0xFF;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(N, 0); ihdr.writeUInt32BE(N, 4);
  ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]),
    chunk("IHDR", ihdr),
    chunk("IDAT", zlib.deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0))
  ]);
}
function url(buf) { return "data:image/png;base64," + png(buf).toString("base64"); }

// ---------------------------------------------------------------- paint
function blank() { return Buffer.alloc(N * N * 4); }
function hex(h) { return [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)]; }
function put(b, x, y, r, g, bl, a) {
  if (x < 0 || y < 0 || x >= N || y >= N) return;
  const i = (y * N + x) * 4;
  const na = a + (b[i + 3] / 255) * (255 - a) / 255 * (b[i + 3] ? 1 : 0);
  // simple source-over
  const sa = a / 255, da = b[i + 3] / 255, oa = sa + da * (1 - sa);
  if (!oa) return;
  b[i] = (r * sa + b[i] * da * (1 - sa)) / oa;
  b[i + 1] = (g * sa + b[i + 1] * da * (1 - sa)) / oa;
  b[i + 2] = (bl * sa + b[i + 2] * da * (1 - sa)) / oa;
  b[i + 3] = oa * 255;
}
// deterministic noise
let seed = 1;
function rnd() { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; }

function skyGradient(top, bottom, bandHue) {
  const b = blank();
  const t = hex(top), bo = hex(bottom);
  for (let y = 0; y < N; y++) {
    const f = y / N;
    // slight eased curve so the horizon glows
    const e = f * f * (3 - 2 * f);
    for (let x = 0; x < N; x++) {
      const i = (y * N + x) * 4;
      b[i] = t[0] + (bo[0] - t[0]) * e;
      b[i + 1] = t[1] + (bo[1] - t[1]) * e;
      b[i + 2] = t[2] + (bo[2] - t[2]) * e;
      b[i + 3] = 255;
    }
  }
  if (bandHue) {           // a soft colour band low in the sky
    const c = hex(bandHue);
    for (let y = 0; y < N; y++) {
      const d = Math.abs(y - N * 0.62) / (N * 0.16);
      if (d > 1) continue;
      const a = (1 - d) * (1 - d) * 90;
      for (let x = 0; x < N; x++) put(b, x, y, c[0], c[1], c[2], a);
    }
  }
  return b;
}

function stars(count, tint) {
  const b = blank();
  const c = hex(tint);
  seed = 77;
  for (let k = 0; k < count; k++) {
    const x = (rnd() * N) | 0, y = (rnd() * N * 0.7) | 0;
    const bright = 120 + rnd() * 135;
    put(b, x, y, c[0], c[1], c[2], bright);
    // a soft cross of falloff on the brighter ones
    if (bright > 200) {
      [[1, 0], [-1, 0], [0, 1], [0, -1]].forEach(function (d) {
        put(b, x + d[0], y + d[1], c[0], c[1], c[2], bright * 0.4);
      });
    }
  }
  return b;
}

function moon(cx, cy, R, base, shade, glow, opts) {
  const b = blank();
  const c = hex(base), s = hex(shade), g = hex(glow);
  // glow halo
  for (let y = cy - R * 1.6; y < cy + R * 1.6; y++) for (let x = cx - R * 1.6; x < cx + R * 1.6; x++) {
    const d = Math.hypot(x - cx, y - cy) / R;
    if (d > 1 && d < 1.6) put(b, x | 0, y | 0, g[0], g[1], g[2], (1.6 - d) / 0.6 * 60);
  }
  // body with a lit side and an anti-aliased rim
  for (let y = cy - R - 1; y < cy + R + 1; y++) for (let x = cx - R - 1; x < cx + R + 1; x++) {
    const d = Math.hypot(x - cx, y - cy);
    if (d > R + 1) continue;
    const edge = Math.min(1, R + 1 - d);                     // rim AA
    const lit = 0.5 + 0.5 * ((cx - x) / R * 0.7 + (cy - y) / R * 0.3);
    const rr = s[0] + (c[0] - s[0]) * lit, gg = s[1] + (c[1] - s[1]) * lit, bb = s[2] + (c[2] - s[2]) * lit;
    put(b, x | 0, y | 0, rr, gg, bb, 255 * edge);
  }
  // craters
  if (opts && opts.craters) {
    seed = 31;
    for (let k = 0; k < 7; k++) {
      const a = rnd() * Math.PI * 2, rr2 = rnd() * R * 0.7;
      const px = cx + Math.cos(a) * rr2, py = cy + Math.sin(a) * rr2;
      const cr = R * (0.06 + rnd() * 0.09);
      for (let y = py - cr; y < py + cr; y++) for (let x = px - cr; x < px + cr; x++) {
        const d = Math.hypot(x - px, y - py);
        if (d < cr) put(b, x | 0, y | 0, s[0], s[1], s[2], 110 * Math.min(1, cr - d + 0.5));
      }
    }
  }
  // ring
  if (opts && opts.ring) {
    const rc = hex(opts.ring);
    for (let x = cx - R * 1.9; x < cx + R * 1.9; x++) {
      const fx = (x - cx) / (R * 1.9);
      const y0 = cy + fx * fx * R * 0.24 + R * 0.12 - Math.abs(fx) * R * 0.1;
      for (let t2 = -2; t2 <= 2; t2++) {
        const d = Math.hypot(x - cx, (y0 + t2) - cy);
        if (d > R * 0.98) put(b, x | 0, (y0 + t2) | 0, rc[0], rc[1], rc[2], 150 - Math.abs(t2) * 40);
      }
    }
  }
  return b;
}

function ridge(base, dark, height, rough) {
  const b = blank();
  const c = hex(base), d2 = hex(dark);
  // 1D value noise horizon
  seed = rough;
  const pts = [];
  for (let k = 0; k <= 8; k++) pts.push(rnd());
  function h(x) {
    const f = x / N * 8, i = f | 0, t2 = f - i;
    const e = t2 * t2 * (3 - 2 * t2);
    return pts[i] + (pts[i + 1] - pts[i]) * e;
  }
  for (let x = 0; x < N; x++) {
    const top = N - height - h(x) * height * 0.6;
    for (let y = top | 0; y < N; y++) {
      const f = (y - top) / (N - top);
      const rr = c[0] + (d2[0] - c[0]) * f, gg = c[1] + (d2[1] - c[1]) * f, bb = c[2] + (d2[2] - c[2]) * f;
      const edge = Math.min(1, y - top + 1);
      put(b, x, y, rr, gg, bb, 255 * edge);
    }
  }
  return b;
}

function aurora(tint, drift) {
  const b = blank();
  const c = hex(tint);
  for (let x = 0; x < N; x++) {
    const mid = N * 0.3 + Math.sin(x / N * Math.PI * 2 + drift) * N * 0.08
              + Math.sin(x / N * Math.PI * 5 + drift * 2) * N * 0.03;
    for (let y = 0; y < N * 0.6; y++) {
      const d = Math.abs(y - mid) / (N * 0.09);
      if (d > 1.6) continue;
      const a = Math.max(0, (1 - d / 1.6)) * 70 * (0.6 + 0.4 * Math.sin(x / N * Math.PI));
      put(b, x, y | 0, c[0], c[1], c[2], a);
    }
  }
  return b;
}

// ------------------------------------------------------- petals and rings
// A rotated soft-edged ellipse — the petal primitive. Everything organic here
// is petals at angles; everything cosmic is distance bands. Both are just
// "how far is this pixel from a shape", which is the whole trick of drawing
// smooth things without a graphics library.
function petal(b, cx, cy, angle, len, wid, inner, outer, alpha) {
  const ci = hex(inner), co = hex(outer);
  const cos = Math.cos(angle), sin = Math.sin(angle);
  const reach = len * 2 + 4;
  for (let y = cy - reach; y < cy + reach; y++) for (let x = cx - reach; x < cx + reach; x++) {
    const dx = x - cx, dy = y - cy;
    const u = dx * cos + dy * sin;              // along the petal
    const v = -dx * sin + dy * cos;             // across it
    if (u < -2 || u > len + 2) continue;
    const f = Math.max(0, Math.min(1, u / len));
    const halfw = wid * Math.sin(Math.PI * Math.min(1, Math.max(0, f)));  // lens shape
    const d = Math.abs(v) - halfw;
    if (d > 1) continue;
    const edge = Math.min(1, 1 - d);
    const rr = ci[0] + (co[0] - ci[0]) * f, gg = ci[1] + (co[1] - ci[1]) * f, bb = ci[2] + (co[2] - ci[2]) * f;
    put(b, x | 0, y | 0, rr, gg, bb, alpha * edge);
  }
}
function glowOrb(b, cx, cy, R, core, glow) {
  const c = hex(core), g = hex(glow);
  for (let y = cy - R * 2.2; y < cy + R * 2.2; y++) for (let x = cx - R * 2.2; x < cx + R * 2.2; x++) {
    const d = Math.hypot(x - cx, y - cy) / R;
    if (d < 1) {
      const f = d * d;
      put(b, x | 0, y | 0, c[0] + (g[0] - c[0]) * f, c[1] + (g[1] - c[1]) * f, c[2] + (g[2] - c[2]) * f, 255 * Math.min(1, (1 - d) * 4 + 0.6));
    } else if (d < 2.2) {
      put(b, x | 0, y | 0, g[0], g[1], g[2], (2.2 - d) / 1.2 * 70);
    }
  }
}
// a tilted elliptical ring drawn as a soft distance band
function ring(b, cx, cy, R, squash, tilt, width, tint, alpha) {
  const c = hex(tint);
  const cos = Math.cos(tilt), sin = Math.sin(tilt);
  const reach = R + width + 3;
  for (let y = cy - reach; y < cy + reach; y++) for (let x = cx - reach; x < cx + reach; x++) {
    const dx = x - cx, dy = y - cy;
    const u = dx * cos + dy * sin, v = (-dx * sin + dy * cos) / squash;
    const d = Math.abs(Math.hypot(u, v) - R) - width;
    if (d > 1.5) continue;
    put(b, x | 0, y | 0, c[0], c[1], c[2], alpha * Math.min(1, 1.5 - d) / 1.5);
  }
}
// a glowing dot with a fading arc trail along a ring
function comet(b, cx, cy, R, squash, tilt, at, tint) {
  const c = hex(tint);
  const cos = Math.cos(tilt), sin = Math.sin(tilt);
  for (let k = 0; k < 40; k++) {
    const a = at - k * 0.02;
    const ex = Math.cos(a) * R, ey = Math.sin(a) * R * squash;
    const x = cx + ex * cos - ey * sin, y = cy + ex * sin + ey * cos;
    const fade = 1 - k / 40;
    put(b, x | 0, y | 0, c[0], c[1], c[2], 220 * fade);
    put(b, (x + 1) | 0, y | 0, c[0], c[1], c[2], 120 * fade);
    put(b, x | 0, (y + 1) | 0, c[0], c[1], c[2], 120 * fade);
  }
  glowOrb(b, cx + Math.cos(at) * R * cos - Math.sin(at) * R * squash * sin,
             cy + Math.cos(at) * R * sin + Math.sin(at) * R * squash * cos, 5, "#ffffff", tint);
}
function stemAndLeaves(b, tint, dark) {
  const c = hex(tint), d2 = hex(dark);
  const cx = N / 2;
  for (let y = N * 0.55; y < N; y++) {
    const wob = Math.sin(y / N * 6) * 6;
    for (let w = -3; w <= 3; w++) {
      const f = Math.abs(w) / 3;
      put(b, (cx + wob + w) | 0, y | 0, c[0] + (d2[0] - c[0]) * f, c[1] + (d2[1] - c[1]) * f, c[2] + (d2[2] - c[2]) * f, 255 - f * 80);
    }
  }
  petal(b, cx - 4, N * 0.74, Math.PI * 0.85, N * 0.14, N * 0.045, tint, dark, 235);
  petal(b, cx + 4, N * 0.82, Math.PI * 0.15, N * 0.12, N * 0.04, tint, dark, 235);
}
function bloom(b, petals, inner, outer, coreC, coreG, jitter) {
  const cx = N / 2, cy = N * 0.42, len = N * 0.24, wid = N * 0.075;
  seed = jitter;
  for (let k = 0; k < petals; k++) {
    const a = k / petals * Math.PI * 2 - Math.PI / 2 + (rnd() - 0.5) * 0.12;
    petal(b, cx, cy, a, len * (0.92 + rnd() * 0.16), wid, inner, outer, 245);
  }
  glowOrb(b, cx, cy, N * 0.055, coreC, coreG);
}

// ---------------------------------------------------------------- project
let sq = 0;
function uid() { return "rst" + (sq++).toString(36) + Math.random().toString(36).slice(2, 6); }
function trait(name, weight, buf) { return { id: uid(), name: name, weight: weight, image: url(buf), colors: [] }; }
function category(name, traits) { return { id: uid(), name: name, traits: traits }; }

// ---------------------------------------------------------------- spirits
// A character in raster: a dome with a wavy hem, shaded by height, rim-lit,
// with glossy eyes. All of it is still "how far is this pixel from a shape".
function arc(b, cx, cy, R, a0, a1, w, tint, alpha) {
  const c = hex(tint);
  const steps = Math.max(24, R * (a1 - a0));
  for (let k = 0; k <= steps; k++) {
    const a = a0 + (a1 - a0) * k / steps;
    const x = cx + Math.cos(a) * R, y = cy + Math.sin(a) * R;
    for (let dy = -w; dy <= w; dy++) for (let dx = -w; dx <= w; dx++) {
      const d = Math.hypot(dx, dy);
      if (d <= w + 0.5) put(b, (x + dx) | 0, (y + dy) | 0, c[0], c[1], c[2], alpha * Math.min(1, w + 0.5 - d + 0.5));
    }
  }
}
function spiritBody(base, deep, rim, bodyAlpha) {
  const b = blank();
  const cb = hex(base), cd = hex(deep), cr = hex(rim);
  const cx = N / 2, top = N * 0.2, cy = N * 0.42, rx = N * 0.26, bot = N * 0.78;
  const ry = cy - top;
  for (let y = top - 2; y < bot + N * 0.03; y++) {
    for (let x = cx - rx - 2; x < cx + rx + 2; x++) {
      let edge;
      if (y < cy) {
        const d = Math.hypot((x - cx) / rx, (y - cy) / ry);
        edge = Math.min(1, (1 - d) * ry * 0.5 + 0.5);
      } else {
        const hem = bot + Math.sin((x - cx) / rx * Math.PI * 2.5) * N * 0.02;
        const ex = Math.min(1, rx - Math.abs(x - cx) + 0.5);
        const ey = Math.min(1, hem - y + 0.5);
        edge = Math.min(ex, ey);
      }
      if (edge <= 0) continue;
      const f = Math.max(0, Math.min(1, (y - top) / (bot - top)));
      let rr = cb[0] + (cd[0] - cb[0]) * f, gg = cb[1] + (cd[1] - cb[1]) * f, bb = cb[2] + (cd[2] - cb[2]) * f;
      // rim light upper-left
      const rd = Math.hypot(x - (cx - rx * 0.4), y - (top + ry * 0.5)) / (rx * 0.8);
      if (rd < 1) { rr += (cr[0] - rr) * (1 - rd) * 0.5; gg += (cr[1] - gg) * (1 - rd) * 0.5; bb += (cr[2] - bb) * (1 - rd) * 0.5; }
      put(b, x | 0, y | 0, rr, gg, bb, bodyAlpha * Math.min(1, edge));
    }
  }
  // little side nubs for arms
  [[cx - rx - N * 0.015, N * 0.55], [cx + rx + N * 0.015, N * 0.55]].forEach(function (pt) {
    for (let y = pt[1] - N * 0.035; y < pt[1] + N * 0.035; y++) for (let x = pt[0] - N * 0.03; x < pt[0] + N * 0.03; x++) {
      const d = Math.hypot((x - pt[0]) / (N * 0.03), (y - pt[1]) / (N * 0.035));
      if (d < 1) {
        const f = 0.55;
        put(b, x | 0, y | 0, cb[0] + (cd[0] - cb[0]) * f, cb[1] + (cd[1] - cb[1]) * f, cb[2] + (cd[2] - cb[2]) * f,
            bodyAlpha * Math.min(1, (1 - d) * 10));
      }
    }
  });
  return b;
}
function spiritEyes(style) {
  const b = blank();
  const ex = N * 0.095, cy = N * 0.42;
  [N / 2 - ex, N / 2 + ex].forEach(function (cx, i) {
    if (style === "sleepy") {
      arc(b, cx, cy - N * 0.01, N * 0.032, 0.15, Math.PI - 0.15, 2.2, "#1d1a26", 255);
      return;
    }
    if (style === "star") {
      for (let k = 0; k < 4; k++) petal(b, cx, cy, k * Math.PI / 2 + Math.PI / 4, N * 0.030, N * 0.011, "#1d1a26", "#1d1a26", 255);
      glowOrb(b, cx, cy, N * 0.008, "#ffffff", "#ffffff");
      return;
    }
    const rx2 = style === "wide" ? N * 0.043 : N * 0.034;
    const ry2 = style === "wide" ? N * 0.05 : N * 0.045;
    for (let y = cy - ry2 - 1; y < cy + ry2 + 1; y++) for (let x = cx - rx2 - 1; x < cx + rx2 + 1; x++) {
      const d = Math.hypot((x - cx) / rx2, (y - cy) / ry2);
      if (d < 1) put(b, x | 0, y | 0, 29, 26, 38, 255 * Math.min(1, (1 - d) * 12));
    }
    glowOrb(b, cx - rx2 * 0.3, cy - ry2 * 0.35, N * 0.011, "#ffffff", "#ffffff");
    put(b, (cx + rx2 * 0.35) | 0, (cy + ry2 * 0.25) | 0, 255, 255, 255, 160);
  });
  return b;
}
function spiritMouth(style) {
  const b = blank();
  const cx = N / 2, cy = N * 0.52;
  if (style === "o") {
    for (let y = cy - N * 0.016; y < cy + N * 0.016; y++) for (let x = cx - N * 0.013; x < cx + N * 0.013; x++) {
      const d = Math.hypot((x - cx) / (N * 0.013), (y - cy) / (N * 0.016));
      if (d < 1) put(b, x | 0, y | 0, 29, 26, 38, 255 * Math.min(1, (1 - d) * 10));
    }
  } else if (style === "smile") {
    arc(b, cx, cy - N * 0.012, N * 0.028, 0.3, Math.PI - 0.3, 2.2, "#1d1a26", 255);
  } else if (style === "cat") {
    arc(b, cx - N * 0.014, cy - N * 0.008, N * 0.015, 0.2, Math.PI - 0.2, 1.8, "#1d1a26", 255);
    arc(b, cx + N * 0.014, cy - N * 0.008, N * 0.015, 0.2, Math.PI - 0.2, 1.8, "#1d1a26", 255);
  }
  return b;
}
function spiritBlush(tint) {
  const b = blank();
  const c = hex(tint);
  [N / 2 - N * 0.155, N / 2 + N * 0.155].forEach(function (cx) {
    for (let y = N * 0.475 - N * 0.02; y < N * 0.475 + N * 0.02; y++) for (let x = cx - N * 0.03; x < cx + N * 0.03; x++) {
      const d = Math.hypot((x - cx) / (N * 0.03), (y - N * 0.475) / (N * 0.02));
      if (d < 1) put(b, x | 0, y | 0, c[0], c[1], c[2], 90 * (1 - d));
    }
  });
  return b;
}
function spiritCharm(style) {
  const b = blank();
  if (style === "halo") ring(b, N / 2, N * 0.13, N * 0.07, 0.35, 0, 2.4, "#e5cf7a", 220);
  else if (style === "sprout") {
    const c = hex("#4f7a4a");
    for (let y = N * 0.13; y < N * 0.2; y++) put(b, N / 2 | 0, y | 0, c[0], c[1], c[2], 235);
    petal(b, N / 2, N * 0.14, -Math.PI * 0.75, N * 0.05, N * 0.02, "#6a9c5f", "#4f7a4a", 235);
    petal(b, N / 2, N * 0.14, -Math.PI * 0.25, N * 0.05, N * 0.02, "#6a9c5f", "#4f7a4a", 235);
  } else if (style === "star") {
    glowOrb(b, N * 0.71, N * 0.2, N * 0.014, "#fff8d4", "#e5cf7a");
    glowOrb(b, N * 0.28, N * 0.16, N * 0.009, "#fff8d4", "#e5cf7a");
  } else if (style === "crown") {
    const c = hex("#e5cf7a");
    for (let x = N * 0.42; x < N * 0.58; x++) {
      const h = Math.abs(((x - N * 0.42) % (N * 0.053)) - N * 0.0265) / N * 800;
      for (let y = N * 0.155 - h; y < N * 0.175; y++) put(b, x | 0, y | 0, c[0], c[1], c[2], 235);
    }
  }
  return b;
}

// ---------------------------------------------------------------- maidens
// The anime-chibi face, from the same distance fields. The eyes carry the
// style: a tall gradient iris, a pupil, two stacked catchlights and a lash
// arc — everything else stays soft and simple so the eyes read as the point.
function softEllipse(b, cx, cy, rx, ry, inner, outer, alpha) {
  const ci = hex(inner), co = hex(outer);
  for (let y = cy - ry - 1; y < cy + ry + 1; y++) for (let x = cx - rx - 1; x < cx + rx + 1; x++) {
    const d = Math.hypot((x - cx) / rx, (y - cy) / ry);
    if (d >= 1.05) continue;
    const f = Math.min(1, d);
    put(b, x | 0, y | 0,
        ci[0] + (co[0] - ci[0]) * f, ci[1] + (co[1] - ci[1]) * f, ci[2] + (co[2] - ci[2]) * f,
        alpha * Math.min(1, (1.05 - d) * rx * 0.5));
  }
}
function maidenSkin(base, deep, blush) {
  const b = blank();
  const cx = N / 2;
  // head: a wider upper ellipse over a narrower jaw one — the anime taper
  softEllipse(b, cx, N * 0.40, N * 0.205, N * 0.195, base, deep, 255);
  softEllipse(b, cx, N * 0.47, N * 0.165, N * 0.155, base, deep, 255);
  // neck and small shoulders
  const cb2 = hex(base), cd2 = hex(deep);
  for (let y = N * 0.58; y < N * 0.66; y++) for (let x = cx - N * 0.05; x < cx + N * 0.05; x++)
    put(b, x | 0, y | 0, cd2[0], cd2[1], cd2[2], 255 * Math.min(1, N * 0.05 - Math.abs(x - cx) + 0.5));
  softEllipse(b, cx, N * 0.74, N * 0.19, N * 0.1, base, deep, 255);
  // blush pads
  softEllipse(b, cx - N * 0.125, N * 0.5, N * 0.045, N * 0.026, blush, blush, 120);
  softEllipse(b, cx + N * 0.125, N * 0.5, N * 0.045, N * 0.026, blush, blush, 120);
  return b;
}
function maidenOutfit(style, hexC, dark) {
  const b = blank();
  const cx = N / 2;
  // shoulder band over the skin shoulders
  softEllipse(b, cx, N * 0.76, N * 0.21, N * 0.11, hexC, dark, 255);
  if (style === "sailor") {
    petal(b, cx - N * 0.02, N * 0.64, Math.PI * 0.72, N * 0.12, N * 0.05, "#eef2f6", "#c4cede", 255);
    petal(b, cx + N * 0.02, N * 0.64, Math.PI * 0.28, N * 0.12, N * 0.05, "#eef2f6", "#c4cede", 255);
    softEllipse(b, cx, N * 0.67, N * 0.02, N * 0.025, "#c4453a", "#9c352d", 255);
  } else if (style === "hoodie") {
    arc(b, cx, N * 0.66, N * 0.075, Math.PI * 0.15, Math.PI * 0.85, 4, dark, 255);
  } else if (style === "straps") {
    petal(b, cx - N * 0.09, N * 0.66, Math.PI * 0.62, N * 0.09, N * 0.02, dark, dark, 255);
    petal(b, cx + N * 0.09, N * 0.66, Math.PI * 0.38, N * 0.09, N * 0.02, dark, dark, 255);
  }
  return b;
}
function maidenHair(style, hexC, dark) {
  const b = blank();
  const cx = N / 2, hl = N * 0.33;               // hairline
  // Cap over the crown only. The first cut reached below the eyes, which put
  // hair colour all round them and read as a helmet with a face peeking out —
  // the forehead has to stay skin for the face to be a face.
  softEllipse(b, cx, N * 0.29, N * 0.215, N * 0.115, hexC, dark, 255);
  // carve nothing — bangs hang from the hairline as petals
  for (let k = -2; k <= 2; k++) {
    petal(b, cx + k * N * 0.055, hl - N * 0.045, Math.PI / 2 + k * 0.06, N * 0.06, N * 0.024, hexC, dark, 255);
  }
  if (style === "twintails") {
    [-1, 1].forEach(function (s) {
      const bx = cx + s * N * 0.23;
      petal(b, bx, N * 0.34, Math.PI / 2 - s * 0.22, N * 0.3, N * 0.05, hexC, dark, 255);
      petal(b, bx + s * N * 0.02, N * 0.36, Math.PI / 2 - s * 0.05, N * 0.26, N * 0.035, hexC, dark, 255);
      softEllipse(b, bx, N * 0.325, N * 0.02, N * 0.02, "#e5cf7a", "#c4a94f", 255);   // tie
    });
  } else if (style === "long") {
    [-1, 1].forEach(function (s) {
      petal(b, cx + s * N * 0.195, N * 0.36, Math.PI / 2 - s * 0.05, N * 0.36, N * 0.045, hexC, dark, 255);
      petal(b, cx + s * N * 0.16, N * 0.4, Math.PI / 2, N * 0.3, N * 0.03, hexC, dark, 255);
    });
  } else if (style === "bob") {
    [-1, 1].forEach(function (s) {
      petal(b, cx + s * N * 0.195, N * 0.36, Math.PI / 2 + s * 0.18, N * 0.17, N * 0.05, hexC, dark, 255);
    });
  } else if (style === "buns") {
    [-1, 1].forEach(function (s) {
      softEllipse(b, cx + s * N * 0.185, N * 0.24, N * 0.055, N * 0.055, hexC, dark, 255);
      softEllipse(b, cx + s * N * 0.185, N * 0.24, N * 0.03, N * 0.03, dark, hexC, 200);
    });
  }
  return b;
}
function animeEyes(irisTop, irisBot, style) {
  const b = blank();
  const ct = hex(irisTop), cb2 = hex(irisBot);
  const ey = N * 0.455, ex = N * 0.088, rx = N * 0.041, ry = N * 0.056;
  [N / 2 - ex, N / 2 + ex].forEach(function (cx) {
    // white
    softEllipse(b, cx, ey, rx + 2, ry + 2, "#ffffff", "#e8ecf2", 255);
    // iris: vertical gradient
    for (let y = ey - ry; y < ey + ry; y++) for (let x = cx - rx; x < cx + rx; x++) {
      const d = Math.hypot((x - cx) / rx, (y - ey) / ry);
      if (d >= 1) continue;
      const f = (y - (ey - ry)) / (2 * ry);
      put(b, x | 0, y | 0, ct[0] + (cb2[0] - ct[0]) * f, ct[1] + (cb2[1] - ct[1]) * f, ct[2] + (cb2[2] - ct[2]) * f,
          255 * Math.min(1, (1 - d) * 14));
    }
    // pupil, catchlights
    softEllipse(b, cx, ey + ry * 0.05, rx * 0.42, ry * 0.5, "#1d1a26", "#1d1a26", 255);
    softEllipse(b, cx - rx * 0.35, ey - ry * 0.4, rx * 0.3, ry * 0.22, "#ffffff", "#ffffff", 255);
    softEllipse(b, cx + rx * 0.4, ey + ry * 0.35, rx * 0.16, ry * 0.12, "#ffffff", "#ffffff", 220);
    if (style === "sparkle") softEllipse(b, cx + rx * 0.1, ey - ry * 0.05, rx * 0.1, ry * 0.08, "#ffffff", "#ffffff", 255);
    // upper lash
    arc(b, cx, ey - ry * 0.15, ry * 1.05, Math.PI * 1.12, Math.PI * 1.88, 2.6, "#1d1a26", 255);
    arc(b, cx + rx * 1.05, ey - ry * 0.6, ry * 0.28, Math.PI * 1.6, Math.PI * 2.1, 1.8, "#1d1a26", 255);
    if (style === "sleepy") {
      // lid: a skin-toned band over the top third
      softEllipse(b, cx, ey - ry * 0.75, rx + 3, ry * 0.5, "#f2ddc9", "#f2ddc9", 255);
      arc(b, cx, ey - ry * 0.5, ry * 0.9, Math.PI * 1.15, Math.PI * 1.85, 2.2, "#1d1a26", 255);
    }
  });
  // brows
  arc(b, N / 2 - ex, ey - ry * 1.7, ry * 0.5, Math.PI * 1.2, Math.PI * 1.8, 1.6, "#3a3040", 200);
  arc(b, N / 2 + ex, ey - ry * 1.7, ry * 0.5, Math.PI * 1.2, Math.PI * 1.8, 1.6, "#3a3040", 200);
  return b;
}
function maidenMouth(style) {
  const b = blank();
  const cx = N / 2, cy = N * 0.555;
  if (style === "smile") arc(b, cx, cy - N * 0.008, N * 0.017, 0.35, Math.PI - 0.35, 1.8, "#a35b6b", 255);
  else if (style === "o") softEllipse(b, cx, cy, N * 0.009, N * 0.011, "#a35b6b", "#7a3b4a", 255);
  else if (style === "pout") arc(b, cx, cy + N * 0.012, N * 0.014, Math.PI + 0.5, Math.PI * 2 - 0.5, 1.6, "#a35b6b", 255);
  else if (style === "cat") {
    arc(b, cx - N * 0.008, cy - N * 0.004, N * 0.008, 0.25, Math.PI - 0.25, 1.4, "#a35b6b", 255);
    arc(b, cx + N * 0.008, cy - N * 0.004, N * 0.008, 0.25, Math.PI - 0.25, 1.4, "#a35b6b", 255);
  }
  return b;
}
function maidenExtra(style) {
  const b = blank();
  if (style === "bow") {
    petal(b, N * 0.325, N * 0.27, Math.PI * 1.25, N * 0.05, N * 0.028, "#e58f9a", "#b06f7e", 255);
    petal(b, N * 0.325, N * 0.27, Math.PI * 0.1, N * 0.05, N * 0.028, "#e58f9a", "#b06f7e", 255);
    softEllipse(b, N * 0.325, N * 0.27, N * 0.014, N * 0.014, "#b06f7e", "#8f5764", 255);
  } else if (style === "choker") {
    arc(b, N / 2, N * 0.6, N * 0.052, Math.PI * 0.15, Math.PI * 0.85, 2.4, "#3a3542", 255);
    softEllipse(b, N / 2, N * 0.648, N * 0.008, N * 0.008, "#e5cf7a", "#c4a94f", 255);
  } else if (style === "halo") {
    ring(b, N / 2, N * 0.155, N * 0.075, 0.32, 0, 2.6, "#e5cf7a", 220);
  } else if (style === "sparkles") {
    glowOrb(b, N * 0.74, N * 0.3, N * 0.012, "#fff8d4", "#e5cf7a");
    glowOrb(b, N * 0.25, N * 0.62, N * 0.008, "#f6dce8", "#e88ab0");
    glowOrb(b, N * 0.78, N * 0.56, N * 0.007, "#eef8ff", "#7ab8c9");
  }
  return b;
}

console.log("drawing (512px raster takes a moment)…");

function moonMaidens() {
  return {
    file: "moon-maidens", name: "Moon Maidens",
    blurb: "Soft anime-chibi in raster \u2014 gradient irises with stacked catchlights, petal-drawn hair, blush baked in. The eyes are the point.",
    categories: [
      category("Ground", [
        trait("Blossom", 10, skyGradient("#3d2a38", "#5c4055", null)),
        trait("Cloud", 9, skyGradient("#2e3a4f", "#4a5c77", null)),
        trait("Matcha", 8, skyGradient("#2b382b", "#44573f", null)),
        trait("Cream", 7, skyGradient("#443c33", "#6e6152", null)),
        trait("Midnight", 5, skyGradient("#1a1a2b", "#2e2e4a", null))
      ]),
      category("Skin", [
        trait("Cream", 10, maidenSkin("#f6e3d1", "#dcc2ab", "#eda3ab")),
        trait("Peach", 9, maidenSkin("#eed0b5", "#d1ab8c", "#e58f9a")),
        trait("Honey", 8, maidenSkin("#d9ad84", "#b88c64", "#d97f8f")),
        trait("Cocoa", 7, maidenSkin("#9c6f4f", "#7d5738", "#b56676")),
        trait("Doll", 3, maidenSkin("#eeeaf4", "#ccc4da", "#d4a3c9"))
      ]),
      category("Outfit", [
        trait("Sailor", 9, maidenOutfit("sailor", "#8fa3c9", "#6e82a8")),
        trait("Rose Hoodie", 8, maidenOutfit("hoodie", "#d98f9e", "#b06f7e")),
        trait("Black Dress", 6, maidenOutfit("straps", "#3a3542", "#2b2733")),
        trait("Mint Knit", 6, maidenOutfit("hoodie", "#9ec9ab", "#7ea88a"))
      ]),
      category("Hair", [
        trait("Twintails Pink", 7, maidenHair("twintails", "#e8a8c4", "#c987a3")),
        trait("Twintails Blond", 6, maidenHair("twintails", "#e5d29a", "#c4b077")),
        trait("Long Black", 7, maidenHair("long", "#33303b", "#242229")),
        trait("Long Silver", 5, maidenHair("long", "#d4d4dc", "#b0b0bc")),
        trait("Bob Brown", 7, maidenHair("bob", "#8a5f43", "#6e4a32")),
        trait("Bob Lilac", 5, maidenHair("bob", "#c4a8e0", "#a387bf")),
        trait("Buns Black", 5, maidenHair("buns", "#33303b", "#242229"))
      ]),
      category("Eyes", [
        trait("Amber", 10, animeEyes("#8a5430", "#e0a86a", "plain")),
        trait("Sky", 8, animeEyes("#3a5c9c", "#9ec4ee", "plain")),
        trait("Rose", 7, animeEyes("#9c3a5c", "#ee9ec4", "plain")),
        trait("Emerald", 6, animeEyes("#2b6e4f", "#8fd4ab", "plain")),
        trait("Sparkle Violet", 4, animeEyes("#5c3a9c", "#c4a8ee", "sparkle")),
        trait("Sleepy", 3, animeEyes("#8a5430", "#e0a86a", "sleepy"))
      ]),
      category("Mouth", [
        trait("Smile", 10, maidenMouth("smile")),
        trait("O", 7, maidenMouth("o")),
        trait("Cat", 5, maidenMouth("cat")),
        trait("Pout", 4, maidenMouth("pout"))
      ]),
      category("Extras", [
        trait("None", 11, blank()),
        trait("Bow", 6, maidenExtra("bow")),
        trait("Choker", 5, maidenExtra("choker")),
        trait("Halo", 3, maidenExtra("halo")),
        trait("Sparkles", 4, maidenExtra("sparkles"))
      ])
    ]
  };
}

function moonSpirits() {
  return {
    file: "moon-spirits", name: "Moon Spirits",
    blurb: "Soft glowing ghosts \u2014 smooth domes, wavy hems, glossy eyes, a halo or a sprout. The raster character set.",
    categories: [
      category("Ground", [
        trait("Twilight", 10, skyGradient("#241d38", "#3d3355", null)),
        trait("Sea Glass", 9, skyGradient("#1d332e", "#2e554a", null)),
        trait("Rosewood", 8, skyGradient("#33202b", "#553844", null)),
        trait("Ink", 7, skyGradient("#14141f", "#242438", null)),
        trait("Honey Dusk", 5, skyGradient("#2b2214", "#554427", null))
      ]),
      category("Spirit", [
        trait("Mint", 10, spiritBody("#b8e8d4", "#6aa88f", "#e8fff4", 255)),
        trait("Lilac", 9, spiritBody("#d4c4ee", "#907ec4", "#f4eeff", 255)),
        trait("Peach", 8, spiritBody("#f6d4be", "#c99277", "#fff0e4", 255)),
        trait("Ice", 7, spiritBody("#c4e0f6", "#7ea8cf", "#eef8ff", 255)),
        trait("Phantom", 3, spiritBody("#f0f0f4", "#b0b0c4", "#ffffff", 200))
      ]),
      category("Eyes", [
        trait("Round", 10, spiritEyes("round")),
        trait("Wide", 8, spiritEyes("wide")),
        trait("Sleepy", 6, spiritEyes("sleepy")),
        trait("Star", 4, spiritEyes("star"))
      ]),
      category("Mouth", [
        trait("Smile", 10, spiritMouth("smile")),
        trait("O", 7, spiritMouth("o")),
        trait("Cat", 5, spiritMouth("cat")),
        trait("None", 4, blank())
      ]),
      category("Blush", [
        trait("Rose", 9, spiritBlush("#e58f9a")),
        trait("Coral", 6, spiritBlush("#e5a37a")),
        trait("None", 7, blank())
      ]),
      category("Charm", [
        trait("None", 10, spiritCharm("none")),
        trait("Halo", 6, spiritCharm("halo")),
        trait("Sprout", 6, spiritCharm("sprout")),
        trait("Stars", 4, spiritCharm("star")),
        trait("Crown", 3, spiritCharm("crown"))
      ])
    ]
  };
}

function lunarDrift() {
  return {
    file: "lunar-drift", name: "Lunar Drift",
    blurb: "Raster, not pixel: gradient skies, glowing moons, auroras and a noise-drawn horizon. Landscapes, no characters.",
    categories: [
      category("Sky", [
        trait("Dusk", 10, skyGradient("#1a1633", "#4f3a5c", "#c96a4f")),
        trait("Night", 10, skyGradient("#0a0d1a", "#1d2438", null)),
        trait("Nebula", 8, skyGradient("#12102b", "#3a2f5c", "#7a4fa3")),
        trait("Dawn", 6, skyGradient("#1d2438", "#7a5c4f", "#c99a4f")),
        trait("Void", 4, skyGradient("#060609", "#101018", null))
      ]),
      category("Stars", [
        trait("Sparse", 10, stars(60, "#e6e2d6")),
        trait("Dense", 8, stars(200, "#e6e2d6")),
        trait("Warm", 5, stars(120, "#e5cf9a")),
        trait("None", 5, blank())
      ]),
      category("Aurora", [
        trait("None", 12, blank()),
        trait("Green", 6, aurora("#4fdc94", 0.4)),
        trait("Violet", 5, aurora("#a37adc", 2.1)),
        trait("Lime", 3, aurora("#cdfd37", 4.2))
      ]),
      category("Body", [
        trait("Cratered Moon", 10, moon(N * 0.62, N * 0.34, N * 0.17, "#ddd8cc", "#8a8578", "#e6e2d6", { craters: true })),
        trait("Blood Moon", 6, moon(N * 0.62, N * 0.34, N * 0.17, "#c96a4f", "#7a3b2e", "#c96a4f", { craters: true })),
        trait("Ringed Giant", 6, moon(N * 0.38, N * 0.3, N * 0.15, "#c9b28a", "#8a7355", "#e5cf9a", { ring: "#e5cf9a" })),
        trait("Ice Giant", 5, moon(N * 0.62, N * 0.3, N * 0.19, "#7ab8c9", "#4f7a8a", "#a8dbe8", {})),
        trait("Twin Moons", 4, (function () {
          const b = moon(N * 0.7, N * 0.28, N * 0.11, "#ddd8cc", "#8a8578", "#e6e2d6", { craters: true });
          const b2 = moon(N * 0.45, N * 0.42, N * 0.06, "#c9a3a8", "#8a6a78", "#e8b7c1", {});
          for (let i = 0; i < b.length; i += 4) {
            if (b2[i + 3]) {
              const sa = b2[i + 3] / 255;
              b[i] = b2[i] * sa + b[i] * (1 - sa);
              b[i + 1] = b2[i + 1] * sa + b[i + 1] * (1 - sa);
              b[i + 2] = b2[i + 2] * sa + b[i + 2] * (1 - sa);
              b[i + 3] = Math.max(b[i + 3], b2[i + 3]);
            }
          }
          return b;
        })())
      ]),
      category("Horizon", [
        trait("Dunes", 10, ridge("#3a3348", "#171420", N * 0.22, 5)),
        trait("Peaks", 8, ridge("#2c3340", "#12161d", N * 0.34, 11)),
        trait("Flats", 6, ridge("#33302b", "#14120e", N * 0.14, 23)),
        trait("Crags", 5, ridge("#3d2f38", "#170f14", N * 0.4, 47))
      ])
    ]
  };
}

function nightBlooms() {
  return {
    file: "night-blooms", name: "Night Blooms",
    blurb: "Procedural flowers — petal counts, colourways and glowing cores on deep grounds. Organic, and nothing like the portraits.",
    categories: [
      category("Ground", [
        trait("Ink", 10, skyGradient("#101018", "#1d1d2b", null)),
        trait("Forest", 9, skyGradient("#0e1a14", "#1d332a", null)),
        trait("Wine", 8, skyGradient("#1d0e14", "#38202b", null)),
        trait("Midnight", 7, skyGradient("#0a0d1a", "#141d38", null)),
        trait("Ember", 5, skyGradient("#1a0e0a", "#332017", null))
      ]),
      category("Stem", [
        trait("Green", 10, (function () { const b = blank(); stemAndLeaves(b, "#4f7a4a", "#31482e"); return b; })()),
        trait("Teal", 7, (function () { const b = blank(); stemAndLeaves(b, "#4a7a72", "#2e4844"); return b; })()),
        trait("None", 5, blank())
      ]),
      category("Bloom", [
        trait("Rose 6", 10, (function () { const b = blank(); bloom(b, 6, "#e88ab0", "#a34f7a", "#f6dce8", "#e88ab0", 3); return b; })()),
        trait("Lotus 8", 8, (function () { const b = blank(); bloom(b, 8, "#e8d4a8", "#b0925c", "#faf3e0", "#e8d4a8", 7); return b; })()),
        trait("Iris 5", 7, (function () { const b = blank(); bloom(b, 5, "#a38ae8", "#5c4fa3", "#e4dcf6", "#a38ae8", 11); return b; })()),
        trait("Dahlia 12", 6, (function () { const b = blank(); bloom(b, 12, "#e8946a", "#a3543a", "#f6e0d4", "#e8946a", 13); return b; })()),
        trait("Ghost 7", 4, (function () { const b = blank(); bloom(b, 7, "#dfe8ea", "#8fa3a8", "#ffffff", "#bcd4d8", 17); return b; })()),
        trait("Lime 9", 3, (function () { const b = blank(); bloom(b, 9, "#cdfd37", "#7a9c1f", "#f0ffc4", "#cdfd37", 19); return b; })())
      ]),
      category("Air", [
        trait("Still", 10, blank()),
        trait("Fireflies", 6, (function () { const b = blank(); seed = 41;
          for (let k = 0; k < 14; k++) glowOrb(b, rnd() * N, rnd() * N * 0.8, 2.5, "#f6ffd4", "#cdfd37");
          return b; })()),
        trait("Pollen", 5, (function () { const b = blank(); seed = 43;
          for (let k = 0; k < 22; k++) glowOrb(b, rnd() * N, rnd() * N, 1.5, "#f6e8c4", "#e5cf9a");
          return b; })()),
        trait("Rain", 4, (function () { const b = blank(); const c = hex("#8fa3c9"); seed = 47;
          for (let k = 0; k < 60; k++) { const x = rnd() * N, y = rnd() * N;
            for (let j = 0; j < 8; j++) put(b, (x + j * 0.3) | 0, (y + j) | 0, c[0], c[1], c[2], 90 - j * 10); }
          return b; })())
      ])
    ]
  };
}

function orbitals() {
  function system(tilt, tint, tint2, jitter) {
    const b = blank();
    const cx = N / 2, cy = N / 2;
    seed = jitter;
    ring(b, cx, cy, N * 0.34, 0.38, tilt, 1.2, tint, 180);
    ring(b, cx, cy, N * 0.24, 0.38, tilt, 1.0, tint2, 150);
    ring(b, cx, cy, N * 0.42, 0.38, tilt, 0.8, tint, 110);
    comet(b, cx, cy, N * 0.34, 0.38, tilt, rnd() * Math.PI * 2, tint);
    comet(b, cx, cy, N * 0.24, 0.38, tilt, rnd() * Math.PI * 2, tint2);
    return b;
  }
  return {
    file: "orbitals", name: "Orbitals",
    blurb: "Generative ring systems — a glowing core, tilted orbits, comets mid-flight. The abstract one.",
    categories: [
      category("Field", [
        trait("Deep", 10, skyGradient("#0a0a12", "#12121f", null)),
        trait("Haze", 8, skyGradient("#12101f", "#241d33", null)),
        trait("Carbon", 7, skyGradient("#0d0d0d", "#1a1a1c", null)),
        trait("Abyss", 5, skyGradient("#060912", "#0a1424", null))
      ]),
      category("Dust", [
        trait("Fine", 10, stars(140, "#c9c9d4")),
        trait("Coarse", 7, stars(50, "#e6e2d6")),
        trait("None", 6, blank())
      ]),
      category("Core", [
        trait("White Dwarf", 10, (function () { const b = blank(); glowOrb(b, N / 2, N / 2, N * 0.06, "#ffffff", "#c9d4e8"); return b; })()),
        trait("Ember Core", 8, (function () { const b = blank(); glowOrb(b, N / 2, N / 2, N * 0.07, "#f6d4a8", "#e8946a"); return b; })()),
        trait("Lime Core", 5, (function () { const b = blank(); glowOrb(b, N / 2, N / 2, N * 0.065, "#f0ffc4", "#cdfd37"); return b; })()),
        trait("Void Core", 3, (function () { const b = blank();
          const c = hex("#0a0a12");
          for (let y = N / 2 - N * 0.06; y < N / 2 + N * 0.06; y++) for (let x = N / 2 - N * 0.06; x < N / 2 + N * 0.06; x++) {
            const d = Math.hypot(x - N / 2, y - N / 2) / (N * 0.055);
            if (d < 1) put(b, x | 0, y | 0, c[0], c[1], c[2], 255 * Math.min(1, (1 - d) * 6 + 0.4));
          }
          ring(b, N / 2, N / 2, N * 0.062, 1, 0, 1.4, "#a37adc", 220);
          return b; })())
      ]),
      category("Orbits", [
        trait("Silver Tilt", 10, system(0.5, "#c9c9d4", "#8fa3c9", 3)),
        trait("Amber Tilt", 8, system(2.6, "#e5cf9a", "#e8946a", 5)),
        trait("Violet Flat", 7, system(0.05, "#a37adc", "#e88ab0", 7)),
        trait("Lime Steep", 5, system(1.1, "#cdfd37", "#7ae0e0", 11))
      ])
    ]
  };
}

fs.mkdirSync(OUT, { recursive: true });
const idxPath = path.join(OUT, "index.json");
const idx = JSON.parse(fs.readFileSync(idxPath, "utf8"));

[lunarDrift, nightBlooms, orbitals, moonSpirits].forEach(function (make) {
  const r = make();
  const project = {
    id: uid(), name: r.name,
    canvas: { mode: "raster", pixel: 48, raster: N },
    supply: 500, seed: 1337, ones: [], rules: [],
    categories: r.categories
  };
  const doc = { kind: "moonpad-project", version: 1, savedAt: new Date().toISOString(), project: project };
  const file = path.join(OUT, r.file + ".moonpad.json");
  fs.writeFileSync(file, JSON.stringify(doc));
  const combos = project.categories.reduce(function (a, c) { return a * c.traits.length; }, 1);
  const traits = project.categories.reduce(function (a, c) { return a + c.traits.length; }, 0);
  idx.templates = idx.templates.filter(function (t2) { return t2.file !== r.file + ".moonpad.json"; });
  idx.templates.push({
    file: r.file + ".moonpad.json", name: r.name, blurb: r.blurb,
    categories: project.categories.length, traits: traits, combinations: combos
  });
  console.log("  " + r.name.padEnd(14) + project.categories.length + " cats  " +
              String(traits).padStart(2) + " traits  " + combos.toLocaleString().padStart(6) +
              " combos  " + (fs.statSync(file).size / 1024 / 1024).toFixed(1) + " MB");
});

fs.writeFileSync(idxPath, JSON.stringify(idx, null, 2));
console.log("  index.json updated");
