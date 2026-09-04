(function () {
  "use strict";
  // Wallet, chain and deploy for Moonpad. No libraries — ethers and viem are
  // hundreds of kilobytes to do what amounts to hex string assembly, and this
  // site has no build step to tree-shake them.
  //
  // Moonpad never holds funds and never signs anything. The user's wallet
  // deploys the contract, owns it, and receives every mint payment directly.

  var ALL = window.MOONPAD_CHAINS || [];
  var byId = {};
  ALL.forEach(function (c) { byId[c.id] = c; });

  // Every chain is wired; only the ones flagged live are offered. deploy() also
  // refuses a held-back chain, so a stale UI or a hand-built call cannot reach
  // one that has not been opened yet.
  var CHAINS = ALL.filter(function (c) { return c.live; });

  // Collections that grant access, checked in order. A list rather than a single
  // contract on purpose: later drops can also unlock the builder, so the ceiling
  // is not fixed at whatever the first collection sold. Holding any one of these
  // is enough.
  //
  // Empty means the gate is open — the builder is free until the first pass
  // exists, which is the state it ships in.
  var PASSES = [
    { chainId: 4663, address: "0x7b74b4b390cD07A608513bC3D5043637a963B664", label: "Moonbabies" }
  ];

  // ------------------------------------------------------------------ abi
  var enc = {
    hex: function (n) {
      var h = BigInt(n).toString(16);
      return h.length % 2 ? "0" + h : h;
    },
    word: function (n) { return enc.hex(n).padStart(64, "0"); },
    addr: function (a) { return a.toLowerCase().replace(/^0x/, "").padStart(64, "0"); },
    // A dynamic string is a 32-byte length followed by the bytes, padded up to
    // the next 32-byte boundary.
    str: function (s) {
      var bytes = new TextEncoder().encode(s);
      var hex = "";
      for (var i = 0; i < bytes.length; i++) hex += bytes[i].toString(16).padStart(2, "0");
      var pad = (64 - (hex.length % 64)) % 64;
      return enc.word(bytes.length) + hex + "0".repeat(pad);
    }
  };

  // Encode constructor(string,string,string,uint256,uint256,uint256,address).
  // Dynamic values go in a tail; their slot in the head holds the byte offset to
  // where they start. Getting that offset wrong is the classic way to deploy a
  // contract whose name is garbage, so it is computed rather than hardcoded.
  // The constructor's arguments, in order. The three fee numbers are a struct
  // in Solidity now, but a struct of statics encodes inline — so they are still
  // three words in the same place and this did not change for them. reserveQty
  // and openAtDeploy are new, and the head grew by two words.
  // The Gate struct is two more static words on the end — signer, duration.
  function encodeArgs(name, symbol, baseUri, maxSupply, price, maxPerWallet, owner,
                      feeFloor, feeBps, feeTo, royaltyBps, reserveQty, openAtDeploy,
                      gateSigner, gateSeconds) {
    var HEAD = 15 * 32;
    var tail = "", offsets = [];
    [name, symbol, baseUri].forEach(function (s) {
      offsets.push(HEAD + tail.length / 2);
      tail += enc.str(s);
    });
    return enc.word(offsets[0]) + enc.word(offsets[1]) + enc.word(offsets[2]) +
           enc.word(maxSupply) + enc.word(price) + enc.word(maxPerWallet) +
           enc.addr(owner) +
           enc.word(feeFloor) + enc.word(feeBps) + enc.addr(feeTo) +
           enc.word(royaltyBps) + enc.word(reserveQty || 0) +
           enc.word(openAtDeploy ? 1 : 0) +
           enc.addr(gateSigner || "0x0000000000000000000000000000000000000000") +
           enc.word(gateSeconds || 0) + tail;
  }

  // What this launch will actually be charged. Zero unless a fee recipient is
  // configured for the chain — no recipient means no fee, rather than a fee
  // that quietly goes nowhere.
  function feeFor(chainId) {
    var f = window.MOONPAD_FEE || {};
    var chain = byId[chainId] || {};
    var to = chain.feeTo || f.to;
    if (!to) return { floor: "0", bps: 0, to: "0x0000000000000000000000000000000000000000" };
    return { floor: f.floor || "0", bps: f.bps || 0, to: to };
  }

  // ---------------------------------------------------------------- wallet
  function provider() {
    if (!window.MOONPAD_ETH()) throw new Error("No wallet found. Install MetaMask or Rabby.");
    return window.MOONPAD_ETH();
  }

  async function connect() {
    var accounts = await provider().request({ method: "eth_requestAccounts" });
    if (!accounts || !accounts.length) throw new Error("No account was shared");
    return accounts[0];
  }

  // Prove control of the connected wallet for the upload gate. The server rebuilds
  // this exact message, recovers the signer, and requires it to equal `address`
  // AND to hold a Moonbaby — so naming someone else's address gets you nowhere.
  // The timestamp keeps an old signature from being replayed later.
  async function signLaunch(address) {
    var ts = Date.now();
    var msg = "Moonpad launch\n" + String(address).toLowerCase() + "\n" + ts;
    var sig = await provider().request({ method: "personal_sign", params: [msg, address] });
    return { sig: sig, ts: ts };
  }

  // Pay the storage fee: a plain ETH transfer of `wei` to the treasury. The
  // server verifies this exact transfer on chain before granting the upload, so
  // the returned hash is what proves the fee was paid. The wallet's own prompt is
  // the user's confirmation of the amount.
  async function payFee(from, to, wei) {
    var tx = { from: from, to: to, value: "0x" + BigInt(wei).toString(16) };
    return provider().request({ method: "eth_sendTransaction", params: [tx] });
  }

  async function currentChain() {
    return parseInt(await provider().request({ method: "eth_chainId" }), 16);
  }

  // Switch first; a wallet that has never seen the chain answers 4902, and only
  // then is it right to ask to add it. Asking to add a chain the user already
  // has produces a confusing second prompt.
  async function switchChain(id) {
    var c = byId[id];
    if (!c) throw new Error("unknown chain " + id);
    var hex = "0x" + c.id.toString(16);
    try {
      await provider().request({ method: "wallet_switchEthereumChain", params: [{ chainId: hex }] });
    } catch (e) {
      if (e && (e.code === 4902 || (e.data && e.data.originalError && e.data.originalError.code === 4902))) {
        await provider().request({
          method: "wallet_addEthereumChain",
          params: [{
            chainId: hex,
            chainName: c.name,
            rpcUrls: [c.rpc],
            blockExplorerUrls: [c.explorer],
            nativeCurrency: { name: c.symbol, symbol: c.symbol, decimals: c.decimals }
          }]
        });
      } else {
        throw e;
      }
    }
  }

  // ------------------------------------------------------------ holder gate
  // Read balanceOf(address) straight from the chain over plain JSON-RPC, so the
  // check works whatever chain the wallet happens to be on.
  async function balanceOf(pass, address) {
    var chain = byId[pass.chainId];
    if (!chain) throw new Error("pass " + pass.label + " is on an unknown chain");
    // Through the shared reader in chains.js: retry, and one budget shared with
    // every other read, so a burst cannot get this refused.
    var res;
    try {
      res = await window.MoonpadRPC.call(chain.rpc, pass.address,
        "0x70a08231" + enc.addr(address));
    } catch (e) {
      throw new Error("could not read " + pass.label + ": " + (e && e.message ? e.message : e));
    }
    return parseInt(res, 16) || 0;
  }

  // ------------------------------------------------------- address checking
  // Is there a collection at this address, and what is it called?
  //
  // An allowlist is a list of other people's contracts, typed or pasted by
  // hand. A wrong character gives a perfectly well-formed address that simply
  // has nothing at it, and the mistake is invisible until a mint nobody can
  // pass. So the address is looked up rather than accepted: no code means no
  // contract, and the name is shown back as confirmation that it is the
  // collection the creator meant.
  function decodeStr(hex) {
    if (!hex || hex === "0x") return "";
    var b = hex.slice(2);
    if (b.length < 128) return "";
    var len = parseInt(b.slice(64, 128), 16);
    if (!len || len > 256) return "";
    var out = "";
    for (var i = 0; i < len; i++) {
      var c = parseInt(b.substr(128 + i * 2, 2), 16);
      if (c >= 32 && c < 127) out += String.fromCharCode(c);
    }
    return out.trim();
  }

  // Same shared reader; body keeps its { method, params } shape so every caller
  // below is unchanged.
  async function rpc(chain, body) {
    return window.MoonpadRPC.send(chain.rpc, body.method, body.params);
  }

  async function inspect(chainId, address) {
    var chain = byId[chainId];
    if (!chain) throw new Error("unknown chain " + chainId);
    var code = await rpc(chain, { method: "eth_getCode", params: [address, "latest"] });
    if (!code || code === "0x") return { contract: false, kind: "none", name: "", symbol: "", decimals: 0 };

    async function call(data) {
      try { return await rpc(chain, { method: "eth_call", params: [{ to: address, data: data }, "latest"] }); }
      catch (e) { return null; }
    }
    async function read(sel) { return decodeStr(await call(sel)); }

    // Which kind of contract, asked rather than assumed. name() and symbol()
    // are on both standards, so they cannot tell a collection from a coin —
    // and the two mean different things in an allowlist. A coin address
    // pasted where a collection was meant looks perfectly fine otherwise.
    //
    // ERC-721 answers supportsInterface(0x80ac58cd). ERC-20 has no such thing,
    // so it is identified by having decimals(); an ERC-721 does not.
    var kind = "unknown", decimals = 0;
    var is721 = await call("0x01ffc9a7" + "80ac58cd".padEnd(64, "0"));
    if (is721 && /^0x0*1$/.test(is721)) {
      kind = "nft";
    } else {
      var d = await call("0x313ce567");
      if (d && d !== "0x" && d !== "0x0") {
        var n = parseInt(d, 16);
        // a plausible answer, not merely a non-empty one — plenty of contracts
        // return something for a selector they do not implement
        if (n >= 0 && n <= 36) { kind = "coin"; decimals = n; }
      }
    }
    return {
      contract: true, kind: kind, decimals: decimals,
      name: await read("0x06fdde03"), symbol: await read("0x95d89b41")
    };
  }

  // What this wallet holds, pass by pass. Returned rather than reduced to a
  // boolean so the UI can say which collection let them in.
  async function holdings(address) {
    var out = [];
    for (var i = 0; i < PASSES.length; i++) {
      try {
        out.push({ pass: PASSES[i], balance: await balanceOf(PASSES[i], address) });
      } catch (e) {
        // One unreachable rpc must not lock out a holder of a different pass,
        // so a failed read counts as unknown rather than as zero.
        out.push({ pass: PASSES[i], balance: null, error: e.message });
      }
    }
    return out;
  }

  async function hasAccess(address) {
    if (!PASSES.length) return true;           // no pass exists yet — open
    var held = await holdings(address);
    return held.some(function (h) { return h.balance > 0; });
  }

  // ---------------------------------------------------------------- deploy
  async function deploy(opts) {
    var c = window.MOONPAD_CONTRACT;
    if (!c) throw new Error("contract.js did not load");

    if (!byId[opts.chainId]) throw new Error("unknown chain " + opts.chainId);
    if (!byId[opts.chainId].live) {
      throw new Error(byId[opts.chainId].name + " is not open yet — Robinhood Chain only for now.");
    }

    var from = opts.from || await connect();
    // WAVES has no launch pass — anyone can deploy; storage is the only cost
    await switchChain(opts.chainId);

    var fee = feeFor(opts.chainId);
    var args = encodeArgs(
      opts.name, opts.symbol, opts.baseUri || "",
      opts.maxSupply, opts.priceWei || 0, opts.maxPerWallet || 0,
      opts.owner || from,
      fee.floor, fee.bps, fee.to,
      opts.royaltyBps || 0,
      opts.reserveQty || 0, !!opts.openAtDeploy,
      opts.gateSigner, opts.gateSeconds || 0
    );

    var tx = {
      from: from,
      data: c.bytecode + args,
      value: "0x0"
    };

    // Estimate first: a revert here is free, whereas finding out on-chain costs
    // the full gas and leaves nothing deployed.
    try {
      tx.gas = pad(await provider().request({ method: "eth_estimateGas", params: [tx] }));
    } catch (e) {
      throw new Error("The deploy would fail: " + (e && e.message ? e.message : e));
    }

    await priceTx(tx);
    var hash = await provider().request({ method: "eth_sendTransaction", params: [tx] });
    return { hash: hash, chain: byId[opts.chainId] };
  }

  // Price the transaction with room to move. A flat gasPrice read a moment ago
  // is rejected the instant the base fee ticks up ("max fee per gas less than
  // block base fee"), and leaving the field off entirely makes at least one
  // wallet offer a literal zero. EIP-1559 solves both: maxFeePerGas is only a
  // ceiling, so headroom over the base fee costs nothing — the sender still
  // pays base + tip.
  async function priceTx(tx) {
    var ask = function (method, params) {
      return provider().request({ method: method, params: params });
    };
    try {
      var block = await ask("eth_getBlockByNumber", ["latest", false]);
      var base = BigInt((block && block.baseFeePerGas) || 0);
      if (base > 0n) {
        var tip;
        try { tip = BigInt(await ask("eth_maxPriorityFeePerGas", [])); }
        catch (e) { tip = 0n; }
        if (tip <= 0n) tip = base / 10n + 1n;
        tx.maxPriorityFeePerGas = "0x" + tip.toString(16);
        /* A modest ceiling, deliberately.
         *
         * maxFeePerGas is a LIMIT, not a price — the sender pays base + tip
         * whatever this says — so headroom is free in ETH terms. It is not free
         * in trust: at 3x the base fee MetaMask flags the transaction with a red
         * "Review alert" on the network fee, and a creator halfway through a
         * launch reads that as the site trying something. Costing them nothing
         * while looking alarming is the worst of both.
         *
         * Blocks here arrive every ~0.1s and the base fee barely moves, so 2x
         * plus the tip is still several blocks of room. */
        tx.maxFeePerGas = "0x" + (base * 2n + tip).toString(16);
        return tx;
      }
      var gp = BigInt(await ask("eth_gasPrice", []));
      if (gp > 0n) tx.gasPrice = "0x" + (gp * 2n).toString(16);
    } catch (e) {}
    return tx;
  }

  // Estimates come back exact; a reserve of several hundred ids is close enough
  // to the block limit that an exact figure leaves no room for a state change
  // between estimating and mining.
  function pad(hex) {
    return "0x" + ((BigInt(hex) * 12n) / 10n).toString(16);
  }

  // poll for the receipt; wallets do not push one
  async function waitForContract(hash, chainId) {
    var chain = byId[chainId];
    for (var i = 0; i < 120; i++) {
      // Through the shared reader: retry, and one budget shared with every other
      // request the page makes. A dropped poll is NOT a failed transaction — the
      // tx is already signed, paid for and very likely mined, so a blip here
      // means "ask again", not "tell them it broke". Hence the catch to null,
      // which the loop reads exactly like a not-yet-mined receipt; only running
      // out of attempts is a real timeout.
      var res = await window.MoonpadRPC.send(chain.rpc, "eth_getTransactionReceipt", [hash])
        .catch(function () { return null; });
      if (res) {
        if (res.status === "0x0") throw new Error("The deploy transaction reverted");
        return {
          address: res.contractAddress,
          explorer: chain.explorer + "/address/" + res.contractAddress
        };
      }
      await new Promise(function (r) { setTimeout(r, 2500); });
    }
    throw new Error("Still not confirmed after five minutes — check the explorer");
  }

  // Owner-only calls on a deployed collection. The panel needs these so a
  // creator never has to open a block explorer and hand-encode a transaction —
  // the contract ships with the sale closed, so without this a finished launch
  // is unsellable.
  async function ownerCall(chainId, contract, data, from) {
    await switchChain(chainId);
    var tx = { from: from, to: contract, data: data, value: "0x0" };
    try {
      tx.gas = pad(await provider().request({ method: "eth_estimateGas", params: [tx] }));
    } catch (e) {
      // an estimate that reverts is almost always "you are not the owner"
      throw new Error("That call would fail: " + (e && e.message ? e.message : e));
    }
    await priceTx(tx);
    return provider().request({ method: "eth_sendTransaction", params: [tx] });
  }

  // Selectors come from the compiled contract, never typed by hand. One was
  // wrong when written from memory — freezeMetadata is d111515d, not 1ce9727d —
  // and a wrong selector does not error, it calls a different function or
  // nothing at all.
  function sig(name) {
    var sels = (window.MOONPAD_CONTRACT || {}).selectors || {};
    if (!sels[name]) throw new Error("no selector for " + name);
    return "0x" + sels[name];
  }

  var abi = {
    reserve: function (qty, to) {
      return sig("reserve(uint256,address)") + enc.word(qty) + enc.addr(to);
    },
    setVault: function (v) {
      return sig("setVault(address)") + enc.addr(v);
    },
    setSaleOpen: function (open) {
      return sig("setSaleOpen(bool)") + enc.word(open ? 1 : 0);
    },
    setRoyalty: function (receiver, bps) {
      return sig("setRoyalty(address,uint96)") + enc.addr(receiver) + enc.word(bps);
    },
    freezeMetadata: function () { return sig("freezeMetadata()"); }
  };

  // Listing on the public index. Separate from deploy on purpose: the registry
  // is a different contract, and a collection that fails to list is still a
  // perfectly good collection — the launch must not be lost over it.
  async function registerOn(chainId, collection, from) {
    var chain = byId[chainId];
    var R = window.MOONPAD_REGISTRY || {};
    var sels = R.selectors || {};
    if (!chain || !chain.registry || !sels["register(address)"]) {
      throw new Error("No registry on " + (chain ? chain.name : chainId));
    }
    return ownerCall(chainId, chain.registry,
      "0x" + sels["register(address)"] + enc.addr(collection), from);
  }

  // ------------------------------------------------------------- pairing
  //
  // The vault has to exist before the coin does: Pons takes creatorFeeRecipient
  // at launch and it is set once, so the address it points at must already be
  // known. That is the whole reason the vault takes its coin through setCoin
  // afterwards rather than through its constructor.
  async function deployVault(chainId, collection, binder, costs, weights, from, payToken) {
    await switchChain(chainId);
    var V = window.MOONPAD_VAULT || {};
    if (!V.bytecode) throw new Error("The vault contract failed to load — reload the page");

    // costs and weights are uint256[4], fixed-size, so they sit inline.
    // The length is read off the arrays rather than written as a literal —
    // this loop said 3 after the contract moved to 4 tiers, which encodes
    // short and hands the constructor somebody else's bytes.
    var args = enc.addr(collection) + enc.addr(binder);
    for (var i = 0; i < costs.length; i++) args += enc.word(costs[i]);
    for (var j = 0; j < weights.length; j++) args += enc.word(weights[j]);
    // pendingRelease 0: a panel-launched vault folds its bank the moment
    // weight exists, as before. A dated first distribution is a manual-deploy
    // choice (Moonbabies), not something the panel asks every creator about.
    args += enc.word(0);
    // The Pons fee escrow on this chain, so the vault harvests its own trading
    // fees as a side effect of ordinary staking traffic. Pons never pushes —
    // its escrow pays only the recipient, on the recipient's own call — and a
    // vault that cannot pull was how Inkheads' fees got stranded on launch
    // night. Zero (no escrow configured) deploys a direct-send-only vault.
    var ponsCfg = (window.MoonpadPons && window.MoonpadPons.forChain)
      ? window.MoonpadPons.forChain(chainId) : null;
    args += enc.addr((ponsCfg && ponsCfg.feeEscrow) ||
                     "0x0000000000000000000000000000000000000000");
    // What this vault pays out in. Zero is ETH; for an RWA-paired launch it is
    // the same asset the curve is priced in, because that is what Pons credits
    // the creator fees in. It must equal the launch's pairToken — a vault whose
    // pay asset disagrees can never be paid at all, and nothing recovers it.
    args += enc.addr(payToken || "0x0000000000000000000000000000000000000000");

    var tx = { from: from, data: V.bytecode + args, value: "0x0" };
    try {
      tx.gas = pad(await provider().request({ method: "eth_estimateGas", params: [tx] }));
    } catch (e) {
      throw new Error("The vault would fail to deploy: " + (e && e.message ? e.message : e));
    }
    await priceTx(tx);
    return provider().request({ method: "eth_sendTransaction", params: [tx] });
  }

  // Launch the coin with its trading fees pointed at the vault from the very
  // first trade. The economics quote is read here rather than earlier on
  // purpose: it describes the launch config as it stands right now, and a
  // config that moves between the quote and the signature is exactly what the
  // factory checks it against.
  async function launchCoin(chainId, opts, from) {
    await switchChain(chainId);
    var chain = byId[chainId];
    var cfg = window.MoonpadPons.forChain(chainId);
    if (!cfg) throw new Error("Pairing is not available on " + (chain ? chain.name : chainId));

    if (!(await window.MoonpadPons.enabled(chain, cfg))) {
      throw new Error("Pons is not accepting launches right now.");
    }
    var economics = await window.MoonpadPons.economics(chain, cfg, opts.pairAsset);
    var fee = await window.MoonpadPons.fee(chain, cfg);

    var data = window.MoonpadPons.encodeLaunch(
      window.MoonpadPons.selectors.launchToken,
      {
        name: opts.coinName,
        symbol: opts.coinSymbol,
        logo: opts.logo || "",
        description: opts.description || "",
        socials: {
          twitter: opts.links.x || "",
          telegram: opts.links.telegram || "",
          discord: opts.links.discord || "",
          website: opts.links.website || "",
          farcaster: ""
        },
        creatorFeeRecipient: opts.vault,
        creatorTaxBps: opts.taxBps,
        buybackEnabled: false,
        expectedEconomics: economics,
        salt: opts.salt
      },
      cfg.config, opts.pairAsset || cfg.ethPair);

    var tx = { from: from, to: cfg.factory, data: data, value: "0x" + fee.toString(16) };
    try {
      tx.gas = pad(await provider().request({ method: "eth_estimateGas", params: [tx] }));
    } catch (e) {
      throw new Error("The coin launch would fail: " + (e && e.message ? e.message : e));
    }
    await priceTx(tx);
    return provider().request({ method: "eth_sendTransaction", params: [tx] });
  }

  // The creator's optional dev buy: the first purchase off the fresh Pons curve,
  // native ETH, from the creator's own wallet, the instant the coin exists. The
  // curve's buy is buy(uint256 quoteIn, uint256 minTokensOut, address recipient)
  // payable with msg.value == quoteIn (selector 0x59a87bc1, verified against Pons
  // source — the same call trade.js uses). Only meaningful for an ETH-priced
  // curve; a token-priced one is paid in the pair asset, not ETH, so the panel
  // gates this to ETH pairs.
  async function devBuy(chainId, curve, weiHex, from) {
    await switchChain(chainId);
    var wei = BigInt(weiHex || "0x0");
    if (wei <= 0n) return null;
    var value = "0x" + wei.toString(16);
    var BUY = "0x59a87bc1";
    // Quote first for a slippage floor. The creator is the first buyer on a fresh
    // curve so this rarely bites, but minOut 0 on a payable buy is a gift to a
    // front-runner — give it a 5% floor when the quote answers, and fall back to 0
    // only if the read fails (e.g. a rate-limited RPC).
    var minOut = 0n;
    try {
      var q = await provider().request({ method: "eth_call", params: [
        { from: from, to: curve, data: BUY + enc.word(wei) + enc.word(0) + enc.addr(from), value: value },
        "latest"
      ] });
      var out = BigInt(q && q !== "0x" ? q : "0x0");
      if (out > 0n) minOut = out * 95n / 100n;
    } catch (e) { minOut = 0n; }

    var tx = { from: from, to: curve,
      data: BUY + enc.word(wei) + enc.word(minOut) + enc.addr(from), value: value };
    try {
      tx.gas = pad(await provider().request({ method: "eth_estimateGas", params: [tx] }));
    } catch (e) {
      throw new Error("The dev buy would fail: " + (e && e.message ? e.message : e));
    }
    await priceTx(tx);
    return provider().request({ method: "eth_sendTransaction", params: [tx] });
  }

  // Bind the coin to the vault. One-way and once only — an unbound vault is
  // inert, which is the safe direction for the window between the two.
  async function bindCoin(chainId, vault, coin, from) {
    var sels = (window.MOONPAD_VAULT || {}).selectors || {};
    if (!sels["setCoin(address)"]) throw new Error("no selector for setCoin");
    return ownerCall(chainId, vault, "0x" + sels["setCoin(address)"] + enc.addr(coin), from);
  }

  // Listing a paired collection carries the vault address too, so the mint page
  // can find the staking contract without a second lookup.
  async function registerPaired(chainId, collection, vault, from) {
    var chain = byId[chainId];
    var sels = (window.MOONPAD_REGISTRY || {}).selectors || {};
    if (!chain || !chain.registry || !sels["register(address,address)"]) {
      throw new Error("No registry on " + (chain ? chain.name : chainId));
    }
    return ownerCall(chainId, chain.registry,
      "0x" + sels["register(address,address)"] + enc.addr(collection) + enc.addr(vault), from);
  }

  /// Read a deployed vault's pay asset back off the chain.
  ///
  /// The panel refuses to open a sale when this disagrees with the launch's
  /// pairToken. Nothing in the flow can produce that mismatch — the same value
  /// feeds both — but the failure is permanent and its only symptom is fees
  /// that silently never arrive, so it is asserted rather than assumed.
  async function readVaultPayToken(chainId, vault) {
    var chain = byId[chainId];
    if (!chain) throw new Error("unknown chain " + chainId);
    // payToken() — verified against `cast sig`, not typed from memory. Four
    // guessed vault selectors in an earlier tool reported silent garbage.
    var r = await rpc(chain, { method: "eth_call",
      params: [{ to: vault, data: "0x96336b30" }, "latest"] });
    if (!r || r === "0x") throw new Error("the vault did not answer payToken()");
    return ("0x" + r.slice(-40)).toLowerCase();
  }

  /**
   * Deploy a contract from bytecode that already has its constructor arguments
   * appended. Estimated and priced like every other transaction here, so a
   * constructor that would revert says so before the wallet opens rather than
   * after the gas is spent.
   *
   * Used by the internal deploy pages, which are the only places a contract is
   * created by hand rather than by the launch path.
   */
  async function deployRaw(data, from, chainId) {
    from = from || await connect();
    if (chainId) await switchChain(chainId);
    var tx = { from: from, data: data, value: "0x0" };
    try {
      tx.gas = pad(await provider().request({ method: "eth_estimateGas", params: [tx] }));
    } catch (e) {
      throw new Error("The deployment would fail: " + (e && e.message ? e.message : e));
    }
    await priceTx(tx);
    return provider().request({ method: "eth_sendTransaction", params: [tx] });
  }

  window.MoonpadLaunch = {
    ownerCall: ownerCall,
    deployRaw: deployRaw,
    readVaultPayToken: readVaultPayToken,
    feeFor: feeFor,
    registerOn: registerOn,
    deployVault: deployVault,
    launchCoin: launchCoin,
    devBuy: devBuy,
    bindCoin: bindCoin,
    registerPaired: registerPaired,
    abi: abi,
    waitForTx: async function (hash, chainId) {
      var chain = byId[chainId];
      for (var i = 0; i < 90; i++) {
        // Through the shared reader: retry, and one budget shared with every other
        // request the page makes. A dropped poll is NOT a failed transaction — the
        // tx is already signed, paid for and very likely mined, so a blip here
        // means "ask again", not "tell them it broke". Hence the catch to null,
        // which the loop reads exactly like a not-yet-mined receipt; only running
        // out of attempts is a real timeout.
        var r = await window.MoonpadRPC.send(chain.rpc, "eth_getTransactionReceipt", [hash])
          .catch(function () { return null; });
        if (r) {
          if (r.status === "0x0") throw new Error("The transaction reverted");
          return r;
        }
        await new Promise(function (res) { setTimeout(res, 2500); });
      }
      throw new Error("Not confirmed yet — check the explorer");
    },
    chains: CHAINS,          // only the open ones
    allChains: ALL,
    connect: connect,
    signLaunch: signLaunch,
    payFee: payFee,
    currentChain: currentChain,
    switchChain: switchChain,
    holdings: holdings,
    hasAccess: hasAccess,
    inspect: inspect,
    passes: function () { return PASSES.slice(); },
    deploy: deploy,
    waitForContract: waitForContract,
    encodeArgs: encodeArgs,          // exported so it can be tested
    // Add a collection that grants access. Call once per pass, after deploy.
    addPass: function (chainId, address, label) {
      PASSES.push({ chainId: chainId, address: address, label: label || "pass" });
    }
  };
})();
