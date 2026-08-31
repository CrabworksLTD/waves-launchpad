/* The one wallet chip, site-wide. Any page whose nav carries #mConnect gets
   connect / address / hover-disconnect; pages that care listen for
   "moonpad-wallet" and read window.MoonpadWallet.account.

   Wallet discovery is EIP-6963: every installed extension announces itself
   with a name and icon, and when there is more than one the chip opens a
   picker instead of trusting whichever extension hijacked window.ethereum —
   the silent wrong-wallet connect that made balances "disappear". One wallet
   installed means no modal at all; the choice is remembered by rdns and
   resumed silently on the next page. The chosen provider is published as
   MoonpadWallet.provider, which window.MOONPAD_ETH() (chains.js) hands to
   every page. */
(function () {
  function init() {
    var account = null;
    var activeP = null;                 // the provider behind the account
    var providers = [];                 // every EIP-6963 announcement, deduped
    var chip = document.getElementById("mConnect");
    var KEY = "moonpad.wallet.rdns";

    function short(a) { return a.slice(0, 6) + "…" + a.slice(-4); }
    function tell() {
      window.MoonpadWallet = { account: account, connect: connect, provider: activeP,
        disconnect: disconnect };
      window.dispatchEvent(new CustomEvent("moonpad-wallet", { detail: account }));
    }
    function paint() { if (chip) chip.textContent = account ? short(account) : "Connect wallet"; }

    var hooked = [];
    function hook(prov) {
      if (!prov || !prov.on || hooked.indexOf(prov) >= 0) return;
      hooked.push(prov);
      prov.on("accountsChanged", function (a) {
        if (prov !== activeP) return;   // a background wallet's news is not ours
        account = (a && a[0]) || null;
        paint(); tell();
      });
    }

    function adopt(entry, addr, remember) {
      activeP = entry.provider;
      account = addr;
      if (remember && entry.info) {
        try { localStorage.setItem(KEY, entry.info.rdns); } catch (e) {}
      }
      hook(activeP);
      paint(); tell();
    }

    // ---- WalletConnect: the mobile path. A phone browser has no injected
    // extension, so without this a mobile holder cannot connect at all. The SDK
    // is heavy and useless to a desktop extension user, so it is imported only
    // when someone actually clicks the WalletConnect row.
    var WC_PROJECT = "b49b0b248faa4facb591bfdb31fcc69b";
    var wcProvider = null;
    async function getWC() {
      if (wcProvider) return wcProvider;
      // Pinned exactly, not floated at @2. This import is the entire mobile
      // connect path and it is fetched from a CDN at click time: a breaking
      // publish upstream takes mobile connect down with no deploy of ours and
      // no error anyone would see.
      var mod = await import("https://esm.sh/@walletconnect/ethereum-provider@2.23.10");
      var EP = mod.EthereumProvider || (mod.default && mod.default.EthereumProvider) || mod.default;
      wcProvider = await EP.init({
        projectId: WC_PROJECT,
        // 4663 is OPTIONAL, never required.
        //
        // `chains` is WalletConnect's REQUIRED namespace: a wallet that cannot
        // serve every id in it refuses the entire session rather than
        // negotiating down to what it has. Almost no mobile wallet ships
        // Robinhood Chain, so asking for 4663 here asked most of them to say no
        // — not "switch network", a flat refusal at the handshake, which is what
        // a phone actually hit.
        //
        // As an optional chain the session opens on whatever the wallet already
        // carries, and the first transaction runs the same switchChain path
        // every tx flow here already uses (wallet_switchEthereumChain, falling
        // back to wallet_addEthereumChain on 4902). Connect first; add the chain
        // when there is something to sign.
        chains: [],
        optionalChains: [4663],
        showQrModal: true,
        rpcMap: { 4663: "https://rpc.mainnet.chain.robinhood.com" },
        metadata: {
          name: "WAVES",
          description: "One of a kind token and NFT launchpad.",
          url: location.origin,
          icons: [location.origin + "/art/pfp.png"]
        }
      });
      wcProvider.on("accountsChanged", function (a) {
        if (wcProvider !== activeP) return;
        account = (a && a[0]) || null; paint(); tell();
      });
      wcProvider.on("disconnect", function () {
        if (wcProvider !== activeP) return;
        account = null; activeP = null; paint(); tell();
      });
      return wcProvider;
    }

    // ---- discovery. Listen first, then ask; extensions re-announce on request.
    window.addEventListener("eip6963:announceProvider", function (e) {
      var d = e.detail;
      if (!d || !d.info || !d.provider) return;
      for (var i = 0; i < providers.length; i++) {
        if (providers[i].info.uuid === d.info.uuid) return;
      }
      providers.push(d);
      // the remembered wallet resumes itself, silently, the moment it shows up
      var want = null;
      try { want = localStorage.getItem(KEY); } catch (err) {}
      if (!account && want && d.info.rdns === want) {
        d.provider.request({ method: "eth_accounts" }).then(function (a) {
          if (a && a.length && !account) adopt(d, a[0], false);
        }).catch(function () {});
      }
    });
    window.dispatchEvent(new Event("eip6963:requestProvider"));

    // ---- the picker. Built with createElement throughout: names and icons
    // are extension-supplied strings and do not get to be markup. Picking a
    // wallet keeps the modal open in a "confirm in your wallet" state until
    // the extension answers — a modal that vanishes mid-handshake reads as
    // broken, and this is the first thing a new user touches.
    var modal = null;
    function closeModal() { if (modal) { modal.remove(); modal = null; } }

    // One error line inside the picker. textContent, never innerHTML: the string
    // can carry a wallet- or SDK-supplied message and does not get to be markup.
    function wcSay(card, msg) {
      var el = card.querySelector(".mw-err");
      if (!el) {
        el = document.createElement("p");
        el.className = "mw-err";
        var note = card.querySelector(".mw-note");
        card.insertBefore(el, note || null);
      }
      el.textContent = msg;
    }
    function openModal() {
      closeModal();
      modal = document.createElement("div");
      modal.id = "mwPick";
      var back = document.createElement("div");
      back.className = "mw-back";
      back.addEventListener("click", closeModal);
      var card = document.createElement("div");
      card.className = "mw-card";

      var head = document.createElement("div");
      head.className = "mw-head";
      var h = document.createElement("b");
      h.textContent = "Connect a wallet";
      var x = document.createElement("button");
      x.type = "button"; x.className = "mw-x"; x.textContent = "×";
      x.setAttribute("aria-label", "Close");
      x.addEventListener("click", closeModal);
      head.appendChild(h); head.appendChild(x);
      card.appendChild(head);

      // The known names, whether or not they answered the 6963 roll call.
      // Installed ones connect; the rest link to their install page — the
      // full-roster look of the big connect modals, no SDK attached.
      var KNOWN = [
        { name: "MetaMask",        rdns: "io.metamask",         url: "https://metamask.io/download/",       bg: "#f6851b", img: "/art/wallets/metamask.png" },
        { name: "Rabby",           rdns: "io.rabby",            url: "https://rabby.io/",                   bg: "#7084ff", img: "/art/wallets/rabby.png" },
        { name: "Coinbase Wallet", rdns: "com.coinbase.wallet", url: "https://www.coinbase.com/wallet",     bg: "#0052ff", img: "/art/wallets/coinbase.png" },
        { name: "Phantom",         rdns: "app.phantom",         url: "https://phantom.com/download",        bg: "#ab9ff2", img: "/art/wallets/phantom.png" },
        { name: "OKX Wallet",      rdns: "com.okex.wallet",     url: "https://web3.okx.com/download",       bg: "#111111", img: "/art/wallets/okx.png" },
        { name: "Trust Wallet",    rdns: "com.trustwallet.app", url: "https://trustwallet.com/download",    bg: "#0500ff", img: "/art/wallets/trust.png" },
        { name: "Zerion",          rdns: "io.zerion.wallet",    url: "https://zerion.io/download",          bg: "#2461ed", img: "/art/wallets/zerion.png" },
        { name: "Rainbow",         rdns: "me.rainbow",          url: "https://rainbow.me/download",         bg: "#001e59", img: "/art/wallets/rainbow.png" }
      ];
      var have = {};
      providers.forEach(function (e2) { have[e2.info.rdns] = true; });
      var missing = KNOWN.filter(function (k) { return !have[k.rdns]; });

      var busy = false;
      providers.forEach(function (entry) {
        var b = document.createElement("button");
        b.type = "button"; b.className = "mw-row";
        var img = document.createElement("img");
        img.alt = "";
        var icon = (entry.info.icon || "").trim();
        if (/^data:image\//.test(icon)) img.src = icon;
        var s = document.createElement("span");
        s.className = "mw-name";
        s.textContent = entry.info.name || "Wallet";
        var tag = document.createElement("i");
        tag.className = "mw-tag";
        tag.textContent = "Installed";
        b.appendChild(img); b.appendChild(s); b.appendChild(tag);
        b.addEventListener("click", async function () {
          if (busy) return;
          busy = true;
          card.classList.add("mw-busy");
          b.classList.add("mw-wait");
          tag.textContent = "Confirm in " + (entry.info.name || "your wallet") + "…";
          var a = await entry.provider.request({ method: "eth_requestAccounts" })
            .catch(function () { return null; });
          if (a && a.length) {
            adopt(entry, a[0], true);
            closeModal();
          } else {
            busy = false;
            card.classList.remove("mw-busy");
            b.classList.remove("mw-wait");
            tag.textContent = "Installed";
          }
        });
        card.appendChild(b);
      });

      // WalletConnect row — deep-links to a wallet app (MetaMask, Phantom, …) or
      // shows a QR to scan from a phone. Sits after any installed extensions, so
      // on desktop the user's own wallet leads; on mobile, where nothing is
      // injected, it is the first actionable row.
      var wcRow = document.createElement("button");
      wcRow.type = "button"; wcRow.className = "mw-row";
      var wcImg = document.createElement("img");
      wcImg.alt = ""; wcImg.src = "/art/wallets/walletconnect.svg";
      wcImg.onerror = function () {
        var fb = document.createElement("span");
        fb.className = "mw-tile"; fb.style.background = "#3b99fc"; fb.textContent = "W";
        wcImg.replaceWith(fb);
      };
      var wcName = document.createElement("span");
      wcName.className = "mw-name"; wcName.textContent = "WalletConnect";
      var wcTag = document.createElement("i");
      wcTag.className = "mw-tag"; wcTag.textContent = "Scan / mobile";
      wcRow.appendChild(wcImg); wcRow.appendChild(wcName); wcRow.appendChild(wcTag);
      wcRow.addEventListener("click", async function () {
        if (busy) return;
        busy = true; card.classList.add("mw-busy"); wcRow.classList.add("mw-wait");
        wcTag.textContent = "Opening…";
        try {
          var provider = await getWC();
          var a = await provider.enable();      // opens the QR / deep-link modal
          if (a && a.length) {
            hook(provider);
            adopt({ provider: provider, info: { rdns: "walletconnect", name: "WalletConnect" } }, a[0], false);
            closeModal();
            return;
          }
        } catch (e) {
          // This catch used to be silent, which made a refused session, a wallet
          // that will not serve the chain, and a CDN that failed to hand over the
          // SDK all look exactly like the user tapping X: nothing happens, no
          // reason given. On a phone that is both unreportable by whoever hit it
          // and undebuggable by us, so a real failure now says so. A deliberate
          // cancel stays quiet — that one the user already knows about.
          var m = (e && e.message ? e.message : String(e || ""));
          if (!/user (rejected|disapproved|closed)|modal closed|cancell?ed|closeModal/i.test(m)) {
            wcSay(card, m ? "WalletConnect: " + m
                          : "Could not open WalletConnect. Check your connection and try again.");
          }
        }
        busy = false; card.classList.remove("mw-busy"); wcRow.classList.remove("mw-wait");
        wcTag.textContent = "Scan / mobile";
      });
      card.appendChild(wcRow);

      missing.forEach(function (k) {
        var b = document.createElement("a");
        b.className = "mw-row mw-get";
        b.href = k.url; b.target = "_blank"; b.rel = "noopener";
        // the real mark, self-hosted; the monogram tile only if it fails
        var tile = document.createElement("img");
        tile.className = "mw-tile-img";
        tile.alt = "";
        tile.src = k.img;
        tile.onerror = function () {
          var fb = document.createElement("span");
          fb.className = "mw-tile";
          fb.style.background = k.bg;
          fb.textContent = k.name[0];
          tile.replaceWith(fb);
        };
        var s = document.createElement("span");
        s.className = "mw-name";
        s.textContent = k.name;
        var tag = document.createElement("i");
        tag.className = "mw-tag";
        tag.textContent = "Get →";
        b.appendChild(tile); b.appendChild(s); b.appendChild(tag);
        card.appendChild(b);
      });

      // The escape hatch for a mobile holder whose wallet has no WalletConnect
      // and no extension: open the site inside the wallet app's own browser.
      var note = document.createElement("p");
      note.className = "mw-note";
      note.textContent = "On a phone and don’t see your wallet? Open this site in your wallet app’s built-in browser to connect there.";
      card.appendChild(note);

      var foot = document.createElement("p");
      foot.className = "mw-foot";
      foot.textContent = "Connecting shares your address only. Nothing moves without a signature.";
      card.appendChild(foot);

      modal.appendChild(back); modal.appendChild(card);
      document.body.appendChild(modal);
    }
    document.addEventListener("keydown", function (e) {
      if (e.key === "Escape") closeModal();
    });

    async function connect() {
      if (providers.length > 1) return openModal();
      var entry = providers[0] ||
        (window.ethereum ? { provider: window.ethereum } : null);
      // Nothing injected — a plain mobile browser. Open the picker so
      // WalletConnect (and the in-app-browser notice) are reachable, instead of
      // the old dead end that told a phone user "No wallet found".
      if (!entry) return openModal();
      var a = await entry.provider.request({ method: "eth_requestAccounts" })
        .catch(function () { return null; });
      if (a && a.length) adopt(entry, a[0], !!entry.info);
    }

    async function disconnect() {
      var prov = activeP || window.ethereum;
      var wasWC = !!wcProvider && prov === wcProvider;
      account = null; activeP = null;
      try { localStorage.removeItem(KEY); } catch (e) {}
      paint(); tell();
      // WalletConnect has no wallet_revokePermissions — with WC the session IS
      // the permission, and it lives in the wallet app and in the SDK's own
      // localStorage. Calling the EIP-2255 method on it merely throws into the
      // catch below, so Disconnect cleared the chip on screen while the phone
      // stayed paired and the stale session came back on the next connect.
      if (wasWC) {
        try { await prov.disconnect(); } catch (e) {}
        wcProvider = null;   // next connect builds a fresh session, not a ghost
        return;
      }
      try {
        await prov.request({ method: "wallet_revokePermissions",
                             params: [{ eth_accounts: {} }] });
      } catch (e) {}
    }

    if (chip) {
      chip.addEventListener("click", function () { account ? disconnect() : connect(); });
      chip.addEventListener("mouseenter", function () { if (account) chip.textContent = "Disconnect ×"; });
      chip.addEventListener("mouseleave", function () { if (account) paint(); });
    }
    tell();

    // ---- resume for the pre-6963 world: no remembered wallet, or none of the
    // announcers matched — ask the injected slot like the site always did.
    // Deferred a beat so 6963 announcements get first claim.
    setTimeout(function () {
      if (account || !window.ethereum) return;
      var want = null;
      try { want = localStorage.getItem(KEY); } catch (e) {}
      if (want && providers.length) return;   // its wallet will resume itself
      window.ethereum.request({ method: "eth_accounts" }).then(function (a) {
        if (a && a.length && !account) adopt({ provider: window.ethereum }, a[0], false);
      }).catch(function () {});
    }, 400);

    var css = document.createElement("style");
    css.textContent =
      "#mwPick{position:fixed;inset:0;z-index:2000}" +
      "#mwPick .mw-back{position:absolute;inset:0;background:rgba(4,5,8,.74);backdrop-filter:blur(4px);" +
        "animation:mwFade .18s ease-out}" +
      "#mwPick .mw-card{position:absolute;top:50%;left:50%;transform:translate(-50%,-50%);" +
        "width:min(372px,92vw);background:linear-gradient(180deg,#191b21,#131519);" +
        "border:1px solid #2a2d35;border-radius:2px;padding:18px 18px 14px;" +
        "box-shadow:0 24px 70px rgba(0,0,0,.55);animation:mwIn .2s ease-out}" +
      "@keyframes mwFade{from{opacity:0}}" +
      "@keyframes mwIn{from{opacity:0;transform:translate(-50%,-48.5%) scale(.97)}}" +
      "#mwPick .mw-head{display:flex;align-items:center;justify-content:space-between;margin-bottom:12px}" +
      "#mwPick .mw-head b{font-weight:700;font-size:15.5px;color:#e9eeec}" +
      "#mwPick .mw-x{background:none;border:0;color:#616a75;font-size:22px;line-height:1;" +
        "cursor:pointer;padding:0 2px}" +
      "#mwPick .mw-x:hover{color:#e9eeec}" +
      "#mwPick .mw-row{display:flex;align-items:center;gap:12px;width:100%;margin-top:8px;" +
        "padding:12px;background:#0d0e13;border:1px solid #2c2f38;border-radius:2px;" +
        "color:#e9eeec;font:600 13.5px inherit;cursor:pointer;text-align:left;" +
        "transition:border-color .2s,background .2s}" +
      "#mwPick .mw-row:hover{border-color:#c9f53f;background:rgba(201,245,63,.05)}" +
      "#mwPick .mw-row img{width:30px;height:30px;border-radius:5px;background:#171c22;flex:none}" +
      "#mwPick .mw-name{flex:1}" +
      "#mwPick .mw-tag{font:500 10.5px ui-monospace,monospace;font-style:normal;color:#616a75;" +
        "letter-spacing:.06em}" +
      "#mwPick .mw-row.mw-wait{border-color:#c9f53f}" +
      "#mwPick .mw-row.mw-wait .mw-tag{color:#c9f53f}" +
      "#mwPick .mw-busy .mw-row:not(.mw-wait){opacity:.35;pointer-events:none}" +
      "#mwPick .mw-card{max-height:min(560px,86vh);overflow-y:auto}" +
      "#mwPick .mw-row.mw-get{text-decoration:none}" +
      "#mwPick .mw-row.mw-get:hover{border-color:#3a4149;background:rgba(255,255,255,.03)}" +
      "#mwPick .mw-tile-img{width:30px;height:30px;border-radius:5px;flex:none;background:#171c22}" +
      "#mwPick .mw-tile{width:30px;height:30px;border-radius:5px;flex:none;display:flex;" +
        "align-items:center;justify-content:center;color:#fff;font:800 14px inherit}" +
      "#mwPick .mw-err{margin:12px 0 0;padding:10px 12px;border:1px solid #5c2b2b;border-radius:2px;" +
        "background:rgba(220,80,80,.08);color:#ea9a9a;font-size:11.5px;line-height:1.55}" +
      "#mwPick .mw-note{margin:14px 0 0;padding:10px 12px;border:1px solid #2c2f38;border-radius:2px;" +
        "background:#0d0e13;color:#8b9094;font-size:11.5px;line-height:1.55}" +
      "#mwPick .mw-foot{margin:12px 0 0;padding-top:12px;border-top:1px solid #22242c;" +
        "color:#616a75;font-size:11.5px;line-height:1.5}" +
      "#mwPick .mw-foot a{color:#c9f53f;text-decoration:none;font-weight:600}";
    document.head.appendChild(css);
  }
  if (document.readyState !== "loading") init();
  else document.addEventListener("DOMContentLoaded", init);
})();
