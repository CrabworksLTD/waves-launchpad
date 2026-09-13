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
// (fail-closed auth · claim/harvest → persist the REAL plan → execute each step
// idempotently · signature written BEFORE broadcast so a crash resumes without
// paying twice · destination from the record, never the caller):
//
//   1. FEE LADDER — claim the tier's platform fee (which the escrow claim wallet
//      holds), forward the creator's share to their fee wallet, keep WAVES's cut.
//      Standard (1.15%) needs no forward: the creator already has their 0.5%
//      on-chain and WAVES keeps the 0.40% platform fee at feeOwner directly.
//   2. HOLDER REWARDS — dividend: harvest the Token-2022 transfer fee + pay
//      holders pro-rata; burn: destroy the harvested token; split: half each;
//      pair: deposit the reward into the staking vault + sync (holders CLAIM).
//
// ── The two non-idempotent boundaries the auditor must focus on ───────────────
// Every deterministic payout below goes through payOnce() (record sig → broadcast
// → confirm), so it is safe to interrupt and resume. Two steps are NOT built by
// us and cannot be wrapped that way, exactly as in keeper.js:
//   • the Raydium `claimPlatformFee` execute (fee ladder)
//   • the Jupiter swap (rewards)
// Both are handled by persisting the plan the instant the step lands, so the pot
// is never spent without a record of who it belongs to. The residual crash window
// (step lands, process dies before the persist) leaves funds in the keeper's OWN
// escrow — recoverable, never lost to a third party. See the notes at each site.
//
// ── Why "delta" for the fee, "whole balance" for the reward ───────────────────
// The platform fee is claimed in the pool's QUOTE mint (mintB). Two SOL-quoted
// launches share the keeper's one WSOL ATA, so the fee job measures the DELTA the
// claim added (before/after) to isolate this launch — never the whole balance,
// which would rob a sibling launch's un-swept fees. The reward pot is harvested in
// the LAUNCHED mint, which is unique to one launch, so the reward job treats the
// keeper's whole ATA balance as the pot — that is what makes the harvest step
// crash-safe (a resume re-reads the balance, which still holds the pot).

export const config = { runtime: "nodejs", maxDuration: 300 };

import { allow, tooMany } from "./_guard.js";

const RPC = process.env.SOLANA_RPC || "https://solana-rpc.publicnode.com";
const TREASURY = process.env.FEE_OWNER || "BU9dYi7fGw5G3Wd54CUTmt1Y58jEJaPq8LKiL72ydeKJ";
const LAMPORTS_PER_SIG = 5000n;
const GAS_FLOOR = 20000000n;               // 0.02 SOL
const ATA_RENT_LAMPORTS = 2040000n;
const BATCH = 5;                           // reward payouts batch small
const PLAN_TTL = 60 * 60 * 24 * 7;         // an unfinished plan is worth resuming a week later
const DUST = 10000n;

const TOKEN2022 = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";
const TOKENKEG = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const WSOL = "So11111111111111111111111111111111111111112";
const STAKE_PROGRAM = "jt5JegTBVPZP8V6a48fnKYPFKTbpcTfkz91Pemur82H";
const SYNC_DISC = Buffer.from([4, 219, 40, 164, 21, 157, 189, 88]); // stake.js IX.sync

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

let _bs58 = null;

