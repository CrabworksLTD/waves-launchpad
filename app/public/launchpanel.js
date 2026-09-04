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

  /* NFT+token pairing. The launch mechanics are all live (collection launch,
   * token launch, fee routing), but a pair's fees feed the collection's reward
   * VAULT, and NFT holders CLAIM from it via the staking program — which is
   * devnet-only and unaudited as of 2026-09-02. Until it is deployed to mainnet
   * and audited, launching a pair would strand fees in a vault nobody can claim.
   * So the panel is built and wired behind this flag; flip it the day the
   * program lands. Local testing: set true in the console or here. */
  var PAIRING_LIVE = false;

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
      /* Both buttons, one geometry.
       *
       * Back was rendering taller than Continue and the row was bottom-aligned,
       * so they disagreed on height and only agreed on their bottom edge. The
       * cause is a padding difference inherited from outside this panel, so
       * rather than chase it, the row states the box explicitly: same height,
       * same radius, text centred. Back sets the row's top, so fixing the
       * height leaves the gap above unchanged. */
      ".lp .tip{margin-top:16px;padding:14px 15px;border-radius:10px;",
      "  border:1px solid var(--accent);background:rgba(var(--accent-rgb),.07)}",
      ".lp .tip b{display:block;font:700 13.5px Archivo;margin-bottom:4px}",
      ".lp .tip span{display:block;font-size:12.5px;color:var(--dim);line-height:1.5}",
      ".lp .tip a{display:inline-block;margin-top:10px;font-size:12.5px;font-weight:600;",
      "  color:var(--accent);text-decoration:none}",
      ".lp .acts{display:flex;gap:10px;margin-top:22px;align-items:center}",
      ".lp .acts button{height:46px;padding:0 16px;border-radius:8px;margin:0;",
      "  display:inline-flex;align-items:center;justify-content:center;line-height:1}",
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
      // section header, stays pinned while its group scrolls under it
      ".lp .phead{position:sticky;top:0;z-index:1;background:var(--panel);padding:8px 12px;",
      "  font:600 10px 'IBM Plex Mono',monospace;letter-spacing:.14em;text-transform:uppercase;",
      "  color:var(--faint);border-bottom:1px solid var(--line)}",
      ".lp .phead.tradeable{color:var(--accent)}",
      ".lp .phead.nohead{cursor:pointer;display:flex;justify-content:space-between;align-items:center}",
      ".lp .phead.nohead:hover{color:var(--ink)}",
      ".lp .phead .tw{color:var(--accent);font-size:9px;letter-spacing:.1em}",
      ".lp .prow{display:flex;gap:10px;align-items:baseline;width:100%;text-align:left;",
      "  padding:9px 12px;border:0;border-bottom:1px solid var(--line);border-radius:0;",
      "  background:transparent}",
      ".lp .prow:hover{background:var(--panel2)}",
      ".lp .prow b{flex:none;min-width:74px;font-size:13px}",
      ".lp .prow span{flex:1;color:var(--dim);font-size:12px;white-space:nowrap;",
      "  overflow:hidden;text-overflow:ellipsis}",
      ".lp .prow i{font-style:normal;color:var(--faint);font-size:11px;",
      // an asset with no market yet: readable, not shouted
      ".lp .prow i.dim{color:#ffb84d;opacity:.75}",
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
      ".lp .tiers.three{grid-template-columns:1fr 1fr 1fr}",
      // three modes, one row — a wrapped third option reads as an afterthought
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

  /* Keep the panel where it is between renders.
   *
   * The backdrop centres its card, so every render that changes height moves
   * the whole panel — picking a reward asset swaps a one-line note for a
   * three-line one and the dialog visibly jumps out from under the cursor. The
   * first render centres as before; after that the top edge is pinned and new
   * content grows downward, which is what the eye expects.
   *
   * The pin is clamped so a panel that grows tall cannot be pushed off the top
   * of the screen, and it is dropped on resize and on close so the next open
   * centres normally. */
  function pinTop(top) {
    var card = el.querySelector(".lp");
    if (!card) return;
    var margin = 24;
    var room = window.innerHeight - card.offsetHeight - margin;
    var at = Math.max(margin, Math.min(top, room));
    if (room < margin) { unpin(); return; }   // taller than the viewport: centre/scroll as before
    el.style.alignItems = "start";
    el.style.paddingTop = at + "px";
  }
  function unpin() {
    if (!el) return;
    el.style.alignItems = "";
    el.style.paddingTop = "";
  }
  window.addEventListener("resize", unpin);

  function shell(node) {
    css();
    if (!el) {
      el = document.createElement("div");
      el.className = "lp-back";
      el.addEventListener("click", function (e) { if (e.target === el) close(); });
      document.body.appendChild(el);
    }
    // where the panel sits, and where it is scrolled to, before it is replaced
    var prev = el.querySelector(".lp");
    var top = prev ? prev.getBoundingClientRect().top : null;
    var scrolled = prev ? prev.scrollTop : 0;

    el.innerHTML = '<div class="lp">' + (node.s || node) + "</div>";
    var card = el.querySelector(".lp");
    if (top !== null) pinTop(top);
    /* Keep the scroll where it was.
     *
     * Several controls re-render the whole panel — changing the quote currency
     * rebuilds it — and a fresh innerHTML starts at the top, so clicking a
     * button two thirds of the way down threw the creator back to the name
     * field. The panel looks like it jumped; it was replaced. */
    if (card && scrolled) card.scrollTop = scrolled;
    return card;
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
      /* Empty, not "Untitled collection". That default was a real value that
       * looked like placeholder text, so leaving the field alone put a
       * collection literally named "Untitled collection" on chain and on the
       * explore page — the existing `if (!d.name)` check passed happily,
       * because the string is truthy. A placeholder cannot be submitted. */
      name: P.name || "", symbol: "", desc: "",
      price: 0, maxPer: 0, dev: 0, roy: 5, royTo: "",
      site: "", x: "", tg: "", dc: "",
      openAt: "", splits: [], allowOn: false, phases: [""], wave: 30,
      pairOn: false, tname: "", tsym: "", avatar: null, avatarName: "", banner: null, bannerName: ""
    };

    var box = shell(H`
      <h2>Launch collection</h2>
      <p class="sub">${supply} pieces, generated and ready. Nothing is on chain until you confirm.</p>

      <div class="two">
        <div><label>Name</label><input id="f-name" value="${d.name}" maxlength="28"
          placeholder="Your collection's name"></div>
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

      <!-- A paired token exists to feed this collection's reward vault; the
           collection's NFT holders claim from it on the staking page. The
           launch is independent of the staking program (it only routes fees to
           the vault) — but claiming needs that program live, so the tick is
           held until it ships. See PAIRING_LIVE. -->
      <label class="tick"><input type="checkbox" id="f-pairOn" ${PAIRING_LIVE ? "" : raw("disabled")}>
        <span><b>Pair a token that rewards NFT holders</b>
        <span>${PAIRING_LIVE
          ? "Its trading fees feed a vault your holders claim from staking."
          : "Still in closed testing."}</span></span></label>

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
      // gated on PAIRING_LIVE: the checkbox is disabled until the staking
      // program (the claim side) ships, so this reads false until then
      d.pairOn = PAIRING_LIVE && box.querySelector("#f-pairOn").checked;
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
        // pairs use their own minimal token form, not the full token window
        return pairTokenDetails(flow);
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
        (flow.feeSharePct || 0) >= 100 ? "all to holders"
          : (flow.feeSharePct || 0) > 0 ? flow.feeSharePct + "% to holders"
          : "you keep it all"}</b></div>
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
    /* Status is written beside the step's name, never over it. Replacing the
     * label meant a finished run read "Confirming on chain — 1s" where it
     * should say "Paying for storage", so the list stopped describing what
     * had actually happened. */
    var started = {};
    return function mark(k, state, extra) {
      var li = box.querySelector('[data-k="' + k + '"]');
      if (!li) return;
      if (!started[k]) started[k] = Date.now();
      if (state === "done" && !extra) {
        var secs = Math.round((Date.now() - started[k]) / 1000);
        if (secs >= 2) extra = secs + "s";
      }
      li.className = state;
      li.querySelector("i").textContent = state === "done" ? "✓" : "›";
      var span = li.querySelector("span");
      if (!span.dataset.label) span.dataset.label = span.textContent;
      span.textContent = span.dataset.label + (extra ? " — " + extra : "");
    };
  }

  async function doNftLaunch(cfg, flow) {
    busy = true;
    var stages = [
      ["storage", "Paying for storage"],
      ["images", "Uploading art"],
      ["metadata", "Uploading metadata"],
      ["live", "Waiting for the artwork to go live"],
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
    var waitingOn = "storage";
    window.Launch.onWait = function (msg) { mark(waitingOn, "on", msg); };

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
          if (p.phase === "images") {
            waitingOn = "images";
            mark("images", p.state === "done" ? "done" : "on",
              p.state === "done" ? null : "Uploading to Arweave…");
          }
          if (p.phase === "metadata") {
            waitingOn = "metadata";
            mark("metadata", p.state === "done" ? "done" : "on",
              p.state === "done" ? null : "Uploading to Arweave…");
          }
        },
        payer: async function (q) {
          waitingOn = "storage";
          await assertFreshBuild();
          var held = paidCredit();
          if (held) {
            // paid already on a run that did not finish; the credit is unspent
            mark("storage", "done", "Using the storage payment you already made");
            return held.sig;
          }
          mark("storage", "on", "Approve the payment in your wallet…");
          var sig = await payStorage(q);
          mark("storage", "done");
          return sig;
        }
      });
      forgetPaid();          // the upload redeemed it; a retry must pay afresh

      /* Same reason as the token flow: marketplaces and wallets read a
       * collection's metadata once and cache it, and a fresh Arweave upload is
       * not servable for minutes. Wait before the machine goes on chain. */
      if (up && up.collectionUri) {
        mark("live", "on", "Arweave is still publishing it — this is worth the wait");
        var ok = await waitForUri(up.collectionUri, function (secs) {
          mark("live", "on", "Arweave is still publishing it — " + secs + "s");
        });
        mark("live", "done", ok ? "" : "still publishing — launching anyway");
      }

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
        /* Record it NOW, not after the token. The collection is on chain and
         * paid for the moment this line runs; leaving it unrecorded until the
         * second half succeeds meant a failed token launch made a real,
         * deployed collection invisible to the site. The token records itself
         * and links back when it lands. */
        recordCollection(cfg, res, null, up);
        // configured and confirmed before any of this was signed
        if (flow.preconfig) { doTokenLaunch(flow); return; }
        tokenDetails(flow);
        return;
      }

      window.Launch.onWait = null;
      recordCollection(cfg, res, null, up);
      nftDone(cfg, res, up);
    } catch (e) {
      busy = false;
      window.Launch.onWait = null;
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

      /* Fall back to the collection's own art when no PFP was attached — the
       * same piece #1 the listing avatar already falls back to. The BANNER is
       * left null on purpose: cardmaker washes the avatar across the background
       * when there is no banner, which looks like the collection rather than
       * like a stretched thumbnail. */
      var first = null;
      if (kind === "collection" && !cfg.avatar && run && run.files) {
        var img = (run.files || []).find(function (f) {
          return /\.(png|jpe?g|webp|gif)$/i.test(f.name || "");
        });
        if (img && img.bytes) first = blobUrl(img.bytes);
      }

      return await window.CardMaker.make({
        kind: kind,
        chain: isEvm() ? "robinhood" : "solana",
        name: cfg.name,
        sym: cfg.symbol,
        avatar: blobUrl(cfg.avatar) || first,
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

  /**
   * Record a listing, waiting out a chain that has not caught up yet.
   *
   * The listing endpoints now verify against the chain before accepting
   * anything — a shape check could not tell a launch from a made-up string, and
   * the list is capped, so strings could evict real collections. This runs
   * seconds after the collection was created, so a lagging node legitimately
   * answers "no such collection"; that comes back as a 503 marked retryable and
   * is worth waiting out rather than believing.
   *
   * Still never throws, for the original reason: the collection is already on
   * chain, and a launch must never look failed because a listing endpoint was.
   */
  function postListing(url, payload) {
    var delays = [2000, 5000, 10000, 15000];
    function attempt(i) {
      return fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload)
      }).then(function (r) {
        if (r.ok || r.status !== 503 || i >= delays.length) return;
        return new Promise(function (go) { setTimeout(go, delays[i]); })
          .then(function () { return attempt(i + 1); });
      }).catch(function () {
        if (i >= delays.length) return;
        return new Promise(function (go) { setTimeout(go, delays[i]); })
          .then(function () { return attempt(i + 1); });
      });
    }
    return attempt(0);
  }

  function recordEvmCollection(cfg, res, up) {
    postListing("/api/collections", {
        chain: "robinhood",
        address: res.address,
        name: cfg.name,
        avatar: (up && up.avatarUri) || null,
        card: (up && up.cardUri) || null,
        creator: (window.MoonpadWallet || {}).account || null
    });
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
    postListing("/api/collections", {
        candyMachine: res.candyMachine, collection: res.collection,
        name: cfg.name, cluster: res.cluster, tokenMint: tokenMint || null,
        avatar: (up && up.avatarUri) || null,
        card: (up && up.cardUri) || null,
        creator: (window.Wallet.current() || {}).publicKey || null
    });
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

  /* A paid-for launch that dies must not cost the money twice.
   *
   * The server grants the upload credit against a payment signature and only
   * marks it spent when an upload actually redeems it — so a signature from a
   * launch that failed before uploading is still worth exactly what was paid.
   * Nothing remembered it, though: a frozen window on 2026-08-31 took a
   * payment and orphaned it, and the credit expired unspent an hour later.
   *
   * ⚠️ That hour is the server's rule (api/upload-url rejects payments older
   * than 3600s), so a resume offer must state the time left rather than
   * pretend the credit keeps. */
  /* The code this page loaded, learned once at startup.
   *
   * A tab left open across a deploy keeps running its original JavaScript, and
   * nothing about the page says so. Three launches in a row failed on a bug
   * that was already fixed and deployed, each paying a storage fee before
   * reaching the broken step. Checking costs one request and only ever runs
   * before money moves. */
  var loadedBuild = null;
  fetch("/api/build").then(function (r) { return r.json(); })
    .then(function (j) { loadedBuild = j && j.build; })
    .catch(function () {});

  async function assertFreshBuild() {
    if (!loadedBuild) return;                 // never learned it — do not block
    var live = null;
    try {
      live = (await (await fetch("/api/build", { cache: "no-store" })).json()).build;
    } catch (e) { return; }                   // offline is not a stale tab
    if (live && live !== loadedBuild) {
      throw new Error("This page was loaded before the site updated, and would " +
        "run the old code. Reload and launch again — nothing has been charged.");
    }
  }

  var PAID_KEY = "waves.paidStorage";
  var PAID_TTL = 55 * 60 * 1000;        // just inside the server's hour

  function rememberPaid(sig, q) {
    try {
      localStorage.setItem(PAID_KEY, JSON.stringify({
        sig: sig, at: Date.now(),
        lamports: String(q && q.feeLamports || ""), chain: "solana"
      }));
    } catch (e) {}
    return sig;
  }
  function paidCredit() {
    try {
      var v = JSON.parse(localStorage.getItem(PAID_KEY) || "null");
      if (!v || !v.sig) return null;
      if (Date.now() - v.at > PAID_TTL) { forgetPaid(); return null; }
      v.minutesLeft = Math.max(0, Math.round((PAID_TTL - (Date.now() - v.at)) / 60000));
      return v;
    } catch (e) { return null; }
  }
  function forgetPaid() { try { localStorage.removeItem(PAID_KEY); } catch (e) {} }

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
    var rpcUrl = window.Launch.clusters[window.Launch.cluster()].rpc;
    var umi = mx.createUmi(rpcUrl, "confirmed")
      .use(mx.walletAdapterIdentity(window.Launch.asAdapter(mx, w)));
    // ask the chain whether the payment landed instead of trusting a websocket
    // that reported three successful payments as expired
    window.Launch.usePolledConfirm(mx, umi, rpcUrl);

    /* A blockhash lives about a minute. Between building the transfer and the
     * wallet prompt being approved — plus a public RPC that may be a few
     * slots behind — that window can close, and the send comes back "block
     * height exceeded".
     *
     * Retrying is right, but retrying blind would charge twice. An expiry
     * error is not proof the payment failed: the transaction may have landed
     * while confirmation timed out. So on failure we ask the chain about that
     * exact signature first, and only rebuild when it genuinely is not there. */
    var conn = new mx.Connection(window.Launch.clusters[window.Launch.cluster()].rpc, "confirmed");

    /* Give the chain a few seconds to admit it has the transaction before
     * concluding it does not. Asking once, immediately, is what let a retry
     * send a second payment three seconds after the first — both landed. */
    async function landed(sig) {
      for (var i = 0; i < 8; i++) {
        try {
          var st = await conn.getSignatureStatus(sig, { searchTransactionHistory: true });
          var v = st && st.value;
          if (v && v.err) return false;
          if (v && (v.confirmationStatus === "confirmed" ||
                    v.confirmationStatus === "finalized")) return true;
        } catch (e) {}
        await new Promise(function (r) { setTimeout(r, 1500); });
      }
      return false;
    }

    /* Prefer signAndSendTransaction: the wallet simulates and broadcasts it
     * itself, rather than handing signed bytes back to this page to send
     * wherever it likes. That second shape is what a drainer relies on and it
     * is a signal wallet scanners weigh — and this transfer, a bare payment to
     * an unfamiliar address moments after connecting, is already the most
     * drainer-shaped thing WAVES asks anyone to do. Phantom blocks the domain
     * outright today; this removes one reason to.
     *
     * Falls back to the umi path for wallets without the feature. */
    var w2 = window.Wallet.current();
    if (w2 && w2.canSignAndSend) {
      /* Built through umi, not web3 primitives: the vendor bundle exports
       * Transaction, Connection and PublicKey but NOT SystemProgram, so
       * composing the transfer by hand threw "cannot read properties of
       * undefined (reading 'transfer')" on the first step of a launch.
       * transferSol is exported and is the same instruction. */
      var conn2 = new mx.Connection(rpcUrl, "confirmed");
      var bh2 = await umi.rpc.getLatestBlockhash();
      var built2 = mx.transferSol(umi, {
        destination: mx.publicKey(q.feeTo),
        amount: mx.lamports(BigInt(q.feeLamports))
      }).setBlockhash(bh2).build(umi);
      var sig2 = await w2.signAndSendTransaction(umi.transactions.serialize(built2));
      // the wallet has broadcast it; wait for the chain to agree
      for (var t2 = 0; t2 < 90; t2++) {
        var st2 = await conn2.getSignatureStatus(sig2, { searchTransactionHistory: true })
          .catch(function () { return null; });
        var v2 = st2 && st2.value;
        if (v2 && v2.err) throw new Error("The storage payment failed on chain.");
        if (v2 && (v2.confirmationStatus === "confirmed" ||
                   v2.confirmationStatus === "finalized")) return rememberPaid(sig2, q);
        await new Promise(function (r) { setTimeout(r, 1000); });
      }
      throw new Error("The storage payment did not confirm in 90s. Nothing further " +
        "was charged — its signature was " + sig2);
    }

    for (var attempt = 0; attempt < 2; attempt++) {
      try {
        var res = await mx.transferSol(umi, {
          destination: mx.publicKey(q.feeTo),
          amount: mx.lamports(BigInt(q.feeLamports))
        }).sendAndConfirm(umi, { confirm: { commitment: "confirmed" } });
        return rememberPaid(mx.base58.deserialize(res.signature)[0], q);
      } catch (e) {
        var msg = String((e && e.message) || e);
        // the signature is in the error text when a send times out
        var found = msg.match(/[1-9A-HJ-NP-Za-km-z]{80,90}/);
        if (found && await landed(found[0])) return rememberPaid(found[0], q);
        var expired = /expired|block height exceeded|timed? ?out/i.test(msg);
        if (attempt === 0 && expired) continue;   // fresh blockhash, one more go
        throw e;
      }
    }
    throw new Error("The storage payment could not be confirmed — nothing was charged twice; try again.");
  }

  /* Poll a freshly uploaded URI until the gateway serves it.
   *
   * Capped, because a launch cannot hang forever — if it is still not up we
   * proceed and say so, since the alternative is stranding a paid-for launch.
   * no-cors is not usable here (an opaque response hides the status), so this
   * relies on the gateway's CORS headers, which arweave.net sends. */
  async function waitForUri(uri, onTick) {
    if (!uri) return false;

    /* Ask every gateway that could have it, not just the slowest one.
     *
     * arweave.net will not serve an upload until the bundle is posted and
     * indexed — twenty minutes and counting on $MOAR, which is far too long to
     * hold a launch. But Turbo's receipt lists gateways that hold the data
     * immediately, and any of them answering means the upload is real and
     * propagating rather than lost.
     *
     * That is the thing actually worth waiting for. The on-chain URI still
     * points at arweave.net, which is the address that outlives us, and our own
     * pages read through the mirror in the meantime — so proceeding once the
     * data is provably published costs nothing and saves minutes. */
    var urls = [uri];
    try {
      var fast = window.__turboFast;
      if (fast && fast.hosts && fast.hosts.length) {
        var path = uri.replace(/^https:\/\/arweave\.net/, "");
        fast.hosts.slice(0, 4).forEach(function (h) {
          var host = /^https?:/.test(h) ? h : "https://" + h;
          urls.push(host.replace(/\/$/, "") + path);
        });
      }
    } catch (e) {}

    var started = Date.now();
    var LIMIT = 90000;                       // ninety seconds, not four minutes
    while (Date.now() - started < LIMIT) {
      var hit = await Promise.all(urls.map(function (u) {
        return fetch(u, { cache: "no-store" }).then(function (r) { return r.ok; })
          .catch(function () { return false; });
      }));
      if (hit.some(Boolean)) return true;
      if (onTick) onTick(Math.round((Date.now() - started) / 1000));
      await new Promise(function (res) { setTimeout(res, 2500); });
    }
    return false;
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
  /* The reward asset offers the whole catalogue with its status on each row.
   * 354 of the 448 verified assets have no market while still quoting a price;
   * hiding them would cut the creative surface that makes tokenised stocks
   * worth having, and offering them silently would pay holders something
   * unsellable. So each row says which it is, and the keeper pays the quote
   * currency until an asset can actually be sold. */
  /* Each rung is a config that already exists on chain, so choosing one costs
   * nothing extra at launch. A rung with no config for the selected quote is
   * not offered — silently creating one mid-launch is what turned a launch into
   * two signatures and a failure point. */
  /* A cap at the point of choosing, so nothing downstream has to cope.
   *
   * There was none, so a 20MB PNG was accepted and then met three limits that
   * did not agree with each other: the free-upload allowance, the mirror's
   * size cap, and Arweave pricing. The launch either cost more than expected
   * or lost its mirror copy, and neither said so. Refusing here is one clear
   * sentence before anything is paid for.
   *
   * 2MB is generous for a token logo or banner — the largest real launch art so
   * far was 1.1MB — and leaves room under the mirror's 3MB ceiling. */
  var MAX_ART_BYTES = 2 * 1024 * 1024;

  function takeArt(file, box, onOk) {
    if (!file) return;
    if (file.size > MAX_ART_BYTES) {
      var e = box.querySelector("#lp-err");
      if (e) {
        e.textContent = '"' + file.name + '" is ' +
          (file.size / 1048576).toFixed(1) + "MB. Images must be under 2MB — " +
          "resize it and try again.";
        e.className = "err";
      }
      return;
    }
    var e2 = box.querySelector("#lp-err");
    if (e2) { e2.textContent = ""; e2.className = ""; }
    file.arrayBuffer().then(function (buf) { onOk(new Uint8Array(buf)); });
  }

  /* ETH spot and the live curve terms, each fetched once per panel session.
   * The terms come from the DEPLOYED contract rather than constants — they are
   * immutable there, so the contract is the only honest source. */
  var ethUsdP = null;
  function ethUsd() {
    if (!ethUsdP) {
      ethUsdP = fetch("https://api.coinbase.com/v2/prices/ETH-USD/spot")
        .then(function (r) { return r.json(); })
        .then(function (j) { return Number(j.data.amount) || null; })
        .catch(function () { return null; });
    }
    return ethUsdP;
  }

  var evmTermsP = null;
  function evmTerms() {
    if (!evmTermsP) {
      evmTermsP = (window.MoonpadToken ? Promise.resolve() : window.Shell.ensureEvmLaunch())
        .then(function () { return window.MoonpadToken.terms(); })
        .catch(function () { return null; });
    }
    return evmTermsP;
  }

  /* What a dev buy actually gets you, in tokens, share of supply and dollars.
   *
   * Priced with the curve's own arithmetic against its virtual reserves — the
   * same formula the contract runs — and net of the rung's trading fee, which
   * the creator pays on their own first buy like anybody else. There is no
   * token yet to call quoteBuy against, so this is computed rather than read.
   */
  var evmBuySeq = 0;
  function paintEvmBuyShare(el, amt, flow) {
    var seq = ++evmBuySeq;
    var bps = tierSpec(flow).baseFeeBps || 100;
    el.textContent = "…";
    Promise.all([evmTerms(), ethUsd()]).then(function (r) {
      if (seq !== evmBuySeq) return;          // a newer keystroke won
      var t = r[0], px = r[1];
      if (!t) { el.textContent = ""; return; }
      var ve = Number(t.virtualEth) / 1e18;
      var vt = Number(t.virtualTokens) / 1e18;
      var cs = Number(t.curveSupply) / 1e18;
      var inAfterFee = amt * (1 - bps / 10000);
      var out = vt - (ve * vt) / (ve + inAfterFee);
      if (out > cs) out = cs;
      var pct = (out / cs) * 100;
      el.innerHTML =
        (px ? "<b>$" + UI.fmt(amt * px, 2) + "</b> — that buys you about " : "That buys you about ") +
        "<b>" + UI.fmt(out, 0) + " tokens</b>, " + pct.toFixed(2) + "% of supply" +
        (pct >= 10 ? ". <b>Buyers will read that as a large insider position.</b>" : ".");
    });
  }

  /* Reward assets on Robinhood Chain — the tokenised equities and USDG a
   * creator can have their holders paid in.
   *
   * Generated by tools/fetch-rh-assets.js and chain-verified there, for the
   * same reason rwa.json is: a ticker is not an identity. Two different
   * contracts on this chain both called themselves MSTR. */
  var rhAssetsP = null;
  function loadRhAssets() {
    if (!rhAssetsP) {
      rhAssetsP = fetch("/rh-assets.json")
        .then(function (r) { return r.json(); })
        .then(function (j) { return j.tokens || []; })
        .catch(function () { return []; });
    }
    return rhAssetsP;
  }

  function tierSpec(flow) {
    var T = window.DBC_TERMS;
    return (T && T.TIERS && T.TIERS[flow.tier || "standard"]) ||
           { label: "Standard", pct: 1, baseFeeBps: 100 };
  }
  function tierPct(flow) { return tierSpec(flow).pct; }

  function tierRungs(flow) {
    var T = window.DBC_TERMS;
    if (!T || !T.LADDER) return [];
    var out = [];
    for (var i = 0; i < T.LADDER.length; i++) {
      var name = T.LADDER[i], spec = T.TIERS[name];
      if (!spec) continue;
      /* On Solana a rung only exists if we signed a DBC config for it, so the
       * list is what has actually been created. On Robinhood the contract
       * enforces the ladder itself — platformVolumeBps accepts exactly these
       * six rungs and reverts on anything else — so there is nothing to look
       * up, and asking Solana whether "eth" has a config threw for every rung
       * and left the launch window with NO tax picker at all. */
      var ready = true;
      if (isEvm()) {
        ready = EVM_PLATFORM_BPS[spec.baseFeeBps] !== undefined;
      } else {
        try { window.Token.configFor(flow.quote, name); } catch (e) { ready = false; }
      }
      if (ready) out.push({ name: name, spec: spec });
    }
    return out;
  }

  function tierButtons(flow) {
    var rungs = tierRungs(flow);
    if (!rungs.length) return "";
    var cur = flow.tier || "standard";
    // a rung that vanished with the quote must not stay selected
    if (!rungs.some(function (r) { return r.name === cur; })) {
      cur = rungs[0].name;
      flow.tier = cur;
    }
    /* The tax IS the trading fee, so the buttons are the fee itself — "None"
     * being the 1.2% floor every launch pays. Naming them after the number a
     * trader sees keeps the label honest: a 3% tax means traders pay 3%. */
    return rungs.map(function (r) {
      return '<button data-t="' + r.name + '"' + (r.name === cur ? ' class="on"' : "") + ">" +
        r.spec.pct + "%" + "</button>";
    }).join("");
  }


  /* The paired token's OWN launch form — not the full token window.
   *
   * A pair exists for one reason: to feed its collection's reward vault, which
   * the collection's NFT holders claim from on the staking page. So the creator
   * decides only what a pair needs — logo, banner, name, ticker, the trading
   * fee, and their own first buy. There is no quote picker (a pair prices in
   * SOL), no split slider and no reward-asset picker: 100% of the creator fee
   * routes to the vault, full stop. Everything the standard token window asks
   * that a pair does not need is simply absent, by design.
   *
   * Reached only from the pair tick, which is gated on PAIRING_LIVE, and always
   * in the preconfig order: this form is filled first, then the collection
   * launches, then the token pairs to it. */
  function pairTokenDetails(flow) {
    flow = flow || {};
    var nft = flow.nft;
    var defName = flow.preTname || (nft ? nft.cfg.name : "");
    var defSym = flow.preTsym ||
      (defName ? defName.replace(/[^A-Za-z]/g, "").slice(0, 5).toUpperCase() : "");

    flow.quote = "sol";                    // pairs price in SOL
    if (!flow.tier) flow.tier = "standard";
    /* The whole creator share feeds the collection's vault; NFT holders claim
     * it from the staking program. This is a RECORDED PREFERENCE, not launch-
     * time routing: the pool launches clean with the launcher as poolCreator,
     * and the creator role is handed to the staking pool PDA AFTER deploy, from
     * a claim-page step — the same post-launch activation the standard token now
     * uses. Doing it inside the launch tx puts an unknown signer (the vault/PDA)
     * into the pool creation, which is exactly the drainer shape Phantom blocked
     * — moving reward routing to after deploy is what CLEARED that block
     * (2026-09-03). Piece 3 (token.js) must follow the same post-deploy model. */
    flow.feeShare = "vault";
    flow.feeSharePct = 100;
    flow.rewardMode = "dividend";
    // what the NFT holders are paid in — SOL by default, changed via the picker
    /* Default to the chain's own unit of account: SOL on Solana, USDG here.
     * BUILTIN_REWARDS[0] is SOL, which does not exist on Robinhood. */
    flow.reward = flow.reward || (isEvm()
      ? { mint: "0x0000000000000000000000000000000000000000",
          symbol: "ETH", name: "Ether" }
      : BUILTIN_REWARDS[0]);

    var box = shell(H`
      <h2>2 of 2 — the token</h2>
      <p class="sub">Paired with ${nft ? nft.cfg.name : "your collection"}. Its trading fees
      feed the collection's reward vault, which its NFT holders claim from staking.</p>

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
        <div><label>Ticker</label>
        <input id="lp-tsym" value="${flow.tsym || defSym}" maxlength="8" placeholder="TKN"
          style="text-transform:uppercase"></div>
      </div>

      <label>Trading fee</label>
      <div class="ptabs" id="tk-tiers">${raw(tierButtons(flow))}</div>
      <p class="note" id="tk-taxtxt"></p>

      <label>Your first buy (${isEvm() ? "ETH" : "SOL"}) — optional</label>
      <input id="lp-tbuy" type="number" min="0" step="${isEvm() ? "0.005" : "0.1"}" value="${flow.tbuy || 0}">
      <p class="note" id="tk-buyshare"></p>
      <p class="note">Lands in the same transaction as the pool, so nobody can snipe
      the opening price ahead of you.</p>

      <label>Rewards paid in</label>
      <button class="pick" id="lp-reward">
        <span><b>${flow.reward.symbol}</b> &nbsp;<span class="k2">${flow.reward.name}</span></span>
        <span class="pk-r"><span class="k2 mono">${
          flow.reward.liquidity === undefined || flow.reward.liquidity >= 1000
            ? "tradeable" : "not tradeable yet"}</span>
        <span class="pk-dd">Change ▾</span></span>
      </button>
      <p class="note">What your NFT holders claim — SOL, USDC, or a tokenized stock or
      commodity.${flow.reward.liquidity !== undefined && flow.reward.liquidity < 1000
        ? raw(" <b>Nothing trades " + esc(flow.reward.symbol) + " yet</b>, so holders " +
              "receive SOL until it can be sold — it switches by itself once a market exists.")
        : ""}</p>

      <div id="lp-err"></div>
      <div class="acts"><button id="lp-x">Back</button>
      <button class="go" id="lp-next">Continue</button></div>
    `);

    function collect() {
      flow.tname = box.querySelector("#lp-tname").value;
      flow.tsym = box.querySelector("#lp-tsym").value;
      flow.tbuy = box.querySelector("#lp-tbuy").value;
    }

    box.querySelector("#tk-logobtn").onclick = function () { box.querySelector("#tk-logo").click(); };
    box.querySelector("#tk-logo").addEventListener("change", function (e) {
      var f = e.target.files && e.target.files[0];
      takeArt(f, box, function (bytes) {
        flow.icon = bytes; flow.iconName = f.name;
        flow.iconExt = /\.jpe?g$/i.test(f.name) ? "jpg" : "png";
        var lb = box.querySelector("#tk-logobtn");
        lb.textContent = "✓ " + f.name; lb.classList.add("has");
      });
    });
    box.querySelector("#tk-bannerbtn").onclick = function () { box.querySelector("#tk-banner").click(); };
    box.querySelector("#tk-banner").addEventListener("change", function () {
      var f = box.querySelector("#tk-banner").files[0];
      takeArt(f, box, function (bytes) {
        flow.banner = bytes; flow.bannerName = f.name;
        flow.bannerExt = /\.jpe?g$/i.test(f.name) ? "jpg" : "png";
        var bb = box.querySelector("#tk-bannerbtn");
        bb.textContent = "✓ " + f.name; bb.classList.add("has");
      });
    });

    function paintTax() {
      var el = box.querySelector("#tk-taxtxt");
      if (el) el.textContent = "Traders pay " + tierPct(flow) + "% in total.";
    }
    paintTax();
    box.querySelector("#tk-tiers").addEventListener("click", function (e) {
      var b = e.target.closest("button[data-t]");
      if (!b || b.disabled) return;
      flow.tier = b.dataset.t;
      box.querySelectorAll("#tk-tiers button").forEach(function (x) { x.classList.toggle("on", x === b); });
      paintTax();
    });

    function paintBuyShare() {
      var el = box.querySelector("#tk-buyshare");
      if (!el) return;
      var amt = parseFloat(box.querySelector("#lp-tbuy").value) || 0;
      if (isEvm()) {
        if (!amt) { el.textContent = ""; return; }
        return paintEvmBuyShare(el, amt, flow);
      }
      var terms = window.DBC_TERMS;
      var q = terms && terms.QUOTES && terms.QUOTES[flow.quote];
      var cap = q && q.initialMarketCap;
      if (!amt || !cap) { el.textContent = ""; return; }
      var supply = (terms.TERMS && terms.TERMS.totalTokenSupply) || 1e9;
      var pct = Math.min(100, (amt / cap) * 100);
      el.innerHTML = "That buys you roughly <b>" + pct.toFixed(2) + "% of supply</b> — about " +
        UI.fmt(supply * pct / 100, 0) + " tokens" +
        (pct >= 10 ? " <b>— buyers will read that as a large insider position.</b>" : ".");
    }
    paintBuyShare();
    box.querySelector("#lp-tbuy").addEventListener("input", paintBuyShare);
    // the suggested-amount chips are gone; the field is typed into directly
    var chipRow = box.querySelector("#tk-chips");
    if (chipRow) chipRow.addEventListener("click", function (e) {
      var b = e.target.closest("button[data-v]");
      if (b) box.querySelector("#lp-tbuy").value = b.dataset.v;
      setTimeout(paintBuyShare, 0);        // after the chip writes the value
    });

    // the reward choice is recorded with the launch; it reopens this same form
    var rewardBtn = box.querySelector("#lp-reward");
    if (rewardBtn) rewardBtn.onclick = function () {
      collect();
      (isEvm() ? rhRewardPicker : rewardPicker)(flow);
    };

    box.querySelector("#lp-x").onclick = function () {
      // back to the collection form; flow.d still holds what they entered there
      collect();
      nftDetails(flow);
    };
    box.querySelector("#lp-next").onclick = function () {
      collect();
      var name = (flow.tname || "").trim();
      var sym = (flow.tsym || "").trim().toUpperCase();
      if (!name) return fail(box, "The token needs a name.");
      if (!/^[A-Z0-9]{2,8}$/.test(sym)) return fail(box, "Ticker: 2-8 letters or digits.");
      flow.tname = name; flow.tsym = sym;
      flow.tbuy = parseFloat(flow.tbuy) || 0;
      // preconfig: the collection launches first, then the token pairs to it
      return nftConfirm(flow.cfg, flow);
    };
  }

  function tokenDetails(flow) {
    flow = flow || {};
    var nft = flow.nft;
    // what they typed beside the pair tick comes through as the default here,
    // so the token step opens already carrying their answer
    var defName = flow.preTname || (nft ? nft.cfg.name : "");
    var defSym = flow.preTsym ||
      (defName ? defName.replace(/[^A-Za-z]/g, "").slice(0, 5).toUpperCase() : "");
    /* Default to the chain's own unit of account: SOL on Solana, USDG here.
     * BUILTIN_REWARDS[0] is SOL, which does not exist on Robinhood. */
    flow.reward = flow.reward || (isEvm()
      ? { mint: "0x0000000000000000000000000000000000000000",
          symbol: "ETH", name: "Ether" }
      : BUILTIN_REWARDS[0]);
    /* Robinhood Chain prices in ETH and nothing else — the curve takes the
     * chain's native coin, there is no USDC config and no RWA quote. */
    flow.quote = isEvm() ? "eth" : (flow.quote || "sol");
    /* Standard, keeping the fees — the least surprising thing a launch can be,
     * and the state the panel opens in. Sharing is a decision the creator
     * makes, not one they have to notice and undo. */
    if (!flow.tier) flow.tier = "standard";
    /* Rewards are switched on after launch, from the claim page. A launch that
     * named our keeper as the pool's creator put an unknown third signer into
     * the transaction, which is what Phantom blocked as a possible drainer —
     * isolated 2026-09-02 across four launches. */
    flow.feeSharePct = 0;
    flow.feeShare = "keep";
    var quotes = window.Token.quotes();
    var rwas = window.Token.rwaQuotes();
    var qLabel = isEvm() ? "ETH"
      : flow.quote === "usdc" ? "USDC"
      : flow.quote === "sol" ? "SOL"
      : (flow.quoteSym || "RWA");

    var box = shell(H`
      <h2>${nft ? "2 of 2 — the token" : "Launch token"}</h2>
      <p class="sub">${nft
        ? "Paired with " + nft.cfg.name + ". Its trading fees reward the collection's holders."
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
      <textarea id="tk-desc" rows="2" placeholder="${isEvm()
        ? "Shown on your token page and explorers" : "Shown on Jupiter and explorers"}">${flow.tdesc || ""}</textarea>

      ${isEvm() ? "" : H`<label>Priced in</label>
      <div class="ptabs" id="tk-quotes">
        <button data-q="sol" ${flow.quote === "sol" ? raw('class="on"') : ""}
          ${quotes.indexOf("sol") < 0 ? raw("disabled") : ""}>SOL</button>
        <button data-q="usdc" ${flow.quote === "usdc" ? raw('class="on"') : ""}
          ${quotes.indexOf("usdc") < 0 ? raw("disabled") : ""}>USDC</button>
      </div>`}

      <div class="fold2" id="tk-econ">
        <div class="row"><span class="k">Trading fee</span><b id="tk-fee">${tierPct(flow) + "%"}</b></div>
        <div class="row"><span class="k">Graduates at</span><b id="tk-grad">reading the curve…</b></div>
        <div class="row" style="border-bottom:0"><span class="k">Migrates to</span><b>${
          isEvm() ? "Uniswap V3, liquidity locked" : "Meteora DAMM v2, LP locked"}</b></div>
        <p class="note" style="margin-top:6px">${isEvm()
          ? "Set when the curve contract was deployed and immutable since — identical for every launch, so nobody negotiates a better curve than you."
          : "Locked in the launchpad's config — identical for every launch, so nobody negotiates a better curve than you."}</p>
      </div>

      <label>Your first buy (${qLabel}) — optional</label>
      <input id="lp-tbuy" type="number" min="0" step="${isEvm() ? "0.005" : "0.1"}" value="${flow.tbuy || 0}">
      <p class="note" id="tk-buyshare"></p>
      <p class="note">Lands in the same transaction as the pool, so nobody can snipe
      the opening price ahead of you.</p>

      <label>Creator tax</label>
      <div class="ptabs" id="tk-tiers">${raw(tierButtons(flow))}</div>
      <p class="note" id="tk-taxtxt"></p>


      <!-- Two ways the pledged share can work. Like the asset below, this is
           recorded with the launch and takes effect when rewards are switched
           on from the fee page — no routing happens here. -->
      <label>Holder rewards</label>
      <div class="tiers three" id="tk-modes">
        <button data-m="none" class="tier ${(flow.rewardMode || "none") === "none" ? "on" : ""}">
          <b>Normal</b><span>You keep all of your trading fees. No holder
          rewards.</span></button>
        <button data-m="dividend" class="tier ${flow.rewardMode === "dividend" ? "on" : ""}">
          <b>Dividend</b><span>Paid out to holders automatically based on their
          holdings.</span></button>
        <button data-m="burn" class="tier ${flow.rewardMode === "burn" ? "on" : ""}">
          <b>Buyback &amp; burn</b><span>Buys the token off the market and burns it,
          causing supply to fall.</span></button>
      </div>

      <!-- What holders would be paid in. A preference recorded with the
           launch, not a routing instruction: nothing reaches holders until the
           creator activates rewards on the fee page, which is a separate
           signature. Keeping the choice here means they make it while thinking
           about their token, not weeks later in a different screen. -->
      <div id="tk-rewardwrap" ${(flow.rewardMode || "none") !== "dividend" ? raw("hidden") : ""}>
        <label>Holders are paid in</label>
        <button class="pick" id="lp-reward">
          <span><b>${flow.reward.symbol}</b> &nbsp;<span class="k2">${flow.reward.name}</span></span>
          <span class="pk-r"><span class="k2 mono">${
            flow.reward.liquidity === undefined || flow.reward.liquidity >= 1000
              ? "tradeable" : "not tradeable yet"}</span>
          <span class="pk-dd">Change ▾</span></span>
        </button>
        <p class="note">Saved with your launch. Rewards start once you switch
        them on from the fee page.${flow.reward.liquidity !== undefined && flow.reward.liquidity < 1000
          ? raw(" <b>Nothing trades " + esc(flow.reward.symbol) + " yet</b>, so holders " +
                "would receive " + esc(qLabel) + " until it can be sold — it switches " +
                "by itself once a market exists.")
          : ""}</p>
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
      ${window.Token.configKey() ? "" : raw(
        '<p class="err">Token launches are not configured on this deployment yet — ' +
        "the form is a preview and the launch button is disabled.</p>")}
      <div id="lp-err"></div>
      <div class="acts"><button id="lp-x">${nft ? "Skip token" : "Back"}</button>
      <button class="go" id="lp-next" ${window.Token.configKey() ? "" : raw("disabled")}>Continue</button></div>
    `);

    /* Live economics, read from the config this launch will actually use — not
     * hardcoded copy, and not the standard rung's numbers shown against a rung
     * the creator picked instead. Re-read when the rung changes. */
    function paintEconomics() {
      if (isEvm()) return paintEvmEconomics();
      window.Token.describeConfig(flow.quote, flow.tier || "standard").then(function (d) {
        var el = box.querySelector("#tk-grad");
        if (!el) return;
        if (!d) { el.textContent = "shown at launch"; return; }
        el.textContent = UI.fmt(d.graduation) + " " + qLabel + " raised";
        if (d.feePct) box.querySelector("#tk-fee").textContent =
          d.feePct + "% — " + Math.round(80 * d.creatorShare / 100) + "% you / " +
          Math.round(80 * (100 - d.creatorShare) / 100) + "% platform / 20% Meteora";
      });
    }
    /* Read from the contract, not from constants.
     *
     * The curve's parameters are constructor arguments and immutable, so the
     * only truthful source for "graduates at" is the deployment itself — a page
     * quoting last month's numbers at a curve deployed with different ones is
     * worse than a page that says it does not know. */
    function paintEvmEconomics() {
      var grad = box.querySelector("#tk-grad");
      var feeEl = box.querySelector("#tk-fee");
      var sp = evmSplit(flow);
      if (feeEl && sp) {
        feeEl.textContent = sp.total + "% — " + sp.creator + "% you / " + sp.platform + "% platform";
      }
      if (!grad) return;
      if (!window.MoonpadToken || !window.MoonpadToken.curveAddress()) {
        grad.textContent = "not open on this chain yet";
        return;
      }
      window.MoonpadToken.terms().then(function (t) {
        grad.textContent = UI.fmt(Number(t.graduationEth) / 1e18) + " ETH raised";
      }).catch(function () { grad.textContent = "shown at launch"; });
    }

    paintEconomics();

    function collect() {
      flow.tname = box.querySelector("#lp-tname").value;
      flow.tsym = box.querySelector("#lp-tsym").value;
      flow.tbuy = box.querySelector("#lp-tbuy").value;
      flow.tdesc = box.querySelector("#tk-desc").value;
      var fw = box.querySelector("#tk-feewallet");
      flow.feeWallet = fw ? fw.value.trim() : (flow.feeWallet || "");
      flow.web = box.querySelector("#tk-web").value.trim();
      flow.x = box.querySelector("#tk-x").value.trim();
      /* Telegram and Discord were dropped from the form. Read defensively so a
       * flow that still carries them (a launch resumed from an older tab) is
       * not clobbered, and so this cannot throw on a field that is gone. */
      var tg = box.querySelector("#tk-tg"), dc = box.querySelector("#tk-dc");
      if (tg) flow.tg = tg.value.trim();
      if (dc) flow.dc = dc.value.trim();
    }

    box.querySelector("#tk-logobtn").onclick = function () { box.querySelector("#tk-logo").click(); };
    box.querySelector("#tk-logo").addEventListener("change", function (e) {
      var f = e.target.files && e.target.files[0];
      takeArt(f, box, function (bytes) {
        flow.icon = bytes;
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
      takeArt(f, box, function (bytes) {
        flow.banner = bytes;
        flow.bannerName = f.name;
        flow.bannerExt = /\.jpe?g$/i.test(f.name) ? "jpg" : "png";
        var bb = box.querySelector("#tk-bannerbtn");
        bb.textContent = "✓ " + f.name; bb.classList.add("has");
      });
    });
    var SHARE_STOPS = [0, 10, 25, 50, 75, 90, 100];
    /* A tax token pledges the creator's entire share to holders — there is no
     * slider, and flow.feeSharePct is not a choice.
     *
     * A creator who wants to keep their fees launches on the standard rung and
     * keeps all of them; one who wants a reward token gives all of it. The
     * in-between was a dial nobody could interpret: "90% of your share" reads
     * as 90% of every trade, and the honest figure took three lines to explain. */
    /* What the first buy actually gets you.
     *
     * "1 SOL" tells a launcher nothing about the position they are taking. The
     * curve starts at a known market cap, so the share is simply the amount
     * over that cap — 1 SOL into a 28 SOL curve is ~3.5% of supply. Slightly
     * generous, because the buy walks the price up as it fills, and marked
     * approximate for that reason. It matters because this is the one number
     * that decides whether a launch looks fair or looks like a rug. */
    function paintBuyShare() {
      var el = box.querySelector("#tk-buyshare");
      if (!el) return;
      var amt = parseFloat(box.querySelector("#lp-tbuy").value) || 0;
      if (isEvm()) {
        if (!amt) { el.textContent = ""; return; }
        return paintEvmBuyShare(el, amt, flow);
      }
      var terms = window.DBC_TERMS;
      var q = terms && terms.QUOTES && terms.QUOTES[flow.quote];
      var cap = q && q.initialMarketCap;
      if (!amt || !cap) { el.textContent = ""; return; }
      var supply = (terms.TERMS && terms.TERMS.totalTokenSupply) || 1e9;
      var pct = Math.min(100, (amt / cap) * 100);
      el.innerHTML = "That buys you roughly <b>" + pct.toFixed(2) + "% of supply</b> — " +
        "about " + UI.fmt(supply * pct / 100, 0) + " tokens" +
        (pct >= 10 ? " <b>— buyers will read that as a large insider position.</b>" : ".");
    }
    paintBuyShare();
    box.querySelector("#lp-tbuy").addEventListener("input", paintBuyShare);
    // the suggested-amount chips are gone; the field is typed into directly
    var chipRow = box.querySelector("#tk-chips");
    if (chipRow) chipRow.addEventListener("click", function () {
      setTimeout(paintBuyShare, 0);      // after the chip has written the value
    });

    box.querySelector("#tk-tiers").addEventListener("click", function (e) {
      var b = e.target.closest("button[data-t]");
      if (!b || b.disabled) return;
      // toggle IN PLACE — a full re-render scrolls the window back to the
      // top, which reads as a jump
      flow.tier = b.dataset.t;
      // these are plain buttons now, not the old two-column cards
      box.querySelectorAll("#tk-tiers button").forEach(function (x) {
        x.classList.toggle("on", x === b);
      });

      /* The rung sets the size of the pot, not who gets it — the split below
       * is the only thing that decides that, and it survives a rung change. */
      paintTax();
      paintEconomics();          // each rung has its own curve, not just its own fee
    });
    /* What a trader pays, and only that. Where it goes is documentation — the
     * creator is choosing a headline number here, not auditing a split. */
    function paintTax() {
      var el = box.querySelector("#tk-taxtxt");
      if (el) el.textContent = "Traders pay " + tierPct(flow) + "% in total.";
    }




    paintTax();



    /* Absent on Robinhood Chain — there is one quote currency, so the picker is
     * not rendered. Binding to it unconditionally threw a TypeError and took
     * the whole details screen down with it. */
    var quoteTabs = box.querySelector("#tk-quotes");
    if (quoteTabs) quoteTabs.addEventListener("click", function (e) {
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
      /* Re-render, deliberately. The currency changes labels captured at
       * render time — "your first buy (SOL)", the graduation figure, the
       * reward note — so repainting piecemeal leaves at least one of them
       * lying. shell() preserves the scroll position, so this no longer
       * throws the creator back to the top. */
      flow.quote = b.dataset.q;
      tokenDetails(flow);
    });
    // the suggested-amount chips are gone; the field is typed into directly
    var chipRow = box.querySelector("#tk-chips");
    if (chipRow) chipRow.addEventListener("click", function (e) {
      var b = e.target.closest("button[data-v]");
      if (b) box.querySelector("#lp-tbuy").value = b.dataset.v;
    });
    box.querySelector("#lp-x").onclick = function () {
      if (nft) { recordCollection(nft.cfg, nft.res, null, nft.up); nftDone(nft.cfg, nft.res, nft.up); }
      else modeSelect();
    };
    // present on both chains now; the reward ASSET picker is the Solana-only part
    var modeTabs = box.querySelector("#tk-modes");
    if (modeTabs) modeTabs.addEventListener("click", function (e) {
      var b = e.target.closest("button[data-m]");
      if (!b) return;
      flow.rewardMode = b.dataset.m;

      /* The mode has to move the SHARE, not just the label.
       *
       * These were two tabs sitting over a feeSharePct that this window
       * hardcodes to zero, so picking "Dividend" changed the wording and
       * pledged nothing. Normal is a share of zero; the other two pledge the
       * creator's whole side, which is what the fee page then activates. */
      if (flow.rewardMode === "none") {
        flow.feeShare = "keep";
        flow.feeSharePct = 0;
      } else {
        flow.feeShare = "holders";
        if (!(flow.feeSharePct > 0)) flow.feeSharePct = 100;
      }
      var fw = box.querySelector("#tk-fwwrap");
      if (fw) fw.hidden = (flow.feeSharePct || 0) >= 100;

      box.querySelectorAll("#tk-modes .tier").forEach(function (x) {
        x.classList.toggle("on", x === b);
      });
      /* A burn pays nobody anything, so "paid in what?" stops being a question
       * — a control that does nothing is worse than no control. */
      var rw = box.querySelector("#tk-rewardwrap");
      // the "paid in" asset only matters for a dividend — Normal keeps the fees,
      // burn buys back the token itself
      if (rw) rw.hidden = flow.rewardMode !== "dividend";
    });

    // the choice is recorded with the launch; activation happens on the fee page
    var rewardBtn = box.querySelector("#lp-reward");
    if (rewardBtn) rewardBtn.onclick = function () {
      collect();
      (isEvm() ? rhRewardPicker : rewardPicker)(flow);
    };
    box.querySelector("#lp-next").onclick = function () {
      collect();
      var name = flow.tname.trim();
      var sym = flow.tsym.trim().toUpperCase();
      if (!name) return fail(box, "The token needs a name.");
      if (!/^[A-Z0-9]{2,8}$/.test(sym)) return fail(box, "Symbol: 2-8 letters or digits.");
      /* An address on Robinhood Chain is 0x-hex, not base58 — validating
       * everything as base58 rejected every EVM fee wallet as malformed. */
      var addrOk = isEvm() ? /^0x[0-9a-fA-F]{40}$/ : /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
      if (flow.feeWallet && !addrOk.test(flow.feeWallet)) {
        return fail(box, "The fee wallet is not a valid address.");
      }
      flow.tname = name; flow.tsym = sym;
      flow.tbuy = parseFloat(flow.tbuy) || 0;
      if (flow.preconfig) return nftConfirm(flow.cfg, flow);
      if (isEvm()) return evmTokenConfirm(flow);
      tokenConfirm(flow);
    };
  }

  /* The 500+ asset picker. Shows the mint on every row on purpose: the entire
   * reason rwa.json is generated and chain-verified is that picking by ticker
   * is dangerous — five "TSLAx" tokens exist and four are fakes. The UI must
   * not undo that by hiding what is actually being selected. */
  /**
   * The Robinhood reward picker.
   *
   * Deliberately not the Solana one. That one searches five hundred assets and
   * has to warn about the four hundred with no market; here there are
   * seventeen, every one already filtered to something that trades, so a search
   * box over a short list is the whole interface.
   *
   * The address is shown on every row for the same reason it is there: the
   * point of chain-verifying this list is that a ticker is not an identity, and
   * hiding what is actually being selected would undo that.
   */
  function rhRewardPicker(flow) {
    var box = shell(H`
      <h2>Reward asset</h2>
      <p class="sub">Trading fees are converted into this before your holders
      are paid. Every asset here is verified on chain and has a live market.</p>
      <input id="lp-q" type="search" placeholder="Search…" autocomplete="off">
      <div class="ptabs" id="lp-tabs">
        <button data-t="all" class="on">All</button>
        <button data-t="native">ETH</button>
        <button data-t="stable">Stablecoins</button>
        <button data-t="equity">Stocks &amp; ETFs</button>
      </div>
      <div class="plist" id="lp-list"><p class="note" style="padding:12px">Loading…</p></div>
      <p class="note" id="lp-count"></p>
      <div class="acts"><button id="lp-x">Back</button></div>
    `);
    box.querySelector("#lp-x").onclick = function () { tokenDetails(flow); };

    var tab = "all";
    loadRhAssets().then(function (list) {
      /* Same three columns the Solana picker uses — ticker, name, then the
       * detail that matters. There it is depth; here it is how many pools use
       * the asset, which is the closest thing to "can this actually be sold". */
      function rowHtml(t) {
        var name = (t.name || "").replace(/ • Robinhood Token$/, "");
        var detail = t.kind === "native" ? "paid as-is"
          : t.pools + (t.pools === 1 ? " pool" : " pools");
        return '<button class="prow" data-a="' + esc(t.address) + '">' +
          "<b>" + esc(t.symbol) + "</b><span>" + esc(name) + "</span>" +
          '<i class="' + (t.kind === "native" || t.pools >= 3 ? "" : "dim") + '">' +
          esc(detail) + "</i></button>";
      }
      function head(label, n) {
        return '<div class="phead">' + label + " · " + n + "</div>";
      }
      function paint() {
        var q = (box.querySelector("#lp-q").value || "").trim().toLowerCase();
        var rows = list.filter(function (t) {
          if (tab !== "all" && t.kind !== tab) return false;
          return !q || (t.symbol + " " + (t.name || "")).toLowerCase().indexOf(q) >= 0;
        });
        var native = rows.filter(function (t) { return t.kind === "native"; });
        var stable = rows.filter(function (t) { return t.kind === "stable"; });
        var equity = rows.filter(function (t) { return t.kind === "equity"; });
        var html = "";
        /* ETH first: it is what the fees already are, so choosing it means no
         * swap, no slippage and nothing that can fail between the claim and the
         * payout. */
        if (native.length) html += head("No conversion", native.length) + native.map(rowHtml).join("");
        if (stable.length) html += head("Stablecoins", stable.length) + stable.map(rowHtml).join("");
        if (equity.length) html += head("Stocks & ETFs", equity.length) + equity.map(rowHtml).join("");
        box.querySelector("#lp-list").innerHTML =
          html || '<p class="note" style="padding:12px">Nothing matches that.</p>';
        box.querySelector("#lp-count").textContent =
          rows.length + " of " + list.length + " assets · every one verified on chain";
      }
      paint();
      box.querySelector("#lp-q").addEventListener("input", paint);
      box.querySelector("#lp-tabs").addEventListener("click", function (e) {
        var b = e.target.closest("button[data-t]");
        if (!b) return;
        tab = b.dataset.t;
        [].slice.call(box.querySelectorAll("#lp-tabs button")).forEach(function (x) {
          x.className = x === b ? "on" : "";
        });
        paint();
      });
      box.querySelector("#lp-list").addEventListener("click", function (e) {
        var b = e.target.closest("button[data-a]");
        if (!b) return;
        var hit = list.find(function (t) { return t.address === b.dataset.a; });
        if (!hit) return;
        /* Recorded with the launch, exactly as on Solana — nothing is routed
         * until rewards are switched on from the fee page. */
        flow.reward = {
          mint: hit.address, symbol: hit.symbol,
          name: (hit.name || "").replace(/ • Robinhood Token$/, ""),
          liquidity: hit.liquidity
        };
        tokenDetails(flow);
      });
    });
  }

  function rewardPicker(flow) {
    var box = shell(H`
      <h2>Reward asset</h2>
      <p class="sub">Trading fees are converted into this before distribution.</p>
      <input id="lp-q" type="search" placeholder="Search assets…" autocomplete="off">
      <div class="ptabs" id="lp-tabs">
        <button data-t="all" class="on">All</button>
        <button data-t="tradeable">Tradeable</button>
        <button data-t="untradeable">Not tradeable yet</button>
        <button data-t="native">SOL &amp; USDC</button>
        <button data-t="equity">Stocks</button>
        <button data-t="commodity">Commodities</button>
      </div>
      <div class="plist" id="lp-list"><p class="note" style="padding:12px">Loading…</p></div>
      <p class="note" id="lp-hidden"></p>
      <div class="acts"><button id="lp-x">Back</button></div>
    `);
    // return to whichever form opened the picker — the pair panel or the full
    // token window
    box.querySelector("#lp-x").onclick = function () { (flow.pair ? pairTokenDetails : tokenDetails)(flow); };

    var all = null, tab = "all", q = "", hidden = 0, showNo = false;

    /* What the row tells you. A creator picking what their holders get paid in
     * needs to know two things: can it be sold, and how deep is it. */
    var MIN_LIQUIDITY = 1000;
    function depth(t) {
      var n = t.liquidity;
      if (n === undefined) return "";                 // SOL / USDC
      if (n < MIN_LIQUIDITY) return "not tradeable yet";
      if (n >= 1e6) return "$" + (n / 1e6).toFixed(1) + "M deep";
      return "$" + Math.round(n / 1e3) + "k deep";
    }

    // SOL/USDC carry no liquidity number and are always tradeable
    function tradeable(t) { return t.liquidity === undefined || (t.liquidity || 0) >= MIN_LIQUIDITY; }
    function draw() {
      if (!all) return;
      /* Two tab kinds share one row: ASSET-TYPE tabs (native/equity/commodity)
       * filter by t.kind; TRADEABILITY tabs (tradeable/untradeable) filter by
       * liquidity. "all" filters by neither. Search narrows whatever is showing;
       * the 2000 cap is a safety bound well above the ~750 catalogue. */
      var KIND = { native: 1, equity: 1, commodity: 1 };
      var matched = all.filter(function (t) {
        if (KIND[tab] && t.kind !== tab) return false;
        if (tab === "tradeable" && !tradeable(t)) return false;
        if (tab === "untradeable" && tradeable(t)) return false;
        if (!q) return true;
        return (t.symbol + " " + t.name).toLowerCase().indexOf(q) >= 0;
      }).slice(0, 2000);
      function rowHtml(t) {
        return '<button class="prow" data-mint="' + esc(t.mint) + '">' +
          "<b>" + esc(t.symbol) + "</b><span>" + esc(t.name) + "</span>" +
          '<i class="' + (tradeable(t) ? "" : "dim") + '">' + esc(depth(t) || shortAddr(t.mint)) +
          "</i></button>";
      }
      function head(label, cls, n) {
        return '<div class="phead ' + cls + '">' + label + " · " + n + "</div>";
      }

      var html, hasNo;
      if (tab === "tradeable") {
        html = matched.length ? head("Tradeable now", "tradeable", matched.length) +
          matched.map(rowHtml).join("") : "";
        hasNo = false;
      } else if (tab === "untradeable") {
        html = matched.length ? head("Not tradeable yet", "", matched.length) +
          matched.map(rowHtml).join("") : "";
        hasNo = matched.length > 0;
      } else {
        // "all" or an asset-type tab: tradeable listed, the rest collapsed under
        // their own header so it is never buried by hundreds of rows
        var yes = matched.filter(tradeable);
        var no = matched.filter(function (t) { return !tradeable(t); });
        var openNo = showNo || !!q;
        html = (yes.length ? head("Tradeable now", "tradeable", yes.length) +
          yes.map(rowHtml).join("") : "");
        if (no.length) {
          html += '<div class="phead nohead">Not tradeable yet · ' + no.length +
            ' <span class="tw">' + (openNo ? "hide ▾" : "show ▸") + "</span></div>" +
            (openNo ? no.map(rowHtml).join("") : "");
        }
        hasNo = no.length > 0;
      }

      var list = box.querySelector("#lp-list");
      list.innerHTML = html || '<p class="note" style="padding:12px">Nothing matches.</p>';
      var note = box.querySelector("#lp-hidden");
      if (note) {
        note.textContent = hasNo
          ? "A not-tradeable pick pays holders the quote currency until the asset " +
            "can be sold, then switches to it by itself."
          : "";
      }
      var nh = list.querySelector(".nohead");
      if (nh) nh.onclick = function () { showNo = !showNo; draw(); };
      list.querySelectorAll(".prow").forEach(function (b) {
        b.onclick = function () {
          flow.reward = all.find(function (t) { return t.mint === b.dataset.mint; });
          (flow.pair ? pairTokenDetails : tokenDetails)(flow);
        };
      });
    }

    /* Everything is offered — the catalogue is the point — but tradeable ones
     * sort first, so a creator browsing sees what works before what does not. */
    window.Token.rwa().then(function (rwa) {
      var list = (rwa || []).slice().sort(function (a, b) {
        return (b.liquidity || 0) - (a.liquidity || 0);
      });
      hidden = list.filter(function (t) { return (t.liquidity || 0) < MIN_LIQUIDITY; }).length;
      all = BUILTIN_REWARDS.concat(list);
      // show the exact catalogue size in the search box — "+" because it grows
      // every time tools/fetch-rwa.js is re-run
      var qi = box.querySelector("#lp-q");
      if (qi && list.length) qi.placeholder = "Search " + list.length + "+ assets";
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
        ? (flow.feeSharePct >= 100 ? "all to holders"
           : flow.feeSharePct + "% holders / " + (100 - flow.feeSharePct) + "% you")
        : "You keep everything"}</b></div>
      ${(flow.feeSharePct || 0) > 0 && flow.rewardMode === "burn"
        ? H`<div class="row"><span class="k">Holder share</span><b>buyback &amp; burn</b></div>`
        : ""}
      ${(flow.feeSharePct || 0) > 0 && flow.rewardMode !== "burn" ? H`<div class="row"><span class="k">Holders paid in</span><b>${
        flow.reward.liquidity !== undefined && flow.reward.liquidity < 1000
          ? qLabel + " — " + flow.reward.symbol + " has no market yet"
          : (flow.reward.symbol || qLabel)}</b></div>` : ""}
      <div class="row"><span class="k">First buy</span><b>${flow.tbuy > 0
        ? flow.tbuy + " " + qLabel + buyShareSuffix(flow) : "none"}</b></div>
      ${flow.feeWallet ? H`<div class="row"><span class="k">Fees claim to</span><b>${shortAddr(flow.feeWallet)}</b></div>` : ""}
      <div class="row"><span class="k">Metadata storage</span><b id="lp-fee">quoting…</b></div>
      <div class="row"><span class="k">Wallet</span><b>${w ? w.name + " · " + shortAddr(w.publicKey) : "not connected"}</b></div>
      <div class="row"><span class="k">Swap fee</span><b>${
        tierSpec(flow).label + " — " + tierPct(flow) + "%"}</b></div>
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
      ["live", "Waiting for the artwork to go live"],
      ["pool", "Creating the pool" + (flow.tbuy > 0 ? " + your first buy" : "")]
    ];
    /* No "pledge" step: the pool is created with the keeper as its creator, so
     * it is pledged from the instant it exists rather than a transaction later.
     * See token.js — the gap that step left is what cost $MOAR's holders
     * almost all of their fees. */
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
      /* Check the SOL balance BEFORE charging for storage. Rent is paid in SOL
       * whatever the token is priced in, and finding that out after taking the
       * storage fee is how a creator ends up paying for an upload they cannot
       * use. */
      await window.Token.assertEnoughSol({
        quote: flow.quote, firstBuySol: flow.tbuy
      });

      mark("meta", "on");
      var tcard = await makeCard({
        name: flow.tname, symbol: flow.tsym,
        avatar: flow.icon || null, banner: flow.banner || null
      }, "token", [
        ["priced in", (flow.quote || "SOL").toUpperCase()],
        ["swap fee", tierPct(flow) + "%"],
        ["chain", "Solana"]
      ]);
      /* Checked before the upload rather than at a payment prompt — with the
       * fee folded into the pool transaction there is no prompt left to hang
       * this on, and an upload from a stale tab is wasted either way. */
      await assertFreshBuild();
      // the credit is spent the moment an upload redeems it
      var heldCredit = paidCredit();
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
        /* A token launch charges for storage inside the pool transaction, so
         * there is nothing to approve here. An unspent credit from an earlier
         * attempt is still honoured — it has already been paid for, and
         * charging again in the pool would be charging twice. */
        deferPayment: !heldCredit,
        onDeferredFee: function (q) {
          flow.storageFee = { to: q.feeTo, lamports: String(q.feeLamports) };
        },
        payer: heldCredit ? function () { return heldCredit.sig; } : null
      });
      forgetPaid();
      mark("meta", "done");

      /* Wait for the gateway before putting the URI on chain.
       *
       * Turbo returns an id the instant it accepts the upload, but arweave.net
       * cannot serve it until the bundle is posted and indexed — minutes, not
       * seconds. Aggregators (GMGN, Axiom, Photon), wallets and explorers all
       * fetch this URI ONCE, when they first see the pool, and cache what they
       * get. $MOAR launched into that window and shows as a letter placeholder
       * on GMGN with no image, which no amount of later propagation undoes.
       *
       * So the pool waits for the metadata to actually resolve. It costs a few
       * minutes at launch and buys a token that looks right everywhere it is
       * indexed. */
      mark("live", "on", "Arweave is still publishing it — this is worth the wait");
      var liveOk = await waitForUri(meta.uri, function (secs) {
        mark("live", "on", "Arweave is still publishing it — " + secs + "s");
      });
      mark("live", "done", liveOk ? "" : "still publishing — launching anyway");

      mark("pool", "on");
      var res = await window.Token.launchToken({
        name: flow.tname,
        symbol: flow.tsym,
        uri: meta.uri,
        quote: flow.quote,
        tier: flow.tier || "standard",
        storageFee: flow.storageFee || null,
        feeShare: flow.feeShare || "keep",
        feeSharePct: flow.feeSharePct || 0,
        firstBuySol: flow.tbuy,
        rewardMode: flow.rewardMode === "burn" ? "burn" : "dividend",
        // a burn buys the token itself, so there is no reward asset to name
        rewardMint: flow.reward ? flow.reward.mint : null,
        feeWallet: flow.feeWallet || null,
        icon: meta.iconUri || null,
        banner: meta.bannerUri || null,
        card: meta.cardUri || null,
        collection: flow.nft ? flow.nft.res.collection : null
      });
      mark("pool", "done");

      /* Index the new token straight away. The record was written a moment
       * ago, so the sweep would not reach it for up to ten minutes — and its
       * page is being opened right now, by the person who just made it. */
      /* Index the launch before the creator can open its page.
       *
       * This was fire-and-forget, so anything transient — a slow node, an RPC
       * having a bad afternoon — left the token page showing "—" for holders
       * and an empty chart, on the one visit that matters most. It now retries,
       * and keeps retrying while the run reports nothing indexed, because the
       * first buy sometimes lands a moment after the record does. */
      (function indexNow(attempt) {
        fetch("/api/indexer?mint=" + encodeURIComponent(res.mint))
          .then(function (r) { return r.json(); })
          .then(function (j) {
            var got = j && (j.indexed || j.trades || j.holders);
            if (!got && attempt < 5) setTimeout(function () { indexNow(attempt + 1); }, 3000);
          })
          .catch(function () {
            if (attempt < 5) setTimeout(function () { indexNow(attempt + 1); }, 3000);
          });
      })(0);

      // Link the records both ways for a pair.
      if (flow.nft) recordCollection(flow.nft.cfg, flow.nft.res, res.mint, flow.nft.up);

      busy = false;
      tokenDone(flow, res);
    } catch (e) {
      busy = false;
      window.Launch.onWait = null;
      fail(box, describe(e));
      box.insertAdjacentHTML("beforeend",
        '<div class="acts"><button id="lp-close2">Close</button></div>');
      box.querySelector("#lp-close2").onclick = close;
    }
  }

  /* The first buy as a share of supply, for the confirm screen. Same
   * arithmetic as the launch window: the curve opens at a known market cap, so
   * the share is the amount over that cap. */
  function buyShareSuffix(flow) {
    var terms = window.DBC_TERMS;
    var q = terms && terms.QUOTES && terms.QUOTES[flow.quote];
    if (!q || !q.initialMarketCap || !(flow.tbuy > 0)) return "";
    var pct = Math.min(100, (flow.tbuy / q.initialMarketCap) * 100);
    return "  ·  ~" + pct.toFixed(2) + "% of supply";
  }

  function tokenDone(flow, res) {
    var nft = flow.nft;
    /* The token's own page is where it trades. Jupiter cannot route a token
     * that is still on its bonding curve — it only appears there after the
     * curve graduates into DAMM — so sending a creator to Jupiter the moment
     * they launch points them at an empty search result for their own token. */
    var page = location.origin + "/token/" + res.mint;
    var box = shell(H`
      <h2>Live</h2>
      <p class="sub">$${flow.tsym} is trading on ${res.cluster}.</p>
      <div class="row"><span class="k">Trading fees</span><b>yours to claim</b></div>

      <!-- Rewards are a second, separate step now: one instruction the creator
           signs alone. Doing it inside the launch put a third signer in the
           transaction and Phantom blocked it. -->
      <div class="tip">
        <b>Want your holders to earn from every trade?</b>
        <span>Turn on holder rewards from the fee page — one signature, and your
        share starts paying out hourly. You can do it whenever you like.</span>
        <a class="go" href="/fees">Open the fee page →</a>
      </div>
      ${raw(caRow("Token CA", res.mint))}
      ${nft ? raw(caRow("Collection", nft.res.collection) + caRow("Candy machine", nft.res.candyMachine)) : ""}
      ${nft ? H`<label>Mint page</label>
      <input readonly value="${nft.res.mintUrl}" onclick="this.select()">` : ""}
      <label>Token page</label>
      <input readonly value="${page}" onclick="this.select()">
      <p class="note">Share this — it is where people buy, and it unfurls with
      your launch card. Jupiter lists the token once the curve graduates.</p>
      <div class="acts"><button id="lp-done">Close</button>
      ${nft ? H`<button id="lp-open">Mint page</button>` : ""}
      <button class="go" id="lp-token">Open token page</button></div>
    `);
    bindCopy(box);
    box.querySelector("#lp-done").onclick = close;
    var open = box.querySelector("#lp-open");
    if (open) open.onclick = function () { location.href = nft.res.mintUrl; };
    box.querySelector("#lp-token").onclick = function () { location.href = page; };
  }

  /* ---------- Robinhood Chain token launches ---------- */

  /* The platform's cut, in basis points OF VOLUME, by rung.
   *
   * Mirrors platformVolumeBps() in contracts/WavesCurve.sol. Duplicated rather
   * than read from the chain because this is a display string on a screen shown
   * before a wallet is necessarily connected — but the contract is the
   * authority, and it will refuse a rung that is not on this ladder, so the two
   * cannot silently disagree about what is allowed. */
  var EVM_PLATFORM_BPS = { 100: 40, 200: 50, 300: 60, 400: 70, 500: 80, 1000: 90 };

  function evmSplit(flow) {
    var bps = tierSpec(flow).baseFeeBps || 100;
    var plat = EVM_PLATFORM_BPS[bps];
    if (plat === undefined) return null;
    return { total: bps / 100, platform: plat / 100, creator: (bps - plat) / 100, bps: bps };
  }

  async function evmTokenConfirm(flow) {
    var acct = (window.MoonpadWallet || {}).account;
    var sp = evmSplit(flow);
    var box = shell(H`
      <h2>Confirm token</h2>
      <p class="sub">One small metadata upload, then the curve. The curve is the liquidity.</p>
      <div class="row"><span class="k">Token</span><b>${flow.tname} · $${flow.tsym}</b></div>
      <div class="row"><span class="k">Chain</span><b>Robinhood</b></div>
      <div class="row"><span class="k">Priced in</span><b>ETH</b></div>
      <div class="row"><span class="k">First buy</span><b>${
        flow.tbuy > 0 ? flow.tbuy + " ETH" : "none"}</b></div>
      <div class="row"><span class="k">Metadata storage</span><b id="lp-fee">quoting…</b></div>
      <div class="row"><span class="k">Wallet</span><b>${
        acct ? shortAddr(acct) : "not connected"}</b></div>
      <div class="row"><span class="k">Trading fee</span><b>${
        tierSpec(flow).label + " — " + (sp ? sp.total : tierPct(flow)) + "%"}</b></div>
      <div class="row"><span class="k">Fee sharing</span><b>${(flow.feeSharePct || 0) > 0
        ? (flow.feeSharePct >= 100 ? "all to holders"
           : flow.feeSharePct + "% holders / " + (100 - flow.feeSharePct) + "% you")
        : "You keep everything"}</b></div>
      ${(flow.feeSharePct || 0) > 0 ? H`<div class="row"><span class="k">Holder share</span><b>${
        flow.rewardMode === "burn" ? "buyback & burn" : "dividend, paid in ETH"}</b></div>` : ""}
      ${flow.feeWallet ? H`<div class="row"><span class="k">Fees claim to</span><b>${
        shortAddr(flow.feeWallet)}</b></div>` : ""}
      ${sp ? H`<p class="note">Of every ${sp.total}% traded, ${sp.creator}% is yours and
      ${sp.platform}% is ours. There is no third party on this chain, so you keep
      more here than the same rung pays on Solana.</p>` : ""}
      <p class="note">Holder rewards are switched on afterwards, from the fee page —
      one transaction you sign alone.</p>
      <div id="lp-err"></div>
      <div class="acts"><button id="lp-back">Back</button>
      <button class="go" id="lp-go" disabled>${acct ? "Launch token" : "Connect a wallet"}</button></div>
    `);
    box.querySelector("#lp-back").onclick = function () { tokenDetails(flow); };

    /* Refuse early if there is no curve to launch into. Better here, on a screen
     * that has taken nothing, than after the storage fee has been paid. */
    if (!window.MoonpadToken || !window.MoonpadToken.curveAddress()) {
      box.querySelector("#lp-fee").textContent = "—";
      return fail(box, "Token launches are not open on Robinhood Chain yet — " +
        "the bonding curve has not been deployed.");
    }

    /* Launch-sized uploads are on us — see doEvmTokenLaunch. Quoting a fee the
     * creator will not be charged, and then not charging it, is a worse
     * surprise than either being honest or actually charging. */
    var upBytes = 300 + (flow.icon ? flow.icon.length : 0) +
      (flow.banner ? flow.banner.length : 0);
    box.querySelector("#lp-fee").textContent =
      upBytes > 8 * 1024 * 1024 ? "charged at cost — your art is over the free size"
                                : "included";

    var go = box.querySelector("#lp-go");
    go.disabled = false;
    go.onclick = acct
      ? function () { doEvmTokenLaunch(flow); }
      : async function () {
          var w = await (window.Shell ? Shell.connect() : Promise.resolve(null));
          if (w) evmTokenConfirm(flow);
        };
  }

  async function doEvmTokenLaunch(flow) {
    busy = true;
    /* Two steps, not three.
     *
     * A Solana launch has to wait for arweave.net to serve the metadata before
     * the pool goes on chain, because the pool embeds the URI and every
     * aggregator reads it once and caches whatever it gets. Nothing on this
     * chain points at the metadata — WavesToken has a name and a symbol and no
     * URI — so there is nothing to wait for, and the launch is faster for it. */
    var stages = [
      ["meta", "Storing token metadata"],
      ["curve", "Opening the curve" + (flow.tbuy > 0 ? " + your first buy" : "")]
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
      var tcard = await makeCard({
        name: flow.tname, symbol: flow.tsym,
        avatar: flow.icon || null, banner: flow.banner || null
      }, "token", [
        ["priced in", "ETH"],
        ["swap fee", (evmSplit(flow) || {}).total + "%"],
        ["chain", "Robinhood"]
      ]);
      await assertFreshBuild();
      var meta = await window.Storage.uploadTokenMeta({
        name: flow.tname,
        symbol: flow.tsym,
        description: flow.tdesc || "",
        card: tcard,
        icon: flow.icon || null,
        iconExt: flow.iconExt || "png",
        banner: flow.banner || null,
        bannerExt: flow.bannerExt || "png",
        links: { website: flow.web, x: flow.x, telegram: flow.tg },
        /* No payment step, and therefore ONE signature for the whole launch.
         *
         * The server already grants launch-sized uploads (≤8MB, ≤5 files) for
         * free, rate limited per address — a token launch is a card, an icon, a
         * banner and a json, nowhere near it. Charging anyway meant a second
         * transaction, and on this chain that transaction's gas costs about
         * twice the fee it collects. Collecting nine tenths of a cent for
         * seventeen tenths of a cent of gas, at the price of an extra wallet
         * prompt, is worse for everyone.
         *
         * A collection is a different question — thousands of images is real
         * money — so evm collections still pay, via payStorageEvm.
         *
         * The payer stays wired for the case the free tier refuses: art large
         * enough to fall outside it still has a way through. */
        payer: (300 + (flow.icon ? flow.icon.length : 0) +
                (flow.banner ? flow.banner.length : 0) > 8 * 1024 * 1024)
          ? payStorageEvm : null
      });
      mark("meta", "done");

      mark("curve", "on");
      var ETHER = 1000000000000000000n;
      var devWei = flow.tbuy > 0
        ? BigInt(Math.round(flow.tbuy * 1e9)) * (ETHER / 1000000000n)
        : 0n;
      var sent = await window.MoonpadToken.launch({
        name: flow.tname,
        symbol: flow.tsym,
        feeBps: tierSpec(flow).baseFeeBps || 100,
        devBuyWei: devWei,

        /* ON CHAIN, and only obtainable here.
         *
         * An ERC20 has no metadata account, so an indexer reads the picture off
         * the token itself or shows a grey letter forever — there is no later
         * step. The icon is the square one; the share card is the fallback so a
         * launch with no logo is still not blank.
         *
         * Served through our /m/ path, not arweave.net, for the reason
         * storage.js already gives about token.json: an aggregator fetches once
         * and caches whatever it gets, and arweave.net cannot serve a fresh
         * upload for minutes. $MOAR is a permanent letter placeholder on GMGN
         * because of exactly that window. The bytes are still on Arweave. */
        logo: (meta && (meta.iconUri || meta.cardUri)) || "",
        description: (flow.tdesc || "").slice(0, 200),
        socials: flow.x || flow.web || "",
        /* Deliberately no slippage floor on the creator's own first buy: they
         * are the first trade on a curve nobody else can have touched yet, so
         * there is nothing to be front-run by. */
        minTokensOut: 0
      });
      var res = await window.MoonpadToken.waitForLaunch(sent.hash);
      mark("curve", "done");

      recordEvmToken(flow, res, meta);
      busy = false;
      evmTokenDone(flow, res);
    } catch (e) {
      busy = false;
      fail(box, describe(e));
      box.insertAdjacentHTML("beforeend",
        '<div class="acts"><button id="lp-close3">Close</button></div>');
      box.querySelector("#lp-close3").onclick = close;
    }
  }

  function recordEvmToken(flow, res, meta) {
    /* The same fields the Solana side records, and for the same reason: these
     * are the creator's CHOICES, saved with the launch and applied when they
     * switch rewards on from the fee page. Recording "keep / 0" regardless —
     * which this used to do — quietly threw away what they picked. */
    postListing("/api/tokens", {
      chain: "robinhood",
      mint: res.token,
      name: flow.tname,
      symbol: flow.tsym,
      creator: (window.MoonpadWallet || {}).account || null,
      icon: (meta && meta.iconUri) || null,
      banner: (meta && meta.bannerUri) || null,
      card: (meta && meta.cardUri) || null,
      feeShare: flow.feeShare || "keep",
      feeSharePct: flow.feeSharePct || 0,
      rewardMode: flow.rewardMode === "burn" ? "burn" : "dividend",
      // where the creator's KEPT portion claims to — claimTo() on the curve
      feeWallet: flow.feeWallet || null
    });
  }

  function evmTokenDone(flow, res) {
    var page = location.origin + "/token/" + res.token;
    var box = shell(H`
      <h2>Live</h2>
      <p class="sub">$${flow.tsym} is trading on Robinhood Chain.</p>
      <div class="row"><span class="k">Trading fees</span><b>yours to claim</b></div>
      <div class="tip">
        <b>Want your holders to earn from every trade?</b>
        <span>Turn on holder rewards from the fee page — one transaction, and your
        share starts paying out. You can do it whenever you like.</span>
        <a class="go" href="/fees">Open the fee page →</a>
      </div>
      ${raw(caRow("Token CA", res.token))}
      <label>Token page</label>
      <input readonly value="${page}" onclick="this.select()">
      <p class="note">Share this — it is where people buy. The token moves to a
      Uniswap pool automatically once the curve fills, and the liquidity is locked
      there permanently.</p>
      <div class="acts"><button id="lp-done3">Close</button>
      <button class="go" id="lp-token3">Open token page</button></div>
    `);
    bindCopy(box);
    box.querySelector("#lp-done3").onclick = close;
    box.querySelector("#lp-token3").onclick = function () { location.href = page; };
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

      /* Metadata pairing: 4.png needs 4.json, for every image.
       *
       * Bringing finished files means bringing their traits — we never write
       * anyone's json, so an upload without it produces a collection with no
       * attributes at all, and nobody notices until it is on chain and
       * immutable. Requiring it up front is the only point where that is still
       * fixable. */
      var stem = function (n) { return n.replace(/\.(png|json)$/i, ""); };
      var jmap = {};
      jsons.forEach(function (j) { jmap[stem(j.name)] = j; });
      if (!jsons.length) {
        return fail(box, "No .json files in that selection — every image needs " +
          "its metadata, named to match (4.png needs 4.json). We never write " +
          "your json, so without it the collection would have no traits.");
      }
      {
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
