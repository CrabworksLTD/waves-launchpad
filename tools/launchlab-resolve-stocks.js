#!/usr/bin/env node
/* From the enumerated configs, take the Xs-prefixed (Backed xStock) quote mints
 * — the real equities/commodities — and resolve symbol/name/decimals. Also
 * check a curated allowlist of liquid token majors. Writes brand-ready blocks. */
const fs = require("fs");
const rows = JSON.parse(fs.readFileSync("tools/launchlab-quotes.json", "utf8"));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// curated liquid token majors we'd actually offer (config existence checked below)
const TOKEN_ALLOW = {
  "So11111111111111111111111111111111111111112": "SOL",
  "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v": "USDC",
  "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB": "USDT",
  "4k3Dyjzvzp8eMZWUXbBCjEvwSkkk59S5iCNLY3QrkX6R": "RAY",
  "JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN": "JUP",
  "EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm": "WIF",
  "7GCihgDB8fe6KNjn2MYtkzZcRjQy3t9GHdC8uHYmW2hr": "POPCAT",
  "3NZ9JMVBmGAqocybic2c7LQCJScmgsAZ6vQqTDzcqmJh": "WBTC",
  "7vfCXTUXx5WJV5JADk17DUJ4ksgau7utNKj4b963voxs": "WETH",
  "jtojtomepa8beP8AuQc6eXt5FriJwfFMwQx2v2f9mCL": "JTO",
  "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263": "BONK",
  "mSoLzYCxHdYgdzU16g5QSh3i5K3z3KZK7ytfqcJm7So": "mSOL",
  "cbbtcf3aa214zXHbiAZQwf4122FBYbraNdFqgw4iMij": "cbBTC",
};

async function jup(mint) {
  for (const base of ["https://lite-api.jup.ag", "https://api.jup.ag"]) {
    try {
      const res = await fetch(base + "/tokens/v1/token/" + mint);
      if (!res.ok) continue;
      const t = await res.json();
      if (t && (t.symbol || t.name)) return t;
    } catch (e) {}
  }
  return null;
}

(async () => {
  const configMints = new Set(rows.map((r) => r.mint));
  const stocks = rows.filter((r) => r.mint.startsWith("Xs"));
  console.error("Xs-prefixed configs: " + stocks.length + "  |  resolving metadata…");
  const out = [];
  for (const r of stocks) {
    const t = await jup(r.mint);
    await sleep(150);
    out.push({ mint: r.mint, symbol: t ? t.symbol : "", name: t ? t.name : "", decimals: t ? t.decimals : null });
  }
  out.sort((a, b) => (a.symbol || "z").localeCompare(b.symbol || "z"));
  console.log("\n=== STOCK/COMMODITY xStock quotes with live LaunchLab configs (" + out.length + ") ===");
  for (const s of out) console.log("  " + (s.symbol || "?").padEnd(10), (s.decimals ?? "?") + "d", (s.name || "").slice(0, 30).padEnd(30), s.mint);

  console.log("\n=== curated TOKEN majors — config present? ===");
  const tokOut = [];
  for (const [mint, sym] of Object.entries(TOKEN_ALLOW)) {
    const has = configMints.has(mint) || mint === "So11111111111111111111111111111111111111112" || mint === "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
    const t = await jup(mint); await sleep(120);
    tokOut.push({ mint, symbol: sym, name: t ? t.name : "", decimals: t ? t.decimals : null, config: has });
    console.log("  " + sym.padEnd(10), (has ? "CONFIG" : "no cfg").padEnd(8), (t ? t.decimals : "?") + "d", mint);
  }
  fs.writeFileSync("tools/launchlab-stocks-resolved.json", JSON.stringify({ stocks: out, tokens: tokOut }, null, 2));
  console.error("\nwritten → tools/launchlab-stocks-resolved.json");
})().catch((e) => { console.error(e); process.exit(1); });
