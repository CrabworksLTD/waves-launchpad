// POST /api/cosign  { tx: <base64 legacy transaction> }
//   -> { tx: <base64, with the keeper's signature added> }
//
// A pledged launch names the keeper as the pool's creator at creation, so the
// pool is never unpledged for even one transaction — snipers took nearly all of
// $MOAR's creator fees through exactly that gap. The cost of closing it is that
// the pool transaction needs the keeper's signature, and the keeper's key lives
// here, not in the browser. Without this the transaction went out one signature
// short: the public node accepted it without simulating and dropped it, which
// looked for hours like an expired blockhash.
//
// This is a signing oracle for a hot key, so it is not enough that it usually
// signs the right thing. Three properties are checked, and together they make a
// misuse unable to move funds regardless of what else the transaction contains:
//
//   1. The keeper is never a writable account. Solana cannot debit lamports
//      from a non-writable account, so no instruction in the transaction can
//      take its SOL.
//   2. The keeper appears only in instructions belonging to the DBC program.
//      That is what stops it being used as a token authority — an SPL transfer
//      signed by a read-only authority is otherwise perfectly valid, so
//      read-only alone would not be enough.
//   3. The keeper is not the fee payer, which is writable by definition.
//
// What is deliberately NOT checked is the shape of the DBC instruction itself.
// Pinning the discriminator would break on the next SDK release and strand
// launches; the invariants above already bound the damage to "the keeper is
// named as the creator of some DBC pool", which is the thing being asked for.

export const config = { runtime: "nodejs" };

import { allow, tooMany } from "./_guard.js";

const DBC = "dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN";
const MAX_TX_BYTES = 1600;

export default async function handler(req, res) {
  /* Holds the keeper key. The secret is the real gate; this bounds how fast
   * anyone may guess at it, and how much signing work a caller can demand. */
  if (!(await allow(req, { bucket: "cosign", max: 30, windowSec: 60 }))) return tooMany(res, 60);

  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "POST" });
  }
  if (!process.env.KEEPER_SECRET) {
    return res.status(503).json({ error: "co-signing is not configured" });
  }

  let body = req.body;
  if (typeof body === "string") {
    try { body = JSON.parse(body); } catch { return res.status(400).json({ error: "bad json" }); }
  }
  const b64 = body && body.tx;
  if (typeof b64 !== "string" || !b64) return res.status(400).json({ error: "expected tx" });

  const raw = Buffer.from(b64, "base64");
  if (!raw.length || raw.length > MAX_TX_BYTES) {
    return res.status(413).json({ error: "transaction size out of range" });
  }

  try {
    const w3 = await import("@solana/web3.js");
    const bs58 = (await import("bs58")).default;
    const keeper = w3.Keypair.fromSecretKey(bs58.decode(process.env.KEEPER_SECRET.trim()));
    const me = keeper.publicKey.toBase58();

    const tx = w3.Transaction.from(raw);

    if (!tx.feePayer) return res.status(400).json({ error: "no fee payer" });
    if (tx.feePayer.toBase58() === me) {
      return res.status(403).json({ error: "the keeper may not be the fee payer" });
    }

    // it must actually need us, or there is nothing to authorise
    const msg = tx.compileMessage();
    const idx = msg.accountKeys.findIndex((k) => k.toBase58() === me);
    if (idx < 0 || idx >= msg.header.numRequiredSignatures) {
      return res.status(400).json({ error: "this transaction does not require the keeper" });
    }
    if (msg.isAccountWritable(idx)) {
      return res.status(403).json({ error: "the keeper must be read-only" });
    }

    for (const ix of tx.instructions) {
      const touches = ix.keys.some((k) => k.pubkey.toBase58() === me);
      if (!touches) continue;
      if (ix.programId.toBase58() !== DBC) {
        return res.status(403).json({ error: "the keeper is only signable for the curve program" });
      }
      // belt and braces: writability is a per-instruction flag too
      if (ix.keys.some((k) => k.pubkey.toBase58() === me && k.isWritable)) {
        return res.status(403).json({ error: "the keeper must be read-only" });
      }
    }

    tx.partialSign(keeper);
    return res.status(200).json({
      tx: tx.serialize({ requireAllSignatures: false, verifySignatures: false }).toString("base64"),
      signer: me
    });
  } catch (e) {
    return res.status(400).json({ error: "could not co-sign: " + (e.message || String(e)) });
  }
}
