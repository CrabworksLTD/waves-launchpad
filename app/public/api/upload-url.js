// POST /api/upload-url — two modes:
//
//   { quote:true, bytes, count }                    -> { feeLamports, feeSol, feeTo }
//   { signerAddress, bytes, count, <credential> }   -> { paidBy, winc }
//
// The upload is paid from the platform's Turbo credits (TURBO_JWK), so granting
// the credit share is gated or it is an open invitation to spend someone else's
// storage money. Three ways in, cheapest first:
//
//   1. the team's closed-testing password (key)
//   2. a pass holder who SIGNS the launch message — the server verifies the
//      signature against the claimed pubkey, so naming someone's address fails
//   3. anyone else, by paying the exact Turbo cost of their upload in SOL
//      (× margin), verified on chain here and marked spent so it can't be
//      replayed for a second free upload
//
// Quote mode is public and grants nothing — it just returns a price.
//
// Ported from Moonpad's EVM version. The quote maths is unchanged; what moved
// is payment verification (getTransaction + lamport delta instead of
// eth_getTransactionByHash + tx.value) and signature checking (ed25519 instead
// of ECDSA recovery). Every fail-closed decision below is deliberate and was
// arrived at the hard way — read the comments before relaxing one.

// SHA-256 of the closed-testing password — the team's free path.
import { allow, tooMany } from "./_guard.js";

const TEST_HASH = process.env.TEST_HASH || "";

// Collections whose holders launch free. Empty until a pass collection exists
// on Solana; the mechanism stays wired so turning it on is one entry.
const PASSES = [
  // { collection: "<Core collection address>", label: "Passes" }
];

// Where storage fees land.
const FEE_TO = process.env.FEE_TO || "";
const RPC = process.env.SOLANA_RPC || "https://api.mainnet-beta.solana.com";

const MARGIN = 1.5;                 // fee = actual storage cost × this
const MAX_FILES = 25000;            // bounds a single approval (and the fee)
const PER_FILE_FLOOR = 7000;        // Turbo's per-item floor, in bytes-equivalent
const GiB = 1024 * 1024 * 1024;
const LAMPORTS = 1e9;

async function sha256(s) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/* ---------- base58, because addresses and signatures arrive as base58 and
   pulling a dependency in for forty lines of arithmetic is not worth it ---- */
const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
function b58decode(str) {
  if (typeof str !== "string" || !str.length) return null;
  // Starts empty, not [0]. Seeding a zero byte adds a spurious leading zero on
  // top of the explicit leading-'1' handling below, which made the System
  // Program address ('1' × 32) decode to 33 bytes and fail isAddress.
  const bytes = [];
  for (const ch of str) {
    let carry = B58.indexOf(ch);
    if (carry < 0) return null;                   // not base58 at all
    for (let i = 0; i < bytes.length; i++) {
      carry += bytes[i] * 58;
      bytes[i] = carry & 0xff;
      carry >>= 8;
    }
    while (carry) { bytes.push(carry & 0xff); carry >>= 8; }
  }
  // each leading '1' is one leading zero byte, by definition of base58
  for (let i = 0; i < str.length && str[i] === "1"; i++) bytes.push(0);
  return Uint8Array.from(bytes.reverse());
}
const isAddress = (s) => { const b = b58decode(s); return !!b && b.length === 32; };

/* ---------- RPC ---------- */
async function rpc(method, params) {
  const r = await fetch(RPC, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params })
  }).then((x) => x.json());
  if (r.error) throw new Error(r.error.message || "rpc error");
  return r.result;
}

// Does this wallet hold an asset from one of the pass collections? Uses DAS,
// which every mainstream Solana RPC exposes — the equivalent of the balanceOf
// eth_call on the EVM side.
async function holdsAPass(address) {
  if (!PASSES.length) return false;
  for (const p of PASSES) {
    try {
      const page = await rpc("searchAssets", {
        ownerAddress: address,
        grouping: ["collection", p.collection],
        page: 1, limit: 1
      });
      if (page && page.total > 0) return true;
    } catch (e) {
      // an rpc without DAS must not lock out a holder of a different pass
    }
  }
  return false;
}

