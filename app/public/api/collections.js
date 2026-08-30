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

export default async function handler(req, res) {
  if (req.method === "GET") {
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
    const body = typeof req.body === "string" ? JSON.parse(req.body || "{}") : (req.body || {});
    const { candyMachine, collection, name, cluster } = body;

    if (!B58.test(candyMachine || "")) return res.status(400).json({ error: "bad candyMachine" });
    if (!B58.test(collection || "")) return res.status(400).json({ error: "bad collection" });
    // Mainnet only. A devnet test collection on the homepage is a bug that
    // looks like a scam.
    if (cluster && cluster !== "mainnet-beta") return res.status(200).json({ ok: true, skipped: "not mainnet" });

    try {
      const db = await kv();
      // Idempotent: relaunching the same machine must not double-list it.
      const first = await db.set("cm:" + candyMachine, 1, { nx: true });
      if (first !== "OK") return res.status(200).json({ ok: true, duplicate: true });

      await db.lpush(KEY, JSON.stringify({
        candyMachine,
        collection,
        name: String(name || "Untitled").slice(0, 40),
        at: Date.now()
      }));
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
