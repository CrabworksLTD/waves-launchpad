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
      "mainnet-beta": { sol: "DdHWKSqE7gvKrCUvcAnEVT7R1YWKY2SknBYFLUKxxsCN",
                        usdc: "9xHSsPYmRuJJtGA3TYB7Q5P2oHWy4zpeugTf9EZ1S491",
                        tax: { sol: "", usdc: "", rwa: {} },
                        // ⚠️ only classic-SPL mints can quote (DBC rejects
                        // Token-2022): XAUt0 / GOLD / VNXAU of the 526
                        rwa: {
                          "AymATz4TCL9sWNEEV9Kvyz45CHVhDZ6kUgjTJPzLpU9P":
                            { config: "AWar1Y1GALnT3TjL3d4K1qjH2ZLB5KiqrSw3gmaR9EGA",
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
