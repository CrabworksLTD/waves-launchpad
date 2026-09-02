// Chains a collection can be deployed to.

// The active wallet provider, site-wide. wallet.js runs the EIP-6963 picker
// and parks the chosen provider on MoonpadWallet; every page asks here instead
// of grabbing window.ethereum, so the wallet the user picked is the wallet
// that signs — not whichever extension won the injection race.
window.MOONPAD_ETH = function () {
  return (window.MoonpadWallet && window.MoonpadWallet.provider) || window.ethereum;
};
//
// The drop contract is compiled for evmVersion "paris", so it deploys on any of
// these without relying on PUSH0. Adding a chain is one entry here — nothing
// else in the launch flow knows about specific networks.
//
// Every id and rpc below is checked against the live network by
// tools/verify-chains.js, which asks each rpc for eth_chainId. A wrong chainId
// here would have someone deploy to a chain they did not choose.
//
// `opensea` is the chain's slug in OpenSea asset urls
// (opensea.io/assets/<slug>/<contract>) — OpenSea indexes every contract on a
// supported chain unprompted, so the link works from the moment a collection
// deploys. Absent means OpenSea does not carry the chain and no Trade link is
// offered. Note Polygon is "matic" and ApeChain "ape_chain", not their keys.
//
// `registry` is the MoonpadRegistry address on that chain — the on-chain index
// the explore page reads. null means no registry there yet, and the explore page
// says so rather than showing an empty list as if nothing had ever launched.
//
// `live: true` is what the UI offers. The rest are wired and verified but held
// back — turning one on is a single flag, no code change, so opening a chain
// later is a deploy rather than a build.
// The protocol fee, in one place so it can never disagree between the launch
// panel and the mint page. Both numbers are written into each collection at
// deploy and are immutable there — changing them here only affects collections
// launched afterwards.
window.MOONPAD_FEE = {
  // The greater of the two, per token, paid by the buyer on top of the price.
  //
  // The floor is the business and the percentage is the upside. Below a 0.04
  // ETH mint the floor is what pays — and most collections are below it — so
  // this number decides the revenue while the percentage only reaches the rare
  // expensive launch. Raising the floor is the lever; raising the percentage
  // barely moves anything.
  //
  // 0.001 rather than more: gas here is about 0.0000064 ETH, so a fee this size
  // is already 150x the cost of the transaction it rides on. At 0.0025 a buyer
  // minting a 0.002 ETH collection would pay more in fee than in price, which
  // taxes cheap collections hardest — and cheap collections are the volume.
  floor: "1000000000000000",  // 0.001 ETH per token, in wei
  bps: 250,                   // 2.5% of price per token
  // Where fees are swept to. Set PER CHAIN, never here — this global is the
  // immutable feeTo for every collection the panel launches on every chain, so
  // an address parked here is baked into strangers' drops too and they cannot
  // undo it (audit A2-2). Null forces both rates to zero, which is the safe
  // default: no recipient means no fee, not a fee that goes nowhere.
  to: null
};

// The platform token. Null until $MOON is launched on Pons — every page that
// mentions it checks this first and says "not launched yet" rather than
// rendering zeros, because a chart of nothing looks like a dead token.
//
// `curve` is the bonding curve Pons deploys alongside the token; it holds the
// unsold supply, so its balance is what has *not* been bought. After the curve
// graduates at 4.2 ETH raised, trading moves to a Uniswap V4 pool and the curve
// stops being the price.
window.MOONPAD_MOON = {
  chainId: 4663,
  address: "0x69e826f373b16a96b54f9fae386a26b6c02a28d6",   // launched 2026-08-18, treasury launch-and-buy verified
  curve: "0x5e58413c23a7bd128e4de026bf1dd456b0619517",
  symbol: "MOON",
  decimals: 18,
  // where a buyer goes to get some
  buyUrl: "https://www.ponsfamily.com/launchpad/0x69e826f373b16a96b54f9fae386a26b6c02a28d6"
};

// Which collection is Moonbabies. It is the one collection whose staking has
// its own page — every other paired launch carries the panel on its own mint
// page, where its buyers already are. Null until it is deployed, and both pages
// read it from here so they cannot disagree about which one it is.
/* WAVES stands alone: no spotlight/hidden/contest site config here, and no
 * ties to any other launchpad's collections. What WAVES lists comes from its
 * own records; this file is chain plumbing only. */

