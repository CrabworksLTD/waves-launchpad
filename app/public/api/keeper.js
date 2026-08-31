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

/* ── The reward-asset swap leg, when it gets built ───────────────────────────
 *
 * Creators can pick a tokenised stock or commodity for holders to be paid in.
 * That is a novelty and everyone knows it — holders sell them — but it costs
 * little and it is the thing that makes a WAVES launch look different.
 *
 * Two rules it has to respect, both learned before writing a line of it:
 *
 * 1. ROUTABILITY, CHECKED AT PAYOUT. The picker offers every verified asset,
 *    because the catalogue is the feature — a Disney-themed token paying
 *    Disney is why creators want this. 354 of the 448 have no market at all
 *    while still quoting a price, and the launch window says so on the row and
 *    on the confirm screen: holders receive the quote currency until the asset
 *    can be sold.
 *
 *    So the keeper decides, per round, from the chain and not from a list:
 *    ask Jupiter for a real quote at the pot's actual size. No route, or under
 *    REWARD_MIN_LIQUIDITY, means pay the quote currency this round and log why.
 *    An asset that becomes tradeable starts paying itself with no migration
 *    and nobody pressing anything — which is the whole point of deciding late
 *    rather than at launch.
 *
 * 2. HEADROOM. The keeper's buy is the largest single trade in the whole
 *    cycle: it buys the entire pot at once, where each holder later sells only
 *    their slice. Buying and selling back is cheap when the pool can absorb it
 *    — about 0.6%, being the two swap fees, because the impact reverses — but
 *    that stops holding once the pot is a meaningful fraction of the pool.
 *
 *    So: if pot > REWARD_HEADROOM of the asset's liquidity, pay that round in
 *    the quote currency instead and log why. A successful token should not be
 *    punished for outgrowing the asset its creator picked in week one.
 *
 * Also worth remembering: a holder receiving an asset they do not already own
 * pays ~0.002 SOL of rent to open the account. On a $2 payout that is 10% —
 * far more than any slippage — which is its own argument for paying the quote
 * currency on small pots regardless of headroom.
 */
const REWARD_HEADROOM = 0.02;      // 2% of the reward asset's liquidity
const REWARD_MIN_LIQUIDITY = 1000; // matches the picker in launchpanel.js

