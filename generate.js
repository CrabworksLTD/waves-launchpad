#!/usr/bin/env node
"use strict";
const fs = require("fs");
const path = require("path");
const png = require("./lib/png");
const { loadCatalog, rate } = require("./lib/catalog");

const ROOT = __dirname;

// ---------- config ----------
const DEFAULTS = {
  name: "Cooker",
  symbol: "COOK",
  description: "Cookers. Let him cook.",
  supply: 500,
  scale: 16,              // 32px art -> 512px output
  schema: "both",         // erc721 | metaplex | both
  seed: 20260803,
  baseUri: "",            // e.g. "ipfs://CID/" — appended with <id>.png
  background: "",         // hex to flatten onto, "" keeps transparency
  out: "output"
};

function parseArgs(argv) {
  const cfgFile = path.join(ROOT, "cookers.config.json");
  const fromFile = fs.existsSync(cfgFile)
    ? JSON.parse(fs.readFileSync(cfgFile, "utf8")) : {};
  const cfg = Object.assign({}, DEFAULTS, fromFile);

  for (let i = 2; i < argv.length; i++) {
    const m = /^--([\w-]+)(?:=(.*))?$/.exec(argv[i]);
    if (!m) continue;
    const key = m[1].replace(/-([a-z])/g, function (_, c) { return c.toUpperCase(); });
    let val = m[2] !== undefined ? m[2] : argv[++i];
    if (typeof DEFAULTS[key] === "number") val = Number(val);
    cfg[key] = val;
  }
  return cfg;
}

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

function pick(options, rand) {
  let total = 0;
  for (let i = 0; i < options.length; i++) total += options[i].weight;
  let x = rand() * total;
  for (let i = 0; i < options.length; i++) {
    x -= options[i].weight;
    if (x <= 0) return i;
  }
  return options.length - 1;
}

// ---------- exclusion rules ----------
// rules.json: { "exclude": [ { "when": {"Headwear":"Toque"},
//                             "forbid": {"Eyes":["Shades","Rekt"]} } ] }
function loadRules() {
  const f = path.join(ROOT, "rules.json");
  if (!fs.existsSync(f)) return [];
  return JSON.parse(fs.readFileSync(f, "utf8")).exclude || [];
}

// A value ending in " *" matches by prefix, so "Man Bun *" covers every color
// of that style. Without this, adding a new hair color silently punches a hole
// in every rule that listed the old ones by name.
function matches(value, pattern) {
  if (pattern.slice(-2) === " *") return value.indexOf(pattern.slice(0, -1)) === 0;
  return value === pattern;
}

function anyMatch(value, spec) {
  return Array.isArray(spec)
    ? spec.some(function (p) { return matches(value, p); })
    : matches(value, spec);
}

function violates(combo, rules) {
  return rules.some(function (r) {
    const whenHit = Object.keys(r.when).every(function (k) {
      return anyMatch(combo[k], r.when[k]);
    });
    if (!whenHit) return false;
    return Object.keys(r.forbid).some(function (k) {
      return anyMatch(combo[k], r.forbid[k]);
    });
  });
}

// A 1/1's overlay is stored the way the editor stores art: planes of palette
// keys, each with its own opacity. Resolve them the same way the editor does.
function renderPlanes(planes) {
  const spec = require("./lib/spec");
  const N = spec.SIZE;
  const hexOf = function (k) {
    if (typeof k === "string" && k.charAt(0) === "#") return k;
    const s = spec.slots.concat(spec.literals).find(function (x) { return x.key === k; });
    return s ? s.hex : null;
  };
  const img = png.blank(N, N);
  planes.forEach(function (L) {
    if (L.visible === false) return;
    const a = Math.round((L.opacity == null ? 1 : L.opacity) * 255);
    if (a <= 0) return;
    const lay = png.blank(N, N);
    for (let i = 0; i < N * N; i++) {
      const h = hexOf(L.grid[i]);
      if (!h) continue;
      const o = i * 4;
      lay.data[o] = parseInt(h.slice(1, 3), 16);
      lay.data[o + 1] = parseInt(h.slice(3, 5), 16);
      lay.data[o + 2] = parseInt(h.slice(5, 7), 16);
      lay.data[o + 3] = a;
    }
    png.over(img, lay);
  });
  return img;
}

