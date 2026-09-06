// GET /api/rh-keeper — pay Robinhood holders their share, on a schedule.
//
// For every launch that pledged: work out what that token earned, claim it,
// then split it across holders in proportion to what they hold.
//
// ── The ordering rule, inherited from the Solana keeper ──────────────────────
// Claiming moves money OUT of the curve and into a hot wallet. Once claimed the
// curve reports nothing owed, so a later failure does not retry — it strands.
// Everything that can fail is therefore done BEFORE the claim:
//
//   1. read the holder table   (built by /api/rh-indexer)
//   2. attribute the pot       (which token earned what — see below)
//   3. check gas               (the keeper's float, never the pot)
//   4. claim                   ← the first irreversible step
//   5. persist the plan to KV
//   6. execute, marking progress as each transfer lands
//
// A crash after step 4 leaves a plan, and the next run finishes it instead of
// claiming again. That is what makes this safe to run unattended.
//
// ── ⚠️ Why attribution is not optional ───────────────────────────────────────
// The curve keeps ONE balance per address:
//
//     mapping(address => uint256) public owed;
//
// so every token that pledges to this keeper pays into the same pot, and
// claiming returns a single number with no record of where it came from. On
// Solana each pool holds its own fees and the question never arises.
//
// Paying that pot out by holder share alone would take one token's fees and
// hand them to another token's holders. So each token's contribution is
// recomputed from its own trades: every Bought and Sold carries the fee it
// paid, and the split is fixed by the rung, so the keeper's share of each trade
// is arithmetic. Sum it, and the pot divides honestly.
//
// ── The minimum pot ──────────────────────────────────────────────────────────
// Gas comes from the keeper's own float. Paying 100 holders costs about $2, so
// a token earning pennies would burn our ETH forwarding them. A run therefore
// waits until the pot is worth several times the gas to distribute it.

import { kv } from "./_guard.js";

export const config = { runtime: "nodejs" };

const RPC = process.env.RH_RPC || "https://rpc.mainnet.chain.robinhood.com";
/* Robinhood launches now trade on the V4-hook singleton
 * (contracts/WavesCurveHook.sol). Its owed[] mapping, claim(), platformVolumeBps,
 * terms getters and Bought/Sold events are identical to the retired standalone
 * curve, so the keeper's claim + fee-walk work against it unchanged — only the
 * address moves. RH_CURVE is ignored: it named the retired curve. */
const CURVE = process.env.RH_HOOK || "0xA02AAaCb311F49e7f55c4dF5b40b3cFCe0D76888";

// Bought(address,address,uint256,uint256,uint256) / Sold(...)
const BOUGHT = "0x7ce543d1780f3bdc3dac42da06c95da802653cd1b212b8d74ec3e3c33ad7095c";
const SOLD   = "0x9be8a5ca22b7e6e81f04b5879f0248227bb770114291bd47dfaee4c3a82ad60e";

/* The V4 router that turns the pot into the asset a creator chose. Absent
 * until it is deployed, and absent means "pay ETH" — the behaviour before this
 * existed, which is honest rather than broken. */
const SWAP_ROUTER = process.env.RH_SWAP_ROUTER || null;
/* Buyback-and-burn buys the token on its own curve through the public
 * WavesHookRouter and delivers it straight to the dead address. buy() takes a
 * recipient, so no separate burn tx is needed. */
const HOOK_ROUTER = process.env.RH_HOOK_ROUTER || "0x29b0638dd7fcd8f829fed7cd2a10830a6c1faa27";
const DEAD = "0x000000000000000000000000000000000000dEaD";
const ROUTER_BUY = "0xb3ffb760"; // buy(address,uint256,address,uint256)

// WavesSwapRouter.swap((address,address,uint24,int24,address),uint256,address)
const SEL_SWAP = "0x4ea88ad7";
// WavesSwapRouter.quoteBest((address,address,uint24,int24,address)[],uint256)
const SEL_QUOTE_BEST = "0x33a3a81b";
// swap2(PoolKey,PoolKey,uint256,address) / quoteBest2(PoolKey,PoolKey[],uint256)
const SEL_SWAP2 = "0xe235cc1c";
const SEL_QUOTE_BEST2 = "0x09edbcc5";
/* The middle of every two-hop route. Everything on this chain without a usable
 * ETH market trades against USDG, so there is one intermediate rather than a
 * graph to search. */
const USDG = "0x5fc5360d0400a0fd4f2af552add042d716f1d168";
const SEL_TRANSFER = "0xa9059cbb";      // ERC20 transfer(address,uint256)
const SEL_BALANCE_OF = "0x70a08231";    // ERC20 balanceOf(address)

const CHUNK = 50000n;
const MAX_CHUNKS = 12;
const GAS_PER_TRANSFER = 21000n;
/* ⚠️ Measured, not assumed. A textbook ERC20 transfer is about 51,000 and the
 * 65,000 budgeted here was reasoning from that — but Robinhood's tokenised
 * equities are not textbook ERC20s, and an MSFT transfer burned 64,484 and
 * still ran out. The transaction reverted, and because a reverted receipt used
 * to count as success the holder was recorded as paid.
 *
 * Generous now, because an unused gas limit costs nothing: the sender pays for
 * gas USED. Only the worth-it estimate is affected, and over-estimating there
 * is the safe direction — it waits for a bigger pot rather than starting a run
 * it cannot finish. */
const GAS_PER_ERC20 = 250000n;
const GAS_SWAP = 400000n;
// two swaps in one lock, so roughly twice the work plus the second settlement
const GAS_SWAP2 = 700000n;
const GAS_CLAIM = 80000n;
const GAS_BURN = 600000n;   // one router.buy that opens/settles a curve position

/* How much worse than the quote a fill is allowed to be. The keeper is the only
 * thing trading these pools at this size, but the mempool is public and an
 * unprotected swap is a sandwich waiting to happen. 3% is loose enough that
 * ordinary drift between quoting and mining does not abort a payout. */
const SLIPPAGE_BPS = 300n;

const ZERO_ADDR = "0x" + "0".repeat(40);

