#!/usr/bin/env node
/* launchlab-keeper-preflight.js — READ-ONLY. Moves nothing.
 *
 * Validates every job the LaunchLab keeper (api/launchlab-keeper.js) would try to
 * service, so a misconfiguration is caught BEFORE the fund-moving run instead of
 * as a failed payout. For each serviceable token record it checks the invariants
 * the keeper depends on and prints a per-job verdict.
 *
 * Run it against the same KV the site uses (needs KV_REST_API_URL / _TOKEN in the
 * env, e.g. `vercel env pull` then `node -r dotenv/config`), or point RPC at
 * mainnet. Nothing here signs or sends.
 *
 *   KV_REST_API_URL=... KV_REST_API_TOKEN=... node tools/launchlab-keeper-preflight.js
 *   MINT=<mint> ...                      # just one token
 */
const os = require("os");
const fs = require("fs");
const w3 = require("@solana/web3.js");
const r = require("@raydium-io/raydium-sdk-v2");
const splToken = require("@solana/spl-token");

const RPC = process.env.SOLANA_RPC || process.env.RPC || "https://api.mainnet-beta.solana.com";
const ONLY = process.env.MINT || null;
const TOKEN2022 = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";
const WSOL = "So11111111111111111111111111111111111111112";
const STAKE_PROGRAM = "jt5JegTBVPZP8V6a48fnKYPFKTbpcTfkz91Pemur82H";
// the keeper identity the tier configs claim to + the mints' transferFeeExtensionAuth
const KEEPER = process.env.KEEPER_PUBKEY || "EFFY1LjZbzzEYuUr24udxWponKqtta8MaxZxs6HGPswH";

function loadBrand() {
  const path = require("path").join(__dirname, "..", "app", "public", "brand.js");
  const win = {};
  new Function("window", fs.readFileSync(path, "utf8"))(win);
  return win.BRAND || {};
}

async function kvTokens() {
  if (!process.env.KV_REST_API_URL || !process.env.KV_REST_API_TOKEN) return null;
  const { Redis } = require("@upstash/redis");
  const db = new Redis({ url: process.env.KV_REST_API_URL, token: process.env.KV_REST_API_TOKEN });
  const raw = await db.lrange("tokens", 0, 199);
  return (raw || []).map((x) => (typeof x === "string" ? JSON.parse(x) : x)).filter(Boolean);
}

const C = { ok: "\x1b[32m✓\x1b[0m", warn: "\x1b[33m⚠\x1b[0m", bad: "\x1b[31m✗\x1b[0m", dim: "\x1b[2m", off: "\x1b[0m" };

