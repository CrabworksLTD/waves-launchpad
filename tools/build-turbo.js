#!/usr/bin/env node
/* Build the Turbo web client into app/public/vendor/turbo.esm.js.
 *
 *   node tools/build-turbo.js
 *
 * The SDK's "web" entry still reaches for node builtins (stream, crypto,
 * buffer) through arbundles, so they are aliased to browserify shims here.
 * That is what the browser-polyfill devDependencies exist for — without the
 * alias map esbuild refuses to resolve them and the build dies. */
"use strict";
const path = require("path");
const fs = require("fs");
const esbuild = require("esbuild");
const ROOT = path.join(__dirname, "..");
const OUT = path.join(ROOT, "app/public/vendor/turbo.esm.js");

const shim = (name) => require.resolve(name, { paths: [ROOT] });
const alias = {};
for (const [from, to] of Object.entries({
  stream: "stream-browserify",
  crypto: "crypto-browserify",
  buffer: "buffer",
  util: "util",
  events: "events",
  process: "process",
})) {
  alias[from] = shim(to);
  alias["node:" + from] = shim(to);   // node: prefix is a separate specifier
}

esbuild.build({
  entryPoints: [path.join(ROOT, "tools/turbo-entry.mjs")],
  bundle: true, format: "esm", platform: "browser", target: ["es2020"],
  minify: true, legalComments: "none", outfile: OUT,
  inject: [path.join(ROOT, "tools/turbo-shim.mjs")],
  alias,
  define: { global: "globalThis", "process.env.NODE_ENV": '"production"' },
  logLevel: "warning",
}).then(function () {
  console.log("  vendor/turbo.esm.js  " + (fs.statSync(OUT).size / 1048576).toFixed(1) + " MB");
}).catch(function (e) { console.error(e); process.exit(1); });
