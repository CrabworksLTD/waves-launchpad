#!/usr/bin/env node
/* Build the Raydium LaunchLab client into app/public/vendor/raydium.esm.js.
 *   node tools/build-raydium.js
 * Same node-builtin alias map as the DBC / Turbo builds — raydium-sdk-v2 pulls
 * in buffer, crypto, stream through its Anchor + spl-token dependencies. */
"use strict";
const path = require("path");
const fs = require("fs");
const esbuild = require("esbuild");
const ROOT = path.join(__dirname, "..");
const OUT = path.join(ROOT, "app/public/vendor/raydium.esm.js");

const shim = (n) => require.resolve(n, { paths: [ROOT] });
const alias = {};
for (const [from, to] of Object.entries({
  stream: "stream-browserify", crypto: "crypto-browserify",
  buffer: "buffer", util: "util", events: "events", process: "process",
})) { alias[from] = shim(to); alias["node:" + from] = shim(to); }

esbuild.build({
  entryPoints: [path.join(ROOT, "tools/raydium-entry.mjs")],
  bundle: true, format: "esm", platform: "browser", target: ["es2020"],
  minify: true, legalComments: "none", outfile: OUT,
  inject: [path.join(ROOT, "tools/turbo-shim.mjs")],
  alias,
  define: { global: "globalThis", "process.env.NODE_ENV": '"production"' },
  logLevel: "warning",
}).then(function () {
  console.log("  vendor/raydium.esm.js  " + (fs.statSync(OUT).size / 1024).toFixed(0) + " KB");
}).catch(function (e) { console.error(e); process.exit(1); });