/* ⚠️ The most a pool may charge before the payout is worse than not swapping.
 *
 * V4 fees are hundredths of a bip, so 100000 is 10%. That sounds generous until
 * you look at the chain: of 177 fillable reward assets, every normal one wins on
 * a tier between 0.01% and 5.01% — the equities cluster tightly around 4.8%.
 * Four are different. SPY, NFLX and INTC have nothing better than a 70% pool and
 * MCD nothing better than 20%.
 *
 * quoteBest picks by output, so it would have chosen those quite correctly: they
 * ARE the best available price. But "best available" and "worth doing" are not
 * the same question when the answer costs holders seventy per cent of their
 * money. ETH is better than that, so those assets fall back. */
const MAX_POOL_FEE = 100000;
/* The pot must be worth this many times the gas to move it. Below that the run
 * waits: forwarding a dollar at a cost of a dollar helps nobody. */
const WORTH_IT = 5n;

let rpcId = 0;
async function rpc(method, params) {
  /* ⚠️ Retried, like the indexer. Robinhood's public node throttles a burst
   * hard (429), and a keeper run makes many calls — without backoff the whole
   * run died on the first refusal ("rpc 429"). A run is heavier than an index
   * sweep, so this backs off a little longer and a little more often. RH_RPC can
   * point at a private endpoint to avoid this entirely. */
  for (let attempt = 0; attempt < 6; attempt++) {
    try {
      const r = await fetch(RPC, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method, params }),
        signal: AbortSignal.timeout(25000)
      });
      if (!r.ok) throw new Error("rpc " + r.status);
      const j = await r.json();
      if (j.error) throw new Error(j.error.message || "rpc error");
      return j.result;
    } catch (e) {
      if (attempt === 5) throw e;
      await new Promise((s) => setTimeout(s, 700 * Math.pow(2, attempt))); // ~22s total
    }
  }
}

const addrOf = (t) => "0x" + String(t).slice(-40).toLowerCase();

/* Hand-rolled encoding, because this file has no ABI library and a payout is a
 * bad place to discover a dependency. Every one of these was checked against
 * `cast calldata` byte for byte before it was used to move money.
 *
 * A PoolKey is five static words, so it inlines with no offset — the tuple is
 * not dynamic. The ARRAY of them is dynamic and needs the offset/length header,
 * which is the part that is easy to get wrong and silently quote garbage. */
const pad = (v) => BigInt(v).toString(16).padStart(64, "0");
const encAddr = (a) => String(a).replace(/^0x/, "").toLowerCase().padStart(64, "0");
const encKey = (k) =>
  encAddr(k.currency0) + encAddr(k.currency1) + pad(k.fee) + pad(k.tickSpacing) + encAddr(k.hooks);

function encQuoteBest(keys, amountIn) {
  return SEL_QUOTE_BEST +
    pad(64) +                       // offset to the array: two head words in
    pad(amountIn) +
    pad(keys.length) +
    keys.map(encKey).join("");
}

const encSwap = (key, minOut, to) => SEL_SWAP + encKey(key) + pad(minOut) + encAddr(to);

/* Two static PoolKeys inline, so no offsets — unlike quoteBest2 below, whose
 * array is dynamic and needs one. Both checked against `cast calldata`. */
const encSwap2 = (a, b, minOut, to) =>
  SEL_SWAP2 + encKey(a) + encKey(b) + pad(minOut) + encAddr(to);

function encQuoteBest2(nearKey, farKeys, amountIn) {
  // head: keyA (5 words) + offset + amountIn = 7 words, so the array starts at 224
  return SEL_QUOTE_BEST2 + encKey(nearKey) + pad(224) + pad(amountIn) +
    pad(farKeys.length) + farKeys.map(encKey).join("");
}
const encTransfer = (to, amount) => SEL_TRANSFER + encAddr(to) + pad(amount);
const word = (d, i) => BigInt("0x" + String(d).replace(/^0x/, "").slice(i * 64, i * 64 + 64));

/* The platform's cut, in basis points OF VOLUME, by rung. Mirrors
 * platformVolumeBps() in the curve — the contract is the authority, this is
 * only used to work out what is left for the creator side. */
const PLATFORM_BPS = { 100: 40, 200: 50, 300: 60, 400: 70, 500: 80, 1000: 90 };

/**
 * The keeper's key, in the form viem wants.
 *
 * MetaMask exports a private key as bare hex with no 0x, and viem rejects that
 * with "invalid private key, expected hex or 32 bytes, got string". Refusing a
 * correct key over a missing prefix is a pointless way to break a payout run,
 * so both forms are accepted and anything else is rejected clearly.
 */
function keeperKey() {
  const raw = String(process.env.RH_KEEPER_SECRET || "").trim();
  if (!raw) return null;
  const hex = raw.startsWith("0x") ? raw : "0x" + raw;
  if (!/^0x[0-9a-fA-F]{64}$/.test(hex)) {
    throw new Error("RH_KEEPER_SECRET is not a 32-byte hex private key");
  }
  return hex;
}

/**
 * What this token has earned for its holders since the last payout.
 *
 * Walked from the curve's own trade events. `fee` on each is what the trader
 * paid; the platform's share of that trade comes off first, and the pledged
 * fraction of what remains is the holders'.
 */
async function accrued(db, token, feeBps, rewardsBps, fromBlock, latest) {
  const key = "rhk:" + token + ":cursor";
  let cursor = BigInt((await db.get(key).catch(() => null)) || fromBlock || 0);
  if (cursor <= 0n || cursor >= latest) return { wei: 0n, upTo: cursor };

  const platBps = BigInt(PLATFORM_BPS[feeBps] ?? 40);
  const topic = "0x" + "0".repeat(24) + String(token).replace(/^0x/, "").toLowerCase();
  let total = 0n;

  for (let i = 0; i < MAX_CHUNKS && cursor < latest; i++) {
    const to = cursor + CHUNK > latest ? latest : cursor + CHUNK;
    let logs;
    try {
      logs = await rpc("eth_getLogs", [{
        address: CURVE,
        fromBlock: "0x" + cursor.toString(16),
        toBlock: "0x" + to.toString(16),
        topics: [[BOUGHT, SOLD], topic]
      }]);
    } catch (e) {
      break;                      // refused window: keep what we have, resume later
    }
    for (const lg of logs) {
      /* Bought(token, buyer, ethIn, tokensOut, fee)
       * Sold  (token, seller, tokensIn, ethOut, fee)
       * — the fee is the third data word either way. The volume it was charged
       * on is the ETH side, which is word 0 on a buy and word 1 on a sell. */
      const isBuy = String(lg.topics[0]).toLowerCase() === BOUGHT;
      const volume = isBuy ? word(lg.data, 0) : word(lg.data, 1);
      const fee = word(lg.data, 2);
      let toPlatform = (volume * platBps) / 10000n;
      if (toPlatform > fee) toPlatform = fee;
      const creatorSide = fee - toPlatform;
      total += (creatorSide * BigInt(rewardsBps)) / 10000n;
    }
    cursor = to;
  }
  return { wei: total, upTo: cursor };
}