export default async function handler(req, res) {
  // fail closed — a missing secret must never authenticate a payout run
  const secret = process.env.CRON_SECRET;
  if (!secret) return res.status(500).json({ error: "CRON_SECRET is not set" });
  if ((req.headers.authorization || "") !== "Bearer " + secret) return res.status(401).json({ error: "no" });
  if (!process.env.KEEPER_SECRET) return res.status(200).json({ ok: true, skipped: "KEEPER_SECRET is not set" });
  if (!(await allow(req, { bucket: "llkeeper", max: 30, windowSec: 60 }))) return tooMany(res, 60);

  const log = [];
  let lockDb = null;
  try {
    /* M-9: single-flight. The fee path's claim measures a before/after DELTA on a
     * quote-mint ATA that is SHARED across SOL-quoted launches, so two overlapping
     * runs would let one run's claim land inside the other's window and mis-attribute
     * fees. A KV lock serialises runs; it auto-expires so a crash cannot wedge it. */
    lockDb = await kv();
    if (lockDb) {
      const got = await lockDb.set("llkeeper:lock", Date.now(), { nx: true, ex: 300 });
      if (!got) return res.status(200).json({ ok: true, skipped: "another run holds the lock" });
    }
    const w3 = await import("@solana/web3.js");
    const r = await import("@raydium-io/raydium-sdk-v2");
    const bs58 = (await import("bs58")).default;
    const splToken = await import("@solana/spl-token");
    const BN = (await import("bn.js")).default;
    _bs58 = bs58;

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
      const raw = db ? await db.lrange("tokens", 0, 199) : [];
      all = (raw || []).map((x) => (typeof x === "string" ? JSON.parse(x) : x)).filter(Boolean);
    } catch (e) { log.push("could not read tokens: " + String((e && e.message) || e).slice(0, 80)); }
    /* H-6: "burn" is NOT serviceable here. The H-3 fix made a pure-burn launch a
     * standard SPL token with NO transfer-fee extension, so there is nothing to
     * harvest — this keeper would throw at the harvest on every burn job. A buyback
     * -and-burn needs the other pipeline (claim fees in the QUOTE → swap quote→
     * launched mint → burn), which is not built. Until it is, burn is excluded so
     * a creator is never shown a silent, perpetually-failing job. NOTE: "split"
     * DOES burn half — but a split launch keeps the transfer-fee extension
     * (hasHolderTax = dividend || split), so its burn-half destroys harvested
     * launched-mint tokens directly, which works. Only pure burn is out. */
    // A PAIR routes the creator's trading fee to a staking vault (feeShare "vault"
    // + a paired collection). Its token is STANDARD (no transfer tax), so it is
    // serviced by runPair (claim creator fee → vault), NOT the transfer-fee
    // dividend path. A tier or a non-pair dividend/split is serviced as before.
    const isPair = (t) => !!(t.pairedCollection || (t.feeShare === "vault" && t.collection));
    const jobs = all.filter((t) =>
      t.backend === "launchlab" &&
      ((t.tier && t.tier !== "standard") ||
       isPair(t) ||
       ["dividend", "split"].indexOf(t.rewardMode) >= 0));

    log.push("launchlab jobs: " + jobs.length);

    const ctx = { conn, w3, r, splToken, BN, lp, prog, keeper, db, log, tiers };
    for (const job of jobs) {
      if (!job.mint || !job.pool) continue;
      try {
        if (isPair(job)) {
          // pair: the keeper IS the pool creator, so it claims the creator's 0.5%
          // (in the quote) and routes it to the staking vault. No transfer tax.
          await runPair(job, ctx);
        } else {
          if (job.tier && job.tier !== "standard" && tiers[job.tier]) {
            await runFeeLadder(job, ctx);
          }
          if (["dividend", "split"].indexOf(job.rewardMode) >= 0) {   // H-6: burn excluded
            await runReward(job, ctx);
          }
        }
      } catch (e) {
        // the plan (if any) stays in KV; the next run picks it up where it stopped
        log.push(job.mint + ": FAILED — " + String((e && e.message) || e).slice(0, 140));
      }
    }

    return res.status(200).json({ ok: true, jobs: jobs.length, log });
  } catch (e) {
    return res.status(200).json({ ok: false, error: String((e && e.message) || e).slice(0, 200), log });
  } finally {
    // release the single-flight lock so the next scheduled run is not blocked for
    // the full TTL; a crash before this still clears via the lock's own expiry.
    if (lockDb) { try { await lockDb.del("llkeeper:lock"); } catch (e) {} }
  }
}

/* ── FEE LADDER ────────────────────────────────────────────────────────────────
 * Claim the tier's platform fee into the keeper escrow, forward the creator's
 * share, sweep WAVES's cut. Resume-safe: the plan records the exact amounts, and
 * the forward + sweep are payOnce steps. */
async function runFeeLadder(job, ctx) {
  const { conn, w3, r, splToken, lp, prog, keeper, db, log, tiers } = ctx;
  const tier = tiers[job.tier];
  const frac = creatorFraction(tier);
  const planKey = "llfee:" + job.mint;
  const save = async () => { if (db) await db.set(planKey, JSON.stringify(plan), { ex: PLAN_TTL }); };

  /* M-11: a tier with a bad brand.js entry makes frac === 0, which would forward
   * the creator NOTHING and sweep the ENTIRE platform fee to the treasury —
   * logged as a normal run. That is the one failure mode in this file that would
   * read as deliberate theft in a dispute. So a non-standard tier that resolves to
   * frac 0 SKIPS loudly and claims nothing, rather than paying us 100%. (A resume
   * of a plan already written with a good frac is unaffected — this guards the
   * fresh-claim path.) */
  const resuming = db ? await db.get(planKey).catch(() => null) : null;
  if (!resuming && !(frac > 0)) {
    log.push(job.mint + ": ⚠ tier '" + job.tier + "' resolves to creator-fraction 0 (bad config) — SKIPPED, not claiming");
    return;
  }

  // resume an in-flight plan before claiming again (keeper.js pattern)
  let plan = resuming;
  if (typeof plan === "string") { try { plan = JSON.parse(plan); } catch { plan = null; } }

  if (!plan) {
    const poolId = new w3.PublicKey(job.pool);
    const p = r.LaunchpadPool.decode((await conn.getAccountInfo(poolId)).data);
    const mintB = p.mintB.toBase58();
    const mintBProgram = await mintProgram(conn, w3, mintB);

    // measure the DELTA the claim adds (never the whole balance — a shared quote
    // ATA holds sibling launches' fees; see the header note).
    const before = await ataBalance(conn, w3, splToken, mintB, keeper.publicKey, mintBProgram);
    // NON-IDEMPOTENT boundary #1: Raydium's own execute. Re-claiming is safe (it
    // only ever claims freshly-accrued fees), so the residual crash window here —
    // claim lands, process dies before `save()` below — is recovered on the next
    // run: re-claim adds ~0, delta ≈ 0, and the previously-claimed amount stays in
    // the keeper's OWN escrow. It is never lost, only deferred to manual sweep.
    const built = await lp.claimPlatformFee({
      programId: prog, platformId: new w3.PublicKey(tier.platformId),
      platformClaimFeeWallet: keeper.publicKey,
      poolId, mintB: new w3.PublicKey(mintB),
      mintBProgram: new w3.PublicKey(mintBProgram), txVersion: r.TxVersion.LEGACY,
    });
    await built.execute({ sendAndConfirm: true });
    const after = await ataBalance(conn, w3, splToken, mintB, keeper.publicKey, mintBProgram);
    const claimed = after - before;
    if (claimed <= 0n) { log.push(job.mint + ": no platform fee to claim"); if (db) await db.del(planKey); return; }

    const toCreator = (claimed * BigInt(Math.round(frac * 1e6))) / 1000000n;
    const dest = job.feeWallet || job.creator;             // from the RECORD, never a request
    plan = {
      kind: "fee", mint: job.mint, mintB, mintBProgram,
      claimed: claimed.toString(),
      toCreator: (dest ? toCreator : 0n).toString(),
      toKeep: (claimed - (dest ? toCreator : 0n)).toString(),
      creatorDest: dest || null, frac,
    };
    await save();
    log.push(job.mint + ": claimed " + claimed + " (fee tier " + job.tier + ")");
  } else {
    log.push(job.mint + ": resuming fee plan");
  }

  const mintB = plan.mintB, mintBProgram = plan.mintBProgram;
  // forward the creator's share (payOnce — resume-safe token transfer)
  if (BigInt(plan.toCreator) > 0n && plan.creatorDest && !plan.creatorDone) {
    await payOnce(conn, keeper, plan, "creator", () =>
      buildTransfer(conn, w3, splToken, keeper, mintB, mintBProgram, new w3.PublicKey(plan.creatorDest), BigInt(plan.toCreator)), save);
    log.push(job.mint + ": forwarded " + plan.toCreator + " (" + (plan.frac * 100).toFixed(1) + "%) to creator");
  }
  // sweep WAVES's cut to the treasury
  if (BigInt(plan.toKeep) > 0n && !plan.keepDone) {
    await payOnce(conn, keeper, plan, "keep", () =>
      buildTransfer(conn, w3, splToken, keeper, mintB, mintBProgram, new w3.PublicKey(TREASURY), BigInt(plan.toKeep)), save);
    log.push(job.mint + ": swept " + plan.toKeep + " to treasury");
  }
  if (db) await db.del(planKey);
}

