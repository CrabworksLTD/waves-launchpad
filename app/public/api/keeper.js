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

/* ── The reward-asset swap leg ───────────────────────────────────────────────
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
 * 3. ACCOUNT RENT. A holder receiving an asset they do not already own pays
 *    ~0.002 SOL for an account to hold it, funded by the keeper. On a small pot
 *    that is most of the payout, so the swap is skipped when rent would exceed
 *    10% of the pot — holders would rather have the quote currency than a dust
 *    position that cost more to create than it holds.
 *
 * Also worth remembering: a holder receiving an asset they do not already own
 * pays ~0.002 SOL of rent to open the account. On a $2 payout that is 10% —
 * far more than any slippage — which is its own argument for paying the quote
 * currency on small pots regardless of headroom.
 */
const REWARD_HEADROOM = 0.02;      // 2% of the reward asset's liquidity
const REWARD_MIN_LIQUIDITY = 1000; // matches the picker in launchpanel.js
const REWARD_SLIPPAGE_BPS = 150;   // 1.5% — these are thin books, not majors
const ATA_RENT_LAMPORTS = 2040000n; // what a holder's new token account costs

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

async function signSend(conn, tx, keeper, extra) {
  tx.feePayer = keeper.publicKey;
  tx.recentBlockhash = (await conn.getLatestBlockhash("confirmed")).blockhash;
  // the keeper always pays; `extra` is any additional required signer, which
  // for a partner claim is the claim key — it authorises, it does not fund
  tx.sign.apply(tx, extra ? [keeper, extra] : [keeper]);
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


/* ── The reward swap ─────────────────────────────────────────────────────────
 *
 * Claimed fees arrive in the pool's quote currency. A creator who chose a
 * reward asset wants their holders paid in THAT, so the keeper buys it before
 * distributing. Everything below decides whether doing so is actually in the
 * holders' interest, and pays the quote currency when it is not.
 *
 * ⚠️ This is the one part of the keeper that cannot be rehearsed on a local
 * validator: Jupiter does not exist there. It has to be proven on mainnet with
 * a small pot.
 */

// Jupiter, with the same plain-text-429 handling the indexer needs
async function jup(path) {
  for (let i = 0; i < 4; i++) {
    const r = await fetch("https://lite-api.jup.ag" + path);
    const text = await r.text();
    try { return JSON.parse(text); } catch (e) { /* rate limited */ }
    await new Promise((s) => setTimeout(s, 500 * (i + 1)));
  }
  return null;
}

/* Would swapping actually serve the holders? Four ways the answer is no, each
 * of which pays the quote currency instead — that is a real payout in an asset
 * every wallet already holds, not a failure. */
async function rewardPlan(rewardMint, quoteMint, potLamports, quoteDecimals, holders) {
  if (!rewardMint || rewardMint === quoteMint) return null;

  const price = await jup("/price/v3?ids=" + rewardMint);
  const info = price && price[rewardMint];
  const liquidity = (info && info.liquidity) || 0;
  if (liquidity < REWARD_MIN_LIQUIDITY) {
    return { skip: "nothing trades " + rewardMint.slice(0, 6) + "… yet" };
  }

  /* Headroom. The keeper buys the whole pot at once, where each holder later
   * sells only a slice, so the keeper is the largest trade in the cycle. Above
   * a couple of percent of the pool the holders are paying for our impact. */
  const potUsd = (Number(potLamports) / Math.pow(10, quoteDecimals)) *
    ((await jup("/price/v3?ids=" + quoteMint))?.[quoteMint]?.usdPrice || 0);
  if (potUsd > liquidity * REWARD_HEADROOM) {
    return { skip: "pot is " + (potUsd / liquidity * 100).toFixed(1) +
      "% of that asset's liquidity — too big to buy without moving it" };
  }

  /* Account rent. A holder receiving an asset they do not already own pays for
   * an account to hold it — about 0.002 SOL, which the keeper funds. On a small
   * pot that overhead is most of the payout, and holders would rather have the
   * quote currency than a dust position that cost more to create than it holds. */
  const rentCost = Number(ATA_RENT_LAMPORTS) * holders;
  if (rentCost > Number(potLamports) * 0.1) {
    return { skip: "account rent for " + holders + " holders would eat more than " +
      "10% of the pot" };
  }

  const quote = await jup("/swap/v1/quote?inputMint=" + quoteMint +
    "&outputMint=" + rewardMint + "&amount=" + potLamports.toString() +
    "&slippageBps=" + REWARD_SLIPPAGE_BPS);
  if (!quote || quote.error || !quote.outAmount) {
    return { skip: "no route to " + rewardMint.slice(0, 6) + "…" };
  }
  return { quote, liquidity };
}


/* Execute the swap Jupiter quoted, signing with the keeper. Returns how much of
 * the reward asset actually arrived — measured from the keeper's own balance,
 * not from the quote, because a quote is a promise and slippage is real.
 *
 * ⚠️ The DELTA, not the balance.
 *
 * This used to report the keeper's whole balance of the reward mint. With one
 * token paying rewards in a given asset that is harmless, and it even papered
 * over a crash by sweeping what an earlier run had left behind. With two, it is
 * theft: the keeper holds one ATA per asset, not per token, so the first
 * token's payout would hand its holders everything the second token had bought.
 *
 * Leftovers are no longer swept implicitly. They do not need to be — the plan
 * is written the moment the swap lands, so an interrupted run resumes and pays
 * exactly what it bought. */
async function doSwap(conn, w3, keeper, quote, rewardMint, splToken) {
  const built = await fetch("https://lite-api.jup.ag/swap/v1/swap", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      quoteResponse: quote,
      userPublicKey: keeper.publicKey.toBase58(),
      wrapAndUnwrapSol: true,
      dynamicComputeUnitLimit: true
    })
  }).then((r) => r.json());
  if (!built || !built.swapTransaction) throw new Error("Jupiter returned no transaction");

  /* Read the balance BEFORE sending, so the arrival can be measured rather than
   * assumed. A missing account reads as zero, which is what it holds. */
  const ataPre = splToken.getAssociatedTokenAddressSync(
    new w3.PublicKey(rewardMint), keeper.publicKey, true,
    await tokenProgramOf(conn, w3, rewardMint, splToken));
  const preBal = await conn.getTokenAccountBalance(ataPre).catch(() => null);
  const before = BigInt((preBal && preBal.value && preBal.value.amount) || "0");

  const raw = Buffer.from(built.swapTransaction, "base64");
  const tx = w3.VersionedTransaction.deserialize(raw);
  tx.sign([keeper]);
  const bytes = tx.serialize();
  const sig = await conn.sendRawTransaction(bytes, { maxRetries: 5 });
  await confirmed(conn, sig, bytes, 120000);

  /* Reading a delta is racier than reading a balance: a confirmed transaction
   * whose account state has not propagated to the node we happen to ask reads
   * as "nothing arrived", and the caller would then treat a spent pot as a
   * failed swap. Ask again a few times before believing a zero. */
  let bal = null, after = before, gained = 0n;
  for (let i = 0; i < 6; i++) {
    bal = await conn.getTokenAccountBalance(ataPre).catch(() => null);
    after = BigInt((bal && bal.value && bal.value.amount) || "0");
    gained = after > before ? after - before : 0n;
    if (gained > 0n) break;
    await new Promise((r) => setTimeout(r, 700));
  }
  return { sig, amount: gained,
           decimals: (bal && bal.value && bal.value.decimals) || 0 };
}

