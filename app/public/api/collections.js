// GET  /api/collections        -> { collections: [...] }   newest first
// POST /api/collections        -> { ok: true }              record a launch
//
// The index of what has been launched here. Deliberately NOT on chain.
//
// DAS can answer "what assets are in this collection" but not "which
// collections came from us" — every creator is their own update authority, so
// there is nothing common to query on. The alternatives were deploying a
// registry program (which would be the only custom program in the system, for
// a listing page) or keeping a list. A list wins.
//
// The failure mode is the right one: if this store is unavailable the homepage
// listing goes quiet, but every collection and every mint page keeps working,
// because those read chain state by address and never touch this. Nothing
// anyone paid for depends on it.
//
// Only the address is stored. Names, prices, supply and mint progress are read
// live from chain by the client — caching those would mean showing a stale
// "12/500 minted" on a sold-out collection, which is worse than showing
// nothing.

import { okArt } from "./_art.js";
import { allow, tooMany, isRealCollection, isRealEvmToken, archiveOverflow } from "./_guard.js";

const KEY = "collections";
const MAX = 200;                 // the listing is a shop window, not an archive

function kv() {
  return import("@upstash/redis").then(({ Redis }) => new Redis({
    url: process.env.KV_REST_API_URL,
    token: process.env.KV_REST_API_TOKEN
  }));
}

// base58, 32 bytes — same shape check as upload-url, kept local so neither
// file has to import the other.
const B58 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
// EVM address, for Robinhood Chain launches
const EVM = /^0x[0-9a-fA-F]{40}$/;

export default async function handler(req, res) {
  if (req.method === "GET") {
    /* Prove it exists. A shape check cannot tell a collection from a string,
     * and a string was enough to evict a real one. See api/_guard.js. */
    {
      const isAdmin = process.env.CRON_SECRET &&
        req.headers.authorization === "Bearer " + process.env.CRON_SECRET;
      if (!isAdmin) {
        const real = isEvm ? await isRealEvmToken(address) : await isRealCollection(collection);
        if (!real.ok) {
          return res.status(real.reason === "unverifiable" ? 503 : 400)
            .json({ ok: false, error: real.reason, retryable: real.reason === "unverifiable" });
        }
      }
    }

    try {
      const db = await kv();
      const raw = await db.lrange(KEY, 0, MAX - 1);
      const out = (raw || []).map((r) => (typeof r === "string" ? JSON.parse(r) : r));
      // Cache briefly at the edge. The list changes when someone launches,
      // which is rare; the live numbers come from chain regardless.
      res.setHeader("Cache-Control", "public, s-maxage=60, stale-while-revalidate=600");
      return res.status(200).json({ collections: out });
    } catch (e) {
      // An unreachable store must not 500 the homepage — the section simply
      // falls back to templates.
      return res.status(200).json({ collections: [], degraded: true });
    }
  }

  if (req.method === "POST") {
    /* Same reasoning as api/tokens.js: this list is capped and trimmed, so an
     * unauthenticated write was also an unauthenticated delete. */
    if (!(await allow(req, { bucket: "collections", max: 10, windowSec: 600 }))) return tooMany(res, 600);

    const body = typeof req.body === "string" ? JSON.parse(req.body || "{}") : (req.body || {});
    const { candyMachine, collection, name, cluster, tokenMint, creator, avatar,
            chain, address } = body;

    const isEvm = chain === "robinhood";
    if (isEvm) {
      // A Robinhood Chain launch records the drop contract's address; the
      // explore page reads everything else off the contract live.
      if (!EVM.test(address || "")) return res.status(400).json({ error: "bad address" });
    } else {
      if (!B58.test(candyMachine || "")) return res.status(400).json({ error: "bad candyMachine" });
      if (!B58.test(collection || "")) return res.status(400).json({ error: "bad collection" });
      // Mainnet only. A devnet test collection on the homepage is a bug that
      // looks like a scam.
      if (cluster && cluster !== "mainnet-beta") return res.status(200).json({ ok: true, skipped: "not mainnet" });
    }

    try {
      const db = await kv();
      const rec = {
        candyMachine: isEvm ? null : candyMachine,
        collection: isEvm ? null : collection,
        chain: isEvm ? "robinhood" : null,
        address: isEvm ? address : null,
        name: String(name || "Untitled").slice(0, 40),
        // only arweave art, never an arbitrary URL someone POSTs at us
        avatar: okArt(avatar, req.headers.host),
        // the launch's own share card, pinned beside its art
        card: okArt(body.card, req.headers.host),
        tokenMint: (tokenMint && /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(tokenMint)) ? tokenMint : null,
        creator: (creator && (B58.test(creator) || EVM.test(creator))) ? creator : null,
        at: Date.now()
      };
      const key = isEvm ? address.toLowerCase() : candyMachine;
      const matches = (cur) => cur &&
        (isEvm ? String(cur.address || "").toLowerCase() === key : cur.candyMachine === key);

      /* Correcting a value that is already set needs the cron secret, so a
       * stranger cannot rewrite someone's listing; filling a blank is open,
       * because it cannot destroy anything. Both matter: a paired launch
       * writes its collection before the token exists, then comes back with
       * the token mint. */
      const admin = process.env.CRON_SECRET &&
        req.headers.authorization === "Bearer " + process.env.CRON_SECRET;

      // Idempotent: relaunching the same machine must not double-list it.
      const dupeKey = isEvm ? "evm:" + key : "cm:" + key;
      const first = await db.set(dupeKey, 1, { nx: true });
      if (first !== "OK") {
        const raw = await db.lrange(KEY, 0, MAX - 1);
        for (let i = 0; i < (raw || []).length; i++) {
          const cur = typeof raw[i] === "string" ? JSON.parse(raw[i]) : raw[i];
          if (!matches(cur)) continue;
          let changed = false;
          for (const k of Object.keys(rec)) {
            if (k === "at" || rec[k] == null) continue;
            /* An admin correction may only touch fields the caller actually
             * SENT. `rec` is a fully-formed record with defaults — name falls
             * back to "Untitled collection" — so without this, fixing one
             * field silently renames the collection. The same bug in
             * api/tokens.js blanked $SOLWAVES's name and ticker. */
            if (admin && !(k in body)) continue;
            if (admin || cur[k] === null || cur[k] === undefined) {
              if (cur[k] !== rec[k]) { cur[k] = rec[k]; changed = true; }
            }
          }
          if (changed) await db.lset(KEY, i, JSON.stringify(cur));
          return res.status(200).json({ ok: true, updated: changed, duplicate: !changed });
        }
        return res.status(200).json({ ok: true, duplicate: true });
      }

      await db.lpush(KEY, JSON.stringify(rec));
      // the cap is a shop window, not a delete — keep what falls off the end
      await archiveOverflow(db, KEY, MAX);
      await db.ltrim(KEY, 0, MAX - 1);
      return res.status(200).json({ ok: true });
    } catch (e) {
      // A launch must never fail because the listing did. The collection is
      // already on chain by the time this runs.
      return res.status(200).json({ ok: false, detail: "not listed" });
    }
  }

  res.setHeader("Allow", "GET, POST");
  return res.status(405).json({ error: "GET or POST" });
}
