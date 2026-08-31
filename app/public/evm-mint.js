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
        '<img src="/art/opensea.png" alt="" width="16" height="16"></a>');
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

  function paint() {
    document.title = st.name + " · WAVES";
    $("name").textContent = st.name;
    $("creator").textContent = shortAddr(C);
    $("addr").textContent = shortAddr(C);
    $("minted").textContent = st.minted.toLocaleString() + " / " + st.maxSupply.toLocaleString();
    var pct = st.maxSupply ? Math.min(100, 100 * st.minted / st.maxSupply) : 0;
    $("bar").style.width = pct.toFixed(1) + "%";
    $("pct").textContent = pct.toFixed(1) + "% minted";
    document.querySelector(".sale .foot").textContent =
      "Runs on Robinhood Chain. Nothing custom in the middle.";
    renderLinks();

    var total = st.price + st.fee;
    var out = st.minted >= st.maxSupply;
    var go = $("go");
    if (out) { go.disabled = true; go.textContent = "Sold out"; return; }
    if (!st.saleOpen) { go.disabled = true; go.textContent = "Sale not open"; return; }
    if (st.gateActive) {
      go.disabled = true; go.textContent = "Allowlist phase";
      say("err", "This collection is in a gated allowlist phase. " +
        "Minting opens here when the public phase begins.");
      return;
    }
    go.disabled = false;
    go.textContent = total === 0n ? "Mint — free" : "Mint — " + fmtEth(total) + " ETH";
  }

  /* identity extras from the metadata dir, when they exist */
  function loadIdentity() {
    if (!baseUri) return;
    var arw = function (u) {
      return u && u.indexOf("ar://") === 0 ? "https://arweave.net/" + u.slice(5) : u;
    };
    fetch(arw(baseUri) + "1.json").then(function (r) { return r.ok ? r.json() : null; })
      .then(function (meta) {
        if (meta && meta.image)
          $("ava").innerHTML = '<img alt="" src="' + esc(window.EvmCollections.imageUrl(meta.image)) + '">';
      }).catch(function () {});
  }

  var GRID_MAX = 24;
  function loadPieces() {
    var box = $("pieces");
    if (!baseUri || !st.minted) { $("pieces-none").hidden = false; return; }
    var n = Math.min(st.minted, GRID_MAX);
    var arw = function (u) {
      return u && u.indexOf("ar://") === 0 ? "https://arweave.net/" + u.slice(5) : u;
    };
    box.innerHTML = "";
    for (var i = 1; i <= n; i++) (function (id) {
      fetch(arw(baseUri) + id + ".json").then(function (r) { return r.ok ? r.json() : null; })
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
      }
      go.disabled = true; go.textContent = "Confirm in your wallet…";
      await window.MOONPAD_SWITCH_CHAIN(chain());
      var value = (st.price + st.fee);
      var tx = {
        from: mw.account, to: C,
        value: "0x" + value.toString(16),
        data: "0x" + drop()["mint(uint256)"] + word(1)
      };
      await priceTx(tx);
      var hash = await provider().request({ method: "eth_sendTransaction", params: [tx] });
      go.textContent = "Minting…";
      var rec = await waitReceipt(hash);
      if (rec.status !== "0x1") throw new Error("The transaction reverted.");
      say("ok", 'Minted. <a href="' + chain().explorer + "/tx/" + esc(hash) +
        '" target="_blank" rel="noopener">View tx ↗</a>');
      await read(); paint(); loadPieces();
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
      $("phases").hidden = true;
      $("t-all").style.display = "none";   // no local template for EVM drops
      try {
        await read();
      } catch (e) {
        $("name").textContent = "Could not reach the chain";
        say("err", "Robinhood Chain did not answer. Refresh to try again.");
        return;
      }
      paint(); loadIdentity(); loadPieces();
      $("go").addEventListener("click", mint);
    }
  };
})();
