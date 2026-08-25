"use strict";
// Collection generation: expand colors, roll unique combinations, honor
// exclusion rules, and write images, both metadata schemas, a rarity report and
// a contact sheet.

const fs = require("fs");
const path = require("path");
const png = require("../../lib/png");

// ---------- deterministic rng ----------
function rng(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function pick(opts, rand) {
  let total = 0;
  for (let i = 0; i < opts.length; i++) total += opts[i].weight || 1;
  let x = rand() * total;
  for (let i = 0; i < opts.length; i++) {
    x -= opts[i].weight || 1;
    if (x <= 0) return i;
  }
  return opts.length - 1;
}

// ---------- exclusion rules ----------
// A value ending in " *" matches by prefix, so a rule survives new colorways
// being added later instead of silently developing holes.
// A value may be negated with a leading "!", so a rule can say "any hat except
// None" rather than naming every hat — an explicit list goes stale the moment a
// new one is added, which is exactly how Dreads kept acquiring hats.
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
    const hit = Object.keys(r.when || {}).every(function (k) { return anyMatch(combo[k], r.when[k]); });
    if (!hit) return false;
    return Object.keys(r.forbid || {}).some(function (k) { return anyMatch(combo[k], r.forbid[k]); });
  });
}

// ---------- work limits ----------
// Generation is synchronous and the zip is built in one Buffer, so peak memory
// runs about twice the finished collection. Measured: 1000 tokens at 512px of
// noisy art is a 591 MB collection and a 3.2 GB peak. Rather than discover that
// on a live box, the work is capped up front and refused with a message saying
// what to change.
//
// Every limit is overridable by env var, so a bigger machine can raise them
// without a code change.
const LIMITS = {
  supply: +process.env.MOONPAD_MAX_SUPPLY || 25000,
  canvas: +process.env.MOONPAD_MAX_CANVAS || 2048,
  // total pixels written across the whole collection: supply x W x H
  pixels: +process.env.MOONPAD_MAX_PIXELS || 120e6,
  // decoded trait art held in memory at once, as RGBA bytes
  traitBytes: +process.env.MOONPAD_MAX_TRAIT_BYTES || 512 * 1024 * 1024
};

function human(n) {
  return n >= 1e9 ? (n / 1e9).toFixed(1) + "B"
       : n >= 1e6 ? (n / 1e6).toFixed(0) + "M"
       : n >= 1e3 ? (n / 1e3).toFixed(0) + "K" : String(n);
}

// Checked before any image is decoded, so an oversized request costs nothing.
function checkBudget(supply, w, h, optionCount) {
  if (supply > LIMITS.supply) {
    throw new Error("supply of " + human(supply) + " is over the limit of " +
      human(LIMITS.supply) + " — lower the supply");
  }
  if (w > LIMITS.canvas || h > LIMITS.canvas) {
    throw new Error("canvas " + w + "x" + h + " is over the limit of " +
      LIMITS.canvas + "px — use a smaller canvas");
  }
  const px = supply * w * h;
  if (px > LIMITS.pixels) {
    const maxSupply = Math.floor(LIMITS.pixels / (w * h));
    throw new Error(human(supply) + " tokens at " + w + "x" + h + " is " + human(px) +
      " pixels, over the limit of " + human(LIMITS.pixels) + ". At this canvas size the " +
      "maximum supply is " + human(maxSupply) + " — lower the supply or the canvas size");
  }
  const tb = optionCount * w * h * 4;
  if (tb > LIMITS.traitBytes) {
    throw new Error(optionCount + " trait images at " + w + "x" + h + " need " +
      (tb / 1048576).toFixed(0) + " MB in memory, over the limit of " +
      (LIMITS.traitBytes / 1048576).toFixed(0) + " MB — use fewer traits or a smaller canvas");
  }
}

function dataUrlToPng(url) {
  const m = /^data:image\/png;base64,(.+)$/.exec(url || "");
  return m ? Buffer.from(m[1], "base64") : null;
}

function decode(buf, tmpDir) {
  const tmp = path.join(tmpDir, ".tmp-" + Math.random().toString(36).slice(2) + ".png");
  fs.writeFileSync(tmp, buf);
  const im = png.read(tmp);
  fs.unlinkSync(tmp);
  return im;
}

