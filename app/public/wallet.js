/* Wallet discovery and connection.
 *
 * Solana's equivalent of EIP-6963 is the Wallet Standard, where wallets
 * announce themselves through window.navigator.wallets. We listen on that
 * first, then fall back to the injected globals — Wallet Standard is well
 * adopted but a stale Solflare or an in-app browser will still only expose
 * window.solflare, and dropping those users to support a cleaner API is a bad
 * trade for a mint page.
 *
 * Exposes window.Wallet:
 *   .list()                 -> [{id, name, icon, connect}]
 *   .connect(id)            -> {publicKey, signTransaction, signAllTransactions}
 *   .current()              -> the connected wallet or null
 *   .disconnect()
 *   .on("change", fn)       -> account/disconnect changes
 */
(function () {
  "use strict";

  var standard = [];   // wallets that registered via Wallet Standard
  var connected = null;
  var listeners = [];

  /* ---------- Wallet Standard discovery ----------
     Wallets either push into an existing registry or wait for the app to
     announce itself. Doing both covers wallets that loaded before us and
     wallets that load after. */
  function collectStandard() {
    var api = {
      register: function () {
        var added = [].slice.call(arguments);
        for (var i = 0; i < added.length; i++) add(added[i]);
        return function () {};
      },
      get: function () { return standard.slice(); },
      on: function () { return function () {}; }
    };

    function add(w) {
      if (!w || !w.features) return;
      // only wallets that can actually sign for Solana
      if (!w.features["solana:signTransaction"] &&
          !w.features["solana:signAndSendTransaction"]) return;
      for (var i = 0; i < standard.length; i++) if (standard[i].name === w.name) return;
      standard.push(w);
    }

    try {
      var existing = window.navigator.wallets;
      if (existing && typeof existing.push === "function") {
        existing.push({ register: api.register });
      }
    } catch (e) { /* no registry, fall through to the event */ }

    window.addEventListener("wallet-standard:register-wallet", function (ev) {
      try { ev.detail({ register: api.register }); } catch (e) {}
    });
    try {
      window.dispatchEvent(new CustomEvent("wallet-standard:app-ready", { detail: api }));
    } catch (e) {}
  }
  collectStandard();

  /* ---------- injected fallbacks ---------- */
  var INJECTED = [
    { id: "phantom",  name: "Phantom",  get: function () { return (window.phantom && window.phantom.solana) || (window.solana && window.solana.isPhantom ? window.solana : null); } },
    { id: "solflare", name: "Solflare", get: function () { return window.solflare && window.solflare.isSolflare ? window.solflare : null; } },
    { id: "backpack", name: "Backpack", get: function () { return window.backpack && window.backpack.isBackpack ? window.backpack : null; } }
  ];

  function slug(s) {
    return String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  }

  function list() {
    var out = [], seen = {};
    for (var i = 0; i < standard.length; i++) {
      var w = standard[i];
      out.push({ id: "std:" + slug(w.name), name: w.name, icon: w.icon || "", _std: w });
      seen[slug(w.name)] = 1;
    }
    for (var j = 0; j < INJECTED.length; j++) {
      var p = INJECTED[j];
      if (seen[p.id]) continue;          // already found via the standard
      var prov = p.get();
      if (prov) out.push({ id: p.id, name: p.name, icon: prov.icon || "", _inj: prov });
    }
    return out;
  }

  function emit(kind) {
    for (var i = 0; i < listeners.length; i++) {
      try { listeners[i](kind, connected); } catch (e) {}
    }
  }

  /* Both paths are normalised to the same shape so callers never branch on
     which kind of wallet they got. */
  function wrapStandard(w) {
    var feat = w.features;
    return feat["standard:connect"].connect().then(function (res) {
      var acct = res.accounts && res.accounts[0];
      if (!acct) throw new Error("no account returned");
      return {
        name: w.name,
        icon: w.icon || "",
        publicKey: acct.address,
        _account: acct,
        /* Wallet Standard signs BYTES and returns bytes — handing it a
         * Transaction object makes the wallet try to iterate it ("e is not
         * iterable" from Phantom). Callers may pass either form; they get
         * back the form they spoke. The object form returns a {serialize}
         * shim because that is the only method our senders call. */
        signTransaction: function (tx) {
          var f = feat["solana:signTransaction"];
          var isBytes = tx instanceof Uint8Array;
          var bytes = isBytes ? tx
            : tx.serialize({ requireAllSignatures: false, verifySignatures: false });
          return f.signTransaction({ account: acct, transaction: bytes })
            .then(function (r) {
              var sb = r[0].signedTransaction;
              return isBytes ? sb : { serialize: function () { return sb; } };
            });
        },
        signAllTransactions: function (txs) {
          var f = feat["solana:signTransaction"];
          var isBytes = txs.length && txs[0] instanceof Uint8Array;
          var inputs = txs.map(function (t) {
            return { account: acct, transaction: isBytes ? t
              : t.serialize({ requireAllSignatures: false, verifySignatures: false }) };
          });
          return f.signTransaction.apply(f, inputs)
            .then(function (r) { return r.map(function (x) {
              var sb = x.signedTransaction;
              return isBytes ? sb : { serialize: function () { return sb; } };
            }); });
        },
        signMessage: function (bytes) {
          var f = feat["solana:signMessage"];
          if (!f) return Promise.reject(new Error(w.name + " cannot sign messages"));
          return f.signMessage({ account: acct, message: bytes })
                  .then(function (r) { return r[0].signature; });
        },
        disconnect: function () {
          var d = feat["standard:disconnect"];
          return d ? d.disconnect() : Promise.resolve();
        }
      };
    });
  }

  function wrapInjected(prov, name) {
    return prov.connect().then(function () {
      var pk = prov.publicKey;
      if (!pk) throw new Error("no account returned");
      return {
        name: name,
        icon: prov.icon || "",
        publicKey: pk.toBase58 ? pk.toBase58() : String(pk),
        _provider: prov,
        signTransaction: function (tx) { return prov.signTransaction(tx); },
        signAllTransactions: function (txs) { return prov.signAllTransactions(txs); },
        signMessage: function (bytes) {
          return prov.signMessage(bytes, "utf8").then(function (r) {
            return r.signature || r;
          });
        },
        disconnect: function () { return prov.disconnect ? prov.disconnect() : Promise.resolve(); }
      };
    });
  }

  function connect(id) {
    var found = null, all = list();
    for (var i = 0; i < all.length; i++) if (all[i].id === id) found = all[i];
    if (!found) return Promise.reject(new Error("wallet not found: " + id));

    var p = found._std ? wrapStandard(found._std) : wrapInjected(found._inj, found.name);
    return p.then(function (w) {
      connected = w;
      // Phantom and friends fire this when the user switches account in the
      // extension. Without it the page keeps signing as the old key.
      var prov = found._inj;
      if (prov && prov.on) {
        prov.on("accountChanged", function (pk) {
          if (!pk) { connected = null; emit("disconnect"); return; }
          connected.publicKey = pk.toBase58 ? pk.toBase58() : String(pk);
          emit("change");
        });
        prov.on("disconnect", function () { connected = null; emit("disconnect"); });
      }
      emit("connect");
      return w;
    });
  }

  function disconnect() {
    if (!connected) return Promise.resolve();
    var w = connected;
    connected = null;
    emit("disconnect");
    return w.disconnect ? w.disconnect() : Promise.resolve();
  }

  window.Wallet = {
    list: list,
    connect: connect,
    disconnect: disconnect,
    current: function () { return connected; },
    on: function (kind, fn) { listeners.push(fn); }
  };
})();