/**
 * Sign a transaction WITHOUT sending it, and say what its hash will be.
 *
 * ⚠️ This split is what makes the swap safe to retry.
 *
 * A transfer that is sent twice is a rounding error — the second one fails on
 * balance, or overpays one holder. A SWAP sent twice spends a slice of the pot
 * that has already been spent, and the second attempt eats into another token's
 * money. So the swap's hash is written down before it is broadcast: a run that
 * dies mid-swap resumes by asking whether that exact hash landed, and either
 * uses its result or rebroadcasts the identical bytes. Same nonce, same
 * transaction — the chain cannot apply it twice.
 */
async function signKeeperTx(to, data, value, gas) {
  const { privateKeyToAccount } = await import("viem/accounts");
  const account = privateKeyToAccount(keeperKey());
  const [nonce, block] = await Promise.all([
    rpc("eth_getTransactionCount", [account.address, "pending"]),
    rpc("eth_getBlockByNumber", ["latest", false])
  ]);
  const base = BigInt(block.baseFeePerGas || 0);
  /* A tenth of the base fee, paid on every one of these, for nothing — no
   * transaction on this chain pays a priority fee and the node suggests zero.
   * A small absolute floor instead, so a gas spike does not multiply what the
   * keeper hands over on a payout run that may be a hundred transfers long. */
  const tip = await rpc("eth_maxPriorityFeePerGas", [])
    .then((t) => { const n = BigInt(t || 0); return n < 10000000n ? 10000000n : n; })
    .catch(() => base / 10n + 1n);
  const raw = await account.signTransaction({
    to, data: data || "0x", value: value || 0n, gas,
    maxFeePerGas: base * 2n + tip, maxPriorityFeePerGas: tip,
    nonce: parseInt(nonce, 16), chainId: 4663, type: "eip1559"
  });
  const { keccak256 } = await import("viem");
  return { raw, hash: keccak256(raw) };
}

async function keeperTx(to, data, value, gas) {
  const { raw } = await signKeeperTx(to, data, value, gas);
  return rpc("eth_sendRawTransaction", [raw]);
}

/**
 * The ETH pools for a reward asset, from the file the launch picker uses.
 *
 * Read from disk rather than fetched: it ships with the deployment, so there is
 * no network call and no chance of a payout run stalling on our own CDN.
 */
let assetCache = null;
async function ethPoolsFor(asset) {
  if (!assetCache) {
    try {
      const fs = await import("node:fs/promises");
      const path = await import("node:path");
      const file = path.join(process.cwd(), "public", "rh-assets.json");
      assetCache = JSON.parse(await fs.readFile(file, "utf8"));
    } catch (e) {
      /* Vercel's layout for static files is not guaranteed; fall back to our
       * own origin rather than silently paying ETH for every token. */
      try {
        const base = process.env.VERCEL_URL
          ? "https://" + process.env.VERCEL_URL
          : "https://www.waveslaunchpad.xyz";
        assetCache = await fetch(base + "/rh-assets.json",
          { signal: AbortSignal.timeout(10000) }).then((r) => r.json());
      } catch (e2) { assetCache = { tokens: [] }; }
    }
  }
  const hit = (assetCache.tokens || []).find(
    (t) => String(t.address).toLowerCase() === String(asset).toLowerCase());
  /* Hookless only, and not extortionate. A hook can charge, reject or reprice a
   * swap arbitrarily, and this is other people's money — the sweeper found a
   * hookless ETH pool for every asset that has one at all, so nothing is lost
   * by refusing them. */
  const usable = (k) => k.hooks === ZERO_ADDR && Number(k.fee) <= MAX_POOL_FEE;
  return {
    direct: ((hit && hit.ethPools) || []).filter(usable),
    viaUsdg: ((hit && hit.usdgPools) || []).filter(usable)
  };
}

/* The near leg of every two-hop route: ETH into USDG. Read from the same file
 * and cached for the run, because every hopped asset shares it. */
let nearLegP = null;
function ethToUsdgLeg() {
  if (!nearLegP) {
    nearLegP = ethPoolsFor(USDG).then((p) => p.direct).catch(() => []);
  }
  return nearLegP;
}

/**
 * Which pool pays best for this many wei, and what it pays.
 *
 * One eth_call for all of them. `quoteBest` runs each swap on chain and throws
 * the result away, so the number is a true fill rather than our arithmetic
 * about someone else's curve — and an empty pool, which fills for ZERO without
 * reverting, scores zero and loses. That last part is not a nicety: the first
 * ETH pool recorded for USDG is empty, so "use the first key" would have paid
 * every holder nothing.
 */
async function bestPool(keys, amountIn) {
  if (!SWAP_ROUTER || !keys.length) return null;

  /* ⚠️ Four at a time, and never skip a batch that fails.
   *
   * Each quote is a full swap simulation, and Robinhood's eth_call gas cap
   * refuses eight of them in one call — "out of gas", which no explicit gas
   * parameter raises. A batch of twelve therefore ALWAYS failed for an asset
   * with many pools, and a failed batch used to be skipped, so the keeper
   * concluded nothing could fill and paid ETH instead. Silently, and only for
   * the assets people are most likely to choose.
   *
   * USDG is the case that found it: five empty pools, then live ones at
   * positions six, eight, nine and ten. A batch of four sees only empties; a
   * batch of twelve sees nothing at all. So a batch that fails is retried one
   * pool at a time rather than dropped — slower, and it gets the right answer.
   */
  const LIMIT = 4;
  let best = null;
  const consider = (key, got) => {
    if (got > 0n && (!best || got > best.out)) best = { key, out: got };
  };

  for (let i = 0; i < keys.length && i < 48; i += LIMIT) {
    const batch = keys.slice(i, i + LIMIT);
    let out = null;
    try {
      out = await rpc("eth_call", [
        { to: SWAP_ROUTER, data: encQuoteBest(batch, amountIn) }, "latest"]);
    } catch (e) { out = null; }

    if (out && out !== "0x") {
      consider(batch[Number(word(out, 0))], word(out, 1));
      continue;
    }

    // the batch was refused: ask about each pool on its own
    for (const key of batch) {
      try {
        const one = await rpc("eth_call", [
          { to: SWAP_ROUTER, data: encQuoteBest([key], amountIn) }, "latest"]);
        if (one && one !== "0x") consider(key, word(one, 1));
      } catch (e) { /* this pool cannot be priced; the others still can */ }
    }
  }
  return best;
}

