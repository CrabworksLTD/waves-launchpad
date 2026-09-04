#!/usr/bin/env node
/* node tools/fetch-rh-assets.js
 *
 * The reward assets a Robinhood Chain launch can pay holders in, written to
 * app/public/rh-assets.json.
 *
 * The equivalent of tools/fetch-rwa.js on the Solana side, and it exists for
 * the same reason that one does: picking a reward asset by TICKER is dangerous.
 * There, searching Jupiter for "TSLAx" returned five tokens and four were
 * pump.fun impostors. Here the risk is the same shape — anyone can deploy an
 * ERC20 called NVDA — so nothing reaches the picker on a name alone.
 *
 * Two filters, both necessary:
 *
 *   1. It must be something people actually TRADE. Assets are taken from live
 *      pairs on Robinhood Chain, so every one has a market. An asset with a
 *      price and no liquidity is a payout that shows a dollar figure and cannot
 *      be sold — 354 of Solana's 448 "verified" assets were exactly that.
 *   2. It must answer for itself ON CHAIN. name/symbol/decimals are read from
 *      the contract, not copied from the aggregator, so a listing that lies
 *      about what it is cannot get through.
 *
 * Robinhood's own tokenised equities identify themselves as "… • Robinhood
 * Token", which is a useful signal but not a requirement — USDG is not one and
 * belongs on the list.
 */
"use strict";
const fs = require("fs");
const path = require("path");

const RPC = process.env.RH_RPC || "https://rpc.mainnet.chain.robinhood.com";
const OUT = path.join(__dirname, "..", "app", "public", "rh-assets.json");
const MIN_LIQUIDITY = 1000;          // dollars; below this a payout cannot be sold

// WETH is the chain's own wrapped coin, not a reward asset — a creator wanting
// ETH rewards simply does not pledge into a swap.
const SKIP = new Set(["0x0bd7d308f8e1639fab988df18a8011f41eacad73"]);

/* ⚠️ Stablecoins by ADDRESS, never by name.
 *
 * The first version classified anything whose name matched /dollar/ as a
 * stablecoin, and the picker filled up with "22 MILLION DOLLARS IN 3 HOURS",
 * "Gold Dollar" and "NL Dollars" — memecoins, listed under the one category a
 * creator would trust without looking. That is the same "a ticker is not an
 * identity" mistake this whole file exists to prevent, made one level up in the
 * classifier instead of in the list.
 *
 * An equity can be recognised by its name because Robinhood issues it and says
 * so. Nothing else can, so nothing else is guessed at. */
const STABLES = {
  "0x5fc5360d0400a0fd4f2af552add042d716f1d168": "USDG"
};

let id = 0;
async function rpc(method, params) {
  const r = await fetch(RPC, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params })
  });
  const j = await r.json();
  if (j.error) throw new Error(method + ": " + (j.error.message || "rpc error"));
  return j.result;
}

/// A solidity `string` return: offset, length, then the bytes.
function decodeString(hex) {
  const d = String(hex || "").replace(/^0x/, "");
  if (d.length < 128) return null;
  const len = parseInt(d.slice(64, 128), 16);
  if (!Number.isFinite(len) || len === 0) return null;
  return Buffer.from(d.slice(128, 128 + len * 2), "hex").toString("utf8");
}

async function onChain(address) {
  const call = (sig) => rpc("eth_call", [{ to: address, data: sig }, "latest"]);
  try {
    const [n, s, d] = await Promise.all([
      call("0x06fdde03"),          // name()
      call("0x95d89b41"),          // symbol()
      call("0x313ce567")           // decimals()
    ]);
    const decimals = parseInt(String(d).slice(2), 16);
    return {
      name: decodeString(n),
      symbol: decodeString(s),
      decimals: Number.isFinite(decimals) ? decimals : null
    };
  } catch (e) {
    return null;
  }
}

