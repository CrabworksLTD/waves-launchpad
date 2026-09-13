// Shared protection for the public endpoints: rate limiting, and proof that a
// thing being listed actually exists on chain.
//
// Both exist for the same reason. Every public write here was open, validated
// only for SHAPE — "is this 32-44 base58 characters" — and a shape check cannot
// tell a launch from a string. The listing is capped and trimmed, so two
// hundred well-formed strings pushed every real launch off the homepage, for
// good, in about a second. Nothing was stolen and nothing could be recovered.
//
// So: a listing must name a mint that exists and a pool the bonding curve owns,
// and no single caller may do very much per minute.

const SPL_TOKEN  = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const TOKEN_2022 = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";
const DBC        = "dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN";
// Raydium LaunchLab (mainnet + devnet) — the second launch backend. A pool
// owned by either program is a real bonding curve.
const LAUNCHLAB     = "LanMV9sAd7wArD4vJFi2qDdfnVhFxYSUg6eADduJ3uj";
const DEV_LAUNCHLAB = "DRay6fNdQ5J82H7xV6uq2aV3mNrUZ1J4PgSKsWgptcm6";
const CURVE_PROGRAMS = [DBC, LAUNCHLAB, DEV_LAUNCHLAB];

export function kv() {
  return import("@upstash/redis").then(({ Redis }) => new Redis({
    url: process.env.KV_REST_API_URL,
    token: process.env.KV_REST_API_TOKEN
  }));
}

/* Vercel sits behind a proxy, so the socket address is Vercel's. x-forwarded-for
 * is a list and the LEFT-most entry is the client's claim about itself, which a
 * caller can set to anything; the right-most is the one our own proxy appended.
 * Taking the left would let one attacker look like a thousand. */
export function clientIp(req) {
  /* Two request shapes live here: the Node functions get a plain headers
   * object, the edge ones get a Headers instance whose values only come out
   * through .get(). Reading the wrong one silently yields undefined, which
   * buckets every caller together under "unknown" — a rate limiter that is
   * really a global one, and a single user could then lock out the world. */
  const h = (name) =>
    (typeof req.headers?.get === "function" ? req.headers.get(name) : req.headers?.[name]) || "";

  const xff = h("x-forwarded-for");
  if (typeof xff === "string" && xff.length) {
    const parts = xff.split(",").map((s) => s.trim()).filter(Boolean);
    if (parts.length) return parts[parts.length - 1];
  }
  return h("x-real-ip") || req.socket?.remoteAddress || "unknown";
}

/**
 * A fixed-window counter in Redis. Returns true if the call may proceed.
 *
 * Deliberately fails OPEN: if the store is unreachable the site keeps working
 * and loses its rate limiting, rather than refusing everyone. The thing being
 * defended is cost and spam, and an outage that takes the whole site down to
 * protect it from spam has done the attacker's job.
 */
export async function allow(req, { bucket, max, windowSec, cost = 1 }) {
  try {
    const db = await kv();
    const key = "rl:" + bucket + ":" + clientIp(req) + ":" + Math.floor(Date.now() / (windowSec * 1000));
    /* `cost` because a JSON-RPC batch is one HTTP request carrying up to twenty
     * calls, and it is the calls that get billed. Counting requests would price
     * a batch the same as a single read and leave a twentyfold hole. */
    /* One round trip, and the expiry is NOT conditional.
     *
     * It used to be set only when the counter came back equal to the cost —
     * i.e. on what looked like the first call of the window. Two things wrong
     * with that: concurrent first calls can both miss the test, and an INCRBY
     * that lands while the EXPIRE fails leaves a key with no TTL at all. The
     * key carries its own window index so a stranded one is never read again,
     * but it is also never collected, and a rate limiter that slowly fills the
     * store is its own denial of service. */
    const [n] = await db.pipeline().incrby(key, cost).expire(key, windowSec).exec();
    return Number(n) <= max;
  } catch {
    return true;
  }
}

/** Send the 429 for a caller `allow` turned down. */
export function tooMany(res, retryAfter) {
  res.setHeader("Retry-After", String(retryAfter || 60));
  return res.status(429).json({ error: "slow down" });
}

/** The same refusal, for the edge functions, which return a Response. */
export function tooManyResponse(retryAfter) {
  return new Response(JSON.stringify({ error: "slow down" }), {
    status: 429,
    headers: { "content-type": "application/json", "Retry-After": String(retryAfter || 60) }
  });
}

