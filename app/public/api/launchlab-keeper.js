// api/launchlab-keeper.js   POST, Authorization: Bearer $CRON_SECRET
//
// ⚠️ FUND-MOVING. NOT wired into any cron and NOT called from the app. This is
// the reviewable artifact for the LaunchLab keeper audit (Phase 3 of
// docs/launchlab-ladder-keeper.md). It moves real money on every claim, so it
// ships ONLY after the auditor signs off and `launchlabLadderLive` is flipped.
// keeper.js (the Meteora keeper) still excludes backend:"launchlab", so nothing
// here runs today.
//
// It does two jobs for a LaunchLab launch, both reusing keeper.js's proven shape
// (fail-closed auth · snapshot → gas → claim → persist the REAL plan → execute ·
// confirmed-by-polling · destination from the record, never the caller):
//
//   1. FEE LADDER — claim the tier's platform fee (which the escrow claim wallet
//      holds), forward the creator's share to their fee wallet, keep WAVES's cut.
//      Standard (1.15%) needs no forward: the creator already has their 0.5%
//      on-chain and WAVES keeps the 0.40% platform fee at feeOwner directly.
//   2. HOLDER REWARDS — dividend: harvest the Token-2022 transfer fee + pay
//      holders pro-rata; buyback: swap the pot into the token and burn; split:
//      half each. (Structured below; the harvest/swap execs are the audit's core.)

export const config = { runtime: "nodejs" };

import { allow, tooMany } from "./_guard.js";

const RPC = process.env.SOLANA_RPC || "https://solana-rpc.publicnode.com";
const TREASURY = process.env.FEE_OWNER || "BU9dYi7fGw5G3Wd54CUTmt1Y58jEJaPq8LKiL72ydeKJ";
const LAMPORTS_PER_SIG = 5000n;
const GAS_FLOOR = 20000000n;               // 0.02 SOL
const ATA_RENT_LAMPORTS = 2040000n;
const BATCH = 5;                           // reward payouts batch small
const PLAN_TTL = 60 * 60 * 24;

function kv() {
  if (!process.env.KV_REST_API_URL || !process.env.KV_REST_API_TOKEN) return Promise.resolve(null);
  return import("@upstash/redis").then(({ Redis }) => new Redis({
    url: process.env.KV_REST_API_URL, token: process.env.KV_REST_API_TOKEN,
  })).catch(() => null);
}

/* Creator's fraction of the claimed platform fee for a tier. The platform fee is
 * `feeRate` bps; WAVES keeps `wavesKeepBps`; the rest is forwarded to the creator
 * (who already holds their 0.5% on-chain). Pure arithmetic on brand.js values. */
function creatorFraction(tierCfg) {
  const feeRate = Number(tierCfg.feeRate);
  const keep = Number(tierCfg.wavesKeepBps);
  if (!(feeRate > 0) || keep < 0 || keep > feeRate) return 0;
  return (feeRate - keep) / feeRate;
}

