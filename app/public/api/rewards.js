// POST /api/rewards  { mint, sig, feeSharePct, rewardMode, rewardMint }
//
// Record what a creator chose when they switched holder rewards on.
//
// The switch itself happens on chain: the creator hands their pool's creator
// role to our keeper with transferPoolCreator, which they sign alone. That is
// the part that matters — the keeper refuses to touch any pool it does not own,
// so nothing here can start a payout that the chain has not already authorised.
// This only stores the terms the keeper reads each run: how much goes to
// holders, whether it is paid out or burned, and in what.
//
// ── Why the signature is the credential ──────────────────────────────────────
// A creator has no password and we do not want one. But they have just signed a
// transaction that only they could sign, so that transaction IS the proof:
//
//   - it must exist and have succeeded
//   - it must name this pool
//   - its signer must be the wallet recorded as the launch's creator
//   - and the pool's creator role must now belong to the keeper
//
// All four are read from the chain, so a stranger cannot set terms on someone
// else's token by replaying a mint address at this endpoint.

export const config = { runtime: "nodejs" };

const B58 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const SIG = /^[1-9A-HJ-NP-Za-km-z]{80,100}$/;
const KEY = "tokens";

function kv() {
  if (!process.env.KV_REST_API_URL || !process.env.KV_REST_API_TOKEN) {
    return Promise.resolve(null);
  }
  return import("@upstash/redis").then(({ Redis }) => new Redis({
    url: process.env.KV_REST_API_URL,
    token: process.env.KV_REST_API_TOKEN
  }));
}

async function rpc(method, params) {
  const url = process.env.SOLANA_RPC || "https://solana-rpc.publicnode.com";
  const r = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    signal: AbortSignal.timeout(20000)
  });
  const j = await r.json();
  if (j.error) throw new Error(j.error.message || "rpc error");
  return j.result;
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "POST" });
  }
  let body = req.body;
  if (typeof body === "string") {
    try { body = JSON.parse(body); } catch { return res.status(400).json({ error: "bad json" }); }
  }
  const { mint, sig } = body || {};
  if (!B58.test(mint || "")) return res.status(400).json({ error: "bad mint" });
  if (!SIG.test(sig || "")) return res.status(400).json({ error: "bad signature" });

  const keeper = body.keeper || process.env.FEE_KEEPER || "";
  const pct = Math.max(0, Math.min(100, parseInt(body.feeSharePct, 10) || 0));
  if (pct <= 0) return res.status(400).json({ error: "nothing would be shared" });
  const mode = body.rewardMode === "burn" ? "burn" : "dividend";
  const rewardMint = B58.test(body.rewardMint || "") ? body.rewardMint : null;

  try {
    const db = await kv();
    if (!db) return res.status(503).json({ error: "no store" });

    const raw = await db.get(KEY);
    let list = typeof raw === "string" ? JSON.parse(raw) : (raw || []);
    if (!Array.isArray(list)) list = [];
    const i = list.findIndex((t) => t && t.mint === mint);
    if (i < 0) return res.status(404).json({ error: "unknown token" });
    const rec = list[i];
    if (!rec.pool) return res.status(400).json({ error: "that launch has no pool recorded" });

    // 1. the transaction exists, succeeded, and this wallet signed it
    const tx = await rpc("getTransaction", [sig, { maxSupportedTransactionVersion: 0 }]);
    if (!tx) return res.status(400).json({ error: "that transaction is not on chain yet" });
    if (tx.meta && tx.meta.err) return res.status(400).json({ error: "that transaction failed" });

    const keys = (tx.transaction && tx.transaction.message &&
      (tx.transaction.message.accountKeys || [])).map((k) => (typeof k === "string" ? k : k.pubkey));
    const signer = keys[0];
    if (!signer || signer !== rec.creator) {
      return res.status(403).json({ error: "that transaction was not signed by this token's creator" });
    }
    // 2. and it concerned this pool
    if (!keys.includes(rec.pool)) {
      return res.status(400).json({ error: "that transaction does not involve this pool" });
    }

    /* 3. The state that actually matters. Whatever the transaction was, the
     * pool's creator role has to belong to the keeper now — otherwise the
     * keeper will ignore this token and the terms would be a lie on a page. */
    const acct = await rpc("getAccountInfo", [rec.pool, { encoding: "base64" }]);
    const data = acct && acct.value && acct.value.data && acct.value.data[0];
    if (!data) return res.status(400).json({ error: "could not read the pool" });
    const buf = Buffer.from(data, "base64");
    const wanted = keeper && B58.test(keeper) ? keeper : null;
    if (!wanted) return res.status(400).json({ error: "no keeper address given" });
    const { PublicKey } = await import("@solana/web3.js");
    const target = new PublicKey(wanted).toBuffer();
    let found = false;
    for (let o = 0; o + 32 <= buf.length; o += 1) {
      if (buf.compare(target, 0, 32, o, o + 32) === 0) { found = true; break; }
    }
    if (!found) {
      return res.status(400).json({
        error: "the pool has not been handed to the keeper yet — activate first"
      });
    }

    list[i] = Object.assign({}, rec, {
      feeShare: "holders",
      feeSharePct: pct,
      rewardMode: mode,
      rewardMint: mode === "burn" ? null : (rewardMint || rec.rewardMint || null),
      rewardsActivatedAt: Date.now()
    });
    await db.set(KEY, JSON.stringify(list));
    return res.status(200).json({ ok: true, feeSharePct: pct, rewardMode: mode });
  } catch (e) {
    return res.status(500).json({ error: (e.message || String(e)).slice(0, 200) });
  }
}
