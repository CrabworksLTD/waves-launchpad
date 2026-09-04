#!/usr/bin/env node
/* node tools/fetch-rh-pools.js
 *
 * The ETH-paired Uniswap V4 pools for every reward asset, written back into
 * app/public/rh-assets.json as `ethPools`.
 *
 * ── Why this is needed at all ────────────────────────────────────────────────
 * The keeper claims a pot of ETH and has to hand holders the asset their
 * creator chose. On Solana that is a Jupiter call: name the two mints and it
 * routes. Uniswap V4 has no such thing — a swap names a POOL, and a pool is
 * identified by its whole key:
 *
 *     (currency0, currency1, fee, tickSpacing, hooks)
 *
 * not by an address. rh-assets.json records how many pools an asset appears in,
 * which was enough to decide it was tradeable but is not enough to trade it.
 * Without the key there is nothing to swap against, which is why the keeper
 * pays ETH today regardless of what the creator picked.
 *
 * ── Where the keys come from ─────────────────────────────────────────────────
 * Every pool announces its own key when it is created. The PoolManager's
 * Initialize event indexes the id and both currencies, and carries the rest in
 * its data:
 *
 *   Initialize(bytes32 indexed id, address indexed currency0,
 *              address indexed currency1, uint24 fee, int24 tickSpacing,
 *              address hooks, uint160 sqrtPriceX96, int24 tick)
 *
 * So the same sweep that found the assets can recover the keys exactly, with no
 * guessing at fee tiers. Native ETH is currency 0 by V4's ordering rule —
 * address(0) sorts below everything — so an ETH pair is any Initialize whose
 * currency0 is zero.
 *
 * ── What is deliberately NOT decided here ────────────────────────────────────
 * Which pool to actually swap through. Several fee tiers usually exist for the
 * same pair and the deepest one changes by the hour, so picking here would bake
 * in a snapshot that is stale by the time anyone trades. Every key found is
 * recorded; the keeper reads live liquidity and chooses at swap time.
 *
 * Hooked pools ARE recorded but flagged. A hook can charge, reject or reprice a
 * swap arbitrarily, and a keeper moving other people's money should not walk
 * into one blind — the keeper prefers hookless pools and only falls back to a
 * hooked one if that is all there is.
 */
"use strict";
const fs = require("fs");
const path = require("path");

const RPC = process.env.RH_RPC || "https://rpc.mainnet.chain.robinhood.com";
const OUT = path.join(__dirname, "..", "app", "public", "rh-assets.json");

const PM = "0x8366a39cc670b4001a1121b8f6a443a643e40951";
const INIT = "0xdd466e674ea557f56295e2d0218a125ea4b4f0f6f3307b95f85e6110838d6438";
const ZERO = "0x" + "0".repeat(40);

const CHUNK = 50000n;                                   // ~1.4h; wider is refused
const CHUNKS = Number(process.env.RH_CHUNKS || 40);     // ~2.3 days of pools

let id = 0;
async function rpc(method, params) {
  for (let attempt = 0; attempt < 4; attempt++) {
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
      // Robinhood rate-limits an open sweep hard; back off rather than give up
      if (attempt === 3) throw e;
      await new Promise((r) => setTimeout(r, 400 * Math.pow(2, attempt)));
    }
  }
}

const addrAt = (data, word) => "0x" + data.slice(word * 64 + 24, (word + 1) * 64).toLowerCase();
const numAt = (data, word) => parseInt(data.slice(word * 64, (word + 1) * 64), 16);

/* int24 comes back as a 256-bit two's-complement word. tickSpacing is always
 * positive in practice, but reading it as unsigned would turn a negative into
 * an astronomical number and produce a key that matches no pool — silently, at
 * swap time. */
function intAt(data, word) {
  const n = BigInt("0x" + data.slice(word * 64, (word + 1) * 64));
  return Number(n >= 1n << 255n ? n - (1n << 256n) : n);
}

