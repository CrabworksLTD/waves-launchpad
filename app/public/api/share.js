// GET /api/share?id=<address>&to=mint|token
//
// The landing crawlers get when a WAVES mint/token link is shared (vercel.json
// routes bot UAs here). It carries the subject-specific OG card (/api/og) so
// the unfurl shows the collection or token rather than a generic card, then
// bounces a human straight to the real page.
//
// No <meta refresh>: Telegram follows those to the destination and reads its
// generic tags instead of this card. Humans bounce via script with ?hp=1 —
// the vercel.json rules carry a `missing: hp` guard so a webview whose UA
// says "bot" doesn't loop.

export const config = { runtime: "edge" };

const B58 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

async function evmName(c) {
  try {
    const r = await fetch("https://rpc.mainnet.chain.robinhood.com", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_call",
        params: [{ to: c, data: "0x06fdde03" }, "latest"] }),
      signal: AbortSignal.timeout(2500)
    }).then((x) => x.json());
    const hex = r && r.result;
    if (!hex || hex === "0x") return "";
    const h = hex.replace(/^0x/, "");
    const len = parseInt(h.slice(64, 128), 16);
    const bytes = h.slice(128, 128 + len * 2);
    let s = "";
    for (let i = 0; i < bytes.length; i += 2) s += String.fromCharCode(parseInt(bytes.slice(i, i + 2), 16));
    return decodeURIComponent(escape(s));
  } catch (e) { return ""; }
}

async function recordName(origin, id, to) {
  try {
    const kind = to === "token" ? "tokens" : "collections";
    const j = await fetch(origin + "/api/" + kind, { signal: AbortSignal.timeout(2500) })
      .then((r) => r.json());
    const list = (to === "token" ? j.tokens : j.collections) || [];
    const rec = list.find((r) => (to === "token" ? r.mint : r.candyMachine) === id);
    if (!rec) return "";
    return to === "token"
      ? ("$" + (rec.symbol || "").toUpperCase() + (rec.name ? " · " + rec.name : ""))
      : (rec.name || "");
  } catch (e) { return ""; }
}

function esc(s) {
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

export default async function handler(req) {
  const url = new URL(req.url);
  const id = url.searchParams.get("id") || "";
  const to = url.searchParams.get("to") === "token" ? "token" : "mint";
  const isEvm = /^0x[0-9a-fA-F]{40}$/.test(id);

  if (!isEvm && !B58.test(id)) return Response.redirect(url.origin + "/", 302);

  const name = (isEvm ? await evmName(id) : await recordName(url.origin, id, to)) ||
    (to === "token" ? "Token" : "Collection");
  const dest = "/" + (to === "token" ? "token" : "mint") + "/" + id;
  const card = url.origin + "/api/og?id=" + id + "&to=" + to;
  const title = esc(name) + " — WAVES";
  const desc = "Cross-chain token and NFT launchpad";
  const human = dest + "?hp=1";

  const html = '<!doctype html><html lang="en"><head><meta charset="utf-8">' +
    '<title>' + title + '</title>' +
    '<meta name="description" content="' + desc + '">' +
    '<meta property="og:type" content="website">' +
    '<meta property="og:site_name" content="WAVES">' +
    '<meta property="og:title" content="' + title + '">' +
    '<meta property="og:description" content="' + desc + '">' +
    '<meta property="og:url" content="' + url.origin + esc(dest) + '">' +
    '<meta property="og:image" content="' + card + '">' +
    '<meta property="og:image:width" content="1200">' +
    '<meta property="og:image:height" content="630">' +
    '<meta name="twitter:card" content="summary_large_image">' +
    '<meta name="twitter:title" content="' + title + '">' +
    '<meta name="twitter:description" content="' + desc + '">' +
    '<meta name="twitter:image" content="' + card + '">' +
    '<link rel="canonical" href="' + url.origin + esc(dest) + '">' +
    '<script>location.replace(' + JSON.stringify(human) + ')</script>' +
    '</head><body style="background:#0a0a0a;color:#14F195;font-family:ui-monospace,monospace;padding:40px">' +
    'Opening ' + esc(name) + '&hellip; <a style="color:#14F195" href="' + esc(human) + '">continue</a>' +
    '</body></html>';

  return new Response(html, {
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "public, s-maxage=600, stale-while-revalidate=86400"
    }
  });
}
