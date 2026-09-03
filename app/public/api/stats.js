// GET /api/stats?mint=<mint>[&tf=1h|6h|1d|7d|all]
//   -> { stats, trades, points }
//
// What api/indexer.js recorded, shaped for the token page. Serving this from
// KV rather than the chain is the whole point: the page used to read the pool's
// entire signature history on every load, which cost a second or two and could
// not answer "what was the price yesterday" at all.
//
// `points` is the price series for the chart, bucketed to keep the line honest
// at every zoom level — a day of trading drawn as raw points is noise, and an
// hour of trading drawn as hourly candles is a single dot.
//
// Degrades to empty rather than erroring: a token indexed a minute ago and one
// that has never traded look the same to the page, and both are fine.

export const config = { runtime: "nodejs" };

import { allow, tooMany } from "./_guard.js";

const WINDOWS = {
  "1h": 3600000,
  "6h": 21600000,
  "1d": 86400000,
  "7d": 604800000,
  all: null
};

function kv() {
  /* No credentials means no store, not a broken one. The Upstash client
   * constructs happily without a url and then fails every command with
   * "Failed to parse URL from /pipeline", which reads like a bug in us and
   * aborted the whole job — so answer null and let callers degrade. */
  if (!process.env.KV_REST_API_URL || !process.env.KV_REST_API_TOKEN) {
    return Promise.resolve(null);
  }
  return import("@upstash/redis").then(({ Redis }) => new Redis({
    url: process.env.KV_REST_API_URL,
    token: process.env.KV_REST_API_TOKEN
  }));
}

const B58 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

/* One point per bucket, carrying the last price in it — a close, which is what
 * a line chart wants. Buckets with no trades are skipped rather than filled
 * flat: a gap in the line is true, an invented price is not. */
function bucket(trades, from, to, want) {
  if (!trades.length) return [];
  const span = Math.max(1, to - from);
  const size = Math.max(1, Math.floor(span / Math.max(1, want)));
  const out = [];
  let cur = null;
  for (const t of trades) {
    const b = Math.floor((t.at - from) / size);
    if (cur && cur.b === b) { cur.price = t.price; cur.vol += t.quote; cur.n++; continue; }
    if (cur) out.push(cur);
    cur = { b, at: from + b * size, price: t.price, vol: t.quote, n: 1 };
  }
  if (cur) out.push(cur);
  return out.map((p) => ({ at: p.at, price: p.price, vol: p.vol, n: p.n }));
}

const QUOTE_MINTS = {
  sol:  "So11111111111111111111111111111111111111112",
  usdc: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"
};

/* The dollar rate for a quote currency, independent of any token being
 * indexed. A launch is minutes old before the indexer has seen it, but its
 * page still wants to show dollars rather than falling back to raw SOL — so
 * this answers from the same source the indexer uses, cached at the edge. */
const B58MINT = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
async function quoteUsd(sym) {
  // a known quote symbol (sol/usdc), or a raw mint address — the token page
  // uses the raw-mint form to price a reward asset (e.g. an xStock) so it can
  // show accrued/distributed in that asset rather than the quote currency
  const key = String(sym || "sol").toLowerCase();
  const mint = QUOTE_MINTS[key] || (B58MINT.test(String(sym)) ? String(sym) : null);
  if (!mint) return null;
  try {
    const j = await fetch("https://lite-api.jup.ag/price/v3?ids=" + mint).then((r) => r.json());
    const v = j && j[mint] && j[mint].usdPrice;
    return typeof v === "number" && v > 0 ? v : null;
  } catch (e) { return null; }
}

