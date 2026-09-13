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
    // WAVES's own X handle — worn on every share card so a token launched here
    // is free exposure back to us (@ included, ready to render or link)
    x: "@waveslaunchpad",

    /* Launch gate: sha256 of the password, empty = open.
     *
     * CLOSED again 2026-08-31 — opened for about an hour, then Kyle asked for
     * the whole site back behind it. shell.js reads this and nothing else, so
     * setting it to "" reopens everything.
     *
     * It is client-side: anyone reading source can walk past it. That is fine
     * for a curtain and not fine as security — do not put anything behind it
     * that would matter if it were read. Password is with Kyle. */
    gate: "",

    /* Per-chain gate, applied when the whole-site `gate` above is open.
     *
     * Robinhood Chain is behind the same password the whole site used to be —
     * the token launchpad there runs on our own bonding curve, which works and
     * is tested but has never been deployed or audited, so it is not something
     * to leave open to strangers. The Solana side stays public.
     *
     * Same caveat as `gate`: this is a curtain, not security. Anyone reading
     * source walks past it. It keeps out visitors, not attackers. */
    gateChain: {
      robinhood: ""
    },

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
                        // standard-tier (1%) quote-token configs, keyed by quote mint —
                        // tokenised stocks AND liquid altcoins both live here.
                        // { "<mint>": { config, symbol, decimals } }; filled by
                        // tools/sign-rwa-configs.js
                        rwa: {},
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

    /* ---- Raydium LaunchLab backend (Solana stock quotes) ----
     * The SECOND launch backend, for Token-2022 stock quotes (xStocks) that
     * Meteora's DBC rejects (InvalidQuoteMint). Unlike dbcConfigs, the CURVE
     * config is Raydium's and global — we don't create it (launchlab.js derives
     * the config PDA from the quote mint). What IS ours is a PlatformConfig,
     * created once per cluster (permissionless) by tools/sign-launchlab-platform.js;
     * platformId holds it, feeBps our trading fee, quotes the stock mints we
     * offer ({ "<mint>": { symbol, decimals, label, configId? } }).
     *
     * ⚠️ SCAFFOLD — launchlabLive stays false until launchlab.js is audited and
     * browser-smoke-tested. Proven in Node (tools/launchlab-smoke.js) only.
     * See docs/launchlab-migration-spec.md. */
    launchlabConfigs: {
      // Fee ladder per trade (verified in tools/launchlab-fee-check.js, all
      // additive + charged on the curve): 0.25% Raydium (fixed on the config) +
      // 0.40% platform (feeRate) + 0.50% creator (creatorFeeRate, program cap) =
      // 1.15%. platformFeeRate/creatorFeeRate are on-chain 1e6 units and are set
      // when the platform is created (sign-launchlab-platform.js); listed here
      // for reference — the live values are whatever the platform was created with.
      "mainnet-beta": {
        // created + verified on-chain 2026-09-13 via /launchlab-platform; admin =
        // feeOwner BU9d…deKJ; feeRate 4000 / creatorFeeRate 5000 confirmed
        platformId: "iaidSbPCBvzZVSnLdQUHWJFXL2j6oQt386QZ6fTfBoi",
        platformFeeRate: 4000, creatorFeeRate: 5000,
        // Quote currencies, all with a live Raydium LaunchLab config (config-gated
        // — added only when Raydium has created the config; configId is derived at
        // index 0 by launchlab.js, not stored here). Enumerated on-chain + liquidity-
        // verified via Jupiter routing 2026-09-13 (dead routes dropped). Categories:
        // Backed xStocks (24) + Backpack Securities stocks (40) = cat "stock",
        // GLDx = "commodity", PreStocks pre-IPO = "preipo", the rest = tokens.
        quotes: {
          "XsueG8BtpquVJX9LVLLEGuViXUungE6WmK5YZ3p3bd1": { symbol: "CRCLx", decimals: 8, label: "Circle" },
          "XsoCS1TfEyfFhfvj8EtZ528L3CaKBDBRqRapnBbDF2W": { symbol: "SPYx", decimals: 8, label: "SP500" },
          "Xsc9qvGR1efVDFGLrVsmkzv3qi45LTBjeUKSPmx9qEh": { symbol: "NVDAx", decimals: 8, label: "NVIDIA" },
          "Xs8S1uUs1zvS2p7iwtsG3b6fkhpvmwz4GYU3gWAmWHZ": { symbol: "QQQx", decimals: 8, label: "Nasdaq" },
          "XsDoVfqeBukxuZHWhdvWHBhgEHjGNst4MLodqsJHzoB": { symbol: "TSLAx", decimals: 8, label: "Tesla" },
          "XsP7xzNPvEHS1m6qfanPUGjNmdnmsLKEoNAnHjdxxyZ": { symbol: "MSTRx", decimals: 8, label: "MicroStrategy" },
          "Xs7ZdzSHLU9ftNJsii5fCeJhoRWSC32SQGzGQtePxNu": { symbol: "COINx", decimals: 8, label: "Coinbase" },
          "XsvNBAYkrDRNhA7wPHQfX3ZUXZyZLdnCQDfHZ56bzpg": { symbol: "HOODx", decimals: 8, label: "Robinhood" },
          "XsbEhLAtcf6HdfpFZ5xEMdqW8nfAvcsP5bdudRLJzJp": { symbol: "AAPLx", decimals: 8, label: "Apple" },
          "XsCPL9dNWBMvFtTmwcCA5v3xWPSMEBCszbQdiLLq6aN": { symbol: "GOOGLx", decimals: 8, label: "Alphabet" },
          "Xs3eBt7uRfJX8QUs4suhyU8p2M6DoUDrJyWBa8LLZsg": { symbol: "AMZNx", decimals: 8, label: "Amazon" },
          "Xsv9hRk1z5ystj9MhnA7Lq4vjSsLwzL2nxrwmwtD3re": { symbol: "GLDx", decimals: 8, label: "Gold", cat: "commodity" },
          "Xs78JED6PFZxWc2wCEPspZW9kL3Se5J7L5TChKgsidH": { symbol: "STRCx", decimals: 8, label: "Strategy PP Variable" },
          "XsqE9cRRpzxcGKDXj1BJ7Xmg4GRhZoyY1KpmGSxAWT2": { symbol: "MCDx", decimals: 8, label: "McDonald's" },
          "XspzcW1PRtgf6Wj92HCiZdjzKCyFekVD8P5Ueh3dRMX": { symbol: "MSFTx", decimals: 8, label: "Microsoft" },
          "XsfCC9VL4DamVGNgdJpfLXB3sBVa158Gbx8sh7NzmTk": { symbol: "VIDAx", decimals: 8, label: "Vida Global" },
          "Xsa62P5mvPszXL1krVUnU5ar38bBSVcWAB6fmPCo5Zu": { symbol: "METAx", decimals: 8, label: "Meta" },
          "XsoBhf2ufR8fTyNSjqfU71DYGaE6Z3SUGAidpzriAA4": { symbol: "PLTRx", decimals: 8, label: "Palantir" },
          "Xs6B6zawENwAbWVi7w92rjazLuAr5Az59qgWKcNb45x": { symbol: "BRK.Bx", decimals: 8, label: "Berkshire Hathaway" },
          "Xsf9mBktVB9BSU5kf4nHxPq5hCBJ2j2ui3ecFGxPRGc": { symbol: "GMEx", decimals: 8, label: "Gamestop" },
          "XsaBXg8dU5cPM6ehmVctMkVqoiRG2ZjMo1cyBJ3AykQ": { symbol: "KOx", decimals: 8, label: "Coca-Cola" },
          "XshPgPdXFRWB8tP1j82rebb2Q9rPgGX37RuqzohmArM": { symbol: "INTCx", decimals: 8, label: "Intel" },
          "Xs3oZwbHvqis4NYcf4YKWmEia2eC84wSiVrcYcTqpH8": { symbol: "SPCXx", decimals: 8, label: "SpaceX" },
          "Xs2yquAgsHByNzx68WJC55WHjHBvG9JsMB7CWjTLyPy": { symbol: "DFDVx", decimals: 8, label: "DFDV" },
          // Backpack Securities tokenised stocks (40) — a second issuer; liquidity-verified.
          "AMC1qwR9KhiyrQBRPrxnfo4JfMeMZqEBvt5tgTytNNoc": { symbol: "AMC", decimals: 6, label: "AMC Entertainment", cat: "stock" },
          "BArimz1PcKZr8PcPh3tcZ2dg4S7FJLk3cw6R5F8GsHKg": { symbol: "BA", decimals: 6, label: "The Boeing Company", cat: "stock" },
          "BABANGA4JE7Kkam4nTrALAwAVgsNJUuFJnnkF7S16BZp": { symbol: "BABA", decimals: 6, label: "Alibaba Group Holding", cat: "stock" },
          "BoTx8y9ynfdxf5ZjWtCoBVkff52qKA82ysaLU8ZM6d8T": { symbol: "BOT", decimals: 6, label: "RoboStrategy", cat: "stock" },
          "BULL151gUXcFV5wXEUqu9Am2L7Qt4bTJRLRuAUjkcspC": { symbol: "BULL", decimals: 6, label: "Webull", cat: "stock" },
          "CZEB3WNZuF2Yz1z2H81RcCk8T7fsw82KB33zqamASVsg": { symbol: "COST", decimals: 6, label: "Costco Wholesale", cat: "stock" },
          "DELL2aRKQz7DMq5DrKLtkn47ZCnbxXPZXrSGbkmd13wy": { symbol: "DELL", decimals: 6, label: "Dell Technologies", cat: "stock" },
          "DJTu7vi8norVzdVAffgvb39VP7wjKeTsgaMBJrzfxvoF": { symbol: "DJT", decimals: 6, label: "Trump Media & Technology Group Corp.", cat: "stock" },
          "DKNGQFNGQmoBdXSRGKJ8tTu7uPDasw5JDcfMmWniNfow": { symbol: "DKNG", decimals: 6, label: "DraftKings", cat: "stock" },
          "DNUTsCvKbKwu2RM72cUuW3TD9YpzArzACcqYQssjPLSk": { symbol: "DNUT", decimals: 6, label: "Krispy Kreme", cat: "stock" },
          "DRAMjSWR7HRfJKjRkvQWYL2bcaejaVhuxEcjf4pAY4Cw": { symbol: "DRAM", decimals: 6, label: "Roundhill Memory ETF", cat: "stock" },
          "FLWSojG1gB5VStYR3Sb4nQFRt43UBYkqih1j2CpVLqgd": { symbol: "FLWS", decimals: 6, label: "1-800-FLOWERS.COM", cat: "stock" },
          "GPRR2u6NS5yBQHWGauoJ9HXgjrTH8dDsrBfTV5zAYvDH": { symbol: "GPRO", decimals: 6, label: "GoPro", cat: "stock" },
          "GRNDYDpqwpCm6jVxpbh4xT5AM4r3p391qYsKTHqgaET2": { symbol: "GRND", decimals: 6, label: "Grindr", cat: "stock" },
          "HiMSSzzwkZkrXJ4PGVJRdtfLaANeAztjjcgk5Dxe7Lwx": { symbol: "HIMS", decimals: 6, label: "Hims & Hers Health", cat: "stock" },
          "HTZsLG4zqaNvWMwXSLHH3GG5KyJpKwpBRsKVdMG6hvzP": { symbol: "HTZ", decimals: 6, label: "Hertz Global Holdings", cat: "stock" },
          "BMKdM4yUxX12moFqVk195k7coMbaybd4RUKCUdm7D1Sk": { symbol: "IBM", decimals: 6, label: "International Business Machines", cat: "stock" },
          "JNJg1znKdF712Phe7L7z52AATAvEjEytBdN2w8Lnh1Y": { symbol: "JNJ", decimals: 6, label: "Johnson & Johnson", cat: "stock" },
          "LLYuwZ33keFihgwoxXsBawy31AiRFLFSva32TYq5TvD": { symbol: "LLY", decimals: 6, label: "Eli Lilly and Company", cat: "stock" },
          "LMT3i1BHgixFqPUgcyteJhnEz2dpy9i3cYy4pi9BoeV": { symbol: "LMT", decimals: 6, label: "Lockheed Martin", cat: "stock" },
          "LULUmT9VMttkfAJE236LXJcYJ2tTP7nunrSWR5G1BdS": { symbol: "LULU", decimals: 6, label: "lululemon athletica", cat: "stock" },
          "MGMuubtUEirmkhfEQdmGUh4pr7HuUdMWcZXFtpPbVJD": { symbol: "MGM", decimals: 6, label: "MGM Resorts International", cat: "stock" },
          "MRNAzXzhNcaEXJPibHEn8cd4vyekCDiivTyEwswLUCT": { symbol: "MRNA", decimals: 6, label: "Moderna", cat: "stock" },
          "MRVLSjkR2ceUBukujaD3xCyHP1H3B2SzpsNTZF546jo": { symbol: "MRVL", decimals: 6, label: "Marvell Technology", cat: "stock" },
          "MUxEsUKSMACyw5fZf68wxf5FLnZVhtU9CwH8uNNGay1": { symbol: "MU", decimals: 6, label: "Micron Technology", cat: "stock" },
          "NBiSF3UaVUFtRzHwAfxyHsBCAZWGEKnMpewAE4oh7BG": { symbol: "NBIS", decimals: 6, label: "Nebius Group N.V.", cat: "stock" },
          "NKEda5nHhNGgjrE9nDdMvaEmkmJ96qqxzBVZEcKmjSg": { symbol: "NKE", decimals: 6, label: "NIKE", cat: "stock" },
          "PFER6ENqP8r8NF3CqVt4mFowxsin3V5MLidBNQFCC3x": { symbol: "PFE", decimals: 6, label: "Pfizer", cat: "stock" },
          "QUBTAD8C9bMU9LvmMNgKPhrmBGbHvxpu6vfWQtThxxw": { symbol: "QUBT", decimals: 6, label: "Quantum Computing", cat: "stock" },
          "RBLXDGRD64AtRamHMFVcjqne3Ar7NLWtFtYNtsrf1cE": { symbol: "RBLX", decimals: 6, label: "Roblox", cat: "stock" },
          "RDDTGbhHwVXfyCvQMXzzowKjf5qrYBZAnehoXW83ooh": { symbol: "RDDT", decimals: 6, label: "Reddit", cat: "stock" },
          "RcZmt84VMJv9bDhKqmw1uWDahYrUT468VwAChTnfD8p": { symbol: "RIVN", decimals: 6, label: "Rivian Automotive", cat: "stock" },
          "SH55hfaipFAbwT42nQYhRoM5o5t61QpkmJ6p62vXB3m": { symbol: "SHOP", decimals: 6, label: "Shopify", cat: "stock" },
          "SKHYhSjuRWHgikq8eRKbtBbpABgJSkd7ytQV14i9EQ3": { symbol: "SKHY", decimals: 6, label: "SK Hynix", cat: "stock" },
          "SNAPcESrvnH8yUdgeMF6xm1hym9b6hW6s8YeqeHdZFz": { symbol: "SNAP", decimals: 6, label: "Snap", cat: "stock" },
          "SNDKbwMUQvZhnLnxLduradgLHG5KrPuKwpnrkkGRhfH": { symbol: "SNDK", decimals: 6, label: "Sandisk", cat: "stock" },
          "SPHRp8cZaSQBTp1KMNP4V1X821SXhXWt4Q2yLdyHzju": { symbol: "SPHR", decimals: 6, label: "Sphere Entertainment", cat: "stock" },
          "TTWofwAge91oFhZs7kpQdyrVRkmevgM88xijGvQFbKo": { symbol: "TTWO", decimals: 6, label: "Take-Two Interactive Software", cat: "stock" },
          "UPSqUeMHcWbkdg784XuBUEF9DtySSnW9ur5LAVdcuB9": { symbol: "UPS", decimals: 6, label: "United Parcel Service", cat: "stock" },
          "WENAZ2WyPbmgvUcKfQ8hyMDfBQP9bZ65hsZ5KTFrRGZ": { symbol: "WEN", decimals: 6, label: "The Wendy's Company", cat: "stock" },
          // PreStocks pre-IPO synthetics (7) — own "preipo" category; thinnest liquidity (2-5.5% on $1k).
          "PresTj4Yc2bAR197Er7wz4UUKSfqt6FryBEdAriBoQB": { symbol: "ANDURIL", decimals: 9, label: "Anduril", cat: "preipo" },
          "Pren1FvFX6J3E4kXhJuCiAD5aDmGEb7qJRncwA8Lkhw": { symbol: "ANTHROPIC", decimals: 9, label: "Anthropic", cat: "preipo" },
          "PreZad18qfPtbxNpMtMuAuX2zVpvkEU8DnJx56faCWd": { symbol: "FIGUREAI", decimals: 9, label: "Figure AI", cat: "preipo" },
          "PreLWGkkeqG1s4HEfFZSy9moCrJ7btsHuUtfcCeoRua": { symbol: "KALSHI", decimals: 9, label: "Kalshi", cat: "preipo" },
          "PrekqLJvJ3qVdXmBGDiexvwUTF4rLFDa6HWS4HJbw9S": { symbol: "NEURALINK", decimals: 9, label: "Neuralink", cat: "preipo" },
          "PreweJYECqtQwBtpxHL171nL2K6umo692gTm7Q3rpgF": { symbol: "OPENAI", decimals: 9, label: "OpenAI", cat: "preipo" },
          "Pre8AREmFPtoJFT8mQSXQLh56cwJmM7CFDRuoGBZiUP": { symbol: "POLYMARKET", decimals: 9, label: "Polymarket", cat: "preipo" },
          // SPL tokens with a live Raydium LaunchLab config — altcoins/majors a
          // token can be priced in (verified mints/decimals/configs 2026-09-13).
          "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB": { symbol: "USDT", decimals: 6, label: "Tether" },
          "4k3Dyjzvzp8eMZWUXbBCjEvwSkkk59S5iCNLY3QrkX6R": { symbol: "RAY", decimals: 6, label: "Raydium" },
          "JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN": { symbol: "JUP", decimals: 6, label: "Jupiter" },
          "EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm": { symbol: "WIF", decimals: 6, label: "dogwifhat" },
          "7GCihgDB8fe6KNjn2MYtkzZcRjQy3t9GHdC8uHYmW2hr": { symbol: "POPCAT", decimals: 9, label: "Popcat" },
          "3NZ9JMVBmGAqocybic2c7LQCJScmgsAZ6vQqTDzcqmJh": { symbol: "WBTC", decimals: 8, label: "Wrapped BTC" },
          "7vfCXTUXx5WJV5JADk17DUJ4ksgau7utNKj4b963voxs": { symbol: "WETH", decimals: 8, label: "Wrapped ETH" },
          "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263": { symbol: "BONK", decimals: 5, label: "Bonk" },
          "jtojtomepa8beP8AuQc6eXt5FriJwfFMwQx2v2f9mCL": { symbol: "JTO", decimals: 9, label: "Jito" },
          // major L1/L2 + wrapped coins (liquidity-verified 2026-09-13; LTC/XMR dropped — dead routes)
          "9gP2kCy3wA1ctvYWQk75guqXuHfrEomqydHLtcTCqiLa": { symbol: "WBNB", decimals: 8, label: "Wrapped BNB" },
          "6UpQcMAb5xMzxc7ZfPaVMgx3KqsvKZdT5U718BzD5We2": { symbol: "wXRP", decimals: 6, label: "Wrapped XRP" },
          "suifhC9gU1VbJAPYPTBkHJyyyStKGLLYPVDTmPoqbvA": { symbol: "SUI", decimals: 8, label: "Sui" },
          "3ZLekZYq2qkZiSpnSvabjit34tUkjSwD1JFuW9as9wBG": { symbol: "NEAR", decimals: 9, label: "NEAR" },
          "ARBzQTYDCW2KnVEjs1Mc81LekB1ibVFZKbSVmorkoT9d": { symbol: "ARB", decimals: 8, label: "Arbitrum" },
          "DoGEV7LASBkQbibMc5k5vKnTZoMg423GpJ5QtJEGfm7R": { symbol: "DOGE", decimals: 8, label: "Dogecoin" },
          "AavE1kKKnesPw4MuRJmJ9jZs9QzEE8CPxQ3ViczUDfc1": { symbol: "AAVE", decimals: 8, label: "Aave" },
          "uniHfuPhEQSrtpzXpJZDCSq53yaejKKpNhFUiKoHKHV": { symbol: "UNI", decimals: 8, label: "Uniswap" },
          "taoC6xyv2v8tDLcev4uaGUgV4vdQsWJrGft2kcBRrBY": { symbol: "TAO", decimals: 9, label: "Bittensor" },
          "A7bdiYdS5GjqGFtxf17ppRHtDKPkkRqbKtR27dxvQXaS": { symbol: "ZEC", decimals: 8, label: "Zcash" }
        }
      },
      // devnet platform proven by launchlab-smoke.js (throwaway smoke key; created
      // with 1% platform / 0 creator, before the ladder was fixed — devnet only)
      devnet: { platformId: "EzwdaEx5EBK51vGzALFs4rg8kd4EkNMVPCrj7YgtyAQi", platformFeeRate: 10000, creatorFeeRate: 0, quotes: {} }
    },
    // Per-cluster launch gate.
    // ⚠️ mainnet-beta is ON for a DELIBERATE pre-audit LaunchLab test (2026-09-13,
    // Kyle's explicit go-ahead). This routes REAL mainnet launches through the
    // UNAUDITED launchlab.js. REVERT to false before the public site is deployed,
    // or the public launch gate opens for everyone. Audit must land before this
    // ships to production.
    launchlabLive: { "mainnet-beta": false, devnet: true },

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
