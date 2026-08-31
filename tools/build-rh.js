#!/usr/bin/env node
/* Generates app/public/rh.html — the Robinhood-side homepage — from
 * index.html. Same page, three differences: the share meta carries the
 * Robinhood card, the favicon is the lime mark, and a head script pins the
 * chain before shell.js boots so there is no purple flash and no redirect
 * for crawlers to mishandle (Telegram refused to unfurl through the
 * ?chain=rh 307 — a real page with real tags is un-refusable).
 *
 * Run after any index.html edit:  node tools/build-rh.js  */
"use strict";
const fs = require("fs");
const path = require("path");

const pub = path.join(__dirname, "..", "app", "public");
let s = fs.readFileSync(path.join(pub, "index.html"), "utf8");

s = s.replace(/https:\/\/www\.waveslaunchpad\.xyz\/art\/og\.png/g,
  "https://www.waveslaunchpad.xyz/art/og-rh.png");
s = s.replace('<meta property="og:url" content="https://www.waveslaunchpad.xyz/">',
  '<meta property="og:url" content="https://www.waveslaunchpad.xyz/rh">');

// pin the chain before any script runs
s = s.replace("<script src=\"/brand.js\"></script>",
  "<script>try { localStorage.setItem(\"shl-chain\", \"robinhood\"); } catch (e) {}</script>\n" +
  "<script src=\"/brand.js\"></script>");

if (!/shl-chain/.test(s)) throw new Error("chain pin did not land");
fs.writeFileSync(path.join(pub, "rh.html"), s);
console.log("rh.html written (" + s.length + " bytes)");
