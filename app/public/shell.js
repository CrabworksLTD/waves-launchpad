(function () {
  "use strict";
  /* The shared chrome: top bar, nav, wallet button, search. Mounted by every
   * page, implemented once.
   *
   *   Shell.mount({ active: "collections", search: true });
   *
   * This file exists because the bar was implemented twice — index.html and
   * mint.html — and the copies had already drifted by the time there were two
   * of them. Three more pages are coming (token launch, staking, docs); one
   * implementation or five drifting ones.
   *
   * Styles are injected from here rather than kept in a stylesheet, so a page
   * cannot mount the shell and forget its CSS, and the prefix (shl-) keeps it
   * out of page namespaces.
   *
   * Search does not know what a page shows. It dispatches "shell:search" on
   * document with {query} and the page filters whatever it owns. Pages that
   * pass search:false simply do not get the icon.
   */

  var H = window.UI.html, raw = window.UI.raw, render = window.UI.render,
      on = window.UI.on, shortAddr = window.UI.shortAddr;

  var NAV = [
    { id: "collections", label: "Collections", href: "/" },
    { id: "launch",      label: "Launch",      href: "/app" },
    { id: "tools",       label: "Tools",       href: "#" },
    { id: "docs",        label: "Docs",        href: "#" },
    { id: "faq",         label: "FAQ",         href: "#" }
  ];

  var CSS = [
    ".shl{position:sticky;top:0;z-index:40;display:flex;align-items:center;gap:16px;",
    "  height:60px;padding:0 20px;background:var(--void);border-bottom:1px solid var(--line)}",
    ".shl .zone{flex:1 1 0;display:flex;align-items:center;gap:10px;min-width:0}",
    ".shl .zone.r{justify-content:flex-end}",
    ".shl-mark{width:30px;height:30px;border-radius:9px;background:var(--grad);flex:none;",
    "  display:grid;place-items:center;font:700 14px 'Space Grotesk',sans-serif;",
    "  color:var(--accent-ink);text-decoration:none}",
    ".shl-ico{width:34px;height:34px;border-radius:9px;border:0;background:transparent;",
    "  color:var(--faint);display:grid;place-items:center;cursor:pointer;flex:none;",
    "  transition:color .18s,background .18s}",
    ".shl-ico:hover{color:var(--ink);background:var(--panel2)}",
    ".shl-ico svg{width:17px;height:17px;stroke:currentColor;fill:none;stroke-width:1.9;",
    "  stroke-linecap:round;stroke-linejoin:round}",
    ".shl-nav{display:flex;align-items:center;gap:4px;flex:none}",
    ".shl-nav a{padding:8px 14px;border-radius:8px;font-size:14px;color:var(--dim);",
    "  text-decoration:none;transition:color .18s,background .18s}",
    ".shl-nav a:hover{color:var(--ink);background:var(--panel2)}",
    ".shl-nav a.on{color:var(--ink)}",
    /* Hollow pill: the gradient runs through a transparent 1px border via the
     * padding-box/border-box double background, and through the lettering via
     * background-clip on an inner span — it cannot sit on the button itself,
     * because that background is already busy being the border. */
    ".shl-wallet{font:700 13.5px Archivo,'Space Grotesk',sans-serif;cursor:pointer;",
    "  padding:9px 18px;border-radius:999px;border:1px solid transparent;",
    "  background:linear-gradient(var(--void),var(--void)) padding-box,",
    "    var(--grad) border-box;",
    "  white-space:nowrap;transition:filter .2s}",
    ".shl-wallet span{background:var(--grad);-webkit-background-clip:text;",
    "  background-clip:text;color:transparent}",
    ".shl-wallet:hover{filter:brightness(1.18)}",
    ".shl-wallet.linked span{background:none;color:var(--dim);",
    "  font:400 12.5px 'IBM Plex Mono',monospace}",
    ".shl-search{display:none;flex:1;min-width:0}",
    ".shl-search.open{display:block}",
    ".shl-search input{width:100%;max-width:320px;background:var(--bg);color:var(--ink);",
    "  border:1px solid var(--line2);border-radius:8px;padding:8px 11px;",
    "  font:400 13.5px Inter,sans-serif}",
    ".shl-search input:focus{outline:none;border-color:var(--faint)}",
    /* connect popup */
    ".shl-back{position:fixed;inset:0;z-index:60;background:rgba(0,0,0,.72);",
    "  backdrop-filter:blur(5px);display:grid;place-items:center;padding:24px}",
    ".shl-card{width:min(400px,100%);background:var(--panel);border:1px solid var(--line2);",
    "  border-radius:14px;padding:20px}",
    ".shl-card .hd{display:flex;align-items:center;justify-content:space-between;margin-bottom:14px}",
    ".shl-card .hd b{font:700 15px Archivo,sans-serif}",
    ".shl-card .hd button{width:30px;height:30px;border:0;border-radius:8px;background:transparent;",
    "  color:var(--faint);font-size:17px;cursor:pointer}",
    ".shl-card .hd button:hover{background:var(--panel2);color:var(--ink)}",
    ".shl-w{display:flex;align-items:center;gap:12px;width:100%;padding:10px;margin-top:6px;",
    "  border:1px solid var(--line);border-radius:10px;background:transparent;cursor:pointer;",
    "  text-align:left;font:inherit;color:var(--ink);text-decoration:none;",
    "  transition:border-color .15s,background .15s}",
    ".shl-w:hover{border-color:var(--faint);background:var(--panel2)}",
    ".shl-w .ic{width:34px;height:34px;border-radius:9px;flex:none;display:grid;",
    "  place-items:center;font:700 15px Archivo,sans-serif;color:#fff;overflow:hidden}",
    ".shl-w .ic img{width:100%;height:100%;display:block}",
    ".shl-w b{font:600 13.5px Inter,sans-serif;flex:1}",
    ".shl-w .st{font-size:11.5px;color:var(--faint)}",
    ".shl-w.busy{pointer-events:none;border-color:var(--accent)}",
    ".shl-w.busy .st{color:var(--accent)}",
    ".shl-werr{margin-top:10px;font-size:12px;color:#ffb3b3;background:rgba(255,107,107,.1);",
    "  border:1px solid rgba(255,107,107,.35);border-radius:8px;padding:9px 11px}",
    "@media (max-width:860px){.shl-nav{display:none}.shl{gap:10px}}"
  ].join("\n");

  function ensureCss() {
    if (document.getElementById("shl-css")) return;
    var s = document.createElement("style");
    s.id = "shl-css";
    s.textContent = CSS;
    document.head.appendChild(s);
  }

  function mount(opts) {
    opts = opts || {};
    ensureCss();

    var host = document.getElementById("shell");
    if (!host) {
      host = document.createElement("header");
      host.id = "shell";
      document.body.insertBefore(host, document.body.firstChild);
    }
    host.className = "shl";

    var markChar = (window.BRAND && window.BRAND.name || "S").slice(0, 1);

    render(host, H`
      <div class="zone">
        <a class="shl-mark" href="/" aria-label="Home">${markChar}</a>
        ${opts.search === false ? "" : raw(
          '<button class="shl-ico" id="shl-searchbtn" aria-label="Search" title="Search">' +
          '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="11" r="7"/>' +
          '<path d="m20 20-3.6-3.6"/></svg></button>' +
          '<div class="shl-search" id="shl-searchwrap">' +
          '<input id="shl-q" type="search" placeholder="Search" autocomplete="off"></div>')}
      </div>
      <nav class="shl-nav" aria-label="Main">
        ${raw(NAV.map(function (n) {
          return '<a href="' + n.href + '"' +
            (n.id === opts.active ? ' class="on" aria-current="page"' : "") + ">" +
            window.UI.esc(n.label) + "</a>";
        }).join(""))}
      </nav>
      <div class="zone r">
        <button class="shl-wallet" id="shl-wallet"><span>Connect wallet</span></button>
      </div>
    `);

    /* ---- search ---- */
    if (opts.search !== false) {
      var wrap = document.getElementById("shl-searchwrap");
      var input = document.getElementById("shl-q");
      var say = function (q) {
        document.dispatchEvent(new CustomEvent("shell:search", { detail: { query: q } }));
      };
      document.getElementById("shl-searchbtn").addEventListener("click", function () {
        wrap.classList.toggle("open");
        if (wrap.classList.contains("open")) input.focus();
        else { input.value = ""; say(""); }
      });
      input.addEventListener("input", function () { say(input.value); });
      input.addEventListener("keydown", function (e) {
        if (e.key === "Escape") { input.value = ""; say(""); wrap.classList.remove("open"); }
      });
    }

    /* ---- wallet ---- */
    var btn = document.getElementById("shl-wallet");
    function paint() {
      var w = window.Wallet && window.Wallet.current();
      if (w) {
        btn.className = "shl-wallet linked";
        btn.innerHTML = "<span>" + window.UI.esc(shortAddr(w.publicKey)) + "</span>";
        btn.title = w.name + " — click to disconnect";
      } else {
        btn.className = "shl-wallet";
        btn.innerHTML = "<span>Connect wallet</span>";
        btn.title = "";
      }
    }
    btn.addEventListener("click", function () {
      if (!window.Wallet) return;
      if (window.Wallet.current()) {
        window.Wallet.disconnect().then(paint);
        return;
      }
      connectModal().then(paint);
    });
    if (window.Wallet) window.Wallet.on("change", paint);
    paint();
    // wallets may register after page load; recheck briefly rather than never
    var n = 0, t = setInterval(function () { paint(); if (++n > 5) clearInterval(t); }, 450);
  }

  /* The connect popup, after Moonpad's: the full roster of known wallets,
   * whether or not they answered the roll call. Installed ones connect and
   * hold a "confirm in your wallet" state until the extension answers — a
   * popup that vanishes mid-handshake reads as a failure. Missing ones link
   * to their install page. Detected wallets bring their own icon (Wallet
   * Standard ships one as a data URI); the roster fallback is a brand tile. */
  var KNOWN = [
    { match: /phantom/i,  name: "Phantom",  bg: "#ab9ff2", url: "https://phantom.com/download" },
    { match: /solflare/i, name: "Solflare", bg: "#fc7227", url: "https://solflare.com/download" },
    { match: /backpack/i, name: "Backpack", bg: "#e33e3f", url: "https://backpack.app/download" },
    { match: /metamask/i, name: "MetaMask", bg: "#f6851b", url: "https://metamask.io/download/" },
    { match: /okx/i,      name: "OKX Wallet", bg: "#111111", url: "https://web3.okx.com/download" },
    { match: /coinbase/i, name: "Coinbase Wallet", bg: "#0052ff", url: "https://www.coinbase.com/wallet" }
  ];
  var LAST_KEY = (window.BRAND ? window.BRAND.key("wallet") : "wallet.last");

  function connectModal() {
    return new Promise(function (resolve) {
      var old = document.getElementById("shl-pick");
      if (old) old.remove();

      var back = document.createElement("div");
      back.className = "shl-back";
      back.id = "shl-pick";
      back.addEventListener("click", function (e) {
        if (e.target === back) { back.remove(); resolve(null); }
      });

      var detected = window.Wallet ? window.Wallet.list() : [];
      var last = null;
      try { last = localStorage.getItem(LAST_KEY); } catch (e) {}

      var rows = KNOWN.map(function (k) {
        var hit = detected.find(function (d) { return k.match.test(d.name); });
        return { known: k, det: hit || null, recent: hit && hit.name === last };
      });
      // detected wallets the roster does not know still get a row
      detected.forEach(function (d) {
        if (!rows.some(function (r) { return r.det && r.det.id === d.id; })) {
          rows.push({ known: { name: d.name, bg: "#333" }, det: d, recent: d.name === last });
        }
      });
      rows.sort(function (a, b) {
        return (b.recent - a.recent) || (!!b.det - !!a.det);
      });

      var card = document.createElement("div");
      card.className = "shl-card";
      card.innerHTML = '<div class="hd"><b>Connect a wallet</b>' +
        '<button aria-label="Close">×</button></div>' +
        rows.map(function (r, i) {
          var ic = r.det && r.det.icon
            ? '<span class="ic"><img alt="" src="' + window.UI.esc(r.det.icon) + '"></span>'
            : '<span class="ic" style="background:' + r.known.bg + '">' +
              window.UI.esc(r.known.name.slice(0, 1)) + "</span>";
          if (r.det) {
            return '<button class="shl-w" data-i="' + i + '">' + ic +
              "<b>" + window.UI.esc(r.det.name) + "</b>" +
              '<span class="st">' + (r.recent ? "Recent" : "Detected") + "</span></button>";
          }
          return '<a class="shl-w" href="' + r.known.url + '" target="_blank" rel="noopener">' +
            ic + "<b>" + window.UI.esc(r.known.name) + '</b><span class="st">Install ↗</span></a>';
        }).join("") +
        '<div id="shl-werr" hidden class="shl-werr"></div>';
      back.appendChild(card);
      document.body.appendChild(back);

      card.querySelector(".hd button").addEventListener("click", function () {
        back.remove(); resolve(null);
      });
      card.querySelectorAll("button.shl-w").forEach(function (b) {
        b.addEventListener("click", function () {
          var r = rows[+b.dataset.i];
          b.classList.add("busy");
          b.querySelector(".st").textContent = "Confirm in your wallet…";
          window.Wallet.connect(r.det.id).then(function (w) {
            try { localStorage.setItem(LAST_KEY, r.det.name); } catch (e) {}
            back.remove(); resolve(w);
          }).catch(function (e) {
            b.classList.remove("busy");
            b.querySelector(".st").textContent = r.recent ? "Recent" : "Detected";
            var err = card.querySelector("#shl-werr");
            err.hidden = false;
            err.textContent = /reject/i.test(String(e && e.message))
              ? "You declined in the wallet."
              : String(e && e.message || "Could not connect.").slice(0, 120);
          });
        });
      });
    });
  }

  window.Shell = { mount: mount, connect: connectModal };
})();
