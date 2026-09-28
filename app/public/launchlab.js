(function () {
  "use strict";
  /* Token launches on Raydium LaunchLab — the SECOND launch backend, used only
   * when the chosen quote is a Token-2022 asset (tokenised stocks: SPYx, NVDAx,
   * TSLAx …) that Meteora's DBC program rejects (InvalidQuoteMint, 0x1778).
   * Classic-SPL quotes (SOL, USDC, altcoins, gold) stay on token.js / Meteora.
   *
   * How this differs from the Meteora path (see token.js), proven end-to-end on
   * devnet in tools/launchlab-smoke.js and confirmed against mainnet:
   *
   *   1. The CURVE config is Raydium's and GLOBAL. We do not create it — the
   *      xStock configs already exist on mainnet (16 verified) and are open:
   *      1,500+ SPYx pools across ~19 distinct third-party platforms, no
   *      allow-list. configFor() derives the config PDA from the quote mint.
   *
   *   2. OUR economics live in a PlatformConfig we create ONCE per cluster
   *      (permissionless — createPlatformConfig has a single signer, the payer;
   *      no Raydium authority). It carries our trading feeRate, our fee wallet,
   *      and the LP split. This is where WAVES's fee ladder runs; the platform
   *      fee accrues to our platform fee vault, claimed via claimPlatformFee.
   *      platformId is stored in BRAND.launchlabConfigs[cluster].platformId,
   *      created by tools/sign-launchlab-platform.js (analogous to the DBC
   *      config signer). Until that exists for a cluster, launches here throw.
   *
   *   3. Reward mode = a Token-2022 transfer-fee extension on the LAUNCHED token
   *      (transferFeeExtensionParams), harvested + redistributed to holders in
   *      the paired stock. The platform is the transfer-fee authority.
   *
   *   4. Token-2022 launches graduate to CPMM (migrateType "cpmm"), not DAMM v2.
   *
   * ⚠️ SCAFFOLD — NOT AUDITED, NOT WIRED INTO THE LIVE LAUNCH FLOW YET. This
   * moves launch liquidity; it is audit-mandatory before any mainnet launch,
   * the same gate as the RH v4-hook curve and the staking program. It has been
   * proven in Node (launchlab-smoke.js) but never browser-smoke-tested. Left
   * behind BRAND.launchlabConfigs presence + a LAUNCHLAB_LIVE gate.
   */

  /* ---- vendor bundles ----
   * raydium.esm.js is the LaunchLab client (tools/build-raydium.js). metaplex
   * .esm.js is reused only for @solana/web3.js (Connection/PublicKey/…), exactly
   * as token.js does — no need to double-bundle web3. */
  var rayMod, mxMod;
  function ray() { if (!rayMod) rayMod = import("/vendor/raydium.esm.js"); return rayMod; }
  function mx()  { if (!mxMod)  mxMod  = import("/vendor/metaplex.esm.js"); return mxMod; }

  /* RPC endpoint for a cluster. Uses the app's authoritative map
   * (window.Launch.clusters), whose mainnet entry is an ABSOLUTE url
   * (origin + /api/rpc) — web3's Connection rejects a bare relative path. Falls
   * back to an absolute mainnet proxy / the public devnet endpoint. */
  function rpcUrl(cluster) {
    try {
      var c = window.Launch && window.Launch.clusters && window.Launch.clusters[cluster];
      if (c && c.rpc) return c.rpc;
    } catch (e) {}
    if (cluster === "devnet") return "https://api.devnet.solana.com";
    return (typeof location !== "undefined" ? location.origin : "") + "/api/rpc";
  }
  function cluster() { return window.Launch ? window.Launch.cluster() : "mainnet-beta"; }
  // Our custom Address Lookup Table of static LaunchLab accounts (brand.js launchAlt),
  // added on top of Raydium's default ALTs to shrink v0 launch/trade txs. null ⇒ none.
  function launchAltAddr() {
    try { return (((window.BRAND || {}).launchAlt || {})[cluster()]) || null; }
    catch (e) { return null; }
  }

  var WSOL = "So11111111111111111111111111111111111111112";
  var USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

  /* A launch's "quote" arrives as "sol", "usdc", or a raw mint (stock/altcoin).
   * Map it to the actual quote mint + its decimals. SOL/USDC are the default
   * base pairs; everything else is a registered quote in launchlabConfigs. */
  function resolveQuote(quote) {
    if (!quote || quote === "sol") return { mint: WSOL, decimals: 9, symbol: "SOL" };
    if (quote === "usdc") return { mint: USDC, decimals: 6, symbol: "USDC" };
    var q = (llConfigs().quotes || {})[quote];
    return { mint: quote, decimals: q ? q.decimals : 8, symbol: q ? q.symbol : quote };
  }

  /* Per-cluster LaunchLab config, read from brand.js. Shape:
   *   launchlabConfigs["mainnet-beta"] = {
   *     platformId: "<our WAVES PlatformConfig PDA>",
   *     platformFeeRate: 4000, creatorFeeRate: 5000,   // reference; live values
   *                                                    // are baked into the platform
   *     quotes: { "<xStockMint>": { symbol, decimals, label, configId? } }
   *   }
   * Fee per trade = 0.25% Raydium + 0.40% platform + 0.50% creator = 1.15%
   * (verified in tools/launchlab-fee-check.js). configId is optional —
   * configFor() derives it when absent. */
  function llConfigs() {
    var B = window.BRAND || {};
    return (B.launchlabConfigs || {})[cluster()] || {};
  }

  function platformId() {
    var id = llConfigs().platformId;
    if (!id) throw new Error(
      "No WAVES LaunchLab platform on " + cluster() + ". Create one with " +
      "tools/sign-launchlab-platform.js, then set launchlabConfigs." + cluster() +
      ".platformId in brand.js.");
    return id;
  }

  /* The platform config to launch against. A fee tier (t2..t10) is its OWN
   * platform config (higher feeRate); "standard"/none uses the flat 1.15% one.
   * Only the platform changes — the quote's curve config is unchanged. */
  function platformIdForTier(tier) {
    if (tier && tier !== "standard") {
      var t = (llConfigs().tiers || {})[tier];
      if (t && t.platformId) return t.platformId;
    }
    return platformId();
  }

  /* The global (Raydium-owned) config PDA for a quote. Accepts "sol"/"usdc"/mint.
   * Stored configId if brand.js pins it; otherwise derived — index 0, curveType
   * 0, where every LaunchLab config lives. Never creates anything. Async because
   * it may need the SDK to derive the PDA. */
  async function configFor(quote) {
    var mint = resolveQuote(quote).mint;
    var q = llConfigs().quotes || {};
    if (q[mint] && q[mint].configId) return q[mint].configId;
    var R = await ray(), X = await mx();
    var prog = cluster() === "devnet" ? R.DEV_LAUNCHPAD_PROGRAM : R.LAUNCHPAD_PROGRAM;
    return R.getPdaLaunchpadConfigId(prog, new X.PublicKey(mint), 0, 0).publicKey.toBase58();
  }

  /* Readiness check, mirroring Token.configKey: is this deployment able to launch
   * at all? On LaunchLab that means the platform exists. Returns truthy (the
   * platformId) or throws — launchpanel uses both shapes. SOL/USDC always have a
   * global config, so platform presence is the only gate. */
  function configKey() {
    return platformId();   // throws with a helpful message if the platform is unset
  }

  // base quote currencies that always work (have a global config): SOL + USDC
  function quotes() {
    var out = [];
    try { platformId(); out.push("sol", "usdc"); } catch (e) {}
    return out;
  }
  // the exotic quote currencies registered in brand.js. cat groups them in the
  // picker: "stock" = a Backed xStock equity (mints start with "Xs"), "token" =
  // a classic SPL token, "commodity" = gold etc. (set cat:"commodity" in brand.js).
  function rwaQuotes() {
    var q = llConfigs().quotes || {};
    return Object.keys(q).map(function (mint) {
      return { mint: mint, symbol: q[mint].symbol, decimals: q[mint].decimals,
               label: q[mint].label || q[mint].symbol,
               cat: q[mint].cat || (mint.indexOf("Xs") === 0 ? "stock" : "token") };
    });
  }
  function quoteDecimals(quote) { return resolveQuote(quote).decimals; }

  /* ---- wallet-connected context ---- */
  async function client() {
    var w = window.Wallet && window.Wallet.current();
    if (!w) throw new Error("Connect a wallet first");
    var R = await ray(), X = await mx();
    var conn = new X.Connection(rpcUrl(cluster()), "confirmed");
    var prog = cluster() === "devnet" ? R.DEV_LAUNCHPAD_PROGRAM : R.LAUNCHPAD_PROGRAM;
    // owner as PublicKey — we build here and sign with the wallet, never with a
    // keypair inside the SDK's execute() (the browser has no secret key).
    var raydium = await R.Raydium.load({
      connection: conn, owner: new X.PublicKey(w.publicKey), cluster: cluster(),
      disableFeatureCheck: true, disableLoadToken: true
    });
    return { R: R, X: X, conn: conn, wallet: w, raydium: raydium, prog: prog,
             owner: new X.PublicKey(w.publicKey) };
  }

  /* ---- send bridge ----
   * The Raydium launchpad builders return { transactions, signers } (legacy
   * Transactions here — we pass txVersion LEGACY). Sign each with its extra
   * signers (the base-mint keypair), then the wallet, then broadcast in order.
   *
   * TODO(before ship): reuse token.js's send() so LaunchLab launches get the
   * same priority fee, storage-fee instruction, cosign path, and stale-blockhash
   * retry. Factor those helpers out of token.js into a shared module rather than
   * copying them. This scaffold does the minimum: feePayer + blockhash + sign +
   * send, with a single stale-blockhash retry. */
  function isStaleBlockhash(e) {
    return /blockhash not found|block height exceeded|expired/i.test(String((e && e.message) || e));
  }
  async function sendOne(c, tx, extraSigners) {
    for (var attempt = 0; attempt < 2; attempt++) {
      try {
        // Finalise the message BEFORE the wallet signs — nothing that changes the
        // bytes (feePayer, blockhash, instructions) may happen after.
        tx.feePayer = c.owner;
        tx.recentBlockhash = (await c.conn.getLatestBlockhash("confirmed")).blockhash;
        /* ⚠️ THE WALLET SIGNS FIRST, then the extra signers (the base-mint key)
         * add their signatures to the exact bytes it returned. Phantom expects a
         * multi-signer transaction with NO existing non-null signatures; handing
         * it one already partial-signed makes it reject/mis-sign, which surfaces
         * as "did not pass signature verification". Same order as token.js send(). */
        var signed = await c.wallet.signTransaction(tx);
        var full = c.X.Transaction.from(signed.serialize());
        // apply the extra signers this tx actually requires. Compute the key set
        // once, and guard against signer entries with no publicKey (the SDK's
        // signers list can carry undefined/placeholder entries).
        var msgKeys = full.compileMessage().accountKeys;
        var need = (extraSigners || []).filter(function (s) {
          return s && s.publicKey && msgKeys.some(function (k) { return k.equals(s.publicKey); });
        });
        if (need.length) full.partialSign.apply(full, need);
        if (!full.verifySignatures()) {
          throw new Error("The transaction lost a signature while being assembled — nothing was sent, try again.");
        }
        var raw = full.serialize();
        var sig = await c.conn.sendRawTransaction(raw, { skipPreflight: false });
        /* confirmTransaction hangs / times out on public nodes even for a tx
         * that landed (it reported this launch as "not confirmed in 30s" when the
         * pool was live) — poll the signature status instead, and rebroadcast
         * while waiting, so the success panel shows when the tx actually lands. */
        var landed = false;
        for (var w8 = 0; w8 < 60; w8++) {
          var st = await c.conn.getSignatureStatus(sig, { searchTransactionHistory: true })
            .catch(function () { return null; });
          var v = st && st.value;
          if (v && v.err) throw new Error("The launch transaction failed on chain.");
          if (v && (v.confirmationStatus === "confirmed" || v.confirmationStatus === "finalized")) { landed = true; break; }
          if (w8 % 5 === 4) c.conn.sendRawTransaction(raw, { skipPreflight: true, maxRetries: 5 }).catch(function () {});
          await new Promise(function (r) { setTimeout(r, 1000); });
        }
        if (!landed) throw new Error("Sent, but not confirmed within 60s. Check the wallet history — signature: " + sig);
        return sig;
      } catch (e) {
        if (attempt === 0 && isStaleBlockhash(e)) continue;
        throw e;
      }
    }
  }
  // run a builder result's transactions in order; each tx gets the builder's
  // extra signers plus any explicitly-known ones (the base-mint keypair) — sendOne
  // applies only the ones a given tx requires.
  async function sendBuilt(c, built, known) {
    var txs = built.transactions || (built.transaction ? [built.transaction] : []);
    var signers = (built.signers || []).concat(known || []);
    var last;
    for (var i = 0; i < txs.length; i++) last = await sendOne(c, txs[i], signers);
    return last;
  }

  /* Poll a signature to confirmation, rebroadcasting the raw bytes while waiting —
   * public nodes' confirmTransaction hangs even on landed txs (see sendOne). */
  async function pollConfirm(c, raw, sig, label) {
    for (var w = 0; w < 60; w++) {
      var st = await c.conn.getSignatureStatus(sig, { searchTransactionHistory: true }).catch(function () { return null; });
      var v = st && st.value;
      if (v && v.err) throw new Error((label || "The transaction") + " failed on chain.");
      if (v && (v.confirmationStatus === "confirmed" || v.confirmationStatus === "finalized")) return sig;
      if (w % 5 === 4) c.conn.sendRawTransaction(raw, { skipPreflight: true, maxRetries: 5 }).catch(function () {});
      await new Promise(function (r) { setTimeout(r, 1000); });
    }
    throw new Error("Sent, but not confirmed within 60s. Check the wallet history — signature: " + sig);
  }

  /* Build a Raydium builder result as ONE v0 tx with our launchAlt (on top of the
   * SDK's default ALTs), wallet-sign it, and send. The builder pre-signs any of its
   * own keypairs (e.g. the launch base-mint) before we sign, matching the launch
   * path; a swap builder has none. `label` names the tx in errors. */
  async function sendV0Built(c, built, label) {
    var alt = launchAltAddr();
    var opts = { txVersion: c.R.TxVersion.V0 };
    if (alt) opts.lookupTableAddress = [alt];
    var vtx = (await built.builder.versionBuild(opts)).transaction;
    var vsigned = await c.wallet.signTransaction(vtx);
    var vraw = vsigned.serialize();
    if (vraw.length > 1232) throw new Error((label || "transaction") + " over 1232 bytes after the lookup table (" + vraw.length + ")");
    var vsig = await c.conn.sendRawTransaction(vraw, { skipPreflight: false });
    return pollConfirm(c, vraw, vsig, label);
  }

  /* ---- launch ----
   * Drop-in for Token.launchToken: the same opts the launch panel builds. quote
   * is "sol" | "usdc" | <mint>. rewardMode "dividend" mints the base as
   * Token-2022 with a transfer-fee extension (the holder tax, paid in the paired
   * asset); "burn" mints a standard SPL token (the keeper buys+burns from fees).
   *
   * ⚠️ Two LaunchLab-specific behaviours the Meteora path doesn't have:
   *   1. createLaunchpad REQUIRES a dev buy > 0 (0 reverts "buy amount should
   *      gt 0"). When the creator asks for no first buy we fall back to a small
   *      minimum (~0.01 of the quote). TODO(product): surface this in the UI.
   *   2. Token-2022 base graduates to CPMM; standard SPL to AMM v4. Only the
   *      CPMM+T2022 path is devnet-proven — the AMM path is UNTESTED. */

  /* SOL-hop for the opening dev buy of an EXOTIC-quoted launch (stock / T-token).
   * createLaunchpad's dev buy is in the QUOTE, but the launcher holds SOL — so we
   * swap the chosen SOL into the quote in a SEPARATE Jupiter tx (the launch tx is
   * already near the size limit, so composing the swap in isn't reliable) and use
   * what ARRIVES as the dev buy. Mirrors buyWithSol's Jupiter flow. Returns the raw
   * quote amount received. */
  async function hopSolForDevBuy(c, solLamports, quoteMint, quoteProg, progress) {
    progress({ step: "hop", state: "signing" });
    var jq = await (await fetch("https://lite-api.jup.ag/swap/v1/quote?inputMint=" + WSOL +
      "&outputMint=" + quoteMint + "&amount=" + String(solLamports) +
      "&slippageBps=150&restrictIntermediateTokens=true")).json();
    if (!jq || !jq.outAmount) throw new Error("No SOL → " + quoteMint.slice(0, 6) + "… route for the first buy — try a different amount.");
    var sr = await (await fetch("https://lite-api.jup.ag/swap/v1/swap", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ quoteResponse: jq, userPublicKey: c.owner.toBase58(), wrapAndUnwrapSol: true, dynamicComputeUnitLimit: true }),
    })).json();
    if (!sr || !sr.swapTransaction) throw new Error("Could not build the SOL → quote swap.");
    var ata = ataFor(c.X, quoteMint, c.owner, quoteProg);
    var before = await c.conn.getTokenAccountBalance(ata).then(function (r) { return BigInt(r.value.amount); }).catch(function () { return 0n; });
    var vtx = c.X.VersionedTransaction.deserialize(b64ToBytes(sr.swapTransaction));
    var signed = await c.wallet.signTransaction(vtx);
    var raw = signed.serialize();
    var sig = await c.conn.sendRawTransaction(raw, { skipPreflight: false });
    var landed = false;
    for (var w = 0; w < 60; w++) {
      var st = await c.conn.getSignatureStatus(sig, { searchTransactionHistory: true }).catch(function () { return null; });
      var v = st && st.value;
      if (v && v.err) throw new Error("The SOL → quote swap failed on chain.");
      if (v && (v.confirmationStatus === "confirmed" || v.confirmationStatus === "finalized")) { landed = true; break; }
      if (w % 5 === 4) c.conn.sendRawTransaction(raw, { skipPreflight: true, maxRetries: 5 }).catch(function () {});
      await new Promise(function (r) { setTimeout(r, 1000); });
    }
    if (!landed) throw new Error("SOL → quote swap not confirmed within 60s — signature: " + sig);
    var after = before;
    for (var i = 0; i < 6; i++) {
      after = await c.conn.getTokenAccountBalance(ata).then(function (r) { return BigInt(r.value.amount); }).catch(function () { return before; });
      if (after > before) break;
      await new Promise(function (r) { setTimeout(r, 800); });
    }
    var got = after - before;
    if (got <= 0n) throw new Error("Swap confirmed but no quote token arrived for the first buy.");
    return got;
  }

  async function launchToken(opts) {
    if (!LAUNCHLAB_LIVE()) throw new Error("LaunchLab launches are not enabled yet (audit-gated).");
    var c = await client();
    /* v0 + Address Lookup Table path (Phantom's Lighthouse flags a launch tx that
     * nears the 1232-byte limit; an ALT tables the static program accounts to shrink
     * it — the SDK's versionBuild merges Raydium's default mainnet ALTs, and we add
     * our own launchAlt of static LaunchLab accounts on top). v0 is the DEFAULT now
     * (Phantom flags near-limit LEGACY txs); ?txv0=0 forces the old LEGACY path. */
    var useV0 = true;
    try { if (typeof localStorage !== "undefined" && localStorage.getItem("wavesTxV0") === "0") useV0 = false; } catch (e) {}
    var progress = opts.onProgress || function () {};
    var q = resolveQuote(opts.quote);
    var configId = await configFor(opts.quote);
    var plat = platformIdForTier(opts.tier);
    var baseMint = c.X.Keypair.generate();
    /* H-3: only a dividend (or the dividend half of a split) carries the
     * Token-2022 transfer-fee tax that funds holder payouts. "none" and "burn"
     * mint a STANDARD SPL token — a creator who opted out of holder rewards must
     * never receive a taxed mint (RugCheck/GMGN auto-flag transfer-fee tokens),
     * and a buyback is funded from the fee share, not a transfer tax. */
    /* A PAIR funds holder rewards from the creator's TRADING-FEE share (routed to
     * the staking vault by the keeper, which is set as the pool's creator below),
     * NOT a Token-2022 transfer tax. So a pair mints a STANDARD token — no tax on
     * traders, platform (0.4%) + Raydium (0.25%) untouched, only the creator's 0.5%
     * is redirected. A pair is a launch with a paired collection + feeShare "vault". */
    var isPairLaunch = opts.feeShare === "vault" && !!opts.collection;
    var hasHolderTax = !isPairLaunch && (opts.rewardMode === "dividend" || opts.rewardMode === "split");

    /* Dev buy — LaunchLab needs > 0, denominated in the QUOTE. SOL/USDC quotes: the
     * first-buy field IS that quote. EXOTIC quote (stock / T-token): the launcher
     * holds SOL, not the quote, so HOP — swap the chosen SOL into the quote (a
     * separate Jupiter tx the wallet signs) and use what arrives as the dev buy. A
     * non-zero opening buy is mandatory, so a 0 field still hops a small default. */
    var devBuyRaw, curveOverride = null;
    var exoticQuote = q.mint !== WSOL && q.mint !== USDC;
    if (exoticQuote) {
      var solForBuy = Number(opts.firstBuySol) > 0 ? Number(opts.firstBuySol) : 0.02;
      var solLam = Math.floor(solForBuy * 1e9);
      var qProg = await quoteProgram(c.conn, c.X, q.mint);
      devBuyRaw = String(await hopSolForDevBuy(c, solLam, q.mint, qProg, progress));
      /* ⚠️ An exotic quote's config is PERMISSIONLESS — it is NOT in Raydium's config
       * API, so createLaunchpad can't read its defaultParams (crashes on
       * `Se.defaultParams`). Provide the curve explicitly: supply/totalSellA are the
       * standard 1B-supply / ~793M-on-curve values (token-side, quote-independent);
       * totalFundRaisingB is the graduation raise in QUOTE units, targeting the same
       * ~85 SOL of value the SOL config uses — derived from THIS launch's own SOL→
       * quote swap rate above, so no price oracle is needed. */
      var raiseB = solLam > 0 ? (85000000000n * BigInt(devBuyRaw)) / BigInt(solLam) : BigInt(devBuyRaw);
      curveOverride = {
        supply: new c.R.BN("1000000000000000"),
        totalSellA: new c.R.BN("793100000000000"),
        totalFundRaisingB: new c.R.BN(raiseB.toString()),
      };
    } else {
      devBuyRaw = rawAmount(opts.firstBuySol || 0, q.decimals);
      if (String(devBuyRaw) === "0") devBuyRaw = String(Math.pow(10, Math.max(0, q.decimals - 2)));
    }

    progress({ step: "pool", state: "signing" });
    var built = await c.raydium.launchpad.createLaunchpad(Object.assign({
      programId: c.prog,
      mintA: baseMint.publicKey,
      decimals: opts.decimals || 6,
      name: opts.name, symbol: opts.symbol, uri: opts.uri,
      configId: new c.X.PublicKey(configId),
      platformId: new c.X.PublicKey(plat),            // OUR platform on Raydium's config
      // Everything graduates to CPMM. T2022 (dividend/split) MUST; a standard-SPL
      // "none"/"burn" token also migrates cleanly via CPMM — proven end-to-end on
      // devnet 2026-09-13 (launch → curve complete → status 2). This retires the
      // untested AMM/OpenBook path the H-3 fix would otherwise have introduced, so
      // every launch uses one proven graduation path.
      migrateType: "cpmm",
      buyAmount: new c.R.BN(devBuyRaw),
      slippage: new c.R.BN(opts.slippageBps || 500),
      token2022: hasHolderTax,
      transferFeeExtensionParams: hasHolderTax ? {
        // the creator's chosen holder tax, threaded through; 1% is the default
        transferFeeBasePoints: opts.rewardBps || 100,
        // no per-transfer cap by design: 1e15 base units = full supply, so a
        // single transfer's percentage is never clamped — a pure-% dividend
        maxinumFee: new c.R.BN("1000000000000000")        // SDK's (mis)spelled key — keep as-is
      } : undefined,
      extraSigners: [baseMint],
      txVersion: useV0 ? c.R.TxVersion.V0 : c.R.TxVersion.LEGACY,
    }, curveOverride || {}));

    /* PAIR: the LAUNCHER stays the pool creator (clean — no foreign creator, so no
     * Phantom "malicious" drainer warning on the launch or on buys). The creator's
     * 0.5% accrues to the launcher, who ROUTES it to the staking vault from the
     * claim page after deploy — the post-launch "activate rewards" step (see
     * launchlab.js claimCreatorFeeToVault + the fee page). Standard launches
     * unchanged; a pair still mints a standard token (no transfer tax). */

    // the Arweave storage fee is a System transfer folded into the launch tx (paid
    // in SOL like the Meteora path). DUCK-TYPED {programId,keys,data} — the bundle
    // exports PublicKey but NOT TransactionInstruction/SystemProgram; Transaction.add
    // and compileToV0Message both coerce this shape, so it works in legacy AND v0.
    // System transfer = instruction index 2 + u64 lamports.
    var sfIx = null;
    if (opts.storageFee && opts.storageFee.to && opts.storageFee.lamports) {
      var lamports = BigInt(opts.storageFee.lamports);
      if (lamports > 0n) {
        var sdata = new Uint8Array(12);
        var sdv = new DataView(sdata.buffer);
        sdv.setUint32(0, 2, true); sdv.setBigUint64(4, lamports, true);
        sfIx = {
          programId: new c.X.PublicKey("11111111111111111111111111111111"),
          keys: [{ pubkey: c.owner, isSigner: true, isWritable: true },
                 { pubkey: new c.X.PublicKey(opts.storageFee.to), isSigner: false, isWritable: true }],
          data: sdata
        };
      }
    }

    var sig;
    if (useV0) {
      // Add the storage fee to the builder, rebuild the launch as ONE v0 tx (with
      // Raydium's default ALTs), then wallet-sign the versioned tx (buildV0 already
      // signed the base-mint keypair) and send it. Confirm by polling, like sendOne.
      if (sfIx) built.builder.addInstruction({ instructions: [sfIx] });
      sig = await sendV0Built(c, built, "The launch transaction");
    } else {
      // LEGACY (proven): fold the storage fee onto the last tx, send in order.
      if (sfIx) {
        var txs = built.transactions || (built.transaction ? [built.transaction] : []);
        var last = txs[txs.length - 1];
        if (last) last.instructions.push(sfIx);
      }
      sig = await sendBuilt(c, built, [baseMint]);
    }
    var poolPk = (built.extInfo && built.extInfo.address && built.extInfo.address.poolId)
      ? built.extInfo.address.poolId
      : c.R.getPdaLaunchpadPoolId(c.prog, baseMint.publicKey, new c.X.PublicKey(q.mint)).publicKey.toBase58();
    progress({ step: "pool", state: "done", mint: String(baseMint.publicKey) });

    // homepage listing — backend tagged so the keeper/stats/token page use the
    // LaunchLab client rather than the Meteora one.
    postListing("/api/tokens", {
      mint: String(baseMint.publicKey), name: opts.name, symbol: opts.symbol,
      rewardMint: opts.rewardMint || (opts.quote === "sol" ? null : q.mint), icon: opts.icon || null,
      banner: opts.banner || null, card: opts.card || null,
      collection: opts.collection || null, creator: String(c.owner),
      pool: String(poolPk), config: String(configId),
      feeShare: opts.feeShare || "keep", feeSharePct: opts.feeSharePct || 0,
      quote: opts.quote || "sol", feeWallet: opts.feeWallet || null,
      // the keeper services jobs by these fields — without them a fee tier or a
      // holder-reward launch is invisible to it. tier drives the ladder claim,
      // rewardMode drives dividend/burn/split, pairedCollection routes a pair's
      // reward into the staking vault (set only when the collection is a reward
      // pair, i.e. feeShare "vault", never for a plain minted-with collection).
      tier: opts.tier || "standard",
      rewardMode: opts.rewardMode || "none",
      pairedCollection: (opts.feeShare === "vault" ? (opts.collection || null) : null),
      burn: opts.burn || null,                       // per-NFT burn-to-activate (pairs)
      backend: "launchlab",
      chain: (window.Shell && window.Shell.chain) ? window.Shell.chain() : "solana",
      cluster: cluster()
    });

    return { mint: String(baseMint.publicKey), signature: sig, pool: String(poolPk),
             backend: "launchlab", cluster: cluster() };
  }

  /* Cheap SOL-balance guard, mirroring Token.assertEnoughSol — fail with a number
   * before the upload rather than at simulation. Rent + fee + the SOL dev buy (if
   * the quote is SOL). Rough floor; the launch tx is the real check. */
  async function assertEnoughSol(opts) {
    var w = window.Wallet && window.Wallet.current();
    if (!w) throw new Error("Connect a wallet first");
    var X = await mx();
    var conn = new X.Connection(rpcUrl(cluster()), "confirmed");
    var bal = await conn.getBalance(new X.PublicKey(w.publicKey));
    var need = 30000000;                               // ~0.03 SOL rent + priority + fees
    // the opening buy costs SOL for a SOL quote OR an exotic quote (which hops SOL →
    // quote); a USDC quote buys in USDC. An exotic quote with no amount hops ~0.02.
    var buySol = 0;
    if (opts.quote !== "usdc") {
      buySol = Number(opts.firstBuySol) > 0 ? Number(opts.firstBuySol)
        : (opts.quote && opts.quote !== "sol" ? 0.02 : 0);
    }
    need += Math.floor(buySol * 1e9);
    if (bal < need) {
      throw new Error("Not enough SOL — need about " + (need / 1e9).toFixed(3) +
        " SOL for rent, fees" + (buySol > 0 ? " and your first buy" : "") +
        ", have " + (bal / 1e9).toFixed(3) + ".");
    }
    return true;
  }

  /* ---- trade ----
   * buy/sellToken need the pool + config to price the swap and the mint token
   * programs (the base is Token-2022 for a dividend token, the quote is T2022 for
   * an xStock). Without them the SDK computes a 0 output ("amount should be gt 0")
   * or derives the wrong ATAs. Slippage is enforced on-chain from the config. */
  async function swap(baseMint, direction, amountInRaw, minOutRaw, poolHint) {
    var c = await client();
    var mintA = new c.X.PublicKey(baseMint);
    var poolId = poolHint ? new c.X.PublicKey(poolHint)
      : c.R.getPdaLaunchpadPoolId(c.prog, mintA, new c.X.PublicKey(WSOL)).publicKey;
    var pAcc = await c.conn.getAccountInfo(poolId);
    if (!pAcc) throw new Error("pool not found");
    var poolInfo = c.R.LaunchpadPool.decode(pAcc.data);
    var configInfo = c.R.LaunchpadConfig.decode((await c.conn.getAccountInfo(poolInfo.configId)).data);
    var mintB = poolInfo.mintB;
    var mintAProgram = new c.X.PublicKey(poolInfo.mintProgramFlag === 1 ? TOKEN2022 : TOKENKEG);
    var mintBProgram = new c.X.PublicKey(await quoteProgram(c.conn, c.X, mintB.toBase58()));
    // v0 by default (Phantom flags near-limit LEGACY txs); ?txv0=0 forces LEGACY.
    var useV0Trade = true;
    try { if (typeof localStorage !== "undefined" && localStorage.getItem("wavesTxV0") === "0") useV0Trade = false; } catch (e) {}
    var common = {
      programId: c.prog, mintA: mintA, mintB: mintB,
      poolInfo: poolInfo, configInfo: configInfo,
      mintAProgram: mintAProgram, mintBProgram: mintBProgram,
      slippage: new c.R.BN(100),
      txVersion: useV0Trade ? c.R.TxVersion.V0 : c.R.TxVersion.LEGACY,
    };
    var built = (direction === "buy")
      ? await c.raydium.launchpad.buyToken(Object.assign({ buyAmount: new c.R.BN(String(amountInRaw)) }, common))
      : await c.raydium.launchpad.sellToken(Object.assign({ sellAmount: new c.R.BN(String(amountInRaw)) }, common));
    return useV0Trade ? sendV0Built(c, built, "The " + direction + " transaction") : sendBuilt(c, built);
  }

  /* ---- pay-in-SOL for a token priced in a stock/token quote ----
   *
   * A LaunchLab curve only accepts its QUOTE mint, so a token priced in e.g. NVDAx
   * can only be bought by someone holding NVDAx. This lets anyone buy with SOL: one
   * atomic transaction that swaps SOL→quote on Jupiter and then buys on the curve,
   * signed once. The two are composed into a single v0 tx so the buy can never land
   * without the swap that funds it (and vice-versa) — no stranded quote dust from a
   * half-done hop, no second approval.
   *
   * `solLamports` is how much SOL the buyer spends. The curve buy uses Jupiter's
   * GUARANTEED minimum output (otherAmountThreshold) as its buyAmount, so the quote
   * ATA is certain to hold enough when the buy instruction runs; any surplus from a
   * better-than-worst-case fill stays in the buyer's quote ATA (≤ the slippage
   * band). Buy-only — selling still returns the quote asset.
   *
   * ⚠️ NOT yet exercised in-browser against a real non-SOL pool. The composition is
   * correct by construction (buy instructions come from the SDK, not hand-derived),
   * but the one hard constraint is TRANSACTION SIZE: a Jupiter route with many hops
   * plus the curve buy's 18 accounts can exceed the 1232-byte limit. maxAccounts is
   * pinned low to keep routes simple; a route that still doesn't fit throws cleanly
   * ("route too large") rather than sending a broken tx. */
  async function buyWithSol(baseMint, solLamports, poolHint) {
    var c = await client();
    var mintA = new c.X.PublicKey(baseMint);
    var poolId = poolHint ? new c.X.PublicKey(poolHint)
      : c.R.getPdaLaunchpadPoolId(c.prog, mintA, new c.X.PublicKey(WSOL)).publicKey;
    var pAcc = await c.conn.getAccountInfo(poolId);
    if (!pAcc) throw new Error("pool not found");
    var poolInfo = c.R.LaunchpadPool.decode(pAcc.data);
    var mintB = poolInfo.mintB.toBase58();
    // already SOL-quoted → no hop needed, take the normal buy path
    if (mintB === WSOL) return swap(baseMint, "buy", String(solLamports), "0", poolId.toBase58());
    var mintBProgram = await quoteProgram(c.conn, c.X, mintB);
    /* An exotic quote's SOL→quote route is a 2-hop swap whose accounts, plus the
     * curve buy's own, overrun a single 1232-byte transaction (composing them threw
     * "encoding overruns Uint8Array", and there is no smaller route — a direct
     * SOL→quote pool doesn't exist). So do it in TWO txs, exactly like the launch
     * dev-buy: swap SOL→quote in Jupiter's own tx (its ALTs cover the route), then
     * buy on the curve with what actually arrived (v0 + our launchAlt). Two
     * signatures, but each fits and neither leg can silently overflow. */
    var got = await hopSolForDevBuy(c, solLamports, mintB, mintBProgram, function () {});
    return swap(baseMint, "buy", String(got), "0", poolId.toBase58());
  }

  /* Build a create-associated-token-account-IDEMPOTENT instruction by hand (the
   * browser bundle doesn't ship @solana/spl-token). ATA program ix 1 = idempotent;
   * accounts: payer(signer,writable), ata(writable), owner, mint, systemProgram,
   * tokenProgram. The ATA address is the standard PDA [owner, tokenProgram, mint]. */
  function ataIdempotentIx(X, owner, mint, tokenProgram) {
    var ATA = new X.PublicKey("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");
    var SYS = new X.PublicKey("11111111111111111111111111111111");
    var ata = X.PublicKey.findProgramAddressSync(
      [owner.toBuffer(), tokenProgram.toBuffer(), mint.toBuffer()], ATA)[0];
    return new X.TransactionInstruction({
      programId: ATA,
      keys: [
        { pubkey: owner, isSigner: true, isWritable: true },
        { pubkey: ata, isSigner: false, isWritable: true },
        { pubkey: owner, isSigner: false, isWritable: false },
        { pubkey: mint, isSigner: false, isWritable: false },
        { pubkey: SYS, isSigner: false, isWritable: false },
        { pubkey: tokenProgram, isSigner: false, isWritable: false },
      ],
      data: new Uint8Array([1]),
    });
  }

  // base64 → Uint8Array, without a global Buffer (not polyfilled in the browser).
  function b64ToBytes(b64) {
    var bin = atob(b64);
    var u = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
    return u;
  }

  /* Estimate the tokens a SOL-funded buy would yield: SOL→quote on Jupiter, then
   * the curve's spot price. Display figure only (the real buy is slippage-protected
   * on both legs). Returns { out: tokens, quoteOut: humanQuote } or nulls on no route. */
  async function estimateBuyWithSol(baseMint, solLamports, poolHint) {
    var m = await readMarket(baseMint, poolHint);
    if (!m || !m.price || !m.quoteMint) return { out: 0, quoteOut: 0 };
    if (m.quoteMint === WSOL) return getQuote(baseMint, solLamports / 1e9, "buy", poolHint);
    var jq = await (await fetch("https://lite-api.jup.ag/swap/v1/quote?inputMint=" + WSOL +
      "&outputMint=" + m.quoteMint + "&amount=" + String(solLamports) +
      "&slippageBps=100&restrictIntermediateTokens=true&maxAccounts=32")).json();
    if (!jq || !jq.outAmount) return { out: 0, quoteOut: 0 };
    var quoteHuman = Number(jq.outAmount) / Math.pow(10, m.quoteDec || 8);
    return { out: quoteHuman / m.price, quoteOut: quoteHuman };
  }

  /* ---- read-only market state (no wallet) ---- */
  async function readPool(baseMint, poolHint) {
    var R = await ray(), X = await mx();
    var conn = new X.Connection(rpcUrl(cluster()), "confirmed");
    var prog = cluster() === "devnet" ? R.DEV_LAUNCHPAD_PROGRAM : R.LAUNCHPAD_PROGRAM;
    var poolId = poolHint ? new X.PublicKey(poolHint)
      : R.getPdaLaunchpadPoolId(prog, new X.PublicKey(baseMint), new X.PublicKey(WSOL)).publicKey;
    var acc = await conn.getAccountInfo(poolId);
    // A caller-supplied poolHint may be a Meteora pool (that's the token's pool
    // in its listing record, whatever backend launched it). Its bytes decode
    // into a garbage-but-truthy LaunchpadPool struct, which made backend
    // detection on the token page flip Meteora tokens to "launchlab" and read
    // their fees through the wrong path ($MOAR/$VROOM showed "N quote"). Only an
    // account OWNED by the LaunchLab program is actually one of our pools.
    if (!acc || !acc.owner || !acc.owner.equals(prog)) return null;
    var p = R.LaunchpadPool.decode(acc.data);
    return {
      pool: poolId.toBase58(),
      mintA: p.mintA.toBase58(), mintB: p.mintB.toBase58(),
      platformId: p.platformId.toBase58(), configId: p.configId.toBase58(),
      realB: p.realB.toString(), virtualB: p.virtualB.toString(),
      totalFundRaisingB: p.totalFundRaisingB.toString(),
      protocolFee: p.protocolFee.toString(), platformFee: p.platformFee.toString(),
      status: p.status, migrateType: p.migrateType, mintProgramFlag: p.mintProgramFlag,
      // curve progress toward graduation, 0..1. Guard the denominator: a
      // non-empty "0" string is truthy so `|| 1` never fired, and a pool read
      // before totalFundRaisingB is set divided by zero → NaN.
      progress: Number(p.totalFundRaisingB.toString()) > 0
        ? Number(p.realB.toString()) / Number(p.totalFundRaisingB.toString())
        : 0,
    };
  }
  // symbol for a quote mint, for display
  function quoteSymForMint(mint) {
    if (mint === WSOL) return "SOL";
    if (mint === USDC) return "USDC";
    var q = (llConfigs().quotes || {})[mint];
    return q ? q.symbol : "quote";
  }

  /* Live market state for a launched token, matching Token.readMarket's shape so
   * the token page needs no per-backend consumption code. price is quote-per-
   * token; mcap is price * supply in QUOTE units (the page converts to USD with
   * the quote's price, same as the Meteora path). Curve.getPrice is verified
   * against a live pool in this repo's fee-check tooling. */
  async function readMarket(baseMint, poolHint) {
    var R = await ray(), X = await mx();
    var conn = new X.Connection(rpcUrl(cluster()), "confirmed");
    var prog = cluster() === "devnet" ? R.DEV_LAUNCHPAD_PROGRAM : R.LAUNCHPAD_PROGRAM;
    var poolId = poolHint ? new X.PublicKey(poolHint)
      : R.getPdaLaunchpadPoolId(prog, new X.PublicKey(baseMint), new X.PublicKey(WSOL)).publicKey;
    var acc = await conn.getAccountInfo(poolId);
    // Not ours unless owned by the LaunchLab program — a Meteora poolHint's
    // bytes would otherwise decode into a bogus market. See readPool.
    if (!acc || !acc.owner || !acc.owner.equals(prog)) return null;
    var p = R.LaunchpadPool.decode(acc.data);
    var decA = p.mintDecimalsA, decB = p.mintDecimalsB;

    var price = null, endPrice = null;
    try {
      price = Number(R.Curve.getPrice({ poolInfo: p, curveType: p.curveType || 0,
        decimalA: decA, decimalB: decB }).toString());
    } catch (e) { /* price stays null, page says so */ }
    // the price the curve reaches when it graduates — for the graduation mcap.
    // getPoolEndPriceReal is the actual end price (getEndPrice returns the init
    // price, ~= spot, which gave a nonsense graduation mcap below the raise).
    try {
      endPrice = Number(R.Curve.getPoolEndPriceReal({ poolInfo: p, curveType: p.curveType || 0,
        decimalA: decA, decimalB: decB }).toString());
    } catch (e) {}

    var raised = Number(p.realB.toString()) / Math.pow(10, decB);
    var threshold = Number(p.totalFundRaisingB.toString()) / Math.pow(10, decB);
    var supply = Number(p.supply.toString()) / Math.pow(10, decA);
    // status 0 = trading on the curve; a completed/migrated curve reports a
    // non-zero status, and raised >= threshold is the same signal.
    var migrated = (p.status !== 0) || (threshold > 0 && raised >= threshold);

    return {
      pool: poolId.toBase58(),
      migrated: migrated,
      raised: raised,
      threshold: threshold,
      progress: threshold > 0 ? Math.min(1, raised / threshold) : 0,
      price: price,
      supply: supply,
      mcap: (price != null) ? price * supply : null,
      // market cap the token reaches at graduation (end price × supply, in quote
      // units) — what "graduates at" should show, not the USD value of the raise.
      gradMcap: (endPrice != null) ? endPrice * supply : null,
      quote: quoteSymForMint(p.mintB.toBase58()),
      quoteMint: p.mintB.toBase58(),         // for the SOL-pay hop (buyWithSol)
      quoteDec: decB,
      creator: p.creator.toBase58()
    };
  }

  /* The connected wallet's balance of the token, for the sell box. Same as
   * Token.balanceOf but derives the ATA with the mint's ACTUAL token program —
   * a LaunchLab dividend token is Token-2022, so its ATA seed differs from a
   * classic SPL token's. Reads the account directly (public nodes refuse indexed
   * balance lookups); the amount is a u64 LE at byte 64 in both layouts. */
  var ATA_PROGRAM = "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL";
  async function balanceOf(baseMint) {
    var X = await mx();
    var w = window.Wallet && window.Wallet.current();
    if (!w) return null;
    try {
      var conn = new X.Connection(rpcUrl(cluster()), "confirmed");
      var mint = new X.PublicKey(baseMint);
      var owner = new X.PublicKey(w.publicKey);
      var mi = await conn.getAccountInfo(mint);
      var prog = (mi && mi.owner && mi.owner.toBase58() === TOKEN2022) ? TOKEN2022 : TOKENKEG;
      var ata = X.PublicKey.findProgramAddressSync(
        [owner.toBuffer(), new X.PublicKey(prog).toBuffer(), mint.toBuffer()],
        new X.PublicKey(ATA_PROGRAM))[0];
      var info = await conn.getAccountInfo(ata);
      if (!info || !info.data) return 0;
      var d = info.data;
      var buf = d.buffer ? d : new Uint8Array(d);
      var dv = new DataView(buf.buffer, buf.byteOffset || 0, buf.byteLength);
      var raw = dv.getBigUint64(64, true);
      var dec = (mi && mi.data && mi.data.length > 44) ? mi.data[44] : 6;   // mint decimals byte
      return Number(raw) / Math.pow(10, dec);
    } catch (e) { return 0; }
  }

  /* ---- claim our platform fee ----
   * The platform trading fee sits in the platform's fee vault (a token account
   * for the quote mint), NOT in pool.platformFee. claimPlatformFee sweeps it to
   * platformClaimFeeWallet. Keeper-side, not creator-side. */
  async function claimPlatformFeesTo(quoteMint, poolHint) {
    var c = await client();
    var built = await c.raydium.launchpad.claimPlatformFee({
      programId: c.prog,
      platformId: new c.X.PublicKey(platformId()),
      // the platform config's claim wallet is fixed at creation = feeOwner; the
      // Raydium program rejects a claim to anyone else. Was c.owner (the connected
      // wallet), which would revert — match claimPartnerFeesTo.
      platformClaimFeeWallet: new c.X.PublicKey(window.BRAND.feeOwner),
      poolId: new c.X.PublicKey(poolHint),
      mintB: new c.X.PublicKey(quoteMint),
      txVersion: c.R.TxVersion.LEGACY,
    });
    return sendBuilt(c, built);
  }

  /* token programs — classic SPL vs Token-2022 (xStock quotes are T2022) */
  var TOKENKEG = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
  var TOKEN2022 = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";

  /* The quote's token program is NOT "SOL/USDC = TokenKeg, everything else = T2022"
   * — that only held while xStocks were the only exotic quote. SPL coin quotes
   * (JUP, WBTC, WETH, BONK, the majors) are TokenKeg; tokenised stocks are
   * Token-2022. Read the mint owner, the authoritative source, or swap()/claim()
   * derive the wrong ATAs and the tx fails. */
  async function quoteProgram(conn, X, mintStr) {
    if (mintStr === WSOL || mintStr === USDC) return TOKENKEG;
    var acc = await conn.getAccountInfo(new X.PublicKey(mintStr));
    return (acc && acc.owner && acc.owner.toBase58() === TOKEN2022) ? TOKEN2022 : TOKENKEG;
  }
  // read a pool's quote mint + its token program, for the claim/fee paths
  async function poolQuote(conn, X, R, prog, poolHint, baseMint) {
    var poolId = poolHint ? new X.PublicKey(poolHint)
      : R.getPdaLaunchpadPoolId(prog, new X.PublicKey(baseMint), new X.PublicKey(WSOL)).publicKey;
    var acc = await conn.getAccountInfo(poolId);
    if (!acc) return null;
    var p = R.LaunchpadPool.decode(acc.data);
    var mintB = p.mintB.toBase58();
    var mintBProgram = await quoteProgram(conn, X, mintB);   // SPL coins vs T2022 stocks
    return { poolId: poolId, mintB: mintB, mintBProgram: mintBProgram, pool: p };
  }

  /* ---- fee claim, matching Token.claimPartnerFeesTo / claimCreatorFeesTo ----
   * On LaunchLab the receiver isn't free-form: the PLATFORM fee always claims to
   * the platform's fixed claim wallet (feeOwner), and the CREATOR fee to the
   * pool creator's ATA. So `receiver` is honoured only where the program allows
   * it (it doesn't here) — the keeper calls these, and the destination is what
   * the platform/pool was created with. */
  async function claimPartnerFeesTo(baseMint, receiver, poolHint) {
    var c = await client();
    var pq = await poolQuote(c.conn, c.X, c.R, c.prog, poolHint, baseMint);
    if (!pq) throw new Error("pool not found");
    var built = await c.raydium.launchpad.claimPlatformFee({
      programId: c.prog, platformId: new c.X.PublicKey(platformId()),
      platformClaimFeeWallet: new c.X.PublicKey(window.BRAND.feeOwner),
      poolId: pq.poolId, mintB: new c.X.PublicKey(pq.mintB),
      mintBProgram: new c.X.PublicKey(pq.mintBProgram),
      txVersion: c.R.TxVersion.LEGACY,
    });
    return sendBuilt(c, built);
  }
  async function claimCreatorFeesTo(baseMint, receiver, poolHint) {
    var c = await client();
    var pq = await poolQuote(c.conn, c.X, c.R, c.prog, poolHint, baseMint);
    if (!pq) throw new Error("pool not found");
    var built = await c.raydium.launchpad.claimCreatorFee({
      programId: c.prog, mintB: new c.X.PublicKey(pq.mintB),
      mintBProgram: new c.X.PublicKey(pq.mintBProgram),
      txVersion: c.R.TxVersion.LEGACY,
    });
    return sendBuilt(c, built);
  }

  var STAKE_PROGRAM = "jt5JegTBVPZP8V6a48fnKYPFKTbpcTfkz91Pemur82H";
  var ATA_PROGRAM = "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL";
  // ATA for (mint, owner) under a token program — derived by hand (no spl-token in browser)
  function ataFor(X, mint, owner, tokenProgram) {
    return X.PublicKey.findProgramAddressSync(
      [new X.PublicKey(owner).toBuffer(), new X.PublicKey(tokenProgram).toBuffer(), new X.PublicKey(mint).toBuffer()],
      new X.PublicKey(ATA_PROGRAM))[0];
  }
  // SPL/Token-2022 TransferChecked (ix 12): [source(w), mint, dest(w), owner(signer)].
  // Returns a DUCK-TYPED {programId,keys,data} — Transaction.add coerces it; the
  // browser bundle does NOT export TransactionInstruction (would throw "not a
  // constructor"), same gotcha as stake.js.
  function transferCheckedIx(X, tokenProgram, source, mint, dest, owner, amount, decimals) {
    var d = new Uint8Array(10); d[0] = 12;
    new DataView(d.buffer).setBigUint64(1, BigInt(amount), true); d[9] = decimals;
    return {
      programId: new X.PublicKey(tokenProgram),
      keys: [{ pubkey: source, isSigner: false, isWritable: true },
             { pubkey: new X.PublicKey(mint), isSigner: false, isWritable: false },
             { pubkey: dest, isSigner: false, isWritable: true },
             { pubkey: new X.PublicKey(owner), isSigner: true, isWritable: false }],
      data: d };
  }

  /* PAIR reward distribution — the creator's "activate rewards" action.
   *
   * The launcher IS the pool creator (kept clean so Phantom shows no drainer flag),
   * so the keeper can't claim their 0.5%. The creator does it here, in ONE
   * signature: claim the accrued creator fee (in the quote), deposit it into the
   * collection's staking vault, and sync so holders' pending updates. They run this
   * whenever they want to pay holders. Supports pairs whose reward IS the quote
   * (SOL/USDC); a stock-reward pair needs a swap step (coming). Returns { sig,
   * amount } — amount is the base-unit quote distributed. */
  async function distributeToVault(baseMint, collection, poolHint) {
    var c = await client();
    var pq = await poolQuote(c.conn, c.X, c.R, c.prog, poolHint, baseMint);
    if (!pq) throw new Error("pool not found");
    var quote = pq.mintB, quoteProg = pq.mintBProgram;

    // the collection's staking pool + its real vault + reward mint (from chain)
    var STAKE = new c.X.PublicKey(STAKE_PROGRAM);
    var spool = c.X.PublicKey.findProgramAddressSync(
      [new TextEncoder().encode("pool"), new c.X.PublicKey(baseMint).toBuffer(), new c.X.PublicKey(collection).toBuffer()], STAKE)[0];
    var spoolAcc = await c.conn.getAccountInfo(spool);
    if (!spoolAcc) {
      // first activation: create the reward pool (vault = the quote, since we
      // distribute the claimed quote directly). Lazy-load the staking client.
      if (!window.WavesStake) await new Promise(function (res, rej) {
        var s = document.createElement("script"); s.src = "/stake.js";
        s.onload = res; s.onerror = function () { rej(new Error("could not load the staking client")); };
        document.head.appendChild(s);
      });
      await window.WavesStake.initPool({ tokenMint: baseMint, collection: collection, rewardMint: quote });
      spoolAcc = await c.conn.getAccountInfo(spool);
      if (!spoolAcc) throw new Error("Could not create the reward pool — try again.");
    }
    var vaultRewardMint = new c.X.PublicKey(spoolAcc.data.slice(72, 104)).toBase58();
    var vault = new c.X.PublicKey(spoolAcc.data.slice(104, 136));
    if (vaultRewardMint !== quote) throw new Error("This pair's reward isn't its quote asset — stock/token-reward distribution is coming soon.");

    // accrued creator fee = the creator vault's balance (creator = the launcher)
    var creatorVault = c.X.PublicKey.findProgramAddressSync(
      [c.owner.toBuffer(), new c.X.PublicKey(quote).toBuffer()], c.prog)[0];
    var bal = await c.conn.getTokenAccountBalance(creatorVault).catch(function () { return null; });
    var accrued = bal ? BigInt(bal.value.amount) : 0n;
    if (accrued <= 0n) throw new Error("Nothing new to distribute — you've already sent all accrued fees to the vault. Trade the pair to build up more, then distribute again.");

    // claim (creator signs) → owner's quote ATA, then move the accrued to the vault + sync, one tx
    var built = await c.raydium.launchpad.claimCreatorFee({
      programId: c.prog, mintB: new c.X.PublicKey(quote),
      mintBProgram: new c.X.PublicKey(quoteProg), txVersion: c.R.TxVersion.LEGACY,
    });
    var claimTx = built.transaction || (built.transactions && built.transactions[0]);
    var ownerAta = ataFor(c.X, quote, c.owner, quoteProg);
    var dec = pq.pool.mintDecimalsB;

    var tx = new c.X.Transaction();
    claimTx.instructions.forEach(function (ix) { tx.add(ix); });
    tx.add(transferCheckedIx(c.X, quoteProg, ownerAta, quote, vault, c.owner, accrued, dec));
    tx.add({   // WavesStake sync — duck-typed (no TransactionInstruction in the bundle)
      programId: STAKE,
      keys: [{ pubkey: spool, isSigner: false, isWritable: true }, { pubkey: vault, isSigner: false, isWritable: false }],
      data: new Uint8Array([4, 219, 40, 164, 21, 157, 189, 88]),
    });
    var sig = await sendOne(c, tx, built.signers || []);
    return { sig: sig, amount: accrued.toString() };
  }

  /* Accrued fees for the fees page. partner = our platform fee in the platform
   * vault; creator = the connected wallet's claimable trading fee. */
  async function feeMetrics(baseMint, poolHint) {
    var R = await ray(), X = await mx();
    var conn = new X.Connection(rpcUrl(cluster()), "confirmed");
    var prog = cluster() === "devnet" ? R.DEV_LAUNCHPAD_PROGRAM : R.LAUNCHPAD_PROGRAM;
    var pq = await poolQuote(conn, X, R, prog, poolHint, baseMint);
    if (!pq) return { creator: 0, partner: 0, quote: "quote", quoteDec: 9 };
    var decB = pq.pool.mintDecimalsB;
    var partner = 0;
    try {
      var pv = R.getPdaPlatformVault(prog, new X.PublicKey(platformId()), new X.PublicKey(pq.mintB)).publicKey;
      var bal = await conn.getTokenAccountBalance(pv).catch(function () { return null; });
      partner = bal ? Number(bal.value.amount) / Math.pow(10, decB) : 0;
    } catch (e) {}
    /* The creator's 0.5% accrues to a per-creator, per-quote vault PDA
     * ([creator, quoteMint] under the program), NOT the pool — so it reads only
     * for a known creator. The connected wallet IS the creator of its own
     * launches, and this is exactly the balance claimCreatorFee would take
     * (same derivation as distributeToVault). Zero before a wallet connects or
     * for a viewer who isn't the creator. ⚠️ The vault aggregates every pool this
     * creator launched against the same quote, so two same-quote launches show —
     * and claim — the same combined total; fine for the common one-per-quote case. */
    var creator = 0;
    try {
      var w = window.Wallet && window.Wallet.current();
      if (w && w.publicKey) {
        var cv = X.PublicKey.findProgramAddressSync(
          [new X.PublicKey(w.publicKey).toBuffer(), new X.PublicKey(pq.mintB).toBuffer()], prog)[0];
        var cbal = await conn.getTokenAccountBalance(cv).catch(function () { return null; });
        creator = cbal ? Number(cbal.value.amount) / Math.pow(10, decB) : 0;
      }
    } catch (e) {}
    return { creator: creator, partner: partner, quote: quoteSymForMint(pq.mintB), quoteDec: decB };
  }

  /* Live trade quote for the trade box. Spot-price estimate (quote-per-token);
   * the actual fill is protected by swap()'s on-chain slippage, so this is a
   * display figure, not the enforced minimum. Shape matches Token.getQuote. */
  async function getQuote(baseMint, amount, direction, poolHint) {
    var m = await readMarket(baseMint, poolHint);
    if (!m || !m.price) return { out: 0, minOut: "0", amountIn: "0" };
    var out, amountInRaw;
    if (direction === "buy") {                 // quote in, base out
      out = amount / m.price;
      amountInRaw = rawAmount(amount, resolveQuote(m.quote === "SOL" ? "sol" : (m.quote === "USDC" ? "usdc" : baseMint)).decimals);
    } else {                                    // base in, quote out
      out = amount * m.price;
      amountInRaw = rawAmount(amount, 6);      // base decimals (launch default 6)
    }
    return { out: out, minOut: "0", amountIn: String(amountInRaw) };
  }

  /* Recent trades for the chart. TODO: decode swaps from the pool's signature
   * history (the indexer already does this backend-agnostically for its stored
   * stats). Returns [] for now so the page renders and falls back to the
   * indexer's aggregate data rather than erroring. */
  async function recentTrades(baseMint, poolHint, limit) { return []; }

  /* Whether holder rewards are on = the launched token is a dividend token
   * (Token-2022 with the transfer-fee extension). Reads the mint's owner. */
  async function rewardsActive(poolHint, mint) {
    try {
      var X = await mx();
      var conn = new X.Connection(rpcUrl(cluster()), "confirmed");
      var info = await conn.getAccountInfo(new X.PublicKey(mint));
      return !!(info && info.owner && info.owner.toBase58() === TOKEN2022);
    } catch (e) { return false; }
  }

  /* Token name/symbol/uri from the Metaplex metadata PDA — backend-agnostic
   * (reads the mint's metadata account). Returns null for a Token-2022 token
   * that carries its metadata in the mint extension instead; the page falls
   * back to its listing record. */
  async function onchainIdentity(mintStr) {
    try {
      var X = await mx();
      var conn = new X.Connection(rpcUrl(cluster()), "confirmed");
      var MD = new X.PublicKey("metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s");
      var mint = new X.PublicKey(mintStr);
      var pda = X.PublicKey.findProgramAddressSync(
        [new TextEncoder().encode("metadata"), MD.toBuffer(), mint.toBuffer()], MD)[0];
      var info = await conn.getAccountInfo(pda);
      if (!info || !info.data) {
        /* No Metaplex PDA — a Token-2022 dividend token carries its metadata
         * inline in the mint's TokenMetadata extension (TLV type 19). Parse it so
         * the page shows the real name + image even with no listing record. */
        try {
          var mi = await conn.getAccountInfo(new X.PublicKey(mintStr));
          if (mi && mi.owner && mi.owner.toBase58() === TOKEN2022 && mi.data && mi.data.length > 166) {
            var _d = mi.data.buffer ? new Uint8Array(mi.data.buffer, mi.data.byteOffset, mi.data.byteLength) : new Uint8Array(mi.data);
            var _v = new DataView(_d.buffer, _d.byteOffset, _d.byteLength);
            var _o = 166;
            while (_o + 4 <= _d.length) {
              var _t = _v.getUint16(_o, true), _l = _v.getUint16(_o + 2, true), _s = _o + 4;
              if (_t === 19) {
                var _p = _s + 64;                       // updateAuthority(32) + mint(32)
                var _rd = function () { var n = _v.getUint32(_p, true); _p += 4; var r = new TextDecoder().decode(_d.subarray(_p, _p + n)); _p += n; return r.trim(); };
                return { name: _rd(), symbol: _rd(), uri: _rd() };
              }
              _o = _s + _l;
            }
          }
        } catch (e2) { /* fall through */ }
        return null;
      }
      var d = info.data;
      var b = d.buffer ? new Uint8Array(d.buffer, d.byteOffset, d.byteLength) : new Uint8Array(d);
      var dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
      var off = 1 + 32 + 32;
      function str() {
        var len = dv.getUint32(off, true); off += 4;
        var raw = new TextDecoder().decode(b.subarray(off, off + len)); off += len;
        return raw.replace(/ +$/, "").trim();
      }
      return { name: str(), symbol: str(), uri: str() };
    } catch (e) { return null; }
  }

  /* ---- helpers ---- */
  function rawAmount(human, decimals) {
    // integer raw units as a string, no float drift
    var s = String(human).trim().toLowerCase();
    if (s[0] === "+") s = s.slice(1);
    if (s[0] === "-") return "0";                     // a negative amount is invalid, not a magnitude
    // expand scientific notation ("1e-7", "2.5e3") — a number input can produce
    // it, and BN rejects "1e-7000000000" once the exponent is appended below
    var e = s.indexOf("e");
    if (e >= 0) {
      var mant = s.slice(0, e), exp = parseInt(s.slice(e + 1), 10) || 0;
      var mp = mant.split("."); var digits = (mp[0] || "0") + (mp[1] || "");
      var point = (mp[0] || "0").length + exp;
      if (point <= 0) s = "0." + "0".repeat(-point) + digits;
      else if (point >= digits.length) s = digits + "0".repeat(point - digits.length);
      else s = digits.slice(0, point) + "." + digits.slice(point);
    }
    var parts = s.split("."); var whole = parts[0] || "0"; var frac = parts[1] || "";
    frac = (frac + "0".repeat(decimals)).slice(0, decimals);
    var out = (whole + frac).replace(/^0+/, "") || "0";
    return out;
  }
  function postListing(url, body) {
    try {
      fetch(url, { method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify(body) }).catch(function () {});
    } catch (e) { /* a listing failure must never surface on a successful launch */ }
  }

  // audit gate — per-cluster (devnet can be on for testing while mainnet stays
  // off until audit). Accepts either a boolean or a {cluster: bool} object.
  function LAUNCHLAB_LIVE() {
    try {
      var v = window.BRAND && window.BRAND.launchlabLive;
      if (v && typeof v === "object") return !!v[cluster()];
      return !!v;
    } catch (e) { return false; }
  }

  window.LaunchLab = {
    // launch-flow surface, mirroring window.Token where launchpanel.js calls it
    launchToken: launchToken,
    assertEnoughSol: assertEnoughSol,
    configKey: function () { try { return configKey(); } catch (e) { return null; } },
    configFor: configFor,
    quotes: quotes,
    rwaQuotes: rwaQuotes,
    // trade / read
    swap: swap,
    buyWithSol: buyWithSol,        // atomic SOL→quote hop + curve buy (non-SOL quotes)
    estimateBuyWithSol: estimateBuyWithSol,
    getQuote: getQuote,
    balanceOf: balanceOf,
    readPool: readPool,
    readMarket: readMarket,
    recentTrades: recentTrades,
    rewardsActive: rewardsActive,
    onchainIdentity: onchainIdentity,
    // fees
    feeMetrics: feeMetrics,
    claimCreatorFeesTo: claimCreatorFeesTo,
    distributeToVault: distributeToVault,   // pair "activate rewards": creator fee → staking vault
    claimPartnerFeesTo: claimPartnerFeesTo,
    claimPlatformFeesTo: claimPlatformFeesTo,
    platformId: function () { try { return platformId(); } catch (e) { return null; } },
    live: LAUNCHLAB_LIVE,
    // routing helper for launchpanel.js: is a quote registered here?
    handlesQuote: function (quote) {
      if (!quote || quote === "sol" || quote === "usdc") return true;
      return !!((llConfigs().quotes || {})[quote]);
    },
  };
})();
