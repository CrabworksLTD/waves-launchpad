// GET /api/verify           verify every Robinhood launch that is not yet verified
// GET /api/verify?token=0x… just that one (open, like the indexer's single-token path)
//
// Publish each launched token's source so it stops reading as an unknown
// contract. GMGN shows an unverified contract with a red warning triangle and
// "Unknown Contract / Decompiled source" — the first impression of every launch,
// on a launchpad a trader has never heard of, flagged as a risk. Fixable for free.
//
// ── Sourcify, not Blockscout ────────────────────────────────────────────────
// Robinhood's Blockscout is the obvious target but it does not work from here:
// its API sits behind a Cloudflare bot-challenge (a serverless fetch gets a 403
// HTML page, not JSON) AND its smart-contract service has been returning 500 for
// every contract — verified ones included. Sourcify is the decentralized
// verifier, supports Robinhood Chain (chainId 4663, verify:true), answers plain
// HTTPS with no challenge, and is what eth-bytecode-db imports from — which is
// what rh-scan and GMGN read. So verifying on Sourcify lights the token up
// everywhere that matters. (Sourcify also forwards to Blockscout itself; that
// leg 403s on Cloudflare, harmlessly — the Sourcify match still stands.)
//
// ── Per address, not per bytecode ───────────────────────────────────────────
// Every WavesToken has identical source, but Sourcify (and the tools reading it)
// verify PER ADDRESS — a bytecode twin is not automatically "verified". So each
// launch has to be submitted once. The compiler input never varies, so it ships
// with the site at /verify/WavesToken.json (written by tools/build-contract.js)
// and this posts that same file for each address. ⚠️ It MUST be the 0.8.26 build
// the hook deploys, not the retired 0.8.28 standalone-curve one.

export const config = { runtime: "nodejs" };

import { kv, allow, tooMany } from "./_guard.js";

const SOURCIFY = process.env.SOURCIFY_URL || "https://sourcify.dev/server";
const CHAIN = "4663"; // Robinhood Chain
const EVM = /^0x[0-9a-fA-F]{40}$/;

async function sourcify(path, init) {
  const r = await fetch(SOURCIFY + path, { ...init, signal: AbortSignal.timeout(30000) });
  const text = await r.text();
  try { return { status: r.status, json: JSON.parse(text) }; }
  catch (e) { return { status: r.status, json: null, text: text.slice(0, 200) }; }
}

/* A match at all (exact_match or match, on creation or runtime) means the source
 * is published and the flag other tools read is set. Reported, not just believed:
 * a silent "no" would resubmit every token every run forever. */
async function isVerified(address) {
  const r = await sourcify("/v2/contract/" + CHAIN + "/" + address);
  const j = r.json || {};
  const m = j.match || j.runtimeMatch || j.creationMatch || null;
  return {
    verified: !!m,
    saw: r.json ? (m ? String(m) : "no match yet") : "no json (" + r.status + ")"
  };
}

let inputCache = null;
async function verificationInput(origin) {
  if (inputCache) return inputCache;
  /* Read from our own deployment — the same bytes the build produced. */
  const r = await fetch(origin + "/verify/WavesToken.json", { signal: AbortSignal.timeout(15000) });
  if (!r.ok) throw new Error("no verification input (" + r.status + ")");
  inputCache = await r.json();
  return inputCache;
}

/* Async on Sourcify: 202 + a verificationId means the job was ACCEPTED, and the
 * next run's isVerified() confirms it stuck — so this is idempotent and safe to
 * re-run. An "already_verified" error is success by another name. Constructor
 * args are recovered by Sourcify from the creation tx; we never held them. */
async function submit(address, spec) {
  const body = {
    stdJsonInput: spec.input,
    compilerVersion: spec.compiler,                 // "0.8.26+commit.8a97fa7a"
    contractIdentifier: spec.contractIdentifier     // "contracts/WavesToken.sol:WavesToken"
  };
  return sourcify("/v2/verify/" + CHAIN + "/" + address, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
}

export default async function handler(req, res) {
  // Fail closed for the full sweep; the single named-token path stays open by
  // design (submits public source to a public verifier).
  const secret = process.env.CRON_SECRET;
  const authed = !!secret && req.headers.authorization === "Bearer " + secret;
  const only = (req.query && req.query.token) || null;
  /* One token by name is open, like the indexer's: a fresh launch wants to be
   * verified now rather than at the next sweep, and submitting a contract's own
   * public source to a public verifier discloses nothing. */
  if (!authed && !only) return res.status(401).json({ error: "no" });
  if (!(await allow(req, { bucket: "verify", max: 30, windowSec: 60 }))) return tooMany(res, 60);

  const origin = process.env.VERCEL_URL
    ? "https://" + process.env.VERCEL_URL
    : "https://www.waveslaunchpad.xyz";

  try {
    let addresses = [];
    if (only) {
      if (!EVM.test(only)) return res.status(400).json({ error: "bad token" });
      addresses = [only.toLowerCase()];
    } else {
      const db = await kv();
      const raw = await db.lrange("tokens", 0, 199);
      addresses = (raw || [])
        .map((r) => (typeof r === "string" ? JSON.parse(r) : r))
        .filter((t) => t && t.chain === "robinhood" && EVM.test(t.mint || ""))
        .map((t) => String(t.mint).toLowerCase());
    }
    if (!addresses.length) return res.status(200).json({ ok: true, note: "nothing to verify" });

    const spec = await verificationInput(origin);
    const out = [];
    for (const a of addresses.slice(0, 12)) {
      try {
        const chk = await isVerified(a);
        if (chk.verified) { out.push({ token: a, already: chk.saw }); continue; }
        const r = await submit(a, spec);
        out.push({
          token: a,
          submitted: r.status,
          id: (r.json && r.json.verificationId) || null,
          note: (r.json && (r.json.error && r.json.error.customCode)) ||
                (r.json && r.json.message) || r.text || null
        });
      } catch (e) {
        out.push({ token: a, error: String(e.message || e).slice(0, 140) });
      }
    }
    return res.status(200).json({ ok: true, checked: out.length, results: out });
  } catch (e) {
    return res.status(200).json({ ok: false, error: String(e.message || e).slice(0, 200) });
  }
}