/* ── PAIR ─────────────────────────────────────────────────────────────────────
 * The keeper is the pool's CREATOR (set at launch), so it claims the creator's
 * 0.5% trading fee — which accrues in the QUOTE (SOL for a SOL-quoted pair) — and
 * routes it to the collection's staking vault. Platform (0.4%) and Raydium (0.25%)
 * are never touched. If the vault's reward asset isn't the quote, the claimed
 * quote is swapped into it first; swapping FROM the quote (SOL/USDC/a liquid stock)
 * always routes, so this works from the first trade, pre-graduation. No transfer
 * tax on the token. Crash-safe: the claim is the one non-idempotent step, the
 * deposit + sync are payOnce. */
async function runPair(job, ctx) {
  const { conn, w3, r, splToken, lp, prog, keeper, db, log } = ctx;
  const planKey = "llpair:" + job.mint;
  const save = async () => { if (db) await db.set(planKey, JSON.stringify(plan), { ex: PLAN_TTL }); };

  const pairedCollection = job.pairedCollection || (job.feeShare === "vault" ? job.collection : null);
  if (!pairedCollection) { log.push(job.mint + ": pair has no collection — skip"); return; }

  // the staking pool + its real vault + reward mint (authoritative, from chain).
  // pool layout: disc8 | tokenMint32 | collection32 | rewardMint@72..104 | vault@104..136
  const stakeProg = new w3.PublicKey(STAKE_PROGRAM);
  const [spool] = w3.PublicKey.findProgramAddressSync(
    [Buffer.from("pool"), new w3.PublicKey(job.mint).toBuffer(), new w3.PublicKey(pairedCollection).toBuffer()], stakeProg);
  const spoolAcc = await conn.getAccountInfo(spool);
  if (!spoolAcc) { log.push(job.mint + ": staking pool not initialised — skip"); return; }
  const vaultRewardMint = new w3.PublicKey(spoolAcc.data.slice(72, 104)).toBase58();
  const vault = new w3.PublicKey(spoolAcc.data.slice(104, 136));

  let plan = db ? await db.get(planKey).catch(() => null) : null;
  if (typeof plan === "string") { try { plan = JSON.parse(plan); } catch { plan = null; } }

  if (!plan) {
    const p = r.LaunchpadPool.decode((await conn.getAccountInfo(new w3.PublicKey(job.pool))).data);
    const quote = p.mintB.toBase58();
    const quoteProgram = await mintProgram(conn, w3, quote);

    // claim the creator's fee (in the quote) to the keeper's quote ATA, by delta.
    // NON-IDEMPOTENT boundary: Raydium claimCreatorFee execute — the keeper IS the
    // pool creator, so this succeeds; re-claiming only ever takes freshly-accrued
    // fees, and the residual crash window strands funds in the keeper's OWN ATA.
    const before = await ataBalance(conn, w3, splToken, quote, keeper.publicKey, quoteProgram);
    const built = await lp.claimCreatorFee({
      programId: prog, mintB: new w3.PublicKey(quote),
      mintBProgram: new w3.PublicKey(quoteProgram), txVersion: r.TxVersion.LEGACY,
    });
    await built.execute({ sendAndConfirm: true });
    const after = await ataBalance(conn, w3, splToken, quote, keeper.publicKey, quoteProgram);
    const claimed = after - before;
    if (claimed <= 0n) { log.push(job.mint + ": no creator fee to claim"); if (db) await db.del(planKey); return; }

    plan = {
      kind: "pair", mint: job.mint, quote, quoteProgram,
      vault: vault.toBase58(), vaultRewardMint, spool: spool.toBase58(),
      claimed: claimed.toString(), payAmount: null, payMint: null, payProgram: null,
    };
    await save();
    log.push(job.mint + ": claimed creator fee " + claimed + " " + quote.slice(0, 6));
  } else {
    log.push(job.mint + ": resuming pair plan");
  }

  // swap the claimed quote into the vault's reward asset, if different
  if (plan.payAmount == null) {
    if (plan.vaultRewardMint === plan.quote) {
      plan.payAmount = plan.claimed; plan.payMint = plan.quote; plan.payProgram = plan.quoteProgram;
    } else {
      const got = await jupSwap(conn, w3, keeper, plan.quote, plan.vaultRewardMint, BigInt(plan.claimed));
      plan.payAmount = got.toString();
      plan.payMint = plan.vaultRewardMint;
      plan.payProgram = await mintProgram(conn, w3, plan.vaultRewardMint);
      log.push(job.mint + ": swapped → " + got + " " + plan.vaultRewardMint.slice(0, 6));
    }
    await save();
  }
  if (BigInt(plan.payAmount) <= 0n) { if (db) await db.del(planKey); return; }

  // deposit into the staking vault + sync (payOnce, resume-safe)
  const vaultPk = new w3.PublicKey(plan.vault);
  const spoolPk = new w3.PublicKey(plan.spool);
  if (!plan.depositDone) {
    const payMintPk = new w3.PublicKey(plan.payMint);
    const payProgPk = new w3.PublicKey(plan.payProgram);
    const from = splToken.getAssociatedTokenAddressSync(payMintPk, keeper.publicKey, true, payProgPk);
    const dec = (await conn.getTokenAccountBalance(from)).value.decimals;
    await payOnce(conn, keeper, plan, "deposit", () => {
      const t = new w3.Transaction();
      t.add(splToken.createTransferCheckedInstruction(from, payMintPk, vaultPk, keeper.publicKey, BigInt(plan.payAmount), dec, [], payProgPk));
      return t;
    }, save);
    log.push(job.mint + ": deposited " + plan.payAmount + " to staking vault");
  }
  if (!plan.syncDone) {
    await payOnce(conn, keeper, plan, "sync", () => {
      const t = new w3.Transaction();
      t.add({ programId: stakeProg,
        keys: [{ pubkey: spoolPk, isSigner: false, isWritable: true }, { pubkey: vaultPk, isSigner: false, isWritable: false }],
        data: SYNC_DISC });
      return t;
    }, save);
    log.push(job.mint + ": synced staking accumulator");
  }
  if (db) await db.del(planKey);
}

