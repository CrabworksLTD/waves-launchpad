#!/usr/bin/env node
/* Build the xStocks reward-asset list into app/public/xstocks.json.
 *
 *   node tools/fetch-xstocks.js
 *
 * Not hand-typed, deliberately. Searching Jupiter for "TSLAx" returns five
 * different tokens with that exact symbol — four of them pump.fun impostors
 * with the same name. Choosing a reward asset by symbol would pay a
 * collection's holders in a fake, and it would look completely correct in
 * review.
 *
 * Three filters, all of which must pass:
 *   1. Jupiter's `xstocks` tag        — the issuer's own tokens
 *   2. an `Xs` address prefix         — Backed uses vanity mints; every real
 *                                       one starts with it, no impostor did
 *   3. getAccountInfo says it is a live mint account
 *
 * Any of the three alone is defeatable. Together they are not worth attacking
 * for the size of reward pool this routes.
 */
"use strict";

const fs = require("fs");
const path = require("path");

const RPC = process.env.SOLANA_RPC || "https://api.mainnet-beta.solana.com";
const SEARCH = "https://lite-api.jup.ag/tokens/v2/search?query=";
const OUT = path.join(__dirname, "../app/public/xstocks.json");

// Jupiter's search pages at 20, so one query will not enumerate 100+ tickers.
// Three passes over the alphabet: the shared name, each letter alone (matches
// symbols and company names), and letter+x (catches tickers whose x-suffixed
// form is the only match). Overlapping on purpose — the set is deduped by mint
// and a missed ticker is a reward asset a creator cannot choose.
const AZ = "ABCDEFGHIJKLMNOPQRSTUVWXYZ".split("");
const QUERIES = ["xStock", "xStocks"]
  .concat(AZ)
  .concat(AZ.map((c) => c + "x"));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function search(q) {
  try {
    const r = await fetch(SEARCH + encodeURIComponent(q));
    if (!r.ok) return [];
    const d = await r.json();
    return Array.isArray(d) ? d : (d.tokens || []);
  } catch (e) { return []; }
}

/* Verify in batches of 100 with getMultipleAccounts.
 *
 * The first version did one getAccountInfo per mint and treated a failed
 * request as "not a mint". Against a public RPC that rate limits, that
 * rejected JPMx, NFLXx, KOx and eighty others as fake. A verifier that cannot
 * tell "this account does not exist" from "I could not ask" is worse than no
 * verifier, because it fails in the confident direction.
 *
 * Now: batched so there are two requests instead of two hundred, retried on
 * transport failure, and a mint is only rejected when the RPC actually
 * answered and said the account is absent or is not a mint. */
async function rpcCall(method, params, attempt = 0) {
  try {
    const r = await fetch(RPC, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params })
    });
    if (r.status === 429) throw new Error("rate limited");
    const d = await r.json();
    if (d.error) throw new Error(d.error.message || "rpc error");
    return d.result;
  } catch (e) {
    if (attempt >= 4) throw e;                       // give up loudly, not quietly
    await sleep(600 * Math.pow(2, attempt));
    return rpcCall(method, params, attempt + 1);
  }
}

async function verifyBatch(addresses) {
  const out = new Map();
  for (let i = 0; i < addresses.length; i += 100) {
    const slice = addresses.slice(i, i + 100);
    const res = await rpcCall("getMultipleAccounts", [slice, { encoding: "jsonParsed" }]);
    const vals = (res && res.value) || [];
    slice.forEach((addr, j) => {
      const v = vals[j];
      const parsed = v && v.data && v.data.parsed;
      out.set(addr, parsed && parsed.type === "mint"
        ? { decimals: parsed.info.decimals, owner: v.owner } : null);
    });
    await sleep(250);
  }
  return out;
}

(async () => {
  const found = new Map();

  process.stdout.write("  searching");
  for (const q of QUERIES) {
    const rows = await search(q);
    for (const t of rows) {
      const tags = t.tags || [];
      const id = t.id || t.address;
      if (!id) continue;
      if (!tags.includes("xstocks")) continue;            // filter 1
      if (!id.startsWith("Xs")) continue;                 // filter 2
      if (!found.has(id)) {
        found.set(id, { symbol: t.symbol, name: t.name, mint: id });
      }
    }
    process.stdout.write(".");
    await sleep(120);                                     // be polite to a free endpoint
  }
  console.log("\n  candidates: " + found.size);

  const all = [...found.values()];
  let live;
  try {
    live = await verifyBatch(all.map((t) => t.mint));     // filter 3
  } catch (e) {
    console.error("\n  RPC verification failed: " + e.message);
    console.error("  Refusing to write a list that was not checked. Set SOLANA_RPC to a paid endpoint and rerun.");
    process.exit(1);
  }

  const verified = [];
  const rejected = [];
  for (const t of all) {
    const info = live.get(t.mint);
    if (info) verified.push(Object.assign({}, t, { decimals: info.decimals }));
    else rejected.push(t);
  }

  verified.sort((a, b) => a.symbol.localeCompare(b.symbol));

  fs.writeFileSync(OUT, JSON.stringify({
    note: "Generated by tools/fetch-xstocks.js. Do not hand-edit — a mistyped " +
          "mint decodes to a valid address and pays rewards into nothing.",
    generatedAt: new Date().toISOString(),
    count: verified.length,
    tokens: verified
  }, null, 2) + "\n");

  console.log("  verified on chain: " + verified.length);
  if (rejected.length) {
    console.log("  rejected (not a live mint): " + rejected.map((r) => r.symbol).join(", "));
  }
  console.log("\n  " + verified.map((t) => t.symbol).join(" "));
  console.log("\n  wrote " + path.relative(path.join(__dirname, ".."), OUT));
})();
