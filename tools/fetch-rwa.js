#!/usr/bin/env node
/* Build the RWA reward-asset list into app/public/rwa.json.
 *
 *   node tools/fetch-rwa.js
 *
 * Not hand-typed, deliberately. Searching Jupiter for "TSLAx" returns five
 * different tokens with that exact symbol — four of them pump.fun impostors
 * with the same name. Choosing a reward asset by symbol would pay a
 * collection's holders in a fake, and it would look correct in review.
 *
 * Covers three issuers, because the first version only knew about one and
 * silently excluded the other two:
 *
 *   Backed xStocks   `x` suffix, `Xs` vanity mint prefix   AAPLx, GLDx, SLVx
 *   Ondo Global      `on` suffix, no common prefix          USOon, BNOon, SLVon
 *   standalone       tokenised commodities                  PAXG, XAUt0
 *
 * Requiring the `xstocks` tag AND an Xs prefix — the original filter — dropped
 * Ondo's entire catalogue and every commodity token that is not an ETF wrapper.
 * That is how crude oil went missing.
 *
 * Filters, both required:
 *   1. Jupiter `verified` tag, plus at least one asset-class tag
 *   2. getAccountInfo says it is a live mint account
 *
 * The issuer is recorded rather than used as a gate, so a UI can group by it
 * and a human can see what they are picking.
 */
"use strict";

const fs = require("fs");
const path = require("path");

const RPC = process.env.SOLANA_RPC || "https://api.mainnet-beta.solana.com";
const SEARCH = "https://lite-api.jup.ag/tokens/v2/search?query=";
const OUT = path.join(__dirname, "../app/public/rwa.json");

// Jupiter's search pages at 20, so one query will not enumerate 100+ tickers.
// Three passes over the alphabet: the shared name, each letter alone (matches
// symbols and company names), and letter+x (catches tickers whose x-suffixed
// form is the only match). Overlapping on purpose — the set is deduped by mint
// and a missed ticker is a reward asset a creator cannot choose.
const AZ = "ABCDEFGHIJKLMNOPQRSTUVWXYZ".split("");
const COMMODITY = ["gold", "silver", "oil", "crude", "brent", "platinum", "palladium",
                   "copper", "uranium", "natural gas", "wheat", "corn", "commodity",
                   "PAXG", "XAUT", "bullion"];
const QUERIES = ["xStock", "xStocks", "Ondo"]
  .concat(AZ)                       // symbols and company names
  .concat(AZ.map((c) => c + "x"))   // Backed tickers
  .concat(AZ.map((c) => c + "on"))  // Ondo tickers
  .concat(COMMODITY);               // commodities are not named after letters

const ASSET_TAGS = ["xstocks", "stocks", "equities", "rwa", "commodities"];
const COMMODITY_WORDS = ["gold", "silver", "oil", "crude", "brent", "platinum",
  "palladium", "copper", "uranium", "natural gas", "bullion", "metal", "commodity"];

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
      const sym = t.symbol || "";
      if (!id) continue;
      // filter 1: Jupiter-verified AND carries an asset-class tag. `verified`
      // alone is too broad; an asset-class tag alone lets an impostor through
      // by self-declaring.
      if (!tags.includes("verified")) continue;
      if (!ASSET_TAGS.some((x) => tags.includes(x))) continue;

      const issuer = id.startsWith("Xs") ? "backed"
                   : /on$/.test(sym) ? "ondo"
                   : "other";
      const name = (t.name || "").toLowerCase();
      const kind = COMMODITY_WORDS.some((w) => name.includes(w)) ? "commodity" : "equity";

      if (!found.has(id)) {
        found.set(id, { symbol: sym, name: t.name, mint: id, issuer: issuer, kind: kind,
                        liquidity: Number(t.liquidity) || 0 });
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
    note: "Generated by tools/fetch-rwa.js. Do not hand-edit — a mistyped mint " +
          "decodes to a valid address and pays rewards into nothing.",
    generatedAt: new Date().toISOString(),
    count: verified.length,
    tokens: verified
  }, null, 2) + "\n");

  console.log("  verified on chain: " + verified.length);
  if (rejected.length) {
    console.log("  rejected (not a live mint): " + rejected.map((r) => r.symbol).join(", "));
  }
  const byKind = { commodity: [], equity: [] };
  verified.forEach((t) => byKind[t.kind].push(t.symbol));
  const byIssuer = {};
  verified.forEach((t) => { byIssuer[t.issuer] = (byIssuer[t.issuer] || 0) + 1; });
  console.log("  issuers: " + Object.entries(byIssuer).map(([k, v]) => k + "=" + v).join("  "));
  console.log("\n  commodities (" + byKind.commodity.length + "): " + byKind.commodity.join(" "));
  console.log("\n  equities (" + byKind.equity.length + "): " + byKind.equity.slice(0, 60).join(" ") +
              (byKind.equity.length > 60 ? " …" : ""));
  console.log("\n  wrote " + path.relative(path.join(__dirname, ".."), OUT));
})();
