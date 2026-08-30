(function () {
  "use strict";
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

  async function uploadApproval(signerAddress, bytes, count, auth) {
    var body = credentials();
    body.signerAddress = signerAddress;
    body.bytes = bytes;
    body.count = count;
    // Three ways the server grants the credit share, cheapest first:
    //  - team password (carried by credentials())
    //  - a pass holder who signed the launch message (address + sig + ts):
    //    the server verifies against the claimed pubkey, so naming someone
    //    else's address alone cannot work
    //  - anyone else, by a storage payment whose signature is verified on chain
    if (auth && auth.address) body.address = auth.address;
    if (auth && auth.sig) { body.sig = auth.sig; body.ts = auth.ts; }
    if (auth && auth.signature) body.signature = auth.signature;

    var r = await fetch(SIGN, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body)
    });
    var j = await r.json().catch(function () { return {}; });
    if (!r.ok || !j.paidBy) {
      throw new Error(j.detail || j.error || ("Could not get an upload slot (" + r.status + ")"));
    }
    return j.paidBy;
  }

  // The exact SOL cost to store this upload permanently, quoted live by the
  // server. Grants nothing — just a price, so a non-holder can be shown and
  // charged the real number before any credit is spent.
  async function quoteUpload(bytes, count) {
    var r = await fetch(SIGN, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ quote: true, bytes: bytes, count: count })
    });
    var j = await r.json().catch(function () { return {}; });
    if (!r.ok || !j.feeLamports) {
      throw new Error(j.detail || j.error || ("Could not price the upload (" + r.status + ")"));
    }
    return j; // { feeLamports, feeSol, feeTo }
  }

  function bytesOf(fileList) {
    var total = 0;
    fileList.forEach(function (f) {
      total += f.bytes ? new Blob([f.bytes]).size : new Blob([f.text]).size;
    });
    return total;
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
    var T = await turbo();

    var key = await throwawayKey();
    var client = T.TurboFactory.authenticated({ privateKey: key, token: "solana" });
    var me = await client.signer.getNativeAddress();

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
      maxConcurrentUploads: 10,
      throwOnFailure: true
    }), total, label);
    var id = res && res.manifestResponse && res.manifestResponse.id;
    if (!id) throw new Error("Upload finished but returned no manifest id");
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
      j.image = "https://arweave.net/" + imageCid + "/" + f.id + ".png";
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
      col.image = "https://arweave.net/" + imageCid + (opts.avatar ? "/_avatar.png" : "/1.png");
      if (opts.banner) col.banner = "https://arweave.net/" + imageCid + "/_banner.png";
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

    return {
      imageCid: imageCid,
      metadataCid: metaCid,
      // Plain https, not ar://: wallets and marketplace indexers do not speak
      // the ar scheme, and a blank image in a wallet is a real cost paid daily
      // for a purity nobody sees. arweave.net is the canonical gateway.
      baseUri: "https://arweave.net/" + metaCid + "/",
      collectionUri: "https://arweave.net/" + metaCid + "/_collection.json",
      preview: "https://arweave.net/" + metaCid + "/1.json",
      index: "https://arweave.net/" + metaCid + "/_index.json",
      avatarUri: opts.avatar
        ? "https://arweave.net/" + metaCid + "/_avatar.png"
        : "https://arweave.net/" + imageCid + "/1.png"
    };
  }

  /* One small folder for a token launch: token.json plus an optional icon.
   * Reuses the exact quote -> payment -> approval -> upload path a collection
   * takes, so the payment gate and its replay guard apply unchanged. The icon
   * rides in the same folder because the metadata needs an absolute url and
   * one manifest covers both. */
  async function uploadTokenMeta(opts) {
    var files = [];
    if (opts.icon) files.push({ id: "_icon", name: "icon.png", bytes: opts.icon });
    if (opts.banner) files.push({ id: "_banner", name: "banner.png", bytes: opts.banner });

    function buildJson(cid) {
      var j = {
        name: opts.name,
        symbol: opts.symbol,
        description: opts.description || ""
      };
      if (opts.icon) j.image = "https://arweave.net/" + cid + "/icon.png";
      if (opts.banner) j.banner = "https://arweave.net/" + cid + "/banner.png";
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
    var totalCount = probe.length;

    var auth = { address: opts.address, sig: opts.sig, ts: opts.ts };
    if (!auth.sig && opts.payer) {
      var q = await quoteUpload(totalBytes, totalCount);
      auth.signature = await opts.payer(q);
      if (!auth.signature) throw new Error("Storage fee was not paid — launch cancelled.");
    }

    var up = await prepareUploader(totalBytes, totalCount, auth, opts.onProgress);
    var set = files.concat([{ id: "_t", name: "token.json", text: buildJson(PLACEHOLDER) }]);
    // Single folder: upload once, then the json inside points at the same
    // manifest for the icon — an Arweave manifest id is 43 chars, so the
    // placeholder-sized upload matches the final bytes exactly.
    var cid = await uploadWith(up, set, "token metadata", opts.onProgress);
    return {
      uri: "https://arweave.net/" + cid + "/token.json", cid: cid,
      iconUri: opts.icon ? "https://arweave.net/" + cid + "/icon.png" : null,
      bannerUri: opts.banner ? "https://arweave.net/" + cid + "/banner.png" : null
    };
  }

  window.Storage = {
    uploadCollection: uploadCollection,
    uploadTokenMeta: uploadTokenMeta,
    quoteUpload: quoteUpload,
    repoint: repoint,
    buildIndex: buildIndex
  };
})();