/* ── HOLDER REWARDS: dividend / burn / split / pair ────────────────────────────
 * The reward pot is the Token-2022 transfer fee withheld on the LAUNCHED mint.
 * Harvest it, then per mode. The launched mint is unique to one launch, so the
 * keeper's whole ATA balance IS the pot (crash-safe: a resume re-reads it). The
 * plan records every downstream amount + the real payee list before a single
 * payout, and each payout is a payOnce step. */
async function runReward(job, ctx) {
  const { conn, w3, r, prog, splToken, keeper, db, log } = ctx;
  const planKey = "llrew:" + job.mint;
  const save = async () => { if (db) await db.set(planKey, JSON.stringify(plan), { ex: PLAN_TTL }); };

  let plan = db ? await db.get(planKey).catch(() => null) : null;
  if (typeof plan === "string") { try { plan = JSON.parse(plan); } catch { plan = null; } }

  // Low (audited): do the cheap fallible check before the IRREVERSIBLE harvest, so
  // a broke keeper never withdraws a pot it then cannot distribute. A finer
  // per-holder gas check still runs before the dividend batches below.
  if (!plan && BigInt(await conn.getBalance(keeper.publicKey)) < GAS_FLOOR) {
    log.push(job.mint + ": keeper below gas floor — deferring harvest"); return;
  }

  if (!plan) {
    // 1) harvest the transfer fee into the keeper's ATA of the launched mint
    await harvestTransferFee(conn, w3, splToken, job.mint, keeper);
    const mintPk = new w3.PublicKey(job.mint);
    const t22 = new w3.PublicKey(TOKEN2022);
    const keeperAta = splToken.getAssociatedTokenAddressSync(mintPk, keeper.publicKey, true, t22);
    const pot = await ataBal(conn, w3, keeperAta);           // whole balance = the pot (unique mint)
    if (pot <= 0n) { log.push(job.mint + ": nothing to harvest"); if (db) await db.del(planKey); return; }

    const mode = job.rewardMode;
    const toBurn = mode === "burn" ? pot : mode === "split" ? pot / 2n : 0n;
    const toPay = pot - toBurn;
    // a pair routes its reward into the staking vault. pairedCollection is the
    // field the record carries; fall back to `collection` when the record only
    // marked feeShare:"vault" (older records), so a pair never mis-pays the
    // token's own holders instead of the NFT stakers.
    const pairedCollection = job.pairedCollection || (job.feeShare === "vault" ? job.collection : null) || null;
    plan = {
      kind: "reward", mode, mint: job.mint, pot: pot.toString(),
      toBurn: toBurn.toString(), toPay: toPay.toString(),
      rewardMint: job.rewardMint || WSOL,
      pairedCollection,
      isPair: !!pairedCollection,
      payAmount: null, payMint: null, payProgram: null, pays: null, done: 0,
    };
    await save();
    log.push(job.mint + ": harvested " + pot + " (" + mode + ")");
  } else {
    log.push(job.mint + ": resuming reward plan");
  }

  const mintPk = new w3.PublicKey(job.mint);
  const t22 = new w3.PublicKey(TOKEN2022);
  const keeperAta = splToken.getAssociatedTokenAddressSync(mintPk, keeper.publicKey, true, t22);

  // 2) burn portion — the pot IS the launched token, so burn directly (payOnce)
  if (BigInt(plan.toBurn) > 0n && !plan.burnDone) {
    const dec = (await conn.getTokenAccountBalance(keeperAta)).value.decimals;
    await payOnce(conn, keeper, plan, "burn", () => {
      const t = new w3.Transaction();
      t.add(splToken.createBurnCheckedInstruction(keeperAta, mintPk, keeper.publicKey, BigInt(plan.toBurn), dec, [], t22));
      return t;
    }, save);
    log.push(job.mint + ": burned " + plan.toBurn);
  }
  if (BigInt(plan.toPay) <= 0n) { if (db) await db.del(planKey); return; }

  // 3) swap the pay portion into the reward asset, then persist the result.
  // NON-IDEMPOTENT boundary #2: the Jupiter swap. We record payAmount the instant
  // it lands so the pot is never spent without a plan naming the payees. The
  // residual window (swap lands, die before persist) leaves the swapped asset in
  // the keeper's OWN ATA — recoverable, never a third-party loss.
  if (plan.payAmount == null) {
    if (plan.rewardMint === plan.mint) {
      plan.payAmount = plan.toPay; plan.payMint = plan.mint; plan.payProgram = TOKEN2022;
    } else {
      const got = await jupSwap(conn, w3, keeper, plan.mint, plan.rewardMint, BigInt(plan.toPay));
      plan.payAmount = got.toString();
      plan.payMint = plan.rewardMint;
      plan.payProgram = await mintProgram(conn, w3, plan.rewardMint);
      log.push(job.mint + ": swapped → " + got + " " + plan.rewardMint.slice(0, 6));
    }
    await save();
  }
  if (BigInt(plan.payAmount) <= 0n) { if (db) await db.del(planKey); return; }

  // 4a) PAIR — deposit the reward into the staking vault + sync (holders CLAIM)
  if (plan.isPair && plan.pairedCollection) {
    const stakeProg = new w3.PublicKey(STAKE_PROGRAM);
    const [pool] = w3.PublicKey.findProgramAddressSync(
      [Buffer.from("pool"), mintPk.toBuffer(), new w3.PublicKey(plan.pairedCollection).toBuffer()], stakeProg);
    const payProg = plan.payProgram;
    /* M-10 (audited): init_pool is permissionless and its `vault` is only
     * constrained to (mint, authority=pool) — NOT to the ATA. So read the pool's
     * actual `vault` field (layout: disc8 | tokenMint32 | collection32 |
     * rewardMint32 | vault@104..136 | …) instead of deriving the ATA. If a pool
     * was created with a non-ATA vault, deriving the ATA would deposit into an
     * account the program never sees and `sync` (has_one = vault) would reject —
     * stranding the reward. Reading pool.vault makes the invariant true by
     * construction. */
    const poolAcc = await conn.getAccountInfo(pool);
    if (!poolAcc) { log.push(job.mint + ": ⚠ pair pool not initialised — cannot deposit reward"); return; }
    const vault = new w3.PublicKey(poolAcc.data.slice(104, 136));
    if (!plan.depositDone) {
      // deposit into the pool's ACTUAL vault account (read above), never a derived
      // ATA — the vault already exists from init_pool, so transfer straight to it.
      const payMintPk = new w3.PublicKey(plan.payMint);
      const payProgPk = new w3.PublicKey(payProg);
      const from = splToken.getAssociatedTokenAddressSync(payMintPk, keeper.publicKey, true, payProgPk);
      const dec = (await conn.getTokenAccountBalance(from)).value.decimals;
      await payOnce(conn, keeper, plan, "deposit", () => {
        const t = new w3.Transaction();
        t.add(splToken.createTransferCheckedInstruction(from, payMintPk, vault, keeper.publicKey, BigInt(plan.payAmount), dec, [], payProgPk));
        return t;
      }, save);
      log.push(job.mint + ": deposited " + plan.payAmount + " to staking vault");
    }
    if (!plan.syncDone) {
      await payOnce(conn, keeper, plan, "sync", () => {
        const t = new w3.Transaction();
        t.add({
          programId: stakeProg,
          keys: [{ pubkey: pool, isSigner: false, isWritable: true }, { pubkey: vault, isSigner: false, isWritable: false }],
          data: SYNC_DISC,
        });
        return t;
      }, save);
      log.push(job.mint + ": synced staking accumulator");
    }
    if (db) await db.del(planKey);
    return;
  }

  // 4b) plain DIVIDEND — snapshot holders + compute the real pays ONCE, then pay.
  if (!plan.pays) {
    /* H-4 (audited): the curve's OWN base vault is a token account of the launched
     * mint, so getProgramAccounts finds it and — pre-graduation, exactly when
     * transfer fees accrue — it holds the large majority of supply. Paying it a
     * pro-rata dividend derives an ATA owned by a pool PDA whose program has no
     * instruction to move a reward mint: the money is PERMANENTLY STRANDED, not
     * misdelivered. So exclude the base vault (by account) and everything the pool
     * authority / pool PDA owns (by owner). */
    const poolAcc = await conn.getAccountInfo(new w3.PublicKey(job.pool));
    const skipAccounts = new Set();
    const skipOwners = new Set([keeper.publicKey.toBase58()]);
    if (poolAcc) {
      const p = r.LaunchpadPool.decode(poolAcc.data);
      skipAccounts.add(p.vaultA.toBase58());               // the curve's base-token vault
      skipOwners.add(job.pool);                            // anything the pool itself owns
      try { skipOwners.add(r.getPdaLaunchpadAuth(prog).publicKey.toBase58()); } catch (e) {}
    } else {
      log.push(job.mint + ": ⚠ could not read pool to exclude the curve vault — skipping to avoid stranding funds");
      return;
    }
    const { holders, total } = await snapshotHolders(conn, w3, job.mint, TOKEN2022, skipOwners, skipAccounts);
    if (!holders.length || total === 0n) { log.push(job.mint + ": no holders to pay"); if (db) await db.del(planKey); return; }
    const n = holders.length;
    const need = BigInt(2 + Math.ceil(n / BATCH)) * LAMPORTS_PER_SIG + BigInt(n) * ATA_RENT_LAMPORTS + GAS_FLOOR;
    if (BigInt(await conn.getBalance(keeper.publicKey)) < need) { log.push(job.mint + ": keeper short on gas (" + need + ")"); return; }
    const payAmt = BigInt(plan.payAmount);
    plan.pays = holders
      .map((h) => ({ owner: h.owner, amount: ((payAmt * h.amount) / total).toString() }))
      .filter((p) => BigInt(p.amount) >= DUST);
    plan.done = 0;
    await save();
  }

  // 5) pay each batch through payOnce — resume picks up at plan.done
  const payMintPk = new w3.PublicKey(plan.payMint);
  const payProg = new w3.PublicKey(plan.payProgram);
  const from = splToken.getAssociatedTokenAddressSync(payMintPk, keeper.publicKey, true, payProg);
  const dec = (await conn.getTokenAccountBalance(from)).value.decimals;
  while (plan.done < plan.pays.length) {
    const at = plan.done;
    const slice = plan.pays.slice(at, at + BATCH);
    await payOnce(conn, keeper, plan, "batch" + at, () => {
      const t = new w3.Transaction();
      for (const p of slice) {
        const to = new w3.PublicKey(p.owner);
        const toAta = splToken.getAssociatedTokenAddressSync(payMintPk, to, true, payProg);
        t.add(splToken.createAssociatedTokenAccountIdempotentInstruction(keeper.publicKey, toAta, to, payMintPk, payProg));
        t.add(splToken.createTransferCheckedInstruction(from, payMintPk, toAta, keeper.publicKey, BigInt(p.amount), dec, [], payProg));
      }
      return t;
    }, save);
    plan.done = at + slice.length;
    await save();
  }
  log.push(job.mint + ": paid " + plan.pays.length + " holders " + plan.payAmount + " " + plan.payMint.slice(0, 6));
  if (db) {
    await db.del(planKey);
    await db.lpush("llkeeperlog", JSON.stringify({ mint: job.mint, mode: plan.mode, pot: plan.pot, holders: plan.pays.length }));
    await db.ltrim("llkeeperlog", 0, 499);
  }
}