/**
 * The best route to an asset: straight from ETH, or through USDG.
 *
 * ⚠️ Two hops is not a fallback, it is a competitor.
 *
 * Six assets have no ETH pool at all — MSFT among them — so a creator picking
 * one had their holders paid ETH forever with nobody told. Others have ETH
 * pools that are empty, or that charge seventy per cent, which the fee cap
 * rightly refuses. For all of those the route through USDG is the only way the
 * promise gets kept.
 *
 * But it is also priced against the direct route rather than used only when
 * that fails, because two fees and two lots of price impact usually lose and
 * occasionally win. Whichever actually pays holders more is the one taken.
 */
export async function bestRoute(asset, amountIn) {
  if (!SWAP_ROUTER) return null;
  const legs = await ethPoolsFor(asset);

  const direct = await bestPool(legs.direct, amountIn);
  let hopped = null;

  if (legs.viaUsdg.length && String(asset).toLowerCase() !== USDG) {
    const near = await ethToUsdgLeg();
    const nearBest = await bestPool(near, amountIn);
    if (nearBest) {
      /* Two at a time. Each of these simulates BOTH hops, so it is twice the
       * work of a single quote and the gas cap bites twice as fast. */
      const LIMIT = 2;
      for (let i = 0; i < legs.viaUsdg.length && i < 24; i += LIMIT) {
        const batch = legs.viaUsdg.slice(i, i + LIMIT);
        let out = null;
        try {
          out = await rpc("eth_call", [{
            to: SWAP_ROUTER, data: encQuoteBest2(nearBest.key, batch, amountIn)
          }, "latest"]);
        } catch (e) { out = null; }
        if (out && out !== "0x") {
          const got = word(out, 1);
          const key = batch[Number(word(out, 0))];
          if (got > 0n && (!hopped || got > hopped.out)) {
            hopped = { out: got, near: nearBest.key, far: key };
          }
          continue;
        }
        for (const far of batch) {
          try {
            const one = await rpc("eth_call", [{
              to: SWAP_ROUTER, data: encQuoteBest2(nearBest.key, [far], amountIn)
            }, "latest"]);
            if (!one || one === "0x") continue;
            const got = word(one, 1);
            if (got > 0n && (!hopped || got > hopped.out)) {
              hopped = { out: got, near: nearBest.key, far };
            }
          } catch (e) { /* this leg cannot be priced; the others still can */ }
        }
      }
    }
  }

  if (hopped && (!direct || hopped.out > direct.out)) {
    return { kind: "usdg", out: hopped.out, key: hopped.near, keyB: hopped.far };
  }
  if (direct) return { kind: "direct", out: direct.out, key: direct.key };
  return null;
}

/**
 * Wait for a transaction, and REFUSE one that reverted.
 *
 * ⚠️ This returned the receipt without looking at its status, so a reverted
 * transaction counted as a completed one. The consequence was not subtle: a
 * payout whose transfer ran out of gas advanced `sent`, moved the cursors,
 * deleted the plan and reported "paid 1 of 1, complete" — while the money sat
 * in the keeper and the holder had nothing. A run that fails is recoverable;
 * a run that fails and says it succeeded is not.
 *
 * Found by checking the chain after a green result rather than believing it.
 */
async function mined(hash) {
  for (let i = 0; i < 60; i++) {
    const r = await rpc("eth_getTransactionReceipt", [hash]).catch(() => null);
    if (r) {
      if (r.status === "0x0") {
        throw new Error("transaction reverted (" + hash + ", gas used " +
          parseInt(r.gasUsed || "0x0", 16) + ")");
      }
      return r;
    }
    await new Promise((s) => setTimeout(s, 2000));
  }
  throw new Error("not mined");
}

