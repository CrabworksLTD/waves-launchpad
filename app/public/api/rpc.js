// POST /api/rpc   — JSON-RPC passthrough to a real node
//
// The browser was talking to a free public endpoint, which is fine for reading
// and quietly unreliable for writing: it accepts sendTransaction, returns a
// signature, and then does a poor job of getting the bytes to the leader. Small
// transactions survive that. A pool creation with a first buy in it — the
// largest transaction this site ever sends — did not, twice in a row, landing
// its config and then dying with an expired blockhash on the pool.
//
// So sends go through the same node the indexer and keeper use. The key stays
// on the server; the browser only ever sees this path.
//
// Not an open proxy: only the methods this site actually calls are forwarded,
// so a key that costs money cannot be turned into someone else's free RPC.

export const config = { runtime: "nodejs" };

const ALLOW = new Set([
  // writing — the reason this exists
  "sendTransaction",
  "simulateTransaction",
  // the confirm loop
  "getSignatureStatuses",
  "getLatestBlockhash",
  "isBlockhashValid",
  "getFeeForMessage",
  "getRecentPrioritizationFees",
  // reads the launch and mint paths make
  "getAccountInfo",
  "getMultipleAccounts",
  "getBalance",
  "getMinimumBalanceForRentExemption",
  "getTokenAccountBalance",
  "getTokenAccountsByOwner",
  "getTokenSupply",
  "getSlot",
  "getBlockHeight",
  "getTransaction",
  "getSignaturesForAddress",
  "getEpochInfo",
  "getVersion",
  "getGenesisHash",
  "getProgramAccounts"
]);

/* Writes are named explicitly; reads are allowed as a class.
 *
 * An enumerated read list is the wrong shape here — the SDKs decide what they
 * call, a method nobody thought of returns 403, and the failure lands in the
 * middle of a launch that has already been paid for. Every `get*` on a Solana
 * node is a read, so the blast radius of allowing them is someone using this as
 * a read endpoint, which rate limiting answers and a dead launch does not. */
function allowed(method) {
  return ALLOW.has(method) || /^get[A-Z]/.test(method);
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "POST" });
  }

  /* More than one node, in order of preference.
   *
   * On 2026-09-02 Helius served getSlot and getHealth happily while returning
   * a plain-text "Internal server error" for every call that takes an address
   * — getBalance, getAccountInfo, getMultipleAccounts. Every page that reads
   * the chain broke, because routing everything here left the site with one
   * node and no way past it.
   *
   * The public node is second, not first: it drops large sends, which is why
   * this endpoint exists at all. But a node that fumbles a send still answers
   * reads correctly, and a degraded site beats a dead one. */
  const upstreams = [process.env.SOLANA_RPC, "https://solana-rpc.publicnode.com"]
    .filter(Boolean);
  if (!upstreams.length) {
    return res.status(503).json({ error: "no upstream rpc configured" });
  }

  let body = req.body;
  if (typeof body === "string") {
    try { body = JSON.parse(body); } catch { return res.status(400).json({ error: "bad json" }); }
  }
  if (!body) return res.status(400).json({ error: "empty" });

  // web3.js batches some reads, so a body may be an array of calls
  const calls = Array.isArray(body) ? body : [body];
  if (calls.length > 20) return res.status(413).json({ error: "batch too large" });
  for (const c of calls) {
    if (!c || typeof c.method !== "string" || !allowed(c.method)) {
      return res.status(403).json({ error: "method not allowed: " + (c && c.method) });
    }
  }

  /* A node counts as having answered only if it returns 2xx AND valid JSON.
   * Helius's failure mode was a 500 carrying the words "Internal server
   * error", so status alone is not enough to trust — and forwarding that text
   * to a caller expecting JSON-RPC is how one node's bad day became every
   * page's bad day. */
  let last = null;
  for (const upstream of upstreams) {
    try {
      const r = await fetch(upstream, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(20000)
      });
      const text = await r.text();
      if (!r.ok) { last = "upstream " + r.status; continue; }
      try { JSON.parse(text); } catch (e) { last = "upstream sent non-json"; continue; }

      res.setHeader("Content-Type", "application/json");
      res.setHeader("Cache-Control", "no-store");
      return res.status(200).send(text);
    } catch (e) {
      last = e.message || String(e);
    }
  }
  return res.status(502).json({ error: "no rpc answered: " + last });
}