export default async function handler(req, res) {
  /* Same reasoning as solstats: the cache handles honest traffic, this
   * handles the traffic that deliberately misses it. */
  if (!(await allow(req, { bucket: "stats", max: 120, windowSec: 60 }))) return tooMany(res, 60);

  // ?usd=sol — just the rate, for a page whose token is not indexed yet
  if (req.query && req.query.usd) {
    const usd = await quoteUsd(req.query.usd);
    res.setHeader("Cache-Control", "public, s-maxage=120, stale-while-revalidate=600");
    return res.status(200).json({ usd });
  }

  /* Bulk mode: ?mints=a,b,c returns just the headline figures for each, so the
   * explore page can price a whole grid in dollars with one request instead of
   * one per card. No trades, no series — those are only wanted on a detail
   * page, and shipping them for twenty tokens would be most of a megabyte. */
  const many = (req.query && req.query.mints) || "";
  if (many) {
    const mints = many.split(",").map((s) => s.trim()).filter((s) => B58.test(s)).slice(0, 60);
    if (!mints.length) return res.status(200).json({ stats: {} });
    try {
      const db = await kv();
      if (!db) return res.status(200).json({ stats: {}, degraded: true });
      const raws = await Promise.all(mints.map((m) => db.get("ix:" + m + ":stats")));
      const out = {};
      raws.forEach((v, i) => {
        let s = v;
        if (typeof s === "string") { try { s = JSON.parse(s); } catch { s = null; } }
        if (!s) return;
        out[mints[i]] = {
          price: s.price, priceUsd: s.priceUsd, mcap: s.mcap, mcapUsd: s.mcapUsd,
          quoteUsd: s.quoteUsd, vol24h: s.vol24h, holders: s.holders,
          trades24h: s.trades24h, supply: s.supply
        };
      });
      res.setHeader("Cache-Control", "public, s-maxage=30, stale-while-revalidate=300");
      return res.status(200).json({ stats: out });
    } catch (e) {
      return res.status(200).json({ stats: {}, degraded: true });
    }
  }

  const mint = (req.query && req.query.mint) || "";
  if (!B58.test(mint)) return res.status(400).json({ error: "bad mint" });
  const tf = (req.query && req.query.tf) || "all";
  const win = Object.prototype.hasOwnProperty.call(WINDOWS, tf) ? WINDOWS[tf] : null;

  try {
    const db = await kv();
    const [rawStats, rawTrades] = await Promise.all([
      db.get("ix:" + mint + ":stats"),
      db.get("ix:" + mint + ":trades")
    ]);
    const parse = (v) => {
      if (v == null) return null;
      if (typeof v !== "string") return v;
      try { return JSON.parse(v); } catch { return null; }
    };
    const stats = parse(rawStats);
    let trades = parse(rawTrades) || [];
    if (!Array.isArray(trades)) trades = [];

    const now = Date.now();
    const from = win ? now - win : (trades.length ? trades[0].at : now);
    const inWindow = win ? trades.filter((t) => t.at >= from) : trades;

    /* Bucket out to the last trade, not to now. On "all", a token that traded
     * hard for two minutes and then went quiet was being spread across a
     * window stretching to the present, so every trade landed in the first
     * bucket or two and the chart drew a two-point line. */
    const to = win ? now : (inWindow.length ? inWindow[inWindow.length - 1].at : now);

    /* Change over the selected window, measured from the first trade inside it
     * — or from the last trade before it, so a quiet token still shows the move
     * that got it to where it is rather than a flat zero. */
    let change = null;
    if (inWindow.length) {
      const before = win ? trades.filter((t) => t.at < from) : [];
      const open = before.length ? before[before.length - 1].price : inWindow[0].price;
      const close = inWindow[inWindow.length - 1].price;
      if (open > 0) change = (close - open) / open;
    }

    res.setHeader("Cache-Control", "public, s-maxage=30, stale-while-revalidate=300");
    return res.status(200).json({
      stats: stats || null,
      indexed: !!stats,
      tf,
      change,
      windowVol: inWindow.reduce((a, b) => a + b.quote, 0),
      windowTrades: inWindow.length,
      points: bucket(inWindow, from, to, 120),
      // newest first is what a feed wants; the store keeps oldest first
      trades: inWindow.slice(-60).reverse()
    });
  } catch (e) {
    // the page must render without us
    return res.status(200).json({
      stats: null, indexed: false, degraded: true,
      points: [], trades: [], tf, change: null
    });
  }
}