export default async function handler(req, res) {
  /* ?whoami — does the deployed key match the keeper pledges name on chain?
   *
   * Open, because it discloses nothing: the address is already in
   * evm-chains.js and written into every pledge on a public chain. What it
   * confirms is that the SERVER holds a key for it, which is the one thing
   * worth knowing before a pot exists — a mismatch is permanent per token, and
   * finding out afterwards means those holders can never be paid.
   *
   * It signs nothing, reads no balances and moves nothing. */
  if (req.query && req.query.whoami) {
    if (!process.env.RH_KEEPER_SECRET) {
      return res.status(200).json({ ok: false, error: "RH_KEEPER_SECRET is not set" });
    }
    try {
      const { privateKeyToAccount } = await import("viem/accounts");
      const derived = privateKeyToAccount(keeperKey()).address;
      const expected = "0xAcA1d1bE05f47090a6d8D918AB26d4543fD3Af81";

      /* The router, checked the same way and for the same reason: a keeper
       * that cannot swap does not fail, it quietly pays ETH to holders who
       * were promised something else. That is indistinguishable from working
       * unless something asks. Reading poolManager() off the address proves
       * there is really a router there and that it points at the venue these
       * tokens trade on — a wrong or absent one is worth knowing before a pot
       * exists rather than after it has been paid out. */
      let router = { configured: !!SWAP_ROUTER, address: SWAP_ROUTER };
      if (SWAP_ROUTER) {
        try {
          const pm = await rpc("eth_call", [{ to: SWAP_ROUTER, data: "0xdc4c90d3" }, "latest"]);
          const got = "0x" + String(pm || "").slice(-40).toLowerCase();
          router.poolManager = got;
          router.ok = got === "0x8366a39cc670b4001a1121b8f6a443a643e40951";
        } catch (e) {
          router.ok = false;
          router.error = String(e.message || e).slice(0, 120);
        }
      }

      /* Which curve this deployment is actually reading. evm-chains.js and
       * RH_CURVE are set in different places and it is entirely possible to
       * change one and not the other — in which case the site launches tokens
       * onto a curve the keeper never looks at, and their holders are never
       * paid. Silent, and only visible by asking. */
      let curve = { address: CURVE };
      try {
        const g = await rpc("eth_call", [{ to: CURVE, data: "0x615bb453" }, "latest"]);
        curve.graduationEth = (Number(BigInt(g || "0x0")) / 1e18) + " ETH";
        curve.ok = BigInt(g || "0x0") > 0n;
      } catch (e) {
        curve.ok = false;
        curve.error = String(e.message || e).slice(0, 120);
      }

      return res.status(200).json({
        ok: derived.toLowerCase() === expected.toLowerCase(),
        derived, expected, router, curve,
        note: derived.toLowerCase() === expected.toLowerCase()
          ? (router.ok ? "key signs for the keeper, and the swap router answers"
             : router.configured ? "key is right, but the swap router does not check out"
             : "key is right; no swap router set, so holders are paid ETH")
          : "MISMATCH — pledges name an address this key cannot sign for"
      });
    } catch (e) {
      return res.status(200).json({ ok: false, error: String(e.message || e).slice(0, 160) });
    }
  }

  const secret = process.env.CRON_SECRET;
  if (secret && req.headers.authorization !== "Bearer " + secret) {
    return res.status(401).json({ error: "no" });
  }
  if (!process.env.RH_KEEPER_SECRET) {
    return res.status(200).json({ ok: true, skipped: "RH_KEEPER_SECRET is not set" });
  }

  const log = [];
  try {
    const db = await kv();
    const { privateKeyToAccount } = await import("viem/accounts");
    const keeper = privateKeyToAccount(keeperKey()).address;

    /* ⚠️ Reported every run so it can be eyeballed against evm-chains.js. If
     * this key does not match the rewardsKeeper written into pledges, those
     * tokens named a keeper nobody can sign for — permanently, per token. */
    const expected = "0xAcA1d1bE05f47090a6d8D918AB26d4543fD3Af81";
    if (keeper.toLowerCase() !== expected.toLowerCase()) {
      return res.status(500).json({
        ok: false, keeper,
        error: "RH_KEEPER_SECRET does not match the rewardsKeeper on chain (" + expected + ")"
      });
    }

    // ── 1. resume anything a previous run left half-done ──────────────────────
    const planKey = "rhk:plan";
    const plan = await db.get(planKey).catch(() => null);
    if (plan) {
      const p = typeof plan === "string" ? JSON.parse(plan) : plan;
      /* A plan can stop at any stage. Finish the swaps it had not done, then
       * build the payments if it never got that far, then pay. Each step is
       * skipped if it is already recorded, so resuming repeats nothing. */
      if (p.slices && !p.payments) {
        const tbl = {};
        for (const sl of p.slices) {
          tbl[sl.mint] = (await db.hgetall("rhix:" + sl.mint + ":h").catch(() => null)) || {};
        }
        await runSwaps(db, planKey, p, keeper);
        await buildPayments(db, p, tbl);
        await db.set(planKey, JSON.stringify(p));
      }
      const done = await payOut(db, planKey, p);
      return res.status(200).json({ ok: true, keeper, resumed: true, ...done });
    }

    const raw = await db.lrange("tokens", 0, 199);
    const toks = (raw || [])
      .map((r) => (typeof r === "string" ? JSON.parse(r) : r))
      /* ⚠️ NOT filtered on feeSharePct.
       *
       * The pledge lives on the curve, and activating it from /fees is one
       * on-chain call that touches nothing of ours — so a creator who pledged
       * after launching still has 0 in the listing. Filtering on it here meant
       * the keeper skipped exactly those tokens and never paid their holders,
       * silently, while the curve had been routing fees to the keeper all
       * along. WAVE4 is one: rewardsBps 10000 on chain, feeSharePct 0 in the
       * record.
       *
       * rewardsBps is read from the curve for each of these a few lines down
       * and anything unpledged is dropped there, so the only cost of not
       * pre-filtering is one eth_call per Robinhood launch. */
      .filter((t) => t && t.chain === "robinhood");
    if (!toks.length) return res.status(200).json({ ok: true, keeper, note: "nothing pledged" });

    const latest = BigInt(await rpc("eth_blockNumber", []));
    const owedHex = await rpc("eth_call", [{
      to: CURVE, data: "0xdf18e047" + "0".repeat(24) + keeper.slice(2).toLowerCase()
    }, "latest"]);
    const pot = BigInt(owedHex || "0x0");
    if (pot === 0n) return res.status(200).json({ ok: true, keeper, note: "nothing owed" });

    // ── 2. attribute the pot across the tokens that earned it ────────────────
    const shares = [];
    const assets = {};
    const burns = {}; // mint -> true when the creator chose buyback-and-burn
    let attributed = 0n;
    for (const t of toks) {
      const mint = String(t.mint).toLowerCase();
      /* What the creator chose to pay holders in. Null, missing or ETH itself
       * all mean the same thing: no swap, pay the native coin. */
      const rm = t.rewardMint && String(t.rewardMint).toLowerCase();
      /* Buyback-and-burn: no asset is paid to holders. The keeper buys the token
       * ITSELF with the accrued ETH and sends it to 0xdEaD — the same thing the
       * Solana side does (destroy rather than distribute), and what a burn on the
       * benchmark launchpad does too. So it takes no asset and no holders. */
      const isBurn = t.rewardMode === "burn";
      burns[mint] = isBurn;
      assets[mint] = (!isBurn && rm && rm !== ZERO_ADDR && /^0x[0-9a-f]{40}$/.test(rm)) ? rm : null;
      /* The hook keys its Curve by PoolId: poolOf(mint) -> curves(poolId).
       * curves(address) on the hook returns a zero struct (rewardsBps 0), so the
       * keeper would skip every token as "no rewards". Layout: token(0)
       * creator(1) feeBps(2) rewardsBps(3) ... */
      const poolId = await rpc("eth_call", [{
        to: CURVE, data: "0x988b1fa7" + "0".repeat(24) + mint.slice(2)
      }, "latest"]);
      const curve = await rpc("eth_call", [{
        to: CURVE, data: "0x66903e80" + String(poolId).replace(/^0x/, "")
      }, "latest"]);
      const feeBps = Number(word(curve, 2));
      const rewardsBps = Number(word(curve, 3));
      if (!rewardsBps) continue;
      const a = await accrued(db, mint, feeBps, rewardsBps, t.block, latest);
      if (a.wei > 0n) { shares.push({ mint, wei: a.wei, upTo: a.upTo, burn: isBurn }); attributed += a.wei; }
      else log.push({ mint, earned: "0" });
    }
    if (!attributed) return res.status(200).json({ ok: true, keeper, note: "no attributable earnings", log });

    // ── 3. is it worth the gas? ──────────────────────────────────────────────
    const block = await rpc("eth_getBlockByNumber", ["latest", false]);
    const gasPrice = BigInt(block.baseFeePerGas || 0) * 2n;
    let holderCount = 0;
    const tables = {};
    for (const s of shares) {
      if (s.burn) continue;              // a burn destroys supply, it pays no holder
      const h = (await db.hgetall("rhix:" + s.mint + ":h").catch(() => null)) || {};
      tables[s.mint] = h;
      holderCount += Object.keys(h).length;
    }
    /* A launch nobody holds yet can still burn — only the DIVIDEND path needs a
     * holder table to pay into. Refuse for no holders only if there is one. */
    const dividendShares = shares.filter((s) => !s.burn).length;
    if (dividendShares > 0 && !holderCount) {
      return res.status(200).json({ ok: true, keeper, note: "no holders indexed yet" });
    }

    /* Budget for the dearer path. A token paying an asset costs a swap plus an
     * ERC20 transfer per holder, and a run that priced itself as ETH sends
     * would pass the worth-it test and then strand halfway through, holding
     * money it had already claimed. */
    const swapping = shares.filter((s) => assets[s.mint] && SWAP_ROUTER).length;
    const burning = shares.filter((s) => s.burn).length;
    const perHolder = swapping ? GAS_PER_ERC20 : GAS_PER_TRANSFER;
    // budget the dearer of the two routes; which one wins is not known until quoted.
    // a burn is one router.buy, no per-holder tail.
    const gasCost = (GAS_CLAIM + GAS_SWAP2 * BigInt(swapping) + GAS_BURN * BigInt(burning) +
      perHolder * BigInt(holderCount)) * gasPrice;
    /* An explicit, authenticated override for testing the path end to end.
     *
     * The economics are real — forwarding a pot smaller than the gas costs more
     * than it moves — but "wait until a test token has traded several hundred
     * dollars" is not a way to find out whether the swap leg works. Requires
     * the deploy secret, so only someone who could change the code anyway. */
    const force = !!(req.query && req.query.force) && !!secret &&
      req.headers.authorization === "Bearer " + secret;
    if (!force && pot < gasCost * WORTH_IT) {
      return res.status(200).json({
        ok: true, keeper, note: "pot too small to be worth the gas",
        potWei: pot.toString(), gasWei: gasCost.toString(), holders: holderCount
      });
    }

    const bal = BigInt(await rpc("eth_getBalance", [keeper, "latest"]));
    if (bal < gasCost * 2n) {
      return res.status(200).json({
        ok: true, keeper, note: "keeper is low on gas — top it up",
        balanceWei: bal.toString(), needWei: (gasCost * 2n).toString()
      });
    }

    // ── 4. claim, then 5. write the plan BEFORE spending any of it ───────────
    const claimHash = await keeperTx(CURVE, "0x4e71d92d", 0n, GAS_CLAIM);
    await mined(claimHash);

    /* The plan exists the moment the money does.
     *
     * Written before any of it is spent, and before the swaps, because from
     * here on a crash must be recoverable rather than a loss. It records what
     * each token is owed in ETH; the swap stage below turns those into assets
     * and the payment stage turns them into transfers. */
    const record = {
      at: Date.now(), claimHash, potWei: pot.toString(),
      cursors: shares.map((s) => ({ mint: s.mint, upTo: s.upTo.toString() })),
      slices: shares.map((s) => ({
        mint: s.mint,
        wei: ((pot * s.wei) / attributed).toString(),
        asset: assets[s.mint] || null,
        burn: !!s.burn
      })),
      swaps: {}, burns: {}, payments: null, sent: 0,
      // what a transfer costs, so the dust threshold survives into a resumed run
      gasPriceWei: gasPrice.toString()
    };
    await db.set(planKey, JSON.stringify(record));

    await runSwaps(db, planKey, record, keeper);
    await runBurns(db, planKey, record, keeper);
    await buildPayments(db, record, tables);
    await db.set(planKey, JSON.stringify(record));

    const done = await payOut(db, planKey, record);
    return res.status(200).json({
      ok: true, keeper, claimHash, swaps: record.swaps, burns: record.burns,
      carriedToNextRun: record.carried || 0, ...done, log
    });
  } catch (e) {
    return res.status(200).json({ ok: false, error: String(e.message || e).slice(0, 300), log });
  }
}