// Airtight holder check: the connected wallet must SIGN the launch message, and
// the signature must verify against the claimed pubkey, which must hold a pass.
// This closes the spoof where a non-holder names a known holder's address. A
// fresh timestamp (±10 min) keeps an old signature from being reused.
async function signedByHolder(address, sig, ts) {
  if (!isAddress(address)) return false;
  const t = parseInt(ts, 10);
  if (!(t > 0) || Math.abs(Date.now() - t) > 10 * 60 * 1000) return false;
  try {
    const { createPublicKey, verify } = await import("node:crypto");
    const pub = b58decode(address);
    const signature = b58decode(sig);
    if (!pub || !signature || signature.length !== 64) return false;

    // Node will not take a bare 32-byte ed25519 key, so wrap it in the fixed
    // SPKI prefix. Avoids a tweetnacl dependency for one verify call.
    const der = Buffer.concat([
      Buffer.from("302a300506032b6570032100", "hex"),
      Buffer.from(pub)
    ]);
    const key = createPublicKey({ key: der, format: "der", type: "spki" });
    const msg = Buffer.from("Launch\n" + address + "\n" + t, "utf8");
    if (!verify(null, msg, key, Buffer.from(signature))) return false;
  } catch (e) {
    return false;
  }
  return await holdsAPass(address);
}

// The storage fee for an upload of `bytes` across `count` files, in lamports.
// Exact Turbo cost (per-item floor × files + bytes × the live per-byte rate)
// → USD at Turbo's own rate → SOL at the live spot × margin. Everything is
// quoted live so a move in the AR or SOL price can't leave the fee under cost.
async function quoteFeeLamports(bytes, count) {
  const rates = await fetch("https://payment.ardrive.io/v1/rates").then((r) => r.json());
  const gibWinc = Number(rates.winc);                    // winc to store 1 GiB
  const gibUsd = Number(rates.fiat.usd);                 // USD for that
  const perItem = Number(rates.perDataItemFeeWinc);      // per-file floor, winc
  const costWinc = count * perItem + bytes * (gibWinc / GiB);
  const costUsd = (costWinc / gibWinc) * gibUsd;
  const px = await fetch("https://api.coinbase.com/v2/prices/SOL-USD/spot").then((r) => r.json());
  const solUsd = Number(px.data.amount);
  if (!(gibWinc > 0) || !(gibUsd > 0) || !(solUsd > 0)) throw new Error("bad rate quote");
  const feeSol = (costUsd / solUsd) * MARGIN;
  return BigInt(Math.ceil(feeSol * LAMPORTS));
}

/* ---- Robinhood Chain: the same quote and guard, in ETH ----
 *
 * A launch on the EVM side pays for its own Arweave storage exactly like the
 * Solana side does; only the money moves differently. EVM gives us tx.value
 * directly (no balance-delta reconstruction), but everything else — live
 * rates, the 1.5x margin, the age limit, the Redis replay claim — is the
 * same policy, deliberately. */
const FEE_TO_EVM = process.env.FEE_TO_EVM || "";
const RH_RPC = process.env.RH_RPC || "https://rpc.mainnet.chain.robinhood.com";
const WEI = 1e18;

async function evmRpc(method, params) {
  const r = await fetch(RH_RPC, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params })
  }).then((x) => x.json());
  if (r.error) throw new Error(r.error.message || "rpc error");
  return r.result;
}

async function quoteFeeWei(bytes, count) {
  const rates = await fetch("https://payment.ardrive.io/v1/rates").then((r) => r.json());
  const gibWinc = Number(rates.winc);
  const gibUsd = Number(rates.fiat.usd);
  const perItem = Number(rates.perDataItemFeeWinc);
  const costWinc = count * perItem + bytes * (gibWinc / GiB);
  const costUsd = (costWinc / gibWinc) * gibUsd;
  const px = await fetch("https://api.coinbase.com/v2/prices/ETH-USD/spot").then((r) => r.json());
  const ethUsd = Number(px.data.amount);
  if (!(gibWinc > 0) || !(gibUsd > 0) || !(ethUsd > 0)) throw new Error("bad rate quote");
  const feeEth = (costUsd / ethUsd) * MARGIN;
  return BigInt(Math.ceil(feeEth * WEI));
}

