#!/usr/bin/env node
/* Verify every hardcoded mint in token.js actually exists on chain.
 *
 *   node tools/check-mints.js
 *
 * Exists because a one-character typo in the USDC mint decoded to a perfectly
 * valid 32-byte base58 address and passed every format check. Only
 * getAccountInfo catches that class of error. */
"use strict";
const fs = require("fs");
const path = require("path");
const RPC = process.env.SOLANA_RPC || "https://api.mainnet-beta.solana.com";

const src = fs.readFileSync(path.join(__dirname, "../app/public/token.js"), "utf8");
const mints = [...src.matchAll(/mint:\s*"([1-9A-HJ-NP-Za-km-z]{32,44})"/g)].map((m) => m[1]);

(async () => {
  let bad = 0;
  for (const m of mints) {
    const r = await fetch(RPC, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getAccountInfo",
        params: [m, { encoding: "jsonParsed" }] })
    }).then((x) => x.json());
    const v = r.result && r.result.value;
    const kind = v && v.data && v.data.parsed && v.data.parsed.type;
    const ok = kind === "mint";
    if (!ok) bad++;
    console.log("  " + (ok ? "ok  " : "BAD ") + m + (ok ? "  decimals=" + v.data.parsed.info.decimals : "  not a mint account"));
  }
  console.log(bad ? "\n  " + bad + " FAILED" : "\n  all " + mints.length + " mints verified");
  process.exit(bad ? 1 : 0);
})();
