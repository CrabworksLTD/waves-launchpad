#!/usr/bin/env node
/* Build the Metaplex client into app/public/vendor/metaplex.esm.js.
 *
 *   node tools/build-metaplex.js
 *
 * Only needs rerunning when tools/metaplex-entry.mjs changes or the Metaplex
 * packages are upgraded. The output is committed so a clean checkout can serve
 * the site without installing anything. */
"use strict";

const path = require("path");
const fs = require("fs");
const esbuild = require("esbuild");

const ROOT = path.join(__dirname, "..");
const OUT = path.join(ROOT, "app/public/vendor/metaplex.esm.js");

esbuild.build({
  entryPoints: [path.join(ROOT, "tools/metaplex-entry.mjs")],
  bundle: true,
  format: "esm",
  platform: "browser",
  target: ["es2020"],
  minify: true,
  legalComments: "none",
  outfile: OUT,
  // Umi's web3.js dependency reaches for node globals it never uses in the
  // browser paths we call. Defining them is cheaper than shipping polyfills.
  define: { global: "globalThis", "process.env.NODE_ENV": '"production"' },
  logLevel: "info",
}).then(function () {
  const kb = fs.statSync(OUT).size / 1024;
  console.log("\n  " + path.relative(ROOT, OUT) + "  " + kb.toFixed(0) + " KB");
  if (kb > 3000) {
    console.log("  ⚠ over 3 MB — check tools/metaplex-entry.mjs for a stray export *");
  }
}).catch(function (e) {
  console.error(e);
  process.exit(1);
});
