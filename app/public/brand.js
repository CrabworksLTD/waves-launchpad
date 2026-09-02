/* Brand — the single source of truth for every name-bearing string.
 *
 * The name is NOT decided yet. "SUNPAD" is a placeholder. To rename the whole
 * project, run:  node tools/rename.js NEWNAME
 * which rewrites this file plus the handful of places a name has to be baked
 * into markup (the <title>, OG tags and the wordmark in app.html).
 *
 * Nothing else in the codebase should contain the product name. If you find
 * yourself typing it in another file, add a field here instead. */
(function () {
  var NAME = "WAVES";
  var lower = NAME.toLowerCase();

  window.BRAND = {
    name: NAME,                       // "SUNPAD" — display, uppercase
    lower: lower,                     // "sunpad" — keys, slugs, filenames
    tagline: "Editor",
    description: "Design, assemble, and deploy your own NFT collection on Solana.",
    chain: "Solana",
    domain: "",                       // set once a domain is registered

    /* Launch gate: sha256 of the password, empty = open.
     *
     * CLOSED again 2026-08-31 — opened for about an hour, then Kyle asked for
     * the whole site back behind it. shell.js reads this and nothing else, so
     * setting it to "" reopens everything.
     *
     * It is client-side: anyone reading source can walk past it. That is fine
     * for a curtain and not fine as security — do not put anything behind it
     * that would matter if it were read. Password is with Kyle. */
    gate: "53d3ecce08c0327fbcce4ee44ffcb3e8f0f02e2c486f840dc561427377c6bc5e",

    // The wallet that owns the platform's fee share. Creator-chosen-fee
    // launches create their own config naming this as feeClaimer — the
    // program does not require its signature, only its address.
    feeOwner: "BU9dYi7fGw5G3Wd54CUTmt1Y58jEJaPq8LKiL72ydeKJ",

    // Auto-shared launches set the POOL CREATOR to this keeper instead of the
    // launcher — that is what makes "share with holders" enforced on chain:
    // the launcher cannot claim a stream they pledged away, and the keeper
    // (api/keeper.js) claims + distributes it to holders.
    //
    // ⚠️ This MUST be the public key of KEEPER_SECRET. It was feeOwner (Kyle's
    // wallet) until 2026-08-31, which meant a pledged launch handed its fee
    // stream to a wallet the keeper cannot sign for: every run skipped the pool
    // with "keeper is not this pool's creator" and the launcher had already
    // signed the stream away. Nothing had pledged yet, so nothing was misrouted.
    // If you rotate KEEPER_SECRET, rotate this in the same commit.
    feeKeeper: "EFFY1LjZbzzEYuUr24udxWponKqtta8MaxZxs6HGPswH",

    /* The wallet named as feeClaimer on NEW configs.
     *
     * Not feeOwner. A config's feeClaimer is fixed at creation and must sign
     * every claim, so naming the treasury meant platform revenue could only be
     * collected by hand — 0.74 SOL sat in the $MOAR pool until someone noticed.
     * This is a dedicated hot key held by api/keeper.js (PARTNER_CLAIMER_SECRET)
     * that can do exactly one thing: trigger a claim, always into feeOwner. It
     * never holds a balance, so losing it costs an hour of unclaimed fees.
     *
     * ⚠️ Configs created before 2026-09-01 name feeOwner and cannot be swept —
     * their pools are claimed manually at /fees. */
    partnerClaimer: "9cHofwC8aDWLnSvdhR3qf4MsK9kfHBB4PktRWPXQekaT",

    // DBC partner configs, one per cluster per quote currency. Created once
    // each by tools/create-dbc-config.js; a missing entry disables that
    // currency in the token launch window rather than hiding the field.
    // Keyed by cluster so a devnet key can never quietly serve mainnet.
    // ⚠️ devnet config is owned by the throwaway smoke key — mainnet's owner
    // must be the real platform wallet, it claims the 60% forever.
    dbcConfigs: {
      // mainnet sol: created 2026-08-30, signed in-browser; owner (fee
      // claimer, forever): BU9dYi7fGw5G3Wd54CUTmt1Y58jEJaPq8LKiL72ydeKJ
      // rwa: configs priced in a tokenised asset, keyed by quote mint —
      // { "<mint>": { config, symbol, decimals } }, signed via
      // /config-create?quote=rwa&mint=<address>
      // .tax holds the 5% "tax token" tier's configs — same shape, its own
      // immutable keys, signed at /config-create?fee=tax
      /* ⚠️ sol was DdHWKSqE7gvKrCUvcAnEVT7R1YWKY2SknBYFLUKxxsCN until
       * 2026-09-01. That config names the TREASURY as feeClaimer, so its
       * platform fees can only be claimed by hand at /fees — $MOAR is on it.
       * The replacement names the keeper's claim key, so fees sweep hourly.
       * Pools keep the config they launched against; this only affects new
       * launches. */
      /* All twelve signed 2026-09-02 and verified on chain before wiring:
       * fee, split, quote mint, feeClaimer (the sweep key, so platform revenue
       * claims hourly) and leftoverReceiver.
       *
       * Platform take by rung: 0.400 / 0.512 / 0.600 / 0.704 / 0.800 / 0.880 %
       * of a trade. It approximates a tenth of a percent per rung rather than
       * hitting it, because creatorTradingFeePercentage is an INTEGER on chain
       * — see dbc-terms.js. */
      "mainnet-beta": { sol: "4cD5hSa6zD8UWDoB7GTcgUDmPt94rPW5rUhWESN5Swhv",
                        usdc: "GTLoW7zUSp8EYUGcUGVeeocT7UWnmi7KhAUpq6zGDFvC",
                        t2:  { sol: "5FRLvvLecmZqDTp7vNYkJAXN4QqBywkKxUPboD5p3Pcv",
                               usdc: "5HFsQE1keZLYv5Nv8quZkd7HQUhSaQdrmEXUJ7JDQs6N", rwa: {} },
                        t3:  { sol: "4aiD1TBNnVQdtAWrmmBW53g3qQU68PtB834EF9rJRbXS",
                               usdc: "G1bXNHGPBvnKi4tTtDCEpxQvsXVcrfWQ5m7Lrv8NF5K6", rwa: {} },
                        t4:  { sol: "73bBu45ymdPRsdVJqyDZLe8ExTWasEN8ncTPTHS3gCck",
                               usdc: "A63Yku5iVaREormEAECywYagueCxqEX9ZqoawD9pTVSs", rwa: {} },
                        t5:  { sol: "9sRHWsZS9DHMfffPA1Hri1NSLE7T7BWxuvtWPDQ6rvxV",
                               usdc: "5e8o73VYKhWhiWkgG34deBmXoa9XcEf5Nxb62pR6obd6", rwa: {} },
                        t10: { sol: "B7VXTPqoAairkL11sVKonAX2mTYXXVeNBCfK8oo7RnSx",
                               usdc: "HThFWGnh98j3aSR7Nhv44e25KVRZPq822wpsJB4kkD59", rwa: {} },

                        /* ⚠️ Superseded, kept only so pools already launched
                         * against them still read. None are in LADDER.
                         *   3HLkZDZz… / CkggbyU3…  1% at 0.2 creator / 0.6 us
                         *   GA2TweZT… / QYECpZwh…  3% at 1.608 / 0.792
                         *   9wYcHGs7… / F22Pjfu2…  3% at 0.6 / 1.8, backwards
                         *   39FwtFMZ…              5% abandoned
                         *   9EMW8SWy…              gold, dropped as a quote
                         *   41hCSSUm… / DUjdKhLg…  10% signed from a stale tab,
                         *                          stored 88 not 89
                         */
                        tax: { sol: "39FwtFMZJfp97WzKqFs3rcC6xE5YewCgPxw5LV6BEQdp",
                               usdc: "", rwa: {} } },
      devnet: { sol: "97FsuYAZrY1HxSokdSz1GnPVsLWNdpVgdczt3bLqXv8J", usdc: "",
                tax: { sol: "", usdc: "", rwa: {} }, rwa: {} }
    },

    // Save files. `fileKind` is written into new saves; `readKinds` is what we
    // accept when opening, so Moonpad projects and the bundled templates
    // (which are still "moonpad-project") keep working. Never drop an entry
    // from readKinds — it silently orphans anyone's saved work.
    fileKind: lower + "-project",
    readKinds: [lower + "-project", "moonpad-project"],
    fileExt: "." + lower + ".json",
    readExts: [".json", "." + lower + ".json", ".moonpad.json"],

    // localStorage namespace. Bumping this resets the tour for everyone.
    key: function (s) { return lower + "." + s; }
  };
})();