/**
 * Turn each token's ETH slice into the asset its creator chose.
 *
 * ⚠️ Exactly once, or a token spends another token's money.
 *
 * The hash is written into the plan BEFORE the transaction is broadcast, so a
 * crash anywhere in here is recoverable: the next run asks the chain whether
 * that exact hash landed. If it did, its result is read off the receipt. If it
 * did not, the identical signed bytes go out again — same nonce, so the chain
 * will apply it at most once no matter how many times this runs.
 *
 * A swap that cannot be done is not an error. No router, no pool, no liquidity,
 * a quote of zero, a revert — every one of them falls back to paying ETH, which
 * is what holders got before any of this existed. The alternative is stranding
 * money that has already been claimed for the sake of a preference.
 */
async function runSwaps(db, planKey, plan, keeper) {
  if (!SWAP_ROUTER) return;

  for (const sl of plan.slices || []) {
    if (!sl.asset) continue;                       // paying ETH by choice
    if (plan.swaps[sl.mint] && plan.swaps[sl.mint].done) continue;   // already swapped

    const amountIn = BigInt(sl.wei);
    if (amountIn <= 0n) continue;

    try {
      let pending = plan.swaps[sl.mint];

      if (!pending) {
        const best = await bestRoute(sl.asset, amountIn);
        if (!best) { plan.swaps[sl.mint] = { skipped: "no route could fill" }; continue; }

        /* minOut off the live quote. Never zero: the mempool is public and an
         * unprotected swap of someone else's payout is a free lunch. */
        const minOut = (best.out * (10000n - SLIPPAGE_BPS)) / 10000n;

        /* ⚠️ What the keeper already holds, read BEFORE the swap and written
         * into the plan with it.
         *
         * This token's proceeds are the DELTA, not the balance. Measuring the
         * balance instead meant two tokens choosing the same asset could not be
         * settled in one run — the second would count the first's tokens as its
         * own — and the version that handled that by deferring the second one
         * swapped its ETH anyway and then advanced its cursor without paying
         * anyone. Its holders got nothing and the asset sat in the keeper.
         *
         * Recorded before broadcasting so a resume can still work the delta out
         * after the fact, when "before" is no longer observable. */
        const beforeHex = await rpc("eth_call", [
          { to: sl.asset, data: SEL_BALANCE_OF + encAddr(keeper) }, "latest"]);

        const data = best.kind === "usdg"
          ? encSwap2(best.key, best.keyB, minOut, keeper)
          : encSwap(best.key, minOut, keeper);
        const { raw, hash } = await signKeeperTx(
          SWAP_ROUTER, data, amountIn, best.kind === "usdg" ? GAS_SWAP2 : GAS_SWAP);

        // written down BEFORE it exists on chain — that is the whole point
        pending = {
          hash, raw, asset: sl.asset, route: best.kind, quoted: best.out.toString(),
          before: BigInt(beforeHex || "0x0").toString(), done: false
        };
        plan.swaps[sl.mint] = pending;
        await db.set(planKey, JSON.stringify(plan));
      }

      /* Ask before sending. On a resume this transaction may already be mined,
       * and rebroadcasting a mined transaction is not harmful but reading its
       * receipt is how we learn what it bought. */
      let receipt = await rpc("eth_getTransactionReceipt", [pending.hash]).catch(() => null);
      if (!receipt) {
        await rpc("eth_sendRawTransaction", [pending.raw]).catch(() => null);
        receipt = await mined(pending.hash);
      }
      if (!receipt || receipt.status === "0x0") {
        plan.swaps[sl.mint] = { skipped: "swap reverted", hash: pending.hash };
        await db.set(planKey, JSON.stringify(plan));
        continue;
      }

      /* How much actually arrived, from the token itself rather than from the
       * quote. The quote was a prediction; the balance is the fact, and the
       * holders are paid out of the fact. */
      const balHex = await rpc("eth_call", [
        { to: sl.asset, data: SEL_BALANCE_OF + encAddr(keeper) }, "latest"]);
      const after = BigInt(balHex || "0x0");
      const received = after - BigInt(pending.before || "0");
      if (received <= 0n) {
        plan.swaps[sl.mint] = { skipped: "nothing arrived", hash: pending.hash };
      } else {
        plan.swaps[sl.mint] = {
          hash: pending.hash, asset: sl.asset, route: pending.route,
          received: received.toString(), quoted: pending.quoted, done: true
        };
      }
      await db.set(planKey, JSON.stringify(plan));
    } catch (e) {
      plan.swaps[sl.mint] = { skipped: String(e.message || e).slice(0, 120) };
      await db.set(planKey, JSON.stringify(plan));
    }
  }
}

