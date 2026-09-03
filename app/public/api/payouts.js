// GET /api/payouts            → { payouts: { <mint>: {sentRaw, runs, holders, lastAt} } }
// GET /api/payouts?mint=<m>    → the same map, filtered to one mint
//
// "Sent out to holders so far", derived — not a new number the keeper has to
// maintain. Every keeper run appends one entry to the `keeperlog` list:
//   { mint, claimed, creatorCut, holders, claimSig, at }
// where `claimed` and `creatorCut` are RAW quote-lamports (strings). The holder
// pot for a run is whatever was claimed minus the creator's kept cut, so the
// lifetime total paid to a token's holders is the sum of (claimed - creatorCut)
// over its entries. The keeper pays gas from its own float, so this is the pot
// that reached holders, in the pool's quote currency. The caller formats it
// with that quote's decimals (see fees.html), exactly as it formats accrued.
//
// ⚠️ Two known bounds, both fine for launch and worth revisiting:
//  - keeperlog is capped at the last 500 run-entries globally (keeper ltrims
//    it). A token that has paid out across more than 500 total platform runs
//    would undercount the oldest ones. A per-mint cumulative counter written by
//    the keeper would be exact; this avoids touching the money path.
//  - burn-mode rewards destroy the pot rather than sending it to holders, and
//    the log entry does not record the mode. Burn has never been run, and
//    $MOAR/etc. are dividend mode, so this over-counts nothing today. If burn
//    ships, stamp the mode into the keeperlog entry and exclude it here.

import { allow, tooMany } from "./_guard.js";

function kv() {
  if (!process.env.KV_REST_API_URL || !process.env.KV_REST_API_TOKEN) {
    return Promise.resolve(null);
  }
  return import("@upstash/redis").then(({ Redis }) => new Redis({
    url: process.env.KV_REST_API_URL,
    token: process.env.KV_REST_API_TOKEN
  }));
}

const B58 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

export default async function handler(req, res) {
  /* Reads five hundred log rows out of Redis on every call and has no
   * cache header, so each request is real work no CDN absorbs. */
  if (!(await allow(req, { bucket: "payouts", max: 120, windowSec: 60 }))) return tooMany(res, 60);

  if (req.method !== "GET") return res.status(405).json({ error: "GET only" });
  const only = req.query && req.query.mint;
  if (only && !B58.test(String(only))) {
    return res.status(400).json({ error: "bad mint" });
  }
  try {
    const db = await kv();
    if (!db) return res.status(200).json({ payouts: {} });

    let rows = await db.lrange("keeperlog", 0, 499).catch(() => []);
    if (!Array.isArray(rows)) rows = [];

    const payouts = {};
    for (const raw of rows) {
      let e = raw;
      if (typeof e === "string") { try { e = JSON.parse(e); } catch { continue; } }
      if (!e || !e.mint) continue;
      if (only && e.mint !== only) continue;

      let claimed, creatorCut;
      try {
        claimed = BigInt(e.claimed || 0);
        creatorCut = BigInt(e.creatorCut || 0);
      } catch { continue; }
      // clamp: a run that paid the whole pot to holders has creatorCut 0, and a
      // 100%-creator config would never be pledged, but never report negative
      const pot = claimed > creatorCut ? claimed - creatorCut : 0n;

      const p = payouts[e.mint] || (payouts[e.mint] = {
        sent: 0n, claimed: 0n, runs: 0, holders: 0, lastAt: 0
      });
      p.sent += pot;
      p.claimed += claimed;          // total creator-side fees claimed since deploy
      p.runs += 1;
      // keeperlog is newest-first (lpush), so the first entry we see for a mint
      // is its most recent run — take holders/lastAt from that one
      if (e.at && e.at > p.lastAt) {
        p.lastAt = e.at;
        p.holders = e.holders || 0;
      }
    }

    // BigInt does not serialise to JSON; hand back the raw lamport string
    const out = {};
    for (const m of Object.keys(payouts)) {
      const p = payouts[m];
      out[m] = { sentRaw: p.sent.toString(), claimedRaw: p.claimed.toString(),
                 runs: p.runs, holders: p.holders, lastAt: p.lastAt };
    }
    res.setHeader("cache-control", "public, max-age=30");
    return res.status(200).json({ payouts: out });
  } catch (e) {
    return res.status(500).json({ error: String((e && e.message) || e).slice(0, 200), payouts: {} });
  }
}
