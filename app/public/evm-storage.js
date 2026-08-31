(function () {
  "use strict";
  // Upload a generated collection to IPFS. The creator supplies nothing — no
  // account, no key, nothing pasted.
  //
  //   browser -> /api/upload-url    "let me upload"
  //   server  -> Pinata             signs a short-lived URL
  //   browser -> Pinata             posts the files straight there
  //
  // The files never pass through the server: a Vercel function caps request
  // bodies near 4.5MB and a 5,555 collection is about 30MB, so proxying could
  // not work even if it were desirable.
  //
  // Order is not negotiable. Images go first, because every metadata file has to
  // name a CID that already exists — uploading metadata first would bake in a
  // URL for art that is not there yet, and the contract can be frozen pointing
  // at it.

  var SIGN = "/api/upload-url";

  // During closed testing the endpoint takes the password. vip.js keeps the
  // plaintext once it has been entered — no weaker than the person knowing it,
  // and it disappears entirely once holding a Moonbaby is the credential.
  function credentials() {
    var out = {};
    try {
      var k = localStorage.getItem("moonpad.vip.k");
      if (k) out.key = k;
    } catch (e) {}
    return out;
  }

  // The Turbo web SDK, loaded once and only when an upload actually happens —
  // it is a 5MB bundle and no other page needs it.
  var turboMod = null;
  function turbo() {
    if (!turboMod) turboMod = import("/vendor/turbo.esm.js");
    return turboMod;
  }

  // The server approves this upload's throwaway signer to spend a slice of the
  // platform's credits — sized to the byte count AND the file count (Turbo
  // charges a per-file floor, so many small files cost far more than their
  // bytes), dead in an hour.
  async function uploadApproval(signerAddress, bytes, count, auth) {
    var body = credentials();
    body.signerAddress = signerAddress;
    body.bytes = bytes;
    body.count = count;
    // Three ways the server grants the credit share, cheapest first:
    //  - team password (carried by credentials())
    //  - a Moonbaby holder who signed the launch message (address + sig + ts):
    //    the server recovers the signer, so the address alone can't be spoofed
    //  - anyone else, by a storage payment whose tx hash is verified on chain
    if (auth && auth.address) body.address = auth.address;
    if (auth && auth.sig) { body.sig = auth.sig; body.ts = auth.ts; }
    if (auth && auth.txHash) body.txHash = auth.txHash;

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

  // The exact ETH cost to store this upload permanently, quoted live by the
  // server. Grants nothing — just a price, so a non-holder can be shown and
  // charged the real number before any credit is spent.
  async function quoteUpload(bytes, count) {
    var r = await fetch(SIGN, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ quote: true, bytes: bytes, count: count })
    });
    var j = await r.json().catch(function () { return {}; });
    if (!r.ok || !j.feeWei) {
      throw new Error(j.detail || j.error || ("Could not price the upload (" + r.status + ")"));
    }
    return j; // { feeWei, feeEth, feeTo }
  }

  // The byte size Turbo will bill this file set at — a Blob measures UTF-8 text
  // exactly, the same figure the upload itself reports.
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

  // Arweave via Turbo, not Pinata: paid once per byte, permanent, no plan to
  // lapse and no pins to go dark. A folder upload returns a manifest whose id
  // addresses the files by name — the same directory semantics an IPFS CID gave
  // us, so the rest of the pipeline only changes its uri scheme.
  //
  // A launch is two folders (images, then metadata pointing at them) but ONE
  // credit approval covers both: one throwaway signer, approved once for the
  // whole launch's byte+file total, uploads both folders. That single approval is
  // one server grant, so a paid launch presents its payment tx exactly once —
  // the metadata folder can't try to spend an already-claimed payment.
  async function prepareUploader(totalBytes, totalCount, auth, onProgress) {
    if (onProgress) onProgress({ phase: "images", state: "signing" });
    var T = await turbo();

    // A throwaway key for the whole launch. It signs the data items and nothing
    // else; the money is the platform's (or the payer's fee), released by the
    // one approval below.
    var raw = new Uint8Array(32);
    crypto.getRandomValues(raw);
    var hexKey = "0x" + Array.prototype.map.call(raw, function (b) {
      return b.toString(16).padStart(2, "0");
    }).join("");
    var signer = new T.EthereumSigner(hexKey);
    var client = T.TurboFactory.authenticated({ signer: signer, token: "ethereum" });
    var me = await client.signer.getNativeAddress();

    var paidBy = await uploadApproval(me, totalBytes, totalCount, auth);
    return { client: client, paidBy: paidBy };
  }

  // Upload one folder with an already-prepared uploader. Never hangs: a too-small
  // approval used to leave this pending forever with the UI stuck on "Storing the
  // images…" and nothing thrown. Race it against a ceiling scaled to the payload.
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
  // here.
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
  // 5,555 collection from 988 KB to 92 KB, or 27 KB over the wire. Token ids are
  // implicit in position, so they are not stored at all.
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

    // How the server is told to grant the credit share. A holder signs (address
    // + sig + ts); the team carries a password in credentials(); a public
    // launcher pays a fee and carries its tx hash, collected below.
    var auth = { address: opts.address, sig: opts.sig, ts: opts.ts };

    // The avatar and banner ride in the images folder as well as the metadata
    // one. Not tidiness — necessity. _contract.json has to give a marketplace
    // absolute urls, it lives in the metadata folder, and that folder's CID does
    // not exist until the moment it is pinned. The images folder is pinned
    // first, so it is the only place a url can point at from inside the
    // metadata. Two small files duplicated is the price of that ordering.
    var imageSet = files.images.slice();
    if (opts.avatar) imageSet.push({ id: "_avatar", name: "_avatar.png", bytes: opts.avatar });
    if (opts.banner) imageSet.push({ id: "_banner", name: "_banner.png", bytes: opts.banner });

    // The metadata folder, assembled for a given image CID. Called twice: once
    // with a placeholder to size the upload before paying, then with the real CID
    // after the images land. Both produce identical byte counts because an
    // Arweave manifest id is always 43 chars — so the fee quoted up front is the
    // fee the metadata actually costs.
    function buildMeta(imageCid) {
      var meta = repoint(files.erc721, imageCid);

      // The index rides in the metadata folder so one CID covers both, named with
      // a leading underscore so it can never collide with a token id.
      meta = meta.concat([{
        id: "_index", name: "_index.json",
        text: buildIndex(meta, opts.name || "Collection")
      }]);

      // A creator's own avatar and banner, same folder for the same reason. Added
      // after the index is built, because buildIndex parses every entry as json
      // and these are bytes.
      if (opts.avatar) meta.push({ id: "_avatar", name: "_avatar.png", bytes: opts.avatar });
      if (opts.banner) meta.push({ id: "_banner", name: "_banner.png", bytes: opts.banner });

      // Where the collection lives off-chain. Same folder for the same reason:
      // one CID covers everything a page needs, and there is nowhere on the
      // contract to put a discord invite that would not cost gas forever.
      if (opts.links && Object.keys(opts.links).length) {
        meta.push({ id: "_links", name: "_links.json", text: JSON.stringify(opts.links, null, 2) });
      }

      // The allowlist, in mint order. Pinned with the collection rather than kept
      // on a server: the whole claim of an allowlist is that it was fixed before
      // the mint, and a list the creator can quietly edit afterwards is not one.
      if (opts.allowlist && (opts.allowlist.phases || opts.allowlist.length)) {
        // Two shapes tolerated: the current { waveMinutes, phases } and the bare
        // array older launches produced — their pinned files are already out
        // there and this writer documents both.
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

      // Collection-level metadata, the only place a marketplace looks for a
      // collection's logo and banner. Our own pages read _avatar.png and
      // _banner.png directly, but nothing tells OpenSea those files exist — it
      // reads contractURI() and expects these key names.
      var contractMeta = { name: opts.name || "Collection" };
      if (opts.description) contractMeta.description = opts.description;
      // No uploaded picture does not mean no picture: the collection's own first
      // token stands in, for the coin's logo and the marketplace card alike.
      contractMeta.image = "https://arweave.net/" + imageCid +
        (opts.avatar ? "/_avatar.png" : "/1.png");
      if (opts.banner) contractMeta.banner_image_url = "https://arweave.net/" + imageCid + "/_banner.png";
      if (opts.links && opts.links.website) contractMeta.external_link = opts.links.website;
      meta.push({ id: "_contract", name: "_contract.json", text: JSON.stringify(contractMeta, null, 2) });
      return meta;
    }

    // A real Arweave manifest id is 43 chars; size the metadata against a
    // placeholder of that length so the pre-pay total matches the real upload.
    var PLACEHOLDER_CID = "0000000000000000000000000000000000000000000";
    var metaProbe = buildMeta(PLACEHOLDER_CID);
    var totalBytes = bytesOf(imageSet) + bytesOf(metaProbe);
    var totalCount = imageSet.length + metaProbe.length;

    // A non-holder (no signature, no team password) pays their own storage. Quote
    // the exact cost, hand it to the panel to collect payment, and carry the tx
    // hash into the one approval. Holders and the team skip this entirely.
    if (!auth.sig && opts.payer) {
      if (opts.onProgress) opts.onProgress({ phase: "images", state: "quoting" });
      var q = await quoteUpload(totalBytes, totalCount);
      auth.txHash = await opts.payer(q);
      if (!auth.txHash) throw new Error("Storage fee was not paid — launch cancelled.");
    }

    // One approval for the whole launch (see prepareUploader): both folders draw
    // from it, so a paid launch presents its payment tx exactly once.
    var up = await prepareUploader(totalBytes, totalCount, auth, opts.onProgress);

    var imageCid = await uploadWith(up, imageSet, "images", opts.onProgress);
    var meta = buildMeta(imageCid);
    var metaCid = await uploadWith(up, meta, "metadata", opts.onProgress);

    return {
      imageCid: imageCid,
      metadataCid: metaCid,
      // Plain https, not ar://: wallets and marketplace indexers do not speak
      // the ar scheme yet, and a blank image in a wallet is a real cost paid
      // daily for a purity nobody sees. arweave.net is the canonical gateway
      // and the convention the Arweave NFT world settled on. Somebody else's
      // uptime, and this outlives all of us.
      baseUri: "https://arweave.net/" + metaCid + "/",
      preview: "https://arweave.net/" + metaCid + "/1.json",
      index: "https://arweave.net/" + metaCid + "/_index.json",
      // a paired coin reuses the collection's picture as its logo — and a
      // collection that skipped the picture is represented by its own #1
      avatarUri: opts.avatar
        ? "https://arweave.net/" + metaCid + "/_avatar.png"
        : "https://arweave.net/" + imageCid + "/1.png"
    };
  }

  window.MoonpadStorage = {
    uploadCollection: uploadCollection,
    repoint: repoint,
    buildIndex: buildIndex
  };
})();