async function main() {
  const doc = JSON.parse(fs.readFileSync(OUT, "utf8"));
  const wanted = new Map();
  for (const t of doc.tokens || []) {
    const a = String(t.address).toLowerCase();
    if (a === ZERO) continue;            // ETH itself needs no pool
    wanted.set(a, t);
  }
  console.log(`Looking for ETH pools for ${wanted.size} reward assets`);

  const latest = BigInt(await rpc("eth_blockNumber", []));
  const found = new Map();               // asset -> Map(keyString -> key)
  let initEvents = 0;

  for (let i = 0; i < CHUNKS; i++) {
    const to = latest - CHUNK * BigInt(i);
    if (to <= 0n) break;
    const from = to > CHUNK ? to - CHUNK + 1n : 0n;
    let logs;
    try {
      logs = await rpc("eth_getLogs", [{
        address: PM,
        fromBlock: "0x" + from.toString(16),
        toBlock: "0x" + to.toString(16),
        topics: [INIT]
      }]);
    } catch (e) {
      console.log(`\n  window ${i} refused (${String(e.message).slice(0, 50)}) — stopping`);
      break;
    }

    for (const l of logs) {
      initEvents++;
      const c0 = "0x" + l.topics[2].slice(-40).toLowerCase();
      const c1 = "0x" + l.topics[3].slice(-40).toLowerCase();
      // V4 orders currencies by address, so native ETH is always currency0
      if (c0 !== ZERO) continue;
      if (!wanted.has(c1)) continue;

      const d = String(l.data || "").replace(/^0x/, "");
      const key = {
        currency0: ZERO,
        currency1: c1,
        fee: numAt(d, 0),
        tickSpacing: intAt(d, 1),
        hooks: addrAt(d, 2)
      };
      const sig = `${key.fee}:${key.tickSpacing}:${key.hooks}`;
      if (!found.has(c1)) found.set(c1, new Map());
      found.get(c1).set(sig, key);
    }
    process.stdout.write(
      `\r  swept ${i + 1}/${CHUNKS} windows · ${initEvents} pools · ` +
      `${found.size}/${wanted.size} assets have an ETH pool`);
  }
  console.log("");

  let withPools = 0, hookless = 0;
  for (const t of doc.tokens || []) {
    const a = String(t.address).toLowerCase();
    if (a === ZERO) { t.ethPools = []; continue; }
    const keys = [...(found.get(a) || new Map()).values()];
    /* Hookless first: those are the pools the keeper can reason about. A hook
     * can charge or reject a swap arbitrarily and this money is not ours. */
    keys.sort((x, y) => (x.hooks === ZERO ? 0 : 1) - (y.hooks === ZERO ? 0 : 1));
    t.ethPools = keys;
    if (keys.length) withPools++;
    if (keys.some((k) => k.hooks === ZERO)) hookless++;
  }

  doc.note = "Verified on chain. `pools` is how many V4 pools use the asset; " +
    "`ethPools` are the ETH-paired PoolKeys the keeper can swap through.";
  doc.poolsAt = new Date().toISOString();
  fs.writeFileSync(OUT, JSON.stringify(doc, null, 2) + "\n");

  console.log(`\n${withPools}/${wanted.size} assets have at least one ETH pool`);
  console.log(`${hookless} of those have a hookless one`);
  console.log(`written to ${OUT}`);

  /* The ones without a pool matter: a creator can pick them in the launch
   * window and the keeper will have nothing to swap through, so they should be
   * either hidden from the picker or shown as ETH-paid. Name them. */
  const orphans = (doc.tokens || [])
    .filter((t) => String(t.address).toLowerCase() !== ZERO && !(t.ethPools || []).length)
    .map((t) => t.symbol);
  if (orphans.length) {
    console.log(`\n⚠️  no ETH pool found for ${orphans.length}: ${orphans.slice(0, 40).join(" ")}`);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