// ---------- main ----------
function main() {
  const cfg = parseArgs(process.argv);
  const cats = loadCatalog(path.join(ROOT, "traits"));
  const rules = loadRules();
  const rand = rng(cfg.seed);

  const W = cats[0].options[0].img.width;
  const H = cats[0].options[0].img.height;

  let space = 1;
  cats.forEach(function (c) { space *= c.options.length; });

  console.log("Catalog: " + cats.length + " categories, " + W + "x" + H + " canvas");
  cats.forEach(function (c) {
    console.log("  " + String(c.order).padStart(2, "0") + "  " +
                c.name.padEnd(16) + c.options.length + " options");
  });
  console.log("Combination space: " + space.toLocaleString());
  if (cfg.supply > space) {
    throw new Error(
      "Supply " + cfg.supply + " exceeds the " + space.toLocaleString() +
      " unique combinations available. Add traits or lower --supply."
    );
  }

  // ---- 1/1s claim the first ids ----
  // Built in the editor, stored in draw/oneofones/. Their trait combination is
  // reserved so no random token can duplicate it, and any hand-drawn overlay is
  // composited above every trait.
  const onesDir = path.join(ROOT, "draw", "oneofones");
  const ones = fs.existsSync(onesDir)
    ? fs.readdirSync(onesDir).filter(function (f) { return /\.json$/.test(f); }).sort()
        .map(function (f) { return JSON.parse(fs.readFileSync(path.join(onesDir, f), "utf8")); })
    : [];
  if (ones.length) console.log("One-of-ones: " + ones.map(function (o) { return o.name; }).join(", "));

  const reserved = new Set();
  ones.forEach(function (o) {
    const idx = cats.map(function (c) {
      const want = o.traits[c.dir];
      const i = c.options.findIndex(function (opt) { return opt.name === want; });
      return i < 0 ? 0 : i;
    });
    reserved.add(idx.join(","));
    o._idx = idx;
  });

  // ---- roll unique tokens ----
  const seen = new Set(reserved);
  const tokens = [];
  let attempts = 0;
  const maxAttempts = cfg.supply * 200 + 10000;

  ones.forEach(function (o) {
    const combo = {};
    cats.forEach(function (c, i) { combo[c.name] = c.options[o._idx[i]].name; });
    tokens.push({ id: tokens.length + 1, idx: o._idx, combo: combo, one: o });
  });

  while (tokens.length < cfg.supply && attempts < maxAttempts) {
    attempts++;
    const idx = cats.map(function (c) { return pick(c.options, rand); });
    const combo = {};
    cats.forEach(function (c, i) { combo[c.name] = c.options[idx[i]].name; });
    if (violates(combo, rules)) continue;
    const key = idx.join(",");
    if (seen.has(key)) continue;
    seen.add(key);
    tokens.push({ id: tokens.length + 1, idx: idx, combo: combo });
  }

  if (tokens.length < cfg.supply) {
    throw new Error(
      "Only found " + tokens.length + " unique valid combinations after " +
      attempts + " attempts. Loosen rules.json or add traits."
    );
  }

  // ---- render ----
  const outDir = path.join(ROOT, cfg.out);
  const imgDir = path.join(outDir, "images");
  const metaDirs = [];
  if (cfg.schema === "erc721" || cfg.schema === "both") metaDirs.push(["erc721", path.join(outDir, "metadata-erc721")]);
  if (cfg.schema === "metaplex" || cfg.schema === "both") metaDirs.push(["metaplex", path.join(outDir, "metadata-metaplex")]);

  fs.rmSync(outDir, { recursive: true, force: true });
  fs.mkdirSync(imgDir, { recursive: true });
  metaDirs.forEach(function (d) { fs.mkdirSync(d[1], { recursive: true }); });

  const counts = {};
  cats.forEach(function (c) { counts[c.name] = {}; });

  tokens.forEach(function (t) {
    let img = png.blank(W, H);
    cats.forEach(function (c, i) {
      const opt = c.options[t.idx[i]];
      const cu0 = t.one && t.one.custom ? t.one.custom[c.dir] : null;
      // a custom asset flagged "replace" stands in for the picked trait
      const suppressed = !!(cu0 && cu0.replace && cu0.layers && cu0.layers.length);
      if (!suppressed && !/^none$/i.test(opt.name)) png.over(img, opt.img);
      counts[c.name][opt.name] = (counts[c.name][opt.name] || 0) + 1;
      // a 1/1 may replace or augment a category with its own drawn asset, which
      // belongs at that category position rather than on top of everything
      if (t.one && t.one.custom) {
        const cu = t.one.custom[c.dir];
        if (cu && cu.layers && cu.layers.length) png.over(img, renderPlanes(cu.layers));
      }
    });
    // a 1/1 overlay sits above every trait
    if (t.one && t.one.layers && t.one.layers.length) png.over(img, renderPlanes(t.one.layers));
    if (cfg.background) png.flatten(img, cfg.background);
    img = png.scale(img, cfg.scale);
    png.write(path.join(imgDir, t.id + ".png"), img);

    // "None" is listed rather than dropped, so every token carries the same
    // trait_types and "no hat" stays filterable on a marketplace.
    const attributes = cats.map(function (c, i) {
      return { trait_type: c.name, value: c.options[t.idx[i]].name };
    });

    const image = cfg.baseUri ? cfg.baseUri + t.id + ".png" : t.id + ".png";
    const displayName = t.one ? cfg.name + " #" + t.id + " \u2014 " + t.one.name : cfg.name + " #" + t.id;
    if (t.one) {
      attributes.push({ trait_type: "1 of 1", value: t.one.name });
      // a labelled hand-drawn addition becomes its own trait, so it is
      // filterable next to everything else
      if (t.one.extra) attributes.push({ trait_type: "Extra", value: t.one.extra });
      // a named custom asset overrides what that category reports
      Object.keys(t.one.custom || {}).forEach(function (dir) {
        const cu = t.one.custom[dir];
        if (!cu || !cu.name) return;
        const cat = cats.find(function (c) { return c.dir === dir; });
        if (!cat) return;
        const a = attributes.find(function (x) { return x.trait_type === cat.name; });
        if (a) a.value = cu.name; else attributes.push({ trait_type: cat.name, value: cu.name });
      });
    }

    metaDirs.forEach(function (d) {
      const body = d[0] === "erc721"
        ? { name: displayName, description: cfg.description, image: image, attributes: attributes }
        : {
            name: displayName, symbol: cfg.symbol, description: cfg.description,
            image: image, attributes: attributes,
            properties: { files: [{ uri: image, type: "image/png" }], category: "image" }
          };
      fs.writeFileSync(path.join(d[1], t.id + ".json"), JSON.stringify(body, null, 2));
    });

    if (t.id % 100 === 0 || t.id === tokens.length) {
      process.stdout.write("\r  rendered " + t.id + "/" + tokens.length);
    }
  });
  process.stdout.write("\n");

  // ---- rarity report ----
  const rarity = cats.map(function (c) {
    return {
      trait_type: c.name,
      values: c.options.map(function (o, i) {
        const n = counts[c.name][o.name] || 0;
        return {
          value: o.name,
          weight: o.weight,
          target: +(rate(c, i) * 100).toFixed(2),
          actual: +((n / tokens.length) * 100).toFixed(2),
          count: n
        };
      }).sort(function (a, b) { return a.actual - b.actual; })
    };
  });
  fs.writeFileSync(path.join(outDir, "rarity.json"), JSON.stringify(rarity, null, 2));

  // token -> traits index, handy for listing pages and sanity checks
  fs.writeFileSync(
    path.join(outDir, "tokens.json"),
    JSON.stringify(tokens.map(function (t) { return { id: t.id, traits: t.combo }; }), null, 2)
  );

  writePreview(outDir, tokens, cfg);

  // ---- 1/1s, also collected on their own ----
  // They stay in the main collection under their token id; this is a second copy
  // grouped by name, so the specials can be handled without picking them out of
  // 999 files.
  const oneTokens = tokens.filter(function (t) { return t.one; });
  if (oneTokens.length) {
    const oneDir = path.join(outDir, "one-of-ones");
    fs.mkdirSync(oneDir, { recursive: true });
    const index = [];
    oneTokens.forEach(function (t) {
      const slug = t.one.name.replace(/[\/\\:]/g, "-");
      fs.copyFileSync(path.join(imgDir, t.id + ".png"), path.join(oneDir, slug + ".png"));
      metaDirs.forEach(function (d) {
        fs.copyFileSync(path.join(d[1], t.id + ".json"),
                        path.join(oneDir, slug + "-" + d[0] + ".json"));
      });
      index.push({ name: t.one.name, id: t.id, traits: t.combo,
                   extra: t.one.extra || null,
                   overlay: !!(t.one.layers && t.one.layers.length) });
    });
    fs.writeFileSync(path.join(oneDir, "index.json"), JSON.stringify(index, null, 2));
    console.log("  one-of-ones/ " + oneTokens.length + " special" +
                (oneTokens.length === 1 ? "" : "s") + ": " +
                oneTokens.map(function (t) { return t.one.name + " (#" + t.id + ")"; }).join(", "));
  }

  console.log("\nDone.");
  console.log("  " + tokens.length + " tokens  ->  " + path.relative(process.cwd(), outDir));
  console.log("  images/      " + (W * cfg.scale) + "x" + (H * cfg.scale) + " PNG");
  metaDirs.forEach(function (d) { console.log("  " + path.basename(d[1]) + "/"); });
  console.log("  rarity.json  target vs actual distribution");
  console.log("  preview.html contact sheet");
  console.log("\nUnique combos used: " + tokens.length + " of " + space.toLocaleString() +
              " (" + ((tokens.length / space) * 100).toFixed(2) + "%)");
}

