(function () {
  "use strict";
  /* WAVES V4-hook launch adapter (Robinhood Chain).
   *
   * The successor to evm-token.js's standalone-curve path. Where that deploys a
   * curve and calls buy/sell on it directly, this launches on the singleton
   * WavesCurveHook — which makes every token a LIVE Uniswap V4 pool from block
   * zero, so GMGN/DexScreener index it natively (the whole reason this exists).
   *
   * Wiring state (2026-09-05):
   *   ✅ launch()      — fully wired; the hook's launch(string,string,uint16,
   *                      string,string,string) is ABI-verified below.
   *   ✅ reads         — curves(poolId), poolOf(token), owed() are wired.
   *   ✅ buy() / sell() — routed through WavesHookRouter (chain.v4Router):
   *                      buy sends ETH and takes the curve amount to the buyer
   *                      (boundary overfill refunded in-tx); sell approves the
   *                      router if needed then swaps tokens->ETH. Both throw a
   *                      clear message while `chain.v4Router` is unset rather
   *                      than encoding against a nonexistent address.
   *   ✅ hook deployed  — 0xA02A…6888 on RH, recorded as chain.hook.
   *   ⏳ router         — deploy script/DeployWavesHookRouter.s.sol and set
   *                      chain.v4Router; until then buy/sell stay gated.
   *
   * This module is inert unless `chain.hook` is set — index/launch pages choose
   * the hook path over the curve path only when a hook address exists, so
   * shipping it changes nothing until it is deployed and recorded (it is) AND a
   * page actually loads this file (none does yet).
   */

  function chain() {
    var id = (window.BRAND && window.BRAND.evmChainId) || 4663;
    var all = window.MOONPAD_CHAINS || [];
    for (var i = 0; i < all.length; i++) if (all[i].id === id) return all[i];
    throw new Error("chain " + id + " is not in evm-chains.js");
  }

  function hookAddress() {
    var a = chain().hook || null;
    if (!a) throw new Error(
      "No WavesCurveHook is deployed on " + chain().name + " yet. Deploy " +
      "contracts/WavesCurveHook.sol (script/DeployWavesCurveHook.s.sol) and set " +
      "`hook` on this chain's entry in evm-chains.js.");
    return a;
  }

  // Present iff a hook is configured — the switch index/launch pages read.
  function enabled() { try { return !!chain().hook; } catch (e) { return false; } }

  // ── ABI-checked selectors (cast against contracts/WavesCurveHook.sol) ──
  var SEL = {
    launch: "44db9ad1",   // launch(string,string,uint16,string,string,string)
    graduate: "ff6d8d05", // graduate(address)
    pledge: "5ac3e590",   // pledge(address,address,uint16)
    claim: "4e71d92d",    // claim()
    curves: "66903e80",   // curves(bytes32)
    poolOf: "988b1fa7",   // poolOf(address)
    owed: "df18e047",     // owed(address)
    // WavesHookRouter (chain.v4Router) — cast-verified selectors
    buy: "b3ffb760",      // buy(address,uint256,address,uint256)
    sell: "883c18b3",     // sell(address,uint256,uint256,address,uint256)
    // ERC20 on WavesToken, for the sell approval
    approve: "095ea7b3",  // approve(address,uint256)
    allowance: "dd62ed3e" // allowance(address,address)
  };

  // Pool params the hook opens every pool with — MUST match WavesCurveHook.sol.
  var LP_FEE = 0;
  var TICK_SPACING = 60;

  function hex32(v) {
    var h = (typeof v === "bigint" ? v : BigInt(v)).toString(16);
    return "0".repeat(64 - h.length) + h;
  }
  function addr32(a) { return "0".repeat(24) + a.replace(/^0x/, "").toLowerCase(); }
  function int24w(v) {
    // two's-complement of a small signed int, left-padded to a word
    var n = BigInt(v);
    if (n < 0n) n += 1n << 256n;
    return hex32(n);
  }
  function strTail(s) {
    var bytes = new TextEncoder().encode(s || "");
    var len = bytes.length;
    var body = "";
    for (var i = 0; i < bytes.length; i++) body += bytes[i].toString(16).padStart(2, "0");
    var pad = (64 - (body.length % 64)) % 64;
    return hex32(BigInt(len)) + body + "0".repeat(pad);
  }

  /* launch(name, symbol, feeBps, logo, description, socials) — six dynamic/
   * value args, head then tails, exactly the layout the hand-encoded curve
   * launch used, minus minTokensOut (a first buy is a separate swap now). */
  function encodeLaunch(name, symbol, feeBps, logo, description, socials) {
    var strs = [name, symbol, logo, description, socials];
    // head: name off, symbol off, feeBps(value), logo off, desc off, socials off
    var headWords = 6;
    var tails = [];
    var offsets = [];
    var running = headWords * 32;
    // order of dynamic args in the signature: 0 name,1 symbol,3 logo,4 desc,5 socials
    var dynIdx = [0, 1, 3, 4, 5];
    var encoded = {};
    dynIdx.forEach(function (i, k) {
      offsets[i] = running;
      var t = strTail(strs[k]);
      encoded[i] = t;
      running += t.length / 2;
    });
    var head = "";
    head += hex32(BigInt(offsets[0]));            // name
    head += hex32(BigInt(offsets[1]));            // symbol
    head += hex32(BigInt(feeBps));                // feeBps
    head += hex32(BigInt(offsets[3]));            // logo
    head += hex32(BigInt(offsets[4]));            // description
    head += hex32(BigInt(offsets[5]));            // socials
    var body = head + encoded[0] + encoded[1] + encoded[3] + encoded[4] + encoded[5];
    return "0x" + SEL.launch + body;
  }

  /* PoolId = keccak256(abi.encode(PoolKey)) — currency0, currency1, fee,
   * tickSpacing, hooks, each a full word. ETH is currency0 (address 0). Needs a
   * keccak; reuse the site's vendored one (window.MoonpadKeccak) if present. */
  function poolId(token) {
    var packed =
      addr32("0x0000000000000000000000000000000000000000") + // currency0 = ETH
      addr32(token) +                                          // currency1
      hex32(BigInt(LP_FEE)) +                                  // fee (uint24)
      int24w(TICK_SPACING) +                                   // tickSpacing (int24)
      addr32(hookAddress());                                   // hooks
    var k = window.MoonpadKeccak || (window.MoonpadRPC && window.MoonpadRPC.keccak256);
    if (!k) throw new Error("keccak256 not available for poolId");
    return "0x" + k(packed).replace(/^0x/, "");
  }

  function read(data, to) {
    return window.MoonpadRPC.send(chain().rpc, "eth_call",
      [{ to: to || hookAddress(), data: data }, "latest"]);
  }

  /* curves(poolId) → the Curve struct. NINE words — a `full` latch (set the
   * instant raised first reaches graduationEth, which freezes the curve) sits
   * between tokensLeft and graduated:
   * (address token, address creator, uint16 feeBps, uint16 rewardsBps,
   *  address keeper, uint96 raised, uint96 tokensLeft, bool full, bool graduated) */
  async function curveOf(token) {
    var hex = await read("0x" + SEL.curves + poolId(token).replace(/^0x/, ""));
    if (!hex || hex === "0x") return null;
    var d = hex.replace(/^0x/, "");
    var w = function (i) { return d.slice(i * 64, i * 64 + 64); };
    var creator = "0x" + w(1).slice(24);
    if (/^0x0+$/.test(creator)) return null;
    return {
      token: "0x" + w(0).slice(24),
      creator: creator,
      feeBps: Number(BigInt("0x" + w(2))),
      rewardsBps: Number(BigInt("0x" + w(3))),
      keeper: "0x" + w(4).slice(24),
      raised: BigInt("0x" + w(5)),
      tokensLeft: BigInt("0x" + w(6)),
      full: BigInt("0x" + w(7)) === 1n,      // curve sold out, awaiting graduate()
      graduated: BigInt("0x" + w(8)) === 1n
    };
  }

  async function owed(addr) {
    var hex = await read("0x" + SEL.owed + addr32(addr));
    return hex && hex !== "0x" ? BigInt(hex) : 0n;
  }

  // ── launch (fully wired) ──────────────────────────────────────────────
  /* opts.firstBuyWei (a BigInt/decimal string, in wei) buys on the curve in the
   * SAME transaction — the anti-snipe. The hook prices it atomically after the
   * pool opens, so there is no separate first-buy for a bot to front-run. */
  async function launch(opts) {
    var from = opts.from || await window.MoonpadLaunch.connect();
    await window.MoonpadLaunch.switchChain(chain().id);
    var data = encodeLaunch(
      opts.name, opts.symbol, opts.feeBps, opts.logo || "", opts.description || "", opts.socials || "");
    var value = opts.firstBuyWei ? "0x" + BigInt(opts.firstBuyWei).toString(16) : "0x0";
    return send(from, { to: hookAddress(), data: data, value: value });
  }

  /* Wallet send with a gas estimate and EIP-1559 pricing — self-contained so the
   * adapter does not depend on evm-token.js's internals. */
  async function send(from, tx) {
    tx.from = from;
    var p = window.ethereum;
    if (!p) throw new Error("No wallet found in this browser.");
    tx.gas = "0x" + ((BigInt(await p.request({ method: "eth_estimateGas", params: [tx] })) * 12n) / 10n).toString(16);
    try {
      var block = await p.request({ method: "eth_getBlockByNumber", params: ["latest", false] });
      var base = BigInt((block && block.baseFeePerGas) || 0);
      var tip = 1000000n;
      tx.maxPriorityFeePerGas = "0x" + tip.toString(16);
      tx.maxFeePerGas = "0x" + (base * 2n + tip).toString(16);
    } catch (e) { /* legacy chains price it themselves */ }
    return p.request({ method: "eth_sendTransaction", params: [tx] });
  }

  // ── buy / sell through WavesHookRouter (chain.v4Router) ───────────────
  function requireRouter() {
    var r = chain().v4Router || null;
    if (!r) throw new Error(
      "Trading the hook needs the WavesHookRouter on " + chain().name +
      ", which is not deployed/recorded yet (chain.v4Router). Launch works; " +
      "deploy script/DeployWavesHookRouter.s.sol and set `v4Router`.");
    return r;
  }

  function defaultDeadline() { return Math.floor(Date.now() / 1000) + 1200; } // +20 min

  // Poll for a mined receipt (used to sequence approve -> sell).
  async function waitReceipt(hash) {
    for (var i = 0; i < 60; i++) {
      var r = await window.MoonpadRPC.send(chain().rpc, "eth_getTransactionReceipt", [hash]);
      if (r && r.blockNumber) {
        if (r.status && BigInt(r.status) === 0n) throw new Error("tx reverted: " + hash);
        return r;
      }
      await new Promise(function (res) { return setTimeout(res, 2000); });
    }
    throw new Error("timed out waiting for " + hash);
  }

  /* Buy `token` with `ethWei` of ETH (BigInt/decimal string). opts.minTokensOut
   * is slippage protection (default 0 = none — the UI should pass a real min).
   * opts.to defaults to the sender. The router refunds any boundary-buy overfill
   * to the sender in the same tx. */
  async function buy(opts) {
    var router = requireRouter();
    var from = opts.from || await window.MoonpadLaunch.connect();
    await window.MoonpadLaunch.switchChain(chain().id);
    var to = opts.to || from;
    var deadline = opts.deadline || defaultDeadline();
    var data = "0x" + SEL.buy + addr32(opts.token) + hex32(BigInt(opts.minTokensOut || 0)) +
      addr32(to) + hex32(BigInt(deadline));
    var value = "0x" + BigInt(opts.ethWei).toString(16);
    return send(from, { to: router, data: data, value: value });
  }

  /* Sell `tokensIn` (BigInt/decimal string) of `token` for ETH. Ensures the
   * router is approved for the amount first (one approve tx, only if the current
   * allowance is short), then the sell. opts.minEthOut is slippage (default 0).
   * opts.to defaults to the sender. Returns the sell tx hash. */
  async function sell(opts) {
    var router = requireRouter();
    var from = opts.from || await window.MoonpadLaunch.connect();
    await window.MoonpadLaunch.switchChain(chain().id);
    var to = opts.to || from;
    var amt = BigInt(opts.tokensIn);
    var deadline = opts.deadline || defaultDeadline();

    // allowance(from, router) — approve only if short
    var allowHex = await read(
      "0x" + SEL.allowance + addr32(from) + addr32(router), opts.token);
    var allowance = allowHex && allowHex !== "0x" ? BigInt(allowHex) : 0n;
    if (allowance < amt) {
      var approveData = "0x" + SEL.approve + addr32(router) + hex32(amt);
      var ah = await send(from, { to: opts.token, data: approveData, value: "0x0" });
      await waitReceipt(ah); // sell's gas estimate needs the allowance in place
    }

    var data = "0x" + SEL.sell + addr32(opts.token) + hex32(amt) +
      hex32(BigInt(opts.minEthOut || 0)) + addr32(to) + hex32(BigInt(deadline));
    return send(from, { to: router, data: data, value: "0x0" });
  }

  window.WavesHook = {
    enabled: enabled,
    launch: launch,
    buy: buy,
    sell: sell,
    curveOf: curveOf,
    owed: owed,
    poolId: poolId,
    address: function () { try { return hookAddress(); } catch (e) { return null; } }
  };
})();
