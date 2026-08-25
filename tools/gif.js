"use strict";
// Minimal animated GIF writer. No dependencies — there is no ffmpeg, gifski or
// imagemagick on this machine, and GIF is the right container anyway: the art is
// flat colour, so a 256-entry palette is lossless for it, and X converts GIF to
// video on upload.
//
//   const g = new Gif(width, height);
//   g.add(rgbaUint8Array, delayCentiseconds);
//   fs.writeFileSync("out.gif", g.end());

// ---------------------------------------------------------------- quantise
// Median cut. Flat pixel art usually lands well under 256 colours and comes out
// exact; screenshots of the app have gradients and antialiasing, and those need
// reducing. Splitting on the widest channel keeps the error where the eye is
// least likely to find it.
function quantise(pixels, max) {
  const seen = new Map();
  for (let i = 0; i < pixels.length; i += 4) {
    const k = (pixels[i] << 16) | (pixels[i + 1] << 8) | pixels[i + 2];
    seen.set(k, (seen.get(k) || 0) + 1);
  }
  if (seen.size <= max) {
    const pal = [...seen.keys()].map(function (k) { return [k >> 16 & 255, k >> 8 & 255, k & 255]; });
    return pal;
  }

  let boxes = [[...seen.keys()].map(function (k) {
    return { r: k >> 16 & 255, g: k >> 8 & 255, b: k & 255, n: seen.get(k) };
  })];

  while (boxes.length < max) {
    // split the box with the widest spread, not simply the biggest — a large
    // box of near-identical colours gains nothing from being cut
    let target = -1, spread = -1, chan = "r";
    boxes.forEach(function (box, i) {
      if (box.length < 2) return;
      ["r", "g", "b"].forEach(function (c) {
        let lo = 255, hi = 0;
        for (const p of box) { if (p[c] < lo) lo = p[c]; if (p[c] > hi) hi = p[c]; }
        if (hi - lo > spread) { spread = hi - lo; target = i; chan = c; }
      });
    });
    if (target < 0) break;

    const box = boxes[target];
    box.sort(function (a, b) { return a[chan] - b[chan]; });
    // split at the weighted median so both halves carry similar pixel counts
    const total = box.reduce(function (s, p) { return s + p.n; }, 0);
    let run = 0, cut = 1;
    for (let i = 0; i < box.length - 1; i++) {
      run += box[i].n;
      if (run >= total / 2) { cut = i + 1; break; }
    }
    boxes.splice(target, 1, box.slice(0, cut), box.slice(cut));
  }

  return boxes.filter(function (b) { return b.length; }).map(function (box) {
    let r = 0, g = 0, b = 0, n = 0;
    for (const p of box) { r += p.r * p.n; g += p.g * p.n; b += p.b * p.n; n += p.n; }
    return [Math.round(r / n), Math.round(g / n), Math.round(b / n)];
  });
}

function indexer(pal) {
  const cache = new Map();
  return function (r, g, b) {
    const k = (r << 16) | (g << 8) | b;
    const hit = cache.get(k);
    if (hit !== undefined) return hit;
    let best = 0, bd = Infinity;
    for (let i = 0; i < pal.length; i++) {
      const dr = r - pal[i][0], dg = g - pal[i][1], db = b - pal[i][2];
      // rough luma weighting: the eye is far more sensitive to green than blue
      const d = dr * dr * 3 + dg * dg * 6 + db * db;
      if (d < bd) { bd = d; best = i; }
    }
    cache.set(k, best);
    return best;
  };
}

// ---------------------------------------------------------------- LZW
function lzw(indices, minCode) {
  const clear = 1 << minCode, eoi = clear + 1;
  let size = minCode + 1, next = eoi + 1;
  let dict = new Map();
  const reset = function () {
    dict = new Map(); next = eoi + 1; size = minCode + 1;
  };

  const out = [];
  let cur = 0, bits = 0;
  const emit = function (code) {
    cur |= code << bits; bits += size;
    while (bits >= 8) { out.push(cur & 255); cur >>= 8; bits -= 8; }
  };

  emit(clear);
  let prefix = indices[0];
  for (let i = 1; i < indices.length; i++) {
    const c = indices[i];
    const key = prefix * 4096 + c;
    if (dict.has(key)) { prefix = dict.get(key); continue; }
    emit(prefix);
    dict.set(key, next++);
    if (next > 4095) { emit(clear); reset(); }
    else if (next > (1 << size) && size < 12) size++;
    prefix = c;
  }
  emit(prefix);
  emit(eoi);
  if (bits > 0) out.push(cur & 255);
  return out;
}

// ---------------------------------------------------------------- writer
class Gif {
  constructor(width, height) {
    this.w = width; this.h = height;
    this.frames = [];
  }

  add(rgba, delay) {
    this.frames.push({ rgba: rgba, delay: delay || 4 });
  }

  end() {
    if (!this.frames.length) throw new Error("no frames");

    // One palette for the whole animation. Per-frame local palettes would track
    // colour better but every frame then carries its own 768-byte table, and the
    // wall-of-characters frames share nearly all their colours anyway.
    const sample = Buffer.concat(this.frames.map(function (f) { return Buffer.from(f.rgba); }));
    const pal = quantise(sample, 256);
    while (pal.length < 2) pal.push([0, 0, 0]);
    const toIndex = indexer(pal);

    let depth = 1;
    while ((1 << depth) < pal.length) depth++;
    const palSize = 1 << depth;

    const bytes = [];
    const push = function (a) { for (const b of a) bytes.push(b); };
    const u16 = function (n) { return [n & 255, (n >> 8) & 255]; };

    push([0x47, 0x49, 0x46, 0x38, 0x39, 0x61]);              // GIF89a
    push(u16(this.w)); push(u16(this.h));
    push([0x80 | ((depth - 1) & 7), 0, 0]);                   // global table, depth
    for (let i = 0; i < palSize; i++) {
      const c = pal[i] || [0, 0, 0];
      push([c[0], c[1], c[2]]);
    }

    // NETSCAPE2.0 — the only way to say "loop forever"
    push([0x21, 0xFF, 11]);
    push([...Buffer.from("NETSCAPE2.0")]);
    push([3, 1, 0, 0, 0]);

    const minCode = Math.max(2, depth);
    for (const f of this.frames) {
      push([0x21, 0xF9, 4, 0x04, f.delay & 255, (f.delay >> 8) & 255, 0, 0]);
      push([0x2C]); push(u16(0)); push(u16(0)); push(u16(this.w)); push(u16(this.h)); push([0]);

      const idx = new Uint8Array(this.w * this.h);
      for (let i = 0, p = 0; i < f.rgba.length; i += 4, p++) {
        idx[p] = toIndex(f.rgba[i], f.rgba[i + 1], f.rgba[i + 2]);
      }
      const data = lzw(idx, minCode);
      push([minCode]);
      for (let i = 0; i < data.length; i += 255) {
        const chunk = data.slice(i, i + 255);
        push([chunk.length]); push(chunk);
      }
      push([0]);
    }

    push([0x3B]);
    return Buffer.from(bytes);
  }
}

module.exports = { Gif, quantise };
