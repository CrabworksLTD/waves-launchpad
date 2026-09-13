(function () {
  "use strict";
  /* The chain half of a launch. No UI in here — launchpanel.js drives it and
   * this reports progress through a callback.
   *
   * The sequence, which is also what tools/devnet-smoke.js proves headlessly:
   *
   *   1. upload art + metadata to Arweave      (storage.js)
   *   2. create a Core collection               — royalties live here
   *   3. create a Candy Machine over it         — guards live here
   *   4. insert config lines in batches         — one name+uri per token
   *   5. hand back the mint page address
   *
   * Steps 2-4 are Metaplex programs. Nothing of ours is deployed, which is why
   * the six Solidity contracts on the Robinhood side have no counterpart.
   */

  var CLUSTERS = {
    // NOT api.mainnet-beta.solana.com — Solana's public endpoint 403s
    // browser-origin requests; publicnode serves them
    /* Our passthrough — a free public node drops large sends (see api/rpc.js).
     * Absolute: web3's Connection and umi both reject a relative path. */
    "mainnet-beta": { rpc: window.location.origin + "/api/rpc", label: "Mainnet", explorer: "" },
    devnet:         { rpc: "https://api.devnet.solana.com",       label: "Devnet",  explorer: "?cluster=devnet" },
    // the local mainnet-clone validator (see memory: sunpad-chain-testing)
    localnet:       { rpc: "http://127.0.0.1:8899",               label: "Localnet", explorer: "?cluster=custom&customUrl=http%3A%2F%2F127.0.0.1%3A8899" }
  };
  // Overridable so a self-hosted or paid RPC can be dropped in without a build.
  var cluster = (window.BRAND && window.BRAND.cluster) || "mainnet-beta";

  var mxMod = null;
  function metaplex() {
    if (!mxMod) mxMod = import("/vendor/metaplex.esm.js");
    return mxMod;
  }

  /* Adapt window.Wallet into the wallet-adapter shape umi expects. Doing the
   * adaptation here rather than inside wallet.js keeps wallet.js honest about
   * what the browser actually gave us, and puts the lossy conversion in one
   * visible place.
   *
   * The awkward part: Wallet Standard signs serialized bytes, injected
   * providers sign transaction objects, and umi hands us a web3.js
   * VersionedTransaction either way. So the standard path serialises on the way
   * in and deserialises on the way out. */
  /* Confirmation, done by asking rather than waiting.
   *
   * web3's confirmTransaction watches a websocket subscription and gives up at
   * the blockhash's last valid block height. Against our RPC that verdict is
   * wrong in the worst direction: three storage payments landed on chain and
   * every one of them was reported to the creator as "block height exceeded",
   * so a launch died after the money moved — and a naive retry pays twice.
   *
   * Polling getSignatureStatus over plain HTTP asks the chain the only
   * question that matters: is this signature there? It costs a request every
   * 1.2s and cannot be wrong about a transaction that landed.
   *
   * Installed on the umi instance, so every sendAndConfirm in this file and in
   * the launch panel gets it without a call-site change. */
  function usePolledConfirm(mx, umi, rpcUrl) {
    var conn = new mx.Connection(rpcUrl, "confirmed");

    /* Solana drops transactions. A validator under load will accept a send and
     * never gossip it, and nothing retries on its own — which is how a launch
     * gets "Creating collection ✓, candy machine ✓, items ✓" and then loses
     * the last step to silence. Keep the signed bytes from the send and
     * re-broadcast them while we wait: the network dedupes by signature, so
     * repeating is free and only the first landing counts. */
    var lastRaw = null, lastHash = null;
    var send = umi.rpc.sendTransaction.bind(umi.rpc);
    umi.rpc.sendTransaction = function (tx, options) {
      try { lastRaw = umi.transactions.serialize(tx); } catch (e) { lastRaw = null; }
      // kept so the confirm loop can tell a slow transaction from a dead one
      try { lastHash = tx.message.blockhash; } catch (e) { lastHash = null; }
      return send(tx, Object.assign({ maxRetries: 5 }, options || {}));
    };

    umi.rpc.confirmTransaction = async function (signature, options) {
      var sig = typeof signature === "string"
        ? signature : mx.base58.deserialize(signature)[0];
      var started = Date.now();
      var deadline = started + 120000;
      var missing = 0, resent = 0;
      while (Date.now() < deadline) {
        // Say what is happening. Polling in silence for two minutes is
        // indistinguishable from a hang, and the last thing a creator needs
        // after signing a payment is a dialog that looks dead.
        if (typeof window.Launch.onWait === "function") {
          var secs = Math.round((Date.now() - started) / 1000);
          window.Launch.onWait("confirming " + secs + "s" +
            (resent ? " · re-sent " + resent + "x" : ""));
        }
        var st = null;
        try { st = await conn.getSignatureStatus(sig, { searchTransactionHistory: true }); }
        catch (e) { st = null; }
        var v = st && st.value;
        if (v && v.err) {
          throw new Error("The transaction failed on chain: " + JSON.stringify(v.err));
        }
        if (v && (v.confirmationStatus === "confirmed" || v.confirmationStatus === "finalized")) {
          return { context: { slot: v.slot || 0 }, value: { err: null } };
        }
        if (!v) {
          missing++;
          // every ~6s of not seeing it, put it back on the wire
          if (lastRaw && missing % 12 === 0) {
            /* An expired blockhash makes re-sending pointless — the RPC takes
             * it, the leader drops it, and the loop keeps counting up at a
             * signature that can never land. Stop as soon as that is certain
             * rather than at the two-minute mark. */
            if (lastHash) {
              var live = true;
              try { live = (await conn.isBlockhashValid(lastHash, { commitment: "confirmed" })).value; }
              catch (e) { live = true; }
              if (!live) {
                throw new Error("The wallet took long enough to approve that the " +
                  "transaction expired before it reached the chain. Nothing was " +
                  "charged for it — try that step again.");
              }
            }
            try {
              await conn.sendRawTransaction(lastRaw, { skipPreflight: true, maxRetries: 5 });
              resent++;
            } catch (e) {}
          }
        }
        await new Promise(function (r) { setTimeout(r, 500); });
      }
      throw new Error("Timed out waiting for " + sig.slice(0, 8) +
        "… to confirm. It may still land — check the explorer before retrying.");
    };
    return umi;
  }

  function asAdapter(mx, w) {
    var isStandard = !!w._account;
    return {
      publicKey: new mx.PublicKey(w.publicKey),
      signMessage: function (bytes) { return w.signMessage(bytes); },
      signTransaction: function (tx) {
        if (!isStandard) return w.signTransaction(tx);
        return w.signTransaction(tx.serialize()).then(function (bytes) {
          return mx.VersionedTransaction.deserialize(bytes);
        });
      },
      signAllTransactions: function (txs) {
        if (!isStandard) return w.signAllTransactions(txs);
        return w.signAllTransactions(txs.map(function (t) { return t.serialize(); }))
          .then(function (list) {
            return list.map(function (b) { return mx.VersionedTransaction.deserialize(b); });
          });
      }
    };
  }

  async function connectUmi() {
    var w = window.Wallet.current();
    if (!w) throw new Error("Connect a wallet first");
    var mx = await metaplex();
    var conf = CLUSTERS[cluster] || CLUSTERS["mainnet-beta"];
    // "confirmed", not umi's "finalized" default — at finalized, a strictly
    // sequential deploy (collection then machine) simulates against a bank
    // where its own previous step does not exist yet. See devnet-smoke.js.
    var umi = mx.createUmi(conf.rpc, "confirmed")
      .use(mx.mplCore())
      .use(mx.mplCandyMachine())
      .use(mx.walletAdapterIdentity(asAdapter(mx, w)));
    usePolledConfirm(mx, umi, conf.rpc);
    return { mx: mx, umi: umi, conf: conf };
  }

  /* Config lines are inserted in batches because each one is transaction bytes
   * and a Solana transaction is capped at 1232. Ten is conservative but safe
   * across every uri length we produce; pushing it higher trades a handful of
   * transactions for launches that fail partway through with half a machine
   * loaded, which is a far worse failure than being slow. */
  var LINES_PER_TX = 10;

  /* The prefix trick. Config lines store `prefixName`/`prefixUri` once on the
   * machine and only the differing tail per item, so a 10,000 piece collection
   * stores "1".."10000" and "1.json".."10000.json" rather than the full string
   * ten thousand times. nameLength/uriLength must be the LONGEST tail, or an
   * insert past that length is rejected. */
  function lineSettings(mx, name, baseUri, supply) {
    var maxIdx = String(supply);
    return mx.some({
      prefixName: name.slice(0, 32 - maxIdx.length - 2) + " #",
      nameLength: maxIdx.length,
      prefixUri: baseUri,
      uriLength: maxIdx.length + 5,          // "<n>.json"
      isSequential: false                    // random order; sequential leaks the rarity order
    });
  }

  /* Guard assembly. Defaults apply to every group; a group's own guards
   * override same-named defaults. So price, per-wallet cap and bot tax live in
   * defaults, while each allowlist wave is a group carrying only its list and
   * its opening time — the Moonpad wave ladder, expressed as Candy Guard
   * groups. Group labels are capped at 6 chars by the program. */
  function buildGuards(mx, opts) {
    var defaults = {};
    if (opts.priceSol > 0) {
      defaults.solPayment = mx.some({
        lamports: mx.sol(opts.priceSol),
        destination: mx.publicKey(opts.treasury || opts._identity)
      });
    }
    if (opts.maxPerWallet > 0) {
      defaults.mintLimit = mx.some({ id: 1, limit: opts.maxPerWallet });
    }
    // Failed guard checks pay a token tax instead of being free — the standard
    // bot deterrent. lastInstruction stops wrapping the mint in a bigger tx to
    // dodge it.
    defaults.botTax = mx.some({ lamports: mx.sol(0.01), lastInstruction: true });

    var openAt = opts.openAt ? new Date(opts.openAt) : new Date();
    if (!opts.waves || !opts.waves.phases || !opts.waves.phases.length) {
      if (opts.openAt) defaults.startDate = mx.some({ date: mx.dateTime(openAt) });
      return { guards: defaults, groups: [], base: openAt, waveMinutes: 0 };
    }

    var waveMs = (opts.waves.minutes || 0) * 60000;
    var groups = opts.waves.phases.map(function (p, i) {
      var startDate = mx.some({ date: mx.dateTime(new Date(openAt.getTime() + i * waveMs)) });
      var guards;
      if (p.kind === "nft") {
        /* Hold ≥1 NFT from the collection. Metaplex nftGate is membership-only,
         * so a collection's `min` above 1 is not enforceable here — a holder is
         * a holder. (The signer-gated EVM path honours min exactly.) */
        guards = { nftGate: mx.some({ requiredCollection: mx.publicKey(p.address) }), startDate: startDate };
      } else if (p.kind === "coin") {
        /* Hold ≥ `amountBase` of the token, in the mint's base units — computed
         * from the mint's real decimals in deploy() before this runs. */
        guards = { tokenGate: mx.some({ mint: mx.publicKey(p.address), amount: p.amountBase }), startDate: startDate };
      } else {
        guards = { allowList: mx.some({ merkleRoot: mx.getMerkleRoot(p.wallets) }), startDate: startDate };
      }
      return { label: p.label.slice(0, 6), guards: guards };
    });
    groups.push({
      label: "pub",
      guards: {
        startDate: mx.some({
          date: mx.dateTime(new Date(openAt.getTime() + opts.waves.phases.length * waveMs))
        })
      }
    });
    return { guards: defaults, groups: groups, base: openAt, waveMinutes: opts.waves.minutes || 0 };
  }

  async function deploy(opts) {
    var progress = opts.onProgress || function () {};
    var c = await connectUmi();
    var mx = c.mx, umi = c.umi;

    var supply = opts.supply;
    var royaltyBps = Math.round((opts.royaltyPercent || 5) * 100);
    opts._identity = umi.identity.publicKey;

    /* THREE signatures for a normal launch (five with dev mints), and Phantom-
     * SAFE — where naive batching was not. Folding the deploy into one
     * signAllTransactions was tried and blocked (2026-09-03): Phantom simulates
     * each tx in a batch against CURRENT state, so the machine tx (referencing
     * the not-yet-created collection) failed and the request was flagged. The
     * fix is not to batch dependent transactions but to put dependent steps
     * INSIDE one transaction — a single tx runs its instructions in order, which
     * Phantom simulates correctly:
     *   1. collection + createCandyGuard in ONE tx (the guard is a PDA of the
     *      machine's address, so it needs only the pubkey, not the account).
     *   2. machine + wrap in ONE tx (wrap sees the machine created earlier in
     *      the same tx). Skipped when there are dev mints — see below.
     *   3. all config lines, batched via signAllTransactions — the ONE thing it
     *      is safe for: independent txs that each reference the existing machine.
     * Verified end to end on devnet by tools/deploy-combine-smoke.js. ⚠️ Never
     * put a DEPENDENT tx in the batch — that is the thing that gets blocked. */

    /* signAllTransactions for INDEPENDENT txs only (config lines, dev mints —
     * each references the already-existing machine). Falls back to one-at-a-time
     * for wallets without it; each is a valid single tx. */
    async function batch(items) {
      items = items.filter(Boolean);
      if (!items.length) return;
      if (typeof umi.identity.signAllTransactions !== "function") {
        for (var i = 0; i < items.length; i++) {
          await items[i].b.sendAndConfirm(umi, { confirm: { commitment: "confirmed" } });
        }
        return;
      }
      var CAP = 12;                                  // blockhash-window safety
      for (var s = 0; s < items.length; s += CAP) {
        var chunk = items.slice(s, s + CAP);
        var bh = await umi.rpc.getLatestBlockhash();
        var unsigned = [];
        for (var j = 0; j < chunk.length; j++) {
          var tx = chunk[j].b.setBlockhash(bh).build(umi);
          var sgs = chunk[j].signers || [];
          for (var k = 0; k < sgs.length; k++) tx = await sgs[k].signTransaction(tx);
          unsigned.push(tx);
        }
        var signed = await umi.identity.signAllTransactions(unsigned);
        for (var n = 0; n < signed.length; n++) {
          var sig = await umi.rpc.sendTransaction(signed[n], { maxRetries: 5 });
          await umi.rpc.confirmTransaction(sig, {
            strategy: { type: "blockhash", blockhash: bh.blockhash, lastValidBlockHeight: bh.lastValidBlockHeight },
            commitment: "confirmed"
          });
        }
      }
    }

    var collection = mx.generateSigner(umi);
    var candyMachine = mx.generateSigner(umi);
    /* Token gates need the threshold in the mint's own base units, so read each
     * token's real decimals from the chain rather than assuming 18/9. Done here,
     * before buildGuards (which is sync), and cached on the phase. */
    if (opts.waves && opts.waves.phases) {
      for (var pIdx = 0; pIdx < opts.waves.phases.length; pIdx++) {
        var ph = opts.waves.phases[pIdx];
        if (ph.kind === "coin" && ph.amountBase == null) {
          var sup = await rpcCall("getTokenSupply", [String(ph.address)]).catch(function () { return null; });
          var dec = Number((sup && sup.value && sup.value.decimals) || 0);
          ph.amountBase = BigInt(Math.round(Number(ph.min) * Math.pow(10, dec)));
        }
      }
    }
    var built = buildGuards(mx, opts);
    var candyGuard = mx.findCandyGuardPda(umi, { base: candyMachine.publicKey });
    var devMints = (opts.devMints || []).filter(function (d) { return d.count > 0; });
    var devTotal = devMints.reduce(function (a, d) { return a + d.count; }, 0);

    /* ---- 1. collection + guard, one signature ---- */
    progress({ step: "collection", state: "signing" });
    await mx.createCollection(umi, {
      collection: collection,
      name: opts.name,
      uri: opts.collectionUri,
      plugins: [{
        type: "Royalties",
        basisPoints: royaltyBps,
        // A royalty wallet override becomes the sole creator; otherwise the launcher.
        creators: [{
          address: opts.royaltyTo ? mx.publicKey(opts.royaltyTo) : umi.identity.publicKey,
          percentage: 100
        }],
        // None means marketplaces are asked, not forced — enforcing breaks transfers.
        ruleSet: { __kind: "None" }
      }]
    })
      .add(mx.createCandyGuard(umi, { base: candyMachine, guards: built.guards, groups: built.groups }))
      .sendAndConfirm(umi, { confirm: { commitment: "confirmed" } });
    progress({ step: "collection", state: "done", address: collection.publicKey });

    /* ---- 2. the machine, wrapped in the SAME tx when there are no dev mints.
     * With dev mints the wrap is deferred, because a dev mint needs US as the
     * mint authority — the wrap hands it to the guard. ---- */
    progress({ step: "machine", state: "signing" });
    var cmBuilder = await mx.createCandyMachine(umi, {
      candyMachine: candyMachine,
      collection: collection.publicKey,
      collectionUpdateAuthority: umi.identity,
      itemsAvailable: supply,
      authority: umi.identity.publicKey,
      isMutable: true,
      configLineSettings: lineSettings(mx, opts.name, opts.baseUri, supply)
    });
    if (devTotal === 0) {
      cmBuilder = cmBuilder.add(mx.wrap(umi, { candyGuard: candyGuard, candyMachine: candyMachine.publicKey }));
    }
    await cmBuilder.sendAndConfirm(umi, { confirm: { commitment: "confirmed" } });
    progress({ step: "machine", state: "done", address: candyMachine.publicKey });

    /* ---- 3. config lines, batched (one signature; a few for a huge set) ---- */
    progress({ step: "lines", state: "signing" });
    var lineOps = [];
    var total = Math.ceil(supply / LINES_PER_TX);
    for (var b = 0; b < total; b++) {
      var start = b * LINES_PER_TX;
      var lines = [];
      for (var i = start; i < Math.min(start + LINES_PER_TX, supply); i++) {
        var id = i + 1;
        lines.push({ name: String(id), uri: id + ".json" });
      }
      lineOps.push({ b: mx.addConfigLines(umi, { candyMachine: candyMachine.publicKey, index: start, configLines: lines }), signers: [] });
    }
    await batch(lineOps);
    var cm = await mx.fetchCandyMachine(umi, candyMachine.publicKey);
    if (Number(cm.itemsLoaded) !== supply) {
      throw new Error("Loaded " + cm.itemsLoaded + " of " + supply +
        " items. The collection is deployed but not fully loaded — do not announce it yet.");
    }
    progress({ step: "lines", state: "done", loaded: cm.itemsLoaded });

    /* ---- 4. dev mints (batched), then the wrap (only when there are dev mints) ---- */
    if (devTotal > 0) {
      progress({ step: "dev", state: "signing", batches: devTotal });
      var devOps = [];
      for (var di = 0; di < devMints.length; di++) {
        for (var k = 0; k < devMints[di].count; k++) {
          var devAsset = mx.generateSigner(umi);
          var mb = (await mx.mintAssetFromCandyMachine(umi, {
            candyMachine: candyMachine.publicKey,
            mintAuthority: umi.identity,
            asset: devAsset,
            assetOwner: mx.publicKey(devMints[di].to || umi.identity.publicKey),
            collection: collection.publicKey
          })).prepend(mx.setComputeUnitLimit(umi, { units: 800000 }));
          devOps.push({ b: mb, signers: [devAsset] });
        }
      }
      await batch(devOps);                           // independent mints, one approval
      progress({ step: "dev", state: "done", minted: devTotal });
      // wrap on its own: it changes the mint authority, so keep it a plain single
      // tx Phantom simulates cleanly rather than bundling it with the mints
      progress({ step: "guard", state: "signing" });
      await mx.wrap(umi, { candyGuard: candyGuard, candyMachine: candyMachine.publicKey })
        .sendAndConfirm(umi, { confirm: { commitment: "confirmed" } });
    }
    progress({ step: "guard", state: "done" });

    return {
      collection: String(collection.publicKey),
      candyMachine: String(candyMachine.publicKey),
      cluster: cluster,
      devMinted: devTotal,
      groups: built.groups.map(function (g) { return g.label; }),
      openAt: built.base.toISOString(),
      waveMinutes: built.waveMinutes,
      explorer: "https://explorer.solana.com/address/" + candyMachine.publicKey + c.conf.explorer,
      mintUrl: location.origin + "/mint/" + candyMachine.publicKey
    };
  }

  /* Mint one, used by the mint page. Kept here so the guard argument shapes
   * live next to the guard definitions they have to mirror — they are set at
   * deploy time and read at mint time, and drift between the two is the single
   * easiest way to ship a machine nobody can mint from. */
  /* Mint one, used by the mint page.
   *
   * With guard groups, minting is two moves: a `route` call proving the wallet
   * is on the group's allowlist (writes a per-wallet proof PDA), then mintV1
   * against that group. `opts.group` names the group and `opts.wallets` is the
   * group's full pinned list — the proof is built client-side from it, which
   * is fine because the list is public by design (_allowlist.json).
   * Ungrouped machines mint exactly as before. */
  async function mintOne(candyMachineAddress, opts) {
    opts = opts || {};
    var c = await connectUmi();
    var mx = c.mx, umi = c.umi;

    var cm = await mx.fetchCandyMachine(umi, mx.publicKey(candyMachineAddress));
    var guard = await mx.fetchCandyGuard(umi, cm.mintAuthority);

    var hasGroups = guard.groups && guard.groups.length > 0;
    if (hasGroups && !opts.group) {
      throw new Error("This mint runs in phases — the page has to pick your phase first.");
    }
    var set = guard.guards;                       // defaults
    var groupSet = null;
    if (hasGroups) {
      var g = guard.groups.find(function (x) { return x.label === opts.group; });
      if (!g) throw new Error("No phase named " + opts.group);
      groupSet = g.guards;
    }
    function guardVal(name) {
      // group overrides default, per candy guard semantics
      if (groupSet && groupSet[name] && groupSet[name].__option === "Some") return groupSet[name].value;
      if (set[name] && set[name].__option === "Some") return set[name].value;
      return null;
    }

    var mintArgs = {};
    var pay = guardVal("solPayment");
    if (pay) mintArgs.solPayment = mx.some({ destination: pay.destination });
    var lim = guardVal("mintLimit");
    if (lim) mintArgs.mintLimit = mx.some({ id: lim.id });

    var allow = groupSet && groupSet.allowList && groupSet.allowList.__option === "Some"
      ? groupSet.allowList.value : null;
    if (allow) {
      if (!opts.wallets || !opts.wallets.length) {
        throw new Error("This phase is allowlisted and the list could not be loaded.");
      }
      // prove membership first — the mint reads the proof PDA the route wrote
      await mx.route(umi, {
        candyMachine: cm.publicKey,
        candyGuard: cm.mintAuthority,
        guard: "allowList",
        group: mx.some(opts.group),
        routeArgs: {
          path: "proof",
          merkleRoot: allow.merkleRoot,
          merkleProof: mx.getMerkleProof(opts.wallets, String(umi.identity.publicKey))
        }
      }).sendAndConfirm(umi, { confirm: { commitment: "confirmed" } });
      mintArgs.allowList = mx.some({ merkleRoot: allow.merkleRoot });
    }

    /* Token gate — the minter's ATA for `mint` is derived by the program, so the
     * only arg is the mint itself. */
    var tokg = guardVal("tokenGate");
    if (tokg) mintArgs.tokenGate = mx.some({ mint: tokg.mint });
    /* NFT gate — the minter must present a specific NFT they hold from the
     * required collection; the page finds a qualifying one and passes it. */
    var nftg = guardVal("nftGate");
    if (nftg) {
      if (!opts.gateNft) throw new Error("This phase is for a collection's holders — a qualifying NFT is required.");
      mintArgs.nftGate = mx.some({ mint: mx.publicKey(opts.gateNft) });
    }

    var asset = mx.generateSigner(umi);
    var builder = await mx.mintV1(umi, {
      candyMachine: cm.publicKey,
      asset: asset,
      collection: cm.collectionMint,
      group: hasGroups ? mx.some(opts.group) : undefined,
      mintArgs: mintArgs
    });
    // Core mints run past the 200k default; without this the failure reads
    // like a program bug instead of an out-of-compute.
    await builder.prepend(mx.setComputeUnitLimit(umi, { units: 800000 }))
                 .sendAndConfirm(umi, { confirm: { commitment: "confirmed" } });

    // A confirmed transaction is NOT a successful mint. With botTax armed, a
    // guard rejection lands as a successful tx that charges the tax and mints
    // nothing — telling the buyer "Minted!" on that tx is the worst message a
    // mint page can show. Only the asset existing is proof.
    var exists = await mx.fetchAsset(umi, asset.publicKey)
      .then(function () { return true; }).catch(function () { return false; });
    if (!exists) {
      throw new Error("The mint was refused by the sale rules (wrong phase, " +
        "not on the allowlist, over the wallet limit, or not open yet). " +
        "A small bot-protection fee was charged.");
    }
    return { asset: String(asset.publicKey) };
  }

  /* Mint several in ONE wallet prompt.
   *
   * The candy machine mints a single asset per instruction and a Core mint is
   * heavy enough that packing several into one transaction is not reliable —
   * so a run of ten really is ten transactions. What it does not have to be is
   * ten approvals: wallets implement signAllTransactions, so we build the whole
   * batch, sign it once, and broadcast. Minting ten used to mean clicking
   * approve ten times.
   *
   * Everything that can fail is done before the prompt: the machine and guard
   * are fetched once instead of per mint, and the allowlist proof rides along
   * as the first transaction in the same batch rather than as its own popup.
   *
   * Wallets that do not implement signAllTransactions fall back to the old
   * one-at-a-time path, which still works — it just asks more often. */
  async function mintMany(candyMachineAddress, opts, count, onProgress) {
    opts = opts || {};
    var qty = Math.max(1, count || 1);
    var progress = onProgress || function () {};
    if (qty === 1) {
      progress({ phase: "sign", done: 0, total: 1 });
      var one = await mintOne(candyMachineAddress, opts);
      progress({ phase: "done", done: 1, total: 1 });
      return [one.asset];
    }

    var c = await connectUmi();
    var mx = c.mx, umi = c.umi;

    if (typeof umi.identity.signAllTransactions !== "function") {
      var out = [];
      for (var k = 0; k < qty; k++) {
        progress({ phase: "sign", done: k, total: qty });
        out.push((await mintOne(candyMachineAddress, opts)).asset);
      }
      progress({ phase: "done", done: qty, total: qty });
      return out;
    }

    var cm = await mx.fetchCandyMachine(umi, mx.publicKey(candyMachineAddress));
    var guard = await mx.fetchCandyGuard(umi, cm.mintAuthority);
    var hasGroups = guard.groups && guard.groups.length > 0;
    if (hasGroups && !opts.group) {
      throw new Error("This mint runs in phases — the page has to pick your phase first.");
    }
    var set = guard.guards, groupSet = null;
    if (hasGroups) {
      var g = guard.groups.find(function (x) { return x.label === opts.group; });
      if (!g) throw new Error("No phase named " + opts.group);
      groupSet = g.guards;
    }
    function guardVal(name) {
      if (groupSet && groupSet[name] && groupSet[name].__option === "Some") return groupSet[name].value;
      if (set[name] && set[name].__option === "Some") return set[name].value;
      return null;
    }

    var mintArgs = {};
    var pay = guardVal("solPayment");
    if (pay) mintArgs.solPayment = mx.some({ destination: pay.destination });
    var lim = guardVal("mintLimit");
    if (lim) mintArgs.mintLimit = mx.some({ id: lim.id });

    var allow = groupSet && groupSet.allowList && groupSet.allowList.__option === "Some"
      ? groupSet.allowList.value : null;

    progress({ phase: "build", done: 0, total: qty });
    var blockhash = await umi.rpc.getLatestBlockhash();
    var builders = [];

    if (allow) {
      if (!opts.wallets || !opts.wallets.length) {
        throw new Error("This phase is allowlisted and the list could not be loaded.");
      }
      builders.push({
        asset: null,
        b: mx.route(umi, {
          candyMachine: cm.publicKey, candyGuard: cm.mintAuthority,
          guard: "allowList", group: mx.some(opts.group),
          routeArgs: {
            path: "proof", merkleRoot: allow.merkleRoot,
            merkleProof: mx.getMerkleProof(opts.wallets, String(umi.identity.publicKey))
          }
        })
      });
      mintArgs.allowList = mx.some({ merkleRoot: allow.merkleRoot });
    }

    var tokgM = guardVal("tokenGate");
    if (tokgM) mintArgs.tokenGate = mx.some({ mint: tokgM.mint });
    var nftgM = guardVal("nftGate");
    if (nftgM) {
      if (!opts.gateNft) throw new Error("This phase is for a collection's holders — a qualifying NFT is required.");
      mintArgs.nftGate = mx.some({ mint: mx.publicKey(opts.gateNft) });
    }

    for (var i = 0; i < qty; i++) {
      var asset = mx.generateSigner(umi);
      var b = await mx.mintV1(umi, {
        candyMachine: cm.publicKey, asset: asset, collection: cm.collectionMint,
        group: hasGroups ? mx.some(opts.group) : undefined, mintArgs: mintArgs
      });
      builders.push({ asset: asset, b: b.prepend(mx.setComputeUnitLimit(umi, { units: 800000 })) });
    }

    /* Sign the batch: each transaction's own asset keypair signs silently
     * first, then the wallet signs all of them in one approval. */
    var unsigned = [];
    for (var j = 0; j < builders.length; j++) {
      var built = builders[j].b.setBlockhash(blockhash).build(umi);
      if (builders[j].asset) built = await builders[j].asset.signTransaction(built);
      unsigned.push(built);
    }
    progress({ phase: "sign", done: 0, total: qty });
    var signed = await umi.identity.signAllTransactions(unsigned);

    /* Broadcast one at a time. The allowlist proof must land before the mints
     * that read it, and a candy machine mints in sequence anyway. */
    progress({ phase: "send", done: 0, total: qty });
    var minted = [];
    for (var n = 0; n < signed.length; n++) {
      var sig = await umi.rpc.sendTransaction(signed[n], { maxRetries: 5 });
      await umi.rpc.confirmTransaction(sig, {
        strategy: { type: "blockhash", blockhash: blockhash.blockhash,
                    lastValidBlockHeight: blockhash.lastValidBlockHeight },
        commitment: "confirmed"
      });
      if (builders[n].asset) {
        minted.push(String(builders[n].asset.publicKey));
        progress({ phase: "send", done: minted.length, total: qty });
      }
    }

    /* Same rule as a single mint: a confirmed transaction is not a successful
     * mint. With botTax armed a rejection lands as a paid, empty transaction,
     * so only the asset existing counts. */
    var confirmedAssets = [];
    for (var q = 0; q < minted.length; q++) {
      var ok = await mx.fetchAsset(umi, mx.publicKey(minted[q]))
        .then(function () { return true; }).catch(function () { return false; });
      if (ok) confirmedAssets.push(minted[q]);
    }
    if (!confirmedAssets.length) {
      throw new Error("The mint was refused by the sale rules (wrong phase, " +
        "not on the allowlist, over the wallet limit, or not open yet). " +
        "A small bot-protection fee was charged.");
    }
    progress({ phase: "done", done: confirmedAssets.length, total: qty });
    return confirmedAssets;
  }

  async function readMachine(candyMachineAddress) {
    var c = await connectUmi().catch(async function () {
      // The mint page has to show supply and price before anyone connects.
      var mx = await metaplex();
      var conf = CLUSTERS[cluster] || CLUSTERS["mainnet-beta"];
      return { mx: mx, umi: mx.createUmi(conf.rpc, "confirmed").use(mx.mplCore()).use(mx.mplCandyMachine()), conf: conf };
    });
    var mx = c.mx, umi = c.umi;
    var cm = await mx.fetchCandyMachine(umi, mx.publicKey(candyMachineAddress));
    var guard = await mx.fetchCandyGuard(umi, cm.mintAuthority);
    function optVal(set, name) {
      return set && set[name] && set[name].__option === "Some" ? set[name].value : null;
    }
    var pay = optVal(guard.guards, "solPayment");
    var price = pay ? Number(pay.lamports.basisPoints) / 1e9 : null;
    var open = optVal(guard.guards, "startDate");

    // The metadata directory, straight from the machine's config. Prefix
    // compression stores the base uri once here (prefixUri) rather than in each
    // item, so cm.items[i].uri is not a reliable full URL to strip a dir from.
    // This is the authoritative source for where _allowlist.json / _collection
    // .json live; the mint page reads it before falling back to an item uri.
    var cls = cm.data && cm.data.configLineSettings;
    var prefixUri = cls && cls.__option === "Some" ? cls.value.prefixUri
      : (cls && cls.prefixUri) || null;

    // Phases, for grouped machines: each wave is a group with an allowlist
    // and an opening time; "pub" is the ungated tail. The wallet lists behind
    // the merkle roots are pinned as _allowlist.json next to the metadata.
    var groups = (guard.groups || []).map(function (g) {
      var gp = optVal(g.guards, "solPayment");
      var sd = optVal(g.guards, "startDate");
      return {
        // Candy-guard labels are a fixed 6-byte field; umi reads them back
        // null-padded ("w1\0\0\0\0"), which never == the pinned "w1" and would
        // break every wave->phase match. Strip the padding so labels are clean.
        label: String(g.label == null ? "" : g.label).replace(/[\u0000\s]+$/g, ""),
        opensAt: sd ? Number(sd.date) * 1000 : null,
        priceSol: gp ? Number(gp.lamports.basisPoints) / 1e9 : price,
        allowlisted: !!optVal(g.guards, "allowList")
      };
    });

    return {
      collection: String(cm.collectionMint),
      available: Number(cm.data.itemsAvailable),
      redeemed: Number(cm.itemsRedeemed),
      loaded: Number(cm.itemsLoaded),
      priceSol: price,
      opensAt: open ? Number(open.date) * 1000 : null,
      groups: groups,
      firstItemUri: (cm.items && cm.items[0] && cm.items[0].uri) || null,
      prefixUri: prefixUri,
      collection: cm.collectionMint ? String(cm.collectionMint) : null,
      authority: String(cm.authority)
    };
  }

  /* ── holdership, for collection/token allowlist waves ────────────────────────
   * A gated wave lets holders of a collection or token mint. The guard enforces
   * it on-chain, but the mint page still has to know whether YOU qualify (to pick
   * your wave) and, for an NFT gate, WHICH asset to present. Both read through
   * the same /api/rpc passthrough the rest of the launcher uses. */
  function rpcUrl() { return (CLUSTERS[cluster] || CLUSTERS["mainnet-beta"]).rpc; }
  async function rpcCall(method, params) {
    var r = await fetch(rpcUrl(), {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: method, params: params })
    });
    var j = await r.json();
    if (j.error) throw new Error(j.error.message || "rpc error");
    return j.result;
  }
  // ≥ minHuman of an SPL mint, summed across the owner's accounts, in its decimals.
  async function holdsToken(owner, mint, minHuman) {
    var res = await rpcCall("getTokenAccountsByOwner",
      [String(owner), { mint: String(mint) }, { encoding: "jsonParsed" }]).catch(function () { return null; });
    if (!res || !res.value) return false;
    var total = 0n, dec = 0;
    res.value.forEach(function (a) {
      var ta = a.account.data.parsed.info.tokenAmount;
      dec = ta.decimals; total += BigInt(ta.amount);
    });
    return total >= BigInt(Math.round(Number(minHuman || 1) * Math.pow(10, dec)));
  }
  // An asset the owner holds from `collection` (Core/DAS grouping), or null. Used
  // both to qualify the wave and as the nftGate `mint` to present.
  async function heldFromCollection(owner, collection, minCount) {
    var res = await rpcCall("getAssetsByOwner",
      [{ ownerAddress: String(owner), page: 1, limit: 1000 }]).catch(function () { return null; });
    if (!res || !res.items) return null;
    var mine = res.items.filter(function (it) {
      return (it.grouping || []).some(function (g) {
        return g.group_key === "collection" && g.group_value === String(collection);
      });
    });
    return mine.length >= (minCount || 1) ? mine[0].id : null;
  }

  window.Launch = {
    // Exported so every wallet-to-Metaplex bridge on the site is THIS one.
    // The launch panel had its own copy that passed the wallet's {serialize}
    // shim straight back to the adapter, which reads .message.version off it
    // — a launch died there after the storage payment was already signed.
    asAdapter: asAdapter,
    usePolledConfirm: usePolledConfirm,
    onWait: null,   // set by the launch panel to surface waiting states
    deploy: deploy,
    mintOne: mintOne,
    mintMany: mintMany,
    holdsToken: holdsToken,
    heldFromCollection: heldFromCollection,
    readMachine: readMachine,
    cluster: function (name) { if (name) cluster = name; return cluster; },
    clusters: CLUSTERS
  };
})();
