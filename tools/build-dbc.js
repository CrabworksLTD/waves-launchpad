#!/usr/bin/env node
/* Build the Meteora DBC client into app/public/vendor/dbc.esm.js.
 *   node tools/build-dbc.js
 * Same node-builtin alias map as the Turbo build — the SDK pulls in buffer and
 * crypto through its Anchor dependency. */
"use strict";
const path = require("path");
const fs = require("fs");
const esbuild = require("esbuild");
const ROOT = path.join(__dirname, "..");
const OUT = path.join(ROOT, "app/public/vendor/dbc.esm.js");

const shim = (n) => require.resolve(n, { paths: [ROOT] });
const alias = {};
for (const [from, to] of Object.entries({
  stream: "stream-browserify", crypto: "crypto-browserify",
  buffer: "buffer", util: "util", events: "events", process: "process",
})) { alias[from] = shim(to); alias["node:" + from] = shim(to); }

esbuild.build({
  entryPoints: [path.join(ROOT, "tools/dbc-entry.mjs")],
  bundle: true, format: "esm", platform: "browser", target: ["es2020"],
  minify: true, legalComments: "none", outfile: OUT,
  inject: [path.join(ROOT, "tools/turbo-shim.mjs")],
  alias,
  define: { global: "globalThis", "process.env.NODE_ENV": '"production"' },
  logLevel: "warning",
}).then(function () {
  console.log("  vendor/dbc.esm.js  " + (fs.statSync(OUT).size / 1024).toFixed(0) + " KB");
}).catch(function (e) { console.error(e); process.exit(1); });
