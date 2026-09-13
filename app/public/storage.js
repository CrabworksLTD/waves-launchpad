(function () {
  "use strict";

  /* The site origin metadata URLs point at. Metadata is served through OUR /m/
     path (api/meta.js), not arweave.net directly, so a fresh launch shows its art
     in wallets IMMEDIATELY — /m/ answers from whichever gateway (incl. the Turbo
     cache) actually has the bytes, while arweave.net can lag minutes-to-hours on a
     fresh bundle. The bytes are still permanent on Arweave; this only changes which
     door callers knock on. On localhost it must be the prod domain (a localhost URL
     baked on-chain is fetchable by nobody). Same reasoning as the token side. */
  function SITE_ORIGIN() {
    return /^(localhost|127\.|\[::1\])/.test(window.location.hostname)
      ? "https://www.waveslaunchpad.xyz" : window.location.origin;
  }
  function mUrl(cid, file) { return SITE_ORIGIN() + "/m/" + cid + "/" + file; }

  // Upload a generated collection to Arweave. The creator supplies nothing —
  // no account, no key, nothing pasted.
  //
  //   browser -> /api/upload-url    "let me upload"
  //   server  -> Turbo              approves a credit share for a throwaway key
  //   browser -> Turbo              posts the files straight there
  //
  // The files never pass through our server: a Vercel function caps request
  // bodies near 4.5MB and a 5,555-piece collection is about 30MB, so proxying
  // could not work even if it were desirable.
  //
  // Order is not negotiable. Images go first, because every metadata file has
  // to name a manifest id that already exists — uploading metadata first bakes
  // in a URL for art that is not there yet, and a Candy Machine can be loaded
  // pointing at it.
  //
  // Ported from Moonpad. What changed for Solana:
  //   - HexSolanaSigner + token:"solana" instead of EthereumSigner/"ethereum"
  //   - the throwaway key is an ed25519 keypair, base58 encoded
  //   - the fee is quoted and paid in lamports, not wei
  // Everything about ordering, sizing and the single-approval rule is
  // unchanged, and all of it was learned the hard way — see the comments.

  var SIGN = "/api/upload-url";

  function credentials() {
    var out = {};
    try {
      var k = localStorage.getItem(window.BRAND ? window.BRAND.key("vip.k") : "vip.k");
      if (k) out.key = k;
    } catch (e) {}
    return out;
  }

  // Both bundles load lazily and only when an upload actually happens — 5MB and
  // 1.3MB respectively, and no other page needs either.
  var turboMod = null, mxMod = null;
  function turbo() {
    /* One of the bundles loaded before this defines globalThis.process with a
     * `version`, and a crypto shim inside the Turbo bundle reads that as
     * "I am Node" — then dereferences a process module that does not exist in
     * a browser and dies with "Cannot read properties of undefined (reading
     * 'version')" mid-upload, after the creator has already paid for storage.
     * The same shim checks process.browser first, so saying so up front takes
     * the branch that was written for us. */
    try {
      if (!globalThis.process) globalThis.process = {};
      if (!globalThis.process.browser) globalThis.process.browser = true;
    } catch (e) {}
    if (!turboMod) turboMod = import("/vendor/turbo.esm.js");
    return turboMod;
  }
  function metaplex() {
    if (!mxMod) mxMod = import("/vendor/metaplex.esm.js");
    return mxMod;
  }

  // A throwaway ed25519 keypair for this launch, as the base58 64-byte secret
  // key Turbo wants. Borrowed from umi rather than hand-rolled: WebCrypto's
  // Ed25519 support is recent enough that a fallback would be needed, and the
  // metaplex bundle is loaded by the launch flow anyway.
  async function throwawayKey() {
    var mx = await metaplex();
    var umi = mx.createUmi("https://api.mainnet-beta.solana.com", "confirmed");   // never used for rpc, consistent anyway
    var kp = mx.generateSigner(umi);
    var secret = kp.secretKey;                       // 64 bytes: seed || pubkey
    if (!secret || secret.length !== 64) throw new Error("bad throwaway keypair");
    return mx.base58.deserialize(secret)[0];
  }

  // which chain pays for this upload — the shell's selected network. The
  // server prices and verifies in that chain's currency.
  function payChain() {
    return (window.Shell && window.Shell.chain && window.Shell.chain() === "robinhood")
      ? "robinhood" : "solana";
  }

  async function uploadApproval(signerAddress, bytes, count, auth) {
    var body = credentials();
    body.signerAddress = signerAddress;
    body.bytes = bytes;
    body.count = count;
    body.chain = payChain();
    // Three ways the server grants the credit share, cheapest first:
    //  - team password (carried by credentials())
    //  - a pass holder who signed the launch message (address + sig + ts):
    //    the server verifies against the claimed pubkey, so naming someone
    //    else's address alone cannot work
    //  - anyone else, by a storage payment whose signature is verified on chain
    if (auth && auth.address) body.address = auth.address;
    if (auth && auth.sig) { body.sig = auth.sig; body.ts = auth.ts; }
    if (auth && auth.signature) body.signature = auth.signature;

    var got = await fetchJson(SIGN, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body)
    }, 45000, "The upload slot request");
    var r = got.r, j = got.j;
    if (!r.ok || !j.paidBy) {
      throw new Error(j.detail || j.error || ("Could not get an upload slot (" + r.status + ")"));
    }
    return j.paidBy;
  }

  // The exact SOL cost to store this upload permanently, quoted live by the
  // server. Grants nothing — just a price, so a non-holder can be shown and
  // charged the real number before any credit is spent.
  async function quoteUpload(bytes, count) {
    var got = await fetchJson(SIGN, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ quote: true, bytes: bytes, count: count, chain: payChain() })
    }, 30000, "The storage price request");
    var r = got.r, j = got.j;
    if (!r.ok || !(j.feeLamports || j.feeWei)) {
      throw new Error(j.detail || j.error || ("Could not price the upload (" + r.status + ")"));
    }
    // Solana: { feeLamports, feeSol, feeTo } · Robinhood: { feeWei, feeEth, feeTo, chain }
    return j;
  }

  function bytesOf(fileList) {
    var total = 0;
    fileList.forEach(function (f) {
      total += f.bytes ? new Blob([f.bytes]).size : new Blob([f.text]).size;
    });
    return total;
  }

  /* Nothing in this file may wait forever.
   *
   * fetch() has no default timeout: a request that never answers leaves the
   * launch panel sitting on a step with no error and no way out. That is what
   * froze a launch on 2026-08-31, immediately after the storage payment had
   * been taken — the worst possible moment, because the money was already
   * gone and the credit expires in an hour.
   *
   * Every network call here now fails loudly instead. */
  function withTimeout(p, ms, what) {
    var timer;
    var stop = new Promise(function (_, reject) {
      timer = setTimeout(function () {
        reject(new Error(what + " did not respond in " + Math.round(ms / 1000) +
          "s. Nothing further was charged — try again."));
      }, ms);
    });
    return Promise.race([p, stop]).finally(function () { clearTimeout(timer); });
  }

  function fetchJson(url, opts, ms, what) {
    return withTimeout(fetch(url, opts), ms || 30000, what).then(function (r) {
      return r.json().catch(function () { return {}; })
        .then(function (j) { return { r: r, j: j }; });
    });
  }

  /* Mirror the art we just uploaded.
   *
   * The browser already holds these bytes — it just sent them to Arweave — so
   * a copy costs one POST and nothing else. It exists because arweave.net
   * cannot serve a fresh upload for minutes, which is exactly when a creator
   * is sharing their launch. See api/mirror.js.
   *
   * Fire and forget on purpose: a launch must never fail, or even wait, for a
   * convenience cache. */
  function mirror(url, bytes, type) {
    if (!url || !bytes) return;
    try {
      var blob = new Blob([bytes], { type: type || "image/png" });
      var fr = new FileReader();
      fr.onload = function () {
        fetch("/api/mirror", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ url: url, dataUrl: fr.result })
        }).catch(function () {});
      };
      fr.readAsDataURL(blob);
    } catch (e) {}
  }

  // A folder upload that never settles must fail loudly, not sit on "Storing
  // the images…" forever. The ceiling scales with the payload — three minutes
  // plus twenty seconds a megabyte — so a real large upload has room while a
  // stall (almost always a credit approval that ran short) throws.
  function raceTimeout(p, bytes, label) {
    var ms = Math.max(180000, Math.round((bytes || 0) / 1e6) * 20000);
    var timer;
    var stop = new Promise(function (_, reject) {
      timer = setTimeout(function () {
        reject(new Error("The " + label + " upload stalled — no response in " +
          Math.round(ms / 1000) + "s. This is almost always the upload credit " +
          "running short; try again, and tell us if it repeats."));
      }, ms);
    });
    return Promise.race([p, stop]).finally(function () { clearTimeout(timer); });
  }

  // A launch is two folders (images, then metadata pointing at them) but ONE
  // credit approval covers both: one throwaway signer, approved once for the
  // whole launch's byte+file total. That single approval is one server grant,
  // so a paid launch presents its payment exactly once — the metadata folder
  // cannot try to spend an already-claimed payment.
  async function prepareUploader(totalBytes, totalCount, auth, onProgress) {
    if (onProgress) onProgress({ phase: "images", state: "signing" });
    var T = await withTimeout(turbo(), 60000, "Loading the upload library");

    var key = await throwawayKey();
    var client = T.TurboFactory.authenticated({ privateKey: key, token: "solana" });
    var me = await withTimeout(client.signer.getNativeAddress(), 20000,
      "Preparing the upload signer");

    var paidBy = await uploadApproval(me, totalBytes, totalCount, auth);
    return { client: client, paidBy: paidBy };
  }

  async function uploadWith(up, files, label, onProgress) {
    var total = 0;
    var fileObjs = files.map(function (f) {
      var blob = f.bytes ? new Blob([f.bytes], { type: "image/png" })
                         : new Blob([f.text], { type: "application/json" });
      total += blob.size;
      return new File([blob], f.name, { type: f.bytes ? "image/png" : "application/json" });
    });

    if (onProgress) onProgress({ phase: label, state: "uploading", count: files.length });
    var res = await raceTimeout(up.client.uploadFolder({
      files: fileObjs,
      dataItemOpts: { paidBy: [up.paidBy] },
      maxConcurrentUploads: 16,
      throwOnFailure: true
    }), total, label);
    var id = res && res.manifestResponse && res.manifestResponse.id;
    if (!id) throw new Error("Upload finished but returned no manifest id");

    /* Turbo tells us where the data is ALREADY readable.
     *
     * arweave.net has to see the bundle posted and indexed before it will
     * serve anything — twenty minutes and counting on $MOAR. But Turbo's
     * receipt carries fastFinalityIndexes: gateways that have the data now,
     * optimistically, before it is settled. Publishing them lets the launch
     * stop waiting on the slowest path.
     *
     * Recorded rather than used as the canonical URL: the on-chain metadata
     * must still point at arweave.net, which is the address that outlives
     * everyone. This is only for knowing when to stop waiting. */
    try {
      var r = res.manifestResponse;
      var fast = (r && (r.fastFinalityIndexes || r.dataCaches)) || [];
      if (fast.length) window.__turboFast = { id: id, hosts: fast };
    } catch (e) {}

    if (onProgress) onProgress({ phase: label, state: "done", cid: id });
    return id;
  }

  // Point every metadata file at the uploaded art. The generator writes a bare
  // filename when no baseUri is set, which is exactly the placeholder replaced
  // here. Metaplex metadata keeps the image in two places — `image` and
  // `properties.files[0].uri` — and wallets disagree about which they read, so
  // both are rewritten.
  function repoint(metadata, imageCid) {
    return metadata.map(function (f) {
      var j = JSON.parse(f.text);
      j.image = mUrl(imageCid, f.id + ".png");
      if (j.properties && j.properties.files && j.properties.files[0]) {
        j.properties.files[0].uri = j.image;
      }
      return { id: f.id, name: f.name, text: JSON.stringify(j, null, 2) };
    });
  }

  // A compact index of the whole collection, uploaded alongside the metadata.
  //
  // Without it a collection page cannot offer trait filters at all: knowing the
  // trait universe means reading every metadata file, and nobody fetches 5,555
  // json documents to populate a dropdown.
  //
  // Dictionary encoded rather than a list of objects. Trait names and values
  // repeat once per token, so writing them once and storing indices takes a
  // 5,555 collection from 988 KB to 92 KB. Token ids are implicit in position.
  function buildIndex(metadata, name) {
    var cats = [], vals = [];
    var rows = metadata.map(function (f) { return JSON.parse(f.text); });

    rows.forEach(function (j) {
      (j.attributes || []).forEach(function (a) {
        if (a && a.trait_type != null && cats.indexOf(a.trait_type) < 0) {
          cats.push(a.trait_type);
          vals.push([]);
        }
      });
    });

    var items = rows.map(function (j) {
      var byCat = {};
      (j.attributes || []).forEach(function (a) {
        if (a && a.trait_type != null) byCat[a.trait_type] = String(a.value);
      });
      return cats.map(function (c, ci) {
        var v = byCat[c];
        if (v == null) return -1;                  // trait absent on this token
        var i = vals[ci].indexOf(v);
        if (i < 0) { vals[ci].push(v); i = vals[ci].length - 1; }
        return i;
      });
    });

    return JSON.stringify({ v: 2, name: name, cats: cats, vals: vals, items: items });
  }

  async function uploadCollection(opts) {
    var files = opts.files;
    if (!files || !files.images.length) throw new Error("Nothing to upload — generate first");

    var auth = { address: opts.address, sig: opts.sig, ts: opts.ts };

    // The avatar and banner ride in the images folder as well as the metadata
    // one. Not tidiness — necessity. _collection.json has to give absolute urls,
    // it lives in the metadata folder, and that folder's manifest id does not
    // exist until the moment it is pinned. The images folder is pinned first, so
    // it is the only place a url can point at from inside the metadata.
    var imageSet = files.images.slice();
    if (opts.avatar) imageSet.push({ id: "_avatar", name: "_avatar.png", bytes: opts.avatar });
    if (opts.banner) imageSet.push({ id: "_banner", name: "_banner.png", bytes: opts.banner });
    // the share card, composed in the browser at launch — one more file in an
    // upload already happening, and the only card that survives us
    if (opts.card) imageSet.push({ id: "_card", name: "_card.png", bytes: opts.card });

    // Called twice: once with a placeholder to size the upload before paying,
    // then with the real id after the images land. Both produce identical byte
    // counts because an Arweave manifest id is always 43 chars — so the fee
    // quoted up front is the fee the metadata actually costs.
    function buildMeta(imageCid) {
      // metaplex, not erc721 — the generator already writes both, and this is
      // the whole reason the Solana port did not need a new output format.
      var source = files.metaplex || files.erc721;
      var meta = repoint(source, imageCid);

      meta = meta.concat([{
        id: "_index", name: "_index.json",
        text: buildIndex(meta, opts.name || "Collection")
      }]);

      if (opts.avatar) meta.push({ id: "_avatar", name: "_avatar.png", bytes: opts.avatar });
      if (opts.banner) meta.push({ id: "_banner", name: "_banner.png", bytes: opts.banner });
      if (opts.card) meta.push({ id: "_card", name: "_card.png", bytes: opts.card });

      if (opts.links && Object.keys(opts.links).length) {
        meta.push({ id: "_links", name: "_links.json", text: JSON.stringify(opts.links, null, 2) });
      }

      // The allowlist, in mint order. Pinned with the collection rather than
      // kept on a server: the whole claim of an allowlist is that it was fixed
      // before the mint, and a list the creator can quietly edit afterwards is
      // not one. Candy Guard enforces it on chain from a merkle root; this is
      // the human-readable record of what that root was built from.
      if (opts.allowlist && (opts.allowlist.phases || opts.allowlist.length)) {
        var phases = opts.allowlist.phases || opts.allowlist;
        meta.push({
          id: "_allowlist", name: "_allowlist.json",
          text: JSON.stringify({
            note: "These mint before the public, in this order. A wallets entry " +
                  "lists addresses directly; a collection entry means anyone holding " +
                  "at least `min` of it. waveMinutes is the ladder: rank 1 mints from " +
                  "the moment the sale opens, each later rank joins waveMinutes after " +
                  "the one before it, and the public joins after the last rank.",
            waveMinutes: opts.allowlist.waveMinutes || 0,
            phases: phases
          }, null, 2)
        });
      }

      // Collection-level metadata. On Solana this is the uri on the Core
      // collection asset — what a marketplace reads for the collection's name,
      // logo and banner.
      var col = { name: opts.name || "Collection" };
      if (opts.symbol) col.symbol = opts.symbol;
      if (opts.description) col.description = opts.description;
      // No uploaded picture does not mean no picture: the collection's own
      // first token stands in.
      col.image = mUrl(imageCid, opts.avatar ? "_avatar.png" : "1.png");
      if (opts.banner) col.banner = mUrl(imageCid, "_banner.png");
      if (opts.links && opts.links.website) col.external_url = opts.links.website;
      col.properties = {
        files: [{ uri: col.image, type: "image/png" }],
        category: "image"
      };
      meta.push({ id: "_collection", name: "_collection.json", text: JSON.stringify(col, null, 2) });
      return meta;
    }

    var PLACEHOLDER_CID = "0000000000000000000000000000000000000000000";  // 43 chars, as a real one is
    var metaProbe = buildMeta(PLACEHOLDER_CID);
    var totalBytes = bytesOf(imageSet) + bytesOf(metaProbe);
    var totalCount = imageSet.length + metaProbe.length;

    // A non-holder pays their own storage. Quote the exact cost, hand it to the
    // panel to collect payment, and carry the signature into the one approval.
    if (!auth.sig && opts.payer) {
      if (opts.onProgress) opts.onProgress({ phase: "images", state: "quoting" });
      var q = await quoteUpload(totalBytes, totalCount);
      auth.signature = await opts.payer(q);
      if (!auth.signature) throw new Error("Storage fee was not paid — launch cancelled.");
    }

    var up = await prepareUploader(totalBytes, totalCount, auth, opts.onProgress);

    var imageCid = await uploadWith(up, imageSet, "images", opts.onProgress);
    var meta = buildMeta(imageCid);
    var metaCid = await uploadWith(up, meta, "metadata", opts.onProgress);

    var ret = {
      imageCid: imageCid,
      metadataCid: metaCid,
      // Served through OUR /m/ path (api/meta.js), not arweave.net — so wallets
      // and aggregators that fetch a fresh launch's metadata get the art NOW
      // (from whichever gateway/Turbo cache has it) instead of a blank while
      // arweave.net catches up. The bytes stay permanent on Arweave; /m/ tries it
      // first and this becomes a pass-through once it serves.
      baseUri: mUrl(metaCid, ""),
      collectionUri: mUrl(metaCid, "_collection.json"),
      preview: mUrl(metaCid, "1.json"),
      index: mUrl(metaCid, "_index.json"),
      // imageCid-based, and the SAME urls _collection.json writes for col.image /
      // col.banner (both mUrl now). That match matters: the mirror is keyed by the
      // path, so the copy stored here is found when a page asks for the exact url
      // the metadata points at.
      avatarUri: opts.avatar ? mUrl(imageCid, "_avatar.png") : mUrl(imageCid, "1.png"),
      bannerUri: opts.banner ? mUrl(imageCid, "_banner.png") : null,
      cardUri: opts.card ? mUrl(metaCid, "_card.png") : null
    };
    mirror(ret.avatarUri, opts.avatar || (files[0] && files[0].bytes));
    mirror(ret.cardUri, opts.card);
    mirror(ret.bannerUri, opts.banner);
    return ret;
  }

  /* One small folder for a token launch: token.json plus an optional icon.
   * Reuses the exact quote -> payment -> approval -> upload path a collection
   * takes, so the payment gate and its replay guard apply unchanged. The icon
   * rides in the same folder because the metadata needs an absolute url and
   * one manifest covers both. */
  async function uploadTokenMeta(opts) {
    var files = [];
    var iconName = "icon." + (opts.iconExt || "png");
    var bannerName = "banner." + (opts.bannerExt || "png");
    if (opts.icon) files.push({ id: "_icon", name: iconName, bytes: opts.icon });
    if (opts.banner) files.push({ id: "_banner", name: bannerName, bytes: opts.banner });
    // the launch's share card, composed in the browser (see cardmaker.js)
    if (opts.card) files.push({ id: "_card", name: "card.png", bytes: opts.card });

    // same reasoning as the uri below — the picture has to answer on the

    // first fetch, not the first fetch after arweave.net indexes

    /* ⚠️ The CANONICAL origin, never location.origin.
     *
     * These URLs go into permanent Arweave metadata and — on Robinhood — into
     * an immutable field on the token contract itself. A launch run from the
     * dev server wrote "http://localhost:4400/m/…/icon.png" on chain, where it
     * will sit forever being fetchable by nobody. There is no setter and no
     * second chance, so the address of the site must not depend on which
     * machine happened to run the launch. */
    var ORIGIN = /^(localhost|127\.|\[::1\])/.test(window.location.hostname)
      ? "https://www.waveslaunchpad.xyz"
      : window.location.origin;

    function buildJson(cid) {
      var j = {
        name: opts.name,
        symbol: opts.symbol,
        description: opts.description || ""
      };
      if (opts.icon) j.image = ORIGIN + "/m/" + cid + "/" + iconName;
      if (opts.banner) j.banner = ORIGIN + "/m/" + cid + "/" + bannerName;
      /* Holder-reward choice, carried in the token's own metadata so the token
       * page can show the reward badge + "/asset" ticker from chain, without
       * depending on the off-chain listing record. { mint, symbol, mode }. */
      if (opts.reward) j.reward = opts.reward;
      // the extensions shape Jupiter and the explorers read socials from
      if (opts.links) {
        var ext = {};
        if (opts.links.website) ext.website = opts.links.website;
        if (opts.links.x) ext.twitter = opts.links.x;
        if (opts.links.telegram) ext.telegram = opts.links.telegram;
        if (Object.keys(ext).length) j.extensions = ext;
      }
      return JSON.stringify(j, null, 2);
    }

    var PLACEHOLDER = "0000000000000000000000000000000000000000000";
    var probe = files.concat([{ id: "_t", name: "token.json", text: buildJson(PLACEHOLDER) }]);
    var totalBytes = bytesOf(probe);
    var totalCount = probe.length + 1;   // two manifests now, art then metadata

    var auth = { address: opts.address, sig: opts.sig, ts: opts.ts };
    if (!auth.sig) {
      var q = await quoteUpload(totalBytes, totalCount);
      if (opts.deferPayment) {
        /* Upload now, charge in the launch transaction.
         *
         * The fee used to be collected here, in its own transaction, purely
         * because the URI has to exist before the pool transaction that embeds
         * it. That ordering cost every launch a second wallet approval. The
         * cost is the same either way — it just rides along with the pool
         * instead of arriving ahead of it.
         *
         * The server allows this only for launch-sized uploads and caps them
         * per hour, so an abandoned launch costs us a few hundred kilobytes
         * rather than an open door. */
        if (opts.onDeferredFee) opts.onDeferredFee(q);
      } else if (opts.payer) {
        auth.signature = await opts.payer(q);
        if (!auth.signature) throw new Error("Storage fee was not paid — launch cancelled.");
      }
    }

    var up = await prepareUploader(totalBytes, totalCount, auth, opts.onProgress);

    /* Two folders, exactly like a collection — images first, then the json
     * that points at them.
     *
     * This used to be one folder with the placeholder cid left in: token.json
     * cannot name the manifest it lives inside, so the id it carried was
     * literally 0000…000, and every launched token pointed its image at a
     * folder that does not exist. The icon was uploaded and unreachable, so
     * wallets and explorers showed nothing. Pinning the art first gives the
     * json a real id to reference; the byte total is unchanged, so the quote
     * the creator already paid still covers it. */
    var artCid = files.length
      ? await uploadWith(up, files, "token art", opts.onProgress)
      : PLACEHOLDER;
    var metaText = buildJson(artCid);
    var cid = await uploadWith(up,
      [{ id: "_t", name: "token.json", text: metaText }],
      "token metadata", opts.onProgress);
    /* Published through our own path rather than arweave.net directly.
     *
     * An aggregator fetches a token's URI once, when it first sees the pool,
     * and caches whatever it gets. arweave.net did not know $MOAR's upload
     * existed 45 minutes after launch, so GMGN cached a 404 and the token has
     * no picture and no website link for good — the metadata is immutable, so
     * there is nothing to repoint.
     *
     * /m/ answers from whichever gateway actually has the bytes, trying
     * arweave.net first. The data is still on Arweave and still permanent;
     * this only changes which door a caller knocks on while the canonical
     * gateway catches up. See api/meta.js. */
    var base = ORIGIN + "/m/";
    var out = {
      uri: base + cid + "/token.json", cid: cid,
      iconUri: opts.icon ? base + artCid + "/" + iconName : null,
      bannerUri: opts.banner ? base + artCid + "/" + bannerName : null,
      cardUri: opts.card ? base + artCid + "/card.png" : null
    };
    /* The json too, not only the pictures.
     *
     * /m/ asks the gateways first and falls back to this. Art was covered and
     * metadata was not, so in the minutes before any gateway has the bundle the
     * images would serve while the file naming them 404'd — and an aggregator
     * that reads a token once would cache that. This is the file that matters
     * most and it was the one thing not kept. */
    mirror(out.uri, metaText, "application/json");
    mirror(out.iconUri, opts.icon);
    mirror(out.bannerUri, opts.banner);
    mirror(out.cardUri, opts.card);
    return out;
  }

  window.Storage = {
    uploadCollection: uploadCollection,
    uploadTokenMeta: uploadTokenMeta,
    quoteUpload: quoteUpload,
    repoint: repoint,
    buildIndex: buildIndex
  };
})();
