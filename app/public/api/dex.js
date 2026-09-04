// GET /dex/latest-block
// GET /dex/asset?id=<address>
// GET /dex/pair?id=<token address>
// GET /dex/events?fromBlock=<n>&toBlock=<n>
//
// The DexScreener adapter: our bonding curve, presented as a venue an
// aggregator can index.
//
// ── Why this exists ─────────────────────────────────────────────────────────
// Aggregators index POOLS. Before a token graduates it has no pool — it trades
// against WavesCurve, and every buy and sell is an event on a contract nothing
// else knows how to decode. So a launch is invisible on GMGN and DexScreener
// for its entire life on the curve, which is exactly the period when a creator
// is trying to get attention for it. MOON shows on GMGN because GMGN built a
// Pons-specific integration; nothing our contract emits can conjure one.
//
// DexScreener's answer to this is an adapter: host four endpoints describing
// the venue and they index it like any other. Balancer, Algebra and the XRPL
// DEX all ship one. That is what this is.
//
// ── The trick that makes it possible ────────────────────────────────────────
// A pair needs reserves and a price at every trade, and the curve stores only
// its CURRENT state. But the state is exactly reconstructable from the events
// themselves — the contract's accounting is:
//
//     Bought(token, buyer,  ethIn,    tokensOut, fee)  raised += ethIn - fee
//                                                      tokensLeft -= tokensOut
//     Sold  (token, seller, tokensIn, ethOut,    fee)  raised -= ethOut + fee
//                                                      tokensLeft += tokensIn
//
// so replaying a token's log from its launch gives the reserves after every
// trade, exactly, with no archive node and no extra storage.
//
// ⚠️ Price comes from the VIRTUAL reserves, because that is what the contract
// prices against and therefore what a trader actually gets. Reserves reported
// for liquidity are the REAL ones — the ETH genuinely held and the tokens
// genuinely unsold — because that is what "how deep is this" means to someone
// reading the number. Reporting virtual reserves as liquidity would claim depth
// that cannot be withdrawn.

export const config = { runtime: "nodejs" };

import { allow, tooMany } from "./_guard.js";

const RPC = process.env.RH_RPC || "https://rpc.mainnet.chain.robinhood.com";
const CURVE = (process.env.RH_CURVE || "0x77ddd6ceb454e4b71a1952fcaafb8cf9975f55c0").toLowerCase();
const CHAIN_ID = 4663;

/* Robinhood's wrapped ether. Named as the quote asset because DexScreener
 * prices a pair in one of its two assets, and "the native coin" is not an
 * address it can look up. Nothing is ever wrapped — the curve takes native ETH
 * — this is purely how the quote side is identified. */
const WETH = "0x0bd7d308f8e1639fab988df18a8011f41eacad73";

// Bought(address,address,uint256,uint256,uint256) / Sold(...)
const BOUGHT = "0x7ce543d1780f3bdc3dac42da06c95da802653cd1b212b8d74ec3e3c33ad7095c";
const SOLD   = "0x9be8a5ca22b7e6e81f04b5879f0248227bb770114291bd47dfaee4c3a82ad60e";
// Launched(address,address,uint16,string,string)
const LAUNCHED = "0xcf74280e4eafa3845516f297991e114213dc6a4c132199d8338fe6ba26b216e4";

const MS_PER_BLOCK = 104;          // ~0.104s; used only to date old blocks
const MAX_SPAN = 50000;            // the widest window this chain answers

let rpcId = 0;
async function rpc(method, params) {
  /* Retried, because Robinhood rate-limits a burst hard and a single refusal
   * used to end a whole scan — which surfaced as "unknown pair" for a token
   * that had plainly launched. A transient 429 is not an answer. */
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const r = await fetch(RPC, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method, params }),
        signal: AbortSignal.timeout(20000)
      });
      if (r.status === 429) throw new Error("429");
      if (!r.ok) throw new Error("rpc " + r.status);
      const j = await r.json();
      if (j.error) throw new Error(j.error.message || "rpc error");
      return j.result;
    } catch (e) {
      if (attempt === 2) throw e;
      await new Promise((s) => setTimeout(s, 350 * (attempt + 1)));
    }
  }
}

