"use strict";
// Stamp-based raster brush engine.
//
// Strokes are drawn by stamping a brush tip along the path at a fixed spacing
// rather than using canvas lineTo, which is what gives pressure response,
// texture and soft edges. Each stroke is composited into a scratch layer first
// so that stroke opacity stays flat — otherwise overlapping stamps within one
// stroke darken where the pointer moved slowly.

const Brush = (function () {

  // ---------- brush tips ----------
  // A tip is a small offscreen canvas holding a white shape with alpha. It gets
  // tinted at stamp time, so one tip serves every color.
  function makeTip(size, hardness, kind) {
    const s = Math.max(2, Math.ceil(size));
    const c = document.createElement("canvas");
    c.width = c.height = s;
    const x = c.getContext("2d");
    const r = s / 2;

    if (kind === "square") {
      x.fillStyle = "#fff";
      x.fillRect(0, 0, s, s);
      return c;
    }

    // hardness 1 = crisp disc, 0 = fully feathered. A single radial gradient
    // reads as plastic, so the falloff is eased.
    const g = x.createRadialGradient(r, r, 0, r, r, r);
    const h = Math.max(0, Math.min(1, hardness));
    g.addColorStop(0, "rgba(255,255,255,1)");
    if (h > 0) g.addColorStop(h * 0.92, "rgba(255,255,255,1)");
    g.addColorStop(Math.min(1, h * 0.92 + (1 - h) * 0.45 + 0.001), "rgba(255,255,255,0.55)");
    g.addColorStop(1, "rgba(255,255,255,0)");
    x.fillStyle = g;
    x.beginPath();
    x.arc(r, r, r, 0, Math.PI * 2);
    x.fill();

    if (kind === "pencil" || kind === "chalk") {
      // knock holes in the tip so the stroke breaks up like graphite
      const im = x.getImageData(0, 0, s, s);
      const d = im.data;
      const density = kind === "pencil" ? 0.42 : 0.6;
      for (let i = 0; i < d.length; i += 4) {
        if (Math.random() < density) d[i + 3] = d[i + 3] * (0.15 + Math.random() * 0.5);
      }
      x.putImageData(im, 0, 0);
    }
    return c;
  }

  const tipCache = new Map();
  function tip(size, hardness, kind) {
    // pencil/chalk are randomised, so they must not be cached or the noise
    // pattern repeats visibly along the stroke
    if (kind === "pencil" || kind === "chalk") return makeTip(size, hardness, kind);
    const key = Math.round(size) + "|" + Math.round(hardness * 20) + "|" + kind;
    let t = tipCache.get(key);
    if (!t) { t = makeTip(size, hardness, kind); tipCache.set(key, t); }
    return t;
  }

  // ---------- presets ----------
  const PRESETS = {
    hard:    { label: "Hard round", kind: "round",  hardness: 1.00, spacing: 0.10, flow: 1.00, sizePressure: 0.55, flowPressure: 0.15 },
    soft:    { label: "Soft round", kind: "round",  hardness: 0.15, spacing: 0.06, flow: 0.55, sizePressure: 0.40, flowPressure: 0.55 },
    pencil:  { label: "Pencil",     kind: "pencil", hardness: 0.85, spacing: 0.08, flow: 0.75, sizePressure: 0.25, flowPressure: 0.70 },
    marker:  { label: "Marker",     kind: "square", hardness: 1.00, spacing: 0.14, flow: 0.80, sizePressure: 0.00, flowPressure: 0.10 },
    chalk:   { label: "Chalk",      kind: "chalk",  hardness: 0.60, spacing: 0.10, flow: 0.85, sizePressure: 0.35, flowPressure: 0.60 },
    airbrush:{ label: "Airbrush",   kind: "round",  hardness: 0.02, spacing: 0.04, flow: 0.14, sizePressure: 0.20, flowPressure: 0.80 }
  };

  // ---------- engine ----------
  function Engine(target) {
    this.target = target;                 // destination canvas
    this.tctx = target.getContext("2d");
    this.scratch = document.createElement("canvas");
    this.scratch.width = target.width;
    this.scratch.height = target.height;
    this.sctx = this.scratch.getContext("2d");

    this.preset = "hard";
    this.size = 24;
    this.opacity = 1;                     // whole-stroke alpha
    this.color = "#141414";
    this.erasing = false;
    this.usePressure = true;

    this.drawing = false;
    this.last = null;
    this.carry = 0;                       // leftover distance between samples
  }

  Engine.prototype.settings = function () {
    return PRESETS[this.preset] || PRESETS.hard;
  };

  Engine.prototype.resize = function (w, h) {
    this.scratch.width = w;
    this.scratch.height = h;
  };

  Engine.prototype.begin = function (pt) {
    this.drawing = true;
    this.last = pt;
    this.carry = 0;
    this.sctx.clearRect(0, 0, this.scratch.width, this.scratch.height);
    this.stamp(pt);
  };

  Engine.prototype.stamp = function (pt) {
    const s = this.settings();
    const press = this.usePressure ? (pt.p == null ? 0.5 : pt.p) : 1;

    const size = Math.max(1, this.size * (1 - s.sizePressure + s.sizePressure * (press * 2)));
    const flow = Math.max(0, Math.min(1,
      s.flow * (1 - s.flowPressure + s.flowPressure * (press * 2))));

    const t = tip(size, s.hardness, s.kind);
    const c = this.sctx;
    c.save();
    c.globalAlpha = flow;
    // tint the white tip with the chosen color
    c.globalCompositeOperation = "source-over";
    c.drawImage(t, pt.x - t.width / 2, pt.y - t.height / 2);
    c.globalCompositeOperation = "source-in";
    c.globalAlpha = 1;
    c.fillStyle = this.color;
    c.fillRect(0, 0, this.scratch.width, this.scratch.height);
    c.restore();
  };

  // Stamping with source-in above would wipe earlier stamps, so each stamp goes
  // through its own small buffer and is merged into the scratch layer.
  Engine.prototype.stampMerged = function (pt) {
    const s = this.settings();
    const press = this.usePressure ? (pt.p == null ? 0.5 : pt.p) : 1;
    const size = Math.max(1, this.size * (1 - s.sizePressure + s.sizePressure * (press * 2)));
    const flow = Math.max(0, Math.min(1,
      s.flow * (1 - s.flowPressure + s.flowPressure * (press * 2))));

    const t = tip(size, s.hardness, s.kind);
    const buf = Engine._buf || (Engine._buf = document.createElement("canvas"));
    buf.width = t.width; buf.height = t.height;
    const b = buf.getContext("2d");
    b.clearRect(0, 0, buf.width, buf.height);
    b.drawImage(t, 0, 0);
    b.globalCompositeOperation = "source-in";
    b.fillStyle = this.color;
    b.fillRect(0, 0, buf.width, buf.height);

    this.sctx.globalAlpha = flow;
    this.sctx.drawImage(buf, pt.x - buf.width / 2, pt.y - buf.height / 2);
    this.sctx.globalAlpha = 1;
  };

  Engine.prototype.move = function (pt) {
    if (!this.drawing) return;
    const s = this.settings();
    const step = Math.max(0.5, this.size * s.spacing);
    let a = this.last;
    const dx = pt.x - a.x, dy = pt.y - a.y;
    const dist = Math.hypot(dx, dy);
    if (dist < 0.01) return;

    let d = this.carry;
    while (d <= dist) {
      const f = d / dist;
      this.stampMerged({
        x: a.x + dx * f,
        y: a.y + dy * f,
        p: (a.p == null ? 0.5 : a.p) + ((pt.p == null ? 0.5 : pt.p) - (a.p == null ? 0.5 : a.p)) * f
      });
      d += step;
    }
    this.carry = d - dist;
    this.last = pt;
  };

  // Flatten the stroke onto the target at the stroke opacity. Doing it once at
  // the end is what keeps a slow stroke from building up darker than a fast one.
  Engine.prototype.end = function () {
    if (!this.drawing) return;
    this.drawing = false;
    const c = this.tctx;
    c.save();
    c.globalAlpha = this.opacity;
    c.globalCompositeOperation = this.erasing ? "destination-out" : "source-over";
    c.drawImage(this.scratch, 0, 0);
    c.restore();
    this.sctx.clearRect(0, 0, this.scratch.width, this.scratch.height);
  };

  Engine.prototype.presets = function () { return PRESETS; };

  return { Engine: Engine, PRESETS: PRESETS, makeTip: makeTip };
})();

if (typeof module !== "undefined") module.exports = Brush;
