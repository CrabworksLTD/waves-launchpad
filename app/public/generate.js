"use strict";
// Collection generation, in the browser.
//
// This is a port of app/server/generate.js, and it is deliberately a close one:
// the rng, the weight expansion, the rule matching and the rolling loop are
// line-for-line the same so a project generates the identical collection
// whether it runs here or on the local server. Change one, change both.
//
// What differs is everything around it. Images are composited on a canvas
// instead of a pixel buffer, PNG encoding is whatever canvas.toBlob gives us,
// and the result goes straight into a zip Blob rather than to disk. Nothing is
// held as one contiguous buffer, so the ceiling is the machine rather than the
// largest ArrayBuffer it can allocate.
window.Gen = (function () {

  // ---------- deterministic rng ----------
  function rng(seed) {
    var a = seed >>> 0;
    return function () {
      a |= 0; a = (a + 0x6D2B79F5) | 0;
      var t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function pick(opts, rand) {
    var total = 0, i;
    for (i = 0; i < opts.length; i++) total += opts[i].weight || 1;
    var x = rand() * total;
    for (i = 0; i < opts.length; i++) {
      x -= opts[i].weight || 1;
      if (x <= 0) return i;
    }
    return opts.length - 1;
  }

  // ---------- exclusion rules ----------
  // A value may be negated with a leading "!", so a rule can say "any hat
  // except None" rather than naming every hat — an explicit list goes stale the
  // moment a new one is added, which is how Dreads kept acquiring hats.
  function matches(v, p) {
    if (String(p).charAt(0) === "!") return !matches(v, String(p).slice(1));
    return String(p).slice(-2) === " *"
      ? String(v).indexOf(String(p).slice(0, -1)) === 0
      : v === p;
  }
  function anyMatch(v, spec) {
    return Array.isArray(spec) ? spec.some(function (p) { return matches(v, p); }) : matches(v, spec);
  }
  function violates(combo, rules) {
    return (rules || []).some(function (r) {
      var hit = Object.keys(r.when || {}).every(function (k) { return anyMatch(combo[k], r.when[k]); });
      if (!hit) return false;
      return Object.keys(r.forbid || {}).some(function (k) { return anyMatch(combo[k], r.forbid[k]); });
    });
  }

  // ---------- limits ----------
  // Set from measurement, not from caution. On this machine, 1,000 tokens at
  // 512px — 262M pixels — took 9.7s, produced a 336 MB zip and grew the heap by
  // 282 MB, with no sign of strain. 500 at 256px took 1.5s.
  //
  // The binding constraint is memory rather than time: the zip is held until
  // the user clicks download. 300M pixels leaves headroom over the largest run
  // measured while keeping the worst case under about half a gigabyte, which a
  // browser tab handles but a phone would not enjoy.
  var LIMITS = {
    supply: 25000,
    canvas: 2048,
    pixels: 300e6,         // supply x W x H
    traitBytes: 512 * 1024 * 1024
  };

  function human(n) {
    return n >= 1e9 ? (n / 1e9).toFixed(1) + "B"
         : n >= 1e6 ? (n / 1e6).toFixed(0) + "M"
         : n >= 1e3 ? (n / 1e3).toFixed(0) + "K" : String(n);
  }

  function checkBudget(supply, w, h, optionCount) {
    if (supply > LIMITS.supply) {
      throw new Error("supply of " + human(supply) + " is over the limit of " +
        human(LIMITS.supply) + " — lower the supply");
    }
    if (w > LIMITS.canvas || h > LIMITS.canvas) {
      throw new Error("canvas " + w + "x" + h + " is over the limit of " +
        LIMITS.canvas + "px — use a smaller canvas");
    }
    var px = supply * w * h;
    if (px > LIMITS.pixels) {
      var maxSupply = Math.floor(LIMITS.pixels / (w * h));
      throw new Error(human(supply) + " tokens at " + w + "x" + h + " is " + human(px) +
        " pixels, over the limit of " + human(LIMITS.pixels) + ". At this canvas size the " +
        "maximum supply is " + human(maxSupply) + " — lower the supply or the canvas size");
    }
    var tb = optionCount * w * h * 4;
    if (tb > LIMITS.traitBytes) {
      throw new Error(optionCount + " trait images at " + w + "x" + h + " need " +
        (tb / 1048576).toFixed(0) + " MB in memory, over the limit of " +
        (LIMITS.traitBytes / 1048576).toFixed(0) + " MB — use fewer traits or a smaller canvas");
    }
  }

  // ---------- helpers ----------
  function loadImage(url, label) {
    return new Promise(function (res, rej) {
      if (!url) return rej(new Error("not drawn: " + label));
      var im = new Image();
      im.onload = function () { res(im); };
      im.onerror = function () { rej(new Error("could not decode: " + label)); };
      im.src = url;
    });
  }

  // toDataURL rather than toBlob, which looks like the wrong choice and is not.
  // toBlob defers its callback to the browser's own scheduling, and measured on
  // a 48x48 canvas that came back at ~1000ms per call against ~1.3ms for
  // toDataURL — a thousandfold difference that made a nine-token collection take
  // nine seconds. Decoding the base64 ourselves is the cheap half of the work.
  function canvasBytes(cv) {
    var url = cv.toDataURL("image/png");
    var b64 = url.slice(url.indexOf(",") + 1);
    var bin = atob(b64);
    var out = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }

  // Yields to the event loop so the page keeps painting and the progress bar
  // actually moves.
  //
  // Deliberately not requestAnimationFrame: it ties the work to the paint
  // cadence, which browsers throttle hard when the tab is not focused — a run
  // that takes a minute in the foreground crawled to seconds *per token* in a
  // background tab. A MessageChannel post is a macrotask that yields to the
  // event loop without waiting for a frame, and setTimeout is clamped to ~4ms
  // once nested, which adds up over thousands of tokens.
  var chan = typeof MessageChannel !== "undefined" ? new MessageChannel() : null;
  var waiting = [];
  if (chan) {
    chan.port1.onmessage = function () {
      var f = waiting.shift();
      if (f) f();
    };
  }
  function breathe() {
    return new Promise(function (res) {
      if (chan) { waiting.push(res); chan.port2.postMessage(0); }
      else setTimeout(res, 0);
    });
  }

  // ---------- main ----------
  // opts: { onProgress(done, total, stage) }
  async function run(p, opts) {
    opts = opts || {};
    var report = opts.onProgress || function () {};

    var cats = p.categories.filter(function (c) { return c.traits.length; });
    if (!cats.length) throw new Error("no categories with traits");

    // Each category expands to one option per trait per color. Weight composes:
    // the trait's weight sets how often the category picks that trait at all,
    // and the color's weight splits that share between its colors — so adding a
    // seventh color to a hat does not make hats more common.
    var options = cats.map(function (c) {
      var out = [];
      c.traits.forEach(function (t) {
        var cols = (t.colors && t.colors.length) ? t.colors : null;
        if (!cols) {
          out.push({ name: t.name, weight: Math.max(1, Math.round((t.weight || 1) * 100)),
                     trait: t, slot: t });
          return;
        }
        var total = cols.reduce(function (a, x) { return a + (x.weight || 1); }, 0) || 1;
        cols.forEach(function (col) {
          out.push({
            name: t.name + " " + col.name,
            weight: Math.max(1, Math.round((t.weight || 1) * (col.weight || 1) / total * 100)),
            trait: t, slot: col
          });
        });
      });
      return out;
    });

    var space = 1;
    options.forEach(function (o) { space *= o.length; });
    var supply = Math.max(1, Math.min(+p.supply || 1, space));

    var declared = (p.canvas && (p.canvas.mode === "raster" ? p.canvas.raster : p.canvas.pixel)) || 0;
    var optionCount = options.reduce(function (a, o) { return a + o.length; }, 0);
    if (declared) checkBudget(supply, declared, declared, optionCount);

    // ---- decode every drawing once ----
    report(0, supply, "loading art");
    var imgs = [];
    for (var ci = 0; ci < options.length; ci++) {
      var cache = {};
      var row = [];
      for (var oi = 0; oi < options[ci].length; oi++) {
        var o = options[ci][oi];
        if (!cache[o.slot.id]) {
          cache[o.slot.id] = await loadImage(o.slot.image, cats[ci].name + " / " + o.name);
        }
        row.push(cache[o.slot.id]);
      }
      imgs.push(row);
    }

    var W = imgs[0][0].naturalWidth, H = imgs[0][0].naturalHeight;
    checkBudget(supply, W, H, optionCount);
    imgs.forEach(function (r, i) {
      r.forEach(function (im, j) {
        if (im.naturalWidth !== W || im.naturalHeight !== H) {
          throw new Error("trait images differ in size — " + cats[i].name + " / " +
            options[i][j].name + " is " + im.naturalWidth + "x" + im.naturalHeight +
            ", expected " + W + "x" + H);
        }
      });
    });

    // ---- roll the combinations ----
    var rand = rng(+p.seed || 1337);
    var rules = p.rules || [];
    var seen = new Set();
    var tokens = [];

    // One-of-ones take the first ids. Their combination is reserved so no random
    // token can duplicate it, and rules deliberately do not apply — a special is
    // allowed to break them.
    (p.ones || []).forEach(function (one) {
      var idx = cats.map(function (c, i) {
        var want = one.picks && one.picks[c.id];
        var at = want ? options[i].findIndex(function (o) {
          return o.trait.id === want.traitId &&
                 ((o.slot === o.trait ? null : o.slot.id) === (want.colorId || null));
        }) : -1;
        return at < 0 ? 0 : at;
      });
      seen.add(idx.join(","));
      var combo = {};
      cats.forEach(function (c, i) { combo[c.name] = options[i][idx[i]].name; });
      tokens.push({ idx: idx, combo: combo, one: one });
    });

    var attempts = 0;
    var maxAttempts = supply * 300 + 20000;
    while (tokens.length < supply && attempts < maxAttempts) {
      attempts++;
      var idx = options.map(function (o) { return pick(o, rand); });
      var combo = {};
      cats.forEach(function (c, i) { combo[c.name] = options[i][idx[i]].name; });
      if (violates(combo, rules)) continue;
      var key = idx.join(",");
      if (seen.has(key)) continue;
      seen.add(key);
      tokens.push({ idx: idx, combo: combo });
      // rolling is fast, but a tight rule set can spin for a while — let the
      // page breathe every so often so it never looks hung
      if (tokens.length % 2000 === 0) await breathe();
    }
    if (tokens.length < supply) {
      throw new Error("only found " + tokens.length + " unique valid combinations of " +
        supply + " — loosen the rules or add traits");
    }

    // ---- render ----
    var zip = new Zip.Writer();
    // The launchpad needs the files themselves, not a zip it would have to
    // unpack again in the browser. Collected only when asked, since holding
    // 5,555 images costs ~30MB of memory that a plain download does not need.
    var keep = p.keepFiles ? { images: [], erc721: [], metaplex: [] } : null;
    var counts = {};
    cats.forEach(function (c) { counts[c.name] = {}; });

    // Traits are drawn at the canvas resolution — 48x48 in pixel mode — which is
    // far too small for a marketplace tile or a wallet thumbnail. Export through
    // an integer nearest-neighbour upscale so the art lands around 1024px with
    // every pixel still square. The factor is integer (never a fractional scale)
    // so pixel edges stay crisp, and clamped to 1 so already-large brush canvases
    // are never blown up or resampled.
    var EXPORT_MIN = 1024;
    var SCALE = Math.max(1, Math.floor(EXPORT_MIN / Math.max(W, H)));
    var EW = W * SCALE, EH = H * SCALE;
    // Composite straight at export resolution. Film grain is a per-trait effect
    // that must land at output px (fine) rather than on the 48px art grid
    // (chunky), so everything is assembled at EWxEH and grained traits carry
    // their grain already baked at that resolution.
    var ev = document.createElement("canvas");
    ev.width = EW; ev.height = EH;
    var ex = ev.getContext("2d");
    ex.imageSmoothingEnabled = false;

    // Fine luminance grain on a canvas's opaque pixels (skips transparency, so it
    // never speckles the empty area around a figure).
    function grainAt(canvas, amount) {
      var x = canvas.getContext("2d"), w = canvas.width, h = canvas.height;
      var im = x.getImageData(0, 0, w, h), d = im.data, sd = amount * 0.9;
      for (var i = 0; i < d.length; i += 4) {
        if (d[i + 3] === 0) continue;
        var nz = (Math.random() * 2 - 1) * sd;
        var r = d[i] + nz, g = d[i + 1] + nz, b = d[i + 2] + nz;
        d[i] = r < 0 ? 0 : r > 255 ? 255 : r;
        d[i + 1] = g < 0 ? 0 : g > 255 ? 255 : g;
        d[i + 2] = b < 0 ? 0 : b > 255 ? 255 : b;
      }
      x.putImageData(im, 0, 0);
    }
    // Bake each grained trait ONCE at export resolution — traits repeat across
    // thousands of tokens, so graining per token would be far too slow. Plain
    // traits stay null and get nearest-upscaled on the fly.
    var grained = imgs.map(function (row, ci) {
      return row.map(function (im, oi) {
        var fx = options[ci][oi].slot.fx;
        if (!fx || !fx.grain) return null;
        var c = document.createElement("canvas"); c.width = EW; c.height = EH;
        var g = c.getContext("2d"); g.imageSmoothingEnabled = false;
        g.drawImage(im, 0, 0, W, H, 0, 0, EW, EH);
        grainAt(c, fx.grain);
        return c;
      });
    });
    function drawTrait(k, oi) {
      var hi = grained[k][oi];
      if (hi) ex.drawImage(hi, 0, 0);
      else ex.drawImage(imgs[k][oi], 0, 0, W, H, 0, 0, EW, EH);
    }
    function drawScaled(img) {
      ex.drawImage(img, 0, 0, img.naturalWidth || img.width, img.naturalHeight || img.height, 0, 0, EW, EH);
    }

    // one-of-one overlays and swaps are data urls too, decoded on first use
    var extra = {};
    async function extraImage(url, label) {
      if (!extra[url]) extra[url] = await loadImage(url, label);
      return extra[url];
    }

    for (var n = 0; n < tokens.length; n++) {
      var t = tokens[n];
      var id = n + 1;
      ex.clearRect(0, 0, EW, EH);

      for (var k = 0; k < cats.length; k++) {
        var cu = t.one && t.one.custom ? t.one.custom[cats[k].id] : null;
        var swap = !!(cu && cu.replace && cu.image);
        if (!swap) drawTrait(k, t.idx[k]);
        if (cu && cu.image) drawScaled(await extraImage(cu.image, "1/1 custom"));
        var nm = (cu && cu.name) ? cu.name : options[k][t.idx[k]].name;
        counts[cats[k].name][nm] = (counts[cats[k].name][nm] || 0) + 1;
      }
      if (t.one && t.one.overlay && t.one.overlay.image) {
        drawScaled(await extraImage(t.one.overlay.image, "1/1 overlay"));
      }

      var pngBytes = canvasBytes(ev);
      zip.add("images/" + id + ".png", pngBytes);
      if (keep) keep.images.push({ id: id, name: id + ".png", bytes: pngBytes });

      var attributes = cats.map(function (c, i) {
        var q = t.one && t.one.custom ? t.one.custom[c.id] : null;
        return { trait_type: c.name, value: (q && q.name) ? q.name : options[i][t.idx[i]].name };
      });
      if (t.one) {
        attributes.push({ trait_type: "1 of 1", value: t.one.name });
        if (t.one.extra) attributes.push({ trait_type: "Accessory", value: t.one.extra });
      }
      var image = (p.baseUri || "") + id + ".png";
      var title = (p.name || "Token") + " #" + id + (t.one ? " — " + t.one.name : "");

      var erc721 = JSON.stringify({
        name: title,
        description: p.description || "",
        image: image,
        attributes: attributes
      }, null, 2);
      zip.text("metadata-erc721/" + id + ".json", erc721);
      if (keep) keep.erc721.push({ id: id, name: id + ".json", text: erc721 });

      var metaplex = JSON.stringify({
        name: title,
        symbol: p.symbol || "",
        description: p.description || "",
        image: image,
        attributes: attributes,
        properties: { files: [{ uri: image, type: "image/png" }], category: "image" }
      }, null, 2);
      zip.text("metadata-metaplex/" + id + ".json", metaplex);
      if (keep) keep.metaplex.push({ id: id, name: id + ".json", text: metaplex });

      if ((id % 10) === 0 || id === tokens.length) {
        report(id, tokens.length, "rendering");
        await breathe();
      }
    }

    // ---- reports ----
    var rarity = cats.map(function (c, i) {
      var total = options[i].reduce(function (a, o) { return a + o.weight; }, 0);
      return {
        trait_type: c.name,
        values: options[i].map(function (o) {
          var got = counts[c.name][o.name] || 0;
          return {
            value: o.name,
            target: +(o.weight / total * 100).toFixed(2),
            actual: +(got / tokens.length * 100).toFixed(2),
            count: got
          };
        }).sort(function (a, b) { return a.actual - b.actual; })
      };
    });

    zip.text("rarity.json", JSON.stringify(rarity, null, 2));
    zip.text("tokens.json", JSON.stringify(
      tokens.map(function (t, i) { return { id: i + 1, traits: t.combo }; }), null, 2));
    zip.text("preview.html", sheet(tokens.length, p));

    var ones = tokens.filter(function (t) { return t.one; });
    if (ones.length) {
      zip.text("one-of-ones/index.json", JSON.stringify(
        ones.map(function (t, i) {
          return { name: t.one.name, id: i + 1, extra: t.one.extra || null, traits: t.combo };
        }), null, 2));
    }

    var zero = [];
    rarity.forEach(function (r) {
      r.values.forEach(function (v) { if (!v.count) zero.push(r.trait_type + " / " + v.value); });
    });

    report(tokens.length, tokens.length, "zipping");
    await breathe();

    return {
      blob: zip.blob(),
      files: keep,
      count: tokens.length,
      space: space,
      size: W + "x" + H,
      zero: zero,
      ones: ones.length
    };
  }

  // contact sheet of the first 200, so the result can be eyeballed immediately
  function sheet(count, p) {
    var shown = Math.min(count, 200);
    var cells = "";
    for (var i = 1; i <= shown; i++) {
      cells += '<figure><img src="images/' + i + '.png" alt="#' + i +
               '"><figcaption>#' + i + '</figcaption></figure>';
    }
    var css = "body{background:#141918;color:#c9d1cc;font:13px system-ui;margin:0;padding:24px}" +
      "h1{font-size:15px;letter-spacing:.04em;text-transform:uppercase;margin:0 0 4px}" +
      "p{color:#5f6b65;margin:0 0 20px;font-size:11px}" +
      ".g{display:grid;grid-template-columns:repeat(auto-fill,minmax(120px,1fr));gap:10px}" +
      "figure{margin:0}" +
      "img{width:100%;image-rendering:pixelated;border:1px solid #313a37;display:block}" +
      "figcaption{font-size:10px;color:#5f6b65;margin-top:3px;font-family:ui-monospace,Menlo,monospace}";
    return "<!doctype html><meta charset=\"utf-8\"><title>" + (p.name || "Collection") +
      "</title><style>" + css + "</style><h1>" + (p.name || "Collection") + "</h1><p>" +
      shown + " of " + count + " tokens</p><div class=\"g\">" + cells + "</div>";
  }

  return { run: run, LIMITS: LIMITS, violates: violates, matches: matches, checkBudget: checkBudget };
})();
