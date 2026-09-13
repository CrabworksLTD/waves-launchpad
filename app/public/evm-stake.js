/* The Robinhood-side claim view for a paired collection's reward vault.
 *
 * A token paired at launch routes its trading fees, through the NFT keeper, into
 * a MoonpadVault (contracts/MoonpadVault.sol). An NFT holder ACTIVATES a token
 * by burning the creator's set amount of the paired coin, and thereafter CLAIMS
 * an equal share (weight 1, "flat per NFT") of everything the vault has taken in.
 *
 * Everything here reads and writes the vault + the collection directly through
 * the vault.js selectors — no new contract, no registry. Reached as:
 *   /stake?vault=0x…            the vault directly
 *   /stake?collection=0x…       resolve the vault off the collection record
 *   /stake?token=0x…            resolve it off the token record
 *
 * Requires evm-chains.js, evm-contract.js, evm-collections.js, vault.js and the
 * shared wallet/rpc from the EVM stack. */
(function () {
  "use strict";

  var esc = window.UI.esc, shortAddr = window.UI.shortAddr;
  var $ = function (id) { return document.getElementById(id); };
  var chain = function () { return window.EvmCollections.chain(); };
  var VSEL = (window.MOONPAD_VAULT || {}).selectors || {};
  var DROP = (window.MOONPAD_CONTRACT || {}).selectors || {};

  var SEL_APPROVE = "095ea7b3";   // ERC20 approve(address,uint256)
  var SEL_SYMBOL = "0x95d89b41";
  var SEL_ALLOWANCE = "0xdd62ed3e"; // allowance(owner,spender)

  var vsel = function (sig) { var s = VSEL[sig]; return s ? "0x" + s : null; };
  var dsel = function (sig) { var s = DROP[sig]; return s ? "0x" + s : null; };

  var word = function (n) { return BigInt(n).toString(16).padStart(64, "0"); };
  var addr32 = function (a) { return String(a).replace(/^0x/, "").toLowerCase().padStart(64, "0"); };
  var toBig = function (h) { try { return BigInt(h); } catch (e) { return 0n; } };
  var addrAt = function (h) { return "0x" + String(h).replace(/^0x/, "").slice(24, 64); };

  function rpc(method, params) { return window.MoonpadRPC.send(chain().rpc, method, params); }
  function call(to, data) { return window.MoonpadRPC.call(chain().rpc, to, data); }
  function decodeString(hex) {
    var h = (hex || "").replace(/^0x/, "");
    if (h.length < 128) return "";
    var len = parseInt(h.slice(64, 128), 16), out = "";
    for (var i = 128; i < 128 + len * 2; i += 2) out += String.fromCharCode(parseInt(h.substr(i, 2), 16));
    try { return decodeURIComponent(escape(out)); } catch (e) { return out; }
  }
  function fmtEth(wei) { return window.EvmCollections.fmtEth(wei); }
  // human amount of an 18-dec coin, compact
  function fmtCoin(wei) {
    var n = Number(BigInt(wei) / (10n ** 12n)) / 1e6;
    if (n >= 1e9) return (n / 1e9).toFixed(2) + "B";
    if (n >= 1e6) return (n / 1e6).toFixed(2) + "M";
    if (n >= 1e3) return (n / 1e3).toFixed(1) + "K";
    return String(Math.round(n));
  }

  var V = null;        // vault address
  var st = null;       // { collection, coin, coinSym, cost, payToken, totalWeight }
  var mine = [];       // [{ id, active, owed }]
  var owner = null;

  function say(kind, html) {
    var m = $("es-msg"); if (!m) return;
    m.className = "msg " + (kind || "");
    m.innerHTML = html || "";
  }

  /* Which vault to show. A direct ?vault wins; otherwise match the collection or
   * token against the recorded paired launches (the same records the keeper
   * reads), which carry the vault address. */
  async function resolveVault() {
    var q = new URLSearchParams(location.search);
    var direct = q.get("vault");
    if (direct && /^0x[0-9a-fA-F]{40}$/.test(direct)) return { vault: direct.toLowerCase() };

    var coll = (q.get("collection") || "").toLowerCase();
    var tok = (q.get("token") || "").toLowerCase();
    var toks = await fetch("/api/tokens").then(function (r) { return r.json(); })
      .then(function (j) { return j.tokens || []; }).catch(function () { return []; });
    var hit = toks.find(function (t) {
      if (t.keeper !== "nft" || !t.vault) return false;
      return (tok && String(t.mint).toLowerCase() === tok) ||
             (coll && String(t.pairedCollection || "").toLowerCase() === coll);
    });
    if (hit) return { vault: String(hit.vault).toLowerCase() };

    // last resort: the collection record itself may carry the vault
    if (coll) {
      var cols = await fetch("/api/collections").then(function (r) { return r.json(); })
        .then(function (j) { return j.collections || []; }).catch(function () { return []; });
      var c = cols.find(function (x) { return String(x.address || "").toLowerCase() === coll && x.vault; });
      if (c) return { vault: String(c.vault).toLowerCase() };
    }
    return null;
  }

  async function readVault() {
    var collection = addrAt(await call(V, vsel("collection()")));
    var coin = addrAt(await call(V, vsel("coin()")).catch(function () { return "0x" + "0".repeat(64); }));
    var payToken = addrAt(await call(V, vsel("payToken()")).catch(function () { return "0x" + "0".repeat(64); }));
    var cost = toBig(await call(V, vsel("tierCost(uint256)") + word(0)));   // tier 1 = index 0
    var totalWeight = toBig(await call(V, vsel("totalWeight()")));
    var coinSym = "";
    try { coinSym = decodeString(await call(coin, SEL_SYMBOL)); } catch (e) {}
    st = { collection: collection, coin: coin, coinSym: coinSym || "TOKEN",
           payToken: payToken, cost: cost, totalWeight: totalWeight };
  }

  // The caller's NFTs from this collection, with each one's vault state.
  async function readMine() {
    mine = [];
    if (!owner) return;
    var bal = Number(toBig(await call(st.collection, dsel("balanceOf(address)") + addr32(owner))));
    var n = Math.min(bal, 200);
    for (var i = 0; i < n; i++) {
      var idHex = await call(st.collection, dsel("tokenOfOwnerByIndex(address,uint256)") + addr32(owner) + word(i))
        .catch(function () { return null; });
      if (!idHex) continue;
      var id = toBig(idHex);
      var active = toBig(await call(V, vsel("isActive(uint256)") + word(id))) === 1n;
      var owed = active ? toBig(await call(V, vsel("owed(uint256)") + word(id))) : 0n;
      mine.push({ id: id, active: active, owed: owed });
    }
  }

  function render() {
    var box = $("es-root");
    if (!box) return;
    var owedTotal = mine.reduce(function (a, m) { return a + m.owed; }, 0n);
    var inactive = mine.filter(function (m) { return !m.active; });
    var claimable = mine.filter(function (m) { return m.owed > 0n; });
    var payLabel = /^0x0+$/.test(st.payToken) ? "ETH" : shortAddr(st.payToken);

    box.innerHTML =
      '<div class="mn-card">' +
        '<div class="mn-ident"><div><b>Reward vault</b>' +
        '<div class="k2 mono">' + esc(shortAddr(V)) + " · collection " + esc(shortAddr(st.collection)) + "</div></div></div>" +
        '<p class="sub" style="margin-top:10px">Activate an NFT by burning <b>' + esc(fmtCoin(st.cost)) +
        " $" + esc(st.coinSym) + "</b>. Each activated NFT then earns an equal share of the fees, paid in " +
        payLabel + ". Selling the NFT stops its rewards automatically.</p>" +
      "</div>" +
      '<div class="mn-card">' +
        (owner
          ? ('<div class="mn-pos"><div><b>' + mine.length + "</b><i>NFTs held</i></div>" +
             "<div><b>" + mine.filter(function (m) { return m.active; }).length + "</b><i>activated</i></div>" +
             '<div><b class="lime">' + esc(fmtEth(owedTotal)) + " " + payLabel + "</b><i>unclaimed</i></div></div>" +
             '<div class="acts" style="margin-top:14px">' +
               '<button class="go" id="es-activate"' + (inactive.length ? "" : " disabled") + ">Activate " +
                 (inactive.length || "") + (inactive.length ? " · burn " + esc(fmtCoin(st.cost * BigInt(inactive.length))) + " $" + esc(st.coinSym) : "") + "</button>" +
               '<button class="go" id="es-claim"' + (claimable.length ? "" : " disabled") + ">Claim" +
                 (owedTotal > 0n ? " " + esc(fmtEth(owedTotal)) + " " + payLabel : "") + "</button>" +
             "</div>" +
             (mine.length ? "" : '<p class="mn-fine">You hold no NFTs from this collection.</p>'))
          : '<p class="sub">Connect your wallet to see your NFTs and what you can claim.</p>' +
            '<div class="acts"><button class="go" id="es-connect">Connect wallet</button></div>') +
        '<p class="msg" id="es-msg" style="margin-top:12px"></p>' +
      "</div>";

    if ($("es-connect")) $("es-connect").onclick = connect;
    if ($("es-activate")) $("es-activate").onclick = function () { doActivate(inactive.map(function (m) { return m.id; })); };
    if ($("es-claim")) $("es-claim").onclick = function () { doClaim(claimable.map(function (m) { return m.id; })); };
  }

  function provider() { return window.MOONPAD_ETH(); }

  async function priceTx(tx) {
    try {
      var base = toBig(await rpc("eth_gasPrice", []));
      tx.maxFeePerGas = "0x" + (base * 3n + 1n).toString(16);
      tx.maxPriorityFeePerGas = "0x" + (base / 10n + 1n).toString(16);
    } catch (e) {}
    try { tx.gas = "0x" + (toBig(await rpc("eth_estimateGas", [tx])) * 12n / 10n).toString(16); } catch (e) {}
    return tx;
  }
  async function sendTx(to, data, value) {
    var tx = { from: owner, to: to, value: "0x" + (value || 0n).toString(16), data: data };
    await priceTx(tx);
    var hash = await provider().request({ method: "eth_sendTransaction", params: [tx] });
    for (var i = 0; i < 90; i++) {
      var r = await rpc("eth_getTransactionReceipt", [hash]).catch(function () { return null; });
      if (r) { if (r.status !== "0x1") throw new Error("The transaction reverted."); return r; }
      await new Promise(function (res) { setTimeout(res, 2000); });
    }
    throw new Error("Taking a while — check the explorer.");
  }

  // dynamic-array calldata: SEL + head + array(length + words)
  function encActivateMany(ids, tier) {
    return vsel("activateMany(uint256[],uint8)") + word(0x40) + word(tier) +
      word(ids.length) + ids.map(word).join("");
  }
  function encClaimMany(ids, to) {
    return vsel("claimMany(uint256[],address)") + word(0x40) + addr32(to) +
      word(ids.length) + ids.map(word).join("");
  }

  async function ensureConnected() {
    await window.Shell.ensureEvmStack();
    var w = window.Shell ? await window.Shell.connect() : null;
    owner = (window.MoonpadWallet || {}).account || w || null;
    if (owner) await window.MOONPAD_SWITCH_CHAIN(chain());
    return owner;
  }
  async function connect() {
    say("", "");
    if (!(await ensureConnected())) return;
    await refresh();
  }

  async function doActivate(ids) {
    if (!ids.length) return;
    say("", "");
    try {
      if (!(await ensureConnected())) return;
      var total = st.cost * BigInt(ids.length);
      if (total > 0n) {
        // allowance first — approve the vault to burn the coin, only if short
        var have = toBig(await call(st.coin, SEL_ALLOWANCE + addr32(owner) + addr32(V)));
        if (have < total) {
          say("", "Approve the burn in your wallet…");
          await sendTx(st.coin, "0x" + SEL_APPROVE + addr32(V) + word(total), 0n);
        }
      }
      say("", "Confirm the activation…");
      await sendTx(V, ids.length === 1
        ? vsel("activate(uint256,uint8)") + word(ids[0]) + word(1)
        : encActivateMany(ids, 1), 0n);
      say("ok", "Activated. Rewards accrue from now.");
      await refresh();
    } catch (e) {
      var m = String((e && e.message) || e);
      say("err", esc(/reject|denied|cancel/i.test(m) ? "You cancelled." : m.slice(0, 200)));
    }
  }

  async function doClaim(ids) {
    if (!ids.length) return;
    say("", "");
    try {
      if (!(await ensureConnected())) return;
      say("", "Confirm the claim…");
      await sendTx(V, ids.length === 1
        ? vsel("claim(uint256,address)") + word(ids[0]) + addr32(owner)
        : encClaimMany(ids, owner), 0n);
      say("ok", "Claimed.");
      await refresh();
    } catch (e) {
      var m = String((e && e.message) || e);
      say("err", esc(/reject|denied|cancel/i.test(m) ? "You cancelled." : m.slice(0, 200)));
    }
  }

  async function refresh() {
    owner = (window.MoonpadWallet || {}).account || owner;
    await readMine();
    render();
  }

  window.EvmStakePage = {
    init: async function () {
      var root = $("es-root");
      if (!root) return;
      root.innerHTML = '<p class="sub">Loading the vault…</p>';
      var r = await resolveVault().catch(function () { return null; });
      if (!r) { root.innerHTML = '<div class="none">No reward vault for that address. Open this from a paired collection.</div>'; return; }
      V = r.vault;
      try { await readVault(); } catch (e) {
        root.innerHTML = '<div class="none">Could not read that vault on ' + esc(chain().name) + ".</div>";
        return;
      }
      owner = (window.MoonpadWallet || {}).account || null;
      if (owner) await readMine();
      render();
    }
  };
})();
