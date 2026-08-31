(function () {
  "use strict";
  /* The launch modal: three modes over shared machinery.
   *
   *   NFT     collection -> candy machine -> mint page   (launch.js)
   *   Token   metadata -> DBC pool                       (token.js)
   *   Pair    both, sequentially, linked in the records
   *
   * app.js talks to this through exactly two calls — setRun() after a generate,
   * open() from the Launch button — and both are guarded on window.LaunchPanel
   * existing, so the editor still runs standalone if this file never loads.
   *
   * The panel owns no chain logic beyond collecting payments, which have to
   * happen here because they need the user's wallet mid-flow. Everything else
   * is storage.js / launch.js / token.js, all of it proven headless first.
   */

  var H = window.UI.html, raw = window.UI.raw, esc = window.UI.esc,
      shortAddr = window.UI.shortAddr;

  var run = null;        // { files, count } from the generator
  var el = null;
  var busy = false;

  /* ---------- chrome ---------- */

  function css() {
    if (document.getElementById("lp-css")) return;
    var s = document.createElement("style");
    s.id = "lp-css";
    s.textContent = [
      ".lp-back{position:fixed;inset:0;z-index:9000;background:rgba(4,3,8,.72);",
      "  backdrop-filter:blur(6px);display:grid;place-items:center;padding:24px}",
      ".lp{width:min(600px,100%);max-height:88vh;overflow:auto;background:var(--panel);",
      "  border:1px solid var(--line2);border-radius:14px;padding:24px 24px 20px}",
      ".lp h2{margin:0 0 4px;font-size:17px;letter-spacing:-.01em}",
      ".lp .sub{margin:0 0 20px;color:var(--dim);font-size:13px}",
      ".lp label{display:block;font-size:11px;letter-spacing:.14em;text-transform:uppercase;",
      "  color:var(--faint);margin:14px 0 5px}",
      ".lp input,.lp textarea{width:100%;background:var(--void);color:var(--ink);",
      "  border:1px solid var(--line);border-radius:6px;padding:9px 10px;font:inherit;font-size:13px}",
      ".lp input:focus,.lp textarea:focus{outline:none;border-color:var(--accent);",
      "  box-shadow:0 0 0 3px var(--accent-glow)}",
      ".lp .two{display:grid;grid-template-columns:1fr 1fr;gap:12px}",
      ".lp .row{display:flex;justify-content:space-between;gap:12px;font-size:13px;",
      "  padding:7px 0;border-bottom:1px solid var(--line)}",
      ".lp .row b{font-weight:600;text-align:right}",
      ".lp .k{color:var(--dim)}",
      ".lp .acts{display:flex;gap:10px;margin-top:22px}",
      ".lp button{flex:1;font:inherit;font-weight:600;font-size:13px;cursor:pointer;",
      "  border-radius:6px;padding:12px 16px;border:1px solid var(--line2);",
      "  background:var(--panel2);color:var(--ink)}",
      ".lp button.go{color:var(--accent-ink);border-color:transparent;",
      "  background-image:var(--grad);background-repeat:no-repeat;",
      "  background-size:calc(100% + 2px) 100%;background-position:-1px 0}",
      ".lp button:disabled{opacity:.4;cursor:default}",
      ".lp .steps{margin:6px 0 0;padding:0;list-style:none;font-size:13px}",
      ".lp .steps li{padding:9px 0;border-bottom:1px solid var(--line);color:var(--faint);",
      "  display:flex;gap:10px;align-items:baseline}",
      ".lp .steps li.on{color:var(--ink)}",
      ".lp .steps li.done{color:var(--accent)}",
      ".lp .steps i{font-style:normal;width:16px;flex:none}",
      ".lp .err{margin-top:14px;padding:11px 12px;border-radius:6px;font-size:12.5px;",
      "  background:rgba(255,107,107,.1);border:1px solid rgba(255,107,107,.35);color:#ffb3b3}",
      ".lp .note{color:var(--faint);font-size:11.5px;margin-top:8px;line-height:1.5}",
      /* the perforated drop box for bring-your-own-files */
      ".lp .drop{border:2px dashed var(--line2);border-radius:8px;background:var(--bg);",
      "  padding:34px 20px;text-align:center;cursor:pointer;",
      "  transition:border-color .15s,background .15s}",
      ".lp .drop:hover,.lp .drop.hot{border-color:var(--accent);",
      "  background:rgba(var(--accent-rgb),.05)}",
      ".lp .drop b{display:block;font-size:13.5px;margin-bottom:4px}",
      ".lp .drop span{color:var(--faint);font-size:12px}",
      ".lp a{color:var(--accent)}",
      /* mode cards */
      ".lp .modes{display:grid;gap:10px;margin-top:4px}",
      ".lp .mode{display:flex;gap:14px;align-items:center;text-align:left;padding:15px 16px}",
      ".lp .mode:hover:not(:disabled){border-color:var(--faint)}",
      ".lp .mode .mi{width:38px;height:38px;border-radius:10px;flex:none;display:grid;",
      "  place-items:center;background:var(--raise);font-size:17px}",
      ".lp .mode b{display:block;font-size:14px}",
      ".lp .mode span{display:block;color:var(--dim);font-size:12px;margin-top:2px}",
      ".lp .mode .why{color:var(--warn);font-size:11px;display:block;margin-top:3px}",
      /* reward picker */
      ".lp .ptabs{display:flex;gap:6px;margin:10px 0}",
      ".lp .ptabs button{flex:none;padding:7px 12px;font-size:12px;border-radius:99px}",
      ".lp .ptabs button.on{background:rgba(var(--accent-rgb),.14);border-color:transparent;",
      "  box-shadow:inset 0 0 0 1px rgba(var(--accent-rgb),.3)}",
      ".lp .plist{max-height:300px;overflow:auto;border:1px solid var(--line);border-radius:8px}",
      ".lp .prow{display:flex;gap:10px;align-items:baseline;width:100%;text-align:left;",
      "  padding:9px 12px;border:0;border-bottom:1px solid var(--line);border-radius:0;",
      "  background:transparent}",
      ".lp .prow:hover{background:var(--panel2)}",
      ".lp .prow b{flex:none;min-width:74px;font-size:13px}",
      ".lp .prow span{flex:1;color:var(--dim);font-size:12px;white-space:nowrap;",
      "  overflow:hidden;text-overflow:ellipsis}",
      ".lp .prow i{font-style:normal;color:var(--faint);font-size:11px;",
      "  font-family:ui-monospace,monospace}",
      ".lp .pick{display:flex;justify-content:space-between;align-items:center;gap:10px;",
      "  width:100%;text-align:left;padding:11px 12px}",
      ".lp .pick .k2{color:var(--faint);font-size:11px}",
      ".lp .pick .pk-r{display:flex;align-items:center;gap:12px}",
      ".lp .pick .pk-dd{font:600 11px Inter,sans-serif;color:var(--accent);",
      "  border:1px solid rgba(var(--accent-rgb),.35);border-radius:99px;padding:4px 11px;",
      "  white-space:nowrap}",
      ".lp .pick:hover{border-color:var(--accent)}",
      ".lp .sharebox{padding:6px 0 2px}",
      ".lp .sharebox input[type=range]{-webkit-appearance:none;appearance:none;",
      "  width:100%;height:6px;border-radius:99px;background:var(--raise);",
      "  outline:none;margin:8px 0 4px;display:block}",
      ".lp .sharebox input[type=range]::-webkit-slider-thumb{-webkit-appearance:none;",
      "  width:18px;height:18px;border-radius:50%;background:#fff;cursor:pointer;",
      "  border:2px solid var(--accent);box-shadow:0 1px 6px rgba(0,0,0,.5)}",
      ".lp .sharebox input[type=range]::-moz-range-thumb{width:18px;height:18px;",
      "  border-radius:50%;background:#fff;cursor:pointer;border:2px solid var(--accent)}",
      ".lp .shareticks{display:flex;justify-content:space-between;margin-top:2px;",
      "  font:500 10.5px 'IBM Plex Mono',monospace;color:var(--faint)}",
      ".lp .shareticks span{width:28px;text-align:center}",
      ".lp .shareticks span:first-child{text-align:left}",
      ".lp .shareticks span:last-child{text-align:right}",
      ".lp .sharelbl{font-size:12px;color:var(--dim);margin-top:8px}",
      ".lp .artbtn{width:100%;padding:12px;border:1px dashed var(--line2);",
      "  border-radius:8px;background:var(--void);color:var(--dim);cursor:pointer;",
      "  font:600 12.5px Inter,sans-serif;overflow:hidden;text-overflow:ellipsis;",
      "  white-space:nowrap;transition:border-color .15s,color .15s}",
      ".lp .artbtn:hover{border-color:var(--accent);color:var(--ink)}",
      ".lp .artbtn.has{border-style:solid;border-color:rgba(var(--accent-rgb),.4);color:var(--accent)}",
      ".lp .tiers{display:grid;grid-template-columns:1fr 1fr;gap:10px}",
      ".lp .tier{text-align:left;padding:12px 14px;border-radius:8px;",
      "  border:1px solid var(--line);background:var(--panel2);cursor:pointer}",
      ".lp .tier b{display:block;font:700 13px Archivo,sans-serif;margin-bottom:3px}",
      ".lp .tier span{display:block;font-size:11.5px;color:var(--faint);line-height:1.45}",
      ".lp .tier.on{border-color:var(--accent)}",
      ".lp .tier.on b{color:var(--accent)}",
      ".lp .tier:disabled{opacity:.45;cursor:default}",
      /* long form */
      ".lp .four{display:grid;grid-template-columns:1fr 1fr 1fr 1fr;gap:10px}",
      ".lp .tick{display:flex;gap:10px;align-items:flex-start;margin:16px 0 4px;cursor:pointer}",
      ".lp .tick input{width:16px;height:16px;margin-top:2px;flex:none;accent-color:var(--accent)}",
      ".lp .tick b{font-size:13px;display:block}",
      ".lp .tick span{display:block;color:var(--dim);font-size:12px;margin-top:1px}",
      ".lp .fold2{border:1px solid var(--line);border-radius:8px;padding:12px 14px;margin-top:8px}",
      ".lp .srow{display:grid;grid-template-columns:1fr 84px 30px;gap:8px;margin-top:6px}",
      ".lp .srow button{flex:none;padding:6px}",
      ".lp .filebtn{display:flex;gap:8px;align-items:center}",
      ".lp .filebtn button{flex:none;padding:8px 12px;font-size:12px}",
      ".lp .filebtn span{color:var(--faint);font-size:11.5px;overflow:hidden;",
      "  text-overflow:ellipsis;white-space:nowrap}",
      ".lp textarea.walls{font-family:ui-monospace,monospace;font-size:11.5px;min-height:74px}",
      /* copyable contract-address rows on the Live window */
      ".lp .ca{display:flex;align-items:center;gap:10px;padding:9px 11px;margin-top:8px;",
      "  border:1px solid var(--line);border-radius:8px;background:var(--void)}",
      ".lp .ca .lb{flex:none;font-size:11px;letter-spacing:.12em;text-transform:uppercase;",
      "  color:var(--faint);min-width:96px}",
      ".lp .ca code{flex:1;font:500 12px ui-monospace,monospace;color:var(--ink);",
      "  overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
      ".lp .ca button{flex:none;padding:6px 12px;font-size:11.5px}",
      ".lp .ca button.did{color:var(--accent);border-color:var(--accent)}"
    ].join("\n");
    document.head.appendChild(s);
  }

  function close() {
    if (busy) return;                       // never vanish mid-deploy
    if (el) { el.remove(); el = null; }
  }

  function shell(node) {
    css();
    if (!el) {
      el = document.createElement("div");
      el.className = "lp-back";
      el.addEventListener("click", function (e) { if (e.target === el) close(); });
      document.body.appendChild(el);
    }
    el.innerHTML = '<div class="lp">' + (node.s || node) + "</div>";
    return el.querySelector(".lp");
  }

  /* A contract address the way people actually use one: the full string,
   * one tap to copy, per-row. Shortened text is for recognising an address —
   * launching is the moment you need the whole thing. */
  function caRow(label, value) {
    return '<div class="ca"><span class="lb">' + esc(label) + '</span>' +
      "<code>" + esc(value) + "</code>" +
      '<button type="button" data-copy="' + esc(value) + '">Copy</button></div>';
  }
  function bindCopy(box) {
    box.querySelectorAll("[data-copy]").forEach(function (b) {
      b.addEventListener("click", function () {
        navigator.clipboard.writeText(b.dataset.copy).then(function () {
          b.classList.add("did"); b.textContent = "Copied";
          setTimeout(function () { b.classList.remove("did"); b.textContent = "Copy"; }, 1600);
        });
      });
    });
  }

  function fail(box, msg) {
    var e = box.querySelector("#lp-err");
    if (e) e.innerHTML = '<div class="err">' + esc(msg) + "</div>";
  }

  /* ---------- mode select ---------- */

  function modeSelect() {
    var hasRun = !!(run && run.files);
    var tokenReady = !!(window.Token && window.Token.configKey());
    var box = shell(H`
      <h2>Launch</h2>
      <p class="sub">What goes on chain today?</p>
      <div class="modes">
        <button class="mode" id="m-nft" ${hasRun ? "" : raw("disabled")}>
          <span class="mi">🖼</span>
          <span><b>NFT collection</b>
          <span>${hasRun ? run.count + " generated pieces, a candy machine, a mint page — pair a token inside." :
                           "Draw and generate a collection first."}</span></span>
        </button>
        <button class="mode" id="m-token" ${tokenReady ? "" : raw("disabled")}>
          <span class="mi">◎</span>
          <span><b>Token</b>
          <span>A bonding-curve token. Trades on Jupiter immediately, graduates to a real pool.</span>
          ${tokenReady ? "" : raw('<span class="why">Token launches are not configured on this deployment yet.</span>')}</span>
        </button>
      </div>
      <div class="acts"><button id="lp-x">Cancel</button></div>
    `);
    box.querySelector("#lp-x").onclick = close;
    if (hasRun) box.querySelector("#m-nft").onclick = function () { nftDetails(null); };
    if (tokenReady) box.querySelector("#m-token").onclick = function () { tokenDetails(null); };
  }

  /* ================= NFT flow ================= */

  /* The Moonpad launch window, ported: one long form. Sections in its order —
   * identity, art, pricing, creator supply with splits, royalties, links —
   * then toggles for the allowlist ladder and the paired token. Staking shows
   * but stays disabled until the rewards program exists; a control that lies
   * is worse than one that says "not yet". */
  function nftDetails(flow) {
    flow = flow || {};
    var P = window.__project || {};
    var supply = run ? run.count : (P.supply || 0);
    var d = flow.d = flow.d || {
      name: P.name || "Untitled collection", symbol: "", desc: "",
      price: 0, maxPer: 0, dev: 0, roy: 5, royTo: "",
      site: "", x: "", tg: "", dc: "",
      openAt: "", splits: [], allowOn: false, phases: [""], wave: 30,
      pairOn: false, tname: "", tsym: "", avatar: null, avatarName: "", banner: null, bannerName: ""
    };

    var box = shell(H`
      <h2>Launch collection</h2>
      <p class="sub">${supply} pieces, generated and ready. Nothing is on chain until you confirm.</p>

      <div class="two">
        <div><label>Name</label><input id="f-name" value="${d.name}" maxlength="28"></div>
        <div><label>Symbol</label><input id="f-sym" value="${d.symbol}" maxlength="8"
          placeholder="OPTIONAL" style="text-transform:uppercase"></div>
      </div>
      <label>Description</label>
      <textarea id="f-desc" rows="2" placeholder="Shown on marketplaces">${d.desc}</textarea>

      <div class="two">
        <div><label>Collection avatar</label>
          <div class="filebtn"><button id="f-pfpbtn" type="button">Choose…</button>
          <span id="f-pfpname">${d.avatarName || "1:1 png — defaults to token #1"}</span></div></div>
        <div><label>Banner</label>
          <div class="filebtn"><button id="f-banbtn" type="button">Choose…</button>
          <span id="f-banname">${d.bannerName || "wide png — optional"}</span></div></div>
      </div>
      <input type="file" id="f-pfp" accept="image/png" hidden>
      <input type="file" id="f-ban" accept="image/png" hidden>

      <div class="four">
        <div><label>Mint price ◎</label><input id="f-price" type="number" min="0" step="0.01" value="${d.price}"></div>
        <div><label>Max / wallet</label><input id="f-max" type="number" min="0" step="1" value="${d.maxPer}" placeholder="0 = ∞"></div>
        <div><label>Creator supply</label><input id="f-dev" type="number" min="0" step="1" value="${d.dev}"></div>
        <div><label>Royalty %</label><input id="f-roy" type="number" min="0" max="50" step="0.5" value="${d.roy}"></div>
      </div>
      <p class="note">Creator supply is minted to you before the sale opens, taking ids
      from the machine first — free, before price and limits exist.</p>
      <p class="note"><b>Fees:</b> mint revenue is 100% yours — we take no cut.
      Storage is the only launch cost. A paired token's trading fees split
      20% you / 60% platform / 20% Meteora on the standard tier.</p>

      <label>Royalty wallet</label>
      <input id="f-royto" value="${d.royTo}" placeholder="optional — defaults to deployer wallet">

      <label class="tick"><input type="checkbox" id="f-splitOn" ${d.splits.length ? raw("checked") : ""}>
        <span><b>Split the creator supply</b>
        <span>Mint parts of it straight to teammates' wallets.</span></span></label>
      <div class="fold2" id="f-splitbox" ${d.splits.length ? "" : raw("hidden")}>
        <div id="f-splitrows"></div>
        <div class="acts" style="margin-top:10px"><button id="f-splitadd" type="button">+ Teammate</button></div>
      </div>

      <div class="four">
        <div><label>Website</label><input id="f-site" value="${d.site}" placeholder="site.xyz"></div>
        <div><label>X</label><input id="f-x" value="${d.x}" placeholder="@handle"></div>
        <div><label>Telegram</label><input id="f-tg" value="${d.tg}" placeholder="t.me/…"></div>
        <div><label>Discord</label><input id="f-dc" value="${d.dc}" placeholder="discord.gg/…"></div>
      </div>

      <label>Sale opens</label>
      <input id="f-open" type="datetime-local" value="${d.openAt}">
      <p class="note">Empty means the moment you launch. Allowlist waves count from here.</p>

      <label class="tick"><input type="checkbox" id="f-allowOn" ${d.allowOn ? raw("checked") : ""}>
        <span><b>Allowlist first</b>
        <span>Listed wallets mint in waves before the public. The list is pinned with the
        collection, so it cannot be quietly edited afterwards.</span></span></label>
      <div class="fold2" id="f-allowbox" ${d.allowOn ? "" : raw("hidden")}>
        <div id="f-phases"></div>
        <div class="acts" style="margin-top:10px">
          <button id="f-phaseadd" type="button">+ Wave</button>
          <div style="flex:1;display:flex;gap:8px;align-items:center">
            <label style="margin:0;flex:none">Wave lasts</label>
            <input id="f-wave" type="number" min="1" value="${d.wave}" style="width:70px"> min
          </div>
        </div>
      </div>

      <label class="tick"><input type="checkbox" id="f-pairOn" ${d.pairOn && !isEvm() ? raw("checked") : ""}
        ${!isEvm() && window.Token && window.Token.configKey() ? "" : raw("disabled")}>
        <span><b>Pair a token</b>
        <span>${isEvm()
          ? "Solana only for now — a paired token needs the bonding-curve launchpad, which we are still building for Robinhood Chain."
          : (window.Token && window.Token.configKey()
            ? "Launch a bonding-curve token alongside the collection — its trading fees can reward your holders."
            : "Not configured on this deployment yet.")}</span></span></label>
      <div class="fold2" id="f-pairbox" ${d.pairOn && !isEvm() ? "" : raw("hidden")}>
        <div class="two">
          <div><label>Token name</label>
          <input id="f-tname" placeholder="${d.name || "Same as the collection"}" value="${d.tname}"></div>
          <div><label>Ticker</label>
          <input id="f-tsym" placeholder="WAVE" maxlength="10" value="${d.tsym}"></div>
        </div>
        <p class="note">Start it here if you like. <b>Continue opens the full
        token setup</b> — what it is priced in (SOL, USDC or a tokenised stock),
        your first buy, the swap fee and how much of it goes to holders, the
        reward asset, your fee wallet and links — and you confirm the whole
        launch, both halves, before anything is signed.</p>
      </div>

      <label class="tick"><input type="checkbox" disabled>
        <span><b>Enable staking</b>
        <span>Burn-to-stake is not live yet: the staking program is written and
        tested but stays off mainnet until it has been audited, and we will not
        take a deposit against code nobody has reviewed. Pick the reward asset
        in the token step meanwhile.</span></span></label>

      <div id="lp-err"></div>
      <div class="acts"><button id="lp-x">Cancel</button>
      <button class="go" id="lp-next">Continue</button></div>
    `);

    /* files */
    function bindFile(btn, input, nameEl, keyBytes, keyName) {
      box.querySelector(btn).onclick = function () { box.querySelector(input).click(); };
      box.querySelector(input).addEventListener("change", function (e) {
        var f = e.target.files && e.target.files[0];
        if (!f) return;
        f.arrayBuffer().then(function (buf) {
          d[keyBytes] = new Uint8Array(buf);
          d[keyName] = f.name;
          box.querySelector(nameEl).textContent = f.name;
        });
      });
    }
    bindFile("#f-pfpbtn", "#f-pfp", "#f-pfpname", "avatar", "avatarName");
    bindFile("#f-banbtn", "#f-ban", "#f-banname", "banner", "bannerName");

    /* splits */
    function drawSplits() {
      var rows = box.querySelector("#f-splitrows");
      rows.innerHTML = d.splits.map(function (r, i) {
        return '<div class="srow">' +
          '<input data-i="' + i + '" data-f="to" value="' + esc(r.to) + '" placeholder="teammate address">' +
          '<input data-i="' + i + '" data-f="count" type="number" min="1" value="' + esc(r.count) + '">' +
          '<button type="button" data-del="' + i + '">×</button></div>';
      }).join("") || '<p class="note">Whatever is not assigned here mints to you.</p>';
      rows.querySelectorAll("input").forEach(function (inp) {
        inp.addEventListener("input", function () {
          d.splits[+inp.dataset.i][inp.dataset.f] =
            inp.dataset.f === "count" ? (parseInt(inp.value, 10) || 0) : inp.value.trim();
        });
      });
      rows.querySelectorAll("[data-del]").forEach(function (b) {
        b.onclick = function () { d.splits.splice(+b.dataset.del, 1); drawSplits(); };
      });
    }
    box.querySelector("#f-splitOn").addEventListener("change", function (e) {
      box.querySelector("#f-splitbox").hidden = !e.target.checked;
      if (e.target.checked && !d.splits.length) { d.splits.push({ to: "", count: 1 }); }
      drawSplits();
    });
    box.querySelector("#f-splitadd").onclick = function () {
      d.splits.push({ to: "", count: 1 }); drawSplits();
    };
    drawSplits();

    /* allowlist waves */
    function drawPhases() {
      var ph = box.querySelector("#f-phases");
      ph.innerHTML = d.phases.map(function (txt, i) {
        return '<label style="margin-top:' + (i ? 10 : 0) + 'px">Wave ' + (i + 1) +
          " — one wallet per line" + (d.phases.length > 1 ?
          ' <button type="button" data-pdel="' + i + '" style="float:right;padding:2px 8px">×</button>' : "") +
          '</label><textarea class="walls" data-p="' + i + '">' + esc(txt) + "</textarea>";
      }).join("");
      ph.querySelectorAll("textarea").forEach(function (t) {
        t.addEventListener("input", function () { d.phases[+t.dataset.p] = t.value; });
      });
      ph.querySelectorAll("[data-pdel]").forEach(function (b) {
        b.onclick = function () { d.phases.splice(+b.dataset.pdel, 1); drawPhases(); };
      });
    }
    box.querySelector("#f-pairOn").addEventListener("change", function (e) {
      d.pairOn = e.target.checked;
      box.querySelector("#f-pairbox").hidden = !d.pairOn;
    });
    box.querySelector("#f-allowOn").addEventListener("change", function (e) {
      d.allowOn = e.target.checked;
      box.querySelector("#f-allowbox").hidden = !d.allowOn;
    });
    box.querySelector("#f-phaseadd").onclick = function () {
      if (d.phases.length >= 8) return;         // labels w1..w8 + pub, 6-char cap
      d.phases.push(""); drawPhases();
    };
    drawPhases();

    box.querySelector("#lp-x").onclick = close;
    box.querySelector("#lp-next").onclick = function () {
      // collect
      d.name = box.querySelector("#f-name").value.trim();
      d.symbol = box.querySelector("#f-sym").value.trim().toUpperCase();
      d.desc = box.querySelector("#f-desc").value.trim();
      d.price = parseFloat(box.querySelector("#f-price").value) || 0;
      d.maxPer = parseInt(box.querySelector("#f-max").value, 10) || 0;
      d.dev = parseInt(box.querySelector("#f-dev").value, 10) || 0;
      d.roy = parseFloat(box.querySelector("#f-roy").value) || 0;
      d.royTo = box.querySelector("#f-royto").value.trim();
      d.site = box.querySelector("#f-site").value.trim();
      d.x = box.querySelector("#f-x").value.trim();
      d.tg = box.querySelector("#f-tg").value.trim();
      d.dc = box.querySelector("#f-dc").value.trim();
      d.openAt = box.querySelector("#f-open").value;
      d.wave = parseInt(box.querySelector("#f-wave").value, 10) || 30;
      d.allowOn = box.querySelector("#f-allowOn").checked;
      d.pairOn = box.querySelector("#f-pairOn").checked && !isEvm();
      d.tname = (box.querySelector("#f-tname") || {}).value || "";
      d.tsym = (box.querySelector("#f-tsym") || {}).value || "";
      if (!box.querySelector("#f-splitOn").checked) d.splits = [];

      // validate
      var B58 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
      if (!d.name) return fail(box, "The collection needs a name.");
      if (d.royTo && !B58.test(d.royTo)) return fail(box, "The royalty wallet is not a valid address.");
      if (d.dev > supply) return fail(box, "Creator supply exceeds the collection.");
      var assigned = 0;
      for (var i = 0; i < d.splits.length; i++) {
        var r = d.splits[i];
        if (!B58.test(r.to)) return fail(box, "Split row " + (i + 1) + " is not a valid address.");
        if (!(r.count > 0)) return fail(box, "Split row " + (i + 1) + " needs a count.");
        assigned += r.count;
      }
      if (assigned > d.dev) return fail(box, "Splits assign " + assigned +
        " but creator supply is " + d.dev + ".");
      var phases = [];
      if (d.allowOn) {
        for (var pi = 0; pi < d.phases.length; pi++) {
          var wallets = d.phases[pi].split(/[\s,]+/).map(function (w) { return w.trim(); })
            .filter(Boolean);
          if (!wallets.length) return fail(box, "Wave " + (pi + 1) + " has no wallets — remove it or fill it.");
          for (var wi = 0; wi < wallets.length; wi++) {
            if (!B58.test(wallets[wi])) return fail(box,
              "Wave " + (pi + 1) + ", line " + (wi + 1) + " is not a valid address.");
          }
          phases.push({ label: "w" + (pi + 1), wallets: wallets });
        }
      }

      flow.pair = d.pairOn;
      flow.preTname = d.tname;
      flow.preTsym = d.tsym;
      var cfg = {
        name: d.name, symbol: d.symbol, description: d.desc,
        priceSol: d.price, maxPerWallet: d.maxPer, royaltyPercent: d.roy,
        royaltyTo: d.royTo || null,
        supply: supply,
        devMints: d.dev > 0 ? d.splits.concat([{ to: null, count: d.dev - assigned }])
          .filter(function (r) { return r.count > 0; }) : [],
        devTotal: d.dev,
        links: { website: d.site, x: d.x, telegram: d.tg, discord: d.dc },
        avatar: d.avatar, banner: d.banner,
        openAt: d.openAt ? new Date(d.openAt).toISOString() : null,
        waves: phases.length ? { minutes: d.wave, phases: phases } : null
      };
      /* Pairing sets the token up BEFORE anything is signed. The token still
       * deploys after the collection — it pairs to a collection that has to
       * exist — but a creator should see and decide every part of what they
       * are launching first, not meet the second half after paying for the
       * first. tokenDetails returns here when it is done. */
      if (d.pairOn) {
        flow.cfg = cfg;
        flow.preconfig = true;
        return tokenDetails(flow);
      }
      nftConfirm(cfg, flow);
    };
  }

  async function nftConfirm(cfg, flow) {
    var evm = isEvm();
    var mw = evm ? (window.MoonpadWallet || {}) : null;
    var w = evm
      ? (mw.account ? { name: "EVM wallet", publicKey: mw.account } : null)
      : window.Wallet.current();
    var CUR = evm ? "ETH" : "SOL";
    var waveTxt = cfg.waves
      ? cfg.waves.phases.map(function (p) { return p.wallets.length; }).join(" + ") +
        " wallets · " + cfg.waves.minutes + " min waves"
      : "no — public from open";
    var box = shell(H`
      <h2>Confirm</h2>
      <p class="sub">Two things get paid for: permanent storage, and ${evm ? "gas" : "Solana rent plus fees"}.</p>
      <div class="row"><span class="k">Collection</span><b>${cfg.name}${cfg.symbol ? " · " + cfg.symbol : ""}</b></div>
      <div class="row"><span class="k">Supply</span><b>${cfg.supply}${cfg.devTotal ? " (" + cfg.devTotal + " to the team first)" : ""}</b></div>
      <div class="row"><span class="k">Mint price</span><b>${cfg.priceSol} ${CUR}${cfg.maxPerWallet ? " · max " + cfg.maxPerWallet + "/wallet" : ""}</b></div>
      <div class="row"><span class="k">Royalty</span><b>${cfg.royaltyPercent}%${cfg.royaltyTo ? " → " + shortAddr(cfg.royaltyTo) : ""}</b></div>
      <div class="row"><span class="k">Allowlist</span><b>${waveTxt}</b></div>
      <div class="row"><span class="k">Opens</span><b>${cfg.openAt ? new Date(cfg.openAt).toLocaleString() : "immediately"}</b></div>
      ${flow && flow.pair && flow.tname ? H`
      <div class="row"><span class="k">Then — token</span><b>${flow.tname} · $${flow.tsym}</b></div>
      <div class="row"><span class="k">Priced in</span><b>${String(flow.quote || "sol").toUpperCase()}${
        flow.tbuy ? " · first buy " + flow.tbuy : ""}</b></div>
      <div class="row"><span class="k">Fee sharing</span><b>${
        (flow.feeSharePct || 0) > 0 ? flow.feeSharePct + "% to holders" : "you keep it all"}</b></div>
      <p class="note">The collection deploys first, then the token pairs to it.
      Both are signed from here.</p>` : ""}
      <div class="row"><span class="k">Storage fee</span><b id="lp-fee">quoting…</b></div>
      <div class="row"><span class="k">Wallet</span><b>${w ? w.name + " · " + shortAddr(w.publicKey) : "not connected"}</b></div>
      <p class="note">Storage is a one-off payment to Arweave for permanent hosting,
      quoted live at the moment you launch. The allowlist is pinned alongside the art,
      so the list minting ahead of the public is on the record forever.</p>
      <div id="lp-err"></div>
      <div class="acts"><button id="lp-back">Back</button>
      <button class="go" id="lp-go" disabled>${w ? "Launch" : "Connect a wallet"}</button></div>
    `);

    box.querySelector("#lp-back").onclick = function () { nftDetails(flow); };

    try {
      var probe = estimateBytes(cfg);
      await window.Storage.quoteUpload(probe.bytes, probe.count).then(function (quote) {
        box.querySelector("#lp-fee").textContent = evm
          ? Number(quote.feeEth).toFixed(6) + " ETH"
          : Number(quote.feeSol).toFixed(4) + " SOL";
      });
    } catch (e) {
      box.querySelector("#lp-fee").textContent = "unavailable";
      fail(box, "Could not price storage: " + e.message);
      return;
    }

    var go = box.querySelector("#lp-go");
    go.disabled = false;
    go.onclick = w
      ? function () { (evm ? doEvmNftLaunch : doNftLaunch)(cfg, flow); }
      : async function () {
          var w2 = evm
            ? await window.Shell.ensureEvmStack().then(function () {
                return window.MoonpadWallet.connect();
              }).catch(function () { return null; })
            : await (window.Shell ? Shell.connect() : Promise.resolve(null));
          if (w2) nftConfirm(cfg, flow);
        };
  }

  /* Sizing probe for the pre-launch quote. storage.js sizes properly against
   * the real file set at upload time; this must not drift from it or the
   * quoted fee will not match the charged fee. */
  var CARD_BYTES = 400 * 1024;   // generous budget for the composed share card

  function estimateBytes(cfg) {
    var f = run.files;
    var bytes = 0, count = 0;
    ["images", "metaplex"].forEach(function (k) {
      (f[k] || []).forEach(function (x) {
        bytes += x.bytes ? x.bytes.byteLength || x.bytes.length : (x.text || "").length;
        count++;
      });
    });
    // avatar and banner ride in BOTH folders (see storage.js on why)
    if (cfg && cfg.avatar) { bytes += cfg.avatar.byteLength * 2; count += 2; }
    if (cfg && cfg.banner) { bytes += cfg.banner.byteLength * 2; count += 2; }
    // the share card rides in both folders too. It is composed after this
    // runs, so budget for it: 1200x630 of flat art is ~250KB, and quoting
    // short is worse than quoting a fraction of a cent high — the approval
    // is sized off this number and the upload fails if it does not fit.
    bytes += CARD_BYTES * 2; count += 2;
    return { bytes: bytes, count: count + 6 };    // +6 for _index, _collection etc.
  }

  /* What actually went wrong, in words. A launch that fails after money has
   * moved must never say "Unexpected error": the creator has paid, and the
   * only way anyone can act on it — them or us — is if the real message,
   * including whatever the SDK wrapped, comes through. */
  function describe(e) {
    if (!e) return "The launch stopped for an unknown reason.";
    var parts = [];
    var m = e.message || e.reason || (typeof e === "string" ? e : "");
    if (m) parts.push(String(m));
    if (e.cause && e.cause.message && parts.indexOf(e.cause.message) < 0) {
      parts.push(String(e.cause.message));
    }
    for (var k = 0; k < (e.errors || []).length && k < 2; k++) {
      if (e.errors[k] && e.errors[k].message) parts.push(String(e.errors[k].message));
    }
    if (!parts.length) {
      try { parts.push(JSON.stringify(e).slice(0, 300)); } catch (x) {}
    }
    if (!parts.length) parts.push(e.name || String(e));
    try { console.error("[launch] failed:", e); } catch (x) {}
    return parts.join(" — ").slice(0, 400);
  }

  function stepList(box) {
    return function mark(k, state, extra) {
      var li = box.querySelector('[data-k="' + k + '"]');
      if (!li) return;
      li.className = state;
      li.querySelector("i").textContent = state === "done" ? "✓" : "›";
      if (extra) li.querySelector("span").textContent = extra;
    };
  }

  async function doNftLaunch(cfg, flow) {
    busy = true;
    var stages = [
      ["storage", "Paying for storage"],
      ["images", "Uploading art"],
      ["metadata", "Uploading metadata"],
      ["collection", "Creating collection"],
      ["machine", "Creating candy machine"],
      ["lines", "Loading items"]
    ];
    if (cfg.devTotal > 0) stages.push(["dev", "Minting the creator supply"]);
    stages.push(["guard", "Arming the sale rules"]);
    var box = shell(H`
      <h2>Launching${flow && flow.pair ? " — collection" : ""}</h2>
      <p class="sub">Leave this tab open. Each step needs a signature.</p>
      <ul class="steps">${raw(stages.map(function (s) {
        return '<li data-k="' + s[0] + '"><i>·</i><span>' + esc(s[1]) + "</span></li>";
      }).join(""))}</ul>
      <div id="lp-err"></div>
    `);
    var mark = stepList(box);

    try {
      var card = await makeCard(cfg, "collection", [
        ["items", String(cfg.supply)],
        ["price", Number(cfg.priceSol) ? cfg.priceSol + " SOL" : "Free"],
        ["chain", "Solana"]
      ]);
      var up = await window.Storage.uploadCollection({
        files: run.files,
        name: cfg.name,
        symbol: cfg.symbol,
        description: cfg.description,
        avatar: cfg.avatar,
        banner: cfg.banner,
        card: card,
        links: cfg.links,
        allowlist: cfg.waves
          ? { waveMinutes: cfg.waves.minutes, phases: cfg.waves.phases }
          : null,
        onProgress: function (p) {
          if (p.phase === "images" && p.state === "quoting") mark("storage", "on");
          if (p.phase === "images") mark("images", p.state === "done" ? "done" : "on");
          if (p.phase === "metadata") mark("metadata", p.state === "done" ? "done" : "on");
        },
        payer: async function (q) {
          mark("storage", "on");
          var sig = await payStorage(q);
          mark("storage", "done");
          return sig;
        }
      });

      var res = await window.Launch.deploy({
        name: cfg.name,
        supply: cfg.supply,
        priceSol: cfg.priceSol,
        maxPerWallet: cfg.maxPerWallet,
        royaltyPercent: cfg.royaltyPercent,
        royaltyTo: cfg.royaltyTo,
        devMints: cfg.devMints,
        openAt: cfg.openAt,
        waves: cfg.waves,
        baseUri: up.baseUri,
        collectionUri: up.collectionUri,
        onProgress: function (p) {
          if ((p.step === "lines" || p.step === "dev") && p.state === "uploading") {
            mark(p.step, "on", (p.step === "dev" ? "Minting the creator supply — " : "Loading items — batch ") +
              p.batch + " of " + p.batches);
          } else {
            mark(p.step, p.state === "done" ? "done" : "on");
          }
        }
      });

      busy = false;

      if (flow && flow.pair) {
        flow.nft = { cfg: cfg, res: res, up: up };
        // configured and confirmed before any of this was signed
        if (flow.preconfig) { doTokenLaunch(flow); return; }
        tokenDetails(flow);
        return;
      }

      recordCollection(cfg, res, null, up);
      nftDone(cfg, res, up);
    } catch (e) {
      busy = false;
      fail(box, describe(e));
      box.insertAdjacentHTML("beforeend",
        '<div class="acts"><button id="lp-close2">Close</button></div>');
      box.querySelector("#lp-close2").onclick = close;
    }
  }

  /* ---- Robinhood Chain launch ----
   * Same shape as the Solana runner: pay for storage, upload the art and
   * metadata, then put the collection on chain. The chain step is one
   * transaction — a drop contract carrying its own supply, price, per-wallet
   * cap and royalty — instead of Solana's collection + machine + item lines,
   * so this path has fewer stages, not different ones.
   *
   * Allowlist waves are Solana-only for now: the gated path needs a signer
   * service WAVES does not run, and a launch that half-arms its allowlist is
   * worse than one that says so. nftDetails hides the wave controls on this
   * chain; the guard here is the backstop. */
  function isEvm() {
    return !!(window.Shell && window.Shell.chain && window.Shell.chain() === "robinhood");
  }

  /* The share card for a launch, composed here and pinned with the art. Never
   * fatal: a launch that succeeded must not be reported as failed because a
   * picture did not draw — a missing card simply falls back to the brand one. */
  async function makeCard(cfg, kind, stats) {
    try {
      if (!window.CardMaker) {
        await new Promise(function (res, rej) {
          var el = document.createElement("script");
          el.src = "/cardmaker.js"; el.onload = res; el.onerror = rej;
          document.head.appendChild(el);
        });
      }
      var blobUrl = function (b) {
        return b ? URL.createObjectURL(new Blob([b], { type: "image/png" })) : null;
      };
      return await window.CardMaker.make({
        kind: kind,
        chain: isEvm() ? "robinhood" : "solana",
        name: cfg.name,
        sym: cfg.symbol,
        avatar: blobUrl(cfg.avatar),
        banner: blobUrl(cfg.banner),
        stats: stats
      });
    } catch (e) { return null; }
  }

  async function doEvmNftLaunch(cfg, flow) {
    busy = true;
    var stages = [
      ["storage", "Paying for storage"],
      ["images", "Uploading art"],
      ["metadata", "Uploading metadata"],
      ["deploy", "Deploying the collection"]
    ];
    if (cfg.devTotal > 0) stages.push(["dev", "Minting the creator supply"]);
    var box = shell(H`
      <h2>Launching</h2>
      <p class="sub">Leave this tab open. Each step needs a signature.</p>
      <ul class="steps">${raw(stages.map(function (s) {
        return '<li data-k="' + s[0] + '"><i>·</i><span>' + esc(s[1]) + "</span></li>";
      }).join(""))}</ul>
      <div id="lp-err"></div>
    `);
    var mark = stepList(box);

    try {
      await window.Shell.ensureEvmLaunch();
      if (cfg.waves) throw new Error("Allowlist waves are not available on Robinhood Chain yet.");

      var card = await makeCard(cfg, "collection", [
        ["items", String(cfg.supply)],
        ["price", Number(cfg.priceSol) ? cfg.priceSol + " ETH" : "Free"],
        ["chain", "Robinhood"]
      ]);
      var up = await window.Storage.uploadCollection({
        files: run.files,
        name: cfg.name,
        symbol: cfg.symbol,
        description: cfg.description,
        avatar: cfg.avatar,
        banner: cfg.banner,
        card: card,
        links: cfg.links,
        allowlist: null,
        onProgress: function (p) {
          if (p.phase === "images" && p.state === "quoting") mark("storage", "on");
          if (p.phase === "images") mark("images", p.state === "done" ? "done" : "on");
          if (p.phase === "metadata") mark("metadata", p.state === "done" ? "done" : "on");
        },
        payer: async function (q) {
          mark("storage", "on");
          var h = await payStorageEvm(q);
          mark("storage", "done");
          return h;
        }
      });

      mark("deploy", "on");
      var priceWei = BigInt(Math.round(Number(cfg.priceSol || 0) * 1e18));
      var me = window.MoonpadWallet.account;
      var dep = await window.MoonpadLaunch.deploy({
        chainId: 4663,
        from: me,
        name: cfg.name,
        symbol: cfg.symbol || "",
        baseUri: up.baseUri,
        maxSupply: cfg.supply,
        priceWei: "0x" + priceWei.toString(16),
        maxPerWallet: cfg.maxPerWallet || 0,
        owner: me,
        royaltyBps: Math.round((cfg.royaltyPercent || 0) * 100),
        reserveQty: cfg.devTotal || 0,
        openAtDeploy: !cfg.openAt,
        gateSigner: "0x0000000000000000000000000000000000000000",
        gateSeconds: 0
      });
      var addr = await window.MoonpadLaunch.waitForContract(dep.hash, 4663);
      mark("deploy", "done");
      if (cfg.devTotal > 0) mark("dev", "done");

      busy = false;
      var res = {
        address: addr,
        chain: dep.chain,
        mintUrl: location.origin + "/mint/" + addr,
        explorer: dep.chain.explorer + "/address/" + addr
      };
      recordEvmCollection(cfg, res, up);
      evmDone(cfg, res);
    } catch (e) {
      busy = false;
      fail(box, describe(e));
      box.insertAdjacentHTML("beforeend",
        '<div class="acts"><button id="lp-close3">Close</button></div>');
      box.querySelector("#lp-close3").onclick = close;
    }
  }

  // A plain ETH transfer to the fee wallet, signed by the creator. The server
  // verifies value, recipient, age and single-use before granting the credit.
  async function payStorageEvm(q) {
    if (!q.feeTo) throw new Error("Storage fees are not configured for Robinhood Chain yet");
    var mw = window.MoonpadWallet;
    if (!mw || !mw.account) await window.MoonpadWallet.connect();
    mw = window.MoonpadWallet;
    await window.MOONPAD_SWITCH_CHAIN(4663);
    var tx = { from: mw.account, to: q.feeTo,
      value: "0x" + BigInt(q.feeWei).toString(16) };
    var hash = await mw.provider.request({ method: "eth_sendTransaction", params: [tx] });
    // the server reads the receipt, so wait for it to exist
    for (var i = 0; i < 90; i++) {
      var r = await window.MoonpadRPC.send(
        window.EvmCollections ? window.EvmCollections.chain().rpc
          : "https://rpc.mainnet.chain.robinhood.com",
        "eth_getTransactionReceipt", [hash]).catch(function () { return null; });
      if (r && r.status === "0x1") return hash;
      if (r && r.status === "0x0") throw new Error("The storage payment reverted.");
      await new Promise(function (res) { setTimeout(res, 2000); });
    }
    throw new Error("The storage payment is taking a while — check the explorer.");
  }

  function recordEvmCollection(cfg, res, up) {
    fetch("/api/collections", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chain: "robinhood",
        address: res.address,
        name: cfg.name,
        avatar: (up && up.avatarUri) || null,
        card: (up && up.cardUri) || null,
        creator: (window.MoonpadWallet || {}).account || null
      })
    }).catch(function () {});
  }

  function evmDone(cfg, res) {
    var box = shell(H`
      <h2>Live</h2>
      <p class="sub">${cfg.name} is on Robinhood Chain.</p>
      <div class="row"><span class="k">Items</span><b>${cfg.supply}</b></div>
      ${raw(caRow("Contract", res.address))}
      <label>Mint page</label>
      <input readonly value="${res.mintUrl}" onclick="this.select()">
      <p class="note"><a href="${res.explorer}" target="_blank" rel="noopener">View on the explorer ↗</a></p>
      <div class="acts"><button id="lp-done2">Close</button>
      <button class="go" id="lp-open2">Open mint page</button></div>
    `);
    bindCopy(box);
    box.querySelector("#lp-done2").onclick = close;
    box.querySelector("#lp-open2").onclick = function () { location.href = res.mintUrl; };
  }

  function recordCollection(cfg, res, tokenMint, up) {
    // Fire-and-forget: the collection is already on chain, and a launch must
    // never look failed because a listing endpoint was down.
    fetch("/api/collections", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        candyMachine: res.candyMachine, collection: res.collection,
        name: cfg.name, cluster: res.cluster, tokenMint: tokenMint || null,
        avatar: (up && up.avatarUri) || null,
        card: (up && up.cardUri) || null,
        creator: (window.Wallet.current() || {}).publicKey || null
      })
    }).catch(function () {});
  }

  function nftDone(cfg, res, up) {
    var box = shell(H`
      <h2>Live</h2>
      <p class="sub">${cfg.name} is on ${res.cluster}.</p>
      <div class="row"><span class="k">Items loaded</span><b>${cfg.supply}</b></div>
      ${raw(caRow("Collection", res.collection))}
      ${raw(caRow("Candy machine", res.candyMachine))}
      <label>Mint page</label>
      <input readonly value="${res.mintUrl}" onclick="this.select()">
      <p class="note"><a href="${res.explorer}" target="_blank" rel="noopener">View on Solana Explorer ↗</a></p>
      <div class="acts"><button id="lp-done">Close</button>
      <button class="go" id="lp-open">Open mint page</button></div>
    `);
    bindCopy(box);
    box.querySelector("#lp-done").onclick = close;
    box.querySelector("#lp-open").onclick = function () { location.href = res.mintUrl; };
  }

  // A plain SOL transfer to the fee wallet, signed by the creator. The server
  // verifies it as a balance delta before granting the upload credit.
  async function payStorage(q) {
    var mx = await import("/vendor/metaplex.esm.js");
    var w = window.Wallet.current();
    if (!q.feeTo) throw new Error("Storage fees are not configured on this deployment");

    /* One bridge, shared with launch.js: the adapter hands us a transaction
     * and expects a real one back — it reads .message.version off the result.
     * Our wallet speaks Wallet Standard, which signs BYTES and returns bytes,
     * so the round trip has to serialize in and rehydrate out. This panel had
     * its own copy that skipped the rehydrate, and a launch died on it after
     * the storage payment had been signed. */
    var umi = mx.createUmi(window.Launch.clusters[window.Launch.cluster()].rpc, "confirmed")
      .use(mx.walletAdapterIdentity(window.Launch.asAdapter(mx, w)));

    var res = await mx.transferSol(umi, {
      destination: mx.publicKey(q.feeTo),
      amount: mx.lamports(BigInt(q.feeLamports))
    }).sendAndConfirm(umi, { confirm: { commitment: "confirmed" } });

    return mx.base58.deserialize(res.signature)[0];
  }

  /* ================= Token flow ================= */

  var BUILTIN_REWARDS = [
    { symbol: "SOL", name: "Solana", mint: "So11111111111111111111111111111111111111112", kind: "native" },
    { symbol: "USDC", name: "USD Coin", mint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", kind: "native" }
  ];

  /* The token window, grown to FLAP's shape on DBC rails. What a creator
   * controls here is identity, quote currency, first buy, rewards, fee wallet
   * and links. The economics — supply, curve, fee, split — are locked in the
   * partner config so every launch gets identical terms, and they are SHOWN,
   * read from chain, rather than dressed up as choices. The tax section
   * (buy/sell rates, burn/dividend allocation) is FLAP's transfer-fee
   * machinery: ours arrives with the rewards program, and the section says so
   * instead of pretending. */
  function tokenDetails(flow) {
    flow = flow || {};
    var nft = flow.nft;
    // what they typed beside the pair tick comes through as the default here,
    // so the token step opens already carrying their answer
    var defName = flow.preTname || (nft ? nft.cfg.name : "");
    var defSym = flow.preTsym ||
      (defName ? defName.replace(/[^A-Za-z]/g, "").slice(0, 5).toUpperCase() : "");
    flow.reward = flow.reward || BUILTIN_REWARDS[0];
    flow.quote = flow.quote || "sol";
    var quotes = window.Token.quotes();
    var rwas = window.Token.rwaQuotes();
    var qLabel = flow.quote === "usdc" ? "USDC"
      : flow.quote === "sol" ? "SOL"
      : (flow.quoteSym || "RWA");

    var box = shell(H`
      <h2>${nft ? "2 of 2 — the token" : "Launch token"}</h2>
      <p class="sub">${nft
        ? "Paired with " + nft.cfg.name + ". Its trading fees can reward the collection's holders."
        : "A bonding-curve token. No liquidity to manage — the curve is the liquidity."}</p>

      <div class="two">
        <div><label>Logo · 1:1</label>
        <button class="artbtn ${flow.icon ? "has" : ""}" id="tk-logobtn" type="button">${
          flow.icon ? "✓ " + (flow.iconName || "chosen") : "Choose…"}</button></div>
        <div><label>Banner · 3:1</label>
        <button class="artbtn ${flow.banner ? "has" : ""}" id="tk-bannerbtn" type="button">${
          flow.banner ? "✓ " + (flow.bannerName || "chosen") : "Choose…"}</button></div>
      </div>
      <input type="file" id="tk-logo" accept="image/png,image/jpeg" hidden>
      <input type="file" id="tk-banner" accept="image/png,image/jpeg" hidden>

      <div class="two">
        <div><label>Name</label>
        <input id="lp-tname" value="${flow.tname || defName}" maxlength="30" placeholder="My Token"></div>
        <div><label>Symbol</label>
        <input id="lp-tsym" value="${flow.tsym || defSym}" maxlength="8" placeholder="TKN"
          style="text-transform:uppercase"></div>
      </div>
      <label>Description</label>
      <textarea id="tk-desc" rows="2" placeholder="Shown on Jupiter and explorers">${flow.tdesc || ""}</textarea>

      <label>Priced in</label>
      <div class="ptabs" id="tk-quotes">
        <button data-q="sol" ${flow.quote === "sol" ? raw('class="on"') : ""}
          ${quotes.indexOf("sol") < 0 ? raw("disabled") : ""}>SOL</button>
        <button data-q="usdc" ${flow.quote === "usdc" ? raw('class="on"') : ""}
          ${quotes.indexOf("usdc") < 0 ? raw("disabled") : ""}>USDC</button>
        <button data-q="rwa" ${flow.quote !== "sol" && flow.quote !== "usdc" ? raw('class="on"') : ""}
          ${rwas.length ? "" : raw('disabled title="A stock or commodity as the trading pair — no RWA curve config signed yet"')}
          >${flow.quote !== "sol" && flow.quote !== "usdc" ? qLabel
             : (rwas.length === 1 ? rwas[0].label : "RWA")}</button>
      </div>

      <div class="fold2" id="tk-econ">
        <div class="row"><span class="k">Total supply</span><b>1,000,000,000 · fixed</b></div>
        <div class="row"><span class="k">Trading fee</span><b id="tk-fee">${(flow.customFee || 1)
          + "% — 20% you / 60% platform / 20% Meteora"}</b></div>
        <div class="row"><span class="k">Graduates at</span><b id="tk-grad">reading the curve…</b></div>
        <div class="row" style="border-bottom:0"><span class="k">Migrates to</span><b>Meteora DAMM v2, LP locked</b></div>
        <p class="note" style="margin-top:6px">Locked in the launchpad's config — identical
        for every launch, so nobody negotiates a better curve than you.</p>
      </div>

      <label>Your first buy (${qLabel}) — optional</label>
      <input id="lp-tbuy" type="number" min="0" step="0.1" value="${flow.tbuy || 0}">
      <div class="ptabs" id="tk-chips">
        <button data-v="0.1">0.1</button><button data-v="0.5">0.5</button>
        <button data-v="1">1</button><button data-v="5">5</button>
      </div>
      <p class="note">Lands in the same transaction as the pool, so nobody can snipe
      the opening price ahead of you.</p>

      <label>Swap fee</label>
      <div class="tiers" id="tk-tiers">
        <button data-t="standard" class="tier ${!flow.customFee ? "on" : ""}">
          <b>Standard — 1%</b><span>You keep 20% of the fee (0.2% of volume).</span></button>
        <button data-t="custom" class="tier ${flow.customFee ? "on" : ""}"
          ${flow.quote !== "sol" && flow.quote !== "usdc"
            ? raw('disabled title="Custom fees are SOL/USDC quotes only for now"') : ""}>
          <b>Tax token — your %</b><span>Same 20% share of a bigger fee —
          the burn/dividend budget.</span></button>
      </div>
      <div id="tk-customrow" ${flow.customFee ? "" : raw("hidden")}>
        <label>Fee percent</label>
        <input id="tk-custompct" type="number" min="0.25" max="20" step="0.25"
          value="${flow.customFee || 1}">
        <div class="ptabs" id="tk-feechips">
          <button data-v="1">1%</button><button data-v="2">2%</button>
          <button data-v="3">3%</button><button data-v="5">5%</button>
          <button data-v="10">10%</button>
        </div>
        <p class="note" id="tk-customsplit"></p>
      </div>
      <p class="note">A tax token is a bigger swap fee with a bigger creator share —
      that stream funds burns or dividends via the rewards program. Per-transfer
      taxes arrive with holder staking.</p>

      <label>Fee sharing — how much of your share goes to holders</label>
      <div class="sharebox">
        <input id="tk-sharepct" type="range" min="0" max="6" step="1"
          value="${[0,10,25,50,75,90,100].indexOf(flow.feeSharePct || 0) >= 0
            ? [0,10,25,50,75,90,100].indexOf(flow.feeSharePct || 0) : 0}">
        <div class="shareticks">
          <span>0</span><span>10</span><span>25</span><span>50</span>
          <span>75</span><span>90</span><span>100</span>
        </div>
        <div class="sharelbl"><span id="tk-sharetxt"></span></div>
      </div>

      <div id="tk-rewardwrap">
        <label>Holder rewards paid in</label>
        <button class="pick" id="lp-reward">
          <span><b>${flow.reward.symbol}</b> &nbsp;<span class="k2">${flow.reward.name}</span></span>
          <span class="pk-r"><span class="k2 mono">${shortAddr(flow.reward.mint)}</span>
          <span class="pk-dd">Change ▾</span></span>
        </button>
        <p class="note">What the keeper pays holders in. Distributions run on a
        schedule, pro-rata by holdings.</p>
      </div>

      <div id="tk-fwwrap" ${(flow.feeSharePct || 0) >= 100 ? raw("hidden") : ""}>
        <label>Creator fee wallet</label>
        <input id="tk-feewallet" value="${flow.feeWallet || ""}"
          placeholder="optional — defaults to deployer wallet">
        <p class="note">Where your kept portion goes. Claim anytime from
        Explore → Claim fees${(flow.feeSharePct || 0) > 0
          ? " — the keeper routes it here automatically on shared launches" : ""}.</p>
      </div>

      <div class="two">
        <div><label>Website</label><input id="tk-web" value="${flow.web || ""}" placeholder="site.xyz"></div>
        <div><label>X</label><input id="tk-x" value="${flow.x || ""}" placeholder="@handle"></div>
      </div>
      <div class="two">
        <div><label>Telegram</label><input id="tk-tg" value="${flow.tg || ""}" placeholder="t.me/…"></div>
        <div><label>Discord</label><input id="tk-dc" value="${flow.dc || ""}" placeholder="discord.gg/…"></div>
      </div>

      ${window.Token.configKey() ? "" : raw(
        '<p class="err">Token launches are not configured on this deployment yet — ' +
        "the form is a preview and the launch button is disabled.</p>")}
      <div id="lp-err"></div>
      <div class="acts"><button id="lp-x">${nft ? "Skip token" : "Back"}</button>
      <button class="go" id="lp-next" ${window.Token.configKey() ? "" : raw("disabled")}>Continue</button></div>
    `);

    // live economics, read from the chain config — not hardcoded copy
    window.Token.describeConfig(flow.quote).then(function (d) {
      var el = box.querySelector("#tk-grad");
      if (!el) return;
      if (!d) { el.textContent = "shown at launch"; return; }
      el.textContent = UI.fmt(d.graduation) + " " + qLabel + " raised";
      if (d.feePct && !flow.customFee) box.querySelector("#tk-fee").textContent =
        d.feePct + "% — " + Math.round(80 * d.creatorShare / 100) + "% you / " +
        Math.round(80 * (100 - d.creatorShare) / 100) + "% platform / 20% Meteora";
    });

    function collect() {
      flow.tname = box.querySelector("#lp-tname").value;
      flow.tsym = box.querySelector("#lp-tsym").value;
      flow.tbuy = box.querySelector("#lp-tbuy").value;
      flow.tdesc = box.querySelector("#tk-desc").value;
      var fw = box.querySelector("#tk-feewallet");
      flow.feeWallet = fw ? fw.value.trim() : (flow.feeWallet || "");
      flow.web = box.querySelector("#tk-web").value.trim();
      flow.x = box.querySelector("#tk-x").value.trim();
      flow.tg = box.querySelector("#tk-tg").value.trim();
      flow.dc = box.querySelector("#tk-dc").value.trim();
    }

    box.querySelector("#tk-logobtn").onclick = function () { box.querySelector("#tk-logo").click(); };
    box.querySelector("#tk-logo").addEventListener("change", function (e) {
      var f = e.target.files && e.target.files[0];
      if (!f) return;
      f.arrayBuffer().then(function (buf) {
        flow.icon = new Uint8Array(buf);
        flow.iconName = f.name;
        flow.iconExt = /\.jpe?g$/i.test(f.name) ? "jpg" : "png";
        var lb = box.querySelector("#tk-logobtn");
        lb.textContent = "✓ " + f.name; lb.classList.add("has");
      });
    });
    box.querySelector("#tk-bannerbtn").onclick = function () {
      box.querySelector("#tk-banner").click();
    };
    box.querySelector("#tk-banner").addEventListener("change", function () {
      var f = box.querySelector("#tk-banner").files[0];
      if (!f) return;
      f.arrayBuffer().then(function (buf) {
        flow.banner = new Uint8Array(buf);
        flow.bannerName = f.name;
        flow.bannerExt = /\.jpe?g$/i.test(f.name) ? "jpg" : "png";
        var bb = box.querySelector("#tk-bannerbtn");
        bb.textContent = "✓ " + f.name; bb.classList.add("has");
      });
    });
    var SHARE_STOPS = [0, 10, 25, 50, 75, 90, 100];
    function paintShare() {
      var sl = box.querySelector("#tk-sharepct");
      var pct = SHARE_STOPS[+sl.value] || 0;
      // the track tells the truth: green exactly as far as the thumb travels,
      // and the thumb runs the full rail — 0 is hard left, 100 hard right
      var t = (+sl.value / 6) * 100;
      sl.style.background = "linear-gradient(90deg, var(--accent) 0%, var(--accent) " +
        t + "%, var(--raise) " + t + "%, var(--raise) 100%)";
      flow.feeSharePct = pct;
      flow.feeShare = pct > 0 ? "holders" : "keep";
      box.querySelector("#tk-sharetxt").textContent = pct === 0
        ? "You keep everything — claim whenever you like."
        : pct + "% to your holders, " + (100 - pct) + "% to you — paid out " +
          "automatically by the keeper.";
      box.querySelector("#tk-fwwrap").hidden = pct >= 100;
    }
    paintShare();
    box.querySelector("#tk-sharepct").addEventListener("input", paintShare);
    box.querySelector("#tk-tiers").addEventListener("click", function (e) {
      var b = e.target.closest("button[data-t]");
      if (!b || b.disabled) return;
      // toggle IN PLACE — a full re-render scrolls the window back to the
      // top, which reads as a jump
      flow.customFee = b.dataset.t === "custom"
        ? (parseFloat(box.querySelector("#tk-custompct").value) || 1) : 0;
      box.querySelectorAll("#tk-tiers .tier").forEach(function (x) {
        x.classList.toggle("on", x === b);
      });
      box.querySelector("#tk-customrow").hidden = !flow.customFee;
      box.querySelector("#tk-fee").textContent =
        (flow.customFee || 1) + "% — 20% you / 60% platform / 20% Meteora";
      if (flow.customFee) paintSplit();
    });
    function paintSplit() {
      var pct = parseFloat(box.querySelector("#tk-custompct").value) || 0;
      var el = box.querySelector("#tk-customsplit");
      if (!(pct >= 0.25)) { el.textContent = "Minimum 0.25%."; return; }
      el.textContent = "Of every trade: " + (pct * 0.2).toFixed(2) + "% to you, " +
        (pct * 0.6).toFixed(2) + "% to the platform, " + (pct * 0.2).toFixed(2) +
        "% to Meteora.";
    }
    if (flow.customFee) paintSplit();
    box.querySelector("#tk-custompct").addEventListener("input", function () {
      flow.customFee = Math.min(20, Math.max(0.25,
        parseFloat(box.querySelector("#tk-custompct").value) || 0)) || flow.customFee;
      box.querySelector("#tk-fee").textContent =
        flow.customFee + "% — 20% you / 60% platform / 20% Meteora";
      paintSplit();
    });
    box.querySelector("#tk-feechips").addEventListener("click", function (e) {
      var b = e.target.closest("button[data-v]");
      if (!b) return;
      flow.customFee = +b.dataset.v;
      box.querySelector("#tk-custompct").value = b.dataset.v;
      box.querySelector("#tk-fee").textContent =
        flow.customFee + "% — 20% you / 60% platform / 20% Meteora";
      paintSplit();
    });
    box.querySelector("#tk-quotes").addEventListener("click", function (e) {
      var b = e.target.closest("button[data-q]");
      if (!b || b.disabled) return;
      collect();
      if (b.dataset.q === "rwa") {
        // pick WHICH asset prices the pair — only mints with a signed config
        var r = window.Token.rwaQuotes();
        if (r.length === 1) {
          flow.quote = r[0].mint; flow.quoteSym = r[0].label;
          return tokenDetails(flow);
        }
        return rwaQuotePicker(flow, r);
      }
      flow.quote = b.dataset.q;
      tokenDetails(flow);                          // re-render with the new currency
    });
    box.querySelector("#tk-chips").addEventListener("click", function (e) {
      var b = e.target.closest("button[data-v]");
      if (b) box.querySelector("#lp-tbuy").value = b.dataset.v;
    });
    box.querySelector("#lp-x").onclick = function () {
      if (nft) { recordCollection(nft.cfg, nft.res, null, nft.up); nftDone(nft.cfg, nft.res, nft.up); }
      else modeSelect();
    };
    box.querySelector("#lp-reward").onclick = function () { collect(); rewardPicker(flow); };
    box.querySelector("#lp-next").onclick = function () {
      collect();
      var name = flow.tname.trim();
      var sym = flow.tsym.trim().toUpperCase();
      if (!name) return fail(box, "The token needs a name.");
      if (!/^[A-Z0-9]{2,8}$/.test(sym)) return fail(box, "Symbol: 2-8 letters or digits.");
      if (flow.feeWallet && !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(flow.feeWallet)) {
        return fail(box, "The fee wallet is not a valid address.");
      }
      flow.tname = name; flow.tsym = sym;
      flow.tbuy = parseFloat(flow.tbuy) || 0;
      if (flow.preconfig) return nftConfirm(flow.cfg, flow);
      tokenConfirm(flow);
    };
  }

  /* The 500+ asset picker. Shows the mint on every row on purpose: the entire
   * reason rwa.json is generated and chain-verified is that picking by ticker
   * is dangerous — five "TSLAx" tokens exist and four are fakes. The UI must
   * not undo that by hiding what is actually being selected. */
  function rewardPicker(flow) {
    var box = shell(H`
      <h2>Reward asset</h2>
      <p class="sub">Trading fees are converted into this before distribution.</p>
      <input id="lp-q" type="search" placeholder="Search 400+ verified assets" autocomplete="off">
      <div class="ptabs" id="lp-tabs">
        <button data-t="all" class="on">All</button>
        <button data-t="native">SOL &amp; USDC</button>
        <button data-t="equity">Stocks</button>
        <button data-t="commodity">Commodities</button>
      </div>
      <div class="plist" id="lp-list"><p class="note" style="padding:12px">Loading…</p></div>
      <div class="acts"><button id="lp-x">Back</button></div>
    `);
    box.querySelector("#lp-x").onclick = function () { tokenDetails(flow); };

    var all = null, tab = "all", q = "";

    function draw() {
      if (!all) return;
      var rows = all.filter(function (t) {
        if (tab !== "all" && t.kind !== tab) return false;
        if (!q) return true;
        return (t.symbol + " " + t.name).toLowerCase().indexOf(q) >= 0;
      }).slice(0, 200);
      var list = box.querySelector("#lp-list");
      list.innerHTML = rows.map(function (t) {
        return '<button class="prow" data-mint="' + esc(t.mint) + '">' +
          "<b>" + esc(t.symbol) + "</b><span>" + esc(t.name) + "</span>" +
          "<i>" + esc(shortAddr(t.mint)) + "</i></button>";
      }).join("") || '<p class="note" style="padding:12px">Nothing matches.</p>';
      list.querySelectorAll(".prow").forEach(function (b) {
        b.onclick = function () {
          flow.reward = all.find(function (t) { return t.mint === b.dataset.mint; });
          tokenDetails(flow);
        };
      });
    }

    window.Token.rwa().then(function (rwa) {
      all = BUILTIN_REWARDS.concat(rwa);
      draw();
    });
    box.querySelector("#lp-q").addEventListener("input", function (e) {
      q = e.target.value.trim().toLowerCase(); draw();
    });
    box.querySelector("#lp-tabs").addEventListener("click", function (e) {
      var b = e.target.closest("button"); if (!b) return;
      tab = b.dataset.t;
      box.querySelectorAll("#lp-tabs button").forEach(function (x) {
        x.classList.toggle("on", x === b);
      });
      draw();
    });
  }

  /* Which real-world asset prices the pair. Short list on purpose: every row
   * here required the platform wallet to sign a curve config for that mint —
   * this is not the 500+ reward list. */
  function rwaQuotePicker(flow, list) {
    var box = shell(H`
      <h2>Priced in a real-world asset</h2>
      <p class="sub">The token trades against this asset — buys are paid in it,
      the curve graduates in it.</p>
      <div class="plist">
        ${raw(list.map(function (t) {
          return '<button class="prow" data-mint="' + esc(t.mint) + '">' +
            "<b>" + esc(t.symbol) + "</b>" +
            "<i>" + esc(shortAddr(t.mint)) + "</i></button>";
        }).join(""))}
      </div>
      <div class="acts"><button id="lp-x">Back</button></div>
    `);
    box.querySelector("#lp-x").onclick = function () { tokenDetails(flow); };
    box.querySelectorAll(".prow").forEach(function (b) {
      b.onclick = function () {
        var t = list.find(function (x) { return x.mint === b.dataset.mint; });
        flow.quote = t.mint; flow.quoteSym = t.label || t.symbol;
        tokenDetails(flow);
      };
    });
  }

  async function tokenConfirm(flow) {
    var w = window.Wallet.current();
    var nft = flow.nft;
    var qLabel = flow.quote === "usdc" ? "USDC"
      : flow.quote === "sol" ? "SOL" : (flow.quoteSym || "RWA");
    var box = shell(H`
      <h2>Confirm token</h2>
      <p class="sub">One small metadata upload, then the pool. The curve is the liquidity.</p>
      <div class="row"><span class="k">Token</span><b>${flow.tname} · $${flow.tsym}</b></div>
      ${nft ? H`<div class="row"><span class="k">Paired with</span><b>${nft.cfg.name}</b></div>` : ""}
      <div class="row"><span class="k">Priced in</span><b>${qLabel}</b></div>
      <div class="row"><span class="k">Fee sharing</span><b>${(flow.feeSharePct || 0) > 0
        ? flow.feeSharePct + "% to holders / " + (100 - flow.feeSharePct) + "% to you"
        : "You keep everything"}</b></div>
      ${(flow.feeSharePct || 0) > 0 ? H`<div class="row"><span class="k">Rewards in</span><b>${flow.reward.symbol}</b></div>` : ""}
      <div class="row"><span class="k">First buy</span><b>${flow.tbuy > 0 ? flow.tbuy + " " + qLabel : "none"}</b></div>
      ${flow.feeWallet ? H`<div class="row"><span class="k">Fees claim to</span><b>${shortAddr(flow.feeWallet)}</b></div>` : ""}
      <div class="row"><span class="k">Metadata storage</span><b id="lp-fee">quoting…</b></div>
      <div class="row"><span class="k">Wallet</span><b>${w ? w.name + " · " + shortAddr(w.publicKey) : "not connected"}</b></div>
      <div class="row"><span class="k">Swap fee</span><b>${flow.customFee
        ? "Tax token — " + flow.customFee + "%" : "Standard — 1%"}</b></div>
      <p class="note">Fee split on every trade: 20% you, 60% platform, 20% Meteora —
      the same split at every fee level.
      Your share claims straight to any address — including a reward vault.</p>
      <div id="lp-err"></div>
      <div class="acts"><button id="lp-back">Back</button>
      <button class="go" id="lp-go" disabled>${w ? "Launch token" : "Connect a wallet"}</button></div>
    `);
    box.querySelector("#lp-back").onclick = function () { tokenDetails(flow); };

    try {
      var upBytes = 300 + (flow.icon ? flow.icon.length : 0) +
        (flow.banner ? flow.banner.length : 0);
      var upCount = 2 + (flow.icon ? 1 : 0) + (flow.banner ? 1 : 0);
      var quote = await window.Storage.quoteUpload(upBytes, upCount);
      box.querySelector("#lp-fee").textContent = Number(quote.feeSol).toFixed(4) + " SOL";
    } catch (e) {
      box.querySelector("#lp-fee").textContent = "unavailable";
      fail(box, "Could not price storage: " + e.message);
      return;
    }

    var go = box.querySelector("#lp-go");
    go.disabled = false;
    go.onclick = w
      ? function () { doTokenLaunch(flow); }
      : async function () {
          var w2 = await (window.Shell ? Shell.connect() : Promise.resolve(null));
          if (w2) tokenConfirm(flow);
        };
  }

  async function doTokenLaunch(flow) {
    busy = true;
    var stages = [
      ["meta", "Storing token metadata"],
      ["pool", "Creating the pool" + (flow.tbuy > 0 ? " + your first buy" : "")]
    ];
    if (flow.feeShare === "holders") {
      stages.push(["pledge", "Pledging your fee share to holders"]);
    }
    var box = shell(H`
      <h2>Launching token</h2>
      <p class="sub">Leave this tab open.</p>
      <ul class="steps">${raw(stages.map(function (s) {
        return '<li data-k="' + s[0] + '"><i>·</i><span>' + esc(s[1]) + "</span></li>";
      }).join(""))}</ul>
      <div id="lp-err"></div>
    `);
    var mark = stepList(box);

    try {
      mark("meta", "on");
      var tcard = await makeCard({
        name: flow.tname, symbol: flow.tsym,
        avatar: flow.icon || null, banner: flow.banner || null
      }, "token", [
        ["priced in", (flow.quote || "SOL").toUpperCase()],
        ["swap fee", (flow.customFeeBps ? (flow.customFeeBps / 100) : 1) + "%"],
        ["chain", "Solana"]
      ]);
      var meta = await window.Storage.uploadTokenMeta({
        name: flow.tname,
        card: tcard,
        symbol: flow.tsym,
        description: flow.tdesc || (flow.nft ? "Paired with " + flow.nft.cfg.name : ""),
        icon: flow.icon || null,
        iconExt: flow.iconExt || "png",
        banner: flow.banner || null,
        bannerExt: flow.bannerExt || "png",
        links: { website: flow.web, x: flow.x, telegram: flow.tg },
        payer: function (q) { return payStorage(q); }
      });
      mark("meta", "done");

      mark("pool", "on");
      var res = await window.Token.launchToken({
        name: flow.tname,
        symbol: flow.tsym,
        uri: meta.uri,
        quote: flow.quote,
        customFeeBps: flow.customFee ? Math.round(flow.customFee * 100) : 0,
        feeShare: flow.feeShare || "keep",
        feeSharePct: flow.feeSharePct || 0,
        firstBuySol: flow.tbuy,
        rewardMint: flow.reward.mint,
        feeWallet: flow.feeWallet || null,
        icon: meta.iconUri || null,
        banner: meta.bannerUri || null,
        card: meta.cardUri || null,
        collection: flow.nft ? flow.nft.res.collection : null
      });
      mark("pool", "done");

      // Link the records both ways for a pair.
      if (flow.nft) recordCollection(flow.nft.cfg, flow.nft.res, res.mint, flow.nft.up);

      busy = false;
      tokenDone(flow, res);
    } catch (e) {
      busy = false;
      fail(box, describe(e));
      box.insertAdjacentHTML("beforeend",
        '<div class="acts"><button id="lp-close2">Close</button></div>');
      box.querySelector("#lp-close2").onclick = close;
    }
  }

  function tokenDone(flow, res) {
    var nft = flow.nft;
    var jup = "https://jup.ag/swap/SOL-" + res.mint;
    var box = shell(H`
      <h2>Live</h2>
      <p class="sub">$${flow.tsym} is trading on ${res.cluster}.</p>
      <div class="row"><span class="k">Fee sharing</span><b>${(flow.feeSharePct || 0) > 0
        ? flow.feeSharePct + "% to holders / " + (100 - flow.feeSharePct) + "% to you"
        : "You keep everything"}</b></div>
      ${(flow.feeSharePct || 0) > 0 ? H`<div class="row"><span class="k">Rewards in</span><b>${flow.reward.symbol}</b></div>` : ""}
      ${raw(caRow("Token CA", res.mint))}
      ${nft ? raw(caRow("Collection", nft.res.collection) + caRow("Candy machine", nft.res.candyMachine)) : ""}
      ${nft ? H`<label>Mint page</label>
      <input readonly value="${nft.res.mintUrl}" onclick="this.select()">` : ""}
      <p class="note"><a href="${jup}" target="_blank" rel="noopener">Trade on Jupiter ↗</a></p>
      <div class="acts"><button id="lp-done">Close</button>
      ${nft ? H`<button class="go" id="lp-open">Open mint page</button>` : ""}</div>
    `);
    bindCopy(box);
    box.querySelector("#lp-done").onclick = close;
    var open = box.querySelector("#lp-open");
    if (open) open.onclick = function () { location.href = nft.res.mintUrl; };
  }

  /* ---------- public surface ---------- */

  /* Direct mode entry, used by the shell's Launch menu and the ?launch= query.
   * Modes that need something missing fall back to the mode select, which
   * already explains what is missing instead of failing silently. */
  function openMode(mode) {
    // straight into the token window either way — if the deployment has no
    // partner config the window says so and holds the launch button, which
    // beats bouncing the creator to a chooser they did not ask for
    if (mode === "token") return tokenDetails(null);
    // arriving from the shell's chooser with the source already decided
    if (mode === "files-collection") return ownFiles("collection");
    if (mode === "files-pair") return ownFiles("pair");
    if (mode === "collection" || mode === "pair") return sourceSelect(mode);
    modeSelect();
  }

  /* Where does the art come from? The editor behind this window, or a folder
   * the creator already has — the same fork Moonpad offered. A generated run,
   * when one exists, is the first card. */
  function sourceSelect(mode) {
    var hasRun = !!(run && run.files);
    var flow = mode === "pair" ? { pair: true } : null;
    var box = shell(H`
      <h2>${mode === "pair" ? "Launch a pair" : "Launch a collection"}</h2>
      <p class="sub">Where is the art coming from?</p>
      <div class="modes">
        ${hasRun ? H`<button class="mode" id="src-run">
          <span class="mi">✓</span>
          <span><b>Use what you generated</b>
          <span>${run.count} pieces, ready to go.</span></span>
        </button>` : ""}
        <button class="mode" id="src-editor">
          <span class="mi">✎</span>
          <span><b>Draw it in the editor</b>
          <span>Trait by trait, right behind this window — then generate and launch.</span></span>
        </button>
        <button class="mode" id="src-files">
          <span class="mi">⤒</span>
          <span><b>Bring your own files</b>
          <span>Already have the art? A folder of PNGs becomes the collection, numbered in order.</span></span>
        </button>
      </div>
      <div id="lp-err"></div>
      <div class="acts"><button id="lp-x">Cancel</button></div>
    `);
    box.querySelector("#lp-x").onclick = close;
    var r = box.querySelector("#src-run");
    if (r) r.onclick = function () { nftDetails(flow); };
    box.querySelector("#src-editor").onclick = function () {
      // The editor IS this page — get out of its way. From another page the
      // shell menu already routed here first.
      close();
    };
    box.querySelector("#src-files").onclick = function () { ownFiles(mode); };
  }

  /* Bring your own files: PNGs in, numbered collection out. Natural sort, so
   * 2.png lands before 10.png the way every file manager shows them — a
   * lexicographic sort here silently shuffles the collection and nobody
   * notices until token #2 has the art of #10. Metadata is generated per
   * piece; a hand-made collection gets working metadata without hand-writing
   * five thousand json files. */
  function ownFiles(mode) {
    var flow = mode === "pair" ? { pair: true } : null;
    var box = shell(H`
      <h2>Your files</h2>
      <p class="sub">PNGs, one per piece. They become 1.png upward
      in natural order.</p>
      <div class="drop" id="of-drop"><b>Drop your files here</b>
      <span>or click to browse — PNG images, plus an optional .json each</span></div>
      <input type="file" id="of-input" accept="image/png,application/json" multiple hidden>
      <p class="note" id="of-note"></p>
      <div id="lp-err"></div>
      <div class="acts"><button id="lp-x">Back</button>
      <button class="go" id="of-go" disabled>Continue</button></div>
    `);
    box.querySelector("#lp-x").onclick = function () { sourceSelect(mode); };
    var input = box.querySelector("#of-input");
    var drop = box.querySelector("#of-drop");
    drop.onclick = function () { input.click(); };
    // dragover must be cancelled or the browser navigates to the dropped file
    drop.addEventListener("dragover", function (e) { e.preventDefault(); drop.classList.add("hot"); });
    drop.addEventListener("dragleave", function () { drop.classList.remove("hot"); });
    drop.addEventListener("drop", function (e) {
      e.preventDefault(); drop.classList.remove("hot");
      stage([].slice.call((e.dataTransfer && e.dataTransfer.files) || []));
    });
    input.addEventListener("change", function () {
      stage([].slice.call(input.files || []));
    });

    var staged = null;
    function stage(all) {
      if (!all.length) return;
      var pngs = all.filter(function (f) { return /\.png$/i.test(f.name); });
      var jsons = all.filter(function (f) { return /\.json$/i.test(f.name); });
      var other = all.length - pngs.length - jsons.length;
      if (other) return fail(box, other + " of those are neither PNG nor JSON.");
      if (!pngs.length) return fail(box, "No images in that selection.");

      // Metadata pairing, as promised on the fork page: 4.png needs 4.json.
      // If ANY json comes along, EVERY image must have its pair — a half-paired
      // collection means half the traits silently vanish, which nobody notices
      // until reveal. We check every pair; we never write their json.
      var stem = function (n) { return n.replace(/\.(png|json)$/i, ""); };
      var jmap = {};
      jsons.forEach(function (j) { jmap[stem(j.name)] = j; });
      if (jsons.length) {
        var missing = pngs.filter(function (p) { return !jmap[stem(p.name)]; });
        if (missing.length) return fail(box, missing.length + " image(s) have no matching .json — first: " +
          missing[0].name + " needs " + stem(missing[0].name) + ".json");
        var orphans = jsons.filter(function (j) {
          return !pngs.some(function (p) { return stem(p.name) === stem(j.name); });
        });
        if (orphans.length) return fail(box, orphans[0].name + " has no matching image.");
      }

      // natural sort: "2.png" before "10.png" — lexicographic silently shuffles
      // the collection and nobody notices until token #2 wears #10's art
      pngs.sort(function (a, b) {
        return a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" });
      });

      Promise.all(pngs.map(function (f) { return f.arrayBuffer(); })).then(function (bufs) {
        var reads = pngs.map(function (p) {
          var j = jmap[stem(p.name)];
          return j ? j.text() : Promise.resolve(null);
        });
        return Promise.all(reads).then(function (texts) {
          var images = [], metaplex = [], badJson = null;
          for (var i = 0; i < pngs.length; i++) {
            var id = i + 1;
            images.push({ id: id, name: id + ".png", bytes: new Uint8Array(bufs[i]) });
            var meta;
            if (texts[i] != null) {
              try {
                meta = JSON.parse(texts[i]);
                if (!meta || typeof meta !== "object") throw new Error("not an object");
              } catch (e) { badJson = badJson || (stem(pngs[i].name) + ".json is not valid JSON"); continue; }
              if (!meta.name) meta.name = "#" + id;
              meta.image = id + ".png";
              meta.properties = meta.properties || {};
              meta.properties.files = [{ uri: id + ".png", type: "image/png" }];
              meta.properties.category = "image";
            } else {
              meta = { name: "#" + id, symbol: "", image: id + ".png", attributes: [],
                properties: { files: [{ uri: id + ".png", type: "image/png" }], category: "image" } };
            }
            metaplex.push({ id: id, name: id + ".json", text: JSON.stringify(meta, null, 2) });
          }
          if (badJson) return fail(box, badJson);
          staged = { images: images, metaplex: metaplex, count: pngs.length };
          box.querySelector("#of-note").textContent =
            pngs.length + " pieces staged" + (jsons.length ? " with your metadata" : "") +
            " — " + pngs[0].name + " becomes 1.png, " +
            pngs[pngs.length - 1].name + " becomes " + pngs.length + ".png.";
          box.querySelector("#of-go").disabled = false;
        });
      });
    }

    box.querySelector("#of-go").onclick = function () {
      if (!staged) return;
      run = { files: { images: staged.images, metaplex: staged.metaplex }, count: staged.count };
      nftDetails(flow);
    };
  }

  window.LaunchPanel = {
    setRun: function (files, count) { run = { files: files, count: count }; },
    open: function () { modeSelect(); },
    openMode: openMode
  };

  // Arriving with ?launch=token (from the shell menu on another page) opens
  // the panel once the page is up. The param is consumed so a reload does not
  // resurrect the panel.
  (function () {
    var m = new URLSearchParams(location.search).get("launch");
    if (!m) return;
    history.replaceState(null, "", location.pathname);
    setTimeout(function () { openMode(m); }, 60);
  })();
})();