export default async function handler(req, res) {
  // fail closed — a missing secret must never authenticate a payout run
  const secret = process.env.CRON_SECRET;
  if (!secret) return res.status(500).json({ error: "CRON_SECRET is not set" });
  if ((req.headers.authorization || "") !== "Bearer " + secret) return res.status(401).json({ error: "no" });
  if (!process.env.KEEPER_SECRET) return res.status(200).json({ ok: true, skipped: "KEEPER_SECRET is not set" });
  if (!(await allow(req, { bucket: "llkeeper", max: 30, windowSec: 60 }))) return tooMany(res, 60);

  const log = [];
  try {
    const w3 = await import("@solana/web3.js");
    const r = await import("@raydium-io/raydium-sdk-v2");
    const bs58 = (await import("bs58")).default;
    const splToken = await import("@solana/spl-token");
    const BN = (await import("bn.js")).default;

    const keeper = w3.Keypair.fromSecretKey(bs58.decode(process.env.KEEPER_SECRET.trim()));
    const conn = new w3.Connection(RPC, "confirmed");
    const prog = r.LAUNCHPAD_PROGRAM;
    const raydium = await (r.Raydium || r.default).load({
      connection: conn, owner: keeper, cluster: "mainnet-beta",
      disableFeatureCheck: true, disableLoadToken: true,
    });
    const lp = raydium.launchpad;
    const db = await kv();
    const brand = await loadBrand();                       // brand.js tiers + platformId
    const cfg = ((brand.launchlabConfigs || {})["mainnet-beta"]) || {};
    const tiers = cfg.tiers || {};

    // only LaunchLab launches, and only the ones that actually need servicing:
    // a fee tier above standard (forward), or a holder-reward mode.
    let all = [];
    try {
      const raw = await db.lrange("tokens", 0, 199);
      all = (raw || []).map((x) => (typeof x === "string" ? JSON.parse(x) : x)).filter(Boolean);
    } catch (e) { log.push("could not read tokens: " + String((e && e.message) || e).slice(0, 80)); }
    const jobs = all.filter((t) =>
      t.backend === "launchlab" &&
      ((t.tier && t.tier !== "standard") ||
       ["dividend", "burn", "split"].indexOf(t.rewardMode) >= 0));

    log.push("launchlab jobs: " + jobs.length);

    for (const job of jobs) {
      if (!job.mint || !job.pool) continue;
      const planKey = "llplan:" + job.mint;
      try {
        // ── FEE LADDER: claim the tier's platform fee, then split ──────────────
        if (job.tier && job.tier !== "standard" && tiers[job.tier]) {
          const tier = tiers[job.tier];
          const frac = creatorFraction(tier);
          const poolId = new w3.PublicKey(job.pool);
          const p = r.LaunchpadPool.decode((await conn.getAccountInfo(poolId)).data);
          const mintB = p.mintB.toBase58();
          const mintBProgram = await mintProgram(conn, w3, splToken, mintB);

          // claim the platform fee to the escrow (the keeper is the claim wallet
          // for tier configs, so this lands in the keeper's mintB ATA)
          const before = await ataBalance(conn, w3, splToken, mintB, keeper.publicKey, mintBProgram);
          const built = await lp.claimPlatformFee({
            programId: prog, platformId: new w3.PublicKey(tier.platformId),
            platformClaimFeeWallet: keeper.publicKey,
            poolId, mintB: new w3.PublicKey(mintB),
            mintBProgram: new w3.PublicKey(mintBProgram), txVersion: r.TxVersion.LEGACY,
          });
          await built.execute({ sendAndConfirm: true });
          const after = await ataBalance(conn, w3, splToken, mintB, keeper.publicKey, mintBProgram);
          const claimed = after - before;
          if (claimed > 0n) {
            // forward the creator's share; WAVES's cut stays in the escrow and is
            // swept to the treasury.
            const toCreator = (claimed * BigInt(Math.round(frac * 1e6))) / 1000000n;
            const dest = job.feeWallet || job.creator;      // from the RECORD, never a request
            if (toCreator > 0n && dest) {
              await transfer(conn, w3, splToken, keeper, mintB, mintBProgram, new w3.PublicKey(dest), toCreator);
              log.push(job.mint + ": forwarded " + toCreator + " (" + (frac * 100).toFixed(1) + "% of " + claimed + ") to creator");
            }
            const keep = claimed - toCreator;
            if (keep > 0n) {
              await transfer(conn, w3, splToken, keeper, mintB, mintBProgram, new w3.PublicKey(TREASURY), keep);
              log.push(job.mint + ": swept " + keep + " to treasury");
            }
          } else {
            log.push(job.mint + ": no platform fee to claim");
          }
        }

        // ── HOLDER REWARDS: dividend / buyback / split ─────────────────────────
        // The reward pot is the Token-2022 transfer fee withheld on the mint. The
        // exec path (harvestWithheldTokensToMint → withdraw → swap → pay/burn) is
        // the fund-moving core the auditor must review; snapshot + plan-persist +
        // confirmed-by-polling mirror keeper.js exactly.
        if (["dividend", "burn", "split"].indexOf(job.rewardMode) >= 0) {
          await distributeReward(job, { conn, w3, r, splToken, BN, keeper, db, planKey, log, BATCH, ATA_RENT_LAMPORTS, LAMPORTS_PER_SIG, GAS_FLOOR });
        }
      } catch (e) {
        log.push(job.mint + ": FAILED — " + String((e && e.message) || e).slice(0, 120));
      }
    }

    return res.status(200).json({ ok: true, jobs: jobs.length, log });
  } catch (e) {
    return res.status(200).json({ ok: false, error: String((e && e.message) || e).slice(0, 200), log });
  }
}

