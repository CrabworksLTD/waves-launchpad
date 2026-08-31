// POST /api/purge   Authorization: Bearer $CRON_SECRET
//
// Remove launches from the listings. Written for one specific moment — wiping
// the test launches before going live — because doing it by hand means three
// different key shapes in Upstash and a good chance of leaving half of one
// behind:
//
//   collections / tokens          the lists the explore pages read
//   col:<addr> / tok:<mint>       the dedupe keys that stop a re-record
//   ix:<mint>:{stats,trades,cursor}   whatever the indexer built
//   keeperplan:<mint>             an unfinished payout, if any
//
// Miss the dedupe key and the address can never be listed again. Miss the
// indexer keys and a future token at the same address inherits a stranger's
// price history.
//
// ── Safety ───────────────────────────────────────────────────────────────────
// Deleting is the one thing here that cannot be undone, so:
//
//   - CRON_SECRET is required, like the keeper.
//   - Nothing happens without an explicit target. `{"all": true}` wipes both
//     listings; otherwise pass the exact addresses.
//   - `{"dry": true}` reports what WOULD go, touching nothing. Run it first.
//   - A purge REFUSES to run if any named token has an unfinished payout plan,
//     because that plan is the only record of money already claimed out of a
//     pool and not yet handed to holders. Deleting it strands the funds.
//
// Example:
//   curl -X POST https://…/api/purge -H "Authorization: Bearer $CRON_SECRET" \
//        -H 'content-type: application/json' -d '{"all":true,"dry":true}'

export const config = { runtime: "nodejs" };

function kv() {
  if (!process.env.KV_REST_API_URL || !process.env.KV_REST_API_TOKEN) {
    return Promise.resolve(null);
  }
  return import("@upstash/redis").then(({ Redis }) => new Redis({
    url: process.env.KV_REST_API_URL,
    token: process.env.KV_REST_API_TOKEN
  }));
}

const MAX = 200;

async function readList(db, key) {
  const raw = await db.lrange(key, 0, MAX - 1).catch(() => []);
  return (raw || []).map((r) => {
    if (typeof r !== "string") return r;
    try { return JSON.parse(r); } catch { return null; }
  }).filter(Boolean);
}

export default async function handler(req, res) {
  const secret = process.env.CRON_SECRET;
  if (!secret) return res.status(500).json({ error: "CRON_SECRET is not set" });
  if ((req.headers.authorization || "") !== "Bearer " + secret) {
    return res.status(401).json({ error: "no" });
  }
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "POST" });
  }

  const body = typeof req.body === "string" ? JSON.parse(req.body || "{}") : (req.body || {});
  const all = body.all === true;
  const dry = body.dry === true;
  const wantCols = Array.isArray(body.collections) ? body.collections : [];
  const wantToks = Array.isArray(body.tokens) ? body.tokens : [];

  if (!all && !wantCols.length && !wantToks.length) {
    return res.status(400).json({
      error: "nothing targeted — pass {all:true} or explicit collections/tokens arrays"
    });
  }

  try {
    const db = await kv();
    if (!db) return res.status(500).json({ error: "no KV configured" });

    const cols = await readList(db, "collections");
    const toks = await readList(db, "tokens");

    const idOf = (c) => c.candyMachine || c.address || "";
    const killCols = all ? cols : cols.filter((c) => wantCols.includes(idOf(c)));
    const killToks = all ? toks : toks.filter((t) => wantToks.includes(t.mint));

    /* An unfinished payout plan means the keeper has already taken fees out of
     * a pool and has not finished handing them to holders. That plan is the
     * only thing that knows about it. */
    const blocked = [];
    for (const t of killToks) {
      const plan = await db.get("keeperplan:" + t.mint).catch(() => null);
      if (plan) blocked.push(t.mint);
    }
    if (blocked.length) {
      return res.status(409).json({
        error: "refusing: these tokens have an unfinished payout plan. Run " +
               "/api/keeper first so holders are paid, then purge.",
        blocked
      });
    }

    const plan = {
      collections: killCols.map((c) => ({ name: c.name, id: idOf(c) })),
      tokens: killToks.map((t) => ({ symbol: t.symbol, mint: t.mint })),
      alsoDeletes: [
        ...killCols.map((c) => "col:" + idOf(c)),
        ...killToks.flatMap((t) => [
          "tok:" + t.mint,
          "ix:" + t.mint + ":stats",
          "ix:" + t.mint + ":trades",
          "ix:" + t.mint + ":cursor"
        ])
      ]
    };

    if (dry) return res.status(200).json({ ok: true, dry: true, wouldRemove: plan });

    /* Rewrite each list rather than deleting entries in place: a Redis list has
     * no delete-by-value, and LSET-ing tombstones then trimming is a good way
     * to lose a neighbouring record. Survivors are rewritten oldest-last so the
     * newest-first order the explore pages expect is preserved. */
    const keepCols = cols.filter((c) => !killCols.includes(c));
    const keepToks = toks.filter((t) => !killToks.includes(t));

    await db.del("collections");
    if (keepCols.length) {
      await db.rpush("collections", ...keepCols.map((c) => JSON.stringify(c)));
    }
    await db.del("tokens");
    if (keepToks.length) {
      await db.rpush("tokens", ...keepToks.map((t) => JSON.stringify(t)));
    }
    for (const k of plan.alsoDeletes) await db.del(k).catch(() => {});

    return res.status(200).json({
      ok: true,
      removed: { collections: plan.collections.length, tokens: plan.tokens.length },
      remaining: { collections: keepCols.length, tokens: keepToks.length },
      detail: plan
    });
  } catch (e) {
    return res.status(500).json({ error: String((e && e.message) || e).slice(0, 300) });
  }
}
