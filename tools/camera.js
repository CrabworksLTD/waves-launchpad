"use strict";
// Camera for the showcase: a rotatable, motion-blurred view onto a capture,
// plus the transition effects between beats.
//
// The first cut framed each beat as a straight push-in and hard-cut to the next.
// That reads as a slideshow. What makes it feel shot rather than assembled is
// that the camera is never square and never still, and that beats are joined by
// a move rather than a cut.

const mix = function (a, b, t) { return a + (b - a) * t; };

// back-out: overshoots the target then settles. A move that arrives and stops
// dead looks mechanical; a little overshoot reads as weight.
function backOut(t, amount) {
  const c = amount === undefined ? 1.34 : amount;
  const p = t - 1;
  return 1 + (c + 1) * p * p * p + c * p * p;
}
function inOutCubic(t) {
  return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
}

// Sample a rotated rectangle of the source into the frame. Bilinear, because
// this is UI type at arbitrary zoom and rotation — nearest sampling shreds it.
function sample(buf, W, H, shot, cam, weight, acc) {
  const ar = W / H;
  let cw = cam.w, ch = cam.w / ar;
  const cos = Math.cos(cam.rot), sin = Math.sin(cam.rot);
  for (let y = 0; y < H; y++) {
    const v = (y / H - 0.5) * ch;
    for (let x = 0; x < W; x++) {
      const u = (x / W - 0.5) * cw;
      const sx = cam.x + u * cos - v * sin;
      const sy = cam.y + u * sin + v * cos;
      const ix = Math.max(0, Math.min(shot.width - 2, Math.floor(sx)));
      const iy = Math.max(0, Math.min(shot.height - 2, Math.floor(sy)));
      const fx = Math.max(0, Math.min(1, sx - ix)), fy = Math.max(0, Math.min(1, sy - iy));
      const d = (y * W + x) * 4;
      for (let c = 0; c < 3; c++) {
        const p00 = shot.data[(iy * shot.width + ix) * 4 + c];
        const p10 = shot.data[(iy * shot.width + ix + 1) * 4 + c];
        const p01 = shot.data[((iy + 1) * shot.width + ix) * 4 + c];
        const p11 = shot.data[((iy + 1) * shot.width + ix + 1) * 4 + c];
        acc[d + c] += mix(mix(p00, p10, fx), mix(p01, p11, fx), fy) * weight;
      }
    }
  }
}

// Several samples along the camera's path, averaged. During a fast move that is
// motion blur; standing still it costs one sample and changes nothing.
function render(buf, W, H, shots, camA, camB, blurSteps) {
  const n = Math.max(1, blurSteps | 0);
  const acc = new Float32Array(W * H * 4);
  for (let i = 0; i < n; i++) {
    const t = n === 1 ? 1 : i / (n - 1);
    const cam = {
      x: mix(camA.cam.x, camB.cam.x, t), y: mix(camA.cam.y, camB.cam.y, t),
      w: mix(camA.cam.w, camB.cam.w, t), rot: mix(camA.cam.rot, camB.cam.rot, t)
    };
    // cross-dissolve when the two ends sit on different captures
    if (camA.shot === camB.shot) {
      sample(acc, W, H, shots[camA.shot], cam, 1 / n, acc);
    } else {
      sample(acc, W, H, shots[camA.shot], cam, (1 - t) / n, acc);
      sample(acc, W, H, shots[camB.shot], cam, t / n, acc);
    }
  }
  for (let i = 0; i < W * H; i++) {
    buf[i * 4] = Math.min(255, acc[i * 4]);
    buf[i * 4 + 1] = Math.min(255, acc[i * 4 + 1]);
    buf[i * 4 + 2] = Math.min(255, acc[i * 4 + 2]);
    buf[i * 4 + 3] = 255;
  }
}

// RGB split plus a few displaced scanline bands. Used for two or three frames on
// a cut, which is what sells it as an edit rather than a dropped frame.
function glitch(buf, W, H, amount, seed) {
  if (amount <= 0) return;
  let s = (seed | 0) || 1;
  const rnd = function () { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
  const src = buf.slice();
  const shift = Math.round(amount * 14);

  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const d = (y * W + x) * 4;
      const rx = Math.max(0, Math.min(W - 1, x - shift));
      const bx = Math.max(0, Math.min(W - 1, x + shift));
      buf[d] = src[(y * W + rx) * 4];
      buf[d + 2] = src[(y * W + bx) * 4 + 2];
    }
  }
  const bands = Math.round(amount * 7);
  for (let i = 0; i < bands; i++) {
    const by = Math.floor(rnd() * H), bh = 2 + Math.floor(rnd() * 14);
    const off = Math.round((rnd() * 2 - 1) * amount * 46);
    for (let y = by; y < Math.min(H, by + bh); y++) {
      for (let x = 0; x < W; x++) {
        const sx = Math.max(0, Math.min(W - 1, x + off));
        const d = (y * W + x) * 4, o = (y * W + sx) * 4;
        buf[d] = src[o]; buf[d + 1] = src[o + 1]; buf[d + 2] = src[o + 2];
      }
    }
  }
}

// darkens the corners so the eye stays where the camera is pointed
function vignette(buf, W, H, strength) {
  const cx = W / 2, cy = H / 2, max = Math.hypot(cx, cy);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const d = (y * W + x) * 4;
    const f = 1 - strength * Math.pow(Math.hypot(x - cx, y - cy) / max, 2.1);
    buf[d] *= f; buf[d + 1] *= f; buf[d + 2] *= f;
  }
}

module.exports = { render, glitch, vignette, backOut, inOutCubic, mix };