// ── idempotent-payment primitive (verbatim shape from keeper.js) ────────────────

/* A payment that can be interrupted at any instant and resumed without paying
 * twice. The signature is recorded BEFORE the tx is broadcast; on resume a known
 * signature is checked against the chain — landed → mark done, never landed →
 * rebuild and send. `slot` is the plan field prefix; `build` returns a fresh
 * Transaction; `save` persists the plan. */
async function payOnce(conn, keeper, plan, slot, build, save) {
  if (plan[slot + "Done"]) return;
  const known = plan[slot + "Sig"];
  if (known) {
    const st = await conn.getSignatureStatus(known, { searchTransactionHistory: true }).catch(() => null);
    const v = st && st.value;
    if (v && !v.err) { plan[slot + "Done"] = true; await save(); return; }
  }
  const tx = await build();
  tx.feePayer = keeper.publicKey;
  tx.recentBlockhash = (await conn.getLatestBlockhash("confirmed")).blockhash;
  tx.sign(keeper);
  const raw = tx.serialize();
  const sig = _bs58.encode(tx.signature);
  plan[slot + "Sig"] = sig;                                 // record before it can land
  await save();
  await conn.sendRawTransaction(raw, { maxRetries: 5 });
  await confirmed(conn, sig, raw);
  plan[slot + "Done"] = true;
  await save();
}

