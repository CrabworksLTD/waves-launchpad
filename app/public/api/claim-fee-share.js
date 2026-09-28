// api/claim-fee-share.js   GET ?mint=<mint>  → { owed }
//                          POST { mint }      → { released, sig }
//
// The pull half of a LaunchLab tier creator's fee. A tier's platform fee is claimed
// by the keeper into its escrow and LEDGERED per (creator, quote) in KV
// (`llcredit:<dest>|<quoteMint>`, see launchlab-keeper.js runFeeLadderGroup) rather
// than auto-forwarded — so the creator pulls it, alongside their on-chain 0.5%, in
// ONE fee-page action (consistent with the pair reward-activation model).
//
// GET reads the owed balance for a token's creator. POST releases it: the keeper
// transfers the owed amount from its own escrow to the recorded creator wallet and
// decrements the ledger. The destination is ALWAYS the recorded creator (never a
// caller-supplied address), so the endpoint is safe to expose without a signed
// request — the worst a stranger can do is trigger a payout to the rightful creator
// (rate-limited to stop gas-drain spam). Crash-safe like the keeper: the transfer
// signature is recorded before broadcast, and the ledger is decremented only after
// the transfer confirms, gated by a `settled` flag so a resume never double-moves.

export const config = { runtime: "nodejs", maxDuration: 60 };

import { allow, tooMany } from "./_guard.js";

const RPC = process.env.SOLANA_RPC || "https://solana-rpc.publicnode.com";
const WSOL = "So11111111111111111111111111111111111111112";
const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const TOKEN2022 = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";
const TOKENKEG = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const PLAN_TTL = 60 * 60 * 24 * 7;

function kv() {
  if (!process.env.KV_REST_API_URL || !process.env.KV_REST_API_TOKEN) return Promise.resolve(null);
  return import("@upstash/redis").then(({ Redis }) => new Redis({
    url: process.env.KV_REST_API_URL, token: process.env.KV_REST_API_TOKEN,
  })).catch(() => null);
}

function quoteMintOf(rec) {
  const q = rec.quote;
  if (!q || q === "sol") return WSOL;
  if (q === "usdc") return USDC;
  return q;                                   // already a mint address
}

