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

export default async function handler(req, res) {
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