const hex = (n) => "0x" + BigInt(n).toString(16);
const addrOf = (t) => "0x" + String(t).slice(-40).toLowerCase();
const word = (d, i) => BigInt("0x" + String(d).replace(/^0x/, "").slice(i * 64, i * 64 + 64));

/* Decimal string from wei without floating point. An aggregator parses these as
 * numbers, and a token amount at 18 decimals does not survive a double. */
function units(v, decimals) {
  const s = BigInt(v).toString().padStart(decimals + 1, "0");
  const whole = s.slice(0, s.length - decimals);
  const frac = s.slice(s.length - decimals).replace(/0+$/, "");
  return frac ? whole + "." + frac : whole;
}

/* A ratio of two wei-scale integers, to 18 significant places, again without
 * floating point — the price of a token on a fresh curve is around 1e-9 ETH and
 * a double loses the end of it. */
function ratio(numer, denom) {
  if (denom === 0n) return "0";
  const scaled = (BigInt(numer) * 10n ** 18n) / BigInt(denom);
  return units(scaled, 18);
}

let termsCache = null;
async function terms() {
  if (termsCache) return termsCache;
  const [ve, vt, cs] = await Promise.all([
    rpc("eth_call", [{ to: CURVE, data: "0x4bd387e1" }, "latest"]),   // virtualEth()
    rpc("eth_call", [{ to: CURVE, data: "0x1d3dad09" }, "latest"]),   // virtualTokens()
    rpc("eth_call", [{ to: CURVE, data: "0x2138a4c0" }, "latest"])    // curveSupply()
  ]);
  termsCache = {
    virtualEth: BigInt(ve), virtualTokens: BigInt(vt), curveSupply: BigInt(cs)
  };
  return termsCache;
}

async function blockTime(n) {
  const b = await rpc("eth_getBlockByNumber", [hex(n), false]);
  return b ? Number(BigInt(b.timestamp)) : 0;
}

/* When a token launched, and with what fee. Read from the curve's own Launched
 * event so the adapter needs nothing from our database — an aggregator asking
 * about a pair we have never listed still gets a correct answer. */
/* The launch block, from the listing we already keep.
 *
 * Walking the curve's log backwards for it works but costs one 50,000-block
 * query per window, and this chain refuses a burst of those — so a token that
 * launched half a million blocks ago took ten queries to find and reported
 * "unknown pair" the moment one was throttled. We recorded the block at launch
 * precisely because it cannot be recovered cheaply later; using it turns the
 * whole search into a single query against one known block. */
async function knownLaunchBlock(token) {
  try {
    const { kv } = await import("./_guard.js");
    const db = await kv();
    if (!db) return null;
    const raw = await db.lrange("tokens", 0, 199);
    for (const r of raw || []) {
      const t = typeof r === "string" ? JSON.parse(r) : r;
      if (t && String(t.mint).toLowerCase() === token && t.block > 0) return Number(t.block);
    }
  } catch (e) { /* fall back to the scan */ }
  return null;
}

async function launchOf(token, latest) {
  const known = await knownLaunchBlock(token);
  if (known) {
    try {
      const logs = await rpc("eth_getLogs", [{
        address: CURVE, fromBlock: hex(known), toBlock: hex(known),
        topics: [LAUNCHED, "0x" + "0".repeat(24) + token.slice(2)]
      }]);
      if (logs && logs.length) {
        return {
          block: known,
          txn: logs[0].transactionHash,
          feeBps: Number(word(logs[0].data, 0))
        };
      }
    } catch (e) { /* the scan below still has a go */ }
  }

  let cursor = latest;
  for (let i = 0; i < 60 && cursor > 0; i++) {
    const from = Math.max(0, cursor - MAX_SPAN);
    let logs = [];
    try {
      logs = await rpc("eth_getLogs", [{
        address: CURVE, fromBlock: hex(from), toBlock: hex(cursor),
        topics: [LAUNCHED, "0x" + "0".repeat(24) + token.slice(2)]
      }]);
    } catch (e) { /* this window is unreadable; the next one may not be */ }
    if (logs.length) {
      const l = logs[0];
      return {
        block: Number(BigInt(l.blockNumber)),
        txn: l.transactionHash,
        feeBps: Number(word(l.data, 0))
      };
    }
    if (from === 0) break;
    cursor = from;
  }
  return null;
}

