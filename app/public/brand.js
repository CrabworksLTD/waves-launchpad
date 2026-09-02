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
      "mainnet-beta": { sol: "3HLkZDZzcJAvdQWsQNWLP98qA9pPL2jtaRbhiE8t6tko",
                        // was 9xHSsPYmRuJJtGA3TYB7Q5P2oHWy4zpeugTf9EZ1S491,
                        // which names the treasury as claimer — see sol above
                        usdc: "CkggbyU3nA7DLxT5Cw6xZBysB9tQK1Bt4SstY7cdcNGe",
                        /* Fee-ladder rungs. Each is its own immutable config,
                         * signed once at /config-create?fee=<rung>. An empty
                         * string means that rung is simply not offered — the
                         * launch window hides it rather than trying to create
                         * one mid-launch. */
                        t2:  { sol: "", usdc: "", rwa: {} },
                        t4:  { sol: "", usdc: "", rwa: {} },
                        t5:  { sol: "", usdc: "", rwa: {} },
                        t10: { sol: "", usdc: "", rwa: {} },
                        /* The tax rung — 3%, signed 2026-09-01. Verified on
                         * chain before wiring: 0.6% Meteora, 0.792% platform,
                         * 1.608% to holders, and feeClaimer is the sweep key so
                         * platform fees claim hourly rather than by hand.
                         *
                         * ⚠️ Replaces an earlier pair signed the same evening
                         * (9wYcHGs7… sol, F22Pjfu2… usdc) which took 1.8% for
                         * the platform and left 0.6% for holders — the wrong
                         * way round for a rung whose whole point is the reward.
                         * Those stay readable for anything already launched on
                         * them; nothing new can reach them. */
                        t3:  { sol: "GA2TweZTv5JMT6nu9gGMRJTsmbnNArvTNdQpFPUxNU7W",
                               usdc: "QYECpZwhb3jCrQtH8Q2wUZmEVA3LijZAKz3c9yEXXgB",
                               // gold, the only tokenised asset DBC will take
                               // as a quote — the rest are Token-2022
                               rwa: { "AymATz4TCL9sWNEEV9Kvyz45CHVhDZ6kUgjTJPzLpU9P":
                                 { config: "9EMW8SWyyTsqXZBzK9664xrfneFhvV7eBYYxKnWg7hL8",
                                   symbol: "XAUt0", decimals: 6, label: "Gold" } } },
                        /* 5% config, signed 2026-09-01 and then superseded by
                         * the 3% rung above. Kept because it is immutable and
                         * paid for; not in LADDER, so nothing new launches on
                         * it. */
                        tax: { sol: "39FwtFMZJfp97WzKqFs3rcC6xE5YewCgPxw5LV6BEQdp",
                               usdc: "", rwa: {} },
                        /* ⚠️ Only classic-SPL mints can be a QUOTE — DBC
                         * rejects Token-2022, and 49 of the 50 most liquid
                         * tokenised assets are Token-2022. Gold is effectively
                         * the only real-world quote available.
                         *
                         * This does not limit REWARDS: Jupiter routes SOL into
                         * NVDAx, SPYx, TSLAx and AAPLx at ~0% impact despite
                         * all four being Token-2022. Paying holders in stocks
                         * needs the keeper's swap leg, not a different quote
                         * mint — and not a different launchpad. */
                        rwa: {
                          // was AWar1Y1GALnT3TjL3d4K1qjH2ZLB5KiqrSw3gmaR9EGA
                          "AymATz4TCL9sWNEEV9Kvyz45CHVhDZ6kUgjTJPzLpU9P":
                            { config: "CoYJxuQZsTSfdGJfadZNfiVwr1pTtKN5tsGKH6K12WGc",
                              symbol: "XAUt0", decimals: 6, label: "Gold" }
                        } },
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
