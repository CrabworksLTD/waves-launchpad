// GET  /api/tokens        -> { tokens: [...] }   newest first
// POST /api/tokens        -> { ok: true }         record a launch
//
// The index of tokens launched here, mirroring api/collections.js — same
// reasoning, same failure mode. Deliberately a separate file with a separate
// Redis key rather than a `kind` param on the collections endpoint: Vercel
// functions are standalone, the file is forty lines, and two trivially
// readable endpoints beat one with branching.
//
// Only identity is stored (mint, name, symbol). Price and curve progress are
// live chain state and are read client-side where they are shown — a cached
// "43% to graduation" on a token that graduated an hour ago is worse than
// showing nothing.

import { okArt as okArtShared } from "./_art.js";
import { allow, tooMany, isRealLaunch, isRealEvmToken, archiveOverflow } from "./_guard.js";

const KEY = "tokens";
const MAX = 200;

function kv() {
  return import("@upstash/redis").then(({ Redis }) => new Redis({
    url: process.env.KV_REST_API_URL,
    token: process.env.KV_REST_API_TOKEN
  }));
}

const B58 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const EVM = /^0x[0-9a-fA-F]{40}$/;

export default async function handler(req, res) {
  if (req.method === "GET") {
    try {
      const db = await kv();
      const raw = await db.lrange(KEY, 0, MAX - 1);
      const out = (raw || []).map((r) => (typeof r === "string" ? JSON.parse(r) : r));
      res.setHeader("Cache-Control", "public, s-maxage=60, stale-while-revalidate=600");
      return res.status(200).json({ tokens: out });
    } catch (e) {
      // an unreachable store must not 500 the homepage
      return res.status(200).json({ tokens: [], degraded: true });
    }
  }

  if (req.method === "POST") {
    /* A launch is a rare event for any one person and a flood is never real. */
    if (!(await allow(req, { bucket: "tokens", max: 10, windowSec: 600 }))) return tooMany(res, 600);

    const body = typeof req.body === "string" ? JSON.parse(req.body || "{}") : (req.body || {});
    const { mint, name, symbol, cluster, rewardMint, collection, creator, icon, banner, pool, config, feeShare, feeSharePct, feeWallet, chain } = body;
    const isEvm = chain === "robinhood";

    /* A Robinhood Chain token is a 0x contract, not a base58 mint — the same
     * split api/collections.js makes. Validating everything as base58 would
     * reject every EVM launch with "bad mint". */
    if (isEvm) {
      if (!EVM.test(mint || "")) return res.status(400).json({ error: "bad address" });
    } else {
      if (!B58.test(mint || "")) return res.status(400).json({ error: "bad mint" });
      // both optional; validated when present so a bad value is dropped loudly
      if (rewardMint && !B58.test(rewardMint)) return res.status(400).json({ error: "bad rewardMint" });
      if (collection && !B58.test(collection)) return res.status(400).json({ error: "bad collection" });
      // Mainnet only — a devnet token on the homepage is a bug dressed as a scam.
      if (cluster && cluster !== "mainnet-beta") return res.status(200).json({ ok: true, skipped: "not mainnet" });
    }

    /* Prove it exists before listing it.
     *
     * ⚠️ Everything above this line is a SHAPE check, and shape is not
     * identity: "is this 32-44 base58 characters" is true of any such string.
     * The list is capped and trimmed, so two hundred well-formed strings pushed
     * every real launch off the homepage permanently, for the price of two
     * hundred HTTP requests. A listing now has to name a mint that exists and a
     * pool the bonding curve owns, which cannot be typed — it has to be
     * launched.
     *
     * Admins skip this: the correction path exists precisely for records the
     * chain disagrees with, and it already requires the deploy secret. */
    const isAdmin = process.env.CRON_SECRET &&
      req.headers.authorization === "Bearer " + process.env.CRON_SECRET;
    if (!isAdmin) {
      const real = isEvm ? await isRealEvmToken(mint) : await isRealLaunch(mint, pool);
      if (!real.ok) {
        /* Fail closed, including when the chain cannot be reached. Listing an
         * unverified token to be helpful during an outage reopens the whole
         * hole; the launch itself already succeeded, and the client can post
         * again. */
        return res.status(real.reason === "unverifiable" ? 503 : 400)
          .json({ ok: false, error: real.reason, retryable: real.reason === "unverifiable" });
      }
    }

    try {
      const db = await kv();
      // one rule for every endpoint — see api/_art.js
      const okArt = (u) => okArtShared(u, req.headers.host);
      const rec = {
        mint,
        name: String(name || "Untitled").slice(0, 40),
        symbol: String(symbol || "").slice(0, 12),
        /* Which side launched it. Mirrors api/collections.js — null means
         * Solana, so records written before this field existed stay Solana,
         * which is what they are. Without it the tokens page showed every
         * launch on both chains. */
        chain: isEvm ? "robinhood" : null,
        // the reward asset the creator picked, and the collection this token
        // is paired with — consumed by the staking keeper later, displayed now
        rewardMint: rewardMint || null,
        /* What the pledged share does: pay holders an asset, or buy the token
         * back and burn it. Anything unrecognised reads as a dividend, which
         * is the behaviour every launch had before this existed. */
        rewardMode: ["burn", "keep"].includes(body.rewardMode) ? body.rewardMode : "dividend",
        // only arweave art, never an arbitrary URL someone POSTs at us
        card: okArt(body.card),
        icon: okArt(icon), banner: okArt(banner),
        pool: (pool && B58.test(pool)) ? pool : null,
        feeShare: feeShare === "holders" ? "holders" : "keep",
        feeSharePct: Math.max(0, Math.min(100, parseInt(feeSharePct, 10) || 0)),
        // where the creator's KEPT portion goes. Dropped on the floor until
        // 2026-08-31, so the keeper always paid the deployer wallet while the
        // launch window promised it would route here.
        feeWallet: (feeWallet && B58.test(feeWallet)) ? feeWallet : null,
        config: (config && B58.test(config)) ? config : null,
        collection: collection || null,
        creator: (creator && B58.test(creator)) ? creator : null,
        at: Date.now()
      };
      /* Maintenance correction. Filling blanks is open to anyone (it cannot
       * destroy data); CHANGING a value that is already there is not, or a
       * listing could be rewritten by a stranger. Vercel's cron secret is the
       * key, so only someone who can already deploy can do it. */
      const admin = process.env.CRON_SECRET &&
        req.headers.authorization === "Bearer " + process.env.CRON_SECRET;
      if (admin) {
        const raw = await db.lrange(KEY, 0, MAX - 1);
        for (let i = 0; i < (raw || []).length; i++) {
          const cur = typeof raw[i] === "string" ? JSON.parse(raw[i]) : raw[i];
          if (!cur || cur.mint !== mint) continue;
          /* Only fields the caller actually SENT.
           *
           * This used to copy every non-null field of `rec`, but `rec` is a
           * fully-formed record with defaults — name falls back to "Untitled"
           * and symbol to "", neither of which is null. So correcting one field
           * silently renamed the token to "Untitled" and blanked its ticker.
           * Doing it to $SOLWAVES while attaching its share card is how this
           * was found. */
          for (const k of Object.keys(rec)) {
            if (k === "at" || !(k in body)) continue;
            if (rec[k] != null) cur[k] = rec[k];
          }
          await db.lset(KEY, i, JSON.stringify(cur));
          return res.status(200).json({ ok: true, corrected: true });
        }
      }

      const first = await db.set("tok:" + mint, 1, { nx: true });
      if (first !== "OK") {
        /* Already listed. Rather than dropping the payload, fill in anything
         * the stored record is missing — a launch that recorded before its
         * art finished uploading, or was repaired by hand, should be able to
         * complete itself. Existing values are never overwritten, so this
         * cannot be used to rewrite someone's listing. */
        const raw = await db.lrange(KEY, 0, MAX - 1);
        for (let i = 0; i < (raw || []).length; i++) {
          const cur = typeof raw[i] === "string" ? JSON.parse(raw[i]) : raw[i];
          if (!cur || cur.mint !== mint) continue;
          let changed = false;
          for (const k of Object.keys(rec)) {
            if ((cur[k] === null || cur[k] === undefined) && rec[k] != null) {
              cur[k] = rec[k]; changed = true;
            }
          }
          if (changed) await db.lset(KEY, i, JSON.stringify(cur));
          return res.status(200).json({ ok: true, updated: changed, duplicate: !changed });
        }
        return res.status(200).json({ ok: true, duplicate: true });
      }

      await db.lpush(KEY, JSON.stringify(rec));
      // whatever falls off the end is kept, so the cap is a window and not a delete
      await archiveOverflow(db, KEY, MAX);
      await db.ltrim(KEY, 0, MAX - 1);
      return res.status(200).json({ ok: true });
    } catch (e) {
      // a launch must never fail because the listing did
      return res.status(200).json({ ok: false, detail: "not listed" });
    }
  }

  res.setHeader("Allow", "GET, POST");
  return res.status(405).json({ error: "GET or POST" });
}