function kv() {
  /* No credentials means no store, not a broken one. The Upstash client
   * constructs happily without a url and then fails every command with
   * "Failed to parse URL from /pipeline", which reads like a bug in us and
   * aborted the whole job — so answer null and let callers degrade. */
  if (!process.env.KV_REST_API_URL || !process.env.KV_REST_API_TOKEN) {
    return Promise.resolve(null);
  }
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

/* A payment that can be interrupted at any instant and resumed without paying
 * twice.
 *
 * Marking a step done AFTER it lands is not enough: the rehearsal killed the
 * keeper between broadcasting the creator's transfer and recording it, and the
 * next run paid the creator a second time out of a pot that only held one
 * payment — the shortfall coming quietly out of the keeper's float.
 *
 * So the signature is written down BEFORE the transaction is broadcast. On
 * resume, a recorded signature is checked against the chain: if it landed the
 * step is simply marked done, and if it never landed the transaction is rebuilt
 * and sent. The write-then-send ordering is what makes the crash window safe —
 * the worst case is a recorded signature that was never sent, which resolves to
 * "did not land, send it".
 *
 * `slot` is the field name in the plan; `build` returns a fresh Transaction. */
async function payOnce(conn, keeper, plan, slot, build, save) {
  if (plan[slot + "Done"]) return;

  const known = plan[slot + "Sig"];
  if (known) {
    const st = await conn.getSignatureStatus(known, { searchTransactionHistory: true })
      .catch(() => null);
    const v = st && st.value;
    if (v && !v.err) {                       // it landed after all
      plan[slot + "Done"] = true;
      await save();
      return;
    }
  }

  const tx = await build();
  tx.feePayer = keeper.publicKey;
  tx.recentBlockhash = (await conn.getLatestBlockhash("confirmed")).blockhash;
  tx.sign(keeper);
  const raw = tx.serialize();

  // the signature exists as soon as it is signed — record it before it can land
  const sig = bs58encode(tx.signature);
  plan[slot + "Sig"] = sig;
  await save();

  await conn.sendRawTransaction(raw, { maxRetries: 5 });
  await confirmed(conn, sig, raw);
  plan[slot + "Done"] = true;
  await save();
}

let _bs58 = null;
function bs58encode(buf) { return _bs58.encode(buf); }

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
    _bs58 = bs58;   // payOnce encodes signatures with it
    const BN = (await import("bn.js")).default;

    const keeper = w3.Keypair.fromSecretKey(bs58.decode(process.env.KEEPER_SECRET.trim()));
    keeperAddr = keeper.publicKey.toBase58();
    const conn = new w3.Connection(RPC, "confirmed");
    const cli = new M.DynamicBondingCurveClient(conn, "confirmed");
    const db = await kv().catch(() => null);

    /* An explicit single job, instead of the live listing. This is how the
     * distribution path gets rehearsed against a local validator before it is
     * trusted with real fees — same deployed code, a pool that does not matter.
     * Behind CRON_SECRET like everything else here. */
    const q = req.query || {};
    let jobs;
    if (q.mint && q.pool) {
      jobs = [{
        mint: q.mint, pool: q.pool, symbol: q.symbol || "TEST",
        feeShare: "holders",
        feeSharePct: q.pct == null ? 100 : parseInt(q.pct, 10),
        creator: q.creator || null, feeWallet: q.feeWallet || null
      }];
      log.push("explicit job: " + q.mint);
    } else {
      const proto = req.headers["x-forwarded-proto"] || "https";
      const origin = proto + "://" + (req.headers["x-forwarded-host"] || req.headers.host);
      const j = await fetch(origin + "/api/tokens").then((r) => r.json()).catch(() => ({}));
      jobs = (j.tokens || []).filter(
        (t) => (t.feeSharePct || 0) > 0 || t.feeShare === "holders");
    }

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
            pays, done: 0, at: Date.now()
          };
          if (db) await db.set(planKey, JSON.stringify(plan), { ex: PLAN_TTL });
          else log.push(job.mint + ": ⚠️ no KV, a failure here cannot be resumed");
        } else {
          log.push(job.mint + ": resuming an unfinished plan from " +
                   new Date(plan.at).toISOString());
        }

        /* ── step 5: execute ────────────────────────────────────────────────
         * Every transfer goes through payOnce, which records its signature
         * before broadcasting so an interrupted run can ask the chain what
         * actually happened instead of assuming. */
        const save = async () => {
          if (db) await db.set(planKey, JSON.stringify(plan), { ex: PLAN_TTL });
        };

        if (BigInt(plan.creatorCut) > 0n && plan.creatorDest) {
          await payOnce(conn, keeper, plan, "creator", () =>
            new w3.Transaction().add(w3.SystemProgram.transfer({
              fromPubkey: keeper.publicKey, toPubkey: new w3.PublicKey(plan.creatorDest),
              lamports: Number(plan.creatorCut)
            })), save);
        }

        while (plan.done < plan.pays.length) {
          const at = plan.done;
          const slice = plan.pays.slice(at, at + BATCH);
          await payOnce(conn, keeper, plan, "batch" + at, () => {
            const t = new w3.Transaction();
            for (const p of slice) {
              t.add(w3.SystemProgram.transfer({
                fromPubkey: keeper.publicKey, toPubkey: new w3.PublicKey(p.owner),
                lamports: Number(p.lamports)
              }));
            }
            return t;
          }, save);
          plan.done = at + slice.length;
          await save();
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