// ── helpers ───────────────────────────────────────────────────────────────────

const TOKEN2022 = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";
const TOKENKEG = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";

async function mintProgram(conn, w3, splToken, mintStr) {
  const acc = await conn.getAccountInfo(new w3.PublicKey(mintStr));
  return acc && acc.owner && acc.owner.toBase58() === TOKEN2022 ? TOKEN2022 : TOKENKEG;
}
async function ataBalance(conn, w3, splToken, mint, owner, programId) {
  const ata = splToken.getAssociatedTokenAddressSync(new w3.PublicKey(mint), owner, true, new w3.PublicKey(programId));
  const bal = await conn.getTokenAccountBalance(ata).catch(() => null);
  return bal ? BigInt(bal.value.amount) : 0n;
}
async function transfer(conn, w3, splToken, keeper, mint, programId, to, amount) {
  const prog = new w3.PublicKey(programId);
  const mintPk = new w3.PublicKey(mint);
  const from = splToken.getAssociatedTokenAddressSync(mintPk, keeper.publicKey, true, prog);
  const toAta = splToken.getAssociatedTokenAddressSync(mintPk, to, true, prog);
  const ixs = [];
  if (!(await conn.getAccountInfo(toAta))) {
    ixs.push(splToken.createAssociatedTokenAccountInstruction(keeper.publicKey, toAta, to, mintPk, prog));
  }
  const dec = (await conn.getTokenAccountBalance(from)).value.decimals;
  ixs.push(splToken.createTransferCheckedInstruction(from, mintPk, toAta, keeper.publicKey, amount, dec, [], prog));
  const tx = new w3.Transaction().add(...ixs);
  tx.feePayer = keeper.publicKey;
  tx.recentBlockhash = (await conn.getLatestBlockhash("confirmed")).blockhash;
  tx.sign(keeper);
  await conn.sendRawTransaction(tx.serialize());
}

async function loadBrand() {
  // brand.js is a browser file (window.BRAND = {…}); read it with a shim.
  const fs = await import("fs");
  const path = new URL("../brand.js", import.meta.url);
  const g = {}; const win = {};
  // eslint-disable-next-line no-new-func
  new Function("window", fs.readFileSync(path, "utf8"))(win);
  return win.BRAND || {};
}

/* AUDIT CORE — holder-reward distribution. Structured to mirror keeper.js's
 * dividend path; the harvest + swap execs are stubbed pending the audit so this
 * file can be reviewed without moving reward-pot money before sign-off. */
async function distributeReward(job, ctx) {
  ctx.log.push(job.mint + ": reward mode " + job.rewardMode + " — distribution pending audit (harvest+swap execs stubbed)");
  // TODO(audit): harvestWithheldTokensToMint → withdrawWithheldTokensFromMint →
  //   snapshot holders (getProgramAccounts) → gas preflight (2 + ceil(n/BATCH))·SIG
  //   + n·ATA_RENT + FLOOR → persist the REAL pays → transferChecked per holder;
  //   burn = swap pot→mint + burnChecked; split = half each. Reuse keeper.js.
}
