/* The mint page's Robinhood Chain driver. Same DOM as the Solana path —
 * hero identity, supply bar, one big button, pieces grid — different chain
 * underneath: state comes off the drop contract, art off its token metadata,
 * and the mint is a plain eth_sendTransaction with EIP-1559 pricing lifted
 * from the donor (base*3 + tip, 1.2x gas pad, receipt polls that treat a
 * dropped poll as "ask again", never as failure).
 *
 * Gated (allowlist) collections need the mint-signer service, which lives
 * with Moonpad — those minted their waves there; this page says so instead
 * of failing mid-transaction. Requires evm-chains.js, evm-contract.js,
 * evm-collections.js. */
(function () {
  "use strict";

  var esc = window.UI.esc, shortAddr = window.UI.shortAddr;
  var $ = function (id) { return document.getElementById(id); };
  var drop = function () { return (window.MOONPAD_CONTRACT || {}).selectors || {}; };
  var chain = function () { return window.EvmCollections.chain(); };

  var word = function (n) { return BigInt(n).toString(16).padStart(64, "0"); };
  var toNum = function (h) { return parseInt(h, 16) || 0; };
  var toBig = function (h) { try { return BigInt(h); } catch (e) { return 0n; } };

  function rpc(method, params) {
    return window.MoonpadRPC.send(chain().rpc, method, params);
  }
  function call(to, data) {
    return window.MoonpadRPC.call(chain().rpc, to, data);
  }

  function decodeString(hex) {
    var h = (hex || "").replace(/^0x/, "");
    var len = parseInt(h.slice(64, 128), 16);
    var b = h.slice(128, 128 + len * 2), out = "";
    for (var i = 0; i < b.length; i += 2) out += String.fromCharCode(parseInt(b.substr(i, 2), 16));
    try { return decodeURIComponent(escape(out)); } catch (e) { return out; }
  }

  var C = null;        // collection address
  var st = null;       // read state
  var baseUri = null;
  var qty = 1;         // how many to mint (the −/+/MAX stepper)

  function say(kind, html) {
    var m = $("msg");
    m.className = "msg " + kind;
    m.innerHTML = html;
  }

  async function read() {
    async function one(sig, dec) {
      try { return dec(await call(C, "0x" + drop()[sig])); }
      catch (e) { return null; }
    }
    st = {
      name: await one("name()", decodeString) || "Untitled",
      symbol: await one("symbol()", decodeString) || "",
      maxSupply: await one("maxSupply()", toNum) || 0,
      minted: await one("totalMinted()", toNum) || 0,
      price: await one("price()", toBig) || 0n,
      fee: await one("mintFee()", toBig) || 0n,
      saleOpen: (await one("saleOpen()", function (h) { return toNum(h) === 1; })) === true,
      maxPerWallet: await one("maxPerWallet()", toNum) || 0,
      gateActive: (await one("gateActive()", function (h) { return toNum(h) === 1; })) === true
    };
    try {
      if (drop()["baseURI()"]) baseUri = decodeString(await call(C, "0x" + drop()["baseURI()"]));
    } catch (e) {}
    if (!baseUri) {
      try {
        var uri = decodeString(await call(C, "0x" + drop()["tokenURI(uint256)"] + word(1)));
        baseUri = uri ? uri.replace(/[^/]*$/, "") : null;
      } catch (e) {}
    }
  }

  function fmtEth(wei) { return window.EvmCollections.fmtEth(wei); }

  /* The links row, which the Solana mint page renders for itself. The EVM
   * driver owns this page on the Robinhood side, so nothing was filling it —
   * there was no marketplace link and no share button here at all. */
  function renderLinks() {
    var box = $("links");
    if (!box) return;
    var out = [];
    var os = chain().opensea;
    if (os) {
      out.push('<a class="ic" href="https://opensea.io/assets/' + os + "/" + C +
        '" target="_blank" rel="noopener" title="OpenSea" aria-label="OpenSea">' +
        '<svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor" aria-hidden="true">' +
        '<path d="M11 3.2v9H4.4L11 3.2z"/>' +                               // mainsail
        '<path d="M12.7 6.6V12.2h4.1L12.7 6.6z"/>' +                        // jib
        '<path d="M2.4 14h19.2l-2 4a2.1 2.1 0 0 1-1.9 1.1H6.3A2.1 2.1 0 0 1 4.4 18l-2-4z"/>' + // hull
        "</svg></a>");
    }
    out.push('<a class="ic" id="share" href="#" title="Share" aria-label="Share">' +
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" ' +
      'stroke-linecap="round" stroke-linejoin="round">' +
      '<circle cx="18" cy="5" r="2.6"/><circle cx="6" cy="12" r="2.6"/>' +
      '<circle cx="18" cy="19" r="2.6"/><path d="M8.3 13.4l7.4 4.3M15.7 6.3l-7.4 4.3"/>' +
      "</svg></a>");
    box.innerHTML = out.join("");

    var sb = $("share");
    if (sb && window.WavesShare) {
      sb.onclick = function (e) {
        e.preventDefault();
        window.WavesShare.open({
          id: C, to: "mint", name: st.name || "This collection", title: "collection"
        });
      };
    }
  }

  /* Quantity stepper — the Robinhood twin of the Solana page's −/+/MAX, which
   * the EVM driver never wired (it always minted one). Capped by whatever is
   * left and by maxPerWallet. */
  function mintCap() {
    var left = st ? Math.max(0, st.maxSupply - st.minted) : 0;
    var per = (st && st.maxPerWallet) || 0;
    var cap = per > 0 ? Math.min(left, per) : left;
    return Math.max(1, Math.min(cap || 1, 50));
  }
  function renderQty() {
    var cap = mintCap();
    if (qty < 1) qty = 1;
    if (qty > cap) qty = cap;
    var n = $("q-n"); if (n) n.textContent = qty;
    var mn = $("q-minus"); if (mn) mn.disabled = qty <= 1;
    var pl = $("q-plus"); if (pl) pl.disabled = qty >= cap;
    var mx = $("q-max"); if (mx) mx.disabled = qty >= cap;
    var lim = $("q-limit");
    if (lim) lim.textContent = (st && st.maxPerWallet) ? "max " + st.maxPerWallet + " per wallet" : cap + " left";
    var cost = $("q-cost");
    if (cost) {
      var total = (st.price + st.fee) * BigInt(qty);
      cost.textContent = total === 0n ? " · free" : " · " + fmtEth(total) + " ETH";
    }
  }
  function showQty(on) {
    var box = $("qty"); if (box) box.hidden = !on;
    var note = $("q-note"); if (note) note.hidden = !on;
    if (on) renderQty();
  }

  function paint() {
    document.title = st.name + " · WAVES";
    $("name").textContent = st.name;
    $("creator").textContent = shortAddr(C);
    $("addr").textContent = shortAddr(C);
    $("minted").textContent = st.minted.toLocaleString() + " / " + st.maxSupply.toLocaleString();
    var pct = st.maxSupply ? Math.min(100, 100 * st.minted / st.maxSupply) : 0;
    $("bar").style.width = pct.toFixed(1) + "%";
    $("pct").textContent = pct.toFixed(1) + "% minted";
    renderLinks();

    var out = st.minted >= st.maxSupply;
    var go = $("go");
    if (out) { showQty(false); go.disabled = true; go.textContent = "Sold out"; return; }
    if (!st.saleOpen) { showQty(false); go.disabled = true; go.textContent = "Sale not open"; return; }
    showQty(true);                                    // clamps qty and prices it
    var total = (st.price + st.fee) * BigInt(qty);
    var priced = total === 0n ? "" : " · " + fmtEth(total) + " ETH";
    var n = qty > 1 ? " " + qty : "";
    go.disabled = false;
    go.textContent = st.gateActive
      // Gated wave: the button mints via the signer (mint() fetches the permit
      // and shows the reason if this wallet isn't eligible yet).
      ? "Mint" + n + " — allowlist" + priced
      : "Mint" + n + (total === 0n ? " — free" : priced);
  }

  /* The metadata dir, read through our /m/ proxy — a fresh Arweave bundle 404s
   * on arweave.net directly (and it caches the 404), so the pfp, banner and
   * pieces would all be blank in the first minutes of a launch. */
  function metaDir() {
    var u = baseUri && baseUri.indexOf("ar://") === 0 ? "https://arweave.net/" + baseUri.slice(5) : baseUri;
    var m = /arweave\.net\/([\w-]{43})\//.exec(u || "");
    return m ? location.origin + "/m/" + m[1] + "/" : (u || "");
  }

  /* Identity from _collection.json (name, pfp, banner), pinned at launch — the
   * Robinhood twin of the Solana page's collection header, which the EVM driver
   * was not filling (it only pulled the pfp from token #1, and never a banner).
   * Falls back to token #1's art for the pfp when the collection has no image. */
  function loadIdentity() {
    if (!baseUri) return;
    var dir = metaDir();
    var setAva = function (img) {
      if (img) $("ava").innerHTML = '<img alt="" src="' + esc(window.EvmCollections.imageUrl(img)) + '">';
    };
    fetch(dir + "_collection.json").then(function (r) { return r.ok ? r.json() : null; })
      .then(function (col) {
        if (col && col.name) { $("name").textContent = col.name; document.title = col.name + " · WAVES"; }
        if (col && col.banner) {
          var b = $("banner"); if (b) { b.src = window.EvmCollections.imageUrl(col.banner); b.hidden = false; }
        }
        if (col && col.image) { setAva(col.image); return null; }
        return fetch(dir + "1.json").then(function (r) { return r.ok ? r.json() : null; })
          .then(function (meta) { if (meta) setAva(meta.image); });
      }).catch(function () {});
  }

  var GRID_MAX = 24;
  function loadPieces() {
    var box = $("pieces");
    if (!baseUri || !st.minted) { $("pieces-none").hidden = false; return; }
    var n = Math.min(st.minted, GRID_MAX);
    var dir = metaDir();
    box.innerHTML = "";
    for (var i = 1; i <= n; i++) (function (id) {
      fetch(dir + id + ".json").then(function (r) { return r.ok ? r.json() : null; })
        .then(function (meta) {
          if (!meta || !meta.image) return;
          var d = document.createElement("a");
          d.className = "piece";
          d.href = chain().explorer + "/token/" + C + "/instance/" + id;
          d.target = "_blank"; d.rel = "noopener";
          d.innerHTML = '<img alt="" loading="lazy" src="' +
            esc(window.EvmCollections.imageUrl(meta.image)) + '">' +
            '<div class="nm">' + esc(meta.name || ("#" + id)) + "</div>";
          box.appendChild(d);
        }).catch(function () {});
    })(i);
  }

  /* The wave ladder, for gated drops — the Robinhood twin of the Solana mint
   * page's phase list. Names, gating and open times come from /api/mint-sig
   * ?facts (the same server-side computation that signs the mint), so the UI
   * and the enforcement never disagree. Hidden entirely for ungated drops. */
  async function renderPhases() {
    var box = $("phases");
    if (!box) return;
    // Show the ladder whenever the collection HAS an allowlist (?facts returns
    // phases), not only while the gate is currently active — gateActive() flips
    // to false the moment the window closes, and hiding on that made the whole
    // allowlist vanish from the mint page. An ungated drop returns an error from
    // ?facts and is hidden below. Solana shows its waves the same way.
    if (!st) { box.hidden = true; return; }
    var mw = window.MoonpadWallet;
    var minter = (mw && mw.account) ? mw.account : "";
    var q = "?facts=1&chainId=" + chain().id + "&collection=" + C + (minter ? "&minter=" + minter : "");
    var f = await fetch("/api/mint-sig" + q).then(function (r) { return r.json(); }).catch(function () { return null; });
    if (!f || f.error || !f.phases || !f.phases.length) { box.hidden = true; return; }
    box.hidden = false;
    var now = Date.now();
    var t = function (secs) {
      return new Date(secs * 1000).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
    };
    var rows = f.phases.map(function (p, i) {
      var open = p.openAt * 1000 <= now;
      var mine = f.wave === i;
      var name = p.name || ("Wave " + (i + 1));
      var who = p.kind === "wallets" ? "wallet allowlist"
        : p.kind === "coin" ? "token holders"
        : p.kind === "nft" ? "collection holders" : "allowlist";
      if (mine) who += " · you qualify";
      return '<div class="ph' + (open ? " open" : "") + (mine ? " mine" : "") + '"><b>' +
        esc(name) + "</b><span>" + who + '</span><span class="st">' +
        (open ? "open" : "opens " + t(p.openAt)) + "</span></div>";
    });
    var pubOpen = f.publicAt * 1000 <= now;
    rows.push('<div class="ph' + (pubOpen ? " open" : "") + (f.wave === -1 ? " mine" : "") +
      '"><b>Public</b><span>everyone</span><span class="st">' +
      (pubOpen ? "open" : "opens " + t(f.publicAt)) + "</span></div>");
    box.innerHTML = rows.join("");
  }

  /* Paired collection: link to its token and to the claim page. The token
   * record carries pairedCollection + vault (set at launch); if one matches this
   * collection, surface both links the Solana mint page has but the EVM driver
   * never filled. */
  function loadPaired() {
    fetch("/api/tokens").then(function (r) { return r.json(); })
      .then(function (j) {
        var t = (j.tokens || []).find(function (x) {
          return x.keeper === "nft" && String(x.pairedCollection || "").toLowerCase() === String(C).toLowerCase();
        });
        if (!t) return;
        var pl = $("pairlink");
        if (pl) {
          pl.href = "/token/" + t.mint;
          pl.innerHTML = '<span class="c"></span><span><b>$' + esc(t.symbol || "TOKEN") +
            "</b><span>The paired token — its trading fees reward this collection's holders</span></span>" +
            '<span class="arw">&rarr;</span>';
          pl.hidden = false;
        }
        var sl = $("stakelink");
        if (sl) {
          sl.href = "/stake?collection=" + C;
          sl.innerHTML = '<span class="c"></span><span><b>Claim holder rewards</b>' +
            "<span>Activate your NFTs and claim your share of the fees</span></span>" +
            '<span class="arw">&rarr;</span>';
          sl.hidden = false;
        }
      }).catch(function () {});
  }

  /* ---- the mint itself ---- */
  function provider() { return window.MOONPAD_ETH(); }

  async function priceTx(tx) {
    try {
      var base = toBig(await rpc("eth_gasPrice", []));
      var tip = 0n;
      try { tip = toBig(await rpc("eth_maxPriorityFeePerGas", [])); }
      catch (e) { tip = base / 10n + 1n; }
      tx.maxFeePerGas = "0x" + (base * 3n + tip).toString(16);
      tx.maxPriorityFeePerGas = "0x" + tip.toString(16);
    } catch (e) {
      try { tx.gasPrice = "0x" + (toBig(await rpc("eth_gasPrice", [])) * 2n).toString(16); }
      catch (e2) {}
    }
    try {
      var est = toBig(await rpc("eth_estimateGas", [tx]));
      tx.gas = "0x" + (est * 12n / 10n).toString(16);
    } catch (e) {}
    return tx;
  }

  async function waitReceipt(hash) {
    for (var i = 0; i < 90; i++) {
      var r = await rpc("eth_getTransactionReceipt", [hash]).catch(function () { return null; });
      if (r) return r;
      await new Promise(function (res) { setTimeout(res, 2000); });
    }
    throw new Error("The transaction is taking a while — check the explorer.");
  }

  async function mint() {
    var go = $("go");
    say("", "");
    try {
      await window.Shell.ensureEvmStack();
      var mw = window.MoonpadWallet;
      if (!mw || !mw.account) {
        await mw.connect();
        mw = window.MoonpadWallet;
        if (!mw.account) return;
        renderPhases();   // now that we know the wallet, highlight its wave
      }
      go.disabled = true; go.textContent = "Confirm in your wallet…";
      await window.MOONPAD_SWITCH_CHAIN(chain());
      var n = Math.max(1, Math.min(qty, mintCap()));
      var value = (st.price + st.fee) * BigInt(n);
      var tx;
      if (st.gateActive) {
        /* Allowlist wave: get a permit from the gate signer for THIS wallet
         * (it recomputes eligibility on-chain), then mintSigned(qty, deadline,
         * sig). A 403 comes back as the reason (not your wave yet / not listed). */
        go.textContent = "Checking allowlist…";
        var permit = await fetch("/api/mint-sig", {
          method: "POST", headers: { "content-type": "application/json" },
          body: JSON.stringify({ chainId: chain().id, collection: C, minter: mw.account })
        }).then(function (r) { return r.json(); }).catch(function () { return null; });
        if (!permit || !permit.sig) {
          throw new Error(permit && permit.error ? permit.error : "You're not eligible for the allowlist yet.");
        }
        var sigHex = String(permit.sig).replace(/^0x/, "");
        var sigPadded = sigHex + "0".repeat((64 - (sigHex.length % 64)) % 64);
        tx = {
          from: mw.account, to: C, value: "0x" + value.toString(16),
          data: "0x" + drop()["mintSigned(uint256,uint256,bytes)"]
            + word(n)                          // quantity
            + word(permit.deadline)            // deadline
            + word(0x60)                       // offset to the bytes arg
            + word(sigHex.length / 2)          // sig byte length (65)
            + sigPadded
        };
      } else {
        tx = {
          from: mw.account, to: C, value: "0x" + value.toString(16),
          data: "0x" + drop()["mint(uint256)"] + word(n)
        };
      }
      await priceTx(tx);
      var hash = await provider().request({ method: "eth_sendTransaction", params: [tx] });
      go.textContent = "Minting…";
      var rec = await waitReceipt(hash);
      if (rec.status !== "0x1") throw new Error("The transaction reverted.");
      say("ok", 'Minted. <a href="' + chain().explorer + "/tx/" + esc(hash) +
        '" target="_blank" rel="noopener">View tx ↗</a>');
      await read(); paint(); loadPieces(); renderPhases();
    } catch (e) {
      var m = String((e && e.message) || e);
      if (/reject|denied|cancel/i.test(m)) m = "You cancelled the transaction.";
      say("err", esc(m.slice(0, 220)));
      paint();
    }
  }

  window.EvmMintPage = {
    init: async function (address) {
      C = address;
      $("t-all").style.display = "none";   // no local template for EVM drops
      try {
        await read();
      } catch (e) {
        $("name").textContent = "Could not reach the chain";
        say("err", "Robinhood Chain did not answer. Refresh to try again.");
        return;
      }
      paint(); loadIdentity(); loadPieces(); renderPhases(); loadPaired();
      var mn = $("q-minus"), pl = $("q-plus"), mx = $("q-max");
      if (mn) mn.onclick = function () { qty--; renderQty(); paint(); };
      if (pl) pl.onclick = function () { qty++; renderQty(); paint(); };
      if (mx) mx.onclick = function () { qty = mintCap(); renderQty(); paint(); };
      $("go").addEventListener("click", mint);
    }
  };
})();
