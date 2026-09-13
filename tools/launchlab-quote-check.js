#!/usr/bin/env node
/* Which quote mints actually have an on-chain LaunchLab config?
 * configFor() in launchlab.js derives the config PDA at (mint, curveType 0,
 * index 0) but NEVER checks it exists. A quote with no config fails at launch.
 * This resolves that empirically: derive the PDA for each candidate, then
 * getMultipleAccounts to see which are real. */
const r = require("@raydium-io/raydium-sdk-v2");
const { Connection, PublicKey } = require("@solana/web3.js");

const RPC = process.env.RPC || "https://api.mainnet-beta.solana.com";

// existing registered quotes (sanity-check they're real) + wrapped candidates.
const CANDIDATES = {
  "SOL":    "So11111111111111111111111111111111111111112",
  "USDC":   "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
  // existing SPL quotes in brand.js
  "USDT":   "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB",
  "RAY":    "4k3Dyjzvzp8eMZWUXbBCjEvwSkkk59S5iCNLY3QrkX6R",
  "JUP":    "JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN",
  "WIF":    "EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm",
  "POPCAT": "7GCihgDB8fe6KNjn2MYtkzZcRjQy3t9GHdC8uHYmW2hr",
  "WBTC(brand)": "3NZ9JMVBmGAqocybic2c7LQCJScmgsAZ6vQqTDzcqmJh",
  "JTO":    "jtojtomepa8beP8AuQc6eXt5FriJwfFMwQx2v2f9mCL",
  // wrapped candidates the user asked about
  "cbBTC":  "cbbtcf3aa214zXHbiAZQwf4122FBYbraNdFqgw4iMij",
  "WBTC(wormhole)": "3NZ9JMVBmGAqocybic2c7LQCJScmgsAdcbyR3ETF6H2R",
  "WETH(wormhole)": "7vfCXTUXx5WJV5JADk17DUJ4ksgau7utNKj4b963voxs",
  "bSOL":   "bSo13r4TkiE4KumL71LsHTPpL2euBYLFx6h9HP3piy1",
  "JitoSOL":"J1toso1uCk3RLmjorhTtrVwY9HJ7X8V9yYac6Y7kGCPn",
  "mSOL":   "mSoLzYCxHdYgdzU16g5QSh3i5K3z3KZK7ytfqcJm7So",
  // a couple of existing xStocks to confirm the stock quotes work at all
  "SPYx":   "XsoCS1TfEyfFhfvj8EtZ528L3CaKBDBRqRapnBbDF2W",
  "NVDAx":  "Xsc9qvGR1efVDFGLrVsmkzv3qi45LTBjeUKSPmx9qEh",
};

(async () => {
  const conn = new Connection(RPC, "confirmed");
  const names = Object.keys(CANDIDATES);
  const pdas = names.map((n) => {
    try {
      return r.getPdaLaunchpadConfigId(r.LAUNCHPAD_PROGRAM, new PublicKey(CANDIDATES[n]), 0, 0).publicKey;
    } catch (e) { return null; }
  });
  const infos = await conn.getMultipleAccountsInfo(pdas.filter(Boolean));
  let j = 0;
  console.log("quote".padEnd(16), "config exists".padEnd(14), "owner");
  console.log("-".repeat(70));
  for (let i = 0; i < names.length; i++) {
    if (!pdas[i]) { console.log(names[i].padEnd(16), "BAD MINT"); continue; }
    const info = infos[j++];
    const ok = info ? "YES" : "no";
    const owner = info ? info.owner.toBase58() : "";
    console.log(names[i].padEnd(16), ok.padEnd(14), owner);
  }
})().catch((e) => { console.error(e); process.exit(1); });
