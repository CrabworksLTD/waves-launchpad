// GET /api/keeper — the fee-share run, on a schedule (vercel.json crons).
//
// For every launch pledged to holders: claim the pool's accrued creator-side
// fees (the keeper holds that authority — the launcher handed it over at
// launch, which is what makes the pledge enforceable), pay the creator their
// kept share, then split the rest across holders pro-rata.
//
// ── The ordering rule ────────────────────────────────────────────────────────
// Claiming moves money OUT of the pool and into a hot wallet. Once claimed, the
// pool reports nothing accrued, so a later failure does not retry — it strands.
// Therefore everything that can fail is done BEFORE the claim:
//
//   1. snapshot holders   (needs an RPC that allows getProgramAccounts)
//   2. check gas          (the keeper's own float, not the pot)
//   3. claim              ← the first irreversible step
//   4. persist the payout plan to KV
//   5. execute the plan, marking progress as each batch lands
//
// A crash after step 3 leaves a plan in KV, and the next run resumes it instead
// of claiming again. That is what makes this safe to run unattended.
//
// Guards worth stating:
//  - KEEPER_SECRET must be set, or the run is a no-op. It is the hot key that
//    signs payouts; without it nothing here can move funds.
//  - Its public key MUST equal BRAND.feeKeeper in brand.js, or pledged pools
//    name a creator this key cannot sign for. Reported as `keeper` in every
//    response so the two can be eyeballed.
//  - SOLANA_RPC must allow getProgramAccounts. The free public node answers
//    403 "Indexed requests require a personal token", which would fail at
//    step 1 — before any money moves, by design.
//  - CRON_SECRET (Vercel sets the Authorization header on scheduled calls)
//    keeps a public URL from triggering payout runs on demand.
//  - Everything is per-pool try/caught: one bad pool must not stop the others.

export const config = { runtime: "nodejs", maxDuration: 300 };

const RPC = process.env.SOLANA_RPC || "https://solana-rpc.publicnode.com";
const DUST_MIN_LAMPORTS = 10000n;   // below this a transfer costs more than it delivers
const BATCH = 12;                   // transfers per transaction
const LAMPORTS_PER_SIG = 5000n;
const GAS_FLOOR = 20000000n;        // 0.02 SOL — the keeper pays gas from its own
                                    // float, never out of the holders' pot
const TOKEN_PROGRAM = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const PLAN_TTL = 60 * 60 * 24 * 7;  // an unfinished plan is still worth resuming a week later

function kv() {
  return import("@upstash/redis").then(({ Redis }) => new Redis({
    url: process.env.KV_REST_API_URL,
    token: process.env.KV_REST_API_TOKEN
  }));
}

/* web3's confirmTransaction reports "block height exceeded" on transactions
 * that landed — it cost us three double-payments during launch testing. The
 * signature status is the authority. Re-broadcast while we wait, because
 * Solana also drops transactions outright. */
