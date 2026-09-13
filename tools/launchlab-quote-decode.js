#!/usr/bin/env node
/* Decode the LaunchpadConfig for a mint and confirm its mintB == the mint we
 * queried. Proves the "config exists" result is real, not a PDA coincidence. */
const r = require("@raydium-io/raydium-sdk-v2");
const { Connection, PublicKey } = require("@solana/web3.js");
const RPC = process.env.RPC || "https://api.mainnet-beta.solana.com";

const MINTS = {
  "USDC":   "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
  "WBTC(brand)": "3NZ9JMVBmGAqocybic2c7LQCJScmgsAZ6vQqTDzcqmJh",
  "cbBTC":  "cbbtcf3aa214zXHbiAZQwf4122FBYbraNdFqgw4iMij",
  "WETH":   "7vfCXTUXx5WJV5JADk17DUJ4ksgau7utNKj4b963voxs",
  "WIF":    "EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm",
  "SPYx":   "XsoCS1TfEyfFhfvj8EtZ528L3CaKBDBRqRapnBbDF2W",
};

(async () => {
  const conn = new Connection(RPC, "confirmed");
  for (const [name, mint] of Object.entries(MINTS)) {
    const pda = r.getPdaLaunchpadConfigId(r.LAUNCHPAD_PROGRAM, new PublicKey(mint), 0, 0).publicKey;
    const info = await conn.getAccountInfo(pda);
    if (!info) { console.log(name.padEnd(14), "NO CONFIG"); continue; }
    let dec;
    try { dec = r.LaunchpadConfig.decode(info.data); }
    catch (e) { console.log(name.padEnd(14), "decode failed:", e.message); continue; }
    const mintB = dec.mintB.toBase58();
    const match = mintB === mint ? "MATCH" : "MISMATCH";
    console.log(name.padEnd(14), match.padEnd(9), "mintB=" + mintB,
      "tradeFee=" + (dec.tradeFeeRate ? dec.tradeFeeRate.toString() : "?"));
  }
})().catch((e) => { console.error(e); process.exit(1); });
