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

const KEY = "tokens";
const MAX = 200;

function kv() {
  return import("@upstash/redis").then(({ Redis }) => new Redis({
    url: process.env.KV_REST_API_URL,
    token: process.env.KV_REST_API_TOKEN
  }));
}

const B58 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

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
    const body = typeof req.body === "string" ? JSON.parse(req.body || "{}") : (req.body || {});
    const { mint, name, symbol, cluster, rewardMint, collection, creator, icon, banner, pool, config, feeShare, feeSharePct } = body;

    if (!B58.test(mint || "")) return res.status(400).json({ error: "bad mint" });
    // both optional; validated when present so a bad value is dropped loudly
    if (rewardMint && !B58.test(rewardMint)) return res.status(400).json({ error: "bad rewardMint" });
    if (collection && !B58.test(collection)) return res.status(400).json({ error: "bad collection" });
    // Mainnet only — a devnet token on the homepage is a bug dressed as a scam.
    if (cluster && cluster !== "mainnet-beta") return res.status(200).json({ ok: true, skipped: "not mainnet" });

    try {
      const db = await kv();
      const okArt = (u) => (typeof u === "string" &&
        /^https:\/\/arweave\.net\/[\w\-\/\.]+$/.test(u)) ? u : null;
      const rec = {
        mint,
        name: String(name || "Untitled").slice(0, 40),
        symbol: String(symbol || "").slice(0, 12),
        // the reward asset the creator picked, and the collection this token
        // is paired with — consumed by the staking keeper later, displayed now
        rewardMint: rewardMint || null,
        // only arweave art, never an arbitrary URL someone POSTs at us
        card: (typeof body.card === "string" && /^https:\/\/arweave\.net\/[\w\-\/\.]+$/.test(body.card)) ? body.card : null,
        icon: okArt(icon), banner: okArt(banner),
        pool: (pool && B58.test(pool)) ? pool : null,
        feeShare: feeShare === "holders" ? "holders" : "keep",
        feeSharePct: Math.max(0, Math.min(100, parseInt(feeSharePct, 10) || 0)),
        config: (config && B58.test(config)) ? config : null,
        collection: collection || null,
        creator: (creator && B58.test(creator)) ? creator : null,
        at: Date.now()
      };
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
