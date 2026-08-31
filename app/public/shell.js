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

  /* Chain skin. The selector's choice persists, and the data-chain attribute
   * flips theme.css's variable block — set it here, before any shell markup
   * renders, so a Robinhood visitor doesn't get a purple flash. Launches are
   * still Solana-only; this recolours, it does not rewire. */
  var CHAINS = {
    solana:    { label: "Solana",          icon: "/art/solana.svg" },
    robinhood: { label: "Robinhood Chain", icon: "/art/robinhood.svg" }
  };
  function currentChain() {
    try { var c = localStorage.getItem("shl-chain"); } catch (e) {}
    return CHAINS[c] ? c : "solana";
  }
  function applyChain(net) {
    if (!CHAINS[net]) net = "solana";
    try { localStorage.setItem("shl-chain", net); } catch (e) {}
    if (net === "solana") delete document.documentElement.dataset.chain;
    else document.documentElement.dataset.chain = net;
    var trig = document.querySelector("#shl-nmenu .shl-net");
    if (trig) {
      trig.querySelector("img").src = CHAINS[net].icon;
      trig.querySelector("span").textContent =
        net === "robinhood" ? "Robinhood" : CHAINS[net].label;
    }
  }
  if (currentChain() !== "solana") {
    document.documentElement.dataset.chain = currentChain();
  }

  // No "Collections" home link — the logo mark is the way home, and the
  // Explore menu is the way to the marketplaces.
  var NAV = [
    // Launch is a menu, not a link: the three launch modes, reachable from any
    // page. On /app the items open the panel directly; elsewhere they carry
    // the mode in the query and the panel opens itself on arrival.
    { id: "launch", label: "Launch", menu: [
      { label: "Token",      mode: "token" },
      { label: "Collection", mode: "collection" },
      { label: "Pair",       mode: "pair" }
    ]},
    { id: "explore", label: "Explore", menu: [
      { label: "Tokens",      href: "/tokens" },
      { label: "Collections", href: "/collections" },
      { label: "Staking",     href: "/stake" },
      { label: "Claim fees",   href: "/fees" }
    ]},
    { id: "docs",        label: "Docs",        href: "/docs" },
    { id: "faq",         label: "FAQ",         href: "/faq" }
  ];

  var CSS = [
    ".shl{position:sticky;top:0;z-index:40;display:flex;align-items:center;gap:16px;",
    "  height:68px;padding:0 24px;background:var(--void);border-bottom:1px solid var(--line)}",
    ".shl .zone{flex:1 1 0;display:flex;align-items:center;gap:10px;min-width:0}",
    ".shl .zone.r{justify-content:flex-end}",
    ".shl-mark{flex:none;display:flex;align-items:center;gap:10px;",
    "  text-decoration:none;transition:transform .2s}",
    ".shl-mark svg{width:30px;height:30px;display:block}",
    ".shl-mark b{font:800 19px Archivo,'Space Grotesk',sans-serif;letter-spacing:-.02em;",
    "  color:var(--ink)}",
    ".shl-mark:hover{transform:translateY(-1px)}",
    "@media (max-width:560px){.shl-mark b{display:none}}",
    ".shl-ico{width:40px;height:40px;border-radius:9px;border:0;background:transparent;",
    "  color:var(--faint);display:grid;place-items:center;cursor:pointer;flex:none;",
    "  transition:color .18s,background .18s}",
    ".shl-ico:hover{color:var(--ink);background:var(--panel2)}",
    ".shl-ico svg{width:20px;height:20px;stroke:currentColor;fill:none;stroke-width:1.9;",
    "  stroke-linecap:round;stroke-linejoin:round}",
    ".shl-nav{display:flex;align-items:center;gap:4px;flex:none}",
    ".shl-nav a{padding:10px 16px;border-radius:9px;font:500 15.5px Inter,sans-serif;color:var(--dim);",
    "  text-decoration:none;transition:color .18s,background .18s}",
    ".shl-nav a:hover{color:var(--ink);background:var(--panel2)}",
    ".shl-nav a.on{color:var(--ink)}",
    ".shl-dd{position:relative}",
    /* :not(.shl-wallet) — the wallet pill lives inside a .shl-dd wrapper too,
     * and this trigger rule outspecifies .shl-wallet, which silently stripped
     * the pill's gradient border for weeks */
    ".shl-dd>button:not(.shl-wallet){padding:10px 16px;border:0;border-radius:9px;",
    "  font:500 15.5px Inter,sans-serif;",
    "  color:var(--dim);background:transparent;cursor:pointer;display:flex;gap:6px;",
    "  align-items:center;transition:color .18s,background .18s}",
    ".shl-dd>button:not(.shl-wallet):hover,.shl-dd.open>button:not(.shl-wallet){",
    "  color:var(--ink);background:var(--panel2)}",
    ".shl-dd>button i{font-style:normal;font-size:10px;transform:translateY(1px)}",
    ".shl-dd .menu{position:absolute;top:calc(100% + 8px);left:50%;transform:translateX(-50%);",
    "  min-width:150px;background:var(--panel);border:1px solid var(--line2);border-radius:10px;",
    "  padding:6px;display:none;box-shadow:0 18px 50px -20px rgba(0,0,0,.9)}",
    ".shl-dd.open .menu{display:block}",
    ".shl-dd .menu a{display:block;padding:10px 14px;border-radius:7px;font-size:14.5px;",
    "  color:var(--ink);text-decoration:none}",
    ".shl-dd .menu a:hover{background:var(--panel2)}",
    ".shl-dd.r .menu{left:auto;right:0;transform:none}",
    /* Hollow pill: the gradient runs through a transparent 1px border via the
     * padding-box/border-box double background, and through the lettering via
     * background-clip on an inner span — it cannot sit on the button itself,
     * because that background is already busy being the border. */
    ".shl-wallet{font:700 15px Archivo,'Space Grotesk',sans-serif;cursor:pointer;",
    "  padding:11px 22px;border-radius:999px;border:1px solid var(--line2);",
    "  background:var(--void);",
    "  white-space:nowrap;transition:filter .2s,border-color .2s}",
    ".shl-wallet:hover{border-color:var(--faint)}",
    ".shl-wallet span{background:var(--grad);-webkit-background-clip:text;",
    "  background-clip:text;color:transparent}",
    ".shl-wallet:hover{filter:brightness(1.18)}",
    ".shl-wallet.linked span{background:none;color:var(--dim);",
    "  font:400 14px 'IBM Plex Mono',monospace}",
    /* network selector: which chain the pad is pointed at */
    ".shl-net{display:flex;align-items:center;gap:8px;padding:10px 16px;",
    "  border:1px solid var(--line2);border-radius:999px;background:transparent;",
    "  cursor:pointer;font:600 13.5px Inter,sans-serif;color:var(--ink);",
    "  white-space:nowrap;transition:border-color .2s}",
    ".shl-net:hover{border-color:var(--faint)}",
    ".shl-net svg{width:14px;height:14px;display:block}",
    ".shl-net i{font-style:normal;font-size:10px;color:var(--faint)}",
    "#shl-nmenu .menu{min-width:210px}",
    "#shl-nmenu .menu a{display:flex;align-items:center;gap:10px}",
    "#shl-nmenu .menu .soon{margin-left:auto;font:600 9px 'IBM Plex Mono',monospace;",
    "  letter-spacing:.14em;color:#ffb84d;border:1px solid rgba(255,180,80,.45);",
    "  border-radius:99px;padding:3px 8px}",
    "@media (max-width:700px){.shl-net span{display:none}}",
    ".shl-search{display:none;flex:1;min-width:0}",
    ".shl-search.open{display:block}",
    ".shl-search input{width:100%;max-width:320px;background:var(--bg);color:var(--ink);",
    "  border:1px solid var(--line2);border-radius:8px;padding:8px 11px;",
    "  font:400 13.5px Inter,sans-serif}",
    ".shl-search input:focus{outline:none;border-color:var(--faint)}",
    /* connect popup */
    ".shl-back{position:fixed;inset:0;z-index:60;background:rgba(0,0,0,.72);",
    "  backdrop-filter:blur(5px);display:grid;place-items:center;padding:24px}",
    ".shl-card{width:min(400px,100%);background:var(--panel);",
    "  border:1px solid var(--line2);border-radius:14px;padding:20px}",
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
    ".shl-w .tx{flex:1;min-width:0}",
    ".shl-w .tx b{display:block}",
    ".shl-w .tx small{display:block;color:var(--faint);font-size:11.5px;margin-top:1px}",
    /* launch gate: the site blurred behind a password card */
    "#shl-gate{position:fixed;inset:0;z-index:999;display:grid;place-items:center;",
    "  padding:24px;background:rgba(0,0,0,.35);",
    "  backdrop-filter:blur(13px) brightness(.75);-webkit-backdrop-filter:blur(13px) brightness(.75)}",
    "#shl-gate .gcard{width:min(360px,100%);border:1px solid transparent;border-radius:14px;",
    "  background:linear-gradient(var(--panel),var(--panel)) padding-box,var(--grad) border-box;",
    "  padding:26px;text-align:center}",
    "#shl-gate svg{width:40px;height:40px;margin:0 auto 14px;display:block}",
    "#shl-gate b{display:block;font:800 18px Archivo,sans-serif;margin-bottom:4px}",
    "#shl-gate p{margin:0 0 16px;color:var(--dim);font-size:13px}",
    "#shl-gate input{width:100%;background:var(--void);color:var(--ink);text-align:center;",
    "  border:1px solid var(--line2);border-radius:9px;padding:11px 12px;",
    "  font:500 15px 'IBM Plex Mono',monospace}",
    "#shl-gate input:focus{outline:none;border-color:var(--accent)}",
    "#shl-gate input.no{border-color:#ff6b6b}",
    "#shl-gate button{width:100%;margin-top:10px;padding:12px;border:0;border-radius:9px;",
    "  cursor:pointer;font:700 14px Archivo,sans-serif;color:var(--accent-ink);",
    "  background-image:var(--grad);background-repeat:no-repeat;",
    "  background-size:calc(100% + 2px) 100%;background-position:-1px 0}",
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

    // The mark: three squares climbing up-and-right (Kyle's, drawn in the
    // editor). Inline so it never flashes; /mark.svg is the same art for
    // favicons and anything external.
    var markSvg = '<svg viewBox="0 0 24 24" aria-hidden="true">' +
      '<defs><linearGradient id="shl-g" x1="0" y1="1" x2="1" y2="0">' +
      '<stop offset="0" style="stop-color:var(--grad-a)"/><stop offset="1" style="stop-color:var(--grad-b)"/>' +
      "</linearGradient></defs>" +
      '<path fill="url(#shl-g)" d="M0 16h8v8H0ZM8 8h8v8H8Zm8-8h8v8h-8Z"/></svg>';
    // the name rides in every browser tab; pages keep their own first word
    var NM = (window.BRAND && window.BRAND.name) || "WAVES";
    var PAGE_NAMES = {
      "/": "Launchpad", "/app": "Editor", "/launch": "Launch",
      "/collections": "Collections", "/tokens": "Tokens", "/stake": "Staking",
      "/docs": "Docs", "/faq": "FAQ", "/profile": "Profile", "/fees": "Fees"
    };
    var pg = PAGE_NAMES[location.pathname]
      || (location.pathname.indexOf("/mint/") === 0 ? "Mint" : null)
      || (location.pathname.indexOf("/token/") === 0 ? "Token" : null)
      || "Launchpad";
    document.title = NM + " " + pg;

    /* Launch gate. A curtain for humans while the site is being built —
     * client-side by design, so it keeps out visitors, not attackers. The
     * hash lives in brand.js; localhost stays open for development. */
    (function () {
      var gh = window.BRAND && window.BRAND.gate;
      if (!gh || /^(localhost|127\.)/.test(location.hostname)) return;
      // the lock is on the front door only — inner pages stay open
      if (location.pathname !== "/" && location.pathname !== "/index.html") return;
      try { if (sessionStorage.getItem("shl.gate") === gh) return; } catch (e) {}
      var ov = document.createElement("div");
      ov.id = "shl-gate";
      ov.innerHTML =
        '<div class="gcard"><svg viewBox="0 0 24 24">' +
        '<defs><linearGradient id="shl-gg" x1="0" y1="1" x2="1" y2="0">' +
        '<stop offset="0" style="stop-color:var(--grad-a)"/><stop offset="1" style="stop-color:var(--grad-b)"/>' +
        '</linearGradient></defs>' +
        '<path fill="url(#shl-gg)" d="M0 16h8v8H0ZM8 8h8v8H8Zm8-8h8v8h-8Z"/></svg>' +
        "<b>" + NM + " is almost here</b>" +
        "<p>The launchpad is in closed testing. Have the password?</p>" +
        '<input id="shl-gate-in" type="password" placeholder="password" autocomplete="off">' +
        '<button id="shl-gate-go">Enter</button></div>';
      document.body.appendChild(ov);
      var inp = ov.querySelector("#shl-gate-in");
      async function tryPass() {
        var buf = new TextEncoder().encode(inp.value.trim());
        var d = await crypto.subtle.digest("SHA-256", buf);
        var hex = [].map.call(new Uint8Array(d), function (b) {
          return b.toString(16).padStart(2, "0");
        }).join("");
        if (hex === gh) {
          try { sessionStorage.setItem("shl.gate", gh); } catch (e) {}
          ov.remove();
        } else {
          inp.classList.add("no");
          setTimeout(function () { inp.classList.remove("no"); }, 900);
        }
      }
      ov.querySelector("#shl-gate-go").addEventListener("click", tryPass);
      inp.addEventListener("keydown", function (e) { if (e.key === "Enter") tryPass(); });
      inp.focus();
    })();
    // favicon rides along on every page the shell mounts on
    if (!document.querySelector('link[rel="icon"]')) {
      var fav = document.createElement("link");
      fav.rel = "icon"; fav.type = "image/svg+xml"; fav.href = "/mark.svg";
      document.head.appendChild(fav);
    }

    render(host, H`
      <div class="zone">
        <a class="shl-mark" href="/" aria-label="Home">${raw(markSvg)}<b>${
          (window.BRAND && window.BRAND.name) || "WAVES"}</b></a>
        ${opts.search === false ? "" : raw(
          '<button class="shl-ico" id="shl-searchbtn" aria-label="Search" title="Search">' +
          '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="11" r="7"/>' +
          '<path d="m20 20-3.6-3.6"/></svg></button>' +
          '<div class="shl-search" id="shl-searchwrap">' +
          '<input id="shl-q" type="search" placeholder="Search" autocomplete="off"></div>')}
      </div>
      <nav class="shl-nav" aria-label="Main">
        ${raw(NAV.map(function (n) {
          if (n.menu) {
            return '<div class="shl-dd" id="shl-dd-' + n.id + '">' +
              '<button aria-haspopup="true" aria-expanded="false">' +
              window.UI.esc(n.label) + " <i>▾</i></button><div class=\"menu\">" +
              n.menu.map(function (m) {
                return m.href
                  ? '<a href="' + m.href + '">' + window.UI.esc(m.label) + "</a>"
                  : '<a href="/app?launch=' + m.mode + '" data-mode="' + m.mode + '">' +
                    window.UI.esc(m.label) + "</a>";
              }).join("") + "</div></div>";
          }
          return '<a href="' + n.href + '"' +
            (n.id === opts.active ? ' class="on" aria-current="page"' : "") + ">" +
            window.UI.esc(n.label) + "</a>";
        }).join(""))}
      </nav>
      <div class="zone r">
        <div class="shl-dd r" id="shl-nmenu">
          <button class="shl-net" aria-haspopup="true" aria-expanded="false">
            <img src="${CHAINS[currentChain()].icon}" width="15" height="15" alt="">
            <span>${currentChain() === "robinhood" ? "Robinhood" : "Solana"}</span> <i>▾</i>
          </button>
          <div class="menu">
            <a href="#" data-net="solana"><img src="/art/solana.svg" width="13" height="13" alt="">
              Solana</a>
            <a href="#" data-net="robinhood"><img src="/art/robinhood.svg" width="13" height="13" alt="">
              Robinhood Chain <span class="soon">SOON</span></a>
          </div>
        </div>
        <div class="shl-dd r" id="shl-wmenu">
          <button class="shl-wallet" id="shl-wallet"><span>Connect wallet</span></button>
          <div class="menu">
            <a href="/profile" id="shl-profile">Profile</a>
            <a href="#" id="shl-disconnect">Disconnect</a>
          </div>
        </div>
      </div>
    `);

    /* ---- nav dropdowns (Launch, Explore) ---- */
    document.querySelectorAll(".shl-nav .shl-dd").forEach(function (dd) {
      var trig = dd.querySelector("button");
      function setOpen(v) {
        dd.classList.toggle("open", v);
        trig.setAttribute("aria-expanded", String(v));
      }
      trig.addEventListener("click", function (e) {
        e.stopPropagation();
        // one menu at a time — the trigger's stopPropagation means the
        // document click that would close a sibling never fires
        document.querySelectorAll(".shl-nav .shl-dd.open").forEach(function (o) {
          if (o !== dd) {
            o.classList.remove("open");
            o.querySelector("button").setAttribute("aria-expanded", "false");
          }
        });
        setOpen(!dd.classList.contains("open"));
      });
      document.addEventListener("click", function () { setOpen(false); });
      document.addEventListener("keydown", function (e) {
        if (e.key === "Escape") setOpen(false);
      });
      dd.querySelectorAll(".menu a").forEach(function (a) {
        a.addEventListener("click", function (e) {
          var mode = a.dataset.mode;
          setOpen(false);
          if (!mode) return;                      // plain link (Explore items)
          // Only the EDITOR opens launches in place — anywhere else, the
          // panel being loaded (e.g. a token window opened earlier) must not
          // hijack Collection/Pair into a popup over the wrong page.
          if (location.pathname === "/app" &&
              window.LaunchPanel && window.LaunchPanel.openMode) {
            e.preventDefault();
            window.LaunchPanel.openMode(mode);
            return;
          }
          // Collection and pair go to the fork page, where the art source is
          // chosen — the editor is a choice, never a default.
          if (mode === "collection" || mode === "pair") {
            e.preventDefault();
            location.href = "/launch?mode=" + mode;
            return;
          }
          // Token opens right here. A token launch involves no art and no
          // editor, so navigating to the editor page to show a modal over it
          // put the wrong product in the background. The launch stack loads
          // on demand and the window opens over the current page.
          e.preventDefault();
          ensureLaunchStack().then(function () {
            window.LaunchPanel.openMode("token");
          });
        });
      });
    });

    /* ---- network selector ---- */
    (function () {
      var nd = document.getElementById("shl-nmenu");
      if (!nd) return;
      var trig = nd.querySelector("button");
      trig.addEventListener("click", function (e) {
        e.stopPropagation();
        document.querySelectorAll(".shl-dd.open").forEach(function (o) {
          if (o !== nd) o.classList.remove("open");
        });
        nd.classList.toggle("open");
      });
      document.addEventListener("click", function () { nd.classList.remove("open"); });
      nd.querySelectorAll(".menu a").forEach(function (a) {
        a.addEventListener("click", function (e) {
          e.preventDefault();
          nd.classList.remove("open");
          applyChain(a.dataset.net);
          if (a.dataset.net === "robinhood") {
            alertBar("Robinhood Chain is being wired in — the EVM side is coming to WAVES. " +
              "Launches still run on Solana for now.");
          }
        });
      });
      function alertBar(text) {
        var el = document.createElement("div");
        el.style.cssText = "position:fixed;left:50%;bottom:26px;transform:translateX(-50%);" +
          "z-index:200;background:var(--panel);border:1px solid var(--line2);" +
          "border-radius:10px;padding:12px 18px;font:500 13px Inter,sans-serif;" +
          "color:var(--ink);max-width:min(480px,90vw);box-shadow:0 18px 50px -20px rgba(0,0,0,.9)";
        el.textContent = text;
        document.body.appendChild(el);
        setTimeout(function () { el.remove(); }, 4200);
      }
    })();

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

    /* ---- wallet ----
     * Disconnected: the button opens the connect popup. Connected: it opens a
     * menu — Profile and Disconnect. The old behaviour, disconnecting on the
     * spot with no warning, read as the button being broken. */
    var btn = document.getElementById("shl-wallet");
    var wmenu = document.getElementById("shl-wmenu");
    function setWOpen(v) { wmenu.classList.toggle("open", v); }
    function paint() {
      var w = window.Wallet && window.Wallet.current();
      if (w) {
        btn.className = "shl-wallet linked";
        btn.innerHTML = "<span>" + window.UI.esc(shortAddr(w.publicKey)) + " ▾</span>";
        btn.title = w.name;
      } else {
        btn.className = "shl-wallet";
        btn.innerHTML = "<span>Connect wallet</span>";
        btn.title = "";
        setWOpen(false);
      }
    }
    btn.addEventListener("click", function (e) {
      if (!window.Wallet) return;
      e.stopPropagation();
      if (window.Wallet.current()) {
        setWOpen(!wmenu.classList.contains("open"));
        return;
      }
      connectModal().then(paint);
    });
    document.addEventListener("click", function () { setWOpen(false); });
    document.getElementById("shl-disconnect").addEventListener("click", function (e) {
      e.preventDefault();
      window.Wallet.disconnect().then(paint);
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

  /* Load the launch machinery on pages that did not ship it. Sequential,
   * because launchpanel.js reads the globals the earlier files define. ui.js
   * and wallet.js are already on every shell page. */
  var stackP = null;
  function ensureLaunchStack() {
    if (window.LaunchPanel) return Promise.resolve();
    if (stackP) return stackP;
    stackP = ["/dbc-terms.js", "/storage.js", "/launch.js", "/token.js", "/launchpanel.js"]
      .reduce(function (p, src) {
        return p.then(function () {
          return new Promise(function (res, rej) {
            var el = document.createElement("script");
            el.src = src;
            el.onload = res;
            el.onerror = function () { rej(new Error("failed to load " + src)); };
            document.head.appendChild(el);
          });
        });
      }, Promise.resolve());
    return stackP;
  }

  window.Shell = { mount: mount, connect: connectModal, ensureLaunchStack: ensureLaunchStack };
})();