/**
 * Split every slice across the people holding that token.
 *
 * A slice that was swapped pays the asset; one that was not pays ETH. Both are
 * pro-rata by holding, and both round down — the dust that leaves behind is
 * swept into the next run rather than being sent as a transfer that costs more
 * gas than it moves.
 */
/* Buyback-and-burn. For each burn slice, buy the token on its own curve through
 * the WavesHookRouter with the accrued ETH and deliver it straight to 0xdEaD.
 * Crash-recoverable like runSwaps: the tx is signed and written into the plan
 * BEFORE broadcast, and the amount burned is the dead-address balance DELTA, so
 * a resume — or two runs — can never double-count. The cumulative burn per token
 * is persisted for the token page's "tokens burnt" counter. */
async function runBurns(db, planKey, plan, keeper) {
  for (const sl of plan.slices || []) {
    if (!sl.burn) continue;
    plan.burns = plan.burns || {};
    if (plan.burns[sl.mint] && plan.burns[sl.mint].done) continue;

    const amountIn = BigInt(sl.wei);
    if (amountIn <= 0n) { plan.burns[sl.mint] = { skipped: "nothing accrued", done: true }; continue; }

    try {
      let pending = plan.burns[sl.mint];
      if (!pending) {
        // dead-address balance BEFORE, so the burn is measured as a delta
        const beforeHex = await rpc("eth_call", [
          { to: sl.mint, data: SEL_BALANCE_OF + encAddr(DEAD) }, "latest"]);
        // buy(token, minOut=0, to=DEAD, deadline). Any overfill near graduation is
        // refunded by the router to the keeper and carried as its own balance.
        const deadline = Math.floor(Date.now() / 1000) + 1200;
        const data = ROUTER_BUY + encAddr(sl.mint) + pad(0n) + encAddr(DEAD) + pad(deadline);
        const { raw, hash } = await signKeeperTx(HOOK_ROUTER, data, amountIn, GAS_BURN);
        pending = { hash, raw, before: BigInt(beforeHex || "0x0").toString(), done: false };
        plan.burns[sl.mint] = pending;
        await db.set(planKey, JSON.stringify(plan));
      }

      let receipt = await rpc("eth_getTransactionReceipt", [pending.hash]).catch(() => null);
      if (!receipt) {
        try { await rpc("eth_sendRawTransaction", [pending.raw]); } catch (e) { /* may already be pooled */ }
        receipt = await mined(pending.hash);
      }
      if (receipt && receipt.status === "0x1") {
        const afterHex = await rpc("eth_call", [
          { to: sl.mint, data: SEL_BALANCE_OF + encAddr(DEAD) }, "latest"]);
        const burnt = BigInt(afterHex || "0x0") - BigInt(pending.before);
        pending.done = true; pending.burnt = burnt.toString();
        await db.set(planKey, JSON.stringify(plan));
        const prevTok = BigInt((await db.get("rhk:" + sl.mint + ":burnt")) || "0");
        await db.set("rhk:" + sl.mint + ":burnt", (prevTok + burnt).toString());
        const prevEth = BigInt((await db.get("rhk:" + sl.mint + ":burnEthWei")) || "0");
        await db.set("rhk:" + sl.mint + ":burnEthWei", (prevEth + amountIn).toString());
      } else {
        pending.error = "burn tx did not succeed";
        await db.set(planKey, JSON.stringify(plan));
      }
    } catch (e) {
      plan.burns[sl.mint] = { ...(plan.burns[sl.mint] || {}), error: String(e.message || e).slice(0, 140) };
      await db.set(planKey, JSON.stringify(plan));
    }
  }
}

