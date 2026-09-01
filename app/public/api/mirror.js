// POST /api/mirror   { url, dataUrl }        store a copy
// GET  /api/mirror?u=<arweave url>           the image, or a redirect to Arweave
//
// A short-lived copy of a launch's art, so a token does not look broken for the
// minutes between paying for permanent storage and permanent storage being able
// to serve it.
//
// Arweave stays the source of truth: it is what the on-chain metadata points
// at, it is what outlives us, and both launch flows already wait for it to
// resolve before going on chain. This only fills the gap for OUR pages and
// cards, which a creator shares within seconds of launching.
//
// Keyed by the Arweave URL, not the mint — a token's mint does not exist yet
// when its art is uploaded, and a collection has no single address either. The
// URL is known at upload time and known again by every page that wants to show
// the image, which is exactly the property needed.
//
// Deliberately expiring. Two days is far longer than propagation has ever taken
// and short enough that this never becomes a storage product we have to run:
// once it lapses the redirect below sends everyone to Arweave, which by then
// has had two days to catch up.

export const config = { runtime: "nodejs" };

const TTL = 60 * 60 * 48;                    // two days
const MAX_BYTES = 900 * 1024;                // a launch icon runs ~400KB
/* Both the addresses a launch's art can be published at: arweave.net directly
 * (collections) and our own /m/ path (tokens, since api/meta.js). Either way
 * the key is the transaction id and the file name, so a mirror written under
 * one is found under the other. */
const ARWEAVE = /^https:\/\/(?:arweave\.net|[\w.-]+\/m)\/([\w-]{43})\/([\w.-]{1,40})$/;

function kv() {
  if (!process.env.KV_REST_API_URL || !process.env.KV_REST_API_TOKEN) {
    return Promise.resolve(null);
  }
  return import("@upstash/redis").then(({ Redis }) => new Redis({
    url: process.env.KV_REST_API_URL,
    token: process.env.KV_REST_API_TOKEN
  }));
}

// only ever a well-formed arweave path, so this cannot be pointed anywhere else
function keyOf(url) {
  const m = ARWEAVE.exec(String(url || ""));
  return m ? "mir:" + m[1] + ":" + m[2] : null;
}

export default async function handler(req, res) {
  if (req.method === "GET") {
    const url = (req.query && req.query.u) || "";
    const key = keyOf(url);
    if (!key) return res.status(400).json({ error: "bad url" });
    try {
      const db = await kv();
      const hit = db ? await db.get(key) : null;
      if (!hit) {
        /* No mirror: send them to the permanent copy. That is the right answer
         * both before we ever stored one and after it expires, and it means a
         * page can use this endpoint unconditionally without knowing which. */
        res.setHeader("Cache-Control", "public, max-age=30");
        return res.redirect(302, url);
      }
      const buf = Buffer.from(String(hit), "base64");
      res.setHeader("Content-Type", url.endsWith(".jpg") || url.endsWith(".jpeg")
        ? "image/jpeg" : "image/png");
      // the bytes at a given arweave path never change
      res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
      return res.status(200).send(buf);
    } catch (e) {
      return res.redirect(302, url);
    }
  }

  if (req.method === "POST") {
    const body = typeof req.body === "string" ? JSON.parse(req.body || "{}") : (req.body || {});
    const key = keyOf(body.url);
    if (!key) return res.status(400).json({ error: "bad url" });
    const dataUrl = body.dataUrl;
    /* json as well as images: the metadata file is the one an aggregator reads
     * first, and it was the one thing this did not keep. */
    if (typeof dataUrl !== "string" ||
        !/^data:(image\/(png|jpeg)|application\/json);base64,/.test(dataUrl)) {
      return res.status(400).json({ error: "expected a png, jpeg or json data url" });
    }
    const b64 = dataUrl.slice(dataUrl.indexOf(",") + 1);
    if (b64.length * 0.75 > MAX_BYTES) return res.status(413).json({ error: "too large" });

    try {
      const db = await kv();
      if (!db) return res.status(200).json({ ok: false, detail: "no store" });
      /* First writer wins. A launch has no secret to present — gating this
       * would mean shipping one to the browser — so the guards are: the key
       * must be a real Arweave path, the payload must be a small image, and an
       * existing entry cannot be overwritten. The worst a stranger can do is
       * seed a copy of an id nobody has uploaded yet, which expires in two days
       * and which Arweave then overrides anyway. */
      await db.set(key, b64, { nx: true, ex: TTL });
      return res.status(200).json({ ok: true });
    } catch (e) {
      // mirroring is a nicety; a launch must never fail because of it
      return res.status(200).json({ ok: false });
    }
  }

  res.setHeader("Allow", "GET, POST");
  return res.status(405).json({ error: "GET or POST" });
}
