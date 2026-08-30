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
    devnet:         { rpc: "https://api.devnet.solana.com",       label: "Devnet",  explorer: "?cluster=devnet" }
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

  async function deploy(opts) {
    var progress = opts.onProgress || function () {};
    var c = await connectUmi();
    var mx = c.mx, umi = c.umi;

    var supply = opts.supply;
    var royaltyBps = Math.round((opts.royaltyPercent || 5) * 100);

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
        creators: opts.creators && opts.creators.length
          ? opts.creators
          : [{ address: umi.identity.publicKey, percentage: 100 }],
        // None means marketplaces are asked, not forced. Enforcing here breaks
        // transfers on every venue that has not adopted the rule set, which is
        // a worse outcome than a marketplace choosing to ignore royalties.
        ruleSet: { __kind: "None" }
      }]
    }).sendAndConfirm(umi, { confirm: { commitment: "confirmed" } });
    progress({ step: "collection", state: "done", address: collection.publicKey });

    /* ---- 2. candy machine ---- */
    progress({ step: "machine", state: "signing" });
    var guards = {};
    if (opts.priceSol > 0) {
      guards.solPayment = mx.some({
        lamports: mx.sol(opts.priceSol),
        destination: mx.publicKey(opts.treasury || umi.identity.publicKey)
      });
    }
    if (opts.startDate) {
      guards.startDate = mx.some({ date: mx.dateTime(opts.startDate) });
    }

    var candyMachine = mx.generateSigner(umi);
    var builder = await mx.createCandyMachine(umi, {
      candyMachine: candyMachine,
      collection: collection.publicKey,
      collectionUpdateAuthority: umi.identity,
      itemsAvailable: supply,
      authority: umi.identity.publicKey,
      isMutable: true,
      configLineSettings: lineSettings(mx, opts.name, opts.baseUri, supply),
      guards: guards
    });
    await builder.sendAndConfirm(umi, { confirm: { commitment: "confirmed" } });
    progress({ step: "machine", state: "done", address: candyMachine.publicKey });

    /* ---- 3. config lines ---- */
    var total = Math.ceil(supply / LINES_PER_TX);
    for (var b = 0; b < total; b++) {
      var start = b * LINES_PER_TX;
      var lines = [];
      for (var i = start; i < Math.min(start + LINES_PER_TX, supply); i++) {
        var id = i + 1;                       // tokens are 1-indexed, config lines 0-indexed
        lines.push({ name: String(id), uri: id + ".json" });
      }
      progress({ step: "lines", state: "uploading", batch: b + 1, batches: total });
      await mx.addConfigLines(umi, {
        candyMachine: candyMachine.publicKey,
        index: start,
        configLines: lines
      }).sendAndConfirm(umi, { confirm: { commitment: "confirmed" } });
    }

    // Verify rather than assume. A batch that silently fell short leaves a
    // machine that mints into a gap, and finding that out at mint time is
    // unrecoverable — the collection is already public.
    var cm = await mx.fetchCandyMachine(umi, candyMachine.publicKey);
    if (Number(cm.itemsLoaded) !== supply) {
      throw new Error("Loaded " + cm.itemsLoaded + " of " + supply +
        " items. The collection is deployed but not fully loaded — do not announce it yet.");
    }
    progress({ step: "lines", state: "done", loaded: cm.itemsLoaded });

    return {
      collection: String(collection.publicKey),
      candyMachine: String(candyMachine.publicKey),
      cluster: cluster,
      explorer: "https://explorer.solana.com/address/" + candyMachine.publicKey + c.conf.explorer,
      mintUrl: location.origin + "/mint/" + candyMachine.publicKey
    };
  }

  /* Mint one, used by the mint page. Kept here so the guard argument shapes
   * live next to the guard definitions they have to mirror — they are set at
   * deploy time and read at mint time, and drift between the two is the single
   * easiest way to ship a machine nobody can mint from. */
  async function mintOne(candyMachineAddress) {
    var c = await connectUmi();
    var mx = c.mx, umi = c.umi;

    var cm = await mx.fetchCandyMachine(umi, mx.publicKey(candyMachineAddress));
    var guard = await mx.fetchCandyGuard(umi, cm.mintAuthority);

    var mintArgs = {};
    if (guard.guards.solPayment && guard.guards.solPayment.__option === "Some") {
      mintArgs.solPayment = mx.some({ destination: guard.guards.solPayment.value.destination });
    }

    var asset = mx.generateSigner(umi);
    var builder = await mx.mintV1(umi, {
      candyMachine: cm.publicKey,
      asset: asset,
      collection: cm.collectionMint,
      mintArgs: mintArgs
    });
    // Core mints run past the 200k default; without this the transaction fails
    // with an out-of-compute error that reads like a program bug.
    await builder.prepend(mx.setComputeUnitLimit(umi, { units: 800000 }))
                 .sendAndConfirm(umi, { confirm: { commitment: "confirmed" } });

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
