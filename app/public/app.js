"use strict";
// Editor shell: binds the project model to the canvas and the rails.
//
// A trait is a stack of layers. Each layer is its own offscreen canvas; the
// visible surface is a composite of the onion guide, then those layers at their
// opacities. Drawing always targets the active layer, never the surface, so
// layer opacity stays live rather than being baked in.

(function () {
  var surface = document.getElementById("surface");
  var view = surface.getContext("2d");
  var toastEl = document.getElementById("toast");

  var P = Project.blank();
  var sel = null;
  var mode = "pixel";
  var tool = "draw";
  var color = "#141414";
  var onion = true;
  var mirror = false;
  var moveSrc = null, moveStart = null;   // Move tool: layer snapshot + drag origin
  var pixelSize = 1;              // pencil width in cells, pixel mode
  var gridOn = true;
  var engine = null;
  // Undo snapshots are ImageData at one resolution, so a 48px pixel-mode
  // snapshot cannot be restored onto a 1024px brush layer. Keeping a stack per
  // mode-and-size means switching modes no longer throws the history away —
  // switch back and your pixel history is still there.
  var stacks = {};
  var changeCbs = [];
  var dragId = null;
  // which traits have their color list expanded, by trait id
  var openCols = {};

  var layers = [];                // [{canvas, ctx, meta}]
  var active = 0;
  var guide = null;               // offscreen composite of other categories

  function px() { return mode === "pixel" ? P.canvas.pixel : P.canvas.raster; }
  // The canvas height for a given width. Square unless the project chose the
  // paper shape — A4's portrait ratio, one to root two.
  function pxH(n) {
    n = n || px();
    return P && P.canvas && P.canvas.aspect === "paper" ? Math.round(n * Math.SQRT2) : n;
  }
  function cur() { return sel ? Project.find(P, sel) : null; }

  // Template names and blurbs come out of a fetched file. Ours today, but it
  // reaches innerHTML, and "we wrote that file" is not a property the code can
  // check.
  function esc(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  }

  function toast(msg) {
    toastEl.textContent = msg;
    toastEl.classList.add("show");
    clearTimeout(toast._t);
    toast._t = setTimeout(function () { toastEl.classList.remove("show"); }, 1600);
  }

  function mkCanvas(n) {
    var c = document.createElement("canvas");
    c.width = n;
    c.height = pxH(n);
    return c;
  }

  // ---------- layer stack ----------
  function blankLayer(name) {
    return { id: Project.uid(), name: name || "Pass", opacity: 1, visible: true, image: null };
  }

  function loadLayers(slot) {
    var n = px();
    if (!slot.layers || !slot.layers.length) {
      slot.layers = [blankLayer("Base")];
      if (slot.image) slot.layers[0].image = slot.image;   // migrate flat drawings
    }
    layers = slot.layers.map(function (m) {
      var c = mkCanvas(n);
      var x = c.getContext("2d", { willReadFrequently: true });
      x.imageSmoothingEnabled = mode !== "pixel";
      if (m.image) {
        var im = new Image();
        im.onload = function () { x.drawImage(im, 0, 0, n, pxH(n)); redraw(); };
        im.src = m.image;
      }
      return { canvas: c, ctx: x, meta: m };
    });
    active = Math.min(active, layers.length - 1);
    bindEngine();
  }

  function bindEngine() {
    if (!layers[active]) return;
    if (!engine) engine = new Brush.Engine(layers[active].canvas);
    engine.target = layers[active].canvas;
    engine.tctx = layers[active].ctx;
    engine.resize(px(), px());
  }

  // ---------- rendering ----------
  function buildGuide() {
    guide = null;
    if (!onion) return;
    var f = cur();
    if (!f) return;
    var n = px();
    var g = mkCanvas(n);
    var gx = g.getContext("2d");
    var any = false;
    P.categories.forEach(function (c) {
      if (c.id === f.cat.id) return;
      var drawn = null;
      c.traits.some(function (t) {
        return Project.slots(t).some(function (s) { if (s.image) { drawn = s; return true; } });
      });
      if (!drawn) return;
      var im = imageCache(drawn.image);
      if (im && im.complete) { gx.drawImage(im, 0, 0, n, pxH(n)); any = true; }
    });
    guide = any ? g : null;
  }

  var _imgs = {};
  function imageCache(url) {
    if (!url) return null;
    if (_imgs[url]) return _imgs[url];
    var im = new Image();
    im.onload = function () { redraw(); };
    im.src = url;
    _imgs[url] = im;
    return im;
  }

  // ---------- per-trait effects (blur + grain) ----------
  // Stored on the slot so they persist with the project and bake into slot.image,
  // which is exactly what the generator composites — no generate.js change needed.
  function slotFx() {
    var f = cur(); if (!f) return null;
    if (!f.slot.fx) f.slot.fx = { blur: 0, grain: 0 };
    return f.slot.fx;
  }
  // Blur is baked into the trait here (a true gaussian, GPU-accelerated). Grain is
  // NOT baked at this resolution — on a 48px pixel trait one noise cell would be a
  // whole art pixel (chunky). Grain lives at OUTPUT resolution instead: a
  // display-res overlay for the preview (paintGrain), and export-res in the
  // generator. So this only handles blur.
  function applyFx(cv) {
    var fx = slotFx();
    if (!fx || !fx.blur) return;
    var w = cv.width, h = cv.height;
    if (fx.blur) {
      // Strength is relative to canvas resolution so the slider feels the same on
      // a 48px pixel trait and a big raster one: slider 20 ≈ 4px on a 48px canvas.
      var bpx = fx.blur * w / 240;
      if (bpx >= 0.12) {
        // Blur on an edge-CLAMPED padded buffer. The plain canvas filter samples
        // transparent space past the edge, so a full-bleed background fades to
        // nothing at the borders (the checkerboard bug). Stretching the source to
        // fill a padded margin bleeds the real edge colour outward — and a trait
        // with transparent edges (a figure) stretches transparent, so it still
        // fades naturally. Blur the whole padded buffer, then crop the centre.
        var pad = Math.ceil(bpx * 3) + 1, pw = w + pad * 2, ph = h + pad * 2;
        var src = document.createElement("canvas"); src.width = pw; src.height = ph;
        var sg = src.getContext("2d");
        sg.drawImage(cv, 0, 0, w, h, 0, 0, pw, ph);   // stretched edge bleed
        sg.drawImage(cv, pad, pad);                    // crisp original centred
        var blr = document.createElement("canvas"); blr.width = pw; blr.height = ph;
        var lg = blr.getContext("2d");
        lg.filter = "blur(" + bpx + "px)"; lg.drawImage(src, 0, 0);
        var bx = cv.getContext("2d");
        bx.clearRect(0, 0, w, h);
        bx.drawImage(blr, pad, pad, w, h, 0, 0, w, h);   // crop the centre back
      }
    }
  }
  // Fine film grain, drawn on a display-resolution overlay so it reads as real
  // grain rather than on the 48px art grid. Mean-grey noise under an overlay blend
  // (the #fxover CSS) lifts/darkens the art like film; a destination-in pass masks
  // it to the trait silhouette so it never speckles the transparent canvas.
  function paintGrain() {
    var ov = document.getElementById("fxover"); if (!ov) return;
    var octx = ov.getContext("2d");
    var f = cur(), amt = (f && f.slot.fx) ? f.slot.fx.grain : 0;
    var rect = surface.getBoundingClientRect();
    if (!amt || !sel || rect.width < 2) { ov.width = ov.height = 1; return; }
    var ow = Math.min(1024, Math.round(rect.width));
    var oh = Math.round(ow * pxH() / px());
    if (ov.width !== ow || ov.height !== oh) { ov.width = ow; ov.height = oh; }
    var im = octx.createImageData(ow, oh), d = im.data, sd = amt * 1.25;
    for (var i = 0; i < d.length; i += 4) {
      var nz = 128 + (Math.random() * 2 - 1) * sd; nz = nz < 0 ? 0 : nz > 255 ? 255 : nz;
      d[i] = d[i + 1] = d[i + 2] = nz; d[i + 3] = 255;
    }
    octx.globalCompositeOperation = "source-over";
    octx.putImageData(im, 0, 0);
    // keep grain only where the trait actually is (upscaled silhouette as a mask)
    octx.globalCompositeOperation = "destination-in";
    octx.imageSmoothingEnabled = false;
    octx.drawImage(flatten(false), 0, 0, px(), pxH(), 0, 0, ow, oh);
    octx.globalCompositeOperation = "source-over";
  }
  // Visible layers composited (with their opacities) into one canvas. withFx bakes
  // the trait's blur/grain; callers pass false mid-stroke so painting stays snappy.
  // The scratch canvas is reused across calls (redraw runs on every pointermove) —
  // its contents are consumed synchronously by the caller, so sharing it is safe.
  var _flat = null;
  function flatten(withFx) {
    var n = px(), h = pxH(n);
    if (!_flat) _flat = document.createElement("canvas");
    if (_flat.width !== n || _flat.height !== h) { _flat.width = n; _flat.height = h; }
    var fx = _flat.getContext("2d");
    fx.clearRect(0, 0, n, h);
    layers.forEach(function (L) {
      if (!L.meta.visible) return;
      fx.globalAlpha = L.meta.opacity;
      fx.drawImage(L.canvas, 0, 0);
    });
    fx.globalAlpha = 1;
    if (withFx) applyFx(_flat);
    return _flat;
  }
  function syncFxUI() {
    var fx = slotFx() || { blur: 0, grain: 0 };
    var b = document.getElementById("fxBlur"), g = document.getElementById("fxGrain");
    if (b) { b.value = fx.blur; document.getElementById("fxBlurV").textContent = fx.blur; }
    if (g) { g.value = fx.grain; document.getElementById("fxGrainV").textContent = fx.grain; }
  }

  function redraw() {
    var note = document.getElementById("canvasnote");
    if (note) note.hidden = !!sel;
    var n = px();
    view.clearRect(0, 0, n, pxH(n));
    drawRef();
    if (guide) {
      view.globalAlpha = 0.22;
      view.drawImage(guide, 0, 0);
      view.globalAlpha = 1;
    }
    // Skip the fx while a stroke is in flight (grain reads back every pixel); the
    // stop() -> redraw() after pointerup paints the finished, effected trait.
    view.drawImage(flatten(!painting), 0, 0);
    if (!painting) paintGrain();
  }

  // ---------- persistence of the drawing ----------
  function commit() {
    var f = cur();
    if (!f) return;
    layers.forEach(function (L) { L.meta.image = L.canvas.toDataURL("image/png"); });
    f.slot.layers = layers.map(function (L) { return L.meta; });
    // flattened copy is what the generator composites — with blur/grain baked in
    f.slot.image = flatten(true).toDataURL("image/png");
    delete _imgs[f.slot.image];
    var sw = document.querySelector('[data-sw="' + f.slot.id + '"]');
    if (sw) sw.style.backgroundImage = "url(" + f.slot.image + ")";
    // the undrawn warning is computed in stats(), so drawing has to refresh it
    var row = sw && sw.parentNode;
    if (row) row.classList.remove("undrawn");
    stats();
  }

  // ---------- importing existing art ----------
  // Accepts PNGs and honors the "Name#weight.png" convention, so art exported
  // from another generator keeps its rarities instead of arriving all at 10.
  function parseName(file) {
    var base = file.name.replace(/\.[a-z0-9]+$/i, "");
    var m = /^(.*?)#(\d+)$/.exec(base);
    return m ? { name: m[1].trim(), weight: Math.max(1, +m[2] || 10) }
             : { name: base.trim() || "Imported", weight: 10 };
  }

  // Draws the file onto a canvas at the project size. Pixel art is scaled with
  // smoothing off so it stays crisp; anything non-square is letterboxed rather
  // than stretched.
  function fileToImage(file) {
    return new Promise(function (res, rej) {
      var fr = new FileReader();
      fr.onerror = function () { rej(new Error("could not read " + file.name)); };
      fr.onload = function () {
        var im = new Image();
        im.onerror = function () { rej(new Error(file.name + " is not a readable image")); };
        im.onload = function () {
          var n = px();
          var cv = mkCanvas(n);
          var cx = cv.getContext("2d");
          cx.imageSmoothingEnabled = mode !== "pixel";
          var H = pxH(n);
          var s = Math.min(n / im.width, H / im.height);
          var w = Math.round(im.width * s), h = Math.round(im.height * s);
          cx.drawImage(im, Math.floor((n - w) / 2), Math.floor((H - h) / 2), w, h);
          res({ url: cv.toDataURL("image/png"), scaled: im.width !== n || im.height !== H });
        };
        im.src = fr.result;
      };
      fr.readAsDataURL(file);
    });
  }

  // `accept` defaults to images (trait import). Open-project passes a JSON filter
  // — without it the picker greyed out the save extension and the app could not reopen
  // its own save files.
  function pickFiles(multiple, accept) {
    return new Promise(function (res) {
      var inp = document.createElement("input");
      inp.type = "file";
      inp.accept = accept || "image/png,image/webp,image/jpeg";
      inp.multiple = !!multiple;
      inp.addEventListener("change", function () { res([].slice.call(inp.files || [])); });
      inp.click();
    });
  }

  // Import as traits of a category, one trait per file.
  function importTraits(cat) {
    pickFiles(true).then(function (files) {
      if (!files.length) return;
      var scaled = 0;
      // sequential, so traits land in the order they were picked rather than
      // the order the decodes happen to finish
      var jobs = files.reduce(function (chain, f) {
        return chain.then(function () {
          var meta = parseName(f);
          return fileToImage(f).then(function (r) {
            if (r.scaled) scaled++;
            var t = Project.addTrait(P, cat.id, meta.name);
            t.weight = meta.weight;
            t.image = r.url;
            t.layers = [{ id: Project.uid(), name: "Base", opacity: 1, visible: true, image: r.url }];
          });
        });
      }, Promise.resolve());
      jobs.then(function () {
        render(); stats(); buildGuide();
        toast("imported " + files.length + " into " + cat.name +
              (scaled ? " · " + scaled + " resized to " + px() + "px" : ""));
      }, function (err) { toast(err.message); });
    });
  }

  // Import as colors of one trait, one color per file.
  function importColors(t) {
    pickFiles(true).then(function (files) {
      if (!files.length) return;
      // an already-drawn trait keeps its art as the first color rather than
      // having the import silently supersede it
      if (!(t.colors || []).length && t.image) Project.addColor(t, "Color 1");
      var jobs = files.reduce(function (chain, f) {
        return chain.then(function () {
          var meta = parseName(f);
          return fileToImage(f).then(function (r) {
            var col = Project.addColor(t, meta.name);
            col.weight = meta.weight;
            col.image = r.url;
            col.layers = [{ id: Project.uid(), name: "Base", opacity: 1, visible: true, image: r.url }];
          });
        });
      }, Promise.resolve());
      jobs.then(function () {
        openCols[t.id] = true;
        render(); stats();
        toast("imported " + files.length + " color" + (files.length > 1 ? "s" : ""));
      }, function (err) { toast(err.message); });
    });
  }

  // ---------- undo ----------
  function stack() {
    var k = mode + ":" + px();
    if (!stacks[k]) stacks[k] = { undo: [], redo: [] };
    return stacks[k];
  }
  function snapshot() {
    var L = layers[active];
    if (!L) return;
    var st = stack();
    try {
      st.undo.push({ i: active, data: L.ctx.getImageData(0, 0, px(), pxH()) });
      if (st.undo.length > 40) st.undo.shift();
      st.redo = [];
    } catch (e) {}
    undoButtons();
  }
  function restore(from, to) {
    var st = stack();
    var a = st[from], b = st[to];
    if (!a.length) return;
    var s = a.pop();
    var L = layers[s.i];
    if (!L) return;
    try { b.push({ i: s.i, data: L.ctx.getImageData(0, 0, px(), pxH()) }); } catch (e) {}
    L.ctx.putImageData(s.data, 0, 0);
    redraw(); commit();
    undoButtons();
  }
  // Greyed out when there is nothing to undo, so a dead press reads as "nothing
  // to undo" rather than "the button is broken".
  function undoButtons() {
    var st = stack();
    var u = document.getElementById("tUndo"), r = document.getElementById("tRedo");
    if (u) u.disabled = !st.undo.length;
    if (r) r.disabled = !st.redo.length;
  }

  // ---------- selection ----------
  function select(id) {
    if (sel === id) return;
    if (sel) commit();
    endScale();               // a scale session never spans two traits
    sel = id;
    var f = cur();
    stacks = {}; active = 0;
    undoButtons();
    if (f) loadLayers(f.slot);
    syncFxUI();
    buildGuide();
    redraw();
    document.getElementById("now").innerHTML = f
      ? esc(f.cat.name) + " › <b>" + esc(f.trait.name) + "</b>" +
        (f.color ? " · " + esc(f.color.name) : "") : "&mdash;";
    renderLayers();
    render();
  }

  // ---------- drawing ----------
  function pos(e) {
    var r = surface.getBoundingClientRect();
    return {
      x: (e.clientX - r.left) / r.width * px(),
      y: (e.clientY - r.top) / r.height * pxH(),
      p: (e.pointerType === "pen" || e.pointerType === "touch") ? e.pressure : 0.5
    };
  }
  var painting = false;

  function ctxOf() { return layers[active] ? layers[active].ctx : null; }

  function pixelAt(p) {
    var x = ctxOf(); if (!x) return;
    var n = px();
    // snap to the pencil grid — a 4px pencil should tile the canvas in 4px
    // steps, not float freely, or the art stops lining up
    var s = pixelSize;
    var x0 = Math.floor(p.x / s) * s;
    var y0 = Math.floor(p.y / s) * s;
    function put(ax) {
      if (ax + pixelSize <= 0 || ax >= n) return;
      if (tool === "erase") x.clearRect(ax, y0, pixelSize, pixelSize);
      else { x.fillStyle = color; x.fillRect(ax, y0, pixelSize, pixelSize); }
    }
    put(x0);
    if (mirror) {
      var mx = Math.floor((n - 1 - x0 - (s - 1)) / s) * s;
      if (mx !== x0) put(mx);
    }
  }

  // flood fill on the active layer, 4-connected, tolerance-free
  function fill(px0, py0) {
    var x = ctxOf(); if (!x) return;
    var n = px(), H = pxH(n);
    var sx = Math.floor(px0), sy = Math.floor(py0);
    if (sx < 0 || sy < 0 || sx >= n || sy >= H) return;
    var im = x.getImageData(0, 0, n, H);
    var d = im.data;
    var at = function (a, b) { return (b * n + a) * 4; };
    var s = at(sx, sy);
    var target = [d[s], d[s + 1], d[s + 2], d[s + 3]];
    var rgb = hexToRgb(color);
    var repl = tool === "erase" ? [0, 0, 0, 0] : [rgb[0], rgb[1], rgb[2], 255];
    if (target[0] === repl[0] && target[1] === repl[1] &&
        target[2] === repl[2] && target[3] === repl[3]) return;

    var stack = [[sx, sy]];
    while (stack.length) {
      var q = stack.pop(), a = q[0], b = q[1];
      if (a < 0 || b < 0 || a >= n || b >= H) continue;
      var o = at(a, b);
      if (d[o] !== target[0] || d[o + 1] !== target[1] ||
          d[o + 2] !== target[2] || d[o + 3] !== target[3]) continue;
      d[o] = repl[0]; d[o + 1] = repl[1]; d[o + 2] = repl[2]; d[o + 3] = repl[3];
      stack.push([a + 1, b], [a - 1, b], [a, b + 1], [a, b - 1]);
    }
    x.putImageData(im, 0, 0);
  }

  function hexToRgb(h) {
    return [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];
  }
  function rgbToHex(r, g, b) {
    return "#" + [r, g, b].map(function (v) {
      var s = v.toString(16); return s.length < 2 ? "0" + s : s;
    }).join("");
  }

  // sample the composited surface, so you can pick a color you can actually see
  function eyedrop(p) {
    var n = px();
    var x = Math.floor(p.x), y = Math.floor(p.y);
    if (x < 0 || y < 0 || x >= n || y >= n) return;
    var d = view.getImageData(x, y, 1, 1).data;
    if (!d[3]) return toast("nothing there to sample");
    var hex = rgbToHex(d[0], d[1], d[2]);
    color = hex;
    if (engine) engine.color = hex;
    picker.set(hex);
    toast(hex);
  }

  surface.addEventListener("pointerdown", function (e) {
    if (!sel) return toast("pick a trait to draw into");
    if (!layers[active]) return;
    e.preventDefault();
    try { surface.setPointerCapture(e.pointerId); } catch (err) {}
    var p = pos(e);
    if (tool === "pick") return eyedrop(p);
    endScale();               // drawing bakes any in-progress scale at its current size
    snapshot();
    painting = true;
    // Move: grab the active layer's pixels into a buffer and drag them as a whole.
    if (tool === "move") {
      var Lm = layers[active];
      moveSrc = document.createElement("canvas");
      moveSrc.width = px(); moveSrc.height = pxH();
      moveSrc.getContext("2d").drawImage(Lm.canvas, 0, 0);
      moveStart = p;
      return;
    }
    if (tool === "fill") { fill(p.x, p.y); redraw(); commit(); painting = false; return; }
    if (mode === "pixel") { pixelAt(p); redraw(); }
    else {
      engine.color = color;
      engine.erasing = tool === "erase";
      engine.begin(p);
      redraw();
    }
  });

  surface.addEventListener("pointermove", function (e) {
    if (!painting) return;
    e.preventDefault();
    // Move drag: redraw the grabbed layer offset by the pointer delta. Whole-pixel
    // steps in pixel mode so the art keeps landing on the grid.
    if (tool === "move" && moveSrc) {
      var mp = pos(e);
      var dx = mp.x - moveStart.x, dy = mp.y - moveStart.y;
      if (mode === "pixel") { dx = Math.round(dx); dy = Math.round(dy); }
      var Lm = layers[active];
      Lm.ctx.clearRect(0, 0, px(), pxH());
      Lm.ctx.drawImage(moveSrc, dx, dy);
      redraw();
      return;
    }
    var evts = [e];
    if (e.getCoalescedEvents) {
      var co = e.getCoalescedEvents();
      if (co && co.length) evts = co;
    }
    for (var i = 0; i < evts.length; i++) {
      var p = pos(evts[i]);
      if (mode === "pixel") pixelAt(p); else engine.move(p);
    }
    redraw();
    // the raster stroke lives in a scratch layer until pointerup, so show it
    if (mode === "raster" && engine.drawing) {
      view.globalAlpha = engine.opacity;
      view.drawImage(engine.scratch, 0, 0);
      view.globalAlpha = 1;
    }
  });

  function stop() {
    if (!painting) return;
    painting = false;
    if (tool === "move") { moveSrc = null; moveStart = null; redraw(); commit(); return; }
    if (mode === "raster") engine.end();
    if (mirror && mode === "raster") mirrorLayer();
    redraw(); commit();
  }
  ["pointerup", "pointercancel", "pointerleave"].forEach(function (ev) {
    surface.addEventListener(ev, stop);
  });

  function mirrorLayer() {
    var L = layers[active]; if (!L) return;
    var n = px();
    var tmp = mkCanvas(n);
    var t = tmp.getContext("2d");
    t.translate(n, 0); t.scale(-1, 1);
    t.drawImage(L.canvas, 0, 0);
    L.ctx.drawImage(tmp, 0, 0);
  }

  // ---------- layer rail ----------
  function renderLayers() {
    var host = document.getElementById("layerlist");
    if (!host) return;
    host.innerHTML = "";
    layers.slice().reverse().forEach(function (L, ri) {
      var i = layers.length - 1 - ri;
      var row = document.createElement("div");
      row.className = "lyr" + (i === active ? " sel" : "");

      var eye = document.createElement("button");
      eye.className = "eye" + (L.meta.visible ? "" : " off");
      eye.textContent = L.meta.visible ? "●" : "○";
      eye.title = "Show / hide";
      eye.addEventListener("click", function (ev) {
        ev.stopPropagation();
        L.meta.visible = !L.meta.visible; renderLayers(); redraw(); commit();
      });
      row.appendChild(eye);

      var nm = document.createElement("input");
      nm.type = "text"; nm.value = L.meta.name;
      nm.addEventListener("input", function () { L.meta.name = nm.value; });
      nm.addEventListener("focus", function () { active = i; bindEngine(); renderLayers(); });
      row.appendChild(nm);

      var op = document.createElement("input");
      op.type = "range"; op.min = "0"; op.max = "100";
      op.value = Math.round(L.meta.opacity * 100);
      op.title = "Opacity";
      op.addEventListener("input", function () {
        L.meta.opacity = +op.value / 100; redraw();
      });
      op.addEventListener("change", commit);
      row.appendChild(op);

      var del = document.createElement("button");
      del.textContent = "×";
      del.addEventListener("click", function (ev) {
        ev.stopPropagation();
        if (layers.length === 1) return toast("a trait needs at least one paint layer");
        layers.splice(i, 1);
        active = Math.max(0, Math.min(active, layers.length - 1));
        bindEngine(); renderLayers(); redraw(); commit();
      });
      row.appendChild(del);

      row.addEventListener("click", function () { active = i; bindEngine(); renderLayers(); });
      host.appendChild(row);
    });
  }

  document.getElementById("addLayer").addEventListener("click", function () {
    if (!sel) return toast("pick a trait first");
    var n = px();
    var c = mkCanvas(n);
    var x = c.getContext("2d", { willReadFrequently: true });
    x.imageSmoothingEnabled = mode !== "pixel";
    layers.push({ canvas: c, ctx: x, meta: blankLayer("Pass " + (layers.length + 1)) });
    active = layers.length - 1;
    bindEngine(); renderLayers(); redraw(); commit();
  });

  // ---------- category / trait rail ----------
  function render() {
    var host = document.getElementById("cats");
    host.innerHTML = "";
    P.categories.forEach(function (c, ci) {
      var box = document.createElement("div");
      box.className = "cat";

      var depth = document.createElement("div");
      depth.className = "depth";
      var pos = ci === 0 ? "back"
              : (ci === P.categories.length - 1 ? "front" : "over " + esc(P.categories[ci - 1].name));
      depth.innerHTML = "<i>" + (ci + 1) + "</i><span>" + pos + "</span>" +
        "<em class=\"grip\" title=\"Drag to reorder\">⋮⋮</em>";
      depth.draggable = true;
      depth.addEventListener("dragstart", function (e) {
        dragId = c.id;
        box.classList.add("dragging");
        e.dataTransfer.effectAllowed = "move";
        // Firefox needs something set or the drag never starts
        e.dataTransfer.setData("text/plain", c.id);
      });
      depth.addEventListener("dragend", function () {
        dragId = null;
        document.querySelectorAll(".cat").forEach(function (el) {
          el.classList.remove("dragging", "over-a", "over-b");
        });
      });
      box.appendChild(depth);

      box.addEventListener("dragover", function (e) {
        if (!dragId || dragId === c.id) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = "move";
        var r = box.getBoundingClientRect();
        var after = (e.clientY - r.top) > r.height / 2;
        box.classList.toggle("over-a", !after);
        box.classList.toggle("over-b", after);
      });
      box.addEventListener("dragleave", function () {
        box.classList.remove("over-a", "over-b");
      });
      box.addEventListener("drop", function (e) {
        if (!dragId || dragId === c.id) return;
        e.preventDefault();
        var r = box.getBoundingClientRect();
        var after = (e.clientY - r.top) > r.height / 2;
        var target = P.categories.findIndex(function (x) { return x.id === c.id; });
        var from = P.categories.findIndex(function (x) { return x.id === dragId; });
        var to = target + (after ? 1 : 0);
        if (from < to) to--;
        var moved = dragId;
        dragId = null;
        if (Project.reorder(P, moved, to)) {
          render(); buildGuide(); redraw();
          toast("stack order updated");
        }
      });

      var head = document.createElement("div");
      head.className = "cathead";
      var nm = document.createElement("input");
      nm.type = "text"; nm.value = c.name;
      nm.addEventListener("input", function () { c.name = nm.value; });
      head.appendChild(nm);
      // Randomize: scatter weights so no two traits share a rarity, without a
      // single trait swallowing the category. A log-normal spread reads like a
      // real collection — a few commons, a long tail of rares — which is what
      // people who do not want to hand-tune actually want.
      var rnd = document.createElement("button");
      rnd.className = "catrnd";
      rnd.textContent = "⤮ Randomize";
      rnd.title = "Give every trait here a random rarity";
      rnd.addEventListener("click", function () {
        randomizeCategory(c);
        render(); stats(); buildGuide();
        toast("randomized " + esc(c.name) + " rarities");
      });
      head.appendChild(rnd);
      var del = document.createElement("button");
      del.textContent = "×";
      del.addEventListener("click", function () {
        if (!confirm("Delete category “" + c.name + "” and its traits?")) return;
        Project.remove(P, c.id);
        if (sel && !Project.find(P, sel)) { sel = null; layers = []; redraw(); }
        render(); stats(); buildGuide();
      });
      del.className = "catdel";
      del.title = "Delete this category";
      box.appendChild(del);
      box.appendChild(head);

      var pcts = Project.shares(c);
      // column header, so the bare number reads as rarity rather than an id
      if (c.traits.length) {
        var th = document.createElement("div");
        th.className = "thead";
        th.innerHTML = "<span class=\"th-n\">Trait</span>" +
                       "<span class=\"th-w\" title=\"How often this trait is picked, relative to the others here\">Rarity</span>" +
                       "<span class=\"th-x\"></span>";
        box.appendChild(th);
      }
      c.traits.forEach(function (t, ti) {
        var cols = t.colors || [];
        // A trait that already has colors shows them by default — reopening a
        // saved project should not hide work behind a toggle. Once toggled by
        // hand that choice sticks for the session.
        var open = openCols[t.id] === undefined ? cols.length > 0 : openCols[t.id];
        // with colors, the trait row's own swatch previews the first one
        var head = Project.slots(t)[0];

        var row = document.createElement("div");
        row.className = "trait" + (head.id === sel ? " sel" : "") + (head.image ? "" : " undrawn");
        var sw = document.createElement("div");
        sw.className = "sw"; sw.dataset.sw = head.id;
        if (head.image) sw.style.backgroundImage = "url(" + head.image + ")";
        sw.style.backgroundSize = "cover";
        sw.addEventListener("click", function () { select(head.id); });
        row.appendChild(sw);
        var nmi = document.createElement("input");
        nmi.type = "text"; nmi.value = t.name;
        nmi.addEventListener("input", function () {
          t.name = nmi.value;
          if (Project.slots(t).some(function (s) { return s.id === sel; })) {
            var f = cur();
            document.getElementById("now").innerHTML = esc(c.name) + " › <b>" + esc(t.name) + "</b>" +
              (f && f.color ? " · " + esc(f.color.name) : "");
          }
        });
        nmi.addEventListener("focus", function () { select(head.id); });
        row.appendChild(nmi);
        var wrap = document.createElement("label");
        wrap.className = "wt";
        wrap.title = "How often this trait is picked, relative to the others here";
        var w = document.createElement("input");
        w.type = "number"; w.value = t.weight; w.min = "1";
        var pct = document.createElement("span");
        pct.className = "pct"; pct.dataset.pct = t.id;
        pct.textContent = pcts[ti].pct.toFixed(0) + "%";
        w.addEventListener("input", function () {
          t.weight = Math.max(1, +w.value || 1); stats(); refreshPcts(c);
        });
        wrap.appendChild(w); wrap.appendChild(pct);
        row.appendChild(wrap);
        var x = document.createElement("button");
        x.className = "x"; x.textContent = "×";
        x.title = "Delete this trait";
        x.addEventListener("click", function () {
          Project.remove(P, t.id);
          if (!Project.find(P, sel)) { sel = null; layers = []; redraw(); }
          render(); stats(); buildGuide();
        });
        row.appendChild(x);
        box.appendChild(row);

        // ---- colors ----
        // Each color is its own drawing of this trait, with its own rarity.
        var tog = document.createElement("button");
        tog.className = "coltog" + (open ? " open" : "") + (cols.length ? " has" : "");
        tog.innerHTML = "<b>" + (open ? "▾" : "▸") + "</b> Colors" +
          (cols.length ? "<i>" + cols.length + "</i>" : "");
        tog.title = cols.length
          ? "This trait outputs one file per color"
          : "Give this trait multiple colors, each drawn separately";
        tog.addEventListener("click", function () {
          openCols[t.id] = !open;
          if (!open && !cols.length) {
            // opening an empty list seeds Color 1 from what is already drawn,
            // so nothing is lost and the list is never empty on screen
            var first = Project.addColor(t, "Color 1");
            if (sel === t.id) sel = first.id;
          }
          render();
        });
        box.appendChild(tog);

        if (open && cols.length) {
          var cshares = Project.colorShares(t);
          cols.forEach(function (col, ki) {
            var cr = document.createElement("div");
            cr.className = "crow" + (col.id === sel ? " sel" : "") + (col.image ? "" : " undrawn");

            var csw = document.createElement("div");
            csw.className = "sw"; csw.dataset.sw = col.id;
            if (col.image) csw.style.backgroundImage = "url(" + col.image + ")";
            csw.style.backgroundSize = "cover";
            csw.addEventListener("click", function () { select(col.id); });
            cr.appendChild(csw);

            var cn = document.createElement("input");
            cn.type = "text"; cn.value = col.name;
            cn.addEventListener("input", function () {
              col.name = cn.value;
              if (col.id === sel) {
                document.getElementById("now").innerHTML =
                  esc(c.name) + " › <b>" + esc(t.name) + "</b> · " + esc(col.name);
              }
            });
            cn.addEventListener("focus", function () { select(col.id); });
            cr.appendChild(cn);

            var cwrap = document.createElement("label");
            cwrap.className = "wt";
            cwrap.title = "How often this color is picked, relative to this trait's other colors";
            var cw = document.createElement("input");
            cw.type = "number"; cw.min = "1"; cw.value = col.weight;
            var cpct = document.createElement("span");
            cpct.className = "pct";
            cpct.textContent = cshares[ki].pct.toFixed(0) + "%";
            cw.addEventListener("input", function () {
              col.weight = Math.max(1, +cw.value || 1);
              stats();
              var sh = Project.colorShares(t);
              cr.parentNode.querySelectorAll(".crow .pct").forEach(function (el, i) {
                if (sh[i]) el.textContent = sh[i].pct.toFixed(0) + "%";
              });
            });
            cwrap.appendChild(cw); cwrap.appendChild(cpct);
            cr.appendChild(cwrap);

            var cx = document.createElement("button");
            cx.className = "x"; cx.textContent = "×";
            cx.title = "Delete this color";
            cx.addEventListener("click", function () {
              Project.remove(P, col.id);
              if (!Project.find(P, sel)) { sel = null; layers = []; redraw(); }
              render(); stats(); buildGuide();
            });
            cr.appendChild(cx);
            box.appendChild(cr);
          });

          var addC = document.createElement("button");
          addC.className = "addc";
          var crow = document.createElement("div");
          crow.className = "colbtns";
          var addC = document.createElement("button");
          addC.className = "addc";
          addC.textContent = "+ Color";
          addC.title = "Adds a copy of the last color to recolor — not a blank canvas";
          addC.addEventListener("click", function () {
            var nc = Project.addColor(t);
            render(); stats(); select(nc.id);
            toast("copied " + cols[cols.length - 1].name + " — recolor it");
          });
          crow.appendChild(addC);
          var impC = document.createElement("button");
          impC.className = "addc imp";
          impC.textContent = "Import";
          impC.title = "Load PNGs as colors of this trait. Name#weight.png sets rarity.";
          impC.addEventListener("click", function () { importColors(t); });
          crow.appendChild(impC);
          box.appendChild(crow);
        }
      });

      if (!c.traits.length) {
        var em = document.createElement("div");
        em.className = "empty";
        em.textContent = "No traits yet — add one, then click its swatch to draw";
        box.appendChild(em);
      }

      var btns = document.createElement("div");
      btns.className = "traitbtns";
      var add = document.createElement("button");
      add.className = "addtrait";
      add.textContent = "+ Trait";
      add.addEventListener("click", function () {
        var t = Project.addTrait(P, c.id, "Trait " + (c.traits.length + 1));
        render(); stats(); select(t.id);
      });
      btns.appendChild(add);
      var imp = document.createElement("button");
      imp.className = "addtrait imp";
      imp.textContent = "Import";
      imp.title = "Load PNGs as traits of this category. Name#weight.png sets rarity.";
      imp.addEventListener("click", function () { importTraits(c); });
      btns.appendChild(imp);
      box.appendChild(btns);
      host.appendChild(box);
    });
    stats();
    renderRules();
    changeCbs.forEach(function (cb) { try { cb(); } catch (e) {} });
  }

  function refreshPcts(c) {
    Project.shares(c).forEach(function (s, i) {
      var el = document.querySelector('[data-pct="' + c.traits[i].id + '"]');
      if (el) el.textContent = s.pct.toFixed(0) + "%";
    });
  }

  // A pleasing rarity spread: log-normal weights (1..100), each trait distinct,
  // colors within a trait scattered the same way. Deterministic-feeling but
  // fresh each press.
  function scatterWeights(n) {
    var ws = [];
    for (var i = 0; i < n; i++) {
      // Box-Muller → log-normal; clamp into a 1..100 integer band
      var u1 = Math.random() || 1e-9, u2 = Math.random();
      var g = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
      ws.push(Math.round(Math.min(100, Math.max(1, Math.exp(1.1 + g * 0.6)))));
    }
    return ws;
  }
  function randomizeCategory(c) {
    var ws = scatterWeights(c.traits.length);
    c.traits.forEach(function (t, i) {
      t.weight = ws[i];
      if (t.colors && t.colors.length) {
        var cw = scatterWeights(t.colors.length);
        t.colors.forEach(function (col, k) { col.weight = cw[k]; });
      }
    });
  }
  // Randomize every category at once — the one-click "surprise me".
  function randomizeAll() {
    P.categories.forEach(randomizeCategory);
    render(); stats(); buildGuide();
    toast("randomized all rarities");
  }
  window.RandomizeAll = randomizeAll;

  function stats() {
    var sp = Project.space(P);
    var supply = +document.getElementById("supply").value || 0;
    var files = 0;
    P.categories.forEach(function (c) { files += Project.outputs(c); });
    document.getElementById("space").textContent = sp
      ? sp.toLocaleString() + " combinations  ·  " + files + " trait files"
      : "add traits to see combinations";
    var w = [];
    if (sp && supply > sp) w.push("Supply exceeds the " + sp.toLocaleString() + " unique combinations available.");
    var u = Project.undrawn(P);
    if (u.length) w.push(u.length + " trait" + (u.length === 1 ? "" : "s") + " not drawn: " +
      u.slice(0, 3).join(", ") + (u.length > 3 ? "…" : ""));
    var empty = P.categories.filter(function (c) { return !c.traits.length; });
    if (empty.length) w.push(empty.length + " empty categor" + (empty.length === 1 ? "y is" : "ies are") + " ignored.");
    var over = overBudget(Math.min(supply, sp || supply), files);
    if (over) w.push(over);
    document.getElementById("warn").textContent = w.join("  ");
    // the server refuses these anyway; saying so here saves a round trip and a
    // confusing failure after the wait
    var g = document.getElementById("generate");
    g.disabled = !!over;
    g.title = over || "";
  }

  // The same object the generator checks against, so the warning above the
  // button and the error it would throw can never disagree.
  var LIMITS = Gen.LIMITS;

  function overBudget(supply, files) {
    if (!LIMITS || !supply) return null;
    var n = px();
    if (supply > LIMITS.supply) {
      return "Supply is over the " + LIMITS.supply.toLocaleString() + " limit.";
    }
    if (n > LIMITS.canvas) return "Canvas is over the " + LIMITS.canvas + "px limit.";
    if (supply * n * n > LIMITS.pixels) {
      var max = Math.floor(LIMITS.pixels / (n * n));
      return "Too big to generate: " + supply.toLocaleString() + " tokens at " + n + "px. " +
             "Max supply at this canvas size is " + max.toLocaleString() + ".";
    }
    if (files * n * pxH(n) * 4 > LIMITS.traitBytes) {
      return "Too many trait images at " + n + "px to hold in memory. Use fewer or a smaller canvas.";
    }
    return null;
  }

  // ---------- mode / canvas ----------
  function sizeCanvas() {
    var n = px();
    surface.width = n;
    surface.height = pxH(n);
    view = surface.getContext("2d");
    view.imageSmoothingEnabled = mode !== "pixel";
    document.getElementById("dims").textContent = n + " × " + pxH(n);
    layout();
  }
  function layout() {
    // How much room the canvas actually has, measured rather than assumed.
    //
    // This used to subtract a flat 300px for everything above and below it.
    // The real overhead is nearer 360 — header, the mode buttons, the
    // breadcrumb, the gap and the tool bar — so on a 900px laptop the tool bar
    // sat 36px below the fold, and body{overflow:hidden} meant it was not
    // scrollable to. Any change to the header or the toolbar moved the number
    // again, which is the argument against having one.
    //
    // Collapsing the canvas and measuring the column is exact and stays exact.
    var app = document.querySelector(".app");
    var mid = surface.closest(".mid");
    var byWidth, byHeight;

    if (app && mid) {
      // Width comes from the rails, not from the middle column: that column is
      // an `auto` grid track, so it is as wide as the canvas and measuring it
      // while the canvas is collapsed gives zero.
      var railW = 0;
      [].forEach.call(app.querySelectorAll(":scope > .col"), function (c) {
        railW += c.offsetWidth;
      });
      var cs = getComputedStyle(mid);
      byWidth = app.clientWidth - railW -
                (parseFloat(cs.paddingLeft) || 0) - (parseFloat(cs.paddingRight) || 0);

      // Height is what is left once the canvas's siblings have taken their
      // share. Summed rather than read off scrollHeight: .mid is a stretched
      // grid item, so its scrollHeight never falls below the row it sits in and
      // collapsing the canvas told us nothing at all.
      var wrap = surface.closest(".stagewrap") || surface;
      var gap = parseFloat(getComputedStyle(mid).rowGap) || 0;
      var used = (parseFloat(cs.paddingTop) || 0) + (parseFloat(cs.paddingBottom) || 0);
      var kids = 0;
      [].forEach.call(mid.children, function (c) {
        kids++;
        if (c !== wrap) used += c.offsetHeight;
      });
      used += gap * Math.max(0, kids - 1);
      // Air under the tool bar. Sized so the bar is clearly inside the window
      // rather than flush against the bottom edge — at 12 it fitted and looked
      // like it had been cropped anyway.
      byHeight = app.clientHeight - used - 40;
    } else {
      byWidth = window.innerWidth - 860;
      byHeight = window.innerHeight - 390;
    }

    var ratio = pxH() / px();
    var d = Math.max(240, Math.min(660, Math.min(byWidth, byHeight / ratio)));
    surface.style.width = d + "px";
    surface.style.height = Math.round(d * ratio) + "px";
    paintGrid(d);
  }

  // The grid cannot be drawn onto the canvas itself — at 48x48 a one-pixel line
  // would cover the art. It is a CSS overlay in display space instead, and it
  // hides when cells get too small to read.
  function paintGrid(d) {
    var el = document.getElementById("grid");
    if (!el) return;
    var n = px();
    var cell = d / n;
    var show = mode === "pixel" && gridOn && cell >= 4;
    el.style.display = show ? "block" : "none";
    if (!show) return;
    var minor = "rgba(255,255,255,.07)";
    var major = "rgba(255,255,255,.16)";
    var every = pixelSize > 1 ? pixelSize : (n % 8 === 0 ? 8 : 0);
    var bg = [
      "repeating-linear-gradient(90deg," + minor + " 0 1px,transparent 1px " + cell + "px)",
      "repeating-linear-gradient(0deg," + minor + " 0 1px,transparent 1px " + cell + "px)"
    ];
    if (every) {
      bg.unshift(
        "repeating-linear-gradient(90deg," + major + " 0 1px,transparent 1px " + (cell * every) + "px)",
        "repeating-linear-gradient(0deg," + major + " 0 1px,transparent 1px " + (cell * every) + "px)"
      );
    }
    el.style.backgroundImage = bg.join(",");
  }
  window.addEventListener("resize", layout);

  function setMode(next) {
    if (next === mode) return;
    if (sel) commit();
    mode = next;
    P.canvas.mode = mode;
    document.body.classList.toggle("pixelmode", mode === "pixel");
    document.getElementById("mPixel").className = mode === "pixel" ? "on" : "";
    document.getElementById("mRaster").className = mode === "raster" ? "on" : "";
    document.getElementById("brushpanel").hidden = mode !== "raster";
    document.getElementById("pixelpanel").hidden = mode === "raster";
    document.getElementById("modehint").textContent = mode === "pixel"
      ? "Pixel mode — " + P.canvas.pixel + "×" + pxH(P.canvas.pixel) + ", " + pixelSize + "px pencil."
      : "Brush mode — " + P.canvas.raster + "×" + pxH(P.canvas.raster) + ", pressure-sensitive.";
    sizeCanvas();
    // select() clears the stacks because it normally means a different trait;
    // here it is the same trait at a new size, so carry them over
    if (sel) { var s = sel, keep = stacks; sel = null; select(s); stacks = keep; }
    undoButtons();
  }

  // ---------- controls ----------
  var rndAllBtn = document.getElementById("rndAll");
  if (rndAllBtn) rndAllBtn.addEventListener("click", function () {
    if (!P.categories.length) return toast("add a category first");
    randomizeAll();
  });
  document.getElementById("addCat").addEventListener("click", function () {
    Project.addCategory(P, "Category " + (P.categories.length + 1));
    render(); buildGuide();
  });
  document.getElementById("projName").addEventListener("input", function (e) { P.name = e.target.value; });
  document.getElementById("supply").addEventListener("input", function (e) {
    P.supply = +e.target.value || 0; stats();
  });
  document.getElementById("mPixel").addEventListener("click", function () { setMode("pixel"); });
  document.getElementById("mRaster").addEventListener("click", function () { setMode("raster"); });

  var toolBtns = { draw: "tDraw", erase: "tErase", fill: "tFill", pick: "tPick", move: "tMove" };
  Object.keys(toolBtns).forEach(function (k) {
    document.getElementById(toolBtns[k]).addEventListener("click", function () {
      tool = k;
      surface.style.cursor = k === "move" ? "move" : "";
      Object.keys(toolBtns).forEach(function (o) {
        document.getElementById(toolBtns[o]).className = o === k ? "on" : "";
      });
    });
  });

  // Scale the SELECTED layer around its centre. The whole layer is resampled from
  // a PRISTINE snapshot each click and the factor accumulates — never from the
  // already-scaled result. Resampling the previous output every click compounds
  // nearest-neighbour rounding into what looks like stray pixels being added and
  // dropped; scaling the original by the running factor keeps every step clean.
  // The session (snapshot + factor) is dropped by endScale() the moment anything
  // else touches the layer — a draw, a trait switch — baking whatever it's at.
  var scaleSrc = null, scaleFac = 1;
  function endScale() { scaleSrc = null; scaleFac = 1; }
  function scaleBy(mult) {
    var L = layers[active]; if (!L) return toast("pick a trait first");
    if (!scaleSrc) {
      snapshot();                                  // one undo entry per scale session
      scaleSrc = mkCanvas(px());
      scaleSrc.getContext("2d").drawImage(L.canvas, 0, 0);
      scaleFac = 1;
    }
    scaleFac *= mult;
    var n = px(), H = pxH();
    L.ctx.clearRect(0, 0, n, H);
    L.ctx.imageSmoothingEnabled = mode !== "pixel";
    L.ctx.save();
    L.ctx.translate(n / 2, H / 2); L.ctx.scale(scaleFac, scaleFac);
    L.ctx.drawImage(scaleSrc, -n / 2, -H / 2);
    L.ctx.restore();
    redraw(); commit();
  }
  document.getElementById("tScaleUp").addEventListener("click", function () { scaleBy(1.1); });
  document.getElementById("tScaleDown").addEventListener("click", function () { scaleBy(1 / 1.1); });

  // Rotate: snapshot the layer when the slider is grabbed, rotate that snapshot
  // live as it drags (so repeated angles never compound resampling), bake on
  // release, and spring the slider back to 0 — the rotation now lives in the art.
  var rotSrc = null;
  var rotEl = document.getElementById("tRotate"), rotVal = document.getElementById("tRotateV");
  function grabRot() {
    if (!layers[active]) return;
    snapshot();
    var n = px(); rotSrc = mkCanvas(n);
    rotSrc.getContext("2d").drawImage(layers[active].canvas, 0, 0);
  }
  rotEl.addEventListener("pointerdown", grabRot);
  rotEl.addEventListener("input", function (e) {
    rotVal.textContent = e.target.value + "°";
    if (!rotSrc) grabRot();                       // keyboard fallback
    if (!rotSrc || !layers[active]) return;
    var n = px(), H = pxH(), ang = +e.target.value * Math.PI / 180, L = layers[active];
    L.ctx.clearRect(0, 0, n, H);
    L.ctx.imageSmoothingEnabled = mode !== "pixel";
    L.ctx.save(); L.ctx.translate(n / 2, H / 2); L.ctx.rotate(ang);
    L.ctx.drawImage(rotSrc, -n / 2, -H / 2); L.ctx.restore();
    redraw();
  });
  rotEl.addEventListener("change", function (e) {
    if (rotSrc) commit();
    rotSrc = null; e.target.value = 0; rotVal.textContent = "0°";
  });

  document.getElementById("tMirror").addEventListener("click", function () {
    mirror = !mirror; this.className = mirror ? "on" : "";
    toast(mirror ? "mirror on" : "mirror off");
  });
  document.getElementById("tUndo").addEventListener("click", function () { restore("undo", "redo"); });
  document.getElementById("tRedo").addEventListener("click", function () { restore("redo", "undo"); });
  document.getElementById("tClear").addEventListener("click", function () {
    if (!layers[active]) return;
    snapshot();
    layers[active].ctx.clearRect(0, 0, px(), pxH());
    redraw(); commit();
  });
  document.getElementById("tGrid").addEventListener("click", function () {
    gridOn = !gridOn; this.className = gridOn ? "on" : "";
    layout();
  });
  document.getElementById("tOnion").addEventListener("click", function () {
    onion = !onion; this.className = onion ? "on" : "";
    buildGuide();
    if (!onion) guide = null;
    redraw();
    toast(onion ? "guide on — other categories underneath" : "guide off");
  });

  var picker = Picker.create(document.getElementById("picker"), {
    value: color,
    onChange: function (hex) { color = hex; if (engine) engine.color = hex; }
  });
  ["bSize", "bOpacity"].forEach(function (id) {
    document.getElementById(id).addEventListener("input", function (e) {
      document.getElementById(id + "V").textContent = e.target.value;
      if (!engine) return;
      if (id === "bSize") engine.size = +e.target.value; else engine.opacity = +e.target.value / 100;
    });
  });
  document.getElementById("bPressure").addEventListener("change", function (e) {
    if (engine) engine.usePressure = e.target.checked;
  });
  // The canvas shape. Width stays put; paper adds rows below (and going back
  // to square crops them), so existing art is re-encoded anchored to the top —
  // pixels are preserved exactly, never scaled.
  document.getElementById("aspectSel").addEventListener("change", function (e) {
    var next = e.target.value;
    if ((P.canvas.aspect || "square") === next) return;
    var hasArt = P.categories.some(function (c) {
      return c.traits.some(function (tr) {
        return Project.slots(tr).some(function (s) { return s.image; });
      });
    });
    if (hasArt && next === "square" &&
        !confirm("Going back to square crops the bottom of every trait. Continue?")) {
      e.target.value = P.canvas.aspect || "square";
      return;
    }
    P.canvas.aspect = next;

    // Re-encode every image in the project at the new height.
    var jobs = [];
    function reshape(holder, key) {
      var url = holder[key];
      if (!url) return;
      jobs.push(new Promise(function (res) {
        var im = new Image();
        im.onload = function () {
          var cv = mkCanvas(im.width);
          cv.getContext("2d").drawImage(im, 0, 0);
          holder[key] = cv.toDataURL("image/png");
          res();
        };
        im.onerror = res;
        im.src = url;
      }));
    }
    P.categories.forEach(function (c) {
      c.traits.forEach(function (tr) {
        Project.slots(tr).forEach(function (s) {
          reshape(s, "image");
          (s.layers || []).forEach(function (L) { reshape(L, "image"); });
        });
      });
    });
    Promise.all(jobs).then(function () {
      sizeCanvas();
      if (sel) { var s = sel; sel = null; select(s); }
      buildGuide();
      layout();
      redraw();
      Project.touch && Project.touch();
      var mh = document.getElementById("modehint");
      if (mh) mh.textContent = mode === "pixel"
        ? "Pixel mode — " + P.canvas.pixel + "×" + pxH(P.canvas.pixel) + ", " + pixelSize + "px pencil."
        : "Brush mode — " + P.canvas.raster + "×" + pxH(P.canvas.raster) + ", pressure-sensitive.";
      toast(next === "paper" ? "paper shape — rows added below" : "square shape");
    });
  });

  document.getElementById("pSize").addEventListener("input", function (e) {
    P.canvas.pixel = +e.target.value;
    document.getElementById("pSizeV").textContent = P.canvas.pixel;
    if (mode === "pixel") {
      sizeCanvas();
      if (sel) { var s = sel; sel = null; select(s); }
    }
    layout();
  });
  document.getElementById("pPen").addEventListener("input", function (e) {
    pixelSize = +e.target.value;
    document.getElementById("pPenV").textContent = pixelSize;
    layout();
    document.getElementById("modehint").textContent =
      "Pixel mode — " + P.canvas.pixel + "×" + pxH(P.canvas.pixel) + ", " + pixelSize + "px pencil.";
  });

  var host = document.getElementById("brushes");
  Object.keys(Brush.PRESETS).forEach(function (k, i) {
    var b = document.createElement("button");
    b.textContent = Brush.PRESETS[k].label;
    b.className = i === 0 ? "on" : "";
    b.addEventListener("click", function () {
      engine.preset = k;
      Array.prototype.forEach.call(host.children, function (c) { c.className = ""; });
      b.className = "on";
    });
    host.appendChild(b);
  });

  // ---------- rules ----------
  // Values are typed rather than picked from a list: variants multiply the
  // option names, and a prefix like "Man Bun *" is the point.
  function renderRules() {
    var host = document.getElementById("rules");
    host.innerHTML = "";
    (P.rules || []).forEach(function (r, i) {
      var box = document.createElement("div");
      box.className = "rule";
      [["when", "When"], ["forbid", "Forbid"]].forEach(function (side) {
        var row = document.createElement("div");
        row.className = "rr";
        var lab = document.createElement("label");
        lab.textContent = side[1];
        row.appendChild(lab);

        var sel = document.createElement("select");
        var first = document.createElement("option");
        first.value = ""; first.textContent = "—";
        sel.appendChild(first);
        P.categories.forEach(function (c) {
          var o = document.createElement("option");
          o.value = c.name; o.textContent = c.name;
          if (Object.keys(r[side[0]] || {})[0] === c.name) o.selected = true;
          sel.appendChild(o);
        });
        row.appendChild(sel);

        var val = document.createElement("input");
        val.type = "text";
        val.placeholder = "value, value, Prefix *";
        var k0 = Object.keys(r[side[0]] || {})[0];
        val.value = k0 ? [].concat(r[side[0]][k0]).join(", ") : "";
        row.appendChild(val);

        function sync() {
          var cat = sel.value;
          if (!cat) { r[side[0]] = {}; stats(); return; }
          var vals = val.value.split(",").map(function (s) { return s.trim(); })
                       .filter(function (s) { return s; });
          r[side[0]] = {}; r[side[0]][cat] = vals;
          stats();
        }
        sel.addEventListener("change", sync);
        val.addEventListener("input", sync);
        box.appendChild(row);
      });

      var del = document.createElement("button");
      del.className = "del"; del.textContent = "remove rule";
      del.addEventListener("click", function () { P.rules.splice(i, 1); renderRules(); });
      box.appendChild(del);
      host.appendChild(box);
    });
  }
  document.getElementById("addRule").addEventListener("click", function () {
    P.rules = P.rules || [];
    P.rules.push({ when: {}, forbid: {} });
    renderRules();
  });

  // ---------- trace reference ----------
  var ref = { img: null, fade: 0.45, scale: 1 };
  function drawRef() {
    if (!ref.img) return;
    var n = px(), H = pxH(n);
    var w = ref.img.width * ref.scale, h = ref.img.height * ref.scale;
    var s = Math.min(n / w, H / h);
    view.globalAlpha = ref.fade;
    view.imageSmoothingEnabled = true;
    view.drawImage(ref.img, (n - w * s) / 2, (H - h * s) / 2, w * s, h * s);
    view.imageSmoothingEnabled = mode !== "pixel";
    view.globalAlpha = 1;
  }
  function loadRef(file) {
    var fr = new FileReader();
    fr.onload = function () {
      var im = new Image();
      im.onload = function () {
        ref.img = im;
        ["refRow", "refRow2", "refClear"].forEach(function (id) {
          document.getElementById(id).hidden = false;
        });
        redraw(); toast("reference loaded — it is never exported");
      };
      im.src = fr.result;
    };
    fr.readAsDataURL(file);
  }
  document.getElementById("refLoad").addEventListener("click", function () {
    document.getElementById("refFile").click();
  });
  document.getElementById("refFile").addEventListener("change", function (e) {
    if (e.target.files && e.target.files[0]) loadRef(e.target.files[0]);
  });
  document.getElementById("refClear").addEventListener("click", function () {
    ref.img = null;
    ["refRow", "refRow2", "refClear"].forEach(function (id) {
      document.getElementById(id).hidden = true;
    });
    redraw();
  });
  document.getElementById("refFade").addEventListener("input", function (e) {
    ref.fade = +e.target.value / 100;
    document.getElementById("refFadeV").textContent = e.target.value;
    redraw();
  });
  document.getElementById("refScale").addEventListener("input", function (e) {
    ref.scale = +e.target.value / 100;
    document.getElementById("refScaleV").textContent = e.target.value;
    redraw();
  });
  // Effects: live on input (redraw shows it), baked into slot.image on change.
  document.getElementById("fxBlur").addEventListener("input", function (e) {
    var fx = slotFx();
    document.getElementById("fxBlurV").textContent = e.target.value;
    if (!fx) return toast("pick a trait first");
    fx.blur = +e.target.value; redraw();
  });
  document.getElementById("fxBlur").addEventListener("change", function () { if (slotFx()) commit(); });
  document.getElementById("fxGrain").addEventListener("input", function (e) {
    var fx = slotFx();
    document.getElementById("fxGrainV").textContent = e.target.value;
    if (!fx) return toast("pick a trait first");
    fx.grain = +e.target.value; redraw();
  });
  document.getElementById("fxGrain").addEventListener("change", function () { if (slotFx()) commit(); });
  surface.addEventListener("dragover", function (e) { e.preventDefault(); });
  surface.addEventListener("drop", function (e) {
    e.preventDefault();
    var f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
    if (f && /^image\//.test(f.type)) loadRef(f);
  });
  window.addEventListener("paste", function (e) {
    var items = (e.clipboardData || {}).items || [];
    for (var i = 0; i < items.length; i++) {
      if (/^image\//.test(items[i].type)) { loadRef(items[i].getAsFile()); break; }
    }
  });

  // ---------- server ----------
  function post(url, done) {
    if (sel) commit();
    fetch(url, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify(P)
    }).then(function (r) { return r.json(); }).then(done)
      .catch(function () { toast("request failed"); });
  }
  // ---------- project save files ----------
  // One self-contained file: every drawing is already a data URL on the model,
  // so the JSON carries the art with it and opens on any machine. This is the
  // only save that survives closing the tab — the server copy cannot currently
  // be loaded back.
  var FILE_KIND = window.BRAND.fileKind;

  function saveToFile() {
    if (sel) commit();
    var doc = { kind: FILE_KIND, version: 1, savedAt: new Date().toISOString(), project: P };
    var blob = new Blob([JSON.stringify(doc)], { type: "application/json" });
    var url = URL.createObjectURL(blob);
    var a = document.createElement("a");
    a.href = url;
    a.download = (slugName(P.name) || "collection") + window.BRAND.fileExt;
    document.body.appendChild(a);
    a.click();
    a.remove();
    // revoked late so the download has definitely started
    setTimeout(function () { URL.revokeObjectURL(url); }, 30000);
    toast("saved " + a.download + " · " + size(blob.size));
  }

  function slugName(s) {
    return String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  }

  function slug(s) {
    return String(s || "").replace(/[^a-z0-9_-]+/gi, "-").replace(/^-+|-+$/g, "").toLowerCase();
  }

  function size(bytes) {
    return bytes < 1048576 ? Math.max(1, Math.round(bytes / 1024)) + " KB"
                           : (bytes / 1048576).toFixed(1) + " MB";
  }

  // Validates before replacing anything — opening a wrong file should not
  // silently wipe the work in progress.
  // Somebody with no art still has to start somewhere. A template is a normal
  // project we happen to ship — the same thing "Save project" writes — so it
  // arrives fully editable and there is no template mode to leave.
  //
  // Listed from a manifest rather than hardcoded, so adding one is a file drop.
  async function pickTemplate() {
    var list;
    try {
      var r = await fetch("/templates/index.json", { cache: "no-store" });
      list = (await r.json()).templates || [];
    } catch (e) { return toast("could not load the templates"); }
    if (!list.length) return toast("no templates yet");

    var veil = document.createElement("div");
    veil.className = "tpl-veil";
    var card = document.createElement("div");
    card.className = "tpl-card";
    card.innerHTML = "<h3>Start from a template</h3>" +
      "<p class=\"sub\">A ready-made trait set you can change completely — recolour it, " +
      "redraw a piece, add categories, delete what you do not want. It opens as your " +
      "project, not as a locked skin.</p>";
    veil.appendChild(card);

    list.forEach(function (t2) {
      var b = document.createElement("button");
      b.className = "tpl-item";
      b.innerHTML = "<img alt=\"\">" +
        "<span><b>" + esc(t2.name) + "</b>" +
        "<span>" + esc(t2.blurb || "") + "</span>" +
        "<i>" + Number(t2.categories) + " categories · " + Number(t2.traits) + " traits · " +
        Number(t2.combinations).toLocaleString() + " combinations</i></span>";
      card.appendChild(b);

      // the thumbnail is composed from the template itself, so it can never
      // show art the file does not contain
      fetch("/templates/" + t2.file).then(function (r) { return r.json(); })
        .then(function (doc) { thumb(doc.project, b.querySelector("img")); })
        .catch(function () {});

      b.addEventListener("click", function () {
        fetch("/templates/" + t2.file).then(function (r) { return r.json(); })
          .then(function (doc) {
            var proj = doc && doc.project ? doc.project : doc;
            if (!proj || !Array.isArray(proj.categories)) throw new Error("bad template");
            if (P.categories.length &&
                !confirm("Replace what you have open with \u201c" + (proj.name || "template") + "\u201d?")) return;
            // a fresh id, or two people starting from the same template would
            // be working on projects that claim to be the same one
            proj.id = Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
            loadProject(proj);
            veil.remove();
            toast("opened " + (proj.name || "template"));
          })
          .catch(function () { toast("could not open that template"); });
      });
    });

    var close = document.createElement("button");
    close.className = "close";
    close.textContent = "Cancel";
    close.addEventListener("click", function () { veil.remove(); });
    card.appendChild(close);

    veil.addEventListener("click", function (e) { if (e.target === veil) veil.remove(); });
    document.body.appendChild(veil);
  }

  // Stack one of every category into a 64px preview.
  function thumb(proj, img) {
    var cv = document.createElement("canvas");
    var n = (proj.canvas && proj.canvas.pixel) || 24;
    var th = proj.canvas && proj.canvas.aspect === "paper" ? Math.round(n * Math.SQRT2) : n;
    cv.width = n; cv.height = th;
    var g = cv.getContext("2d");
    g.imageSmoothingEnabled = false;
    var srcs = proj.categories.map(function (c) {
      var t2 = (c.traits || [])[0];
      return t2 && (t2.image || (t2.colors && t2.colors[0] && t2.colors[0].image));
    }).filter(Boolean);
    var i = 0;
    (function next() {
      if (i >= srcs.length) { img.src = cv.toDataURL("image/png"); return; }
      var im = new Image();
      im.onload = function () { g.drawImage(im, 0, 0, n, th); i++; next(); };
      im.onerror = function () { i++; next(); };
      im.src = srcs[i];
    }());
  }

  function openFromFile() {
    pickFiles(false, window.BRAND.readExts.concat("application/json").join(",")).then(function (files) {
      if (!files.length) return;
      var f = files[0];
      var fr = new FileReader();
      fr.onerror = function () { toast("could not read that file"); };
      fr.onload = function () {
        var doc;
        var bad = "that is not a " + window.BRAND.name + " save file";
        try { doc = JSON.parse(fr.result); }
        catch (e) { return toast(bad); }
        // readKinds, not FILE_KIND — Moonpad saves and the bundled templates
        // are still "moonpad-project" and must keep opening.
        var proj = doc && window.BRAND.readKinds.indexOf(doc.kind) >= 0 ? doc.project
                 : (doc && doc.categories ? doc : null);   // also accept a bare project
        if (!proj || !Array.isArray(proj.categories)) {
          return toast(bad);
        }
        var n = proj.categories.reduce(function (a, c) { return a + (c.traits || []).length; }, 0);
        if (!confirm("Open “" + (proj.name || "untitled") + "”?\n" +
                     proj.categories.length + " categories, " + n + " traits.\n\n" +
                     "This replaces what is on screen now.")) return;
        loadProject(proj);
        toast("opened " + (proj.name || "project"));
      };
      fr.readAsText(f);
    });
  }

  function loadProject(proj) {
    P = proj;
    P.canvas = P.canvas || { mode: "pixel", pixel: 48, raster: 1024 };
    P.canvas.aspect = P.canvas.aspect || "square";
    var aspEl = document.getElementById("aspectSel");
    if (aspEl) aspEl.value = P.canvas.aspect;
    P.categories.forEach(function (c) {
      c.traits.forEach(function (t) {
        // projects saved before the spelling change carry `colours`; migrate on
        // open so an older save is never silently emptied of its color art
        if (!t.colors && t.colours) { t.colors = t.colours; delete t.colours; }
        t.colors = t.colors || [];
      });
    });
    sel = null; layers = []; stacks = {}; active = 0;
    openCols = {};
    document.getElementById("projName").value = P.name || "";
    document.getElementById("supply").value = P.supply || 500;
    // setMode is a no-op when the mode already matches, so the canvas is sized
    // explicitly either way
    var want = P.canvas.mode || "pixel";
    if (want !== mode) { mode = want === "pixel" ? "raster" : "pixel"; setMode(want); }
    else { sizeCanvas(); }
    render(); stats(); buildGuide(); redraw(); renderLayers();
    document.getElementById("now").innerHTML = "&mdash;";
  }

  document.getElementById("savefile").addEventListener("click", saveToFile);
  document.getElementById("openfile").addEventListener("click", openFromFile);
  document.getElementById("usetemplate").addEventListener("click", pickTemplate);

  // Generation runs in this tab. It used to post the project to the server,
  // which meant the hosted site could only ever be half the product — there is
  // no filesystem behind a static host and no request long enough to render a
  // collection. Doing it here removes the server from the path entirely, so the
  // same code runs whether the page came from localhost or the deployed site.
  var lastZip = null;   // { blob, name }

  document.getElementById("generate").addEventListener("click", function () {
    if (sel) commit();
    var u = Project.undrawn(P);
    if (u.length) return toast(u.length + " trait(s) still undrawn");
    if (!Project.space(P)) return toast("add some traits first");

    var btn = this;
    var label = btn.textContent;
    var info = document.getElementById("saveinfo");
    btn.disabled = true;
    document.getElementById("download").hidden = true;

    // Retaining every image costs ~30MB for a 5,555 collection, so only do it
    // when there is actually a launch flow to hand them to.
    P.keepFiles = !!window.LaunchPanel;
    Gen.run(P, {
      onProgress: function (done, total, stage) {
        if (stage === "rendering") {
          var pct = Math.round(done / total * 100);
          btn.textContent = "Rendering " + done + " / " + total;
          info.textContent = pct + "%";
        } else {
          btn.textContent = stage.charAt(0).toUpperCase() + stage.slice(1) + "…";
        }
      }
    }).then(function (r) {
      lastZip = { blob: r.blob, name: (slug(P.name) || "collection") + ".zip" };
      var bits = [r.count + " tokens", r.size, size(r.blob.size)];
      if (r.ones) bits.push(r.ones + " one-of-one" + (r.ones === 1 ? "" : "s"));
      if (r.zero && r.zero.length) bits.push(r.zero.length + " trait(s) with no copies");
      info.textContent = bits.join(" · ");
      document.getElementById("download").hidden = false;
      if (window.LaunchPanel && r.files) {
        window.LaunchPanel.setRun(r.files, r.count);
        document.getElementById("launch").hidden = false;
      }
      toast("generated " + r.count);
    }).catch(function (e) {
      info.textContent = "";
      toast(e.message);
    }).then(function () {
      btn.disabled = false;
      btn.textContent = label;
    });
  });

  // The zip is already in memory, so this is just handing it to the browser.
  document.getElementById("download").addEventListener("click", function () {
    if (!lastZip) return toast("nothing generated yet");
    var url = URL.createObjectURL(lastZip.blob);
    var a = document.createElement("a");
    a.href = url; a.download = lastZip.name;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 30000);
    toast("downloaded " + lastZip.name + " · " + size(lastZip.blob.size));
  });

  // the launch panel reads name and symbol from here to prefill itself
  window.__project = P;

  document.getElementById("launch").addEventListener("click", function () {
    if (window.LaunchPanel) window.LaunchPanel.open();
  });

  document.getElementById("pressureNote").textContent = window.PointerEvent ? "stylus ready" : "unsupported";

  // ---------- start ----------
  var c1 = Project.addCategory(P, "Background");
  var c2 = Project.addCategory(P, "Body");
  var c3 = Project.addCategory(P, "Eyes");
  Project.addTrait(P, c1.id, "Plain");
  Project.addTrait(P, c2.id, "Base");
  Project.addTrait(P, c3.id, "Basic");
  sizeCanvas();
  render();
  select(P.categories[0].traits[0].id);
  layout();
})();
