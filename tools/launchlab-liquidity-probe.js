#!/usr/bin/env node
/* Will a quote actually pair? Config existence ≠ liquidity. Probe each candidate
 * with a real Jupiter route (USDC -> mint, ~$1k) and read priceImpactPct + whether
 * a route exists at all. Tier: GOOD <1%, OK 1-5%, THIN 5-15%, BAD >15%, DEAD no route. */
const all = require("./launchlab-quotes-resolved.json");
const by = {}; all.forEach(m => by[m.mint] = m);
const named = all.filter(m => m.symbol && !/pump$|bonk$/i.test(m.mint));
const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const NOTIONAL = 1000e6; // $1000 in USDC (6dp)
const sleep = ms => new Promise(r => setTimeout(r, ms));

// the sets we intend to ADD
const backpack = named.filter(m => /Backpack Securities/i.test(m.name));
const prestock = named.filter(m => /PreStocks/i.test(m.name));
const COINMINTS = [
  "9gP2kCy3wA1ctvYWQk75guqXuHfrEomqydHLtcTCqiLa","6UpQcMAb5xMzxc7ZfPaVMgx3KqsvKZdT5U718BzD5We2",
  "suifhC9gU1VbJAPYPTBkHJyyyStKGLLYPVDTmPoqbvA","3ZLekZYq2qkZiSpnSvabjit34tUkjSwD1JFuW9as9wBG",
  "ARBzQTYDCW2KnVEjs1Mc81LekB1ibVFZKbSVmorkoT9d","DoGEV7LASBkQbibMc5k5vKnTZoMg423GpJ5QtJEGfm7R",
  "53fpLgNq1dMpFEEq9sRDc3t6DRhzyJGXnTqD6Rcp9NjV","AavE1kKKnesPw4MuRJmJ9jZs9QzEE8CPxQ3ViczUDfc1",
  "uniHfuPhEQSrtpzXpJZDCSq53yaejKKpNhFUiKoHKHV","taoC6xyv2v8tDLcev4uaGUgV4vdQsWJrGft2kcBRrBY",
  "FyWirVeSzuM1mBxED7VtW5DHXapzPu3mjGfCC5wYhde5","A7bdiYdS5GjqGFtxf17ppRHtDKPkkRqbKtR27dxvQXaS",
];
// existing quotes, for calibration
const EXIST = ["7vfCXTUXx5WJV5JADk17DUJ4ksgau7utNKj4b963voxs","3NZ9JMVBmGAqocybic2c7LQCJScmgsAZ6vQqTDzcqmJh",
  "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263","JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN",
  "Xsc9qvGR1efVDFGLrVsmkzv3qi45LTBjeUKSPmx9qEh","XsoCS1TfEyfFhfvj8EtZ528L3CaKBDBRqRapnBbDF2W"];

const GROUPS = [
  ["EXISTING (calibration)", EXIST.map(m => by[m]).filter(Boolean)],
  ["COINS to add", COINMINTS.map(m => by[m]).filter(Boolean)],
  ["Backpack stocks to add", backpack],
  ["PreStocks to add", prestock],
];

async function probe(mint) {
  const u = "https://lite-api.jup.ag/swap/v1/quote?inputMint=" + USDC + "&outputMint=" + mint +
    "&amount=" + NOTIONAL + "&slippageBps=1000&restrictIntermediateTokens=true";
  try {
    const res = await fetch(u);
    if (res.status === 429) return { tier: "RATE", impact: null };
    if (!res.ok) return { tier: "DEAD", impact: null };
    const j = await res.json();
    if (!j || !j.outAmount || j.error) return { tier: "DEAD", impact: null };
    const imp = j.priceImpactPct != null ? Math.abs(parseFloat(j.priceImpactPct)) * 100 : null;
    let tier = "OK";
    if (imp == null) tier = "?";
    else if (imp < 1) tier = "GOOD"; else if (imp < 5) tier = "OK";
    else if (imp < 15) tier = "THIN"; else tier = "BAD";
    return { tier, impact: imp };
  } catch (e) { return { tier: "ERR", impact: null }; }
}

(async () => {
  const summary = {};
  for (const [gname, list] of GROUPS) {
    console.log("\n=== " + gname + " (" + list.length + ") — $1k USDC route, price impact ===");
    for (const m of list.sort((a,b)=>(a.symbol||"").localeCompare(b.symbol||""))) {
      let r = await probe(m.mint);
      if (r.tier === "RATE") { await sleep(1500); r = await probe(m.mint); }
      await sleep(250);
      summary[r.tier] = (summary[r.tier]||0)+1;
      console.log("  " + (m.symbol||"?").padEnd(12), r.tier.padEnd(5),
        (r.impact==null?"—":r.impact.toFixed(2)+"%").padStart(8), " ", (m.name||"").slice(0,32));
    }
  }
  console.log("\nTALLY:", JSON.stringify(summary));
})();
