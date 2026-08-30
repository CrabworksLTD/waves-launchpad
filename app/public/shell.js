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
      var found = window.Wallet.list();
      if (!found.length) { btn.innerHTML = "<span>No wallet found</span>"; return; }
      window.Wallet.connect(found[0].id).then(paint).catch(function () { paint(); });
    });
    if (window.Wallet) window.Wallet.on("change", paint);
    paint();
    // wallets may register after page load; recheck briefly rather than never
    var n = 0, t = setInterval(function () { paint(); if (++n > 5) clearInterval(t); }, 450);
  }

  window.Shell = { mount: mount };
})();
