#!/usr/bin/env node
/* The fee-share keeper. For every launch pledged to holders, this:
 *
 *   1. claims the pool's accrued creator-side fees (the keeper wallet holds
 *      the pool's creator authority on shared launches — the launcher gave
 *      it up at launch, which is what makes the pledge enforceable)
 *   2. snapshots the token's holders
 *   3. distributes the claimed quote pro-rata by holdings, batched
 *
 *   KEEPER_SECRET=<base58> RPC=<url> node tools/fee-share-keeper.js [--dry-run]
 *   MINTS=mint1,mint2       explicit list (else reads the records API)
 *   RECORDS=https://...     records endpoint (default: the live site)
 *
 * v1 distributes in the pool's QUOTE (SOL today). Converting to the pledged
 * reward asset first (Jupiter swap) is the planned upgrade — run on a
 * schedule regardless: xStocks liquidity thins outside market hours.
 *
 * Distribution rules, stated because they are policy:
 *   - holders below DUST_MIN_LAMPORTS of payout are skipped (rent-level
 *     transfers cost more than they deliver); their share stays in the
 *     keeper for the next run rather than being burned
 *   - the pool's own vaults and the keeper itself are excluded
 *   - rounding truncates; remainder carries to the next run
 */
"use strict";

const fs = require("fs");
const path = require("path");

const RPC = process.env.RPC || "https://api.mainnet-beta.solana.com";
const RECORDS = process.env.RECORDS || "https://waves-launchpad-crabworksltd.vercel.app/api/tokens";
const DRY = process.argv.includes("--dry-run");
const DUST_MIN_LAMPORTS = 10_000;          // ~0.00001 SOL
const BATCH = 12;                          // transfers per transaction

