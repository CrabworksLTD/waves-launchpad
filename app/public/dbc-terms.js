/* The launchpad's economics, in ONE place. Both tools/create-dbc-config.js
 * (CLI) and config-create.html (sign-in-browser) build the partner config
 * from this file, so the terms a wallet signs are the terms the CLI would
 * have sent — they cannot drift.
 *
 * ⚠️ Everything here is IMMUTABLE once a config is created. New terms mean a
 * new config key; launched tokens keep the terms they launched under.
 *
 * ⚠️ initialMarketCap and migrationMarketCap are in QUOTE TOKEN UNITS, not
 * dollars. 80_000 against a SOL quote means 80,000 SOL (~$14M), not $80k. */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.DBC_TERMS = factory();
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  var TERMS = {
    totalTokenSupply: 1000000000,      // 1B, the memecoin convention
    baseFeeBps: 100,                   // 1% trading fee, industry standard
    creatorTradingFeePercentage: 25,   // 25% of the 80% LP share -> 20% of the
                                       // total fee (60% platform, 20% Meteora)
    poolCreationFee: 0                 // free to launch
  };

  /* Fee tiers. Each tier is its own immutable config per quote — "tax token"
   * on a bonding curve means a bigger SWAP fee with a bigger creator share,
   * which is the burn/dividend budget the keeper spends. True transfer taxes
   * need the rewards program (custom transfer hook), not a config.
   * ⚠️ PROPOSED numbers — Kyle signs off before any mainnet signature. */
  /* A rung is a whole config, created once and reused by every launch that
   * picks it. That is the difference between a launch costing one signature and
   * costing two: a free-form percentage has no config to point at, so each
   * launch had to create its own first — the transaction that kept stranding
   * launches on 2026-09-01. The ladder is short on purpose; each rung is an
   * immutable on-chain account somebody has to sign for. */
  var TIERS = {
    /* The floor every launch pays. The creator keeps their side of it, so the
     * platform takes a larger slice here than on a tax — 0.46% against 0.50%
     * to the creator, with Meteora's fixed 20% before either. */
    standard: { label: "Standard", pct: 1.2, baseFeeBps: 120,
                creatorTradingFeePercentage: 52.0833 },

    /* Tax rungs. Our share is proportional up to a ceiling of 0.8% of a trade
     * and flat above it, so a creator who sets a high tax to be generous does
     * not fund us for the privilege — at 10% they hand 7.2% to holders and we
     * earn what we would at 4%.
     *
     *   2%   0.40 Meteora  0.53 platform  1.07 creator side
     *   3%   0.60          0.79           1.61
     *   4%   0.80          0.80           2.40
     *   5%   1.00          0.80           3.20
     *  10%   2.00          0.80           7.20
     */
    t2:  { label: "Tax token", pct: 2,  baseFeeBps: 200,  creatorTradingFeePercentage: 67 },
    t3:  { label: "Tax token", pct: 3,  baseFeeBps: 300,  creatorTradingFeePercentage: 67 },
    t4:  { label: "Tax token", pct: 4,  baseFeeBps: 400,  creatorTradingFeePercentage: 75 },
    t5:  { label: "Tax token", pct: 5,  baseFeeBps: 500,  creatorTradingFeePercentage: 80 },
    t10: { label: "Tax token", pct: 10, baseFeeBps: 1000, creatorTradingFeePercentage: 90 },

    /* ⚠️ Superseded. Kept so pools launched against them still read; out of
     * LADDER, so nothing new can reach them. */
    tax: { label: "Tax token", pct: 5, baseFeeBps: 500, creatorTradingFeePercentage: 25 }
  };

  var LADDER = ["standard", "t2", "t3", "t4", "t5", "t10"];

  var QUOTES = {
    sol: {
      mint: "So11111111111111111111111111111111111111112", decimals: 9, label: "SOL",
      initialMarketCap: 28,      // ~$5k at $180 SOL
      migrationMarketCap: 385    // ~$69k, deliberately near pump.fun's graduation
    },
    usdc: {
      mint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", decimals: 6, label: "USDC",
      initialMarketCap: 5000,
      migrationMarketCap: 69000
    }
  };

  /* An RWA as the quote currency (a token priced in TSLAx, PAXG, …).
   * Same DOLLAR targets as the USDC curve — $5k initial, $69k graduation —
   * converted into quote-token units at the asset's price WHEN THE CONFIG IS
   * CREATED. The config stores absolute unit thresholds, so if gold doubles
   * later, new launches against this config graduate at a higher dollar
   * value; that drift is inherent to an immutable config and is fine. */
  function rwaQuote(mint, decimals, symbol, priceUsd) {
    if (!(priceUsd > 0)) throw new Error("rwaQuote needs a positive USD price");
    return {
      mint: mint, decimals: decimals, label: symbol,
      initialMarketCap: 5000 / priceUsd,
      migrationMarketCap: 69000 / priceUsd,
      priceUsdAtCreation: priceUsd
    };
  }

  /* The full buildCurveWithMarketCap argument, given the DBC SDK module (its
   * enums differ by build, so the caller passes its own). See the tool's
   * comment block for why each choice: Immutable metadata, QuoteToken fees,
   * flat fee schedule, LP locked 50/50 permanently.
   * `quote` is "sol"/"usdc" or a QUOTES-shaped object from rwaQuote(). */
  function buildParams(sdk, quote, tier) {
    var Q = typeof quote === "string" ? QUOTES[quote] : quote;
    var T2 = (tier && typeof tier === "object") ? tier
      : TIERS[tier || "standard"] || TIERS.standard;
    return {
      initialMarketCap: Q.initialMarketCap,
      migrationMarketCap: Q.migrationMarketCap,
      activationType: sdk.ActivationType.Slot,

      token: {
        tokenType: sdk.TokenType.SPLToken,
        tokenBaseDecimal: sdk.TokenDecimal.SIX,
        tokenQuoteDecimal: Q.decimals === 9 ? sdk.TokenDecimal.NINE
          : Q.decimals === 8 ? sdk.TokenDecimal.EIGHT : sdk.TokenDecimal.SIX,
        tokenAuthorityOption: sdk.TokenAuthorityOption.Immutable,
        totalTokenSupply: TERMS.totalTokenSupply,
        leftover: 0
      },

      fee: {
        baseFeeParams: {
          baseFeeMode: sdk.BaseFeeMode.FeeSchedulerLinear,
          feeSchedulerParam: {
            startingFeeBps: T2.baseFeeBps,
            endingFeeBps: T2.baseFeeBps,
            numberOfPeriod: 0,
            totalDuration: 0
          }
        },
        dynamicFeeEnabled: true,
        collectFeeMode: sdk.CollectFeeMode.QuoteToken,
        creatorTradingFeePercentage: T2.creatorTradingFeePercentage,
        poolCreationFee: TERMS.poolCreationFee,
        enableFirstSwapWithMinFee: false
      },

      migration: {
        migrationOption: sdk.MigrationOption.MET_DAMM_V2,
        migrationFeeOption: sdk.MigrationFeeOption.FixedBps100,
        migrationFee: { feePercentage: 0, creatorFeePercentage: 0 }
      },

      liquidityDistribution: {
        partnerPermanentLockedLiquidityPercentage: 50,
        partnerLiquidityPercentage: 0,
        creatorPermanentLockedLiquidityPercentage: 50,
        creatorLiquidityPercentage: 0
      },

      lockedVesting: {
        totalLockedVestingAmount: 0,
        numberOfVestingPeriod: 0,
        cliffUnlockAmount: 0,
        totalVestingDuration: 0,
        cliffDurationFromMigrationTime: 0
      }
    };
  }

  return { TERMS: TERMS, TIERS: TIERS, LADDER: LADDER, QUOTES: QUOTES, rwaQuote: rwaQuote, buildParams: buildParams };
});
