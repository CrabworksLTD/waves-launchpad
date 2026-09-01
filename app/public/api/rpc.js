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

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "POST" });
  }

  const upstream = process.env.SOLANA_RPC;
  if (!upstream) {
    /* Say so rather than failing obscurely — without this the site silently
     * falls back to the endpoint that caused the problem. */
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
    if (!c || typeof c.method !== "string" || !ALLOW.has(c.method)) {
      return res.status(403).json({ error: "method not allowed: " + (c && c.method) });
    }
  }

  try {
    const r = await fetch(upstream, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(30000)
    });
    const text = await r.text();
    res.setHeader("Content-Type", "application/json");
    res.setHeader("Cache-Control", "no-store");
    return res.status(r.status).send(text);
  } catch (e) {
    return res.status(502).json({ error: "upstream: " + (e.message || String(e)) });
  }
}