// ---------- main ----------
function generate(p, outRoot, tmpDir) {
  const cats = p.categories.filter(function (c) { return c.traits.length; });
  if (!cats.length) throw new Error("no categories with traits");

  // Each category expands to one option per trait per color. A color is its
  // own drawing, so there is nothing to transform here — the image is taken
  // straight from the color.
  //
  // Weight composes: the trait's weight sets how often the category picks that
  // trait at all, and the color's weight splits that share between its
  // colors. Scaling by the color's share of its own trait keeps the trait's
  // overall frequency fixed no matter how many colors it has, so adding a
  // seventh color to a hat does not make hats more common.
  const options = cats.map(function (c) {
    const out = [];
    c.traits.forEach(function (t) {
      const cols = (t.colors && t.colors.length) ? t.colors : null;
      if (!cols) {
        // ×100 to match the scale colors are expanded on below, or an
        // uncolored trait would be a hundred times rarer than its weight says
        out.push({ name: t.name, weight: Math.max(1, Math.round((t.weight || 1) * 100)),
                   trait: t, slot: t });
        return;
      }
      const total = cols.reduce(function (a, x) { return a + (x.weight || 1); }, 0) || 1;
      cols.forEach(function (col) {
        out.push({
          name: t.name + " " + col.name,
          // ×100 keeps resolution when a color takes a small share, since
          // weights are integers
          weight: Math.max(1, Math.round((t.weight || 1) * (col.weight || 1) / total * 100)),
          trait: t, slot: col
        });
      });
    });
    return out;
  });

  let space = 1;
  options.forEach(function (o) { space *= o.length; });
  const supply = Math.max(1, Math.min(+p.supply || 1, space));

  // Budget checked against the declared canvas before anything is decoded, so
  // an oversized request is refused without spending the memory it asked for.
  // Re-checked below against the real image size, which is what actually gets
  // written and may differ from what the project claims.
  const declared = (p.canvas && (p.canvas.mode === "raster" ? p.canvas.raster : p.canvas.pixel)) || 0;
  const optionCount = options.reduce(function (a, o) { return a + o.length; }, 0);
  if (declared) checkBudget(supply, declared, declared, optionCount);

  // every option carries its own drawing, decoded once
  const imgs = options.map(function (opts, ci) {
    const cache = {};
    return opts.map(function (o) {
      if (!cache[o.slot.id]) {
        const buf = dataUrlToPng(o.slot.image);
        if (!buf) throw new Error("not drawn: " + cats[ci].name + " / " + o.name);
        cache[o.slot.id] = decode(buf, tmpDir);
      }
      return cache[o.slot.id];
    });
  });

  const W = imgs[0][0].width, H = imgs[0][0].height;
  checkBudget(supply, W, H, optionCount);
  imgs.forEach(function (row, ci) {
    row.forEach(function (im, oi) {
      if (im.width !== W || im.height !== H) {
        throw new Error("trait images differ in size — " + cats[ci].name + " / " +
          options[ci][oi].name + " is " + im.width + "x" + im.height +
          ", expected " + W + "x" + H);
      }
    });
  });

  const imgDir = path.join(outRoot, "images");
  const m721 = path.join(outRoot, "metadata-erc721");
  const mMeta = path.join(outRoot, "metadata-metaplex");
  fs.rmSync(outRoot, { recursive: true, force: true });
  [imgDir, m721, mMeta].forEach(function (d) { fs.mkdirSync(d, { recursive: true }); });

  const rand = rng(+p.seed || 1337);
  const rules = p.rules || [];
  const seen = new Set();
  const tokens = [];

  // One-of-ones take the first ids. Their combination is reserved so no random
  // token can duplicate it, and rules deliberately do not apply — a special is
  // allowed to break them.
  (p.ones || []).forEach(function (one) {
    const idx = cats.map(function (c, ci) {
      const want = one.picks && one.picks[c.id];
      const i = want ? options[ci].findIndex(function (o) {
        return o.trait.id === want.traitId &&
               ((o.slot === o.trait ? null : o.slot.id) === (want.colorId || null));
      }) : -1;
      return i < 0 ? 0 : i;
    });
    seen.add(idx.join(","));
    const combo = {};
    cats.forEach(function (c, i) { combo[c.name] = options[i][idx[i]].name; });
    tokens.push({ idx: idx, combo: combo, one: one });
  });
  let attempts = 0;
  const maxAttempts = supply * 300 + 20000;

  while (tokens.length < supply && attempts < maxAttempts) {
    attempts++;
    const idx = options.map(function (o) { return pick(o, rand); });
    const combo = {};
    cats.forEach(function (c, i) { combo[c.name] = options[i][idx[i]].name; });
    if (violates(combo, rules)) continue;
    const key = idx.join(",");
    if (seen.has(key)) continue;
    seen.add(key);
    tokens.push({ idx: idx, combo: combo });
  }
  if (tokens.length < supply) {
    throw new Error("only found " + tokens.length + " unique valid combinations of " +
      supply + " — loosen the rules or add traits");
  }

  const counts = {};
  cats.forEach(function (c) { counts[c.name] = {}; });

  tokens.forEach(function (t, i) {
    const n = i + 1;
    const img = png.blank(W, H);
    cats.forEach(function (c, ci) {
      const cu = t.one && t.one.custom ? t.one.custom[c.id] : null;
      const swap = !!(cu && cu.replace && cu.image);
      if (!swap) png.over(img, imgs[ci][t.idx[ci]]);
      if (cu && cu.image) png.over(img, decode(dataUrlToPng(cu.image), tmpDir));
      const nm = (cu && cu.name) ? cu.name : options[ci][t.idx[ci]].name;
      counts[c.name][nm] = (counts[c.name][nm] || 0) + 1;
    });
    if (t.one && t.one.overlay && t.one.overlay.image) {
      png.over(img, decode(dataUrlToPng(t.one.overlay.image), tmpDir));
    }
    png.write(path.join(imgDir, n + ".png"), img);

    const attributes = cats.map(function (c, ci) {
      const cu = t.one && t.one.custom ? t.one.custom[c.id] : null;
      return { trait_type: c.name, value: (cu && cu.name) ? cu.name : options[ci][t.idx[ci]].name };
    });
    if (t.one) {
      attributes.push({ trait_type: "1 of 1", value: t.one.name });
      if (t.one.extra) attributes.push({ trait_type: "Accessory", value: t.one.extra });
    }
    const image = (p.baseUri || "") + n + ".png";
    fs.writeFileSync(path.join(m721, n + ".json"), JSON.stringify({
      name: (p.name || "Token") + " #" + n + (t.one ? " — " + t.one.name : ""),
      description: p.description || "",
      image: image,
      attributes: attributes
    }, null, 2));
    fs.writeFileSync(path.join(mMeta, n + ".json"), JSON.stringify({
      name: (p.name || "Token") + " #" + n + (t.one ? " — " + t.one.name : ""),
      symbol: p.symbol || "",
      description: p.description || "",
      image: image,
      attributes: attributes,
      properties: { files: [{ uri: image, type: "image/png" }], category: "image" }
    }, null, 2));
  });

  // target vs actual, so a broken distribution shows up before mint
  const rarity = cats.map(function (c, ci) {
    const total = options[ci].reduce(function (a, o) { return a + o.weight; }, 0);
    return {
      trait_type: c.name,
      values: options[ci].map(function (o) {
        const n = counts[c.name][o.name] || 0;
        return {
          value: o.name,
          target: +(o.weight / total * 100).toFixed(2),
          actual: +(n / tokens.length * 100).toFixed(2),
          count: n
        };
      }).sort(function (a, b) { return a.actual - b.actual; })
    };
  });

  fs.writeFileSync(path.join(outRoot, "rarity.json"), JSON.stringify(rarity, null, 2));
  fs.writeFileSync(path.join(outRoot, "tokens.json"), JSON.stringify(
    tokens.map(function (t, i) { return { id: i + 1, traits: t.combo }; }), null, 2));
  writeSheet(outRoot, tokens.length, p);

  // specials also collected on their own, so they can be handled without
  // fishing them out of the full run
  const ones = tokens.filter(function (t) { return t.one; });
  if (ones.length) {
    const od = path.join(outRoot, "one-of-ones");
    fs.mkdirSync(od, { recursive: true });
    const index = [];
    ones.forEach(function (t, i) {
      const n = i + 1;
      const s = String(t.one.name).replace(/[\/\\:]/g, "-");
      fs.copyFileSync(path.join(imgDir, n + ".png"), path.join(od, s + ".png"));
      fs.copyFileSync(path.join(m721, n + ".json"), path.join(od, s + "-erc721.json"));
      fs.copyFileSync(path.join(mMeta, n + ".json"), path.join(od, s + "-metaplex.json"));
      index.push({ name: t.one.name, id: n, extra: t.one.extra || null, traits: t.combo });
    });
    fs.writeFileSync(path.join(od, "index.json"), JSON.stringify(index, null, 2));
  }

  const zero = [];
  rarity.forEach(function (r) {
    r.values.forEach(function (v) { if (!v.count) zero.push(r.trait_type + " / " + v.value); });
  });

  return { count: tokens.length, space: space, size: W + "x" + H, zero: zero, ones: ones.length };
}

