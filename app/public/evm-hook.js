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
    launch: "04156aaa",        // launch(string,string,uint16,string,string,string,address,uint256)
    graduate: "ff6d8d05",      // graduate(address)
    pledge: "5ac3e590",        // pledge(address,address,uint16)  (token, keeper, bps)
    claim: "1e83409a",         // claim(address quote)
    curves: "66903e80",        // curves(bytes32)
    poolOf: "988b1fa7",        // poolOf(address) -> bytes32 poolId
    owed: "28079e4a",          // owed(address who, address quote)
    approvedQuotes: "dc8255c4",// approvedQuotes(address) -> (bool enabled, uint96 grad)
    graduationEth: "615bb453",
    virtualEth: "4bd387e1",
    virtualTokens: "1d3dad09",
    curveSupply: "2138a4c0"
  };
  var ROUTER_SEL = {
    buy: "09aa45a0",           // buy(address token,address quote,uint256 quoteIn,uint256 minOut,address to,uint256 deadline)
    sell: "2e1448af"           // sell(address token,address quote,uint256 tokensIn,uint256 minOut,address to,uint256 deadline)
  };
  // WavesQuoteAggregator — pay ETH, land a quote-paired token (ETH -> quote -> token).
  var AGG_SEL = {
    buyWithEth: "1b138b93",    // buyWithEth(token,quote,legKey,minQuoteOut,minTokensOut,to,deadline)
    buyWithEth2: "1e27d17f"    // buyWithEth2(token,quote,ethToMid,midToQuote,minQuoteOut,minTokensOut,to,deadline)
  };
  // WavesSwapRouter — ETH -> quote (one hop) or ETH -> USDG -> quote (two hops).
  var SWAP_SEL = {
    swap: "4ea88ad7",          // swap(PoolKey,uint256 minOut,address recipient)
    swap2: "e235cc1c"          // swap2(PoolKey,PoolKey,uint256 minOut,address recipient)
  };
  // WavesSellRouter — sell a quote-paired token straight to ETH (token -> quote
  // via the hook router -> ETH via the quote's ETH pool), one tx.
  var SELL_SEL = {
    sellForEth: "6acc7d6a"     // sellForEth(token,quote,tokensIn,ethQuoteKey,minEthOut,to,deadline)
  };
  var ERC20_SEL = {
    balanceOf: "70a08231",     // balanceOf(address)
    approve: "095ea7b3",       // approve(address,uint256)
    allowance: "dd62ed3e",     // allowance(address,address)
    decimals: "313ce567"       // decimals()
  };

  // keccak("Launched(address,address,address,uint16,string,string)") — read the
  // new token's address out of the receipt, a tx has no return value. The quote
  // asset is now an indexed topic (topics[3]); token/creator stay topics[1..2].
  var LAUNCHED_TOPIC = "0x3973e202aee548fc3ec9b963ffa955e8e07b2f7756adf81f9b237e43a399e8bf";
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
   *        string description, string socials, address quote, uint256 firstBuy)
   * — eight args, five dynamic, three static (feeBps, quote, firstBuy). Offsets
   * are counted from the start of the ARGUMENTS (head = 8 words). For an ETH
   * quote the atomic first buy rides on msg.value and firstBuy is 0; for an
   * ERC-20 quote firstBuy is the pre-acquired quote amount (msg.value 0). */
  function encodeLaunch(name, symbol, feeBps, logo, description, socials, quote, firstBuy) {
    var tails = [strTail(name), strTail(symbol), strTail(logo), strTail(description), strTail(socials)];
    var head = 8 * 32;
    var off = [], at = head;
    for (var i = 0; i < tails.length; i++) { off.push(at); at += words(tails[i]) * 32; }
    // head: name, symbol, feeBps(value), logo, description, socials, quote(addr), firstBuy(value)
    return "0x" + HOOK_SEL.launch +
      hex32(off[0]) + hex32(off[1]) + hex32(feeBps) + hex32(off[2]) + hex32(off[3]) + hex32(off[4]) +
      addr32(quote || "0x0000000000000000000000000000000000000000") + hex32(firstBuy || 0) +
      tails.join("");
  }

  // ------------------------------------------------------------ abi decoding
  function wordAt(hex, i) { var s = String(hex || "").replace(/^0x/, ""); return s.slice(i * 64, (i + 1) * 64); }
  function uintAt(hex, i) { return BigInt("0x" + (wordAt(hex, i) || "0")); }
  function addrAt(hex, i) { return "0x" + wordAt(hex, i).slice(24); }

  /* curves(bytes32) → the Curve struct. THIRTEEN words now: the quote asset and
   * ordering, plus the per-curve graduation target and virtual reserve (both
   * denominated in the quote), follow `graduated`. `raised` is in quote units. */
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
      graduated: uintAt(hex, 8) === 1n,
      quote: addrAt(hex, 9),          // pool quote asset; 0x0 = ETH
      tokenIs1: uintAt(hex, 10) === 1n,
      gradQuote: uintAt(hex, 11),     // graduation target, quote units
      virtualQuote: uintAt(hex, 12)   // virtual quote reserve
    };
  }
  // Is a pool quoted in native ETH?
  function isEthQuote(addr) { return !addr || /^0x0+$/i.test(String(addr)); }

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
    var quote = opts.quote || "0x0000000000000000000000000000000000000000";
    var devBuyWei = BigInt(opts.devBuyWei || 0);

    // ETH-quoted (the default): the atomic first buy rides on msg.value, and the
    // firstBuy arg is 0. Behaviour is identical to before, plus the quote arg.
    if (isEthQuote(quote)) {
      var data = encodeLaunch(opts.name, opts.symbol, opts.feeBps,
        opts.logo || "", opts.description || "", opts.socials || "", quote, 0);
      var hash = await send(from, { to: hookAddress(), data: data, value: "0x" + devBuyWei.toString(16) });
      return { hash: hash, chain: chain() };
    }

    /* A quote must be APPROVED on the hook or launch() reverts QuoteNotApproved.
     * Check it here, BEFORE the ETH->quote swap, so an unapproved pick fails
     * cleanly instead of swapping the dev's ETH and then reverting the launch. */
    var qc = await read("0x" + HOOK_SEL.approvedQuotes + addr32(quote));
    if (uintAt(qc, 0) !== 1n) throw new Error(
      "This asset isn't enabled as a quote yet. Price in ETH or USDG, or have the platform approve it first.");

    /* ERC-20 (USDG / stock) quoted. The first buy has to be IN the quote asset,
     * so an ATOMIC anti-snipe dev buy is: swap the dev's ETH -> quote (to the
     * dev), approve the hook, then launch with firstBuy = the quote acquired. The
     * pool opens AND the first buy happen inside that launch tx — no snipe window,
     * exactly like an ETH launch. With no dev buy the pool just opens. */
    var firstBuy = 0n;
    if (devBuyWei > 0n) {
      firstBuy = await zapEthToQuote(quote, devBuyWei, from);   // swap tx
      await ensureHookAllowance(quote, firstBuy, from);         // approve tx
    }
    var data2 = encodeLaunch(opts.name, opts.symbol, opts.feeBps,
      opts.logo || "", opts.description || "", opts.socials || "", quote, firstBuy);
    var hash2 = await send(from, { to: hookAddress(), data: data2, value: "0x0" }); // launch (atomic first buy)
    return { hash: hash2, chain: chain() };
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
  /* Buy with ETH. For an ETH-quoted pool the router takes msg.value directly. For
   * a quoted (USDG/stock) pool the buyer still pays ETH — the aggregator zaps
   * ETH -> quote -> token in one tx so nobody has to hold the stock first. */
  async function buy(token, wei, minTokensOut, from, quote) {
    from = from || await window.MoonpadLaunch.connect();
    await window.MoonpadLaunch.switchChain(chain().id);
    if (quote === undefined || quote === null) {
      var c = await curveOf(token);
      quote = c ? c.quote : "0x0000000000000000000000000000000000000000";
    }
    if (isEthQuote(quote)) {
      // router.buy(token, quote=0x0, quoteIn=0, minOut, to, deadline) — ETH is msg.value
      var data = "0x" + ROUTER_SEL.buy + addr32(token) +
        addr32("0x0000000000000000000000000000000000000000") + hex32(0) +
        hex32(minTokensOut || 0) + addr32(from) + hex32(defaultDeadline());
      return send(from, { to: routerAddress(), data: data, value: "0x" + BigInt(wei).toString(16) });
    }
    return zapBuy(token, quote, BigInt(wei), minTokensOut || 0, from); // reverts if aggregator unset
  }

  function sellRouterAddress() { return chain().sellRouter || null; }

  /* Which contract must be approved to move the seller's tokens, and whether the
   * sale returns ETH. An ETH pool already pays ETH through the hook router. For a
   * USDG/stock quote we route through WavesSellRouter (token -> quote -> ETH) so
   * the seller gets ETH, not stock shares — but only when the sell router is
   * recorded AND the quote has a direct ETH pool (single-hop). Otherwise fall
   * back to the hook router, which pays the quote asset. */
  async function sellPlan(quote) {
    if (isEthQuote(quote)) return { spender: routerAddress(), viaSell: false };
    var sr = sellRouterAddress();
    if (!sr) return { spender: routerAddress(), viaSell: false };
    var leg = await legFor(quote).catch(function () { return null; });
    if (!leg || leg.two) return { spender: routerAddress(), viaSell: false };
    return { spender: sr, viaSell: true, leg: leg };
  }

  /* Sell tokens. ETH-quoted pools and any fall-back return the pool's quote asset
   * through the hook router. A USDG/stock quote with the sell router recorded
   * returns ETH via WavesSellRouter. minOut is honoured in the asset actually
   * returned; the sell-router path uses 0 for now (its ETH floor is a follow-up,
   * matching the buy zap) — funds are correct, only the slippage guard is loose.
   * The seller must approve `plan.spender` first (see the adapter's swap). */
  async function sell(token, amount, minOut, from, quote, plan) {
    from = from || await window.MoonpadLaunch.connect();
    await window.MoonpadLaunch.switchChain(chain().id);
    if (quote === undefined || quote === null) {
      var c = await curveOf(token);
      quote = c ? c.quote : "0x0000000000000000000000000000000000000000";
    }
    plan = plan || await sellPlan(quote);
    if (plan.viaSell) {
      // token -> quote -> ETH in one tx; ethQuoteKey is the quote's ETH pool
      var d = "0x" + SELL_SEL.sellForEth + addr32(token) + addr32(quote) + hex32(amount) +
        encLegKey(plan.leg.key) + hex32(0) + addr32(from) + hex32(defaultDeadline());
      return send(from, { to: plan.spender, data: d, value: "0x0" });
    }
    var data = "0x" + ROUTER_SEL.sell + addr32(token) + addr32(quote) +
      hex32(amount) + hex32(minOut || 0) + addr32(from) + hex32(defaultDeadline());
    return send(from, { to: routerAddress(), data: data, value: "0x0" });
  }

  /* ── ETH zap (quoted pools) ──────────────────────────────────────────────
   * Pay ETH, land a quote-paired token via WavesQuoteAggregator (ETH -> quote ->
   * token) in one tx, so nobody has to hold the stock first. The aggregator and
   * the ETH->quote swap router must be recorded on the chain entry. */
  function aggregatorAddress() {
    var a = chain().aggregator || null;
    if (!a) throw new Error(
      "Paired-pool ETH buys aren't live yet — the WavesQuoteAggregator has not been " +
      "recorded on " + chain().name + ". Hold the quote asset to buy directly, or price in ETH.");
    return a;
  }

  var USDG_ADDR = "0x5fc5360d0400a0fd4f2af552add042d716f1d168";
  var _rhAssets = null;
  function rhAssets() {
    if (_rhAssets) return _rhAssets;
    _rhAssets = fetch("/rh-assets.json").then(function (r) { return r.json(); })
      .then(function (j) { return j.tokens || []; });
    return _rhAssets;
  }
  /* Pick the ETH->quote route from rh-assets.json: a direct ETH pool when the
   * quote has one (USDG always does), else ETH->USDG->quote for a stock that only
   * trades against USDG. Returns the PoolKey(s) the swap router/aggregator use. */
  async function legFor(quote) {
    var toks = await rhAssets();
    var ql = String(quote).toLowerCase();
    function find(a) { return toks.find(function (t) { return String(t.address).toLowerCase() === String(a).toLowerCase(); }); }
    var q = find(ql);
    if (!q) throw new Error("No routing data for the quote asset.");
    if (ql === USDG_ADDR || (q.ethPools || []).length) {
      var k = (q.ethPools || [])[0];
      if (!k) throw new Error("No ETH pool to route ETH -> " + (q.symbol || "quote") + ".");
      return { two: false, key: k };
    }
    var usdg = find(USDG_ADDR);
    var keyA = usdg && (usdg.ethPools || [])[0];   // ETH -> USDG
    var keyB = (q.usdgPools || [])[0];             // USDG -> quote
    if (!keyA || !keyB) throw new Error("No ETH -> USDG -> " + (q.symbol || "quote") + " route.");
    return { two: true, keyA: keyA, keyB: keyB };
  }
  /* A V4 PoolKey is a static tuple — five inline words, no offset. tickSpacing is
   * positive for every RH pool, so a plain pad is a correct int24 encoding. */
  function encLegKey(k) {
    return addr32(k.currency0) + addr32(k.currency1) + hex32(k.fee) + hex32(k.tickSpacing) + addr32(k.hooks);
  }

  /* ETH per one human unit of `quote`, for showing a sell that returns ETH in ETH
   * rather than the quote asset. Priced by /api/rh-indexer?quoteeth= (server-side:
   * ETH from Coinbase, a stock from its own pool slot0) — /api/stats can't price an
   * RH stock (it uses Jupiter, a Solana feed). No client-side keccak; the page
   * makes one same-origin call. Cached ~60s — requote() fires per keystroke and
   * the rate barely moves between them. Null when the price is unavailable, in
   * which case the caller keeps the quote-denominated figure. */
  var _ethPerQuote = {};
  async function ethPerQuote(quote) {
    var key = String(quote).toLowerCase();
    var hit = _ethPerQuote[key];
    var now = Date.now();
    if (hit && now - hit.t < 60000) return hit.v;
    var v = await fetch("/api/rh-indexer?quoteeth=" + encodeURIComponent(key))
      .then(function (r) { return r.json(); })
      .then(function (j) { return (j && j.ethPerQuote) ? Number(j.ethPerQuote) : null; })
      .catch(function () { return null; });
    _ethPerQuote[key] = { v: v, t: now };
    return v;
  }

  /* Buy `token` (quoted in `quote`) with `wei` of ETH, in one aggregator tx.
   * minTokensOut protects the final token amount; the per-leg min is left to the
   * swap router's own empty-pool guard for now (a fair quote-based floor is a
   * later refinement). */
  async function zapBuy(token, quote, wei, minTokensOut, from) {
    var agg = aggregatorAddress();
    var leg = await legFor(quote);
    var deadline = defaultDeadline();
    var data;
    if (leg.two) {
      data = "0x" + AGG_SEL.buyWithEth2 + addr32(token) + addr32(quote) +
        encLegKey(leg.keyA) + encLegKey(leg.keyB) +
        hex32(0) + hex32(minTokensOut || 0) + addr32(from) + hex32(deadline);
    } else {
      data = "0x" + AGG_SEL.buyWithEth + addr32(token) + addr32(quote) +
        encLegKey(leg.key) + hex32(0) + hex32(minTokensOut || 0) + addr32(from) + hex32(deadline);
    }
    return send(from, { to: agg, data: data, value: "0x" + BigInt(wei).toString(16) });
  }

  /* The EXACT tokens `wei` of ETH buys, read from the aggregator's own static
   * execution — ETH -> quote (the leg's fee + impact) -> curve, all of it. This
   * is how a QUOTED buy must be quoted: running the curve math on the raw ETH
   * (quoteBuyPure) skips the ETH->quote leg and over-quotes, so minTokensOut
   * lands above what the trade can deliver and every buy reverts on the min-out
   * guard. eth_call needs no balance, so any probe address works. */
  async function staticZapBuy(token, quote, wei) {
    var agg = aggregatorAddress();
    var leg = await legFor(quote);
    var probe = "0x0000000000000000000000000000000000000001";
    var deadline = defaultDeadline();
    var data;
    if (leg.two) {
      data = "0x" + AGG_SEL.buyWithEth2 + addr32(token) + addr32(quote) +
        encLegKey(leg.keyA) + encLegKey(leg.keyB) + hex32(0) + hex32(0) + addr32(probe) + hex32(deadline);
    } else {
      data = "0x" + AGG_SEL.buyWithEth + addr32(token) + addr32(quote) +
        encLegKey(leg.key) + hex32(0) + hex32(0) + addr32(probe) + hex32(deadline);
    }
    var out = await window.MoonpadRPC.send(chain().rpc, "eth_call",
      [{ from: probe, to: agg, data: data, value: "0x" + BigInt(wei).toString(16) }, "latest"]);
    return uintAt(out, 0);
  }

  function swapAddress() {
    var s = chain().v4Swap || null;
    if (!s) throw new Error(
      "A first buy on a paired (non-ETH) launch needs the ETH->quote router, which " +
      "isn't recorded on " + chain().name + " yet.");
    return s;
  }
  /* Swap `ethWei` of the dev's ETH into `quote` (to the dev's own wallet) through
   * the WavesSwapRouter, and return exactly how much quote arrived — measured as
   * a balance delta, not the quote, because the pool's real fill is the truth.
   * This is the ETH->quote leg of an ATOMIC paired dev buy: the dev then approves
   * the hook and the first buy rides inside launch() itself, so the pool opens and
   * the first buy land in one tx and there is no snipe window. */
  async function zapEthToQuote(quote, ethWei, from) {
    var swap = swapAddress();
    var leg = await legFor(quote);
    var data;
    if (leg.two) {
      data = "0x" + SWAP_SEL.swap2 + encLegKey(leg.keyA) + encLegKey(leg.keyB) + hex32(0) + addr32(from);
    } else {
      data = "0x" + SWAP_SEL.swap + encLegKey(leg.key) + hex32(0) + addr32(from);
    }
    var before = await balanceOf(quote, from);
    var hash = await send(from, { to: swap, data: data, value: "0x" + BigInt(ethWei).toString(16) });
    await waitForTx(hash);
    var got = (await balanceOf(quote, from)) - before;
    if (got <= 0n) throw new Error("The ETH -> quote swap returned nothing — try a larger first buy.");
    return got;
  }
  /* Approve the hook to pull the quote for a paired first buy. Approve the MAX so
   * this is a ONE-TIME cost per wallet+quote — every later paired launch skips it
   * and is just swap + launch (2 sigs). Safe: the hook only transferFroms the
   * quote from msg.sender inside that caller's own launch(), no other path. */
  async function ensureHookAllowance(token, amount, from) {
    var cur = uintAt(await read("0x" + ERC20_SEL.allowance + addr32(from) + addr32(hookAddress()), token), 0);
    if (cur >= BigInt(amount)) return;
    var MAX = (BigInt(1) << BigInt(256)) - BigInt(1);
    var hash = await send(from, { to: token, data: "0x" + ERC20_SEL.approve + addr32(hookAddress()) + hex32(MAX), value: "0x0" });
    /* ⚠️ WAIT for the approval to confirm before the caller fires launch()/buy.
     * Without this the next tx's transferFrom runs against a still-zero
     * allowance and reverts ("Internal JSON-RPC error") — and on a quoted launch
     * the dev's ETH has already been swapped to the quote, so the revert strands
     * it. */
    await waitForTx(hash);
  }

  // Selling needs the spender (hook router, or the sell router for an ETH-out
  // sale) approved to move the seller's tokens. `spender` defaults to the hook
  // router so existing callers are unchanged.
  async function allowance(token, owner, spender) {
    spender = spender || routerAddress();
    var out = await read("0x" + ERC20_SEL.allowance + addr32(owner) + addr32(spender), token);
    return uintAt(out, 0);
  }
  async function approve(token, amount, from, spender) {
    from = from || await window.MoonpadLaunch.connect();
    await window.MoonpadLaunch.switchChain(chain().id);
    spender = spender || routerAddress();
    return send(from, { to: token, data: "0x" + ERC20_SEL.approve + addr32(spender) + hex32(amount), value: "0x0" });
  }

  /* Take what you are owed. The hook pays owed[msg.sender] to the caller; there
   * is no claim-to-another-address on the hook, so `to` is honoured only when it
   * is the caller's own wallet (the fee page passes the connected wallet). */
  async function claim(from, to, quote) {
    from = from || await window.MoonpadLaunch.connect();
    await window.MoonpadLaunch.switchChain(chain().id);
    if (to && String(to).toLowerCase() !== String(from).toLowerCase()) {
      throw new Error("This chain pays fees to the wallet that claims them — connect that wallet to claim.");
    }
    // Fees accrue per quote asset; claim(quote) pays that asset. Defaults to ETH.
    quote = quote || "0x0000000000000000000000000000000000000000";
    return send(from, { to: hookAddress(), data: "0x" + HOOK_SEL.claim + addr32(quote), value: "0x0" });
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

  async function owed(who, quote) {
    // owed(who, quote) — fees accrue in the pool's quote asset. Defaults to ETH.
    quote = quote || "0x0000000000000000000000000000000000000000";
    return uintAt(await read("0x" + HOOK_SEL.owed + addr32(who) + addr32(quote)), 0);
  }

  async function balanceOf(token, who) {
    return uintAt(await read("0x" + ERC20_SEL.balanceOf + addr32(who), token), 0);
  }

  /* Decimals of a quote asset — 18 for native ETH, else read from the ERC-20 (6
   * for USDG, 8 for the tokenised stocks). Falls back to 18 if the call fails. */
  var _decCache = {};
  async function decimalsOf(token) {
    if (isEthQuote(token)) return 18;
    var k = String(token).toLowerCase();
    if (_decCache[k] !== undefined) return _decCache[k];
    var d = 18;
    try { d = Number(uintAt(await read("0x" + ERC20_SEL.decimals, token), 0)) || 18; } catch (e) {}
    _decCache[k] = d;
    return d;
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
  /* The graduation target and virtual reserve are PER CURVE now, denominated in
   * the pool's quote asset (for an ETH pool they equal the global terms). Fall
   * back to the terms if a curve predates the fields. `value`/`amount` and the
   * result are in quote units. */
  function quoteBuyPure(c, t, value) {
    var grad = c.gradQuote || t.graduationEth;
    var vQuote = c.virtualQuote || t.virtualEth;
    var room = c.raised >= grad ? 0n : grad - c.raised;
    if (room === 0n) return 0n;
    var accepted = BigInt(value);
    var feeBps = BigInt(c.feeBps);
    var fee = (accepted * feeBps) / 10000n;
    var inAfterFee = accepted - fee;
    if (inAfterFee > room) inAfterFee = room;
    var sold = t.curveSupply - c.tokensLeft;
    var x = vQuote + c.raised;
    var y = t.virtualTokens - sold;
    var out = y - ((vQuote * t.virtualTokens) / (x + inAfterFee));
    if (out > c.tokensLeft) out = c.tokensLeft;
    return out;
  }
  function quoteSellPure(c, t, amount) {
    amount = BigInt(amount);
    var vQuote = c.virtualQuote || t.virtualEth;
    var sold = t.curveSupply - c.tokensLeft;
    var x = vQuote + c.raised;
    var y = t.virtualTokens - sold;
    var back = (vQuote * t.virtualTokens) / (y + amount);
    var gross = back >= x ? 0n : x - back;
    if (gross > c.raised) gross = c.raised;
    var fee = (gross * BigInt(c.feeBps)) / 10000n;
    return gross - fee;
  }
  async function quoteBuy(token, wei) {
    var c = await curveOf(token); var t = await terms();
    if (!c) return 0n;
    // ETH-quoted: `wei` IS the quote amount — run the curve directly.
    if (isEthQuote(c.quote)) return quoteBuyPure(c, t, wei);
    /* Quoted (USDG/stock): the buy zaps ETH -> quote -> token, so quote through
     * the aggregator's real execution. The raw curve math on ETH over-quotes
     * (it skips the ETH->quote leg) and would set minTokensOut above the
     * achievable output — the "Internal JSON-RPC error" every quoted buy hit.
     * Fall back to the raw estimate only if the static call fails. */
    try {
      var out = await staticZapBuy(token, c.quote, BigInt(wei));
      if (out > 0n) return out;
    } catch (e) {}
    return quoteBuyPure(c, t, wei);
  }
  async function quoteSell(token, amount) {
    var c = await curveOf(token); var t = await terms();
    if (!c) return 0n;
    return quoteSellPure(c, t, amount);
  }
  async function progressBps(token) {
    var c = await curveOf(token); var t = await terms();
    if (!c) return 0;
    var grad = c.gradQuote || t.graduationEth;
    if (grad === 0n) return 0;
    var p = Number((c.raised * 10000n) / grad);
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
          // ETH-quoted: the curve sees the ETH directly.
          if (isEthQuote(c.quote)) {
            var outE = quoteBuyPure(c, t, inWei);
            if (outE <= 0n) throw new Error("The curve cannot fill that — it may be full.");
            return { out: fromWei(outE), amountIn: inWei, minOut: withSlippage(outE) };
          }
          /* Quoted (USDG/stock): the buy zaps ETH -> quote -> token through the
           * aggregator. Quote through its REAL static execution so the estimate
           * AND minOut match what the trade delivers. The old rate-based curve
           * estimate ignored the leg's fee + price impact, so minOut landed above
           * the achievable output and every quoted buy reverted on the min-out
           * guard. Fall back to the rate estimate only if the static call fails. */
          var out = 0n;
          try { out = await staticZapBuy(token, c.quote, inWei); } catch (e) { out = 0n; }
          if (out <= 0n) {
            var rate = await ethPerQuote(c.quote);
            var buyWei = inWei;
            if (rate && rate > 0) {
              var qDec = await decimalsOf(c.quote);
              buyWei = BigInt(Math.floor((fromWei(inWei) / rate) * Math.pow(10, qDec)));
            }
            out = quoteBuyPure(c, t, buyWei);
          }
          if (out <= 0n) throw new Error("The curve cannot fill that — it may be full.");
          return { out: fromWei(out), amountIn: inWei, minOut: withSlippage(out) };
        }
        var back = quoteSellPure(c, t, inWei);
        if (back <= 0n) throw new Error("That is too small to move the curve.");
        /* When the sale routes to ETH via the sell router, the curve pays the
         * quote and the router swaps it to ETH — so show the ETH the seller
         * actually gets (the est label is already "ETH"). Convert the quote
         * figure through its own decimals and the ETH-per-quote rate; if pricing
         * is unavailable, fall back to the quote-denominated figure. */
        try {
          var plan = await sellPlan(c.quote);
          if (plan.viaSell) {
            var rate = await ethPerQuote(c.quote);
            if (rate && rate > 0) {
              var qDec = await decimalsOf(c.quote);
              var backHuman = Number(back) / Math.pow(10, qDec);
              return { out: backHuman * rate, amountIn: inWei, minOut: 0 };
            }
          }
        } catch (e) { /* keep the quote-denominated figure below */ }
        return { out: fromWei(back), amountIn: inWei, minOut: withSlippage(back) };
      },

      swap: async function (token, side, amountIn, minOut) {
        var from = await window.MoonpadLaunch.connect();
        if (side === "buy") return buy(token, amountIn, minOut, from);
        // Resolve the quote once, decide who to approve (hook router, or the
        // sell router for an ETH-out sale), mine that approval, then sell.
        var c = await curveOf(token);
        var quote = c ? c.quote : "0x0000000000000000000000000000000000000000";
        var plan = await sellPlan(quote);
        var have = await allowance(token, from, plan.spender);
        if (have < BigInt(amountIn)) {
          await waitForTx(await approve(token, amountIn, from, plan.spender));
        }
        return sell(token, amountIn, minOut, from, quote, plan);
      },

      readMarket: async function (token) {
        var c = await curveOf(token);
        if (!c || /^0x0{40}$/.test(c.creator)) throw new Error("That token was not launched here.");
        var t = await terms();
        var supply = fromWei(t.curveSupply);
        var pool = await poolIdOf(token);
        var vQuote = c.virtualQuote || t.virtualEth;
        var grad = c.gradQuote || t.graduationEth;
        /* raised / vQuote are in the quote asset's own decimals (18 for ETH, but
         * 6 for USDG, 8 for a stock). Read the quote's real decimals so a non-ETH
         * pool's figures are right; the token page pairs the price with the
         * quote's USD spot for a $ figure. */
        var qDec = await decimalsOf(c.quote);
        var qUnit = Math.pow(10, qDec);
        var x = vQuote + c.raised;
        var sold = t.curveSupply - c.tokensLeft;
        var y = t.virtualTokens - sold;
        // price is quote-per-token: normalise each side by its own decimals
        var price = y > 0n ? (Number(x) / qUnit) / fromWei(y) : null;
        var raised = Number(c.raised) / qUnit;
        var threshold = Number(grad) / qUnit;
        var mcap = price != null ? price * supply : null;
        /* An ETH-denominated view so the homepage can quote every token's
         * progress in one unit. An ETH pool is already ETH; for an RWA/USDG
         * quote convert through the indexer's ETH-per-quote rate — null when the
         * indexer has not priced the quote yet, so the caller falls back to the
         * quote figure rather than showing a wrong ETH number. */
        var ethRate = isEthQuote(c.quote) ? 1 : await ethPerQuote(c.quote);
        var raisedEth = ethRate != null ? raised * ethRate : null;
        var thresholdEth = ethRate != null ? threshold * ethRate : null;
        var mcapEth = (ethRate != null && mcap != null) ? mcap * ethRate : null;
        return {
          pool: pool,
          migrated: c.graduated,
          raised: raised,
          threshold: threshold,
          progress: threshold > 0 ? Math.min(1, raised / threshold) : 0,
          price: price,
          supply: supply,
          mcap: mcap,
          raisedEth: raisedEth,
          thresholdEth: thresholdEth,
          mcapEth: mcapEth,
          ethRate: ethRate,
          quote: isEthQuote(c.quote) ? "ETH" : null,   // symbol resolved by the page
          quoteAddr: c.quote,
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
