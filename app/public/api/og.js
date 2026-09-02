// GET /api/og?id=<address>&to=mint|token — resolves to the share-card PNG.
//
// No renderer. @vercel/og is broken under Vercel's current function builder
// (its dist dies with 'Dynamic require of "fs"' however it's bundled — the
// donor's production cards are down with the identical crash), so cards are
// composed in the browser at launch time, uploaded to Arweave with the
// collection, and recorded. This function just 302s to the right image:
// the launch's own card when one was recorded, the chain's brand card
// otherwise. A redirect is something no builder can break.

import { okArt, isOurPath } from "./_art.js";
import { allow, tooMany } from "./_guard.js";

export default async function handler(req, res) {
  /* A share card is fetched by a crawler once and by a person rarely; a
   * flood is a scraper. Cheap since it became a redirect, but not free. */
  if (!(await allow(req, { bucket: "og", max: 30, windowSec: 60 }))) return tooMany(res, 60);

  const id = String(req.query.id || "");
  const to = req.query.to === "token" ? "token" : "mint";
  const isEvm = /^0x[0-9a-fA-F]{40}$/.test(id);
  const proto = req.headers["x-forwarded-proto"] || "https";
  const origin = proto + "://" + (req.headers["x-forwarded-host"] || req.headers.host);

  let card = null;
  try {
    const kind = to === "token" ? "tokens" : "collections";
    const j = await fetch(origin + "/api/" + kind).then((r) => r.json());
    const list = (to === "token" ? j.tokens : j.collections) || [];
    const rec = list.find((r) =>
      (to === "token" ? r.mint === id
        : (r.candyMachine === id || (r.address || "").toLowerCase() === id.toLowerCase())));
    if (rec) card = okArt(rec.card, req.headers.host);
  } catch (e) {}

  /* Through the mirror, not straight at Arweave.
   *
   * A share card is fetched by X, Telegram and Discord within seconds of a
   * launch — before arweave.net can serve a fresh upload — and those platforms
   * cache the unfurl they get. /api/mirror serves our short-lived copy when it
   * has one and redirects to Arweave when it does not, so the card is right
   * from the first share instead of after propagation. */
  /* Our own /m/ path already falls back across gateways, so wrapping it in the
   * mirror would be a second hop to reach the same bytes. Only arweave.net
   * URLs — collections, and launches from before /m/ existed — need proxying. */
  if (card && isOurPath(card, req.headers.host)) { /* serve it directly */ }
  else if (card) card = origin + "/api/mirror?u=" + encodeURIComponent(card);
  else card = origin + (isEvm ? "/art/og-rh.png" : "/art/og.png");
  res.setHeader("cache-control", "public, s-maxage=300, stale-while-revalidate=3600");
  res.redirect(302, card);
}
