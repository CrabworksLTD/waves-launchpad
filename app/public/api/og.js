// GET /api/og?id=<address>&to=mint|token — resolves to the share-card PNG.
//
// No renderer. @vercel/og is broken under Vercel's current function builder
// (its dist dies with 'Dynamic require of "fs"' however it's bundled — the
// donor's production cards are down with the identical crash), so cards are
// composed in the browser at launch time, uploaded to Arweave with the
// collection, and recorded. This function just 302s to the right image:
// the launch's own card when one was recorded, the chain's brand card
// otherwise. A redirect is something no builder can break.

const ARWEAVE = /^https:\/\/arweave\.net\/[\w\-/.]+$/;

export default async function handler(req, res) {
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
    if (rec && typeof rec.card === "string" && ARWEAVE.test(rec.card)) card = rec.card;
  } catch (e) {}

  if (!card) card = origin + (isEvm ? "/art/og-rh.png" : "/art/og.png");
  res.setHeader("cache-control", "public, s-maxage=300, stale-while-revalidate=3600");
  res.redirect(302, card);
}