(async () => {
  const { Connection, Keypair, PublicKey, SystemProgram, Transaction } =
    await import("@solana/web3.js");
  const M = await import("@meteora-ag/dynamic-bonding-curve-sdk");
  const BN = require("bn.js");
  const bs58 = (await import("bs58")).default;

  if (!process.env.KEEPER_SECRET) {
    console.error("KEEPER_SECRET is not set (base58 secret of the feeKeeper wallet).");
    process.exit(1);
  }
  const keeper = Keypair.fromSecretKey(bs58.decode(process.env.KEEPER_SECRET.trim()));
  const conn = new Connection(RPC, "confirmed");
  const cli = new M.DynamicBondingCurveClient(conn, "confirmed");
  console.log("  keeper  " + keeper.publicKey.toBase58());
  console.log("  rpc     " + RPC + (DRY ? "   (dry run)" : ""));

  // which launches are pledged
  let jobs;
  if (process.env.MINTS) {
    jobs = process.env.MINTS.split(",").map((m) => ({ mint: m.trim(), pool: null }));
  } else {
    const j = await fetch(RECORDS).then((r) => r.json()).catch(() => ({ tokens: [] }));
    jobs = (j.tokens || []).filter((t) => (t.feeSharePct || 0) > 0 || t.feeShare === "holders");
  }
  if (!jobs.length) { console.log("  nothing pledged — done"); return; }

  const TOKEN_PROGRAM = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");

  for (const job of jobs) {
    console.log("\n  == " + job.mint);
    const mintPk = new PublicKey(job.mint);

    // the pool — recorded address preferred, derivation fallback not needed
    // here since the keeper runs with a real RPC
    let poolPk = job.pool ? new PublicKey(job.pool) : null;
    if (!poolPk) {
      const p = await cli.state.getPoolByBaseMint(mintPk);
      if (!p) { console.log("  no pool — skipped"); continue; }
      poolPk = p.publicKey;
    }
    const pool = await cli.state.getPool(poolPk);
    const state = pool.poolState || pool;
    if (String(state.creator) !== keeper.publicKey.toBase58()) {
      console.log("  keeper is not this pool's creator — not a shared launch, skipped");
      continue;
    }

    // 1. claim quote fees to the keeper (SOL arrives as lamports)
    const metrics = await cli.state.getPoolFeeMetrics(poolPk);
    const owed = BigInt(metrics.current.creatorQuoteFee.toString());
    console.log("  accrued " + owed + " lamports");
    if (owed === 0n) { console.log("  nothing to claim — skipped"); continue; }

    const before = BigInt(await conn.getBalance(keeper.publicKey));
    if (!DRY) {
      const U64MAX = "18446744073709551615";
      const tx = await cli.creator.claimCreatorTradingFeeToReceiver({
        creator: keeper.publicKey,
        payer: keeper.publicKey,
        pool: poolPk,
        receiver: keeper.publicKey,
        maxBaseAmount: new BN(U64MAX),
        maxQuoteAmount: new BN(U64MAX)
      });
      tx.feePayer = keeper.publicKey;
      tx.recentBlockhash = (await conn.getLatestBlockhash("confirmed")).blockhash;
      tx.sign(keeper);
      const sig = await conn.sendRawTransaction(tx.serialize());
      await conn.confirmTransaction(sig, "confirmed");
      console.log("  claimed  " + sig.slice(0, 20) + "…");
    }
    // distribute what actually landed, not what the metrics promised
    const after = BigInt(await conn.getBalance(keeper.publicKey));
    const claimed = DRY ? owed : (after - before);
    if (claimed <= 0n) { console.log("  claim landed nothing — skipped"); continue; }

    // the creator's kept portion goes straight back to their wallet — the
    // slider's split, honored to the lamport
    const pct = BigInt(Math.max(0, Math.min(100, job.feeSharePct || 100)));
    const potRaw = (claimed * pct) / 100n;
    const creatorCut = claimed - potRaw;
    const creatorDest = job.feeWallet || job.creator;
    if (creatorCut > 0n && creatorDest && !DRY) {
      const ctx = new Transaction().add(SystemProgram.transfer({
        fromPubkey: keeper.publicKey, toPubkey: new PublicKey(creatorDest),
        lamports: Number(creatorCut)
      }));
      ctx.feePayer = keeper.publicKey;
      ctx.recentBlockhash = (await conn.getLatestBlockhash("confirmed")).blockhash;
      ctx.sign(keeper);
      const csig = await conn.sendRawTransaction(ctx.serialize());
      await conn.confirmTransaction(csig, "confirmed");
      console.log("  creator cut " + creatorCut + " -> " + creatorDest.slice(0, 8) + "…");
    } else if (creatorCut > 0n) {
      console.log("  creator cut " + creatorCut + " -> " + (creatorDest || "?").slice(0, 8) + "… (dry)");
    }
    if (potRaw <= 0n) { console.log("  nothing pledged to holders this run"); continue; }

    // 2. snapshot holders: every token account of the mint, minus the pool's
    // own vaults and the keeper
    const accts = await conn.getProgramAccounts(TOKEN_PROGRAM, {
      filters: [{ dataSize: 165 }, { memcmp: { offset: 0, bytes: job.mint } }]
    });
    const skip = new Set([String(state.baseVault), keeper.publicKey.toBase58()]);
    const holders = [];
    let supplyHeld = 0n;
    for (const a of accts) {
      const d = a.account.data;
      const owner = new PublicKey(d.subarray(32, 64)).toBase58();
      const amount = d.readBigUInt64LE(64);
      if (amount === 0n || skip.has(owner) || skip.has(a.pubkey.toBase58())) continue;
      holders.push({ owner, amount });
      supplyHeld += amount;
    }
    console.log("  holders  " + holders.length + " holding " + supplyHeld);
    if (!holders.length) { console.log("  nobody to pay — carried forward"); continue; }

    // 3. pro-rata, dust-skipped, batched
    const pays = holders
      .map((h) => ({ owner: h.owner, lamports: (potRaw * h.amount) / supplyHeld }))
      .filter((p) => p.lamports >= BigInt(DUST_MIN_LAMPORTS));
    const paidTotal = pays.reduce((s, p) => s + p.lamports, 0n);
    console.log("  paying   " + pays.length + " holders, " + paidTotal +
      " lamports (" + (potRaw - paidTotal) + " carried as dust/remainder)");
    if (DRY) {
      pays.slice(0, 5).forEach((p) =>
        console.log("    " + p.owner.slice(0, 8) + "… <- " + p.lamports));
      continue;
    }
    for (let i = 0; i < pays.length; i += BATCH) {
      const tx = new Transaction();
      for (const p of pays.slice(i, i + BATCH)) {
        tx.add(SystemProgram.transfer({
          fromPubkey: keeper.publicKey,
          toPubkey: new PublicKey(p.owner),
          lamports: Number(p.lamports)
        }));
      }
      tx.feePayer = keeper.publicKey;
      tx.recentBlockhash = (await conn.getLatestBlockhash("confirmed")).blockhash;
      tx.sign(keeper);
      const sig = await conn.sendRawTransaction(tx.serialize());
      await conn.confirmTransaction(sig, "confirmed");
      console.log("  batch " + (i / BATCH + 1) + "  " + sig.slice(0, 20) + "…");
    }
  }
  console.log("\n  done");
})().catch((e) => { console.error("\n  FAILED — " + (e.message || e)); process.exit(1); });
