#!/usr/bin/env node
/* Enumerate EVERY quote mint that has a live Raydium LaunchLab config.
 * A LaunchpadConfig is 371 bytes, disc 95089ccaa0fcb0d9. getProgramAccounts
 * with that filter returns all of them; decode each → mintB (the quote mint).
 * Then resolve symbol/decimals/name from Jupiter's token API and bucket into
 * stock / commodity / token so brand.js can offer the maximal set.
 *
 *   RPC=https://mainnet.helius-rpc.com/?api-key=... node tools/launchlab-enumerate-quotes.js
 */
const r = require("@raydium-io/raydium-sdk-v2");
const { Connection, PublicKey } = require("@solana/web3.js");
const fs = require("fs");

const CONFIG_SIZE = 371;
const DISC = "95089ccaa0fcb0d9";
const RPCS = [
  process.env.RPC,
  "https://api.mainnet-beta.solana.com",
  "https://solana-rpc.publicnode.com",
  "https://rpc.ankr.com/solana",
].filter(Boolean);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function enumerate() {
  for (const url of RPCS) {
    try {
      const conn = new Connection(url, "confirmed");
      const accts = await conn.getProgramAccounts(r.LAUNCHPAD_PROGRAM, {
        commitment: "confirmed",
        filters: [
          { dataSize: CONFIG_SIZE },
          { memcmp: { offset: 0, bytes: /* base58 of disc */ require("bs58").default
              ? require("bs58").default.encode(Buffer.from(DISC, "hex"))
              : require("bs58").encode(Buffer.from(DISC, "hex")) } },
        ],
      });
      console.error("  RPC ok: " + url.split("?")[0] + "  → " + accts.length + " config accounts");
      return accts;
    } catch (e) {
      console.error("  RPC failed (" + url.split("?")[0] + "): " + e.message);
    }
  }
  throw new Error("all RPCs rejected getProgramAccounts — set RPC=<paid endpoint>");
}

async function jupMeta(mint) {
  for (const base of ["https://lite-api.jup.ag", "https://api.jup.ag"]) {
    try {
      const t = await (await fetch(base + "/tokens/v1/token/" + mint)).json();
      if (t && (t.symbol || t.name)) return { symbol: t.symbol, name: t.name, decimals: t.decimals };
    } catch (e) {}
  }
  return null;
}

(async () => {
  const accts = await enumerate();
  const mints = [];
  for (const a of accts) {
    try {
      const dec = r.LaunchpadConfig.decode(a.account.data);
      mints.push(dec.mintB.toBase58());
    } catch (e) {}
  }
  const uniq = [...new Set(mints)];
  console.error("  unique quote mints: " + uniq.length + "\n");

  const rows = [];
  for (const mint of uniq) {
    const m = await jupMeta(mint);
    await sleep(120);
    const sym = m ? m.symbol : "";
    const isStock = /x$/i.test(sym) && mint.startsWith("Xs"); // Backed xStocks
    const cat = mint.startsWith("Xs")
      ? (/gold|gld/i.test((m && m.name) || sym) ? "commodity" : "stock")
      : "token";
    rows.push({ mint, symbol: sym, name: m ? m.name : "", decimals: m ? m.decimals : null, cat });
  }
  rows.sort((a, b) => (a.cat + a.symbol).localeCompare(b.cat + b.symbol));
  fs.writeFileSync("tools/launchlab-quotes.json", JSON.stringify(rows, null, 2));
  const by = (c) => rows.filter((r) => r.cat === c);
  console.log("\n=== " + rows.length + " quotable assets (written to tools/launchlab-quotes.json) ===");
  for (const c of ["token", "stock", "commodity"]) {
    console.log("\n" + c.toUpperCase() + " (" + by(c).length + "):");
    for (const r of by(c)) console.log("  " + (r.symbol || "?").padEnd(10), (r.decimals ?? "?") + "d", (r.name || "").slice(0, 28).padEnd(28), r.mint);
  }
})().catch((e) => { console.error(e); process.exit(1); });