async function buildPayments(db, plan, tables) {
  const payments = [];

  /* ⚠️ Dust is carried, not dropped and not redistributed.
   *
   * A holder owed less than the gas it takes to send costs more to pay than
   * they receive — at 50 holders that tail is most of the bill. But skipping
   * them and splitting their share among the rest would quietly take small
   * holders' money and give it to large ones, which is worse than the gas.
   *
   * So their amount is remembered and added to what they are owed next time,
   * until it clears the threshold. The tokens are already in the keeper, and
   * because each swap measures its OWN delta a carried balance sitting there
   * cannot inflate a later payout.
   *
   * The threshold is in the asset's own units, derived from this run's actual
   * swap rate — no oracle, no second quote. */
  const carryKey = "rhk:carry";
  const carried = (await db.hgetall(carryKey).catch(() => null)) || {};
  const nextCarry = {};
  const gasPrice = BigInt(plan.gasPriceWei || "0");

  for (const sl of plan.slices || []) {
    if (sl.burn) continue;                 // burns pay no holders — handled in runBurns
    const table = tables[sl.mint] || {};
    const supply = Object.values(table).reduce((a, b) => a + BigInt(b), 0n);
    if (supply === 0n) continue;

    /* Each swap recorded what IT brought in, so two tokens paying the same
     * asset settle side by side without either counting the other's tokens. */
    const sw = plan.swaps[sl.mint];
    const swapped = sw && sw.done;
    const asset = swapped ? sw.asset : null;
    const total = swapped ? BigInt(sw.received) : BigInt(sl.wei);

    /* What one transfer costs, expressed in whatever is being sent. For an
     * asset that is the gas converted at the rate this run's own swap got; for
     * ETH the two are the same currency already. */
    const sendGas = asset ? GAS_PER_ERC20 : GAS_PER_TRANSFER;
    const gasInEth = sendGas * gasPrice;
    const threshold = (asset && BigInt(sl.wei) > 0n)
      ? (total * gasInEth) / BigInt(sl.wei)
      : gasInEth;

    for (const [addr, held] of Object.entries(table)) {
      const share = (total * BigInt(held)) / supply;
      const ck = (asset || "eth") + ":" + addr;
      const owed = share + BigInt(carried[ck] || "0");
      if (owed <= 0n) continue;

      if (owed < threshold) {
        nextCarry[ck] = owed.toString();     // wait for it to be worth sending
        continue;
      }
      payments.push({ to: addr, wei: owed.toString(), mint: sl.mint, asset });
    }
  }

  /* Written now, not after paying. A payment already includes whatever was
   * carried, and the plan survives a failure and is retried with the same
   * amounts — so clearing here cannot lose anyone's balance. */
  const stale = Object.keys(carried).filter((k) => !(k in nextCarry));
  if (Object.keys(nextCarry).length) await db.hset(carryKey, nextCarry);
  if (stale.length) await db.hdel(carryKey, ...stale);

  plan.payments = payments;
  plan.carried = Object.keys(nextCarry).length;
  plan.sent = plan.sent || 0;
}

/**
 * Send what the plan says, marking progress as each one lands.
 *
 * Resumable on purpose: the plan is the only record that money was claimed and
 * not yet delivered, so it is updated after every transfer rather than at the
 * end. A run that dies halfway is finished by the next one.
 */
async function payOut(db, planKey, plan) {
  if (!plan.payments) return { paid: 0, of: 0, failures: [], complete: false };
  let sent = plan.sent || 0;
  const failures = [];
  for (let i = sent; i < plan.payments.length; i++) {
    const p = plan.payments[i];
    try {
      /* An asset payment is a transfer ON the token; an ETH one is value on a
       * bare send. Same plan, same ordering, different instrument. */
      const h = p.asset
        ? await keeperTx(p.asset, encTransfer(p.to, BigInt(p.wei)), 0n, GAS_PER_ERC20)
        : await keeperTx(p.to, "0x", BigInt(p.wei), GAS_PER_TRANSFER);
      await mined(h);
      sent = i + 1;
      await db.set(planKey, JSON.stringify({ ...plan, sent }));
    } catch (e) {
      /* Stop, keep the plan, and leave `sent` where it is. The next run picks
       * up from exactly here — which only works because a revert now reaches
       * this handler instead of being read as a completed payment. */
      failures.push({ to: p.to, asset: p.asset || null,
        error: String(e.message || e).slice(0, 160) });
      break;
    }
  }

  if (sent >= plan.payments.length) {
    /* What each token actually paid its holders, kept per token.
     *
     * The keeper knew this all along and threw it away — rhkeeperlog records
     * the run, not the token — so a token page had no way to say what its
     * holders have received. Both figures are kept: the ETH the token earned
     * for them, and the asset units that actually landed, because those are
     * different currencies and only the second is what anyone was paid. */
    try {
      const perToken = {};
      for (const p of plan.payments) {
        const k = p.mint;
        if (!perToken[k]) perToken[k] = { asset: p.asset || null, units: 0n };
        perToken[k].units += BigInt(p.wei);
      }
      for (const sl of plan.slices || []) {
        const t = perToken[sl.mint];
        if (!t) continue;
        const wei = await db.get("rhk:" + sl.mint + ":paidWei").catch(() => null);
        await db.set("rhk:" + sl.mint + ":paidWei",
          (BigInt(wei || "0") + BigInt(sl.wei)).toString());
        if (t.asset) {
          const a = await db.get("rhk:" + sl.mint + ":paidAsset").catch(() => null);
          await db.set("rhk:" + sl.mint + ":paidAsset",
            (BigInt(a || "0") + t.units).toString());
          await db.set("rhk:" + sl.mint + ":paidAssetAddr", t.asset);
        }
      }
    } catch (e) { /* a bookkeeping failure must not undo a completed payout */ }

    /* Only now: the cursors move once the money is actually out. Advancing them
     * earlier would mean a failed run forgot earnings it never paid. */
    for (const c of plan.cursors || []) {
      await db.set("rhk:" + c.mint + ":cursor", c.upTo);
    }
    await db.del(planKey);
    await db.lpush("rhkeeperlog", JSON.stringify({
      at: plan.at, potWei: plan.potWei, paid: sent, claimHash: plan.claimHash
    }));
    await db.ltrim("rhkeeperlog", 0, 499);
  }
  return { paid: sent, of: plan.payments.length, failures, complete: sent >= plan.payments.length };
}