// The activation ladder: what a tier costs, and the share it earns.
//
// Both numbers are relative to tier 1, so a collection sets one price and the
// rest follow. Held here rather than in the launch panel because the deploy
// checker has to encode the identical ladder — when the two held their own
// copies, the checker went on passing against a ladder the app had stopped
// producing, which is how BigInt(1.8) reached production behind a green check.
//
// Cost and weight rise together: 2x the coin buys exactly 2x the share. An
// earlier ladder made the top tier cheaper per unit of weight, which sounds
// generous and is not — it makes the top rung strictly the best buy, so the
// three below it are dead rungs for anyone who is not simply priced out.
// Flat keeps every rung a real choice: pick the one you want to spend, not the
// one the maths forces.
//
// Weights are integers because the vault stores them as uint256, and only the
// ratios matter — 1/2/4/8 is the same ladder as 1.25/2.5/5/10, which is how it
// is labelled for Moonbabies.
window.MOONPAD_TIERS = {
  cost: [1, 2, 5, 10],      // multiples of the tier-1 price
  weight: [1, 2, 5, 10],    // share of the fee stream, as the chain stores it
  // What a tier is called. Only ratios reach the payout, so scaling every
  // weight by the same number changes nothing on chain — this is the label,
  // not a second ladder, and it must stay proportional to `weight` or the UI
  // starts quoting a share the vault will not pay.
  label: [1, 2, 5, 10]
};

// The platform's mint-gate signer. Baked into every allowlist launch as the
// address whose blessing mintSigned() checks during the wave window; the key
// lives in the api's MINT_SIGNER_KEY. Compromise means bots skip the queue
// (bounded by the window, no funds at risk); rotation changes new launches only.
// Where a paired token trades: Pons, its launchpad. The function takes the
// token address so a deep link can slot in the moment we learn Pons' token
// page format — until then every Trade token button lands on their launchpad.
// DexScreener token page. Their slug for Robinhood Chain is "robinhood" —
// verified 2026-08-23 against their API (/latest/dex/tokens/<MOON> returns
// chainId "robinhood" and the v4 ETH pool). The token-address form resolves to
// the token's page regardless of which pool it trades in, so it survives a
// pool migration; set this back to null to hide the link if that ever breaks.
window.MOONPAD_DEXSCREENER = function (token) {
  return "https://dexscreener.com/robinhood/" + String(token || "").toLowerCase();
};

window.MOONPAD_PONS_URL = function (token) {
  return token
    ? "https://www.ponsfamily.com/launchpad/" + token
    : "https://www.ponsfamily.com/launchpad";
};

window.MOONPAD_MINT_SIGNER = "0x544acca55fb1063280cb1937e8c145ad783788b4";

window.MOONPAD_CHAINS = [
  {
    id: 4663,
    key: "robinhood",
    opensea: "robinhood",
    name: "Robinhood Chain",
    rpc: "https://rpc.mainnet.chain.robinhood.com",
    explorer: "https://robinhoodchain.blockscout.com",
    symbol: "ETH",
    decimals: 18,
    live: true,
    // WAVES keeps no on-chain registry — launches are recorded in our own
    // records API, same as the Solana side.
    registry: null,

    /* WAVES's own EVM treasury, set 2026-09-02. The same address that receives
     * the Arweave storage fee (FEE_TO_EVM), so both sides of the business land
     * in one wallet.
     *
     * Turning this from null switches the protocol mint fee on: the greater of
     * 0.001 ETH or 2.5%, per token, paid by the buyer on top of the price. Both
     * numbers are written into each collection at deploy and are immutable
     * there, so this only reaches collections launched from now on. */
    feeTo: "0xE52f574AC7006614EBe1c8a82913a5C07eC73CC7",
    // A $-token (coin) allowlist reads holder balances at the block the sale
    // opened on, for the whole wave. This RPC prunes that state after ~10 min
    // (measured live 2026-08-20), so a longer wave locks holders out — the gate
    // fails closed. Cap coin-gate waves at 5 min here; wallet-list phases read
    // no historical state and are not limited. Set per chain from its RPC's
    // real history window; absent, the panel falls back to a safe 5.
    coinWaveMax: 5,
    note: "StonkBrokers, Mancer and Script Kiddies all live here"
  },
  {
    id: 8453,
    key: "base",
    opensea: "base",
    name: "Base",
    rpc: "https://mainnet.base.org",
    explorer: "https://basescan.org",
    symbol: "ETH",
    decimals: 18,
    note: "cheap and busy — the default for a first launch off Robinhood"
  },
  {
    id: 1,
    key: "ethereum",
    opensea: "ethereum",
    name: "Ethereum",
    rpc: "https://ethereum-rpc.publicnode.com",
    explorer: "https://etherscan.io",
    symbol: "ETH",
    decimals: 18,
    note: "highest fees by a wide margin; only worth it for a marquee drop"
  },
  {
    id: 42161,
    key: "arbitrum",
    opensea: "arbitrum",
    name: "Arbitrum One",
    rpc: "https://arb1.arbitrum.io/rpc",
    explorer: "https://arbiscan.io",
    symbol: "ETH",
    decimals: 18
  },
  {
    id: 10,
    key: "optimism",
    opensea: "optimism",
    name: "OP Mainnet",
    rpc: "https://mainnet.optimism.io",
    explorer: "https://optimistic.etherscan.io",
    symbol: "ETH",
    decimals: 18
  },
  {
    id: 137,
    key: "polygon",
    opensea: "matic",
    name: "Polygon",
    rpc: "https://polygon-bor-rpc.publicnode.com",
    explorer: "https://polygonscan.com",
    symbol: "POL",
    decimals: 18
  },
  {
    id: 7777777,
    key: "zora",
    opensea: "zora",
    name: "Zora",
    rpc: "https://rpc.zora.energy",
    explorer: "https://explorer.zora.energy",
    symbol: "ETH",
    decimals: 18
  },
  {
    id: 33139,
    key: "apechain",
    opensea: "ape_chain",
    name: "ApeChain",
    rpc: "https://rpc.apechain.com",
    explorer: "https://apescan.io",
    symbol: "APE",
    decimals: 18
  },
  {
    id: 46630,
    key: "robinhood-testnet",
    name: "Robinhood Chain Testnet",
    rpc: "https://rpc.testnet.chain.robinhood.com",
    explorer: "https://robinhoodchain.blockscout.com",
    symbol: "ETH",
    decimals: 18,
    testnet: true,
    live: false,
    registry: null,   // MoonpadRegistry, deployed once per chain via /setup
    note: "deploy here first — a mistake costs nothing"
  }
];

