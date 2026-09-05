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
   *   ⏳ buy() / sell() — V4 swaps go through a swap ROUTER, not a direct call.
   *                      Blocked on: (1) the hook deployed (chain.hook), and
   *                      (2) a V4 swap router on RH (chain.v4Router). Both are
   *                      null until on-chain; the functions throw a clear
   *                      message until then rather than encode a swap against an
   *                      address that does not exist.
   *
   * This module is inert unless `chain.hook` is set — index/launch pages choose
   * the hook path over the curve path only when a hook address exists, so
   * shipping it changes nothing until the audited hook is deployed and recorded.
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
    owed: "df18e047"      // owed(address)
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

  /* curves(poolId) → the Curve struct:
   * (address token, address creator, uint16 feeBps, uint16 rewardsBps,
   *  address keeper, uint96 raised, uint96 tokensLeft, bool graduated) */
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
      graduated: BigInt("0x" + w(7)) === 1n
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

  // ── buy / sell — gated on the V4 router (see header) ──────────────────
  function requireRouter() {
    var r = chain().v4Router || null;
    if (!r) throw new Error(
      "Trading the hook needs a V4 swap router on " + chain().name +
      ", which is not deployed/recorded yet (chain.v4Router). Launch works; " +
      "buy/sell wait on the router + audit.");
    return r;
  }
  async function buy() { requireRouter(); throw new Error("hook buy(): router swap not wired — see evm-hook.js header"); }
  async function sell() { requireRouter(); throw new Error("hook sell(): router swap not wired — see evm-hook.js header"); }

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