async function paymentFreshEvm(txHash, minWei) {
  if (!/^0x[0-9a-fA-F]{64}$/.test(txHash || "")) return false;
  if (!FEE_TO_EVM) throw new Error("FEE_TO_EVM is not set on this deployment");

  const [tx, rec] = await Promise.all([
    evmRpc("eth_getTransactionByHash", [txHash]),
    evmRpc("eth_getTransactionReceipt", [txHash])
  ]);
  if (!tx || !rec || rec.status !== "0x1") return false;
  if (String(tx.to || "").toLowerCase() !== FEE_TO_EVM.toLowerCase()) return false;
  if (BigInt(tx.value || "0x0") < (minWei * 85n) / 100n) return false;

  // age limit, same hour as the Solana path
  const blk = await evmRpc("eth_getBlockByNumber", [rec.blockNumber, false]);
  if (!blk || !blk.timestamp) return false;
  if (Math.floor(Date.now() / 1000) - parseInt(blk.timestamp, 16) > 3600) return false;

  const { Redis } = await import("@upstash/redis");
  const kv = new Redis({ url: process.env.KV_REST_API_URL, token: process.env.KV_REST_API_TOKEN });
  const claimed = await kv.set("paid:" + txHash.toLowerCase(), Date.now(), { nx: true, ex: 86400 });
  return claimed === "OK";
}

// True only if `signature` is a confirmed transfer to FEE_TO worth at least
// `minLamports` AND has not been used before.
//
// Solana gives no tx.value to read — a transfer is the difference between
// FEE_TO's pre and post balance in the transaction's own accounting. Reading it
// that way is also strictly better than parsing instructions: it catches the
// payment whether it arrived as a system transfer, through a CPI, or bundled
// with other instructions, and it cannot be fooled by an instruction that looks
// like a transfer but failed.
//
// The Redis SET NX is the replay guard: the first caller to present a signature
// claims it; a second gets null and is refused. Any infra failure throws and
// the caller is denied (fail closed) rather than granted a free upload.
async function paymentFresh(signature, minLamports) {
  if (!signature || typeof signature !== "string") return false;
  const sigBytes = b58decode(signature);
  if (!sigBytes || sigBytes.length !== 64) return false;
  if (!FEE_TO) throw new Error("FEE_TO is not set on this deployment");

  const tx = await rpc("getTransaction", [
    signature,
    { encoding: "jsonParsed", maxSupportedTransactionVersion: 0, commitment: "confirmed" }
  ]);
  if (!tx || !tx.meta || tx.meta.err) return false;

  // Reject by age. A day-old payment would otherwise replay cleanly any time AR
  // and SOL have not moved much, which is most days — the 15% tolerance below
  // is not a substitute for an age check.
  if (!tx.blockTime) return false;
  if (Math.floor(Date.now() / 1000) - tx.blockTime > 3600) return false;

  // Account keys live in different places for legacy vs versioned transactions,
  // and loaded addresses are appended after the static ones. Getting this order
  // wrong reads the wrong account's balance.
  const msg = tx.transaction.message;
  const keys = (msg.accountKeys || []).map((k) => (typeof k === "string" ? k : k.pubkey));
  const loaded = tx.meta.loadedAddresses || {};
  const all = keys.concat(loaded.writable || [], loaded.readonly || []);

  const idx = all.indexOf(FEE_TO);
  if (idx < 0 || idx >= tx.meta.postBalances.length) return false;
  const delta = BigInt(tx.meta.postBalances[idx]) - BigInt(tx.meta.preBalances[idx]);

  // 15% tolerance for price drift between the quote and the payment; the 1.5×
  // margin means this still comfortably covers the real cost.
  if (delta < (minLamports * 85n) / 100n) return false;

  const { Redis } = await import("@upstash/redis");
  const kv = new Redis({ url: process.env.KV_REST_API_URL, token: process.env.KV_REST_API_TOKEN });
  const claimed = await kv.set("paid:" + signature, Date.now(), { nx: true, ex: 86400 });
  return claimed === "OK";
}

// How many approvals one proven holder may pull in an hour.
//
// The signature gate proves who you are; it says nothing about how often. A
// holder could sign once and pull an approval per request all window, so the
// real price of unlimited platform-funded storage was one pass on the secondary
// market. MAX_FILES bounds a single approval; this bounds the number of them.
const HOLDER_APPROVALS_PER_HOUR = 5;

