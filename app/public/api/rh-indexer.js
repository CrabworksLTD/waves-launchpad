// GET /api/rh-indexer — keep a holder table for every Robinhood launch.
//
// The keeper cannot pay holders it cannot name, and on this chain there is no
// way to ask "who holds this token". Solana has getProgramAccounts, which
// returns every holder in one call. An ERC20 has nothing of the sort: the only
// record of who owns what is the Transfer log, and the balances are whatever
// you get from adding it all up.
//
// So this walks the log once, forward, and keeps the running total.
//
// ── Why it cannot be done on demand ──────────────────────────────────────────
// Measured on 2026-09-03: blocks arrive every 0.104s, so a week is 5.8 million
// of them. An open-ended eth_getLogs is answered with "log query timed out", a
// wide one with "logs matched by query exceeds limit of 10000", and a
// 50,000-block window — about 1.4 hours — is what actually works. A token with
// any history cannot be summed inside one request, and a keeper run that tried
// would time out holding money it had already claimed.
//
// Hence a cursor. Each run advances as far as it can and stores where it got
// to; the next picks up there. A busy token catches up over several runs rather
// than failing on all of them.
//
// ── What is not a holder ─────────────────────────────────────────────────────
// The curve holds every token that has not been sold yet, and after graduation
// the pool holds the liquidity. Neither is a person. Counting them would hand
// most of every payout back to the contracts it came from, so both are excluded
// — along with the zero address, which is where burns go.

import { kv } from "./_guard.js";

export const config = { runtime: "nodejs" };

const RPC = process.env.RH_RPC || "https://rpc.mainnet.chain.robinhood.com";
const POOL_MANAGER = "0x8366a39cc670b4001a1121b8f6a443a643e40951";

// keccak("Transfer(address,address,uint256)")
const TRANSFER = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";

// Bought(address,address,uint256,uint256,uint256) / Sold(...)
const BOUGHT = "0x7ce543d1780f3bdc3dac42da06c95da802653cd1b212b8d74ec3e3c33ad7095c";
const SOLD   = "0x9be8a5ca22b7e6e81f04b5879f0248227bb770114291bd47dfaee4c3a82ad60e";

const CHUNK = 50000n;            // the widest window this chain will answer
const MAX_CHUNKS = 12;           // per token per run — keeps a run inside its timeout
const ZERO = "0x0000000000000000000000000000000000000000";

let rpcId = 0;
async function rpc(method, params) {
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
}

const addrOf = (topic) => "0x" + String(topic).slice(-40).toLowerCase();

// keccak("Launched(address,address,uint16,string,string)")
const LAUNCHED = "0xcf74280e4eafa3845516f297991e114213dc6a4c132199d8338fe6ba26b216e4";

/**
 * The block a token launched in, for records written before it was captured.
 *
 * Without it there is nowhere honest to start: this chain prunes historical
 * state within minutes, so a contract cannot be asked when it appeared, and
 * starting one window back silently misses every transfer before that — a
 * holder table short of the people who bought first.
 *
 * The curve knows, because it announced the launch. Searching ITS log is cheap
 * where searching the token's is not: there are a handful of launches, not a
 * trade every few seconds. Cached once found, so this runs once per token ever.
 */
async function findLaunchBlock(db, curveAddr, token, latest) {
  const key = "rhix:" + token + ":start";
  const cached = await db.get(key).catch(() => null);
  if (cached) return BigInt(cached);

  let cursor = latest;
  for (let i = 0; i < 40 && cursor > 0n; i++) {     // ~2.3 days back
    const from = cursor > CHUNK ? cursor - CHUNK : 0n;
    let logs = [];
    try {
      logs = await rpc("eth_getLogs", [{
        address: curveAddr,
        fromBlock: "0x" + from.toString(16),
        toBlock: "0x" + cursor.toString(16),
        topics: [LAUNCHED, null, null]
      }]);
    } catch (e) {
      break;
    }
    const hit = logs.find((l) => addrOf(l.topics[1]) === token);
    if (hit) {
      const b = BigInt(hit.blockNumber);
      await db.set(key, b.toString());
      return b;
    }
    cursor = from;
    if (from === 0n) break;
  }
  return null;
}

/**
 * Advance one token's holder table as far as this run can.
 *
 * Balances are kept as decimal strings because they are uint256 and JSON has no
 * integer that wide — a float would silently round someone's balance and pay
 * them the wrong amount.
 */