async function confirmed(conn, sig, raw, ms) {
  const deadline = Date.now() + (ms || 90000);
  let lastSend = Date.now();
  while (Date.now() < deadline) {
    const st = await conn.getSignatureStatus(sig, { searchTransactionHistory: true }).catch(() => null);
    const v = st && st.value;
    if (v) {
      if (v.err) throw new Error("transaction failed: " + JSON.stringify(v.err));
      if (v.confirmationStatus === "confirmed" || v.confirmationStatus === "finalized") return true;
    }
    if (raw && Date.now() - lastSend > 6000) {
      lastSend = Date.now();
      conn.sendRawTransaction(raw, { skipPreflight: true, maxRetries: 5 }).catch(() => {});
    }
    await new Promise((r) => setTimeout(r, 700));
  }
  throw new Error("not confirmed within timeout");
}

// send one signed tx of raw instructions, confirmed-by-polling. Used only for the
// naturally-idempotent harvest/withdraw steps (re-running harvests ~0 more), NOT
// for payouts — those go through payOnce.
async function sendIx(conn, w3, keeper, ixs) {
  const tx = new w3.Transaction().add(...ixs);
  tx.feePayer = keeper.publicKey;
  tx.recentBlockhash = (await conn.getLatestBlockhash("confirmed")).blockhash;
  tx.sign(keeper);
  const raw = tx.serialize();
  const sig = await conn.sendRawTransaction(raw, { maxRetries: 5 });
  await confirmed(conn, sig, raw);
  return sig;
}