// contact sheet of the first 200, so the result can be eyeballed immediately
function writeSheet(outRoot, count, p) {
  const shown = Math.min(count, 200);
  let cells = "";
  for (let i = 1; i <= shown; i++) {
    cells += '<figure><img src="images/' + i + '.png" alt="#' + i +
             '"><figcaption>#' + i + '</figcaption></figure>';
  }
  const css = "body{background:#141918;color:#c9d1cc;font:13px system-ui;margin:0;padding:24px}" +
    "h1{font-size:15px;letter-spacing:.04em;text-transform:uppercase;margin:0 0 4px}" +
    "p{color:#5f6b65;margin:0 0 20px;font-size:11px}" +
    ".g{display:grid;grid-template-columns:repeat(auto-fill,minmax(120px,1fr));gap:10px}" +
    "figure{margin:0}" +
    "img{width:100%;image-rendering:pixelated;border:1px solid #313a37;display:block}" +
    "figcaption{font-size:10px;color:#5f6b65;margin-top:3px;font-family:ui-monospace,Menlo,monospace}";
  const html = "<!doctype html><meta charset=\"utf-8\"><title>" + (p.name || "Collection") +
    "</title><style>" + css + "</style><h1>" + (p.name || "Collection") + "</h1><p>" +
    shown + " of " + count + " tokens</p><div class=\"g\">" + cells + "</div>";
  fs.writeFileSync(path.join(outRoot, "preview.html"), html);
}

module.exports = { generate: generate, violates: violates, matches: matches,
                   LIMITS: LIMITS, checkBudget: checkBudget };
