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
      pairOn: !!flow.pair, avatar: null, avatarName: "", banner: null, bannerName: ""
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

      <label>Royalty wallet</label>
      <input id="f-royto" value="${d.royTo}" placeholder="optional — defaults to your wallet">

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

      <label class="tick"><input type="checkbox" id="f-pairOn" ${d.pairOn ? raw("checked") : ""}
        ${window.Token && window.Token.configKey() ? "" : raw("disabled")}>
        <span><b>Pair a token</b>
        <span>${window.Token && window.Token.configKey()
          ? "Launch a bonding-curve token after the collection — its trading fees can reward your holders."
          : "Not configured on this deployment yet."}</span></span></label>

      <label class="tick"><input type="checkbox" disabled>
        <span><b>Enable staking</b>
        <span>Burn-to-stake rewards are coming — pick the reward asset in the token step meanwhile.</span></span></label>

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
      d.pairOn = box.querySelector("#f-pairOn").checked;
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
      nftConfirm({
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
      }, flow);
    };
  }

  async function nftConfirm(cfg, flow) {
    var w = window.Wallet.current();
    var waveTxt = cfg.waves
      ? cfg.waves.phases.map(function (p) { return p.wallets.length; }).join(" + ") +
        " wallets · " + cfg.waves.minutes + " min waves"
      : "no — public from open";
    var box = shell(H`
      <h2>Confirm</h2>
      <p class="sub">Two things get paid for: permanent storage, and Solana rent plus fees.</p>
      <div class="row"><span class="k">Collection</span><b>${cfg.name}${cfg.symbol ? " · " + cfg.symbol : ""}</b></div>
      <div class="row"><span class="k">Supply</span><b>${cfg.supply}${cfg.devTotal ? " (" + cfg.devTotal + " to the team first)" : ""}</b></div>
      <div class="row"><span class="k">Mint price</span><b>${cfg.priceSol} SOL${cfg.maxPerWallet ? " · max " + cfg.maxPerWallet + "/wallet" : ""}</b></div>
      <div class="row"><span class="k">Royalty</span><b>${cfg.royaltyPercent}%${cfg.royaltyTo ? " → " + shortAddr(cfg.royaltyTo) : ""}</b></div>
      <div class="row"><span class="k">Allowlist</span><b>${waveTxt}</b></div>
      <div class="row"><span class="k">Opens</span><b>${cfg.openAt ? new Date(cfg.openAt).toLocaleString() : "immediately"}</b></div>
      ${flow && flow.pair ? H`<div class="row"><span class="k">Then</span><b>a paired token</b></div>` : ""}
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
        box.querySelector("#lp-fee").textContent = Number(quote.feeSol).toFixed(4) + " SOL";
      });
    } catch (e) {
      box.querySelector("#lp-fee").textContent = "unavailable";
      fail(box, "Could not price storage: " + e.message);
      return;
    }

    var go = box.querySelector("#lp-go");
    go.disabled = false;
    go.onclick = w
      ? function () { doNftLaunch(cfg, flow); }
      : async function () {
          var w2 = await (window.Shell ? Shell.connect() : Promise.resolve(null));
          if (w2) nftConfirm(cfg, flow);
        };
  }

  /* Sizing probe for the pre-launch quote. storage.js sizes properly against
   * the real file set at upload time; this must not drift from it or the
   * quoted fee will not match the charged fee. */
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
    return { bytes: bytes, count: count + 6 };    // +6 for _index, _collection etc.
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
      var up = await window.Storage.uploadCollection({
        files: run.files,
        name: cfg.name,
        symbol: cfg.symbol,
        description: cfg.description,
        avatar: cfg.avatar,
        banner: cfg.banner,
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
        tokenDetails(flow);
        return;
      }

      recordCollection(cfg, res, null, up);
      nftDone(cfg, res, up);
    } catch (e) {
      busy = false;
      fail(box, e.message || String(e));
      box.insertAdjacentHTML("beforeend",
        '<div class="acts"><button id="lp-close2">Close</button></div>');
      box.querySelector("#lp-close2").onclick = close;
    }
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

    var umi = mx.createUmi(window.Launch.clusters[window.Launch.cluster()].rpc, "confirmed")
      .use(mx.walletAdapterIdentity({
        publicKey: new mx.PublicKey(w.publicKey),
        signMessage: function (b) { return w.signMessage(b); },
        signTransaction: function (t) { return w.signTransaction(t); },
        signAllTransactions: function (t) { return w.signAllTransactions(t); }
      }));

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
    var defName = nft ? nft.cfg.name : "";
    var defSym = defName ? defName.replace(/[^A-Za-z]/g, "").slice(0, 5).toUpperCase() : "";
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

      <label>Logo</label>
      <div class="filebtn"><button id="tk-logobtn" type="button">Choose…</button>
      <span id="tk-logoname">${flow.iconName || "square png — shown in wallets and on Jupiter"}</span></div>
      <input type="file" id="tk-logo" accept="image/png" hidden>

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
          >${flow.quote !== "sol" && flow.quote !== "usdc" ? qLabel : "RWA"}</button>
      </div>

      <div class="fold2" id="tk-econ">
        <div class="row"><span class="k">Total supply</span><b>1,000,000,000 · fixed</b></div>
        <div class="row"><span class="k">Trading fee</span><b id="tk-fee">1% — 20% you / 60% platform / 20% Meteora</b></div>
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

      <label>Holder rewards paid in</label>
      <button class="pick" id="lp-reward">
        <span><b>${flow.reward.symbol}</b> &nbsp;<span class="k2">${flow.reward.name}</span></span>
        <span class="k2 mono">${shortAddr(flow.reward.mint)}</span>
      </button>
      <p class="note">What the fee keeper converts trading fees into before paying
      ${nft ? "this collection's stakers" : "holders"}.</p>

      <label>Creator fee wallet</label>
      <input id="tk-feewallet" value="${flow.feeWallet || ""}"
        placeholder="optional — defaults to your wallet">
      <p class="note">Where your 20% of trading fees claims to. A treasury, a
      multisig, or the reward vault.</p>

      <label class="tick"><input type="checkbox" disabled>
        <span><b>Tax settings — buy/sell rates, burn, dividends</b>
        <span>Transfer-tax mechanics arrive with the rewards program. The reward
        asset above already decides what holders get paid in.</span></span></label>

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
      if (d.feePct) box.querySelector("#tk-fee").textContent =
        d.feePct + "% — " + Math.round(80 * d.creatorShare / 100) + "% you / " +
        Math.round(80 * (100 - d.creatorShare) / 100) + "% platform / 20% Meteora";
    });

    function collect() {
      flow.tname = box.querySelector("#lp-tname").value;
      flow.tsym = box.querySelector("#lp-tsym").value;
      flow.tbuy = box.querySelector("#lp-tbuy").value;
      flow.tdesc = box.querySelector("#tk-desc").value;
      flow.feeWallet = box.querySelector("#tk-feewallet").value.trim();
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
        box.querySelector("#tk-logoname").textContent = f.name;
      });
    });
    box.querySelector("#tk-quotes").addEventListener("click", function (e) {
      var b = e.target.closest("button[data-q]");
      if (!b || b.disabled) return;
      collect();
      if (b.dataset.q === "rwa") {
        // pick WHICH asset prices the pair — only mints with a signed config
        var r = window.Token.rwaQuotes();
        if (r.length === 1) {
          flow.quote = r[0].mint; flow.quoteSym = r[0].symbol;
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
        flow.quote = t.mint; flow.quoteSym = t.symbol;
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
      <div class="row"><span class="k">Rewards in</span><b>${flow.reward.symbol}</b></div>
      <div class="row"><span class="k">First buy</span><b>${flow.tbuy > 0 ? flow.tbuy + " " + qLabel : "none"}</b></div>
      ${flow.feeWallet ? H`<div class="row"><span class="k">Fees claim to</span><b>${shortAddr(flow.feeWallet)}</b></div>` : ""}
      <div class="row"><span class="k">Metadata storage</span><b id="lp-fee">quoting…</b></div>
      <div class="row"><span class="k">Wallet</span><b>${w ? w.name + " · " + shortAddr(w.publicKey) : "not connected"}</b></div>
      <p class="note">Fee split on every trade: 20% you, 60% platform, 20% Meteora.
      Your share claims straight to any address — including a reward vault.</p>
      <div id="lp-err"></div>
      <div class="acts"><button id="lp-back">Back</button>
      <button class="go" id="lp-go" disabled>${w ? "Launch token" : "Connect a wallet"}</button></div>
    `);
    box.querySelector("#lp-back").onclick = function () { tokenDetails(flow); };

    try {
      var quote = await window.Storage.quoteUpload(300, 2);   // token.json is tiny
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
      var meta = await window.Storage.uploadTokenMeta({
        name: flow.tname,
        symbol: flow.tsym,
        description: flow.tdesc || (flow.nft ? "Paired with " + flow.nft.cfg.name : ""),
        icon: flow.icon || null,
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
        firstBuySol: flow.tbuy,
        rewardMint: flow.reward.mint,
        feeWallet: flow.feeWallet || null,
        collection: flow.nft ? flow.nft.res.collection : null
      });
      mark("pool", "done");

      // Link the records both ways for a pair.
      if (flow.nft) recordCollection(flow.nft.cfg, flow.nft.res, res.mint, flow.nft.up);

      busy = false;
      tokenDone(flow, res);
    } catch (e) {
      busy = false;
      fail(box, e.message || String(e));
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
      <div class="row"><span class="k">Rewards in</span><b>${flow.reward.symbol}</b></div>
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