async function indexToken(db, rec, curveAddr) {
  const token = String(rec.mint).toLowerCase();
  const cursorKey = "rhix:" + token + ":cursor";
  const holdersKey = "rhix:" + token + ":h";

  const latest = BigInt(await rpc("eth_blockNumber", []));
  let from = BigInt((await db.get(cursorKey).catch(() => null)) || rec.block || 0);
  if (from <= 0n) {
    // recorded before the launch block was captured — ask the curve
    const found = await findLaunchBlock(db, String(curveAddr).toLowerCase(), token, latest);
    from = found !== null ? found : (latest > CHUNK ? latest - CHUNK : 0n);
  }
  if (from >= latest) return { token, moved: 0, upTo: Number(from), done: true };

  /* Not holders, and counting them would be worse than useless.
   *
   * The curve holds every token that has not been sold yet — at launch that is
   * the entire supply — and after graduation the PoolManager holds the
   * liquidity. Both would swamp the table and take most of every payout back to
   * the contracts the money came from. The zero address is where burns go. */
  const skip = new Set([ZERO, String(curveAddr).toLowerCase(), POOL_MANAGER]);

  const balances = new Map();
  let moved = 0;
  let cursor = from;

  for (let i = 0; i < MAX_CHUNKS && cursor < latest; i++) {
    const to = cursor + CHUNK > latest ? latest : cursor + CHUNK;
    let logs;
    try {
      logs = await rpc("eth_getLogs", [{
        address: token,
        fromBlock: "0x" + cursor.toString(16),
        toBlock: "0x" + to.toString(16),
        topics: [TRANSFER]
      }]);
    } catch (e) {
      /* A refused window is not a failure: stop here, keep what was counted,
       * and let the next run resume. Pushing on would leave a gap in the sum,
       * which is worse than being behind. */
      break;
    }
    for (const lg of logs) {
      if (!lg.topics || lg.topics.length < 3) continue;
      const fromA = addrOf(lg.topics[1]);
      const toA = addrOf(lg.topics[2]);
      const value = BigInt(lg.data || "0x0");
      if (value === 0n) continue;
      if (!skip.has(fromA)) balances.set(fromA, (balances.get(fromA) || 0n) - value);
      if (!skip.has(toA)) balances.set(toA, (balances.get(toA) || 0n) + value);
      moved++;
    }
    cursor = to;
  }

  if (balances.size) {
    /* Read, add, write. The deltas above are only what THIS run saw; the stored
     * figure is the running total. */
    const prior = (await db.hgetall(holdersKey).catch(() => null)) || {};
    const out = {};
    const del = [];
    for (const [addr, delta] of balances) {
      const now = BigInt(prior[addr] || "0") + delta;
      if (now > 0n) out[addr] = now.toString();
      else del.push(addr);            // sold out; not a holder any more
    }
    if (Object.keys(out).length) await db.hset(holdersKey, out);
    if (del.length) await db.hdel(holdersKey, ...del);
  }

  await db.set(cursorKey, cursor.toString());
  return { token, moved, upTo: Number(cursor), done: cursor >= latest };
}

const word = (d, i) => BigInt("0x" + String(d).replace(/^0x/, "").slice(i * 64, i * 64 + 64));

let termsCache = null;
async function curveTerms(curveAddr) {
  if (termsCache) return termsCache;
  const [ve, vt, cs] = await Promise.all([
    rpc("eth_call", [{ to: curveAddr, data: "0x4bd387e1" }, "latest"]),
    rpc("eth_call", [{ to: curveAddr, data: "0x1d3dad09" }, "latest"]),
    rpc("eth_call", [{ to: curveAddr, data: "0x2138a4c0" }, "latest"])
  ]);
  termsCache = { virtualEth: BigInt(ve), virtualTokens: BigInt(vt), curveSupply: BigInt(cs) };
  return termsCache;
}

/**
 * The price history a chart needs, in the shape api/stats.js already serves.
 *
 * ⚠️ Robinhood had no chart at all, and not because the data was missing.
 * api/stats.js rejects anything that is not base58, so an 0x token never
 * reached the indexed path — the page fell back to drawing whatever handful of
 * trades it could read live, and the 1H/6H/1D/7D buttons did nothing, because
 * every one of them asks the indexer.
 *
 * The curve's own accounting reconstructs price exactly, with no archive node:
 *
 *     Bought  raised += ethIn - fee    tokensLeft -= tokensOut
 *     Sold    raised -= ethOut + fee   tokensLeft += tokensIn
 *
 * and price is the virtual reserves, which is what the contract charges. So a
 * replay of the log gives the same {at, price, quote} records the Solana
 * indexer writes, and the same chart code draws them.
 */
