// Is this URL art we published?
//
// One rule, one file, because having it in four was the bug.
//
// Token art moved from arweave.net to our own /m/ path (api/meta.js) so that a
// brand-new launch is not fetched by an aggregator before the canonical gateway
// has indexed it. Four separate copies of "is this an arweave.net URL?" were
// spread across the api directory, and each one silently started rejecting the
// new shape:
//
//   api/tokens.js       recorded icon: null, so tokens had no picture on our
//                       own site while every aggregator showed them fine
//   api/og.js           fell back to the brand card, so every share, tweet and
//                       Telegram unfurl showed the generic WAVES image
//   api/collections.js  the same, waiting to happen to collections
//
// Nothing threw. Each place did exactly what it was told, and the launch looked
// fine everywhere except the places that mattered. Adding a fifth regex would
// have fixed today's symptom and left the next one.
//
// The guard itself matters: these URLs are rendered on our pages and served to
// X and Telegram as our content, so they must never be an arbitrary address
// somebody POSTed at us.

const ARWEAVE = /^https:\/\/arweave\.net\/[\w\-/.]+$/;
const OUR_PATH = /^\/m\/[\w-]{43}\/[\w.-]{1,40}$/;

/* `host` is the host that received the request — req.headers.host. Passing it
 * rather than hardcoding a domain keeps preview deployments and the Robinhood
 * skin working, and means this can never be pointed at another site. */
export function okArt(u, host) {
  if (typeof u !== "string" || !u) return null;
  if (ARWEAVE.test(u)) return u;
  if (!host) return null;
  try {
    const parsed = new URL(u);
    if (parsed.protocol !== "https:") return null;
    const bare = (h) => String(h || "").toLowerCase().split(":")[0].replace(/^www\./, "");
    if (bare(parsed.hostname) !== bare(host)) return null;
    if (!OUR_PATH.test(parsed.pathname)) return null;
    if (parsed.search || parsed.hash) return null;
    return u;
  } catch (e) {
    return null;
  }
}

/* Is it already served by us? Then it needs no mirror wrapper — /m/ does its
 * own gateway fallback. Only an arweave.net URL benefits from being proxied. */
export function isOurPath(u, host) {
  if (typeof u !== "string" || !host) return false;
  try {
    const parsed = new URL(u);
    const bare = (h) => String(h || "").toLowerCase().split(":")[0].replace(/^www\./, "");
    return bare(parsed.hostname) === bare(host) && OUR_PATH.test(parsed.pathname);
  } catch (e) {
    return false;
  }
}
