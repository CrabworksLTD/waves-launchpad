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
      ".lp button.go{background:var(--grad);color:var(--accent-ink);border-color:transparent}",
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
      ".lp .pick .k2{color:var(--faint);font-size:11px}"
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
          <span>${hasRun ? run.count + " generated pieces, a candy machine, a mint page." :
                           "Draw and generate a collection first."}</span></span>
        </button>
        <button class="mode" id="m-token" ${tokenReady ? "" : raw("disabled")}>
          <span class="mi">◎</span>
          <span><b>Token</b>
          <span>A bonding-curve token. Trades on Jupiter immediately, graduates to a real pool.</span>
          ${tokenReady ? "" : raw('<span class="why">Token launches are not configured on this deployment yet.</span>')}</span>
        </button>
        <button class="mode" id="m-pair" ${hasRun && tokenReady ? "" : raw("disabled")}>
          <span class="mi">⬡</span>
          <span><b>Pair — collection + token</b>
          <span>Launch both together. The token's trading fees can reward the collection's holders.</span>
          ${hasRun ? "" : raw('<span class="why">Needs a generated collection.</span>')}</span>
        </button>
      </div>
      <div class="acts"><button id="lp-x">Cancel</button></div>
    `);
    box.querySelector("#lp-x").onclick = close;
    if (hasRun) box.querySelector("#m-nft").onclick = function () { nftDetails(null); };
    if (tokenReady) box.querySelector("#m-token").onclick = function () { tokenDetails(null); };
    if (hasRun && tokenReady) box.querySelector("#m-pair").onclick = function () { nftDetails({ pair: true }); };
  }

  /* ================= NFT flow ================= */

  function nftDetails(flow) {
    var P = window.__project || {};
    var supply = run ? run.count : (P.supply || 0);
    var box = shell(H`
      <h2>${flow && flow.pair ? "1 of 2 — the collection" : "Launch collection"}</h2>
      <p class="sub">${supply} pieces, generated and ready. Nothing is on chain until you confirm.</p>
      <label>Collection name</label>
      <input id="lp-name" value="${P.name || "Untitled collection"}" maxlength="28">
      <label>Description</label>
      <textarea id="lp-desc" rows="2" placeholder="Shown on marketplaces"></textarea>
      <div class="two">
        <div><label>Mint price (SOL)</label>
        <input id="lp-price" type="number" min="0" step="0.01" value="0"></div>
        <div><label>Royalty %</label>
        <input id="lp-roy" type="number" min="0" max="50" step="0.5" value="5"></div>
      </div>
      <label>Network</label>
      <input id="lp-cluster" value="${window.Launch.cluster()}" readonly>
      <p class="note">Name is capped at 28 characters because Candy Machine stores it as a
      fixed-length prefix on chain, and the token number has to fit after it.</p>
      <div class="acts"><button id="lp-x">${flow && flow.pair ? "Back" : "Cancel"}</button>
      <button class="go" id="lp-next">Continue</button></div>
    `);

    box.querySelector("#lp-x").onclick = flow && flow.pair ? modeSelect : close;
    box.querySelector("#lp-next").onclick = function () {
      var name = box.querySelector("#lp-name").value.trim();
      if (!name) return;
      nftConfirm({
        name: name,
        description: box.querySelector("#lp-desc").value.trim(),
        priceSol: parseFloat(box.querySelector("#lp-price").value) || 0,
        royaltyPercent: parseFloat(box.querySelector("#lp-roy").value) || 0,
        supply: supply
      }, flow);
    };
  }

  async function nftConfirm(cfg, flow) {
    var w = window.Wallet.current();
    var box = shell(H`
      <h2>Confirm</h2>
      <p class="sub">Two things get paid for: permanent storage, and Solana rent plus fees.</p>
      <div class="row"><span class="k">Collection</span><b>${cfg.name}</b></div>
      <div class="row"><span class="k">Supply</span><b>${cfg.supply}</b></div>
      <div class="row"><span class="k">Mint price</span><b>${cfg.priceSol} SOL</b></div>
      <div class="row"><span class="k">Royalty</span><b>${cfg.royaltyPercent}%</b></div>
      <div class="row"><span class="k">Storage fee</span><b id="lp-fee">quoting…</b></div>
      <div class="row"><span class="k">Wallet</span><b>${w ? w.name + " · " + shortAddr(w.publicKey) : "not connected"}</b></div>
      <p class="note">Storage is a one-off payment to Arweave for permanent hosting,
      quoted live at the moment you launch so it tracks the real cost.</p>
      <div id="lp-err"></div>
      <div class="acts"><button id="lp-back">Back</button>
      <button class="go" id="lp-go" disabled>${w ? "Launch" : "Connect a wallet"}</button></div>
    `);

    box.querySelector("#lp-back").onclick = function () { nftDetails(flow); };

    // Quote before enabling the button — nobody confirms an unshown price.
    try {
      var probe = estimateBytes();
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
          var found = window.Wallet.list();
          if (!found.length) return fail(box, "No Solana wallet found. Install Phantom or Solflare.");
          try { await window.Wallet.connect(found[0].id); nftConfirm(cfg, flow); }
          catch (e) { fail(box, e.message); }
        };
  }

  /* Sizing probe for the pre-launch quote. storage.js sizes properly against
   * the real file set at upload time; this must not drift from it or the
   * quoted fee will not match the charged fee. */
  function estimateBytes() {
    var f = run.files;
    var bytes = 0, count = 0;
    ["images", "metaplex"].forEach(function (k) {
      (f[k] || []).forEach(function (x) {
        bytes += x.bytes ? x.bytes.byteLength || x.bytes.length : (x.text || "").length;
        count++;
      });
    });
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
        description: cfg.description,
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
        royaltyPercent: cfg.royaltyPercent,
        baseUri: up.baseUri,
        collectionUri: up.collectionUri,
        onProgress: function (p) {
          if (p.step === "lines" && p.state === "uploading") {
            mark("lines", "on", "Loading items — batch " + p.batch + " of " + p.batches);
          } else {
            mark(p.step, p.state === "done" ? "done" : "on");
          }
        }
      });

      busy = false;

      if (flow && flow.pair) {
        // Straight into part two, carrying the collection along. Its record is
        // POSTed at the end of the token flow so the entries link both ways.
        flow.nft = { cfg: cfg, res: res, up: up };
        tokenDetails(flow);
        return;
      }

      recordCollection(cfg, res, null);
      nftDone(cfg, res, up);
    } catch (e) {
      busy = false;
      fail(box, e.message || String(e));
      box.insertAdjacentHTML("beforeend",
        '<div class="acts"><button id="lp-close2">Close</button></div>');
      box.querySelector("#lp-close2").onclick = close;
    }
  }

  function recordCollection(cfg, res, tokenMint) {
    // Fire-and-forget: the collection is already on chain, and a launch must
    // never look failed because a listing endpoint was down.
    fetch("/api/collections", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        candyMachine: res.candyMachine, collection: res.collection,
        name: cfg.name, cluster: res.cluster, tokenMint: tokenMint || null
      })
    }).catch(function () {});
  }

  function nftDone(cfg, res, up) {
    var box = shell(H`
      <h2>Live</h2>
      <p class="sub">${cfg.name} is on ${res.cluster}.</p>
      <div class="row"><span class="k">Candy machine</span><b>${shortAddr(res.candyMachine, 6)}</b></div>
      <div class="row"><span class="k">Collection</span><b>${shortAddr(res.collection, 6)}</b></div>
      <div class="row"><span class="k">Items loaded</span><b>${cfg.supply}</b></div>
      <label>Mint page</label>
      <input readonly value="${res.mintUrl}" onclick="this.select()">
      <p class="note"><a href="${res.explorer}" target="_blank" rel="noopener">View on Solana Explorer ↗</a></p>
      <div class="acts"><button id="lp-done">Close</button>
      <button class="go" id="lp-open">Open mint page</button></div>
    `);
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

  function tokenDetails(flow) {
    flow = flow || {};
    var nft = flow.nft;
    var defName = nft ? nft.cfg.name : "";
    var defSym = defName ? defName.replace(/[^A-Za-z]/g, "").slice(0, 5).toUpperCase() : "";
    flow.reward = flow.reward || BUILTIN_REWARDS[0];

    var box = shell(H`
      <h2>${nft ? "2 of 2 — the token" : "Launch token"}</h2>
      <p class="sub">${nft
        ? "Paired with " + nft.cfg.name + ". Its trading fees can reward the collection's holders."
        : "A bonding-curve token. No liquidity to manage — the curve is the liquidity."}</p>
      <div class="two">
        <div><label>Name</label>
        <input id="lp-tname" value="${flow.tname || defName}" maxlength="30" placeholder="My Token"></div>
        <div><label>Symbol</label>
        <input id="lp-tsym" value="${flow.tsym || defSym}" maxlength="8" placeholder="TKN"
          style="text-transform:uppercase"></div>
      </div>
      <label>Your first buy (SOL) — optional</label>
      <input id="lp-tbuy" type="number" min="0" step="0.1" value="${flow.tbuy || 0}">
      <p class="note">A first buy lands in the same transaction as the pool, so nobody
      can snipe the opening price ahead of you.</p>
      <label>Holder rewards paid in</label>
      <button class="pick" id="lp-reward">
        <span><b>${flow.reward.symbol}</b> &nbsp;<span class="k2">${flow.reward.name}</span></span>
        <span class="k2 mono">${shortAddr(flow.reward.mint)}</span>
      </button>
      <p class="note">What trading fees are converted into before being paid to
      ${nft ? "this collection's stakers" : "holders"}. SOL and USDC need no conversion;
      a stock or commodity is swapped at distribution time.</p>
      <div id="lp-err"></div>
      <div class="acts"><button id="lp-x">${nft ? "Skip token" : "Back"}</button>
      <button class="go" id="lp-next">Continue</button></div>
    `);

    box.querySelector("#lp-x").onclick = function () {
      if (nft) { recordCollection(nft.cfg, nft.res, null); nftDone(nft.cfg, nft.res, nft.up); }
      else modeSelect();
    };
    box.querySelector("#lp-reward").onclick = function () {
      flow.tname = box.querySelector("#lp-tname").value;
      flow.tsym = box.querySelector("#lp-tsym").value;
      flow.tbuy = box.querySelector("#lp-tbuy").value;
      rewardPicker(flow);
    };
    box.querySelector("#lp-next").onclick = function () {
      var name = box.querySelector("#lp-tname").value.trim();
      var sym = box.querySelector("#lp-tsym").value.trim().toUpperCase();
      if (!name) return fail(box, "The token needs a name.");
      if (!/^[A-Z0-9]{2,8}$/.test(sym)) return fail(box, "Symbol: 2-8 letters or digits.");
      flow.tname = name; flow.tsym = sym;
      flow.tbuy = parseFloat(box.querySelector("#lp-tbuy").value) || 0;
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
      <input id="lp-q" type="search" placeholder="Search 500+ assets" autocomplete="off">
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

  async function tokenConfirm(flow) {
    var w = window.Wallet.current();
    var nft = flow.nft;
    var box = shell(H`
      <h2>Confirm token</h2>
      <p class="sub">One small metadata upload, then the pool. The curve is the liquidity.</p>
      <div class="row"><span class="k">Token</span><b>${flow.tname} · $${flow.tsym}</b></div>
      ${nft ? H`<div class="row"><span class="k">Paired with</span><b>${nft.cfg.name}</b></div>` : ""}
      <div class="row"><span class="k">Rewards in</span><b>${flow.reward.symbol}</b></div>
      <div class="row"><span class="k">First buy</span><b>${flow.tbuy > 0 ? flow.tbuy + " SOL" : "none"}</b></div>
      <div class="row"><span class="k">Metadata storage</span><b id="lp-fee">quoting…</b></div>
      <div class="row"><span class="k">Wallet</span><b>${w ? w.name + " · " + shortAddr(w.publicKey) : "not connected"}</b></div>
      <p class="note">Fee split on every trade: 40% you, 40% platform, 20% Meteora.
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
          var found = window.Wallet.list();
          if (!found.length) return fail(box, "No Solana wallet found.");
          try { await window.Wallet.connect(found[0].id); tokenConfirm(flow); }
          catch (e) { fail(box, e.message); }
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
        description: flow.nft ? "Paired with " + flow.nft.cfg.name : "",
        payer: function (q) { return payStorage(q); }
      });
      mark("meta", "done");

      mark("pool", "on");
      var res = await window.Token.launchToken({
        name: flow.tname,
        symbol: flow.tsym,
        uri: meta.uri,
        firstBuySol: flow.tbuy,
        rewardMint: flow.reward.mint,
        collection: flow.nft ? flow.nft.res.collection : null
      });
      mark("pool", "done");

      // Link the records both ways for a pair.
      if (flow.nft) recordCollection(flow.nft.cfg, flow.nft.res, res.mint);

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
      <div class="row"><span class="k">Token mint</span><b>${shortAddr(res.mint, 6)}</b></div>
      <div class="row"><span class="k">Rewards in</span><b>${flow.reward.symbol}</b></div>
      ${nft ? H`<div class="row"><span class="k">Paired collection</span><b>${shortAddr(nft.res.collection, 6)}</b></div>
      <label>Mint page</label>
      <input readonly value="${nft.res.mintUrl}" onclick="this.select()">` : ""}
      <p class="note"><a href="${jup}" target="_blank" rel="noopener">Trade on Jupiter ↗</a></p>
      <div class="acts"><button id="lp-done">Close</button>
      ${nft ? H`<button class="go" id="lp-open">Open mint page</button>` : ""}</div>
    `);
    box.querySelector("#lp-done").onclick = close;
    var open = box.querySelector("#lp-open");
    if (open) open.onclick = function () { location.href = nft.res.mintUrl; };
  }

  /* ---------- public surface ---------- */

  window.LaunchPanel = {
    setRun: function (files, count) { run = { files: files, count: count }; },
    open: function () { modeSelect(); }
  };
})();