// ── helpers ───────────────────────────────────────────────────────────────────

async function mintProgram(conn, w3, mintStr) {
  const acc = await conn.getAccountInfo(new w3.PublicKey(mintStr));
  return acc && acc.owner && acc.owner.toBase58() === TOKEN2022 ? TOKEN2022 : TOKENKEG;
}
async function ataBalance(conn, w3, splToken, mint, owner, programId) {
  const ata = splToken.getAssociatedTokenAddressSync(new w3.PublicKey(mint), owner, true, new w3.PublicKey(programId));
  const bal = await conn.getTokenAccountBalance(ata).catch(() => null);
  return bal ? BigInt(bal.value.amount) : 0n;
}
async function ataBal(conn, w3, ata) {
  const b = await conn.getTokenAccountBalance(ata).catch(() => null);
  return b ? BigInt(b.value.amount) : 0n;
}

// build (do not send) a transferChecked, creating the destination ATA if needed.
async function buildTransfer(conn, w3, splToken, keeper, mint, programId, to, amount) {
  const prog = new w3.PublicKey(programId);
  const mintPk = new w3.PublicKey(mint);
  const from = splToken.getAssociatedTokenAddressSync(mintPk, keeper.publicKey, true, prog);
  const toAta = splToken.getAssociatedTokenAddressSync(mintPk, to, true, prog);
  const dec = (await conn.getTokenAccountBalance(from)).value.decimals;
  const t = new w3.Transaction();
  t.add(splToken.createAssociatedTokenAccountIdempotentInstruction(keeper.publicKey, toAta, to, mintPk, prog));
  t.add(splToken.createTransferCheckedInstruction(from, mintPk, toAta, keeper.publicKey, amount, dec, [], prog));
  return t;
}

/* Harvest the Token-2022 transfer fee for `mint` into the keeper's ATA. The keeper
 * is the mint's transferFeeExtensionAuth (set to EFFY at launch), so it may
 * withdraw. Naturally idempotent: a re-run finds no withheld fees and harvests ~0. */
async function harvestTransferFee(conn, w3, splToken, mint, keeper) {
  const mintPk = new w3.PublicKey(mint);
  const T22 = new w3.PublicKey(TOKEN2022);
  const accs = await conn.getProgramAccounts(T22, {
    commitment: "confirmed", filters: [{ memcmp: { offset: 0, bytes: mint } }],
  });
  const sources = [];
  for (const a of accs) {
    try {
      const acc = splToken.unpackAccount(a.pubkey, a.account, T22);
      const fee = splToken.getTransferFeeAmount(acc);
      if (fee && fee.withheldAmount > 0n) sources.push(a.pubkey);
    } catch (e) {}
  }
  for (let i = 0; i < sources.length; i += 20) {
    await sendIx(conn, w3, keeper, [splToken.createHarvestWithheldTokensToMintInstruction(mintPk, sources.slice(i, i + 20), [], T22)]);
  }
  const keeperAta = splToken.getAssociatedTokenAddressSync(mintPk, keeper.publicKey, true, T22);
  const ixs = [];
  if (!(await conn.getAccountInfo(keeperAta))) ixs.push(splToken.createAssociatedTokenAccountInstruction(keeper.publicKey, keeperAta, keeper.publicKey, mintPk, T22));
  ixs.push(splToken.createWithdrawWithheldTokensFromMintInstruction(mintPk, keeperAta, keeper.publicKey, [], T22));
  await sendIx(conn, w3, keeper, ixs);
}

/* Pro-rata holder snapshot from the launched mint's token accounts. Excludes both
 * a set of OWNERS (keeper, pool authority, pool) and a set of ACCOUNT addresses
 * (the curve base vault — see H-4). offset 0 = mint, 32 = owner, 64 = amount.
 *
 * NOTE (re the Low finding suggesting a dataSize:165 filter): NOT applied here on
 * purpose. keeper.js can use it because a Meteora launched token is classic-SPL,
 * but a LaunchLab dividend mint is Token-2022 with a TransferFeeAmount extension —
 * its token accounts are ~178 bytes, so dataSize:165 would match NOTHING and
 * silently pay no one. The offset-0 mint memcmp already selects only token
 * accounts (a Mint account has no mint pubkey at offset 0), and the base layout is
 * identical for the first 165 bytes, so reading owner@32 / amount@64 is safe with
 * or without extensions. */
