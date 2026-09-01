// GET /m/<arweave-id>/<file>   (rewritten to /api/meta?id=…&file=…)
//
// The address a token's metadata is published at, forever.
//
// It used to be arweave.net directly, and that cost $MOAR its picture. Turbo
// accepts an upload instantly, but arweave.net did not know the transaction
// existed 45 minutes later — not "hadn't served it", its index returned nothing
// at all. Aggregators fetch a token's URI once, when they first see the pool,
// and cache what they get. GMGN got a 404 and that was that: no image and no
// website link, permanently, because token metadata is immutable and the URI
// cannot be repointed.
//
// So the URI names us, and we answer from wherever the data actually is. The
// bytes still live on Arweave and are still permanent — this only fixes WHICH
// door callers knock on during the window where arweave.net has not caught up.
// Once it has, it is the first door tried, and this becomes a pass-through.
//
// The trade is deliberate and was chosen explicitly: a token whose URL depends
// on this domain, against a token that shows nothing on every aggregator that
// looked too early. The second was happening.

export const config = { runtime: "nodejs" };

/* arweave.net first, so the canonical gateway is used the moment it works.
 * The rest are ar.io gateways that serve straight from the Turbo cache, which
 * is what makes a launch visible in the first minutes rather than the first
 * hour. */
const GATEWAYS = [
  "https://arweave.net",
  "https://ar-io.dev",
  "https://permagate.io",
  "https://vilenarios.com"
];

const ID = /^[\w-]{43}$/;
const FILE = /^[\w.-]{1,64}$/;

const TYPES = {
  json: "application/json",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  svg: "image/svg+xml"
};

function kv() {
  if (!process.env.KV_REST_API_URL || !process.env.KV_REST_API_TOKEN) {
    return Promise.resolve(null);
  }
  return import("@upstash/redis").then(({ Redis }) => new Redis({
    url: process.env.KV_REST_API_URL,
    token: process.env.KV_REST_API_TOKEN
  }));
}

export default async function handler(req, res) {
  const id = String((req.query && req.query.id) || "");
  const file = String((req.query && req.query.file) || "");
  if (!ID.test(id) || !FILE.test(file) || file.includes("..")) {
    return res.status(400).json({ error: "bad path" });
  }

  const ext = (file.split(".").pop() || "").toLowerCase();
  const type = TYPES[ext] || "application/octet-stream";

  for (const gw of GATEWAYS) {
    try {
      const r = await fetch(gw + "/" + id + "/" + file, {
        signal: AbortSignal.timeout(8000),
        redirect: "follow"
      });
      if (!r.ok) continue;
      /* A gateway that does not have the data answers 200 with its own "not
       * found" HTML, so trust the content type as well as the status — serving
       * that page as a token's metadata is how a 404 becomes a corrupt token
       * rather than a missing one. */
      const got = (r.headers.get("content-type") || "").toLowerCase();
      if (ext === "json" && !got.includes("json")) continue;
      if (type.startsWith("image/") && !got.startsWith("image/")) continue;

      const buf = Buffer.from(await r.arrayBuffer());
      if (!buf.length) continue;

      res.setHeader("Content-Type", type);
      // the bytes at an arweave path never change
      res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
      res.setHeader("Access-Control-Allow-Origin", "*");
      return res.status(200).send(buf);
    } catch (e) { /* try the next gateway */ }
  }

  /* Nothing served it. The browser mirrors a launch's art at upload time, so
   * this covers the minutes before ANY gateway has the bundle — the gap that
   * made a brand-new token look broken on the page that just created it. */
  try {
    const db = await kv();
    const hit = db ? await db.get("mir:" + id + ":" + file) : null;
    if (hit) {
      res.setHeader("Content-Type", type);
      res.setHeader("Cache-Control", "public, max-age=300");
      res.setHeader("Access-Control-Allow-Origin", "*");
      return res.status(200).send(Buffer.from(String(hit), "base64"));
    }
  } catch (e) { /* fall through */ }

  /* Short cache on a miss, so a caller that arrives during the gap is not told
   * "gone" for a year by its own cache. */
  res.setHeader("Cache-Control", "public, max-age=30");
  return res.status(404).json({ error: "not available yet" });
}