// ------------------------------------------------------------- switching chain
//
// Ask the wallet to move to a chain, adding the network first if it has never
// heard of it.
//
// Four pages carried their own copy of this and they had drifted apart: two of
// them asked for the switch with no fallback at all, so a wallet that does not
// already carry Robinhood Chain just threw. That was survivable for as long as
// everyone arrived with 4663 already configured — a desktop extension its owner
// had set up by hand. WalletConnect ends that assumption: a phone now connects
// on whatever chain its wallet already had, deliberately, so "this wallet has
// never heard of 4663" became the ordinary first-transaction case rather than
// an edge one.
//
// 4902 is "unrecognised chain", and wallets disagree about where they put it:
// bare on the error, nested under data.originalError (MetaMask through some
// bridges), or stated only in the message. All three mean the same thing.
window.MOONPAD_SWITCH_CHAIN = async function (idOrChain) {
  var c = idOrChain && typeof idOrChain === "object" ? idOrChain
        : (window.MOONPAD_CHAINS || []).filter(function (x) { return x.id === idOrChain; })[0];
  if (!c) throw new Error("unknown chain " + idOrChain);
  var eth = window.MOONPAD_ETH();
  if (!eth) throw new Error("No wallet found in this browser.");
  var want = "0x" + c.id.toString(16);

  // Already there. Never prompt for nothing — an unexplained wallet popup on a
  // page the user has not asked to transact on reads as the site misbehaving.
  try {
    if (await eth.request({ method: "eth_chainId" }) === want) return;
  } catch (e) {}

  try {
    await eth.request({ method: "wallet_switchEthereumChain", params: [{ chainId: want }] });
  } catch (e) {
    var code = e && (e.code || (e.data && e.data.originalError && e.data.originalError.code));
    var unknown = code === 4902 ||
      /unrecogni[sz]ed chain|unknown chain|not been added/i.test((e && e.message) || "");
    if (!unknown) throw e;    // a rejection is the user's answer, not a missing network
    await eth.request({ method: "wallet_addEthereumChain", params: [{
      chainId: want,
      chainName: c.name,
      rpcUrls: [c.rpc],
      blockExplorerUrls: [c.explorer],
      nativeCurrency: { name: c.symbol, symbol: c.symbol, decimals: c.decimals || 18 }
    }] });
  }
};