/* A token launch's art can be uploaded before it is paid for.
 *
 * Charging for storage in its own transaction is what made launching cost two
 * wallet approvals: the fee had to be paid BEFORE the upload, because the URI
 * has to exist before the pool transaction that embeds it. Folding the fee into
 * the pool transaction removes that approval — but it also means the upload
 * happens on trust, so this is what bounds the trust.
 *
 * A token launch is an icon, a banner and a metadata file. Anything bigger is a
 * collection, which is expensive and still pays first. The exposure is
 * therefore a few hundred kilobytes per allowance, capped per address per hour,
 * and only for people who abandon a launch after uploading.
 */
/* Two 2MB images plus a generated share card plus the json, with room to
 * spare. At 3MB this sat below what a real launch actually uploads — MOAR's
 * was 2.68MB — so a slightly larger banner would have silently fallen out of
 * the free allowance and demanded a storage payment instead. The launch window
 * caps each image at 2MB, and this is the matching ceiling. */
const LAUNCH_FREE_BYTES = 8 * 1024 * 1024;
const LAUNCH_FREE_FILES = 5;
const LAUNCH_UPLOADS_PER_HOUR = 6;

function isLaunchSized(size, files) {
  return size <= LAUNCH_FREE_BYTES && files <= LAUNCH_FREE_FILES;
}

async function underLaunchLimit(who) {
  try {
    const { Redis } = await import("@upstash/redis");
    const kv = new Redis({ url: process.env.KV_REST_API_URL, token: process.env.KV_REST_API_TOKEN });
    const key = "rlu:" + who + ":" + Math.floor(Date.now() / 3600000);
    const n = await kv.incr(key);
    if (n === 1) await kv.expire(key, 3600);
    return n <= LAUNCH_UPLOADS_PER_HOUR;
  } catch (e) {
    /* Fail CLOSED, unlike the holder limit above. A holder has already proved
     * who they are and paid for a pass; this path has proved nothing, so an
     * unreachable counter must not become an unmetered one. Falling back to
     * paying first still gets the launch done, one approval the poorer. */
    return false;
  }
}