/* Which token program owns a mint. Nearly every tokenised stock is Token-2022,
 * and using the classic program's addresses for one derives an account that
 * does not exist. */
async function tokenProgramOf(conn, w3, mint, splToken) {
  const info = await conn.getAccountInfo(new w3.PublicKey(mint)).catch(() => null);
  return info && info.owner && info.owner.toBase58() === splToken.TOKEN_2022_PROGRAM_ID.toBase58()
    ? splToken.TOKEN_2022_PROGRAM_ID : splToken.TOKEN_PROGRAM_ID;
}


/* The pool's quote currency and its decimals.
 *
 * Needed to size a swap, and neither is on the pool account — the mint is on
 * the config, and the decimals are on the mint. Read once per pool per run.
 * Defaults to SOL's 9, which is right for the common case and harmless as a
 * fallback because a wrong decimals only mis-sizes the USD comparison, which
 * then fails the headroom check and pays the quote currency. */
async function quoteInfo(conn, w3, cli, ps) {
  let mint = ps && ps.quoteMint ? String(ps.quoteMint) : null;
  if (!mint) {
    const cfgKey = ps && (ps.config || ps.poolConfig);
    if (cfgKey) {
      const cfg = await cli.state.getPoolConfig(new w3.PublicKey(String(cfgKey)))
        .catch(() => null);
      if (cfg && cfg.quoteMint) mint = String(cfg.quoteMint);
    }
  }
  if (!mint) return { mint: null, decimals: 9 };
  const info = await conn.getAccountInfo(new w3.PublicKey(mint)).catch(() => null);
  const decimals = info && info.data && info.data.length > 44 ? info.data[44] : 9;
  return { mint, decimals };
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
  const U64MAX = "18446744073709551615";
  let keeperAddr = null;
  try {
    const w3 = await import("@solana/web3.js");
    const M = await import("@meteora-ag/dynamic-bonding-curve-sdk");
    const bs58 = (await import("bs58")).default;
    const splToken = await import("@solana/spl-token");
    _bs58 = bs58;   // payOnce encodes signatures with it
    const BN = (await import("bn.js")).default;

    const keeper = w3.Keypair.fromSecretKey(bs58.decode(process.env.KEEPER_SECRET.trim()));
    keeperAddr = keeper.publicKey.toBase58();
    const conn = new w3.Connection(RPC, "confirmed");
    const cli = new M.DynamicBondingCurveClient(conn, "confirmed");
    const db = await kv().catch(() => null);

    // declared before both the platform sweep and the pledged-job list, which
    // each fetch the records through it
    const proto = req.headers["x-forwarded-proto"] || "https";
    const origin = proto + "://" + (req.headers["x-forwarded-host"] || req.headers.host);

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
      /* Straight from KV, not from our own HTTP API. The self-fetch has
       * returned nothing at least twice — and here that means every pledged
       * launch is silently skipped and holders do not get paid, while the run
       * reports success with "pledged: 0". A failure now says so. */
      let all = [];
      try {
        const raw = await db.lrange("tokens", 0, 199);
        all = (raw || []).map((r) => (typeof r === "string" ? JSON.parse(r) : r)).filter(Boolean);
      } catch (e) {
        log.push("could not read the launch list: " + String((e && e.message) || e).slice(0, 80));
      }
      jobs = all.filter((t) => (t.feeSharePct || 0) > 0 || t.feeShare === "holders");
    }

    /* The platform's own revenue, swept before anything else.
     *
     * Partner fees accrue inside each pool and move only when the config's
     * feeClaimer signs — they do not arrive on their own, and 0.74 SOL sat in
     * the $MOAR pool until someone noticed. The claimer is a dedicated hot key
     * (PARTNER_CLAIMER_SECRET), never the treasury: it can trigger a claim and
     * nothing else, and the receiver is always FEE_TO, so a compromise costs
     * at most an hour of unclaimed fees rather than the balance.
     *
     * ⚠️ Only works on pools whose config was created naming that claimer. A
     * config's feeClaimer is fixed at creation, so pools on the original
     * configs (which name the treasury) still have to be claimed by hand at
     * /fees — that page is the creator-facing tool and stays as it is.
     */
    if (process.env.PARTNER_CLAIMER_SECRET && process.env.FEE_TO) {
      try {
        const claimer = w3.Keypair.fromSecretKey(
          bs58.decode(process.env.PARTNER_CLAIMER_SECRET.trim()));
        const rawAll = await db.lrange("tokens", 0, 199).catch(() => []);
        const allToks = (rawAll || [])
          .map((r) => (typeof r === "string" ? JSON.parse(r) : r)).filter(Boolean);
        for (const t of allToks) {
          if (!t.pool) continue;
          try {
            const p = new w3.PublicKey(t.pool);

            /* Only pools whose config actually names our claim key. A config's
             * feeClaimer is fixed at creation, so pools launched before the
             * claim key existed name the treasury and can only ever be claimed
             * by hand. Attempting them anyway produced a failed simulation in
             * the log every single run, which is noise that hides real
             * problems. */
            const poolState = await cli.state.getPool(p);
            const psx = (poolState && (poolState.account || poolState)) || {};
            const ps2 = psx.poolState || psx;
            const cfgKey = ps2.config || ps2.poolConfig;
            if (!cfgKey) continue;
            const cfg = await cli.state.getPoolConfig(new w3.PublicKey(String(cfgKey)));
            if (!cfg || String(cfg.feeClaimer) !== claimer.publicKey.toBase58()) continue;

            const m = await cli.state.getPoolFeeMetrics(p);
            const owed = BigInt(m.current.partnerQuoteFee.toString());
            if (owed === 0n) continue;
            /* The keeper pays, the claimer authorises. Otherwise the claim key
             * needs its own SOL float and someone has to remember to top it up
             * — and the first sweep failed for exactly that, with "attempt to
             * debit an account but found no record of a prior credit". Keeping
             * the claim key balanceless is also the point: it can authorise a
             * claim and nothing else. */
            const tx = await cli.partner.claimPartnerTradingFeeToReceiver({
              feeClaimer: claimer.publicKey,
              payer: keeper.publicKey,
              pool: p,
              receiver: new w3.PublicKey(process.env.FEE_TO),
              maxBaseAmount: new BN(U64MAX), maxQuoteAmount: new BN(U64MAX)
            });
            await signSend(conn, tx, keeper, claimer);
            log.push("platform: claimed " + owed + " from " + (t.symbol || t.mint));
          } catch (e) {
            // a config that names the treasury refuses this signer — expected
            // for pools created before the claimer existed, so keep it quiet
            const msg = String((e && e.message) || e);
            if (!/signature|unauthor|constraint/i.test(msg)) {
              log.push("platform: " + (t.symbol || t.mint) + " — " + msg.slice(0, 90));
            }
          }
        }
      } catch (e) {
        log.push("platform sweep failed: " + String((e && e.message) || e).slice(0, 120));
      }
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
          /* `let`, because a successful swap re-cuts these in the reward asset
           * below. As a const it threw "Assignment to constant variable" AFTER
           * the swap had already spent the pot — the first time this leg ever
           * ran, it bought the reward and then could not pay anyone. */
          let pays = holders
            .map((h) => ({ owner: h.owner, lamports: ((pot * h.amount) / held).toString() }))
            .filter((p) => BigInt(p.lamports) >= DUST_MIN_LAMPORTS);

          /* ── the reward asset, if the creator chose one and it makes sense ──
           *
           * Only the holders' pot is swapped. The creator's kept share stays in
           * the quote currency — they chose what their HOLDERS are paid in, not
           * what they are. Any reason not to swap pays the quote currency and
           * says why, which is a real payout rather than a failure. */
          let reward = null;
          if (job.rewardMint && pot > 0n && pays.length) {
            const qi = await quoteInfo(conn, w3, cli, ps);
            const decision = await rewardPlan(
              job.rewardMint, qi.mint, pot, qi.decimals, pays.length);
            if (decision && decision.skip) {
              log.push(job.mint + ": paying " + (job.quote || "the quote currency") +
                       " — " + decision.skip);
            } else if (decision && decision.quote) {
              try {
                const got = await doSwap(conn, w3, keeper, decision.quote,
                                         job.rewardMint, splToken);
                if (got.amount > 0n) {
                  reward = { mint: job.rewardMint, amount: got.amount.toString(),
                             decimals: got.decimals, swapSig: got.sig };
                  log.push(job.mint + ": swapped the pot into " +
                           job.rewardMint.slice(0, 6) + "… (" + got.sig.slice(0, 12) + "…)");
                  /* Write it down NOW.
                   *
                   * The plan is normally persisted a few steps below, after the
                   * shares are re-cut — but by this line the pot is already
                   * spent, and anything that throws between here and there
                   * leaves reward tokens in the keeper with nothing recording
                   * who they belong to. That is exactly what happened the first
                   * time this ran. A plan written here is resumable; one
                   * written after is a promise that the swap will not be the
                   * last thing to succeed. */
                  if (db) {
                    await db.set(planKey, JSON.stringify({
                      mint: job.mint, claimSig, claimed: claimed.toString(),
                      creatorCut: creatorCut.toString(),
                      creatorDest: job.feeWallet || job.creator || null,
                      reward: got, pays: [], done: 0, at: Date.now(), partial: true
                    }), { ex: PLAN_TTL });
                  }
                }
              } catch (e) {
                // the pot is still in the quote currency and still gets paid out
                log.push(job.mint + ": swap failed, paying the quote currency — " +
                         String((e && e.message) || e).slice(0, 90));
              }
            }
          }

          /* Re-cut the shares in the asset actually held. Percentages come from
           * the token balances already read, so this is the same split. */
          if (reward) {
            const total = BigInt(reward.amount);
            let assigned = 0n;
            pays = holders
              .map((h) => {
                const share = (total * h.amount) / held;
                assigned += share;
                return { owner: h.owner, amount: share.toString() };
              })
              .filter((p) => BigInt(p.amount) > 0n);
          }

          // ── step 4: write the plan down before spending it ─────────────────
          plan = {
            mint: job.mint, claimSig, claimed: claimed.toString(),
            creatorCut: creatorCut.toString(),
            creatorDest: job.feeWallet || job.creator || null,
            reward,
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

        /* Paying in a token is not paying in SOL: each holder needs an account
         * for that mint, which the keeper creates and funds. Fewer per
         * transaction, because an account creation is far bigger than a
         * lamport transfer. */
        const rewardPay = plan.reward || null;
        let tokenProgram = null, rewardPk = null;
        if (rewardPay) {
          rewardPk = new w3.PublicKey(rewardPay.mint);
          tokenProgram = await tokenProgramOf(conn, w3, rewardPay.mint, splToken);
        }
        const batchSize = rewardPay ? 5 : BATCH;

        while (plan.done < plan.pays.length) {
          const at = plan.done;
          const slice = plan.pays.slice(at, at + batchSize);
          await payOnce(conn, keeper, plan, "batch" + at, () => {
            const t = new w3.Transaction();
            if (rewardPay) {
              const from = splToken.getAssociatedTokenAddressSync(
                rewardPk, keeper.publicKey, true, tokenProgram);
              for (const p of slice) {
                const owner = new w3.PublicKey(p.owner);
                const to = splToken.getAssociatedTokenAddressSync(
                  rewardPk, owner, true, tokenProgram);
                // idempotent: a holder who already owns the asset keeps theirs,
                // and a re-run after a crash cannot fail on "already exists"
                t.add(splToken.createAssociatedTokenAccountIdempotentInstruction(
                  keeper.publicKey, to, owner, rewardPk, tokenProgram));
                /* transferChecked, not transfer: Token-2022 mints carrying a
                 * TransferFeeConfig reject the unchecked instruction, and 49 of
                 * the 50 most liquid tokenised assets are Token-2022. It also
                 * makes the transfer assert the mint's decimals, which is a
                 * free guard against paying the right number in the wrong
                 * units. */
                t.add(splToken.createTransferCheckedInstruction(
                  from, rewardPk, to, keeper.publicKey,
                  BigInt(p.amount), rewardPay.decimals, [], tokenProgram));
              }
            } else {
              for (const p of slice) {
                t.add(w3.SystemProgram.transfer({
                  fromPubkey: keeper.publicKey, toPubkey: new w3.PublicKey(p.owner),
                  lamports: Number(p.lamports)
                }));
              }
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