/**
 * Replay a token's trades and hand back the state after each one.
 *
 * The whole history, every time. That is affordable because the curve's log is
 * small — a token that trades heavily enough for this to hurt has long since
 * graduated and left the curve behind — and it is exact, which the alternative
 * (caching a running total and trusting the aggregator to ask for ranges in
 * order) is not.
 */
async function replay(token, upTo, t) {
  const start = await launchOf(token, upTo);
  if (!start) return null;

  const topic = "0x" + "0".repeat(24) + token.slice(2);
  let raised = 0n;
  let tokensLeft = t.curveSupply;
  const out = [];

  for (let from = start.block; from <= upTo; from += MAX_SPAN) {
    const to = Math.min(from + MAX_SPAN - 1, upTo);
    let logs = [];
    try {
      logs = await rpc("eth_getLogs", [{
        address: CURVE, fromBlock: hex(from), toBlock: hex(to),
        topics: [[BOUGHT, SOLD], topic]
      }]);
    } catch (e) { break; }

    for (const l of logs) {
      const buy = String(l.topics[0]).toLowerCase() === BOUGHT;
      const a = word(l.data, 0);          // ethIn on a buy, tokensIn on a sell
      const b = word(l.data, 1);          // tokensOut on a buy, ethOut on a sell
      const fee = word(l.data, 2);

      if (buy) { raised += a - fee; tokensLeft -= b; }
      else { raised -= b + fee; tokensLeft += a; }

      /* The price the NEXT trade would get, from the virtual reserves the
       * contract prices against. */
      const x = t.virtualEth + raised;
      const y = t.virtualTokens - (t.curveSupply - tokensLeft);

      out.push({
        blockNumber: Number(BigInt(l.blockNumber)),
        txnId: l.transactionHash,
        txnIndex: Number(BigInt(l.transactionIndex || "0x0")),
        eventIndex: Number(BigInt(l.logIndex || "0x0")),
        maker: addrOf(l.topics[2]),
        buy,
        tokenAmount: buy ? b : a,
        ethAmount: buy ? a : b,
        priceNative: ratio(x, y),
        reserveToken: tokensLeft,
        reserveEth: raised
      });
    }
    if (to >= upTo) break;
  }
  return { start, events: out };
}

// ─────────────────────────────────────────────────────────────── handlers

async function latestBlock(res) {
  const n = Number(BigInt(await rpc("eth_blockNumber", [])));
  return res.status(200).json({
    block: { blockNumber: n, blockTimestamp: await blockTime(n) }
  });
}

async function asset(res, id) {
  /* Both sides of every pair. The quote side is the wrapped coin by name only;
   * the curve holds native ETH and nothing is ever wrapped. */
  if (id === WETH) {
    return res.status(200).json({
      asset: { id: WETH, name: "Ether", symbol: "ETH", totalSupply: "0" }
    });
  }
  const call = (sig) => rpc("eth_call", [{ to: id, data: sig }, "latest"]).catch(() => null);
  const [nm, sy, sup] = await Promise.all([
    call("0x06fdde03"), call("0x95d89b41"), call("0x18160ddd")   // name/symbol/totalSupply
  ]);
  const str = (d) => {
    if (!d || d === "0x") return "";
    try {
      const len = Number(word(d, 1));
      const body = String(d).replace(/^0x/, "").slice(128, 128 + len * 2);
      return Buffer.from(body, "hex").toString("utf8").replace(/ +$/, "");
    } catch (e) { return ""; }
  };
  return res.status(200).json({
    asset: {
      id,
      name: str(nm) || "Unknown",
      symbol: str(sy) || "?",
      totalSupply: sup ? units(BigInt(sup), 18) : "0"
    }
  });
}

async function pair(res, id) {
  const latest = Number(BigInt(await rpc("eth_blockNumber", [])));
  const start = await launchOf(id, latest);
  if (!start) return res.status(404).json({ error: "unknown pair" });
  return res.status(200).json({
    pair: {
      id,
      dexKey: "waves",
      asset0Id: id,
      asset1Id: WETH,
      createdAtBlockNumber: start.block,
      createdAtBlockTimestamp: await blockTime(start.block),
      createdAtTxnId: start.txn,
      feeBps: start.feeBps
    }
  });
}

