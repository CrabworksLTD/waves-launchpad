#!/usr/bin/env node
/* End-to-end smoke test of the token launch path — the revenue loop.
 *
 *   SOLANA_RPC=http://127.0.0.1:8899 node tools/token-smoke.js
 *
 * Exercises what the launchpad actually depends on, in order:
 *
 *   1. createConfig        our partner config (the launchpad itself)
 *   2. createPool          a creator launches a token against it
 *   3. swap x2             buyers trade through the curve -> fees accrue
 *   4. fee metrics         the pool reports partner + creator fees
 *   5. claim creator fees  paid STRAIGHT TO A VAULT address (the rewards hook)
 *   6. claim partner fees  the platform's 40%
 *
 * Step 5 is the one the whole rewards protocol hangs off: if creator fees can
 * be claimed to an arbitrary receiver, a collection's reward vault needs no
 * custody anywhere. Run against the local validator with the Meteora programs
 * cloned from mainnet (see memory: sunpad-chain-testing).
 */
"use strict";

const RPC = process.env.SOLANA_RPC || "http://127.0.0.1:8899";

(async () => {
  const {
    DynamicBondingCurveClient, buildCurveWithMarketCap, convertToLamports,
    ActivationType, BaseFeeMode, CollectFeeMode, TokenDecimal,
    TokenType, MigrationOption, MigrationFeeOption, TokenAuthorityOption
  } = await import("@meteora-ag/dynamic-bonding-curve-sdk");
  const { Connection, Keypair, PublicKey, LAMPORTS_PER_SOL } = await import("@solana/web3.js");
  const BN = (await import("bn.js")).default;
  const bs58 = (await import("bs58")).default;
  const fs = require("fs");
  const path = require("path");

  const step = (n, s) => console.log("\n  " + n + "  " + s);
  const ok = (s) => console.log("      ok   " + s);

  // "confirmed" everywhere — the finalized-default lesson from the NFT path.
  const conn = new Connection(RPC, "confirmed");
  const client = new DynamicBondingCurveClient(conn, "confirmed");

  const payer = Keypair.fromSecretKey(bs58.decode(
    fs.readFileSync(path.join(__dirname, "..", ".devnet-smoke.key"), "utf8").trim()));
  console.log("  rpc     " + RPC);
  console.log("  payer   " + payer.publicKey.toBase58());

  async function send(tx, signers, label) {
    tx.feePayer = payer.publicKey;
    tx.recentBlockhash = (await conn.getLatestBlockhash("confirmed")).blockhash;
    tx.sign(...signers);
    try {
      const sig = await conn.sendRawTransaction(tx.serialize(), { skipPreflight: false });
      await conn.confirmTransaction(sig, "confirmed");
      return sig;
    } catch (e) {
      console.error("\n  FAIL at " + label + " — " + String(e.message).split("\n")[0]);
      if (e.logs) console.error("  " + e.logs.slice(-8).join("\n  "));
      process.exit(1);
    }
  }

  const bal = await conn.getBalance(payer.publicKey);
  if (bal < 5 * LAMPORTS_PER_SOL) {
    console.error("  fund " + payer.publicKey.toBase58() + " first (needs ~5 SOL)");
    process.exit(2);
  }

  /* ---- 1. the partner config: this IS the launchpad ---- */
  step("1/6", "create partner config (SOL quote, 60/20/20)");
  const curve = buildCurveWithMarketCap({
    initialMarketCap: 28,          // ~$5k at $180 SOL — per-quote units, not dollars
    migrationMarketCap: 385,       // ~$69k, near pump.fun's graduation
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
        feeSchedulerParam: { startingFeeBps: 100, endingFeeBps: 100, numberOfPeriod: 0, totalDuration: 0 }
      },
      dynamicFeeEnabled: true,
      collectFeeMode: CollectFeeMode.QuoteToken,
      creatorTradingFeePercentage: 25,   // 60% platform / 20% creator of the total fee
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

  const config = Keypair.generate();
  const WSOL = new PublicKey("So11111111111111111111111111111111111111112");
  const cfgTx = await client.partner.createConfig({
    config: config.publicKey,
    feeClaimer: payer.publicKey,
    leftoverReceiver: payer.publicKey,
    payer: payer.publicKey,
    quoteMint: WSOL,
    ...curve
  });
  await send(cfgTx, [payer, config], "createConfig");
  ok(config.publicKey.toBase58());

  /* ---- 2. a creator launches a token ---- */
  step("2/6", "launch a token against the config");
  const baseMint = Keypair.generate();
  const poolTx = await client.creator.createPool({
    name: "Smoke Token",
    symbol: "SMOKE",
    uri: "https://arweave.net/0000000000000000000000000000000000000000000/token.json",
    payer: payer.publicKey,
    poolCreator: payer.publicKey,
    config: config.publicKey,
    baseMint: baseMint.publicKey
  });
  await send(poolTx, [payer, baseMint], "createPool");
  const pool = await client.state.getPoolByBaseMint(baseMint.publicKey);
  if (!pool) { console.error("  FAIL — pool not found after create"); process.exit(1); }
  ok("mint " + baseMint.publicKey.toBase58());
  ok("pool " + pool.publicKey.toBase58());

  /* ---- 3. buyers trade through the curve ---- */
  step("3/6", "two buys through the curve (1 SOL, 0.5 SOL)");
  for (const amt of [1, 0.5]) {
    const swapTx = await client.pool.swap({
      owner: payer.publicKey,
      pool: pool.publicKey,
      amountIn: convertToLamports(amt, 9),
      minimumAmountOut: new BN(1),
      swapBaseForQuote: false,             // quote (SOL) in, base (token) out = a buy
      referralTokenAccount: null
    });
    await send(swapTx, [payer], "swap " + amt + " SOL");
  }
  ok("both swaps landed");

  /* ---- 4. the pool reports fees ---- */
  step("4/6", "fee metrics");
  // Shape learned by dumping it: `current` is what is claimable now, per side;
  // `total` is lifetime trading fees before the partner/creator split.
  const metrics = await client.state.getPoolFeeMetrics(pool.publicKey);
  const partnerQuote = metrics.current.partnerQuoteFee;
  const creatorQuote = metrics.current.creatorQuoteFee;
  ok("partner quote fees: " + partnerQuote.toString() + " lamports (" +
     (Number(partnerQuote) / LAMPORTS_PER_SOL).toFixed(6) + " SOL)");
  ok("creator quote fees: " + creatorQuote.toString() + " lamports (" +
     (Number(creatorQuote) / LAMPORTS_PER_SOL).toFixed(6) + " SOL)");
  if (Number(partnerQuote) <= 0 || Number(creatorQuote) <= 0) {
    console.error("  FAIL — fees did not accrue on both sides");
    process.exit(1);
  }
  // creator gets 25% of the LP share, partner 75% — partner must be 3x the
  // creator to the lamport (integer division can leave a 1-2 lamport rounding
  // remainder on the partner side, tolerated)
  const p = BigInt(partnerQuote.toString()), c = BigInt(creatorQuote.toString());
  const drift = p > c * 3n ? p - c * 3n : c * 3n - p;
  if (drift > 2n) {
    console.error("  FAIL — split is not 75/25: " + partnerQuote + " vs " + creatorQuote);
    process.exit(1);
  }
  ok("split verified 75/25 of LP share (60/20 of total fee)");

  /* ---- 5. creator fees -> a vault address (the rewards hook) ---- */
  step("5/6", "claim creator fees straight to a vault");
  const vault = Keypair.generate();
  const before = await conn.getBalance(vault.publicKey);
  const claimC = await client.creator.claimCreatorTradingFeeToReceiver({
    creator: payer.publicKey,
    payer: payer.publicKey,
    pool: pool.publicKey,
    maxBaseAmount: new BN("18446744073709551615"),   // u64 max: claim everything
    maxQuoteAmount: new BN("18446744073709551615"),
    receiver: vault.publicKey
  });
  await send(claimC, [payer], "claimCreatorTradingFeeToReceiver");
  const after = await conn.getBalance(vault.publicKey);
  const got = after - before;
  ok("vault " + vault.publicKey.toBase58().slice(0, 8) + "… received " +
     (got / LAMPORTS_PER_SOL).toFixed(6) + " SOL");
  if (got <= 0) { console.error("  FAIL — vault received nothing"); process.exit(1); }

  /* ---- 6. partner fees -> the platform ---- */
  step("6/6", "claim partner fees");
  const pBefore = await conn.getBalance(payer.publicKey);
  const claimP = await client.partner.claimPartnerTradingFee({
    feeClaimer: payer.publicKey,
    payer: payer.publicKey,
    pool: pool.publicKey,
    maxBaseAmount: new BN("18446744073709551615"),
    maxQuoteAmount: new BN("18446744073709551615")
  });
  await send(claimP, [payer], "claimPartnerTradingFee");
  const pAfter = await conn.getBalance(payer.publicKey);
  ok("platform claimed (balance delta " +
     ((pAfter - pBefore) / LAMPORTS_PER_SOL).toFixed(6) + " SOL, net of tx fee)");

  const progress = await client.state.getPoolQuoteTokenCurveProgress(pool.publicKey)
    .catch(() => null);
  console.log("\n  PASS — launch, trade, fee split and both claims all work");
  console.log("  curve progress toward migration: " +
    (progress == null ? "n/a" : (Number(progress) * 100).toFixed(2) + "%"));
})().catch((e) => {
  console.error("\n  FAIL — " + (e && e.message ? e.message : e));
  if (e && e.logs) console.error("  " + e.logs.slice(-10).join("\n  "));
  process.exit(1);
});