async function underHolderLimit(address) {
  try {
    const { Redis } = await import("@upstash/redis");
    const kv = new Redis({ url: process.env.KV_REST_API_URL, token: process.env.KV_REST_API_TOKEN });
    const key = "rl:" + address + ":" + Math.floor(Date.now() / 3600000);
    const n = await kv.incr(key);
    if (n === 1) await kv.expire(key, 3600);
    return n <= HOLDER_APPROVALS_PER_HOUR;
  } catch (e) {
    // Fail open, deliberately — unlike the payment path. Making a launch fail
    // because a counter is unreachable trades a slow, bounded spend risk for an
    // outright outage. MAX_FILES still caps what one request can approve.
    return true;
  }
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "POST only" });
  }

  /* An outer ceiling on the whole endpoint, above the per-holder allowance
   * further down. That one bounds how much free STORAGE a proven holder can
   * pull; this bounds how much WORK an anonymous caller can make us do getting
   * there — signature verification, chain reads and rate lookups all happen
   * before anything decides to say no. */
  if (!(await allow(req, { bucket: "upload", max: 120, windowSec: 60 }))) return tooMany(res, 60);

  const body = typeof req.body === "string" ? JSON.parse(req.body || "{}") : (req.body || {});
  const { key, address, sig, ts, signerAddress, bytes, count, signature, quote } = body;
  // which chain is paying — Robinhood Chain pays in ETH, Solana in SOL
  const evm = body.chain === "robinhood";

  const size = Math.max(1, parseInt(bytes, 10) || 0);
  const files = Math.min(Math.max(1, parseInt(count, 10) || 1), MAX_FILES);
  if (size > 2 * GiB) return res.status(400).json({ error: "That upload is over 2GB — talk to us" });

  // Quote mode — a public price, grants nothing.
  if (quote) {
    /* Grants nothing, but is not free: each quote calls Turbo for its live
     * rates and Coinbase for a spot price. Unlimited, that makes this an
     * amplifier aimed at two third parties who would rightly rate limit US.
     * A launch window asks for a handful of quotes as the artwork changes. */
    if (!(await allow(req, { bucket: "quote", max: 60, windowSec: 60 }))) return tooMany(res, 60);

    try {
      if (evm) {
        const feeWei = await quoteFeeWei(size, files);
        return res.status(200).json({
          feeWei: feeWei.toString(),
          feeEth: Number(feeWei) / WEI,
          feeTo: FEE_TO_EVM,
          chain: "robinhood"
        });
      }
      const feeLamports = await quoteFeeLamports(size, files);
      return res.status(200).json({
        feeLamports: feeLamports.toString(),
        feeSol: Number(feeLamports) / LAMPORTS,
        feeTo: FEE_TO
      });
    } catch (e) {
      return res.status(502).json({
        error: "Could not price the upload right now — try again.",
        detail: String(e && e.message ? e.message : e).slice(0, 300)
      });
    }
  }

  // Grant mode.
  const jwk = process.env.TURBO_JWK;
  if (!jwk) return res.status(500).json({ error: "TURBO_JWK is not set on this deployment" });
  if (!isAddress(signerAddress)) {
    return res.status(400).json({ error: "No upload signer address" });
  }

  let allowed = false;
  try {
    if (key && TEST_HASH) allowed = (await sha256(String(key))) === TEST_HASH;
    if (!allowed && address && sig) {
      allowed = await signedByHolder(address, sig, ts);
      if (allowed && !(await underHolderLimit(address))) {
        return res.status(429).json({
          error: "That wallet has started " + HOLDER_APPROVALS_PER_HOUR +
                 " uploads this hour. Try again shortly, or pay the storage fee to continue now."
        });
      }
    }
    /* No payment yet, but small enough to be a launch: allow it, and let the
     * fee ride in the pool transaction. Checked after the paid and holder
     * paths so neither loses its higher limits to this one. */
    if (!allowed && !signature && isLaunchSized(size, files)) {
      const who = (isAddress(address) && address) ||
        String(req.headers["x-forwarded-for"] || "").split(",")[0].trim() || "anon";
      allowed = await underLaunchLimit(who);
      if (!allowed) {
        return res.status(429).json({
          error: "Too many launches started from here this hour. " +
                 "Try again shortly, or pay the storage fee to continue now."
        });
      }
    }
    if (!allowed && signature) {
      if (evm) {
        const feeWei = await quoteFeeWei(size, files);
        allowed = await paymentFreshEvm(signature, feeWei);
      } else {
        const feeLamports = await quoteFeeLamports(size, files);
        allowed = await paymentFresh(signature, feeLamports);
      }
    }
  } catch (e) {
    // A failure verifying the payment (rpc, rates, or Redis) must deny, never
    // grant — the whole point is that only a paid, un-replayed upload gets in.
    return res.status(402).json({
      error: "Could not verify the storage payment — try again.",
      detail: String(e && e.message ? e.message : e).slice(0, 300)
    });
  }
  if (!allowed) {
    return res.status(402).json({ error: "Launching needs the storage fee paid, or the team password." });
  }

  // Turbo prices each data item with a floor, so a folder of many tiny files
  // costs far more than its byte total. Size the approval against a per-file
  // allowance too, or a many-file upload undershoots mid-run and the browser
  // SDK hangs (the old "Storing the images…" freeze). Bounded by MAX_FILES so a
  // huge `count` can't route around the 2GB check above.
  const effectiveBytes = Math.max(size, files * PER_FILE_FLOOR);

  try {
    const { TurboFactory } = await import("@ardrive/turbo-sdk");
    const turbo = TurboFactory.authenticated({ privateKey: JSON.parse(jwk) });

    const [cost] = await turbo.getUploadCosts({ bytes: [effectiveBytes] });
    // 25% headroom over the quote for manifests + price drift; the per-file
    // floor above is what keeps a many-file upload from undershooting.
    const winc = ((BigInt(cost.winc) * 125n) / 100n).toString();

    await turbo.shareCredits({
      approvedAddress: signerAddress,
      approvedWincAmount: winc,
      expiresBySeconds: 3600
    });

    const paidBy = await turbo.signer.getNativeAddress();
    return res.status(200).json({ paidBy, winc, expires: 3600 });
  } catch (e) {
    return res.status(502).json({
      error: "Turbo refused the credit share",
      detail: String(e && e.message ? e.message : e).slice(0, 400)
    });
  }
}