async function events(res, fromBlock, toBlock) {
  const t = await terms();

  /* Which tokens traded in this window. One query against the curve, then a
   * replay per token — the range is the aggregator's, the history is ours. */
  const logs = await rpc("eth_getLogs", [{
    address: CURVE, fromBlock: hex(fromBlock), toBlock: hex(toBlock),
    topics: [[BOUGHT, SOLD]]
  }]);
  const tokens = [...new Set(logs.map((l) => addrOf(l.topics[1])))];

  const stamps = new Map();
  const at = async (n) => {
    if (!stamps.has(n)) stamps.set(n, await blockTime(n));
    return stamps.get(n);
  };

  const out = [];
  for (const token of tokens.slice(0, 25)) {
    const r = await replay(token, toBlock, t);
    if (!r) continue;
    for (const e of r.events) {
      if (e.blockNumber < fromBlock || e.blockNumber > toBlock) continue;
      const ev = {
        block: { blockNumber: e.blockNumber, blockTimestamp: await at(e.blockNumber) },
        eventType: "swap",
        txnId: e.txnId,
        txnIndex: e.txnIndex,
        eventIndex: e.eventIndex,
        maker: e.maker,
        pairId: token,
        priceNative: e.priceNative,
        reserves: {
          asset0: units(e.reserveToken, 18),
          asset1: units(e.reserveEth, 18)
        }
      };
      /* asset0 is the token, asset1 is ETH. A buy sends ETH in and takes
       * tokens out; a sell is the mirror. Only the two moving sides are named,
       * which is what the schema asks for. */
      if (e.buy) {
        ev.asset1In = units(e.ethAmount, 18);
        ev.asset0Out = units(e.tokenAmount, 18);
      } else {
        ev.asset0In = units(e.tokenAmount, 18);
        ev.asset1Out = units(e.ethAmount, 18);
      }
      out.push(ev);
    }
  }

  out.sort((a, b) =>
    a.block.blockNumber - b.block.blockNumber ||
    a.txnIndex - b.txnIndex || a.eventIndex - b.eventIndex);

  return res.status(200).json({ events: out });
}

export default async function handler(req, res) {
  /* Public and unauthenticated by design — an aggregator cannot hold a key —
   * but every path here costs RPC calls, so it is rate limited like the rest. */
  if (!(await allow(req, { bucket: "dex", max: 240, windowSec: 60 }))) return tooMany(res, 60);

  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Cache-Control", "public, max-age=5");

  const q = req.query || {};
  const path = String(q.path || "").replace(/^\/+/, "");

  try {
    if (path === "latest-block") return await latestBlock(res);

    if (path === "asset") {
      const id = String(q.id || "").toLowerCase();
      if (!/^0x[0-9a-f]{40}$/.test(id)) return res.status(400).json({ error: "bad id" });
      return await asset(res, id);
    }

    if (path === "pair") {
      const id = String(q.id || "").toLowerCase();
      if (!/^0x[0-9a-f]{40}$/.test(id)) return res.status(400).json({ error: "bad id" });
      return await pair(res, id);
    }

    if (path === "events") {
      const from = Number(q.fromBlock), to = Number(q.toBlock);
      if (!Number.isFinite(from) || !Number.isFinite(to) || to < from) {
        return res.status(400).json({ error: "bad range" });
      }
      /* A window wider than the chain will answer is refused rather than
       * silently truncated: an aggregator that thinks it has been given a range
       * it has not would skip those blocks forever. */
      if (to - from > MAX_SPAN) return res.status(400).json({ error: "range too wide" });
      return await events(res, from, to);
    }

    return res.status(200).json({
      adapter: "waves-bonding-curve",
      chain: CHAIN_ID,
      curve: CURVE,
      endpoints: ["latest-block", "asset?id=", "pair?id=", "events?fromBlock=&toBlock="]
    });
  } catch (e) {
    return res.status(500).json({ error: String(e.message || e).slice(0, 200) });
  }
}