function writePreview(outDir, tokens, cfg) {
  const shown = tokens.slice(0, 200);
  const cells = shown.map(function (t) {
    const traits = Object.keys(t.combo)
      .map(function (k) { return k + ": " + t.combo[k]; }).join("\n");
    return '<figure title="' + traits.replace(/"/g, "&quot;") + '">' +
           '<img src="images/' + t.id + '.png" alt="' + cfg.name + " #" + t.id + '">' +
           "<figcaption>#" + t.id + "</figcaption></figure>";
  }).join("\n");

  fs.writeFileSync(path.join(outDir, "preview.html"), `<!doctype html>
<meta charset="utf-8">
<title>${cfg.name} — preview</title>
<style>
  body{margin:0;background:#151a19;color:#c9d1cc;
    font:400 14px/1.5 system-ui,-apple-system,sans-serif;padding:28px}
  h1{font:800 22px/1 "Helvetica Neue",Helvetica,sans-serif;letter-spacing:-.02em;
    text-transform:uppercase;margin:0 0 4px}
  p{color:#8b968f;margin:0 0 24px;font-size:13px}
  .grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(104px,1fr));gap:10px}
  figure{margin:0;border:1px solid #333c39;background:#1e2422}
  img{display:block;width:100%;height:auto;image-rendering:pixelated}
  figcaption{padding:5px 7px;font-size:10px;color:#5f6b65;border-top:1px solid #2a3230;
    font-family:ui-monospace,Menlo,monospace}
</style>
<h1>${cfg.name}</h1>
<p>First ${shown.length} of ${tokens.length}. Hover any tile for its traits.</p>
<div class="grid">
${cells}
</div>
`);
}

try {
  main();
} catch (err) {
  console.error("\n" + err.message + "\n");
  process.exit(1);
}
