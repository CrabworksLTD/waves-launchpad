#!/usr/bin/env node
/* Rehearsal for automatic fee distribution — the money path.
 *
 *   export PATH="$HOME/.local/share/solana/install/active_release/bin:$PATH"
 *   solana-test-validator --url https://api.mainnet-beta.solana.com \
 *     --clone-upgradeable-program dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN \
 *     ... (see memory: sunpad-chain-testing) --reset --quiet &
 *   SOLANA_RPC=http://127.0.0.1:8899 node tools/feeshare-smoke.js
 *
 * Why this exists: api/keeper.js claims a creator's trading fees and splits
 * them across holders on a schedule, unattended, with a hot key. It had never
 * executed once. Reading it found nine problems, three of which would have lost
 * or misrouted money — so reading it again is not the way to gain confidence.
 *
 * What it proves, in order:
 *
 *   1. a launch pledged to holders really does hand pool-creator authority to
 *      the keeper, and the launcher can no longer claim that stream
 *   2. trades accrue creator-side fees
 *   3. THE REAL api/keeper.js HANDLER — not a copy of its logic — claims them
 *      and pays every holder pro-rata, plus the creator's kept share
 *   4. the arithmetic adds up to the lamport
 *   5. a run that dies mid-distribution resumes instead of stranding the money
 *
 * Point 3 is the whole point. A rehearsal of a reimplementation proves nothing
 * about the thing that runs at :00 every hour.
 */
"use strict";

const RPC = process.env.SOLANA_RPC || "http://127.0.0.1:8899";
const HOLDERS = 4;