export default async function handler(req, res) {
  const mint = req.method === "GET"
    ? (req.query && req.query.mint)
    : (req.body && (typeof req.body === "string" ? JSON.parse(req.body || "{}").mint : req.body.mint));
  if (!mint) return res.status(400).json({ error: "mint required" });

  const db = await kv();
  if (!db) return res.status(200).json({ owed: "0" });

  // find the launchlab token record → quote + the creator's chosen fee wallet
  let all = [];
  try {
    const raw = await db.lrange("tokens", 0, 199);
    all = (raw || []).map((x) => (typeof x === "string" ? JSON.parse(x) : x)).filter(Boolean);
  } catch (e) {}
  const rec = all.find((t) => t.mint === mint && t.backend === "launchlab");
  if (!rec) return res.status(404).json({ error: "not a launchlab token" });

  const w3 = await import("@solana/web3.js");
  const r = await import("@raydium-io/raydium-sdk-v2");
  const conn = new w3.Connection(RPC, "confirmed");
  const quoteMint = quoteMintOf(rec);

  // destination = the recorded fee wallet, else the pool's on-chain creator — the
  // SAME derivation the keeper uses to pick the ledger key, so they always agree.
  let dest = rec.feeWallet || null;
  if (!dest && rec.pool) {
    try {
      const pd = r.LaunchpadPool.decode((await conn.getAccountInfo(new w3.PublicKey(rec.pool))).data);
      dest = pd.creator.toBase58();
    } catch (e) {}
  }
  if (!dest) return res.status(200).json({ owed: "0" });

  const ledgerKey = "llcredit:" + dest + "|" + quoteMint;
  const owed = BigInt((await db.get(ledgerKey)) || "0");

  if (req.method === "GET") {
    return res.status(200).json({ owed: owed.toString(), dest, quoteMint });
  }
  if (req.method !== "POST") return res.status(405).json({ error: "method" });

  // ── release ──
  if (!process.env.KEEPER_SECRET) return res.status(200).json({ owed: owed.toString(), released: "0", skipped: "keeper not configured" });
  if (!(await allow(req, { bucket: "feeclaim", max: 20, windowSec: 60 }))) return tooMany(res, 60);

  const relKey = "llrel:" + dest + "|" + quoteMint;
  const bs58 = (await import("bs58")).default;
  const splToken = await import("@solana/spl-token");
  const keeper = w3.Keypair.fromSecretKey(bs58.decode(process.env.KEEPER_SECRET.trim()));
  const destPk = new w3.PublicKey(dest);
  const mintPk = new w3.PublicKey(quoteMint);
  const prog = new w3.PublicKey(await tokenProgram(conn, w3, quoteMint));

  // resume a release already in flight (crash-safe)
  let plan = await db.get(relKey).catch(() => null);
  if (typeof plan === "string") { try { plan = JSON.parse(plan); } catch { plan = null; } }

  if (plan && plan.sig) {
    const st = await conn.getSignatureStatus(plan.sig, { searchTransactionHistory: true }).catch(() => null);
    const v = st && st.value;
    if (v && !v.err && (v.confirmationStatus === "confirmed" || v.confirmationStatus === "finalized")) {
      if (!plan.settled) { await db.decrby(ledgerKey, Number(plan.amount)); plan.settled = true; }
      await db.del(relKey);
      return res.status(200).json({ released: String(plan.amount), sig: plan.sig });
    }
    // not landed → fall through and re-send the same amount
  }

  if (!plan) {
    if (owed <= 0n) return res.status(200).json({ owed: "0", released: "0" });
    plan = { amount: owed.toString(), dest, quoteMint };
    await db.set(relKey, JSON.stringify(plan), { ex: PLAN_TTL });
  }

  // build the transfer (create the creator's ATA if needed), record the sig BEFORE
  // broadcasting so a crash can never pay twice, then confirm.
  const from = splToken.getAssociatedTokenAddressSync(mintPk, keeper.publicKey, true, prog);
  const toAta = splToken.getAssociatedTokenAddressSync(mintPk, destPk, true, prog);
  const dec = (await conn.getTokenAccountBalance(from)).value.decimals;
  const tx = new w3.Transaction();
  tx.add(splToken.createAssociatedTokenAccountIdempotentInstruction(keeper.publicKey, toAta, destPk, mintPk, prog));
  tx.add(splToken.createTransferCheckedInstruction(from, mintPk, toAta, keeper.publicKey, BigInt(plan.amount), dec, [], prog));
  tx.feePayer = keeper.publicKey;
  tx.recentBlockhash = (await conn.getLatestBlockhash("confirmed")).blockhash;
  tx.sign(keeper);
  const raw = tx.serialize();
  const sig = bs58.encode(tx.signature);
  plan.sig = sig;
  await db.set(relKey, JSON.stringify(plan), { ex: PLAN_TTL });
  await conn.sendRawTransaction(raw, { maxRetries: 5 });
  await confirmed(conn, sig, raw);

  // decrement the ledger by exactly what we released (concurrent keeper credits are
  // preserved — decrby is atomic), gated so a resume can't double-decrement.
  if (!plan.settled) { await db.decrby(ledgerKey, Number(plan.amount)); plan.settled = true; }
  await db.del(relKey);
  return res.status(200).json({ released: String(plan.amount), sig });
}

async function tokenProgram(conn, w3, mintStr) {
  if (mintStr === WSOL || mintStr === USDC) return TOKENKEG;
  const acc = await conn.getAccountInfo(new w3.PublicKey(mintStr)).catch(() => null);
  return acc && acc.owner && acc.owner.toBase58() === TOKEN2022 ? TOKEN2022 : TOKENKEG;
}

async function confirmed(conn, sig, raw, ms) {
  const deadline = Date.now() + (ms || 90000);
  let lastSend = Date.now();
  while (Date.now() < deadline) {
    const st = await conn.getSignatureStatus(sig, { searchTransactionHistory: true }).catch(() => null);
    const v = st && st.value;
    if (v) {
      if (v.err) throw new Error("transfer failed: " + JSON.stringify(v.err));
      if (v.confirmationStatus === "confirmed" || v.confirmationStatus === "finalized") return true;
    }
    if (raw && Date.now() - lastSend > 6000) {
      lastSend = Date.now();
      conn.sendRawTransaction(raw, { skipPreflight: true, maxRetries: 5 }).catch(() => {});
    }
    await new Promise((r) => setTimeout(r, 700));
  }
  throw new Error("not confirmed within timeout");
}
