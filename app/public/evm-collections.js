/* Robinhood Chain collection reads, for the explore + mint pages.
 *
 * The list of collections comes from OUR records (/api/collections, same as
 * the Solana side) — WAVES stands alone; nothing here reads another site's
 * registry. Every number on every tile still comes off the collection
 * contract itself. Requires evm-chains.js (MoonpadRPC) and evm-contract.js
 * (selector map). */
(function () {
  "use strict";

  var drop = function () { return (window.MOONPAD_CONTRACT || {}).selectors || {}; };
  function rhChain() {
    return (window.MOONPAD_CHAINS || []).find(function (c) { return c.id === 4663; });
  }

  function withTimeout(p, ms, what) {
    return Promise.race([p, new Promise(function (_, rej) {
      setTimeout(function () { rej(new Error(what + " timed out")); }, ms);
    })]);
  }
  function call(to, data) {
    var c = rhChain();
    return withTimeout(window.MoonpadRPC.call(c.rpc, to, data), 12000, "the chain");
  }

  var word = function (n) { return BigInt(n).toString(16).padStart(64, "0"); };
  var toNum = function (h) { return parseInt(h, 16) || 0; };

  function decodeString(hex) {
    var h = (hex || "").replace(/^0x/, "");
    var len = parseInt(h.slice(64, 128), 16);
    var b = h.slice(128, 128 + len * 2), out = "";
    for (var i = 0; i < b.length; i += 2) out += String.fromCharCode(parseInt(b.substr(i, 2), 16));
    try { return decodeURIComponent(escape(out)); } catch (e) { return out; }
  }

  // ---- art (lifted from the donor: gateway race + one retry, because a
  // dropped fetch must read as a blip, not as "this collection has no art")
  var GATEWAYS = [
    "https://gateway.pinata.cloud/ipfs/",
    "https://ipfs.io/ipfs/",
    "https://dweb.link/ipfs/"
  ];
  var arw = function (u) { return u && u.indexOf("ar://") === 0 ? "https://arweave.net/" + u.slice(5) : u; };
  var cidPath = function (u) { return u && u.indexOf("ipfs://") === 0 ? u.slice(7) : null; };
  var imageUrl = function (u) { u = arw(u); var p = cidPath(u); return p ? GATEWAYS[0] + p : u; };

  function retrying(make, tries) {
    return make().catch(function (e) {
      if (tries <= 0) throw e;
      return new Promise(function (r) { setTimeout(r, 500); })
        .then(function () { return retrying(make, tries - 1); });
    });
  }
  function raceJson(uri) {
    uri = arw(uri);
    var p = cidPath(uri);
    if (!p) return withTimeout(retrying(function () {
      return fetch(uri).then(function (r) {
        if (!r.ok) throw new Error(String(r.status));
        return r.json();
      });
    }, 2), 10000, "the art");
    return withTimeout(Promise.any(GATEWAYS.map(function (g) {
      return fetch(g + p).then(function (r) {
        if (!r.ok) throw new Error(String(r.status));
        return r.json();
      });
    })), 12000, "the art");
  }

  // ---- reads
  async function readOne(address) {
    async function one(sig, dec) {
      try { return dec(await call(address, "0x" + drop()[sig])); }
      catch (e) { return null; }
    }
    var c = {
      address: address,
      name: await one("name()", decodeString) || "Untitled",
      symbol: await one("symbol()", decodeString) || "",
      maxSupply: await one("maxSupply()", toNum) || 0,
      minted: await one("totalMinted()", toNum) || 0,
      price: 0n,
      saleOpen: (await one("saleOpen()", function (h) { return toNum(h) === 1; })) === true
    };
    try { c.price = BigInt(await call(address, "0x" + drop()["price()"])); }
    catch (e) { c.price = 0n; }
    return c;
  }

  async function artFor(c) {
    var base = null;
    try {
      if (drop()["baseURI()"]) base = decodeString(await call(c.address, "0x" + drop()["baseURI()"]));
    } catch (e) {}
    if (!base) {
      try {
        var uri = decodeString(await call(c.address,
          "0x" + drop()["tokenURI(uint256)"] + word(1)));
        base = uri ? uri.replace(/[^/]*$/, "") : null;
      } catch (e) {}
    }
    if (!base) return null;
    try {
      var meta = await raceJson(base + "1.json");
      return meta && meta.image ? imageUrl(meta.image) : null;
    } catch (e) { return null; }
  }

  function fmtEth(wei) {
    var s = BigInt(wei).toString().padStart(19, "0");
    var w = s.slice(0, -18), f = s.slice(-18).replace(/0+$/, "").slice(0, 5);
    return w + (f ? "." + f : "");
  }

  window.EvmCollections = {
    chain: rhChain, readOne: readOne,
    artFor: artFor, imageUrl: imageUrl, fmtEth: fmtEth
  };
})();