async function snapshotHolders(conn, w3, mint, mintProgramId, skipOwners, skipAccounts) {
  const accs = await conn.getProgramAccounts(new w3.PublicKey(mintProgramId), {
    commitment: "confirmed", filters: [{ memcmp: { offset: 0, bytes: mint } }],
  });
  const holders = []; let total = 0n;
  for (const a of accs) {
    if (skipAccounts && skipAccounts.has(a.pubkey.toBase58())) continue;
    const d = a.account.data;
    const owner = new w3.PublicKey(d.slice(32, 64)).toBase58();
    const amt = d.readBigUInt64LE(64);
    if (amt === 0n || skipOwners.has(owner)) continue;
    holders.push({ owner, amount: amt }); total += amt;
  }
  return { holders, total };
}

/* Jupiter swap: `amountIn` of `inMint` → `outMint`, landing in the keeper's ATA.
 * Returns the amount that ACTUALLY ARRIVED, measured as a before/after delta on
 * the destination ATA — NOT the quoted `outAmount`.
 *
 * H-5 (audited): the previous version returned `q.outAmount` (the quote) and
 * swallowed a failed confirmation. At 100 bps slippage the real receipt can be up
 * to 1% lower, so `payAmount` was set too high, the holder shares summed to more
 * than the keeper held, and the LAST batch failed with insufficient funds —
 * wedging the plan forever with early holders paid and late holders never paid.
 * A reverted swap was also indistinguishable from a success. This mirrors
 * keeper.js's `doSwap`: read before, send, confirm (THROW on failure), then read
 * after with a few retries before believing a zero, and return the delta. */
async function jupSwap(conn, w3, keeper, inMint, outMint, amountIn) {
  const q = await (await fetch("https://lite-api.jup.ag/swap/v1/quote?inputMint=" + inMint +
    "&outputMint=" + outMint + "&amount=" + amountIn.toString() + "&slippageBps=100&restrictIntermediateTokens=true")).json();
  if (!q || !q.outAmount) throw new Error("no swap route " + inMint.slice(0, 6) + "→" + outMint.slice(0, 6));
  /* wrapAndUnwrapSol MUST be false. The swap INPUT is always the harvested Token-
   * 2022 launched mint — never native SOL — so we never need input-wrapping. But
   * with it true and the OUTPUT being WSOL (a SOL-denominated dividend, the common
   * case), Jupiter unwraps the received WSOL to native SOL and closes the ATA — the
   * before/after delta on the WSOL token account then reads ZERO and this function
   * would wrongly throw "no WSOL arrived". False keeps WSOL as tokens in the ATA, so
   * the delta read works and holders are paid WSOL uniformly with every other SPL
   * reward (audited §2b). */
  const sr = await (await fetch("https://lite-api.jup.ag/swap/v1/swap", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ quoteResponse: q, userPublicKey: keeper.publicKey.toBase58(), wrapAndUnwrapSol: false, dynamicComputeUnitLimit: true }),
  })).json();
  if (!sr || !sr.swapTransaction) throw new Error("swap build failed");

  const outProgram = await mintProgram(conn, w3, outMint);
  const ata = splTokenAta(w3, outMint, keeper.publicKey, outProgram);
  const before = await ataBal(conn, w3, ata);

  const raw = Buffer.from(sr.swapTransaction, "base64");
  const tx = w3.VersionedTransaction.deserialize(raw);
  tx.sign([keeper]);
  const bytes = tx.serialize();
  const sig = await conn.sendRawTransaction(bytes, { maxRetries: 5 });
  await confirmed(conn, sig, bytes, 120000);              // THROWS if the swap did not land

  // a confirmed tx whose state has not propagated to the node we ask reads as
  // "nothing arrived" — ask again a few times before believing a zero.
  let after = before, gained = 0n;
  for (let i = 0; i < 6; i++) {
    after = await ataBal(conn, w3, ata);
    gained = after > before ? after - before : 0n;
    if (gained > 0n) break;
    await new Promise((r) => setTimeout(r, 700));
  }
  if (gained <= 0n) throw new Error("swap confirmed but no " + outMint.slice(0, 6) + " arrived");
  return gained;
}

// spl-token's getAssociatedTokenAddressSync is imported lazily in the handler; a
// tiny module-scope helper keeps jupSwap readable without threading splToken in.
function splTokenAta(w3, mint, owner, programId) {
  // ATA PDA: [owner, tokenProgram, mint] under the ATA program.
  const ATA_PROG = new w3.PublicKey("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");
  return w3.PublicKey.findProgramAddressSync(
    [new w3.PublicKey(owner).toBuffer(), new w3.PublicKey(programId).toBuffer(), new w3.PublicKey(mint).toBuffer()],
    ATA_PROG)[0];
}

async function loadBrand() {
  // brand.js is a browser file (window.BRAND = {…}); read it with a shim.
  const fs = await import("fs");
  const path = new URL("../brand.js", import.meta.url);
  const win = {};
  // eslint-disable-next-line no-new-func
  new Function("window", fs.readFileSync(path, "utf8"))(win);
  return win.BRAND || {};
}