async function indexTrades(db, rec, curveAddr, latest) {
  const token = String(rec.mint).toLowerCase();
  const t = await curveTerms(curveAddr);
  const topic = "0x" + "0".repeat(24) + token.slice(2);

  /* Replayed from launch every run rather than resumed from a cursor. The
   * running total IS the price, so a resumed cursor would have to persist
   * reserves as well, and any drift between the two would bend the chart
   * silently. A curve's whole log is small — a token busy enough for this to
   * hurt has graduated and left. */
  let raised = 0n, tokensLeft = t.curveSupply;
  const trades = [];
  const rawTrades = [];
  const stampOf = new Map();

  const head = await rpc("eth_getBlockByNumber", ["0x" + latest.toString(16), false]);
  const headTs = Number(BigInt(head.timestamp)) * 1000;

  const start = BigInt(rec.block || 0);
  if (start <= 0n) return null;

  for (let from = start; from <= latest; from += CHUNK) {
    const to = from + CHUNK > latest ? latest : from + CHUNK;
    let logs;
    try {
      logs = await rpc("eth_getLogs", [{
        address: curveAddr, fromBlock: "0x" + from.toString(16),
        toBlock: "0x" + to.toString(16), topics: [[BOUGHT, SOLD], topic]
      }]);
    } catch (e) { break; }

    for (const lg of logs) {
      const buy = String(lg.topics[0]).toLowerCase() === BOUGHT;
      const a = word(lg.data, 0), b = word(lg.data, 1), fee = word(lg.data, 2);
      if (buy) { raised += a - fee; tokensLeft -= b; }
      else { raised -= b + fee; tokensLeft += a; }

      const x = t.virtualEth + raised;
      const y = t.virtualTokens - (t.curveSupply - tokensLeft);
      const price = y > 0n ? Number(x) / Number(y) : 0;

      /* Interpolated from the head block, never fetched per trade. One block
       * read per trade is what made the Solana chart hammer its node into rate
       * limiting, and at ~0.104s a block the drift is invisible on a chart. */
      const blk = Number(BigInt(lg.blockNumber));
      if (!stampOf.has(blk)) {
        stampOf.set(blk, headTs - (Number(latest) - blk) * 104);
      }
      trades.push({
        at: stampOf.get(blk),
        price,
        quote: Number(buy ? a : b) / 1e18,     // the ETH side, which is the volume
        side: buy ? "buy" : "sell"
      });
      // kept as integers alongside, for the reward arithmetic below
      rawTrades.push({ block: blk, volume: buy ? a : b, fee });
    }
    if (to >= latest) break;
  }

  if (!trades.length) return { token, trades: 0 };

  const last = trades[trades.length - 1];
  const supply = Number(t.curveSupply) / 1e18;
  let ath = 0, athAt = 0;
  for (const x of trades) if (x.price > ath) { ath = x.price; athAt = x.at; }

  const holders = Object.keys(
    (await db.hgetall("rhix:" + token + ":h").catch(() => null)) || {}).length;

  /* What holders have earned and what they have actually been sent.
   *
   * Earned is in ETH because that is what the curve accrues; sent is in the
   * reward asset because that is what the keeper swapped it into and what
   * landed in a wallet. Reporting both in one currency would mean inventing an
   * exchange rate for money that moved at a different one.
   *
   * Pending is everything after the keeper's cursor — the fees a token has
   * earned for holders but not yet been paid out, which is most of what a
   * holder wants to know between hourly runs. */
  let rewards = null;
  try {
    const paidWei = BigInt((await db.get("rhk:" + token + ":paidWei")) || "0");
    const paidAsset = BigInt((await db.get("rhk:" + token + ":paidAsset")) || "0");
    /* Whichever we know: what the keeper last paid in, or — before any payout
     * has happened — what the creator chose at launch. Without the fallback a
     * token that has never had a run could not name its own reward asset. */
    const assetAddr = (await db.get("rhk:" + token + ":paidAssetAddr")) ||
      (rec.rewardMint ? String(rec.rewardMint).toLowerCase() : null);
    const cursor = BigInt((await db.get("rhk:" + token + ":cursor")) || rec.block || 0);

    const c = await rpc("eth_call", [{
      to: curveAddr, data: "0x2cc3dc6e" + "0".repeat(24) + token.slice(2)
    }, "latest"]);
    const feeBps = Number(word(c, 1));
    const rewardsBps = Number(word(c, 2));
    const platBps = { 100: 40, 200: 50, 300: 60, 400: 70, 500: 80, 1000: 90 }[feeBps] ?? 40;

    /* Only trades the keeper has not settled yet. Its cursor is in blocks and
     * these records are in milliseconds, so the split is done on the raw log
     * during the same pass rather than guessed from timestamps. */
    let pending = 0n;
    if (rewardsBps > 0) {
      for (const r of rawTrades) {
        if (BigInt(r.block) <= cursor) continue;
        let toPlatform = (r.volume * BigInt(platBps)) / 10000n;
        if (toPlatform > r.fee) toPlatform = r.fee;
        pending += ((r.fee - toPlatform) * BigInt(rewardsBps)) / 10000n;
      }
    }
    /* What the earned ETH is worth in the asset holders actually get.
     *
     * A real quote through the same router the keeper swaps with, not a
     * conversion invented from two dollar prices — so the figure is what the
     * next payout would genuinely buy, at the depth it would genuinely hit.
     * Reusing the keeper's own routing means the number on the page and the
     * number in the payout cannot disagree. */
    let earnedAsset = null;
    try {
      const earned = paidWei + pending;
      if (earned > 0n && assetAddr) {
        const { bestRoute } = await import("./rh-keeper.js");
        const r = await bestRoute(assetAddr, earned);
        if (r && r.out > 0n) earnedAsset = r.out.toString();
      }
    } catch (e) { /* the ETH figure still stands on its own */ }

    rewards = {
      earnedWei: (paidWei + pending).toString(),
      earnedAsset,
      pendingWei: pending.toString(),
      paidWei: paidWei.toString(),
      paidAsset: paidAsset.toString(),
      assetAddr: assetAddr || null,
      /* What the fallback had to work with. Guessing why this came out null
       * cost two deploys; the record's own field is one string and reporting it
       * makes the next answer immediate. */
      fromRecord: rec.rewardMint || null,
      rewardsBps
    };
  } catch (e) { /* the chart does not depend on these */ }

  /* Dollars, because a card shows dollars. The Solana indexer stores these on
   * the same blob and the bulk endpoint hands them straight to the grid — an
   * EVM token without them priced as a dash no matter what the chain said. */
  let ethUsd = 0;
  try {
    ethUsd = await fetch("https://api.coinbase.com/v2/prices/ETH-USD/spot",
      { signal: AbortSignal.timeout(6000) })
      .then((r) => r.json()).then((j) => Number(j.data.amount)) || 0;
  } catch (e) { /* the native figures still stand */ }

  const dayAgo = Date.now() - 86400000;
  const day = trades.filter((x) => x.at >= dayAgo);
  const vol24h = day.reduce((a, x) => a + x.quote, 0);

  await db.set("ix:" + token + ":trades", JSON.stringify(trades.slice(-600)));
  await db.set("ix:" + token + ":stats", JSON.stringify({
    price: last.price,
    priceUsd: ethUsd ? last.price * ethUsd : null,
    supply,
    mcap: last.price * supply,
    mcapUsd: ethUsd ? last.price * supply * ethUsd : null,
    quoteUsd: ethUsd || null,
    vol24h,
    trades24h: day.length,
    holders,
    ath, athAt,
    rewards,
    quote: "ETH",
    at: Date.now()
  }));

  /* ⚠️ Sync the pledge from the chain into the listing.
   *
   * A creator activates rewards with one on-chain call that touches nothing of
   * ours, so feeSharePct stays 0 in the record — and the homepage card decides
   * whether to show the rewards badge and the /TSLA suffix from exactly that
   * field. So a token visibly paying its holders advertised neither. Writing it
   * back here fixes every reader at once instead of teaching each one to go and
   * ask the curve. */
  let synced = null, syncError = null;
  try {
    const c = await rpc("eth_call", [{
      to: curveAddr, data: "0x2cc3dc6e" + "0".repeat(24) + token.slice(2)
    }, "latest"]);
    const bps = Number(word(c, 2));
    synced = "bps=" + bps + " listed=" + (rec.feeSharePct || 0);
    if (bps > 0 && (rec.feeSharePct || 0) !== bps / 100) {
      const raw = await db.lrange("tokens", 0, 199);
      for (let i = 0; i < (raw || []).length; i++) {
        const cur = typeof raw[i] === "string" ? JSON.parse(raw[i]) : raw[i];
        if (!cur || String(cur.mint).toLowerCase() !== token) continue;
        cur.feeSharePct = bps / 100;
        cur.feeShare = "holders";
        await db.lset("tokens", i, JSON.stringify(cur));
        synced = "wrote " + (bps / 100) + "% at index " + i;
        break;
      }
    }
  } catch (e) {
    /* Reported, not swallowed. A silent failure here looks exactly like "the
     * creator has not pledged" — the badge and the reward ticker stay off and
     * nothing anywhere says why. */
    syncError = String(e.message || e).slice(0, 120);
  }

  return { token, trades: trades.length, price: last.price, synced, syncError };
}

