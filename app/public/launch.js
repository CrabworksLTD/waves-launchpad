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
    "mainnet-beta": { rpc: "https://api.mainnet-beta.solana.com", label: "Mainnet", explorer: "" },
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
      return {
        label: p.label.slice(0, 6),
        guards: {
          allowList: mx.some({ merkleRoot: mx.getMerkleRoot(p.wallets) }),
          startDate: mx.some({ date: mx.dateTime(new Date(openAt.getTime() + i * waveMs)) })
        }
      };
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

    /* ---- 1. collection ---- */
    progress({ step: "collection", state: "signing" });
    var collection = mx.generateSigner(umi);
    await mx.createCollection(umi, {
      collection: collection,
      name: opts.name,
      uri: opts.collectionUri,
      plugins: [{
        type: "Royalties",
        basisPoints: royaltyBps,
        // A royalty wallet override becomes the sole creator; otherwise the
        // launching wallet. (Supply splits are dev mints, not royalty splits —
        // matching Moonpad, where the royalty wallet was singular.)
        creators: [{
          address: opts.royaltyTo ? mx.publicKey(opts.royaltyTo) : umi.identity.publicKey,
          percentage: 100
        }],
        // None means marketplaces are asked, not forced. Enforcing breaks
        // transfers on every venue that has not adopted the rule set.
        ruleSet: { __kind: "None" }
      }]
    }).sendAndConfirm(umi, { confirm: { commitment: "confirmed" } });
    progress({ step: "collection", state: "done", address: collection.publicKey });

    /* ---- 2. the machine, WITHOUT its guard ----
     * Composed rather than using the create() wrapper, because creator supply
     * needs mintAssetFromCandyMachine, and that requires the mint authority to
     * still be us. The guard takes over only after the dev mints are done. */
    progress({ step: "machine", state: "signing" });
    var candyMachine = mx.generateSigner(umi);
    await (await mx.createCandyMachine(umi, {
      candyMachine: candyMachine,
      collection: collection.publicKey,
      collectionUpdateAuthority: umi.identity,
      itemsAvailable: supply,
      authority: umi.identity.publicKey,
      isMutable: true,
      configLineSettings: lineSettings(mx, opts.name, opts.baseUri, supply)
    })).sendAndConfirm(umi, { confirm: { commitment: "confirmed" } });
    progress({ step: "machine", state: "done", address: candyMachine.publicKey });

    /* ---- 3. config lines ---- */
    var total = Math.ceil(supply / LINES_PER_TX);
    for (var b = 0; b < total; b++) {
      var start = b * LINES_PER_TX;
      var lines = [];
      for (var i = start; i < Math.min(start + LINES_PER_TX, supply); i++) {
        var id = i + 1;
        lines.push({ name: String(id), uri: id + ".json" });
      }
      progress({ step: "lines", state: "uploading", batch: b + 1, batches: total });
      await mx.addConfigLines(umi, {
        candyMachine: candyMachine.publicKey,
        index: start,
        configLines: lines
      }).sendAndConfirm(umi, { confirm: { commitment: "confirmed" } });
    }
    var cm = await mx.fetchCandyMachine(umi, candyMachine.publicKey);
    if (Number(cm.itemsLoaded) !== supply) {
      throw new Error("Loaded " + cm.itemsLoaded + " of " + supply +
        " items. The collection is deployed but not fully loaded — do not announce it yet.");
    }
    progress({ step: "lines", state: "done", loaded: cm.itemsLoaded });

    /* ---- 4. creator supply, minted to each split recipient ----
     * Before the guard exists, so it bypasses price and limits by
     * construction — these are the team's ids 1..N, exactly as on Moonpad. */
    var devMints = (opts.devMints || []).filter(function (d) { return d.count > 0; });
    var devTotal = devMints.reduce(function (a, d) { return a + d.count; }, 0);
    if (devTotal > 0) {
      var minted = 0;
      for (var di = 0; di < devMints.length; di++) {
        for (var k = 0; k < devMints[di].count; k++) {
          minted++;
          progress({ step: "dev", state: "uploading", batch: minted, batches: devTotal });
          var devAsset = mx.generateSigner(umi);
          await (await mx.mintAssetFromCandyMachine(umi, {
            candyMachine: candyMachine.publicKey,
            mintAuthority: umi.identity,
            asset: devAsset,
            assetOwner: mx.publicKey(devMints[di].to || umi.identity.publicKey),
            collection: collection.publicKey
          }))
            .prepend(mx.setComputeUnitLimit(umi, { units: 800000 }))
            .sendAndConfirm(umi, { confirm: { commitment: "confirmed" } });
        }
      }
      progress({ step: "dev", state: "done", minted: devTotal });
    }

    /* ---- 5. now the guard, and hand it the mint authority ---- */
    progress({ step: "guard", state: "signing" });
    var built = buildGuards(mx, opts);
    var guardBase = candyMachine;                  // guard PDA derives from this
    await mx.createCandyGuard(umi, {
      base: guardBase,
      guards: built.guards,
      groups: built.groups
    }).sendAndConfirm(umi, { confirm: { commitment: "confirmed" } });
    var candyGuard = mx.findCandyGuardPda(umi, { base: guardBase.publicKey });
    await mx.wrap(umi, {
      candyGuard: candyGuard,
      candyMachine: candyMachine.publicKey
    }).sendAndConfirm(umi, { confirm: { commitment: "confirmed" } });
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
    var price = null;
    if (guard.guards.solPayment && guard.guards.solPayment.__option === "Some") {
      price = Number(guard.guards.solPayment.value.lamports.basisPoints) / 1e9;
    }
    return {
      collection: String(cm.collectionMint),
      available: Number(cm.data.itemsAvailable),
      redeemed: Number(cm.itemsRedeemed),
      loaded: Number(cm.itemsLoaded),
      priceSol: price,
      authority: String(cm.authority)
    };
  }

  window.Launch = {
    deploy: deploy,
    mintOne: mintOne,
    readMachine: readMachine,
    cluster: function (name) { if (name) cluster = name; return cluster; },
    clusters: CLUSTERS
  };
})();