async function confirmed(conn, sig, raw, ms) {
  const deadline = Date.now() + (ms || 90000);
  let lastSend = Date.now();
  while (Date.now() < deadline) {
    const st = await conn.getSignatureStatus(sig, { searchTransactionHistory: true })
      .catch(() => null);
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

async function signSend(conn, tx, keeper) {
  tx.feePayer = keeper.publicKey;
  tx.recentBlockhash = (await conn.getLatestBlockhash("confirmed")).blockhash;
  tx.sign(keeper);
  const raw = tx.serialize();
  const sig = await conn.sendRawTransaction(raw, { maxRetries: 5 });
  await confirmed(conn, sig, raw);
  return sig;
}

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
  let keeperAddr = null;
  try {
    const w3 = await import("@solana/web3.js");
    const M = await import("@meteora-ag/dynamic-bonding-curve-sdk");
    const bs58 = (await import("bs58")).default;
    const BN = (await import("bn.js")).default;

    const keeper = w3.Keypair.fromSecretKey(bs58.decode(process.env.KEEPER_SECRET.trim()));
    keeperAddr = keeper.publicKey.toBase58();
    const conn = new w3.Connection(RPC, "confirmed");
    const cli = new M.DynamicBondingCurveClient(conn, "confirmed");
    const db = await kv().catch(() => null);

    const proto = req.headers["x-forwarded-proto"] || "https";
    const origin = proto + "://" + (req.headers["x-forwarded-host"] || req.headers.host);
    const j = await fetch(origin + "/api/tokens").then((r) => r.json()).catch(() => ({}));
    const jobs = (j.tokens || []).filter(
      (t) => (t.feeSharePct || 0) > 0 || t.feeShare === "holders");

    if (!jobs.length) {
      return res.status(200).json({ ok: true, keeper: keeperAddr, pledged: 0, log });
    }

    /* Fail the whole run before touching a pool if holders cannot be read.
     * Discovered the hard way: the public node 403s every indexed request, so
     * the old code claimed fees and only then found it could not distribute
     * them. Probe once, with the first job's mint. */
    try {
      await conn.getProgramAccounts(new w3.PublicKey(TOKEN_PROGRAM), {
        filters: [{ dataSize: 165 }, { memcmp: { offset: 0, bytes: jobs[0].mint } }]
      });
    } catch (e) {
      return res.status(200).json({
        ok: false, keeper: keeperAddr, pledged: jobs.length,
        blocked: "RPC refuses getProgramAccounts — set SOLANA_RPC to a node that " +
                 "allows indexed requests. No fees were claimed.",
        detail: String((e && e.message) || e).slice(0, 200)
      });
    }

    const U64MAX = "18446744073709551615";
    for (const job of jobs) {
      try {
        if (!job.pool) { log.push(job.mint + ": no recorded pool, skipped"); continue; }
        const planKey = "keeperplan:" + job.mint;

        /* Resume before claiming. A plan in KV means a previous run claimed the
         * money and did not finish handing it out; claiming again would take a
         * second helping from the pool while the first is still undelivered. */
        let plan = db ? await db.get(planKey).catch(() => null) : null;
        if (typeof plan === "string") { try { plan = JSON.parse(plan); } catch { plan = null; } }

        if (!plan) {
          const poolPk = new w3.PublicKey(job.pool);
          const pool = await cli.state.getPool(poolPk);
          const state = (pool && (pool.account || pool)) || null;
          const ps = state && (state.poolState || state);
          if (!ps) { log.push(job.mint + ": pool unreadable"); continue; }
          if (String(ps.creator) !== keeperAddr) {
            log.push(job.mint + ": pool creator is " + String(ps.creator) +
                     ", not the keeper — this launch cannot be distributed");
            continue;
          }

          const metrics = await cli.state.getPoolFeeMetrics(poolPk);
          const owed = BigInt(metrics.current.creatorQuoteFee.toString());
          if (owed === 0n) { log.push(job.mint + ": nothing accrued"); continue; }

          // ── step 1: holders, before anything irreversible ──────────────────
          const accts = await conn.getProgramAccounts(new w3.PublicKey(TOKEN_PROGRAM), {
            filters: [{ dataSize: 165 }, { memcmp: { offset: 0, bytes: job.mint } }]
          });
          const skip = new Set([String(ps.baseVault), keeperAddr]);
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
          const pct = BigInt(Math.max(0, Math.min(100,
            job.feeSharePct == null ? 100 : job.feeSharePct)));
          if (pct > 0n && (!holders.length || held === 0n)) {
            log.push(job.mint + ": no holders to pay, left in the pool");
            continue;                                   // unclaimed, so it keeps accruing
          }

          // ── step 2: gas, from the keeper's float ───────────────────────────
          const nTx = 1 + 1 + Math.ceil(holders.length / BATCH);   // claim + creator + batches
          const need = BigInt(nTx) * LAMPORTS_PER_SIG + GAS_FLOOR;
          const bal = BigInt(await conn.getBalance(keeper.publicKey));
          if (bal < need) {
            log.push(job.mint + ": keeper needs " + need + " lamports for gas, has " +
                     bal + " — left in the pool");
            continue;                                   // again: nothing claimed
          }

          // ── step 3: claim (irreversible from here) ─────────────────────────
          const before = bal;
          const tx = await cli.creator.claimCreatorTradingFeeToReceiver({
            creator: keeper.publicKey, payer: keeper.publicKey, pool: poolPk,
            receiver: keeper.publicKey,
            maxBaseAmount: new BN(U64MAX), maxQuoteAmount: new BN(U64MAX)
          });
          const claimSig = await signSend(conn, tx, keeper);

          /* What landed, not what the metrics promised — but add back the gas
           * this transaction spent, or a claim smaller than the fee reads as
           * negative and the money silently stays with the keeper. */
          const after = BigInt(await conn.getBalance(keeper.publicKey));
          const ctx2 = await conn.getTransaction(claimSig, {
            maxSupportedTransactionVersion: 0, commitment: "confirmed"
          }).catch(() => null);
          const txFee = BigInt((ctx2 && ctx2.meta && ctx2.meta.fee) || Number(LAMPORTS_PER_SIG));
          const claimed = after - before + txFee;
          if (claimed <= 0n) { log.push(job.mint + ": claim landed nothing"); continue; }

          const pot = (claimed * pct) / 100n;
          const creatorCut = claimed - pot;
          const pays = holders
            .map((h) => ({ owner: h.owner, lamports: ((pot * h.amount) / held).toString() }))
            .filter((p) => BigInt(p.lamports) >= DUST_MIN_LAMPORTS);

          // ── step 4: write the plan down before spending it ─────────────────
          plan = {
            mint: job.mint, claimSig, claimed: claimed.toString(),
            creatorCut: creatorCut.toString(),
            creatorDest: job.feeWallet || job.creator || null,
            creatorPaid: false, pays, done: 0, at: Date.now()
          };
          if (db) await db.set(planKey, JSON.stringify(plan), { ex: PLAN_TTL });
          else log.push(job.mint + ": ⚠️ no KV, a failure here cannot be resumed");
        } else {
          log.push(job.mint + ": resuming an unfinished plan from " +
                   new Date(plan.at).toISOString());
        }

        // ── step 5: execute, recording progress as it goes ───────────────────
        if (!plan.creatorPaid && BigInt(plan.creatorCut) > 0n && plan.creatorDest) {
          const t = new w3.Transaction().add(w3.SystemProgram.transfer({
            fromPubkey: keeper.publicKey, toPubkey: new w3.PublicKey(plan.creatorDest),
            lamports: Number(plan.creatorCut)
          }));
          await signSend(conn, t, keeper);
          plan.creatorPaid = true;
          if (db) await db.set(planKey, JSON.stringify(plan), { ex: PLAN_TTL });
        }

        while (plan.done < plan.pays.length) {
          const slice = plan.pays.slice(plan.done, plan.done + BATCH);
          const t = new w3.Transaction();
          for (const p of slice) {
            t.add(w3.SystemProgram.transfer({
              fromPubkey: keeper.publicKey, toPubkey: new w3.PublicKey(p.owner),
              lamports: Number(p.lamports)
            }));
          }
          await signSend(conn, t, keeper);
          plan.done += slice.length;
          if (db) await db.set(planKey, JSON.stringify(plan), { ex: PLAN_TTL });
        }

        if (db) {
          await db.del(planKey);
          // an audit trail: what was claimed, what was paid, when
          await db.lpush("keeperlog", JSON.stringify({
            mint: plan.mint, claimed: plan.claimed, creatorCut: plan.creatorCut,
            holders: plan.pays.length, claimSig: plan.claimSig, at: Date.now()
          }));
          await db.ltrim("keeperlog", 0, 499);
        }
        log.push(job.mint + ": claimed " + plan.claimed + ", paid " +
                 plan.pays.length + " holders");
      } catch (e) {
        // the plan stays in KV; the next run picks it up where it stopped
        log.push(job.mint + ": FAILED " + String((e && e.message) || e).slice(0, 160));
      }
    }
    return res.status(200).json({ ok: true, keeper: keeperAddr, pledged: jobs.length, log });
  } catch (e) {
    return res.status(500).json({
      ok: false, keeper: keeperAddr,
      error: String((e && e.message) || e).slice(0, 300), log
    });
  }
}