export default async function handler(req, res) {
  /* Reading the table is not indexing it.
   *
   * The sweep walks the chain and costs real time; the token page just wants
   * the count and the top holders, which is one hash read. Keeping them on the
   * same endpoint but different verbs means a page load never triggers a walk
   * it then has to wait for.
   *
   * Percentages are of TOTAL SUPPLY, matching api/indexer.js — against the
   * circulating float they add to 100% and read as though the token is fully
   * distributed while the curve still holds most of it. */
  const want = (req.query && req.query.holders) || null;
  if (want) {
    if (!/^0x[0-9a-fA-F]{40}$/.test(want)) return res.status(400).json({ error: "bad token" });
    try {
      const db = await kv();
      const table = (await db.hgetall("rhix:" + want.toLowerCase() + ":h")) || {};
      const rows = Object.entries(table)
        .map(([owner, amt]) => ({ owner, amt: BigInt(amt) }))
        .filter((r) => r.amt > 0n)
        .sort((a, b) => (b.amt > a.amt ? 1 : b.amt < a.amt ? -1 : 0));

      /* The denominator is the token's own totalSupply, asked of the token.
       * Summing the table would give the float, which is the wrong basis and
       * also wrong in a different way while the cursor is behind. */
      let supply = 0;
      let supplyError = null;
      try {
        const hex = await rpc("eth_call", [{ to: want, data: "0x18160ddd" }, "latest"]);
        supply = Number(BigInt(hex || "0x0")) / 1e18;
        if (!supply) supplyError = "empty: " + JSON.stringify(hex);
      } catch (e) {
        /* Reported rather than swallowed. A silent failure here does not look
         * like a failure — it looks like every holder owning 0% of the token,
         * which is a number, and wrong numbers are worse than absent ones. */
        supplyError = String(e.message || e).slice(0, 160);
      }

      return res.status(200).json({
        ok: true,
        holders: rows.length,
        supply,
        supplyError,
        top: rows.slice(0, 20).map((r) => {
          const amount = Number(r.amt) / 1e18;
          return { owner: r.owner, amount, pct: supply ? (amount / supply) * 100 : 0 };
        })
      });
    } catch (e) {
      return res.status(200).json({ ok: false, error: String(e.message || e).slice(0, 140) });
    }
  }

  const secret = process.env.CRON_SECRET;
  const authed = !secret || req.headers.authorization === "Bearer " + secret;
  const only = (req.query && req.query.token) || null;
  // one token by name is open, like /api/indexer: a launch wants its own page
  // to fill in without waiting for the next sweep
  if (!authed && !only) return res.status(401).json({ error: "no" });

  try {
    const db = await kv();
    const raw = await db.lrange("tokens", 0, 199);
    const all = (raw || []).map((r) => (typeof r === "string" ? JSON.parse(r) : r));

    /* Only Robinhood launches, and only ones that pledged. Indexing holders for
     * a token whose creator kept every fee is work nobody will ever read. */
    let toks = all.filter((t) => t && t.chain === "robinhood");
    if (only) toks = toks.filter((t) => String(t.mint).toLowerCase() === String(only).toLowerCase());
    /* Every Robinhood launch, not only the ones whose LISTING says they
     * pledged. Activating rewards from /fees is an on-chain call that does not
     * touch our record, so filtering on feeSharePct skipped the holder tables
     * of exactly the tokens that needed them — and the keeper cannot pay
     * holders it cannot name. */
    // (no filter: the sweep is capped at 8 tokens per run either way)

    const curveAddr = process.env.RH_CURVE || "0x87c04ca8633a56c30e68919566c605fd970196d3";

    const out = [];
    for (const t of toks.slice(0, 8)) {
      try {
        const r = await indexToken(db, t, curveAddr);
        /* Holders first: the price history reports the holder count, so it
         * wants the table this run just refreshed rather than last run's. */
        try {
          const s = await indexTrades(db, t, curveAddr, BigInt(await rpc("eth_blockNumber", [])));
          if (s) { r.priced = s.trades; r.synced = s.synced; r.syncError = s.syncError; }
        } catch (e) { r.pricedError = String(e.message || e).slice(0, 90); }
        out.push(r);
      } catch (e) {
        out.push({ token: t.mint, error: String(e.message || e).slice(0, 140) });
      }
    }
    return res.status(200).json({ ok: true, indexed: out.length, results: out });
  } catch (e) {
    return res.status(200).json({ ok: false, error: String(e.message || e).slice(0, 200) });
  }
}
