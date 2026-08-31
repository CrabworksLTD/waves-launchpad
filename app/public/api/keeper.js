// GET /api/keeper — the fee-share run, on a schedule (vercel.json crons).
//
// For every launch pledged to holders: claim the pool's accrued creator-side
// fees (the keeper holds that authority — the launcher handed it over at
// launch, which is what makes the pledge enforceable), pay the creator their
// kept share, then split the rest across holders pro-rata.
//
// This is tools/fee-share-keeper.js as a function so it runs without anyone
// remembering to run it. Same policy, same numbers.
//
// Guards worth stating:
//  - KEEPER_SECRET must be set, or the run is a no-op. It is the hot key that
//    signs payouts; without it nothing here can move funds, which is the
//    correct failure.
//  - CRON_SECRET (Vercel sets the Authorization header on scheduled calls)
//    keeps a public URL from triggering payouts on demand.
//  - Everything is per-pool try/caught: one bad pool must not stop the others.

export const config = { runtime: "nodejs", maxDuration: 300 };

const RPC = process.env.SOLANA_RPC || "https://solana-rpc.publicnode.com";
const DUST_MIN_LAMPORTS = 10000n;      // below this a transfer costs more than it delivers
const BATCH = 12;                      // transfers per transaction
const TOKEN_PROGRAM = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";

export default async function handler(req, res) {
  // Vercel signs scheduled invocations; a stranger hitting this URL must not
  // be able to start a payout run.
  const secret = process.env.CRON_SECRET;
  if (secret) {
    const auth = req.headers.authorization || "";
    if (auth !== "Bearer " + secret) return res.status(401).json({ error: "no" });
  }
  if (!process.env.KEEPER_SECRET) {
    return res.status(200).json({ ok: true, skipped: "KEEPER_SECRET is not set" });
  }

  const log = [];
  try {
    const w3 = await import("@solana/web3.js");
    const M = await import("@meteora-ag/dynamic-bonding-curve-sdk");
    const bs58 = (await import("bs58")).default;
    const BN = (await import("bn.js")).default;

    const keeper = w3.Keypair.fromSecretKey(bs58.decode(process.env.KEEPER_SECRET.trim()));
    const conn = new w3.Connection(RPC, "confirmed");
    const cli = new M.DynamicBondingCurveClient(conn, "confirmed");

    const proto = req.headers["x-forwarded-proto"] || "https";
    const origin = proto + "://" + (req.headers["x-forwarded-host"] || req.headers.host);
    const j = await fetch(origin + "/api/tokens").then((r) => r.json()).catch(() => ({}));
    const jobs = (j.tokens || []).filter(
      (t) => (t.feeSharePct || 0) > 0 || t.feeShare === "holders");

    if (!jobs.length) return res.status(200).json({ ok: true, pledged: 0, log });

    const U64MAX = "18446744073709551615";
    for (const job of jobs) {
      try {
        if (!job.pool) { log.push(job.mint + ": no recorded pool, skipped"); continue; }
        const poolPk = new w3.PublicKey(job.pool);
        const pool = await cli.state.getPool(poolPk);
        const state = (pool && (pool.account || pool)) || null;
        const ps = state && (state.poolState || state);
        if (!ps) { log.push(job.mint + ": pool unreadable"); continue; }
        if (String(ps.creator) !== keeper.publicKey.toBase58()) {
          log.push(job.mint + ": keeper is not this pool's creator, skipped");
          continue;
        }

        const metrics = await cli.state.getPoolFeeMetrics(poolPk);
        const owed = BigInt(metrics.current.creatorQuoteFee.toString());
        if (owed === 0n) { log.push(job.mint + ": nothing accrued"); continue; }

        const before = BigInt(await conn.getBalance(keeper.publicKey));
        const tx = await cli.creator.claimCreatorTradingFeeToReceiver({
          creator: keeper.publicKey, payer: keeper.publicKey, pool: poolPk,
          receiver: keeper.publicKey,
          maxBaseAmount: new BN(U64MAX), maxQuoteAmount: new BN(U64MAX)
        });
        tx.feePayer = keeper.publicKey;
        tx.recentBlockhash = (await conn.getLatestBlockhash("confirmed")).blockhash;
        tx.sign(keeper);
        const sig = await conn.sendRawTransaction(tx.serialize());
        await conn.confirmTransaction(sig, "confirmed");

        // distribute what actually landed, not what the metrics promised
        const after = BigInt(await conn.getBalance(keeper.publicKey));
        const claimed = after - before;
        if (claimed <= 0n) { log.push(job.mint + ": claim landed nothing"); continue; }

        const pct = BigInt(Math.max(0, Math.min(100, job.feeSharePct || 100)));
        const pot = (claimed * pct) / 100n;
        const creatorCut = claimed - pot;
        const creatorDest = job.feeWallet || job.creator;

        if (creatorCut > 0n && creatorDest) {
          const ctx = new w3.Transaction().add(w3.SystemProgram.transfer({
            fromPubkey: keeper.publicKey, toPubkey: new w3.PublicKey(creatorDest),
            lamports: Number(creatorCut)
          }));
          ctx.feePayer = keeper.publicKey;
          ctx.recentBlockhash = (await conn.getLatestBlockhash("confirmed")).blockhash;
          ctx.sign(keeper);
          await conn.confirmTransaction(
            await conn.sendRawTransaction(ctx.serialize()), "confirmed");
        }
        if (pot <= 0n) { log.push(job.mint + ": creator keeps all, nothing pledged"); continue; }

        // holders: every token account of the mint, minus the pool's own
        // vault and the keeper itself
        const accts = await conn.getProgramAccounts(new w3.PublicKey(TOKEN_PROGRAM), {
          filters: [{ dataSize: 165 }, { memcmp: { offset: 0, bytes: job.mint } }]
        });
        const skip = new Set([String(ps.baseVault), keeper.publicKey.toBase58()]);
        const holders = [];
        let held = 0n;
        for (const a of accts) {
          const d = a.account.data;
          const owner = new w3.PublicKey(d.subarray(32, 64)).toBase58();
          const amount = d.readBigUInt64LE(64);
          if (amount === 0n || skip.has(owner) || skip.has(a.pubkey.toBase58())) continue;
          holders.push({ owner, amount });
          held += amount;
        }
        if (!holders.length || held === 0n) {
          log.push(job.mint + ": no holders to pay, carried forward");
          continue;
        }

        const pays = holders
          .map((h) => ({ owner: h.owner, lamports: (pot * h.amount) / held }))
          .filter((p) => p.lamports >= DUST_MIN_LAMPORTS);
        for (let i = 0; i < pays.length; i += BATCH) {
          const t = new w3.Transaction();
          for (const p of pays.slice(i, i + BATCH)) {
            t.add(w3.SystemProgram.transfer({
              fromPubkey: keeper.publicKey, toPubkey: new w3.PublicKey(p.owner),
              lamports: Number(p.lamports)
            }));
          }
          t.feePayer = keeper.publicKey;
          t.recentBlockhash = (await conn.getLatestBlockhash("confirmed")).blockhash;
          t.sign(keeper);
          await conn.confirmTransaction(
            await conn.sendRawTransaction(t.serialize()), "confirmed");
        }
        log.push(job.mint + ": claimed " + claimed + ", paid " + pays.length + " holders");
      } catch (e) {
        log.push(job.mint + ": FAILED " + String((e && e.message) || e).slice(0, 160));
      }
    }
    return res.status(200).json({ ok: true, pledged: jobs.length, log });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String((e && e.message) || e).slice(0, 300), log });
  }
}
