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

    // Launch gate: sha256 of the password. While set, production shows a
    // blurred page behind a password card (shell.js). Empty string = open.
    // This keeps HUMANS out during the build — it is client-side, so anyone
    // reading source can bypass it; that is fine for a curtain, remove it
    // before pretending otherwise. Current password: "makewaves".
    gate: "d80f153f648b19e03ac4538a259a44c5de08cecb9d75e96a32d9f42fa51a8023",

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
      "mainnet-beta": { sol: "DdHWKSqE7gvKrCUvcAnEVT7R1YWKY2SknBYFLUKxxsCN",
                        usdc: "9xHSsPYmRuJJtGA3TYB7Q5P2oHWy4zpeugTf9EZ1S491",
                        // ⚠️ only classic-SPL mints can quote (DBC rejects
                        // Token-2022): XAUt0 / GOLD / VNXAU of the 526
                        rwa: {
                          "AymATz4TCL9sWNEEV9Kvyz45CHVhDZ6kUgjTJPzLpU9P":
                            { config: "AWar1Y1GALnT3TjL3d4K1qjH2ZLB5KiqrSw3gmaR9EGA",
                              symbol: "XAUt0", decimals: 6 }
                        } },
      devnet: { sol: "97FsuYAZrY1HxSokdSz1GnPVsLWNdpVgdczt3bLqXv8J", usdc: "", rwa: {} }
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
