#!/usr/bin/env node
/* node tools/rank-rh-pools.js
 *
 * Ask the deployed router what each reward asset's pools would actually pay,
 * then sort them best-first and record whether the asset can be bought at all.
 *
 * ── Why ordering is not cosmetic ─────────────────────────────────────────────
 * fetch-rh-pools.js records pools in the order the chain announced them, which
 * has nothing to do with which ones hold money. Most hold none: they were
 * initialised once and never funded, and an empty V4 pool does not revert — it
 * fills for zero.
 *
 * USDG is the case that matters. Twelve hookless ETH pools, and the first FIVE
 * are empty; the live ones sit at positions six, eight, nine and ten. The keeper
 * quotes in batches of four because Robinhood's eth_call gas cap refuses more,
 * so with the chain's ordering its first batch sees nothing but empties. It
 * recovers — a refused batch is retried pool by pool — but it does three times
 * the work to reach an answer that ordering makes obvious.
 *
 * ── And which assets cannot be paid at all ───────────────────────────────────
 * Some have no fillable ETH pool in either direction. NVDA has sixteen ETH
 * pools, ten of them hookless, and every one is empty. A creator can pick it in
 * the launch window today and their holders will be paid ETH forever without
 * anyone being told. `liquid: false` is what lets the picker say so.
 *
 * ⚠️ This is a SNAPSHOT. Liquidity moves, so nothing is deleted on the strength
 * of one reading — an empty pool is sorted last, not dropped, because the pool
 * that is empty this week may be the deep one next week. Re-run it periodically.
 */
"use strict";
const fs = require("fs");
const path = require("path");

const RPC = process.env.RH_RPC || "https://rpc.mainnet.chain.robinhood.com";
const ROUTER = process.env.RH_SWAP_ROUTER || "0x591c9fa02df270df71225ed3d6dda62a55e0a768";
const OUT = path.join(__dirname, "..", "app", "public", "rh-assets.json");
const ZERO = "0x" + "0".repeat(40);

// what to price with: small enough to be a fair read of a thin pool
const AMOUNT = 10n ** 15n;             // 0.001 ETH

/* Matches MAX_POOL_FEE in api/rh-keeper.js. A pool the keeper will not use must
 * not count towards an asset being buyable, or the picker promises a payout the
 * keeper then declines to make. V4 fees are hundredths of a bip, so this is 10%
 * — every normal asset on this chain wins between 0.01% and 5.01%; the handful
 * above that are 20% and 70% pools which would eat most of a payout. */
const MAX_POOL_FEE = 100000;

const pad = (v) => BigInt(v).toString(16).padStart(64, "0");
const ad = (x) => String(x).replace(/^0x/, "").toLowerCase().padStart(64, "0");
const encKey = (k) => ad(k.currency0) + ad(k.currency1) + pad(k.fee) + pad(k.tickSpacing) + ad(k.hooks);
// quoteBest((address,address,uint24,int24,address)[],uint256)
const encQuoteBest = (keys, a) =>
  "0x33a3a81b" + pad(64) + pad(a) + pad(keys.length) + keys.map(encKey).join("");

let id = 0;
async function rpc(method, params) {
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      const r = await fetch(RPC, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params }),
        signal: AbortSignal.timeout(30000)
      });
      if (r.status === 429) throw new Error("429");
      const j = await r.json();
      if (j.error) throw new Error(j.error.message || "rpc error");
      return j.result;
    } catch (e) {
      if (attempt === 4) throw e;
      await new Promise((s) => setTimeout(s, 500 * Math.pow(2, attempt)));
    }
  }
}

/* One pool at a time. Batching is what the keeper does to save round trips at
 * payout time; here the goal is a reading for EVERY pool, and a batch only
 * reports its winner. */
async function quoteOne(key) {
  try {
    const out = await rpc("eth_call", [
      { to: ROUTER, data: encQuoteBest([key], AMOUNT) }, "latest"]);
    if (!out || out === "0x") return 0n;
    return BigInt("0x" + out.replace(/^0x/, "").slice(64, 128));
  } catch (e) {
    return 0n;                        // unpriceable reads the same as empty here
  }
}

async function main() {
  const doc = JSON.parse(fs.readFileSync(OUT, "utf8"));
  const assets = (doc.tokens || []).filter(
    (t) => String(t.address).toLowerCase() !== ZERO && (t.ethPools || []).length);
  console.log(`Pricing ${assets.length} assets through ${ROUTER}\n`);

  let liquid = 0, dry = [];
  for (let i = 0; i < assets.length; i++) {
    const t = assets[i];
    const hookless = (t.ethPools || []).filter(
      (k) => k.hooks === ZERO && Number(k.fee) <= MAX_POOL_FEE);
    const scored = [];
    for (const k of hookless) scored.push({ k, out: await quoteOne(k) });

    /* Best first. Empty pools keep their place at the back rather than being
     * removed — this is one reading of a market that moves. */
    scored.sort((a, b) => (b.out > a.out ? 1 : b.out < a.out ? -1 : 0));
    // kept, but behind everything the keeper would actually use
    const rest = (t.ethPools || []).filter(
      (k) => !(k.hooks === ZERO && Number(k.fee) <= MAX_POOL_FEE));
    t.ethPools = scored.map((s) => s.k).concat(rest);

    const best = scored.length ? scored[0].out : 0n;
    t.liquid = best > 0n;
    t.quotedAt = best > 0n ? (Number(best) / Math.pow(10, t.decimals || 18)) : 0;
    if (t.liquid) liquid++; else dry.push(t.symbol);

    process.stdout.write(
      `\r  ${i + 1}/${assets.length}  ${liquid} fillable` + " ".repeat(20));
  }
  console.log("");

  doc.rankedAt = new Date().toISOString();
  doc.note = "Verified on chain. `ethPools` are ETH-paired PoolKeys, best-first " +
    "by a live quote; `liquid` is whether any of them could fill at all.";
  fs.writeFileSync(OUT, JSON.stringify(doc, null, 2) + "\n");

  console.log(`\n${liquid}/${assets.length} assets can actually be bought with ETH`);
  if (dry.length) {
    console.log(`\n⚠️  ${dry.length} have pools but none that can fill — holders ` +
      `choosing these are paid ETH:\n   ${dry.join(" ")}`);
  }
  console.log(`\nwritten to ${OUT}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
