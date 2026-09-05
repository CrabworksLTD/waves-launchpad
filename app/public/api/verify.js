// GET /api/verify           verify every Robinhood launch that is not yet verified
// GET /api/verify?token=0x… just that one (open, like the indexer's single-token path)
//
// Publish each launched token's source to the explorer, so it stops reading as
// an unknown contract.
//
// ── Why this is worth a cron ────────────────────────────────────────────────
// GMGN shows an unverified contract with a red warning triangle and "Unknown
// Contract / Decompiled source". A trader meeting a token they have never heard
// of, on a launchpad they have never heard of, sees it flagged as a risk. That
// is the first impression of every single launch, and it is fixable for free.
//
// ⚠️ Blockscout DOES match unverified bytecode against an already-verified twin
// and will show the source — but it leaves `is_verified: false`, and that flag
// is what other tools read. A twin match is not enough; each address has to be
// submitted.
//
// ── No compiler here ────────────────────────────────────────────────────────
// Every WavesToken has identical source and identical settings, so the compiler
// input never varies. tools/build-contract.js writes it to /verify/<Name>.json
// at build time and this posts that same file for each address. Shipping solc
// into a serverless function to regenerate something that cannot change would
// be slow, enormous, and a second description of settings that must agree with
// the first.

export const config = { runtime: "nodejs" };

import { kv, allow, tooMany } from "./_guard.js";

const EXPLORER = process.env.RH_EXPLORER || "https://robinhoodchain.blockscout.com";
/* ⚠️ The explorer sits behind Cloudflare and answers a default fetch with a 403
 * challenge page. It is not refusing API use — a browser User-Agent gets a
 * normal 200 — but without one every call fails in a way that looks like a
 * permissions problem rather than a header problem. */
const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36";

const EVM = /^0x[0-9a-fA-F]{40}$/;

async function explorer(path, init) {
  const r = await fetch(EXPLORER + path, {
    ...init,
    headers: { "User-Agent": UA, ...(init && init.headers) },
    signal: AbortSignal.timeout(30000)
  });
  const text = await r.text();
  try { return { status: r.status, json: JSON.parse(text) }; }
  catch (e) { return { status: r.status, json: null, text: text.slice(0, 200) }; }
}

async function isVerified(address) {
  const r = await explorer("/api/v2/smart-contracts/" + address);
  return !!(r.json && r.json.is_verified);
}

let inputCache = null;
async function verificationInput(origin) {
  if (inputCache) return inputCache;
  /* Read from our own deployment. The file ships with the site, so this is the
   * same bytes the build produced rather than anything reconstructed. */
  const r = await fetch(origin + "/verify/WavesToken.json",
    { signal: AbortSignal.timeout(15000) });
  if (!r.ok) throw new Error("no verification input (" + r.status + ")");
  inputCache = await r.json();
  return inputCache;
}

async function submit(address, spec) {
  const form = new FormData();
  form.append("compiler_version", spec.compiler);
  form.append("contract_name", spec.contractName);
  /* The constructor arguments are in the creation transaction and not here — a
   * token is deployed by the curve, so we never held them. */
  form.append("autodetect_constructor_args", "true");
  form.append("license_type", "mit");
  form.append("files[0]",
    new Blob([JSON.stringify(spec.input)], { type: "application/json" }),
    spec.contractName + ".json");

  const r = await explorer(
    "/api/v2/smart-contracts/" + address + "/verification/via/standard-input",
    { method: "POST", body: form });
  return r;
}

export default async function handler(req, res) {
  const secret = process.env.CRON_SECRET;
  const authed = !secret || req.headers.authorization === "Bearer " + secret;
  const only = (req.query && req.query.token) || null;
  /* One token by name is open, like the indexer's: a fresh launch wants to be
   * verified now rather than at the next sweep, and submitting a contract's own
   * public source to a public explorer discloses nothing. */
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
        if (await isVerified(a)) { out.push({ token: a, already: true }); continue; }
        const r = await submit(a, spec);
        /* A 200 means the job was ACCEPTED, not that it succeeded — Blockscout
         * queues it. The next run reports whether it stuck, which is why this
         * is idempotent and safe to re-run. */
        out.push({
          token: a,
          submitted: r.status,
          note: (r.json && r.json.message) || r.text || null
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
