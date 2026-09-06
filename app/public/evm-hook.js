(function () {
  "use strict";
  /* Token launches and trading on the WAVES V4-hook curve (Robinhood Chain).
   *
   * A DROP-IN for evm-token.js: it exports the same window.MoonpadToken surface
   * (launch / waitForLaunch / adapter / claim / pledge / owed / terms / curveOf /
   * chain), so the launch page, token page and fee page work unchanged — they
   * never learn which curve is underneath. shell.js loads this INSTEAD of
   * evm-wavescurve.js + evm-token.js once the hook is the live path.
   *
   * What differs from the standalone curve it replaces:
   *   - a launch opens a live Uniswap v4 pool from block zero (that is the whole
   *     point — GMGN/DexScreener index it natively), via the singleton hook. Only
   *     the ERC20 deploys per launch; the hook is one audited contract per chain.
   *   - trades go through a public swap ROUTER (chain.v4Router,
   *     contracts/WavesHookRouter.sol), not a direct call on the curve.
   *   - the hook has no quoteBuy/quoteSell view, so getQuote runs the curve math
   *     in JS here — ported byte-for-byte from WavesCurveHook._buy / _sell.
   *   - reads are keyed by PoolId: curves(poolOf(token)), not curves(token).
   *
   * No libraries — hand-encoded calls, same as evm-token.js. Addresses come off
   * the chain entry in evm-chains.js (hook, v4Router), never hard-coded here.
   */

  // ---------------------------------------------------------------- selectors
  // cast-verified against contracts/WavesCurveHook.sol + WavesHookRouter.sol.
  var HOOK_SEL = {
    launch: "44db9ad1",        // launch(string,string,uint16,string,string,string)
    graduate: "ff6d8d05",      // graduate(address)
    pledge: "5ac3e590",        // pledge(address,address,uint16)  (token, keeper, bps)
    claim: "4e71d92d",         // claim()
    curves: "66903e80",        // curves(bytes32)
    poolOf: "988b1fa7",        // poolOf(address) -> bytes32 poolId
    owed: "df18e047",          // owed(address)
    graduationEth: "615bb453",
    virtualEth: "4bd387e1",
    virtualTokens: "1d3dad09",
    curveSupply: "2138a4c0"
  };
  var ROUTER_SEL = {
    buy: "b3ffb760",           // buy(address,uint256,address,uint256)
    sell: "883c18b3"           // sell(address,uint256,uint256,address,uint256)
  };
  var ERC20_SEL = {
    balanceOf: "70a08231",     // balanceOf(address)
    approve: "095ea7b3",       // approve(address,uint256)
    allowance: "dd62ed3e"      // allowance(address,address)
  };

  // keccak("Launched(address,address,uint16,string,string)") — read the new
  // token's address out of the receipt, a tx has no return value. Same event
  // signature the standalone curve used, so the same topic; cast-verified.
  var LAUNCHED_TOPIC = "0xcf74280e4eafa3845516f297991e114213dc6a4c132199d8338fe6ba26b216e4";
  // Bought(address,address,uint256,uint256,uint256) / Sold(...) — the trade feed.
  var BOUGHT_TOPIC = "0x7ce543d1780f3bdc3dac42da06c95da802653cd1b212b8d74ec3e3c33ad7095c";
  var SOLD_TOPIC = "0x9be8a5ca22b7e6e81f04b5879f0248227bb770114291bd47dfaee4c3a82ad60e";

  // ------------------------------------------------------------ abi encoding
  function hex32(v) {
    var s = BigInt(v).toString(16);
    if (s.length > 64) throw new Error("value does not fit in a word");
    return "0".repeat(64 - s.length) + s;
  }
  function addr32(a) {
    var s = String(a || "").toLowerCase().replace(/^0x/, "");
    if (!/^[0-9a-f]{40}$/.test(s)) throw new Error("bad address: " + a);
    return "0".repeat(24) + s;
  }
  function strTail(s) {
    var bytes = new TextEncoder().encode(String(s == null ? "" : s));
    var body = "";
    for (var i = 0; i < bytes.length; i++) body += bytes[i].toString(16).padStart(2, "0");
    var pad = (64 - (body.length % 64)) % 64;
    return hex32(bytes.length) + body + "0".repeat(pad);
  }
  function words(hex) { return hex.length / 64; }

  /* launch(string name, string symbol, uint16 feeBps, string logo,
   *        string description, string socials) — six args, five dynamic.
   * Offsets are counted from the start of the ARGUMENTS. No minTokensOut: the
   * anti-snipe first buy rides on msg.value and the curve prices it atomically. */
  function encodeLaunch(name, symbol, feeBps, logo, description, socials) {
    var tails = [strTail(name), strTail(symbol), strTail(logo), strTail(description), strTail(socials)];
    var head = 6 * 32;
    var off = [], at = head;
    for (var i = 0; i < tails.length; i++) { off.push(at); at += words(tails[i]) * 32; }
    // head order: name, symbol, feeBps(value), logo, description, socials
    return "0x" + HOOK_SEL.launch +
      hex32(off[0]) + hex32(off[1]) + hex32(feeBps) + hex32(off[2]) + hex32(off[3]) + hex32(off[4]) +
      tails.join("");
  }

  // ------------------------------------------------------------ abi decoding
  function wordAt(hex, i) { var s = String(hex || "").replace(/^0x/, ""); return s.slice(i * 64, (i + 1) * 64); }
  function uintAt(hex, i) { return BigInt("0x" + (wordAt(hex, i) || "0")); }
  function addrAt(hex, i) { return "0x" + wordAt(hex, i).slice(24); }

  /* curves(bytes32) → the Curve struct. NINE words: a `full` latch (set when
   * raised first reaches graduationEth) sits between tokensLeft and graduated. */
  function decodeCurve(hex) {
    if (!hex || hex === "0x") return null;
    return {
      token: addrAt(hex, 0),
      creator: addrAt(hex, 1),
      feeBps: Number(uintAt(hex, 2)),
      rewardsBps: Number(uintAt(hex, 3)),
      keeper: addrAt(hex, 4),
      raised: uintAt(hex, 5),
      tokensLeft: uintAt(hex, 6),
      full: uintAt(hex, 7) === 1n,
      graduated: uintAt(hex, 8) === 1n
    };
  }

  // ------------------------------------------------------------------ wiring
  function chain() {
    var id = (window.BRAND && window.BRAND.evmChainId) || 4663;
    var all = window.MOONPAD_CHAINS || [];
    for (var i = 0; i < all.length; i++) if (all[i].id === id) return all[i];
    throw new Error("chain " + id + " is not in evm-chains.js");
  }

  /* The singleton hook every launch on this chain goes through. Null until it is
   * deployed and recorded — the launch UI gates on this, refusing rather than
   * pointing a creator's gas at address zero. */
  function hookAddress() {
    var a = chain().hook || null;
    if (!a) throw new Error(
      "No WavesCurveHook is deployed on " + chain().name + " yet. Deploy " +
      "contracts/WavesCurveHook.sol and set `hook` on this chain's entry in evm-chains.js.");
    return a;
  }
  function routerAddress() {
    var r = chain().v4Router || null;
    if (!r) throw new Error(
      "No swap router on " + chain().name + " yet — deploy contracts/WavesHookRouter.sol " +
      "and set `v4Router` on this chain's entry in evm-chains.js.");
    return r;
  }

  function provider() {
    var p = window.ethereum;
    if (!p) throw new Error("No wallet found in this browser.");
    return p;
  }

  function read(data, to) {
    return window.MoonpadRPC.send(chain().rpc, "eth_call", [{ to: to || hookAddress(), data: data }, "latest"]);
  }

  async function send(from, tx) {
    tx.from = from;
    try {
      var gas = await provider().request({ method: "eth_estimateGas", params: [tx] });
      tx.gas = "0x" + ((BigInt(gas) * 12n) / 10n).toString(16);
    } catch (e) {
      throw new Error(reason(e));
    }
    await priceTx(tx);
    return provider().request({ method: "eth_sendTransaction", params: [tx] });
  }

  async function priceTx(tx) {
    try {
      var block = await provider().request({ method: "eth_getBlockByNumber", params: ["latest", false] });
      var base = BigInt((block && block.baseFeePerGas) || 0);
      if (base > 0n) {
        var tip = 0n;
        try { tip = BigInt(await provider().request({ method: "eth_maxPriorityFeePerGas", params: [] })); } catch (e) {}
        if (tip <= 0n) tip = base / 10n + 1n;
        tx.maxPriorityFeePerGas = "0x" + tip.toString(16);
        tx.maxFeePerGas = "0x" + (base * 3n + tip).toString(16);
        return tx;
      }
      var gp = BigInt(await provider().request({ method: "eth_gasPrice", params: [] }));
      if (gp > 0n) tx.gasPrice = "0x" + (gp * 2n).toString(16);
    } catch (e) {}
    return tx;
  }

  /* Custom errors are four bytes on the wire — turn them into something a person
   * can act on. Selectors cast-verified against the hook + router. */
  var ERRORS = {
    "0x917f1a53": "That fee tier is not one of the rungs.",
    "0x8698bf37": "That token was not launched here.",
    "0xe6a0d45f": "That token has already graduated — trade it on its pool instead.",
    "0xd98e1888": "The curve is full — it has to graduate before it can take more.",
    "0xb0ca2ff5": "Rewards are already pledged, and a pledge cannot be changed.",
    "0xc9f52c71": "The price moved past your slippage limit.",
    "0x203d82d8": "The transaction sat too long and expired — try again.",
    "0x1f2a2005": "Amount cannot be zero.",
    "0x90b8ec18": "A token transfer failed.",
    "0xf7ebfa18": "Exact-output swaps are not supported — set the amount you are spending."
  };
  function reason(e) {
    var msg = (e && (e.message || e.data || "")) + "";
    for (var k in ERRORS) if (msg.indexOf(k) !== -1) return ERRORS[k];
    var m = msg.match(/reverted[^:]*:?\s*(.*)$/i);
    return "The transaction would fail: " + ((m && m[1]) || msg).slice(0, 200);
  }

  function defaultDeadline() { return Math.floor(Date.now() / 1000) + 1200; } // +20 min

  // ------------------------------------------------------------------ launch
  /* Open a pool on the hook, optionally buying on the same transaction. The dev
   * buy rides on msg.value — that atomic first buy IS the anti-snipe, closing the
   * block-zero window a sniper would otherwise have. Rewards are pledged later
   * from the fee page, not here (a keeper the creator has never signed for trips
   * wallet drainer heuristics — same lesson as the Solana side). */
  async function launch(opts) {
    opts = opts || {};
    var from = opts.from || await window.MoonpadLaunch.connect();
    await window.MoonpadLaunch.switchChain(chain().id);
    var value = BigInt(opts.devBuyWei || 0);
    var data = encodeLaunch(opts.name, opts.symbol, opts.feeBps,
      opts.logo || "", opts.description || "", opts.socials || "");
    var hash = await send(from, { to: hookAddress(), data: data, value: "0x" + value.toString(16) });
    return { hash: hash, chain: chain() };
  }

  async function waitForLaunch(hash) {
    var c = chain();
    for (var i = 0; i < 120; i++) {
      var res = await window.MoonpadRPC.send(c.rpc, "eth_getTransactionReceipt", [hash]).catch(function () { return null; });
      if (res) {
        if (res.status === "0x0") throw new Error("The launch transaction reverted");
        var logs = res.logs || [];
        for (var j = 0; j < logs.length; j++) {
          var lg = logs[j];
          if (!lg.topics || lg.topics.length < 3) continue;
          if (String(lg.topics[0]).toLowerCase() !== LAUNCHED_TOPIC) continue;
          var token = "0x" + String(lg.topics[1]).replace(/^0x/, "").slice(24);
          return {
            token: token,
            creator: "0x" + String(lg.topics[2]).replace(/^0x/, "").slice(24),
            explorer: c.explorer + "/address/" + token,
            hash: hash,
            block: parseInt(res.blockNumber, 16)
          };
        }
        throw new Error("The launch succeeded but no token address was in the receipt.");
      }
      await new Promise(function (r) { setTimeout(r, 2500); });
    }
    throw new Error("Still not confirmed after five minutes — check the explorer");
  }

  // ------------------------------------------------------------------- trade
  /* Buy through the router: it delivers the curve amount to `from` and refunds
   * any boundary overfill in the same tx. minTokensOut is the slippage floor. */
  async function buy(token, wei, minTokensOut, from) {
    from = from || await window.MoonpadLaunch.connect();
    await window.MoonpadLaunch.switchChain(chain().id);
    var data = "0x" + ROUTER_SEL.buy + addr32(token) + hex32(minTokensOut || 0) + addr32(from) + hex32(defaultDeadline());
    return send(from, { to: routerAddress(), data: data, value: "0x" + BigInt(wei).toString(16) });
  }

  async function sell(token, amount, minWeiOut, from) {
    from = from || await window.MoonpadLaunch.connect();
    await window.MoonpadLaunch.switchChain(chain().id);
    var data = "0x" + ROUTER_SEL.sell + addr32(token) + hex32(amount) + hex32(minWeiOut || 0) + addr32(from) + hex32(defaultDeadline());
    return send(from, { to: routerAddress(), data: data, value: "0x0" });
  }

  // Selling needs the ROUTER approved to move the seller's tokens.
  async function allowance(token, owner) {
    var out = await read("0x" + ERC20_SEL.allowance + addr32(owner) + addr32(routerAddress()), token);
    return uintAt(out, 0);
  }
  async function approve(token, amount, from) {
    from = from || await window.MoonpadLaunch.connect();
    await window.MoonpadLaunch.switchChain(chain().id);
    return send(from, { to: token, data: "0x" + ERC20_SEL.approve + addr32(routerAddress()) + hex32(amount), value: "0x0" });
  }

  /* Take what you are owed. The hook pays owed[msg.sender] to the caller; there
   * is no claim-to-another-address on the hook, so `to` is honoured only when it
   * is the caller's own wallet (the fee page passes the connected wallet). */
  async function claim(from, to) {
    from = from || await window.MoonpadLaunch.connect();
    await window.MoonpadLaunch.switchChain(chain().id);
    if (to && String(to).toLowerCase() !== String(from).toLowerCase()) {
      throw new Error("This chain pays fees to the wallet that claims them — connect that wallet to claim.");
    }
    return send(from, { to: hookAddress(), data: "0x" + HOOK_SEL.claim, value: "0x0" });
  }

  /* Pledge a share of the creator's fees to holders. hook.pledge(token, keeper,
   * bps) — note the arg order differs from the standalone curve. One way. */
  async function pledgeToHolders(token, bps, keeper, from) {
    from = from || await window.MoonpadLaunch.connect();
    await window.MoonpadLaunch.switchChain(chain().id);
    var data = "0x" + HOOK_SEL.pledge + addr32(token) + addr32(keeper) + hex32(bps);
    return send(from, { to: hookAddress(), data: data, value: "0x0" });
  }

  async function graduate(token, from) {
    from = from || await window.MoonpadLaunch.connect();
    await window.MoonpadLaunch.switchChain(chain().id);
    return send(from, { to: hookAddress(), data: "0x" + HOOK_SEL.graduate + addr32(token), value: "0x0" });
  }

  // -------------------------------------------------------------------- read
  async function poolIdOf(token) {
    var out = await read("0x" + HOOK_SEL.poolOf + addr32(token));
    var id = "0x" + wordAt(out, 0);
    return /^0x0{64}$/.test(id) ? null : id;
  }

  async function curveOf(token) {
    var pool = await poolIdOf(token);
    if (!pool) return null;
    return decodeCurve(await read("0x" + HOOK_SEL.curves + pool.replace(/^0x/, "")));
  }

  async function owed(who) {
    return uintAt(await read("0x" + HOOK_SEL.owed + addr32(who)), 0);
  }

  async function balanceOf(token, who) {
    return uintAt(await read("0x" + ERC20_SEL.balanceOf + addr32(who), token), 0);
  }

  /* The hook's immutable terms, read from the contract. */
  async function terms() {
    var g = uintAt(await read("0x" + HOOK_SEL.graduationEth), 0);
    var ve = uintAt(await read("0x" + HOOK_SEL.virtualEth), 0);
    var vt = uintAt(await read("0x" + HOOK_SEL.virtualTokens), 0);
    var cs = uintAt(await read("0x" + HOOK_SEL.curveSupply), 0);
    return { graduationEth: g, virtualEth: ve, virtualTokens: vt, curveSupply: cs };
  }

  /* quoteBuy / quoteSell — the hook has no on-chain quote view, so the curve
   * math is run here. Ported byte-for-byte from WavesCurveHook._buy / _sell
   * (integer division throughout; BigInt matches the EVM). */
  function quoteBuyPure(c, t, value) {
    var room = c.raised >= t.graduationEth ? 0n : t.graduationEth - c.raised;
    if (room === 0n) return 0n;
    var accepted = BigInt(value);
    var feeBps = BigInt(c.feeBps);
    var fee = (accepted * feeBps) / 10000n;
    var inAfterFee = accepted - fee;
    if (inAfterFee > room) inAfterFee = room;
    var sold = t.curveSupply - c.tokensLeft;
    var x = t.virtualEth + c.raised;
    var y = t.virtualTokens - sold;
    var out = y - ((t.virtualEth * t.virtualTokens) / (x + inAfterFee));
    if (out > c.tokensLeft) out = c.tokensLeft;
    return out;
  }
  function quoteSellPure(c, t, amount) {
    amount = BigInt(amount);
    var sold = t.curveSupply - c.tokensLeft;
    var x = t.virtualEth + c.raised;
    var y = t.virtualTokens - sold;
    var back = (t.virtualEth * t.virtualTokens) / (y + amount);
    var gross = back >= x ? 0n : x - back;
    if (gross > c.raised) gross = c.raised;
    var fee = (gross * BigInt(c.feeBps)) / 10000n;
    return gross - fee;
  }
  async function quoteBuy(token, wei) {
    var c = await curveOf(token); var t = await terms();
    if (!c) return 0n;
    return quoteBuyPure(c, t, wei);
  }
  async function quoteSell(token, amount) {
    var c = await curveOf(token); var t = await terms();
    if (!c) return 0n;
    return quoteSellPure(c, t, amount);
  }
  async function progressBps(token) {
    var c = await curveOf(token); var t = await terms();
    if (!c || t.graduationEth === 0n) return 0;
    var p = Number((c.raised * 10000n) / t.graduationEth);
    return p > 10000 ? 10000 : p;
  }
  async function ready(token) {
    var c = await curveOf(token);
    return !!(c && !/^0x0{40}$/.test(c.creator));
  }

  // ----------------------------------------------------------------- adapter
  function toWei(amount) {
    var n = Number(amount) || 0;
    if (n <= 0) return 0n;
    return BigInt(Math.round(n * 1e9)) * 1000000000n;
  }
  function fromWei(v) { return Number(v) / 1e18; }
  var SLIPPAGE_BPS = 200;
  function withSlippage(v) { return (BigInt(v) * BigInt(10000 - SLIPPAGE_BPS)) / 10000n; }

  async function waitForTx(hash) {
    var c = chain();
    for (var i = 0; i < 120; i++) {
      var r = await window.MoonpadRPC.send(c.rpc, "eth_getTransactionReceipt", [hash]).catch(function () { return null; });
      if (r) {
        if (r.status === "0x0") throw new Error("The transaction reverted");
        return r;
      }
      await new Promise(function (s) { setTimeout(s, 2000); });
    }
    throw new Error("Not confirmed after four minutes — check the explorer");
  }

  function adapter() {
    return {
      evm: true,

      balanceOf: async function (token) {
        var who = (window.MoonpadWallet || {}).account;
        if (!who) return 0;
        return fromWei(await balanceOf(token, who));
      },

      getQuote: async function (token, amount, side) {
        var inWei = toWei(amount);
        if (inWei <= 0n) throw new Error("Enter an amount.");
        var c = await curveOf(token); var t = await terms();
        if (!c) throw new Error("That token was not launched here.");
        if (side === "buy") {
          var out = quoteBuyPure(c, t, inWei);
          if (out <= 0n) throw new Error("The curve cannot fill that — it may be full.");
          return { out: fromWei(out), amountIn: inWei, minOut: withSlippage(out) };
        }
        var back = quoteSellPure(c, t, inWei);
        if (back <= 0n) throw new Error("That is too small to move the curve.");
        return { out: fromWei(back), amountIn: inWei, minOut: withSlippage(back) };
      },

      swap: async function (token, side, amountIn, minOut) {
        var from = await window.MoonpadLaunch.connect();
        if (side === "buy") return buy(token, amountIn, minOut, from);
        // sell needs the ROUTER approved, mined before the sell is sent.
        var have = await allowance(token, from);
        if (have < BigInt(amountIn)) {
          await waitForTx(await approve(token, amountIn, from));
        }
        return sell(token, amountIn, minOut, from);
      },

      readMarket: async function (token) {
        var c = await curveOf(token);
        if (!c || /^0x0{40}$/.test(c.creator)) throw new Error("That token was not launched here.");
        var t = await terms();
        var supply = fromWei(t.curveSupply);
        var pool = await poolIdOf(token);
        var x = t.virtualEth + c.raised;
        var sold = t.curveSupply - c.tokensLeft;
        var y = t.virtualTokens - sold;
        var price = y > 0n ? fromWei(x) / fromWei(y) : null;
        var raised = fromWei(c.raised);
        var threshold = fromWei(t.graduationEth);
        return {
          pool: pool,
          migrated: c.graduated,
          raised: raised,
          threshold: threshold,
          progress: threshold > 0 ? Math.min(1, raised / threshold) : 0,
          price: price,
          supply: supply,
          mcap: price != null ? price * supply : null,
          quote: "ETH",
          creator: c.creator,
          feeBps: c.feeBps,
          rewardsBps: c.rewardsBps
        };
      },

      /* Recent trades off the hook's own Bought/Sold events (same signatures as
       * the standalone curve, so the same topics). RECENT, not complete — RH
       * caps getLogs, so this walks back in bounded chunks. Real history is
       * /api/indexer's job. Timestamps interpolated from the head block. */
      recentTrades: async function (token, limit) {
        limit = limit || 15;
        var c = chain();
        var CHUNK = 50000n, MAX_CHUNKS = 6;
        var latest = BigInt(await window.MoonpadRPC.send(c.rpc, "eth_blockNumber", []));
        var head = await window.MoonpadRPC.send(c.rpc, "eth_getBlockByNumber", ["0x" + latest.toString(16), false]);
        var headTs = Number(BigInt(head.timestamp)) * 1000;
        var MS_PER_BLOCK = 104;
        var tokenTopic = "0x" + addr32(token);
        var out = [];
        for (var i = 0; i < MAX_CHUNKS && out.length < limit; i++) {
          var to = latest - CHUNK * BigInt(i);
          if (to <= 0n) break;
          var from = to > CHUNK ? to - CHUNK + 1n : 0n;
          var logs;
          try {
            logs = await window.MoonpadRPC.send(c.rpc, "eth_getLogs", [{
              address: hookAddress(),
              fromBlock: "0x" + from.toString(16),
              toBlock: "0x" + to.toString(16),
              topics: [[BOUGHT_TOPIC, SOLD_TOPIC], tokenTopic]
            }]);
          } catch (e) { break; }
          for (var j = logs.length - 1; j >= 0 && out.length < limit; j--) {
            var lg = logs[j];
            var isBuy = String(lg.topics[0]).toLowerCase() === BOUGHT_TOPIC;
            var d = String(lg.data || "").replace(/^0x/, "");
            var w = function (n) { return BigInt("0x" + (d.slice(n * 64, n * 64 + 64) || "0")); };
            out.push({
              sig: lg.transactionHash,
              side: isBuy ? "buy" : "sell",
              who: "0x" + String(lg.topics[2]).replace(/^0x/, "").slice(24),
              sol: fromWei(isBuy ? w(0) : w(1)),
              tokens: fromWei(isBuy ? w(1) : w(0)),
              at: headTs - Number(latest - BigInt(lg.blockNumber)) * MS_PER_BLOCK
            });
          }
        }
        return out;
      },

      rewardsActive: async function (token) {
        var c = await curveOf(token);
        return !!(c && c.rewardsBps > 0);
      },

      txUrl: function (hash) { return chain().explorer + "/tx/" + hash; }
    };
  }

  window.MoonpadToken = {
    adapter: adapter,
    waitForTx: waitForTx,
    launch: launch,
    waitForLaunch: waitForLaunch,
    buy: buy,
    sell: sell,
    approve: approve,
    allowance: allowance,
    claim: claim,
    pledgeToHolders: pledgeToHolders,
    graduate: graduate,
    curveOf: curveOf,
    quoteBuy: quoteBuy,
    quoteSell: quoteSell,
    progressBps: progressBps,
    ready: ready,
    owed: owed,
    poolIdOf: poolIdOf,
    balanceOf: balanceOf,
    terms: terms,
    // the hook is the "curve" this chain launches on; the launch UI gates on it
    curveAddress: function () { try { return hookAddress(); } catch (e) { return null; } },
    hookAddress: function () { try { return hookAddress(); } catch (e) { return null; } },
    routerAddress: function () { try { return routerAddress(); } catch (e) { return null; } },
    chain: chain,
    // exported for tests
    encodeLaunch: encodeLaunch,
    decodeCurve: decodeCurve,
    LAUNCHED_TOPIC: LAUNCHED_TOPIC
  };
})();