(async () => {
  const conn = new w3.Connection(RPC, "confirmed");
  const brand = loadBrand();
  const tiers = (((brand.launchlabConfigs || {})["mainnet-beta"]) || {}).tiers || {};

  let tokens = await kvTokens();
  if (!tokens) {
    console.log(C.warn + " no KV env — set KV_REST_API_URL / KV_REST_API_TOKEN to read live records. Nothing to check.");
    return;
  }
  // mirror the keeper's job filter (H-6: pure burn is NOT serviced). A burn launch
  // is surfaced separately below as an un-serviceable warning, not a job.
  let jobs = tokens.filter((t) =>
    t.backend === "launchlab" &&
    ((t.tier && t.tier !== "standard") || ["dividend", "split"].indexOf(t.rewardMode) >= 0));
  const burnJobs = tokens.filter((t) => t.backend === "launchlab" && t.rewardMode === "burn");
  if (ONLY) jobs = jobs.filter((t) => t.mint === ONLY);

  console.log("\nLaunchLab keeper preflight — " + jobs.length + " serviceable job(s) on " + RPC.replace(/^https?:\/\//, "") + "\n");

  for (const job of jobs) {
    const problems = [], notes = [];
    console.log("── " + (job.symbol || "?") + "  " + job.mint);

    if (!job.pool) problems.push("no pool on the record");

    // FEE LADDER checks
    if (job.tier && job.tier !== "standard") {
      const tier = tiers[job.tier];
      if (!tier) problems.push("tier '" + job.tier + "' has no config in brand.js");
      else {
        const plat = await conn.getAccountInfo(new w3.PublicKey(tier.platformId)).catch(() => null);
        if (!plat) problems.push("tier platformId " + tier.platformId.slice(0, 8) + "… does not exist on-chain");
        else notes.push("tier " + job.tier + " (" + tier.pct + "%) → forward " +
          (((tier.feeRate - tier.wavesKeepBps) / tier.feeRate) * 100).toFixed(1) + "% of platform fee to " +
          (job.feeWallet || job.creator || "??").slice(0, 8) + "…");
        if (!(job.feeWallet || job.creator)) problems.push("no feeWallet/creator to forward the tier share to");
      }
    }

    // HOLDER-REWARD checks
    if (["dividend", "burn", "split"].indexOf(job.rewardMode) >= 0) {
      const mintInfo = await conn.getAccountInfo(new w3.PublicKey(job.mint)).catch(() => null);
      const isT22 = mintInfo && mintInfo.owner && mintInfo.owner.toBase58() === TOKEN2022;
      if (!isT22) problems.push("rewardMode '" + job.rewardMode + "' but mint is not Token-2022 (no transfer-fee to harvest)");
      else {
        // the keeper must be the transfer-fee withdraw authority or harvest reverts
        try {
          const mint = splToken.unpackMint(new w3.PublicKey(job.mint), mintInfo, new w3.PublicKey(TOKEN2022));
          const tfc = splToken.getTransferFeeConfig(mint);
          if (!tfc) problems.push("Token-2022 mint has no TransferFeeConfig — nothing accrues");
          else {
            const auth = tfc.withdrawWithheldAuthority ? tfc.withdrawWithheldAuthority.toBase58() : null;
            if (auth !== KEEPER) problems.push("withdrawWithheldAuthority is " + (auth ? auth.slice(0, 8) + "…" : "none") + ", not the keeper " + KEEPER.slice(0, 8) + "… — harvest will fail");
            else notes.push("harvest auth = keeper ✓ (fee " + (Number(tfc.newerTransferFee.transferFeeBasisPoints) / 100) + "%)");
          }
        } catch (e) { notes.push("could not decode transfer-fee config: " + String(e.message).slice(0, 60)); }
      }

      const rewardMint = job.rewardMint || WSOL;
      const pairedCollection = job.pairedCollection || (job.feeShare === "vault" ? job.collection : null);
      if (pairedCollection) {
        // PAIR — the staking pool + vault must already exist (created at launch)
        const [pool] = w3.PublicKey.findProgramAddressSync(
          [Buffer.from("pool"), new w3.PublicKey(job.mint).toBuffer(), new w3.PublicKey(pairedCollection).toBuffer()],
          new w3.PublicKey(STAKE_PROGRAM));
        const poolAcc = await conn.getAccountInfo(pool).catch(() => null);
        if (!poolAcc) problems.push("pair: staking pool " + pool.toBase58().slice(0, 8) + "… not initialised (init_pool never ran at launch)");
        else {
          const rProg = await mintProg(conn, rewardMint);
          const vault = splToken.getAssociatedTokenAddressSync(new w3.PublicKey(rewardMint), pool, true, new w3.PublicKey(rProg));
          const vAcc = await conn.getAccountInfo(vault).catch(() => null);
          if (!vAcc) problems.push("pair: reward vault (pool ATA for " + rewardMint.slice(0, 6) + "…) does not exist");
          else notes.push("pair → deposit+sync into pool " + pool.toBase58().slice(0, 8) + "… vault ✓");
        }
      } else if (job.rewardMode !== "burn") {
        notes.push("dividend → swap to " + rewardMint.slice(0, 6) + "… + pay holders pro-rata");
      } else {
        notes.push("burn → destroy the harvested token");
      }
    }

    for (const n of notes) console.log("   " + C.ok + " " + C.dim + n + C.off);
    for (const p of problems) console.log("   " + C.bad + " " + p);
    if (!problems.length) console.log("   " + C.ok + " ready");
    console.log("");
  }

  if (burnJobs.length) {
    console.log(C.warn + " " + burnJobs.length + " burn launch(es) are NOT serviced (H-6): a pure-burn LaunchLab token is standard SPL");
    console.log("   with no transfer-fee to harvest. Buyback-and-burn needs the quote→burn pipeline, which is not built.\n");
  }

  // keeper gas
  const bal = await conn.getBalance(new w3.PublicKey(KEEPER)).catch(() => 0);
  console.log("keeper " + KEEPER.slice(0, 8) + "…  gas balance " + (bal / 1e9).toFixed(4) + " SOL" +
    (bal < 0.05e9 ? "  " + C.warn + " low — payouts pay their own gas + ATA rent" : ""));
  console.log("\n" + C.dim + "read-only: this tool signed and sent nothing." + C.off);
})().catch((e) => { console.error("FATAL:", e.message); process.exit(1); });

async function mintProg(conn, mintStr) {
  const acc = await conn.getAccountInfo(new w3.PublicKey(mintStr)).catch(() => null);
  return acc && acc.owner && acc.owner.toBase58() === TOKEN2022 ? TOKEN2022 : "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
}