// ---------------------------------------------------------------- reading the chain
//
// Every page used to carry its own copy of a three-line `call()`. That is why
// the same missing-retry bug had to be fixed three separate times in one day
// (mint.js, then the bot, then stake.js) and was still absent from three more
// files. One implementation, used everywhere, is the actual fix.
//
// Two problems are solved here, and they are the same problem:
//
//   1. A dropped request killed the page. A public RPC occasionally drops one.
//      Sixteen sequential reads means sixteen chances to lose the whole render.
//   2. Sixteen sequential round trips is ~3.2s of pure latency. Batched, the
//      identical reads take 0.26s — measured against the Robinhood node.
//
// Fewer requests is both faster AND less fragile, which is why batching matters
// more than retry does. Retry is the seatbelt; batching removes most of the crashes.
window.MoonpadRPC = (function () {
  var RETRIES = 2;      // 3 attempts total
  var BACKOFF = 400;    // ms between them

  // ONE gate for every request the page makes, single or batched.
  //
  // A per-call limit is not enough: the node's ceiling is global, so two
  // independent readers each politely staying under it still add up to over it.
  // That is exactly what happened here — the vault read and the janitor scan
  // overlapped, both got refused, both retried, and the page ended up making
  // MORE calls (1084) than the unbatched version it replaced (668). Counting
  // in-flight calls in one place is the only thing that actually holds.
  // 25 = one batch at a time. This is deliberately below what the node will
  // tolerate, because being refused is far more expensive here than being slow:
  // when the rate limiter rejects a request it appends its own CORS header to
  // the one the node already set, producing
  //
  //     access-control-allow-origin: *,*
  //
  // which Chrome refuses as invalid. The browser then cannot read the response
  // at all — a 429 surfaces as "Failed to fetch", indistinguishable from the
  // network being down, and that is the error on the staking page. 39 of 40
  // concurrent requests reproduced it. None of this is visible from Node, which
  // does not enforce CORS, which is why the whole thing tested clean there.
  //
  // So the ceiling is not "what does the node allow" but "what never gets
  // refused". One batch at a time.
  var MAX_INFLIGHT = 25;   // calls, not requests — the node counts calls
  var inFlight = 0;
  var queue = [];

  function drain() {
    while (queue.length && (inFlight + queue[0].n <= MAX_INFLIGHT || inFlight === 0)) {
      var job = queue.shift();
      inFlight += job.n;
      job.go();
    }
  }

  // n is how many calls this request carries, so one batch of 25 costs 25.
  function gate(n, fn) {
    return new Promise(function (resolve, reject) {
      queue.push({ n: n, go: function () {
        fn().then(function (v) {
          inFlight -= n; drain(); resolve(v);
        }, function (e) {
          inFlight -= n; drain(); reject(e);
        });
      }});
      drain();
    });
  }

  function post(rpc, body, weight) {
    return gate(weight, function () {
      return fetch(rpc, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body)
      }).then(function (r) {
        // A 4xx/5xx still parses as JSON on some gateways and not on others.
        // Treat a non-ok status as a transport failure so it gets retried,
        // rather than letting `.json()` throw something unrecognisable.
        if (!r.ok) { var e = new Error("rpc http " + r.status); throw e; }
        return r.json();
      });
    });
  }

  // Retry transport failures only. A revert is the chain's considered answer —
  // asking again gets the same answer, so it is rethrown immediately and marked
  // `fromChain` so callers can tell "the node is unreachable" from "this call
  // reverted", which are different bugs with different fixes.
  function withRetry(fn) {
    function attempt(left) {
      return fn().catch(function (e) {
        if (left <= 0 || (e && e.fromChain)) throw e;
        return new Promise(function (r) { setTimeout(r, BACKOFF); })
          .then(function () { return attempt(left - 1); });
      });
    }
    return attempt(RETRIES);
  }

  // Any JSON-RPC method, through the same gate. eth_getLogs is the reason this
  // exists: it is not an eth_call so it cannot ride in a batch, but it is the
  // heaviest thing the site asks for and it has to share one budget with
  // everything else. The $MOON page proved the point — its log scan capped
  // itself at 5 concurrent, which alone is fine, but running alongside 43
  // tokenURI reads it went over and 15 requests failed outright.
  //
  // A getLogs counts as five so about five run at once, matching what the node
  // was measured to take; everything else counts as one.
  function send(rpc, method, params) {
    // A getLogs takes the whole budget, so they run one at a time. Five at once
    // was measured to be too many: with wide ranges each response is large and
    // slow, and five of those together get refused — 17 failed requests a load
    // against 0 serialized. Same rule as the batch size, for the same reason:
    // the node's ceiling is work, not request count.
    var weight = method === "eth_getLogs" ? MAX_INFLIGHT : 1;
    return withRetry(function () {
      return post(rpc, { jsonrpc: "2.0", id: 1, method: method,
                         params: params || [] }, weight).then(function (j) {
        if (j && j.error) {
          var e = new Error(j.error.message); e.fromChain = true; throw e;
        }
        return j.result;
      });
    });
  }

  // One eth_call. Same contract as the per-page versions it replaces: resolves
  // to the raw hex result, throws on revert.
  function call(rpc, to, data, block) {
    return withRetry(function () {
      return post(rpc, {
        jsonrpc: "2.0", id: 1, method: "eth_call",
        params: [{ to: to, data: data }, block || "latest"]
      }, 1).then(function (j) {
        if (j && j.error) {
          var e = new Error(j.error.message); e.fromChain = true; throw e;
        }
        return j.result;
      });
    });
  }

  // Many eth_calls in ONE request.
  //
  // calls: [{ to, data }, ...]   ->   resolves to [hex | null, ...]
  //
  // A call that reverts comes back as null in its slot instead of throwing.
  // That is deliberate and is what makes this safe to drop into existing code:
  // reads that were individually wrapped in try/catch (an old vault with no
  // escrow(), a token with no symbol()) keep working, and one optional read
  // failing can no longer take the other fifteen down with it.
  //
  // Results are matched back by id, never by array position — a JSON-RPC server
  // is allowed to return a batch in any order, and assuming order here would
  // silently assign the wrong value to the wrong field. That is the kind of bug
  // that shows a plausible number rather than an error.
  // Measured against the Robinhood node, not guessed. It applies ONE limit and
  // it is a concurrency limit, not a quota: about 55 calls may be in flight at
  // once, whether that is one batch of 55 or three batches of 25. Over that it
  // answers HTTP 429 — and recovers in ~97ms, as soon as the in-flight count
  // drops. Eighty sequential single calls never trip it at all.
  //
  // So chunks go out ONE at a time. That reads like the slow choice and is not:
  // 318 calls take a steady ~2.0s serialized, against 1.2-4.8s with two in
  // flight, because every 429 costs a retry and then a fall back to one-call-
  // at-a-time, which loses far more than the overlap won. Serialized it also
  // leaves headroom for the other tabs a user has open on the same limit.
  //
  // This is the bug that made a 106-NFT wallet read as empty: thirteen chunks
  // fired at once, every one of them refused.
  // 25 and not 50, even though a 50-call batch of a cheap getter answers fine:
  // isStale(uint256) does an external ownerOf() per entry, and 644 of those at
  // 50-per-batch took 17s and then 73s against 4.2s at 25. The ceiling is work,
  // not call count, so this is set from the heaviest real call in the app.
  var MAX_BATCH = 25;   // calls per request

  function callMany(rpc, calls, block) {
    if (!calls.length) return Promise.resolve([]);

    // Split an oversized list and hand every piece straight to the gate, which
    // is what decides how many actually run at once. Two throttles that each
    // think they are in charge is how the last version ended up over the limit.
    if (calls.length > MAX_BATCH) {
      var parts = [];
      for (var i = 0; i < calls.length; i += MAX_BATCH)
        parts.push(calls.slice(i, i + MAX_BATCH));
      return Promise.all(parts.map(function (p) { return callMany(rpc, p, block); }))
        .then(function (res) { return [].concat.apply([], res); });
    }

    function sequential() {
      // Fallback for a node that does not do batching. Slow, but correct —
      // this is the old behaviour, so worst case we are no worse than before.
      var out = [];
      return calls.reduce(function (p, c) {
        return p.then(function () {
          return call(rpc, c.to, c.data, block)
            .then(function (h) { out.push(h); }, function () { out.push(null); });
        });
      }, Promise.resolve()).then(function () { return out; });
    }

    return withRetry(function () {
      return post(rpc, calls.map(function (c, i) {
        return { jsonrpc: "2.0", id: i, method: "eth_call",
                 params: [{ to: c.to, data: c.data }, block || "latest"] };
      }), calls.length).then(function (j) {
        // Not an array back means the node answered a batch with something else
        // (a single error object, or an HTML error page that happened to parse).
        // Don't guess — fall through to one-at-a-time.
        if (!Array.isArray(j) || j.length !== calls.length) throw new Error("no batch");
        var out = new Array(calls.length);
        for (var k = 0; k < j.length; k++) {
          var row = j[k], id = row && typeof row.id === "number" ? row.id : k;
          out[id] = row && row.error ? null : row.result;
        }
        return out;
      });
    }).catch(function () { return sequential(); });
  }

  return { call: call, callMany: callMany, send: send };
})();
