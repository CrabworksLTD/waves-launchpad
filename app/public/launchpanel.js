(function () {
  "use strict";
  /* The launch modal. Drives storage.js and launch.js; owns no chain logic of
   * its own beyond collecting the storage fee, which has to happen here because
   * it needs the user's wallet mid-flow.
   *
   * app.js talks to this through exactly two calls — setRun() after a generate,
   * open() from the Launch button — and both are guarded on window.LaunchPanel
   * existing, so the editor still runs standalone if this file never loads.
   * Keep it that way. */

  var run = null;        // { files, count } from the generator
  var el = null;
  var busy = false;

  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }

  function css() {
    if (document.getElementById("lp-css")) return;
    var s = document.createElement("style");
    s.id = "lp-css";
    s.textContent = [
      ".lp-back{position:fixed;inset:0;z-index:9000;background:rgba(4,3,8,.72);",
      "  backdrop-filter:blur(6px);display:grid;place-items:center;padding:24px}",
      ".lp{width:min(560px,100%);max-height:88vh;overflow:auto;background:var(--panel);",
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
      ".lp .row b{font-weight:600}",
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
      ".lp a{color:var(--accent)}"
    ].join("");
    document.head.appendChild(s);
  }

  function close() {
    if (busy) return;                       // never vanish mid-deploy
    if (el) { el.remove(); el = null; }
  }

  function shell(inner) {
    css();
    if (!el) {
      el = document.createElement("div");
      el.className = "lp-back";
      el.addEventListener("click", function (e) { if (e.target === el) close(); });
      document.body.appendChild(el);
    }
    el.innerHTML = '<div class="lp">' + inner + "</div>";
    return el.querySelector(".lp");
  }

  /* ---------- step 1: details ---------- */
  function details() {
    var P = window.__project || {};
    var supply = run ? run.count : (P.supply || 0);
    var box = shell([
      "<h2>Launch collection</h2>",
      '<p class="sub">', esc(supply), " pieces, generated and ready. Nothing is on chain until you confirm.</p>",
      "<label>Collection name</label>",
      '<input id="lp-name" value="', esc(P.name || "Untitled collection"), '" maxlength="28">',
      "<label>Description</label>",
      '<textarea id="lp-desc" rows="2" placeholder="Shown on marketplaces"></textarea>',
      '<div class="two">',
        "<div><label>Mint price (SOL)</label>",
        '<input id="lp-price" type="number" min="0" step="0.01" value="0"></div>',
        "<div><label>Royalty %</label>",
        '<input id="lp-roy" type="number" min="0" max="50" step="0.5" value="5"></div>',
      "</div>",
      "<label>Network</label>",
      '<input id="lp-cluster" value="', esc(window.Launch.cluster()), '" readonly>',
      '<p class="note">Name is capped at 28 characters because Candy Machine stores it as a ',
      "fixed-length prefix on chain, and the token number has to fit after it.</p>",
      '<div class="acts"><button id="lp-x">Cancel</button>',
      '<button class="go" id="lp-next">Continue</button></div>'
    ].join(""));

    box.querySelector("#lp-x").onclick = close;
    box.querySelector("#lp-next").onclick = function () {
      var name = box.querySelector("#lp-name").value.trim();
      if (!name) return;
      confirmStep({
        name: name,
        description: box.querySelector("#lp-desc").value.trim(),
        priceSol: parseFloat(box.querySelector("#lp-price").value) || 0,
        royaltyPercent: parseFloat(box.querySelector("#lp-roy").value) || 0,
        supply: supply
      });
    };
  }

  /* ---------- step 2: confirm + wallet ---------- */
  async function confirmStep(cfg) {
    var w = window.Wallet.current();
    var box = shell([
      "<h2>Confirm</h2>",
      '<p class="sub">Two things get paid for: permanent storage, and Solana rent plus fees.</p>',
      '<div class="row"><span class="k">Collection</span><b>', esc(cfg.name), "</b></div>",
      '<div class="row"><span class="k">Supply</span><b>', esc(cfg.supply), "</b></div>",
      '<div class="row"><span class="k">Mint price</span><b>', esc(cfg.priceSol), " SOL</b></div>",
      '<div class="row"><span class="k">Royalty</span><b>', esc(cfg.royaltyPercent), "%</b></div>",
      '<div class="row"><span class="k">Storage fee</span><b id="lp-fee">quoting…</b></div>',
      '<div class="row"><span class="k">Wallet</span><b id="lp-wallet">',
        w ? esc(w.name + " · " + w.publicKey.slice(0, 4) + "…" + w.publicKey.slice(-4)) : "not connected",
      "</b></div>",
      '<p class="note">Storage is a one-off payment to Arweave for permanent hosting. ',
      "It is quoted live at the moment you launch, so it tracks the real cost.</p>",
      '<div id="lp-err"></div>',
      '<div class="acts"><button id="lp-back">Back</button>',
      '<button class="go" id="lp-go" disabled>', w ? "Launch" : "Connect a wallet", "</button></div>"
    ].join(""));

    box.querySelector("#lp-back").onclick = details;

    // Quote before enabling the button — nobody should confirm a price they
    // have not been shown.
    var quote = null;
    try {
      var probe = estimateBytes();
      quote = await window.Storage.quoteUpload(probe.bytes, probe.count);
      box.querySelector("#lp-fee").textContent = Number(quote.feeSol).toFixed(4) + " SOL";
    } catch (e) {
      box.querySelector("#lp-fee").textContent = "unavailable";
      fail(box, "Could not price storage: " + e.message);
      return;
    }

    var go = box.querySelector("#lp-go");
    if (!w) {
      go.disabled = false;
      go.onclick = async function () {
        var found = window.Wallet.list();
        if (!found.length) return fail(box, "No Solana wallet found. Install Phantom or Solflare.");
        try { await window.Wallet.connect(found[0].id); confirmStep(cfg); }
        catch (e) { fail(box, e.message); }
      };
    } else {
      go.disabled = false;
      go.onclick = function () { doLaunch(cfg, quote); };
    }
  }

  function fail(box, msg) {
    var e = box.querySelector("#lp-err");
    if (e) e.innerHTML = '<div class="err">' + esc(msg) + "</div>";
  }

  /* Sizing probe. storage.js does this properly against the real file set; this
   * is only for the quote shown before launch, and it must not drift from the
   * real one or the quoted fee will not match the charged fee. */
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

  /* ---------- step 3: the actual launch ---------- */
  async function doLaunch(cfg, quote) {
    busy = true;
    var stages = [
      ["storage", "Paying for storage"],
      ["images", "Uploading art"],
      ["metadata", "Uploading metadata"],
      ["collection", "Creating collection"],
      ["machine", "Creating candy machine"],
      ["lines", "Loading items"]
    ];
    var box = shell([
      "<h2>Launching</h2>",
      '<p class="sub">Leave this tab open. Each step needs a signature.</p>',
      '<ul class="steps" id="lp-steps">',
      stages.map(function (s) {
        return '<li data-k="' + s[0] + '"><i>·</i><span>' + esc(s[1]) + "</span></li>";
      }).join(""),
      "</ul><div id=\"lp-err\"></div>"
    ].join(""));

    function mark(k, state, extra) {
      var li = box.querySelector('[data-k="' + k + '"]');
      if (!li) return;
      li.className = state;
      li.querySelector("i").textContent = state === "done" ? "✓" : "›";
      if (extra) li.querySelector("span").textContent = extra;
    }

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
        // Collect the storage fee. Kept here rather than in storage.js because
        // it needs the wallet, and storage.js is deliberately chain-agnostic.
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
      done(cfg, res, up);
    } catch (e) {
      busy = false;
      fail(box, e.message || String(e));
      var acts = document.createElement("div");
      acts.className = "acts";
      acts.innerHTML = '<button id="lp-close2">Close</button>';
      box.appendChild(acts);
      box.querySelector("#lp-close2").onclick = close;
    }
  }

  // A plain SOL transfer to the fee wallet, signed by the creator. Returns the
  // signature, which the server verifies as a balance delta before granting the
  // upload credit.
  async function payStorage(q) {
    var mx = await import("/vendor/metaplex.esm.js");
    var w = window.Wallet.current();
    if (!q.feeTo) throw new Error("Storage fees are not configured on this deployment");

    var umi = mx.createUmi(window.Launch.clusters[window.Launch.cluster()].rpc)
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

  /* ---------- step 4: done ---------- */
  function done(cfg, res, up) {
    var box = shell([
      "<h2>Live</h2>",
      '<p class="sub">', esc(cfg.name), " is on ", esc(res.cluster), ".</p>",
      '<div class="row"><span class="k">Candy machine</span><b>', esc(res.candyMachine.slice(0, 6)), "…</b></div>",
      '<div class="row"><span class="k">Collection</span><b>', esc(res.collection.slice(0, 6)), "…</b></div>",
      '<div class="row"><span class="k">Items loaded</span><b>', esc(cfg.supply), "</b></div>",
      "<label>Mint page</label>",
      '<input readonly value="', esc(res.mintUrl), '" onclick="this.select()">',
      '<p class="note"><a href="', esc(res.explorer), '" target="_blank" rel="noopener">View on Solana Explorer ↗</a><br>',
      'Metadata: <a href="', esc(up.baseUri), '" target="_blank" rel="noopener">', esc(up.metadataCid.slice(0, 10)), "…</a></p>",
      '<div class="acts"><button id="lp-done">Close</button>',
      '<button class="go" id="lp-open">Open mint page</button></div>'
    ].join(""));
    box.querySelector("#lp-done").onclick = close;
    box.querySelector("#lp-open").onclick = function () { location.href = res.mintUrl; };
  }

  window.LaunchPanel = {
    setRun: function (files, count) { run = { files: files, count: count }; },
    open: function () {
      if (!run || !run.files) return alert("Generate the collection first.");
      details();
    }
  };
})();