async function rpc(method, params) {
  const url = process.env.SOLANA_RPC || "https://solana-rpc.publicnode.com";
  const r = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    signal: AbortSignal.timeout(10000)
  });
  if (!r.ok) throw new Error("rpc " + r.status);
  const j = await r.json();
  if (j.error) throw new Error(j.error.message || "rpc error");
  return j.result;
}

/**
 * Is this a real token, launched on a real bonding curve?
 *
 * One getMultipleAccounts, checking only who OWNS each account — no layout
 * parsing, so nothing here breaks when Meteora changes a struct. The mint must
 * belong to a token program and the pool to the bonding curve program.
 *
 * That does not prove the pool is THIS mint's pool; binding them needs the
 * account layout. It does not need to. The whole attack was that fabricating a
 * listing was free, and this makes every fake listing cost a real pool.
 *
 * Returns { ok, reason }. `ok: false` with reason "unverifiable" means the
 * chain could not be reached — the caller decides what to do about that.
 */
export async function isRealLaunch(mint, pool) {
  if (!mint || !pool) return { ok: false, reason: "a listing must name its mint and pool" };
  let accounts;
  try {
    /* `confirmed`, not the default. getMultipleAccounts finalizes by default,
     * which trails the chain by roughly thirteen seconds — and this is called
     * moments after the pool was created, so a finalized read would reject
     * every genuine launch for being too new. */
    accounts = await rpc("getMultipleAccounts",
      [[mint, pool], { encoding: "base64", commitment: "confirmed" }]);
  } catch (e) {
    return { ok: false, reason: "unverifiable", detail: e.message };
  }
  const [m, p] = accounts?.value || [];
  if (!m) return { ok: false, reason: "no such mint on chain" };
  if (m.owner !== SPL_TOKEN && m.owner !== TOKEN_2022) return { ok: false, reason: "not a token mint" };
  if (!p) return { ok: false, reason: "no such pool on chain" };
  if (CURVE_PROGRAMS.indexOf(p.owner) < 0) return { ok: false, reason: "pool is not a bonding curve" };
  return { ok: true };
}

/**
 * Does this collection exist, as a Metaplex Core collection?
 *
 * The NFT side has no pool to point at, so the check is the asset itself.
 */
const MPL_CORE = "CoREENxT6tW1HoK8ypY1SxRMZTcVPm7R94rH4PZNhX7d";
export async function isRealCollection(address) {
  if (!address) return { ok: false, reason: "a listing must name its collection" };
  let info;
  try {
    // confirmed, for the same reason as isRealLaunch above
    info = await rpc("getAccountInfo", [address, { encoding: "base64", commitment: "confirmed" }]);
  } catch (e) {
    return { ok: false, reason: "unverifiable", detail: e.message };
  }
  const v = info?.value;
  if (!v) return { ok: false, reason: "no such collection on chain" };
  if (v.owner !== MPL_CORE) return { ok: false, reason: "not a Core collection" };
  return { ok: true };
}

/**
 * The same question on Robinhood Chain: is there a contract at this address?
 *
 * `eth_getCode` is the whole check. An address with no code is either an
 * ordinary wallet or nothing at all, and neither is a token.
 */
export async function isRealEvmToken(address) {
  if (!/^0x[0-9a-fA-F]{40}$/.test(address || "")) return { ok: false, reason: "bad address" };
  try {
    const r = await fetch(process.env.RH_RPC || "https://rpc.mainnet.chain.robinhood.com", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_getCode", params: [address, "latest"] }),
      signal: AbortSignal.timeout(10000)
    });
    if (!r.ok) return { ok: false, reason: "unverifiable", detail: "rpc " + r.status };
    const j = await r.json();
    const code = j?.result;
    if (typeof code !== "string") return { ok: false, reason: "unverifiable" };
    if (code === "0x" || code === "0x0") return { ok: false, reason: "no contract at that address" };
    return { ok: true };
  } catch (e) {
    return { ok: false, reason: "unverifiable", detail: e.message };
  }
}

/**
 * Keep whatever the shop window pushes out.
 *
 * `ltrim` discards, so the cap was also a delete: anything trimmed off the end
 * was gone. Copying it aside first costs one write and means a listing can
 * always be put back — which is what turns losing the homepage from permanent
 * into an afternoon.
 */
export async function archiveOverflow(db, key, max) {
  try {
    const overflow = await db.lrange(key, max, max + 200);
    if (overflow && overflow.length) {
      await db.rpush(key + ":archive", ...overflow);
    }
  } catch {
    /* archiving is best-effort; never fail a launch over it */
  }
}