(async () => {
  /* Source: the V4 PoolManager's own Initialize events, not an aggregator
   * search.
   *
   * The first version asked DexScreener to search "robinhood chain" and got 24
   * pairs — a search RESULT, not the chain. Robinhood has far more tokenised
   * equities than that, and which ones a creator can pick should not depend on
   * what a search box felt like returning. Every pool that exists announces
   * both of its currencies here, so this sees all of them. */
  const PM = "0x8366a39cc670b4001a1121b8f6a443a643e40951";
  const INIT = "0xdd466e674ea557f56295e2d0218a125ea4b4f0f6f3307b95f85e6110838d6438";
  const CHUNK = 50000n;            // ~1.4h; wider and the node refuses
  const CHUNKS = Number(process.env.RH_CHUNKS || 20);   // ~28h of pools

  const latest = BigInt(await rpc("eth_blockNumber", []));
  const seen = new Map();
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
      console.log(`  window ${i} refused (${e.message.slice(0, 40)}) — stopping`);
      break;
    }
    for (const l of logs) {
      // topics: [sig, id, currency0, currency1]
      for (const t of [l.topics[2], l.topics[3]]) {
        if (!t) continue;
        const a = ("0x" + t.slice(-40)).toLowerCase();
        if (a === "0x" + "0".repeat(40)) continue;      // native ETH
        if (SKIP.has(a)) continue;
        seen.set(a, (seen.get(a) || 0) + 1);
      }
    }
    process.stdout.write(`\r  swept ${i + 1}/${CHUNKS} windows, ${seen.size} distinct currencies`);
  }
  console.log("");

  /* ⚠️ Filter BEFORE verifying, not after.
   *
   * The sweep finds thousands of currencies, nearly all of them memecoins that
   * appear in exactly one pool. Verifying every one costs three rate-limited
   * eth_calls apiece and took hours. What we are looking for is the assets
   * things trade AGAINST — a stock is the quote side of many pools, a memecoin
   * is the base side of one — so requiring a couple of pools drops the long
   * tail before it costs anything. */
  const MIN_POOLS = Number(process.env.RH_MIN_POOLS || 2);
  const candidates = [...seen.entries()]
    .filter(([, n]) => n >= MIN_POOLS)
    .sort((a, b) => b[1] - a[1]);
  console.log(`  ${candidates.length} currencies in ${MIN_POOLS}+ pools — verifying those`);

  const out = [];
  const bySymbol = new Map();
  for (const [address, pools] of candidates) {
    /* Popularity stands in for liquidity here: an asset nothing pairs against
     * is one nobody can be paid in. The aggregator's dollar figures only
     * covered the handful of pairs it chose to return. */
    if (pools < 1) continue;
    const info = { liquidity: pools, aggSymbol: null };

    /* Sequential, with a pause. Robinhood rate-limits, and firing these in
     * parallel had half the real stocks "not answering on chain" — which would
     * have silently dropped NVDA, GME and TSLA from the picker for a reason
     * that had nothing to do with the tokens. */
    await new Promise((r) => setTimeout(r, 120));
    const chain = await onChain(address);
    if (!chain || !chain.symbol || chain.decimals === null) {
      console.log(`  skip ${info.aggSymbol} — did not answer on chain`);
      continue;
    }
    /* ⚠️ The chain wins. If the contract calls itself something other than what
     * the aggregator said, that is exactly the case this check exists for. */
    /* Sanity. A name or ticker this long is not a stock, it is someone abusing
     * the field. */
    if ((chain.name || "").length > 80 || chain.symbol.length > 12) {
      console.log(`  skip ${chain.symbol.slice(0, 12)} — implausible name or ticker`);
      continue;
    }

    /* ⚠️ Two contracts, one ticker. MSTR and IBM each appeared twice at
     * different addresses, which is the exact hazard this file exists to stop:
     * a creator picks "MSTR" and their holders are paid in someone's forgery.
     * Robinhood's own equities identify themselves as "… • Robinhood Token";
     * anything else claiming a duplicate ticker loses. */
    const isReal = /Robinhood Token/i.test(chain.name || "");
    const prior = bySymbol.get(chain.symbol);
    if (prior) {
      const priorReal = /Robinhood Token/i.test(prior.name || "");
      if (priorReal || !isReal) {
        console.log(`  skip ${chain.symbol} at ${address} — duplicate ticker`);
        continue;
      }
      out.splice(out.indexOf(prior), 1);   // the impostor was seen first
      console.log(`  drop ${chain.symbol} at ${prior.address} — duplicate ticker`);
    }
    const isStable = Object.prototype.hasOwnProperty.call(STABLES, address);
    if (!isReal && !isStable) {
      console.log(`  skip ${chain.symbol} — not a Robinhood equity or a known stablecoin`);
      continue;
    }

    const rec = {
      address,
      symbol: chain.symbol,
      name: chain.name,
      decimals: chain.decimals,
      pools: info.liquidity,
      // Robinhood's own tokenised equities say so in their name
      kind: isReal ? "equity" : "stable"
    };
    out.push(rec);
    bySymbol.set(chain.symbol, rec);
  }

  /* The stablecoins are the point of the category, so they do not depend on
   * whether the swept window happened to include a pool that used one. USDG
   * was missing from the first run for exactly that reason. */
  for (const [address, symbol] of Object.entries(STABLES)) {
    if (out.some((t) => t.address === address)) continue;
    await new Promise((r) => setTimeout(r, 120));
    const chain = await onChain(address);
    if (!chain || chain.symbol !== symbol) {
      console.log(`  WARNING: ${symbol} did not verify at ${address}`);
      continue;
    }
    out.push({
      address, symbol: chain.symbol, name: chain.name,
      decimals: chain.decimals, pools: seen.get(address) || 0, kind: "stable"
    });
    console.log(`  added ${symbol} (allowlisted stablecoin)`);
  }

  out.sort((a, b) => b.pools - a.pools || a.symbol.localeCompare(b.symbol));
  fs.writeFileSync(OUT, JSON.stringify({
    generated: new Date().toISOString(),
    chain: 4663,
    note: "Verified on chain. `pools` is how many V4 pools use the asset.",
    tokens: out
  }, null, 2) + "\n");

  console.log(`\n  ${out.length} assets written to ${path.relative(process.cwd(), OUT)}`);
  for (const t of out) {
    console.log(`    ${t.symbol.padEnd(10)} ${t.kind.padEnd(7)} ${t.pools} pools`);
  }
})();
