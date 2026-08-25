#!/usr/bin/env node
/* Rename the product.
 *
 *   node tools/rename.js SUNPAD
 *   node tools/rename.js SUNPAD --domain sunpad.online
 *
 * Every name-bearing string lives in app/public/brand.js except the few that
 * have to be literal in markup — the <title>, the OG tags and the wordmark,
 * which cannot come from JS without a flash of the wrong name on load. This
 * rewrites both, so renaming stays a one-command operation.
 *
 * It splits the wordmark in half for the two-tone <span>/<em> treatment. For
 * an odd-length name the first half gets the extra character. */
"use strict";

const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const BRAND = path.join(ROOT, "app/public/brand.js");
const HTML = [path.join(ROOT, "app/public/app.html")];

const args = process.argv.slice(2);
const next = (args[0] || "").trim().toUpperCase();
const di = args.indexOf("--domain");
const domain = di >= 0 ? (args[di + 1] || "").trim().toLowerCase() : null;

if (!next || next.startsWith("-")) {
  console.error("usage: node tools/rename.js NEWNAME [--domain example.com]");
  process.exit(1);
}
if (!/^[A-Z][A-Z0-9]{1,23}$/.test(next)) {
  console.error(`refusing "${next}" — letters and digits only, 2-24 chars, must start with a letter.`);
  console.error("The name becomes a filename extension and a localStorage prefix, so keep it plain.");
  process.exit(1);
}

const brandSrc = fs.readFileSync(BRAND, "utf8");
const m = brandSrc.match(/var NAME = "([A-Z0-9]+)";/);
if (!m) {
  console.error("could not find `var NAME = \"...\";` in brand.js — did the file change shape?");
  process.exit(1);
}
const prev = m[1];
if (prev === next && !domain) {
  console.log(`already named ${next}, nothing to do.`);
  process.exit(0);
}

// brand.js — the name, and optionally the domain
let out = brandSrc.replace(/var NAME = "[A-Z0-9]+";/, `var NAME = "${next}";`);
if (domain !== null) {
  out = out.replace(/domain: "[^"]*",/, `domain: "${domain}",`);
}
fs.writeFileSync(BRAND, out);
console.log(`brand.js        ${prev} -> ${next}${domain !== null ? `  (domain: ${domain || "none"})` : ""}`);

// markup — title, OG tags, wordmark
const half = Math.ceil(next.length / 2);
const wordA = next.slice(0, half);
const wordB = next.slice(half);
const prevHalf = Math.ceil(prev.length / 2);
const prevA = prev.slice(0, prevHalf);
const prevB = prev.slice(prevHalf);

for (const file of HTML) {
  if (!fs.existsSync(file)) continue;
  const before = fs.readFileSync(file, "utf8");
  const after = before
    .split(`<span>${prevA}</span><em>${prevB}</em>`).join(`<span>${wordA}</span><em>${wordB}</em>`)
    .split(prev).join(next);
  if (after !== before) {
    fs.writeFileSync(file, after);
    console.log(`${path.relative(ROOT, file).padEnd(16)}${prev} -> ${next}`);
  }
}

// Anything left is a string that escaped brand.js — worth knowing about.
const stray = [];
for (const dir of ["app/public", "app/server", "lib", "tools"]) {
  const d = path.join(ROOT, dir);
  if (!fs.existsSync(d)) continue;
  for (const f of fs.readdirSync(d)) {
    if (!/\.(js|css|html)$/.test(f)) continue;
    const p = path.join(d, f);
    if (p === BRAND) continue;
    const txt = fs.readFileSync(p, "utf8");
    const n = (txt.match(new RegExp(prev, "gi")) || []).length;
    if (n) stray.push(`${path.relative(ROOT, p)} (${n})`);
  }
}
if (stray.length) {
  console.log("\nstill mentions the old name — check whether these should move into brand.js:");
  for (const s of stray) console.log("  " + s);
}

console.log(`\nDone. Directory and git remote are not touched — rename those yourself:
  mv ${path.basename(ROOT)} ${next.toLowerCase()}`);