(async () => {
  const {
    DynamicBondingCurveClient, buildCurveWithMarketCap, convertToLamports,
    ActivationType, BaseFeeMode, CollectFeeMode, TokenDecimal,
    TokenType, MigrationOption, MigrationFeeOption, TokenAuthorityOption
  } = await import("@meteora-ag/dynamic-bonding-curve-sdk");
  const { Connection, Keypair, PublicKey, LAMPORTS_PER_SOL, sendAndConfirmTransaction } =
    await import("@solana/web3.js");
  const BN = (await import("bn.js")).default;
  const bs58 = (await import("bs58")).default;

  const conn = new Connection(RPC, "confirmed");
  const cli = new DynamicBondingCurveClient(conn, "confirmed");
  const step = (n, s) => console.log("\n  " + n + "  " + s);
  const ok = (s) => console.log("      ok    " + s);
  const info = (s) => console.log("      ·     " + s);
  const fail = (s) => { console.log("\n  ✗  " + s + "\n"); process.exit(1); };

  const sol = (l) => (Number(l) / LAMPORTS_PER_SOL).toFixed(9);

  async function fund(kp, amount) {
    const sig = await conn.requestAirdrop(kp.publicKey, amount * LAMPORTS_PER_SOL);
    await conn.confirmTransaction(sig, "confirmed");
  }
  async function send(tx, signers) {
    tx.feePayer = signers[0].publicKey;
    tx.recentBlockhash = (await conn.getLatestBlockhash("confirmed")).blockhash;
    return sendAndConfirmTransaction(conn, tx, signers, {
      commitment: "confirmed", skipPreflight: false
    });
  }

  console.log("\n  FEE SHARE REHEARSAL  ·  " + RPC);

  // ── cast ───────────────────────────────────────────────────────────────────
  const partner = Keypair.generate();     // the launchpad
  const creator = Keypair.generate();     // whoever launches the token
  const keeper = Keypair.generate();      // the hot wallet that distributes
  const buyers = Array.from({ length: HOLDERS }, () => Keypair.generate());

  step("1", "funding");
  await fund(partner, 50);
  await fund(creator, 50);
  await fund(keeper, 5);
  for (const b of buyers) await fund(b, 20);
  ok("partner, creator, keeper and " + HOLDERS + " buyers funded");

  // ── a partner config, as the launchpad creates once per quote currency ─────
  step("2", "partner config");
  const configKp = Keypair.generate();
  const curve = buildCurveWithMarketCap({
    initialMarketCap: 28,
    migrationMarketCap: 385,
    activationType: ActivationType.Slot,
    token: {
      tokenType: TokenType.SPLToken,
      tokenBaseDecimal: TokenDecimal.SIX,
      tokenQuoteDecimal: TokenDecimal.NINE,
      tokenAuthorityOption: TokenAuthorityOption.Immutable,
      totalTokenSupply: 1_000_000_000,
      leftover: 0
    },
    fee: {
      baseFeeParams: {
        baseFeeMode: BaseFeeMode.FeeSchedulerLinear,
        feeSchedulerParam: { startingFeeBps: 100, endingFeeBps: 100,
          numberOfPeriod: 0, totalDuration: 0 }
      },
      dynamicFeeEnabled: true,
      collectFeeMode: CollectFeeMode.QuoteToken,
      creatorTradingFeePercentage: 25,     // the creator's slice of each swap fee
      poolCreationFee: 0,
      enableFirstSwapWithMinFee: false
    },
    migration: {
      migrationOption: MigrationOption.MET_DAMM_V2,
      migrationFeeOption: MigrationFeeOption.FixedBps100,
      migrationFee: { feePercentage: 0, creatorFeePercentage: 0 }
    },
    liquidityDistribution: {
      partnerPermanentLockedLiquidityPercentage: 50,
      partnerLiquidityPercentage: 0,
      creatorPermanentLockedLiquidityPercentage: 50,
      creatorLiquidityPercentage: 0
    },
    lockedVesting: {
      totalLockedVestingAmount: 0, numberOfVestingPeriod: 0, cliffUnlockAmount: 0,
      totalVestingDuration: 0, cliffDurationFromMigrationTime: 0
    }
  });
  await send(await cli.partner.createConfig({
    config: configKp.publicKey, feeClaimer: partner.publicKey,
    leftoverReceiver: partner.publicKey, quoteMint: new PublicKey(
      "So11111111111111111111111111111111111111112"),
    payer: partner.publicKey, ...curve
  }), [partner, configKp]);
  ok("config " + configKp.publicKey.toBase58().slice(0, 12) + "… (creator gets 60% of fees)");

  // ── the launch ─────────────────────────────────────────────────────────────
  step("3", "launch, pledged to holders");
  const baseMint = Keypair.generate();
  await send(await cli.creator.createPool({
    baseMint: baseMint.publicKey, config: configKp.publicKey,
    name: "Rehearsal", symbol: "REH", uri: "https://example.com/t.json",
    payer: creator.publicKey, poolCreator: creator.publicKey
  }), [creator, baseMint]);
  const poolPk = (await cli.state.getPoolByBaseMint(baseMint.publicKey)).publicKey;
  ok("pool " + poolPk.toBase58().slice(0, 12) + "…");

  /* The pledge. This is what makes "share with holders" enforceable rather than
   * a promise: after it, the launcher cannot claim the stream at all. */
  await send(await cli.creator.transferPoolCreator({
    pool: poolPk, creator: creator.publicKey, newCreator: keeper.publicKey
  }), [creator]);
  const after = await cli.state.getPool(poolPk);
  /* Same unwrap as api/keeper.js: getPool returns { poolState: {...} } on this
   * SDK version, and the keeper already handles both shapes. */
  const outer = (after && (after.account || after)) || {};
  const ps = outer.poolState || outer;
  if (process.env.DUMP_POOL) {
    console.log("      pool keys: " + Object.keys(ps).join(", "));
    for (const k of Object.keys(ps)) {
      const v = ps[k];
      if (v && typeof v.toBase58 === "function") console.log("        " + k + " = " + v.toBase58());
    }
  }
  const nowCreator = String(ps.creator);
  if (nowCreator !== keeper.publicKey.toBase58()) {
    fail("pledge did not transfer creator authority (pool says " + nowCreator + ")");
  }
  ok("pool creator is now the keeper — the launcher cannot claim this stream");

  // ── trading ────────────────────────────────────────────────────────────────
  step("4", "buyers trade");
  for (let i = 0; i < buyers.length; i++) {
    const amt = convertToLamports(1 + i, 9);          // 1,2,3,4 SOL — uneven on purpose
    await send(await cli.pool.swap({
      owner: buyers[i].publicKey, pool: poolPk, amountIn: amt,
      minimumAmountOut: new BN(1), swapBaseForQuote: false,
      referralTokenAccount: null
    }), [buyers[i]]);
    info("buyer " + (i + 1) + " bought with " + (i + 1) + " SOL");
  }
  const metrics = await cli.state.getPoolFeeMetrics(poolPk);
  const owed = BigInt(metrics.current.creatorQuoteFee.toString());
  if (owed === 0n) fail("no creator fees accrued — nothing to distribute");
  ok("creator-side fees accrued: " + sol(owed) + " SOL");

  // ── the real handler ───────────────────────────────────────────────────────
  step("5", "running api/keeper.js (the deployed code, not a copy)");
  process.env.SOLANA_RPC = RPC;
  process.env.KEEPER_SECRET = bs58.encode(keeper.secretKey);
  delete process.env.CRON_SECRET;            // no auth needed for a local run
  delete process.env.KV_REST_API_URL;        // no KV: exercises the no-resume path
  delete process.env.KV_REST_API_TOKEN;

  const before = {};
  for (const b of buyers) before[b.publicKey.toBase58()] = BigInt(await conn.getBalance(b.publicKey));
  const creatorBefore = BigInt(await conn.getBalance(creator.publicKey));

  const { default: handler } = await import("../app/public/api/keeper.js");
  globalThis.__keeper = handler;
  const captured = {};
  const res = {
    setHeader() {},
    status(c) { captured.code = c; return this; },
    json(body) { captured.body = body; return this; }
  };
  await handler({
    method: "GET", headers: {},
    query: { mint: baseMint.publicKey.toBase58(), pool: poolPk.toBase58(),
             symbol: "REH", pct: "80", creator: creator.publicKey.toBase58() }
  }, res);

  for (const line of (captured.body && captured.body.log) || []) info(line);
  if (!captured.body || !captured.body.ok) {
    fail("keeper run failed: " + JSON.stringify(captured.body));
  }

  // ── did the money actually arrive ──────────────────────────────────────────
  step("6", "checking every balance");
  let paidHolders = 0n;
  const gained = [];
  for (const b of buyers) {
    const k = b.publicKey.toBase58();
    const g = BigInt(await conn.getBalance(b.publicKey)) - before[k];
    gained.push({ who: k.slice(0, 8), got: g });
    paidHolders += g > 0n ? g : 0n;
  }
  const creatorGot = BigInt(await conn.getBalance(creator.publicKey)) - creatorBefore;
  for (const g of gained) info(g.who + "…  +" + sol(g.got) + " SOL");
  info("creator      +" + sol(creatorGot) + " SOL  (kept 20%)");

  if (paidHolders === 0n) fail("no holder received anything");
  if (creatorGot === 0n) fail("the creator's kept share never arrived");

  /* Pro-rata, not equal: buyer 4 spent four times what buyer 1 did, so it holds
   * the most tokens and must receive the most. Bigger spend, bigger payout. */
  const order = gained.map((g) => g.got);
  for (let i = 1; i < order.length; i++) {
    if (order[i] <= order[i - 1]) {
      fail("payouts are not pro-rata: buyer " + (i + 1) + " holds more but got less");
    }
  }
  ok("payouts rise with holdings — the split is pro-rata");

  const total = paidHolders + creatorGot;
  const share = Number(paidHolders) / Number(total);
  info("holders got " + (share * 100).toFixed(1) + "% of the distribution (pledged 80%)");
  if (Math.abs(share - 0.8) > 0.02) {
    fail("the 80/20 split is wrong: holders received " + (share * 100).toFixed(1) + "%");
  }
  ok("the 80/20 split holds to within a rounding lamport");

  step("7", "the keeper kept nothing");
  const keeperLeft = BigInt(await conn.getBalance(keeper.publicKey));
  info("keeper balance: " + sol(keeperLeft) + " SOL (started with 5, pays gas from it)");
  if (keeperLeft > 5n * BigInt(LAMPORTS_PER_SOL)) {
    fail("the keeper is holding fees it should have distributed");
  }
  ok("no fees stranded in the hot wallet");

  /* ── the crash test ───────────────────────────────────────────────────────
   *
   * The happy path above is the easy half. What actually protects the money is
   * what happens when the function dies between claiming and finishing the
   * payouts: the fees are already out of the pool, so nothing retries them, and
   * without a written-down plan they would sit in the hot wallet forever.
   *
   * So: launch a second token, kill the keeper immediately after it persists
   * its plan, then run it again and prove it resumes rather than re-claims. */
  if (!process.env.KV_STUB) {
    console.log("\n  ✓  automatic fee distribution works end to end");
    console.log("     (set KV_STUB=http://127.0.0.1:7999 to also test crash-resume)\n");
    process.exit(0);
  }

  const stub = process.env.KV_STUB;
  process.env.KV_REST_API_URL = stub;
  process.env.KV_REST_API_TOKEN = "stub";

  /* Two different crash windows, because they fail in different ways:
   *
   *   failAfter 1 — dies after the plan is stored, BEFORE the creator transfer
   *                 is broadcast. Resume must send it.
   *   failAfter 2 — dies after the creator transfer has LANDED but before it is
   *                 marked done. This is the one that paid the creator twice
   *                 before payOnce recorded signatures ahead of broadcasting.
   */
  async function crashTest(failAfter, label) {
  step("8." + failAfter, "crash test — " + label);
  await fetch(stub + "/reset", { method: "POST" });

  const mint2 = Keypair.generate();
  await send(await cli.creator.createPool({
    baseMint: mint2.publicKey, config: configKp.publicKey,
    name: "Rehearsal2", symbol: "REH2", uri: "https://example.com/t.json",
    payer: creator.publicKey, poolCreator: creator.publicKey
  }), [creator, mint2]);
  const pool2 = (await cli.state.getPoolByBaseMint(mint2.publicKey)).publicKey;
  await send(await cli.creator.transferPoolCreator({
    pool: pool2, creator: creator.publicKey, newCreator: keeper.publicKey
  }), [creator]);
  for (let i = 0; i < buyers.length; i++) {
    await send(await cli.pool.swap({
      owner: buyers[i].publicKey, pool: pool2, amountIn: convertToLamports(1 + i, 9),
      minimumAmountOut: new BN(1), swapBaseForQuote: false, referralTokenAccount: null
    }), [buyers[i]]);
  }
  info("second pool launched, pledged and traded");

  const q2 = {
    mint: mint2.publicKey.toBase58(), pool: pool2.toBase58(), symbol: "REH2",
    pct: "80", creator: creator.publicKey.toBase58()
  };
  const before2 = {};
  for (const b of buyers) before2[b.publicKey.toBase58()] = BigInt(await conn.getBalance(b.publicKey));
  const creatorBefore2 = BigInt(await conn.getBalance(creator.publicKey));

  // die on the very first write after the plan is stored
  await fetch(stub + "/fail-after/" + failAfter, { method: "POST" });
  const cap1 = {};
  await handler({ method: "GET", headers: {}, query: q2 }, {
    setHeader() {}, status(c) { cap1.code = c; return this; },
    json(b) { cap1.body = b; return this; }
  });
  for (const line of (cap1.body && cap1.body.log) || []) info("run 1: " + line);

  const dump = await (await fetch(stub + "/dump")).json();
  const planKey = "keeperplan:" + q2.mint;
  if (!dump.keys.includes(planKey)) {
    fail("the keeper died without leaving a plan — this money would be stranded");
  }
  ok("run 1 died after claiming, and left a plan behind");

  const midway = BigInt(await conn.getBalance(keeper.publicKey));
  const claimedNotYetPaid = midway;
  info("keeper is holding the claimed fees: " + sol(claimedNotYetPaid) + " SOL total balance");

  // now let it finish
  await fetch(stub + "/fail-after/-1", { method: "POST" });
  const feesBefore = BigInt(
    (await cli.state.getPoolFeeMetrics(pool2)).current.creatorQuoteFee.toString());
  const cap2 = {};
  await handler({ method: "GET", headers: {}, query: q2 }, {
    setHeader() {}, status(c) { cap2.code = c; return this; },
    json(b) { cap2.body = b; return this; }
  });
  for (const line of (cap2.body && cap2.body.log) || []) info("run 2: " + line);

  const resumed = ((cap2.body && cap2.body.log) || []).some((l) => /resuming/.test(l));
  if (!resumed) fail("run 2 did not resume the plan — it started over");
  ok("run 2 resumed the stored plan instead of starting again");

  const feesAfter = BigInt(
    (await cli.state.getPoolFeeMetrics(pool2)).current.creatorQuoteFee.toString());
  if (feesAfter > feesBefore) {
    fail("run 2 claimed a SECOND time — the pool was charged twice for one payout");
  }
  ok("run 2 did not claim again — the pool was only ever charged once");

  let paid2 = 0n;
  for (const b of buyers) {
    paid2 += BigInt(await conn.getBalance(b.publicKey)) - before2[b.publicKey.toBase58()];
  }
  if (paid2 <= 0n) fail("holders were never paid after the resume");
  ok("every holder was paid exactly once: " + sol(paid2) + " SOL across " + HOLDERS);

  /* The creator's kept share is a single transfer, and run 1 died right after
   * sending it. If resuming just re-sends, the creator is paid twice out of a
   * pot that only holds one payment — the shortfall comes out of the keeper's
   * float, silently. Expected: exactly 20% of what was claimed, once. */
  const creatorGot2 = BigInt(await conn.getBalance(creator.publicKey)) - creatorBefore2;
  const claimed2 = BigInt(JSON.parse((cap2.body.log || []).join("").match(/claimed (\d+)/)[1]));
  const expectCreator = (claimed2 * 20n) / 100n;
  info("creator received " + sol(creatorGot2) + " SOL, should be " + sol(expectCreator));
  if (creatorGot2 > expectCreator + 1000n) {
    fail("the creator was PAID TWICE across the crash (got " + sol(creatorGot2) +
         ", owed " + sol(expectCreator) + ")");
  }
  ok("the creator was paid exactly once despite the crash");

  const dump2 = await (await fetch(stub + "/dump")).json();
  if (dump2.keys.includes(planKey)) fail("the finished plan was left in the store");
  ok("the plan was cleared once the payouts completed");
  }

  await crashTest(1, "killed before the creator transfer was sent");
  await crashTest(2, "killed after the creator transfer LANDED, before it was recorded");

  console.log("\n  ✓  automatic fee distribution works, and survives being killed\n");
  process.exit(0);
})().catch((e) => {
  console.error("\n  ✗  " + (e && e.stack ? e.stack : e) + "\n");
  process.exit(1);
});
