#!/usr/bin/env node
/* staking-rehearse.js — prove the pairing/staking loop on a REAL cluster.
 *
 * Runs the exact sequence a live pair goes through, end-to-end, with one keypair:
 *   init_pool (+ create vault)  →  stake (burn token → weight)  →
 *   deposit reward to the vault  →  sync  →  claim  →  verify the payout landed.
 *
 * The keeper's job in production is the deposit+sync step; here we do it inline so
 * the whole loop is proven against the immutable on-chain program before pairing
 * opens. Read-then-act, confirmed-by-polling, and it prints every signature.
 *
 * ── What you need first ────────────────────────────────────────────────────────
 *   • a funded keypair (JSON secret-key array or {secretArray}/{secretBase58})
 *   • a paired TOKEN mint you hold a balance of (the thing that gets burned)
 *   • a Core NFT you own + its COLLECTION address (launch a small collection on
 *     WAVES to get one; the NFT is what accrues rewards)
 *   • a REWARD mint (default WSOL) — for WSOL the script wraps --depositSol SOL;
 *     for any other SPL it moves --depositRaw from your ATA
 *
 *   node tools/staking-rehearse.js \
 *     --keypair ~/waves-keys/keeper.json \
 *     --token <paired token mint> --collection <core collection> --asset <your NFT> \
 *     --reward So11111111111111111111111111111111111111112 \
 *     --stake 1000000 --depositSol 0.02
 *
 *   Add DRY=1 to print the plan + all derived PDAs and stop before sending.
 *   RPC defaults to mainnet; pass --rpc <url> (Helius recommended for confirms).
 */
const fs = require("fs");
const os = require("os");
const w3 = require("@solana/web3.js");
const splToken = require("@solana/spl-token");

const PROGRAM_ID = "jt5JegTBVPZP8V6a48fnKYPFKTbpcTfkz91Pemur82H";
const TOKENKEG = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const TOKEN2022 = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";
const ATA_PROGRAM = "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL";
const WSOL = "So11111111111111111111111111111111111111112";
// discriminators — MUST match stake.js / the IDL
const DISC = {
  init_pool: [116, 233, 199, 204, 115, 159, 171, 36],
  stake: [206, 176, 202, 18, 200, 209, 179, 108],
  sync: [4, 219, 40, 164, 21, 157, 189, 88],
  claim: [62, 198, 214, 193, 213, 159, 108, 210],
};

function arg(name, def) {
  const i = process.argv.indexOf("--" + name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : def;
}
const DRY = process.env.DRY === "1";
const RPC = arg("rpc", "https://api.mainnet-beta.solana.com");

function loadKeypair(path) {
  const raw = JSON.parse(fs.readFileSync(path.replace(/^~/, os.homedir()), "utf8"));
  if (Array.isArray(raw)) return w3.Keypair.fromSecretKey(Uint8Array.from(raw));
  if (raw.secretArray) return w3.Keypair.fromSecretKey(Uint8Array.from(raw.secretArray));
  if (raw.secretBase58) return w3.Keypair.fromSecretKey(require("bs58").decode(raw.secretBase58));
  throw new Error("unrecognised keypair file shape");
}

const PK = (s) => new w3.PublicKey(s);
const enc = (s) => Buffer.from(s, "utf8");
function poolPda(token, coll) {
  return w3.PublicKey.findProgramAddressSync([enc("pool"), PK(token).toBuffer(), PK(coll).toBuffer()], PK(PROGRAM_ID))[0];
}
function positionPda(pool, asset) {
  return w3.PublicKey.findProgramAddressSync([enc("pos"), pool.toBuffer(), PK(asset).toBuffer()], PK(PROGRAM_ID))[0];
}
function ata(mint, owner, prog) {
  return w3.PublicKey.findProgramAddressSync([PK(owner).toBuffer(), PK(prog).toBuffer(), PK(mint).toBuffer()], PK(ATA_PROGRAM))[0];
}
function ixData(disc, extra) {
  const b = Buffer.alloc(8 + (extra ? extra.length : 0));
  Buffer.from(disc).copy(b, 0);
  if (extra) Buffer.from(extra).copy(b, 8);
  return b;
}
function u64le(n) { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(n)); return b; }
function meta(pubkey, isSigner, isWritable) { return { pubkey: PK(pubkey), isSigner: !!isSigner, isWritable: !!isWritable }; }

async function tokenProgramOf(conn, mint) {
  const info = await conn.getAccountInfo(PK(mint));
  return info && info.owner && info.owner.toBase58() === TOKEN2022 ? TOKEN2022 : TOKENKEG;
}
async function confirm(conn, sig) {
  for (let i = 0; i < 60; i++) {
    const st = await conn.getSignatureStatus(sig, { searchTransactionHistory: true }).catch(() => null);
    const v = st && st.value;
    if (v && v.err) throw new Error("tx failed: " + JSON.stringify(v.err));
    if (v && (v.confirmationStatus === "confirmed" || v.confirmationStatus === "finalized")) return;
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error("not confirmed: " + sig);
}
async function send(conn, kp, ixs, label) {
  const tx = new w3.Transaction().add(...ixs);
  tx.feePayer = kp.publicKey;
  tx.recentBlockhash = (await conn.getLatestBlockhash("confirmed")).blockhash;
  tx.sign(kp);
  const sig = await conn.sendRawTransaction(tx.serialize(), { skipPreflight: false, maxRetries: 5 });
  await confirm(conn, sig);
  console.log("  ✓ " + label + "  " + sig);
  return sig;
}
async function bal(conn, acct) {
  const b = await conn.getTokenAccountBalance(acct).catch(() => null);
  return b ? BigInt(b.value.amount) : 0n;
}

(async () => {
  const conn = new w3.Connection(RPC, "confirmed");
  const kp = loadKeypair(arg("keypair", os.homedir() + "/waves-keys/keeper.json"));
  const token = arg("token"), coll = arg("collection"), asset = arg("asset");
  const reward = arg("reward", WSOL);
  const stakeAmt = BigInt(arg("stake", "1000000"));
  if (!token || !coll || !asset) { console.error("need --token --collection --asset"); process.exit(1); }

  const pool = poolPda(token, coll);
  const pos = positionPda(pool, asset);
  const rewardProg = await tokenProgramOf(conn, reward);
  const tokenProg = await tokenProgramOf(conn, token);
  const vault = ata(reward, pool.toBase58(), rewardProg);
  const stakerTokens = ata(token, kp.publicKey.toBase58(), tokenProg);
  const dest = ata(reward, kp.publicKey.toBase58(), rewardProg);

  console.log("\nStaking rehearsal on " + RPC.replace(/^https?:\/\//, ""));
  console.log("  payer/owner :", kp.publicKey.toBase58());
  console.log("  token(burn) :", token, "(" + (tokenProg === TOKEN2022 ? "T22" : "classic") + ")");
  console.log("  collection  :", coll);
  console.log("  asset (NFT) :", asset);
  console.log("  reward      :", reward, "(" + (rewardProg === TOKEN2022 ? "T22" : "classic") + ")");
  console.log("  pool PDA    :", pool.toBase58());
  console.log("  position    :", pos.toBase58());
  console.log("  vault       :", vault.toBase58());
  console.log("  stake amt   :", stakeAmt.toString(), "| reward:", reward === WSOL ? (arg("depositSol", "0.02") + " SOL") : (arg("depositRaw", "0") + " raw"));
  if (DRY) { console.log("\n[DRY] derived everything, sending nothing."); return; }

  const SYS = "11111111111111111111111111111111";
  const poolExists = !!(await conn.getAccountInfo(pool));

  // 1) init_pool (+ create the vault ATA owned by the pool)
  if (!poolExists) {
    console.log("\n1) init_pool");
    const ixs = [
      splToken.createAssociatedTokenAccountIdempotentInstruction(kp.publicKey, vault, pool, PK(reward), PK(rewardProg)),
      { programId: PK(PROGRAM_ID), keys: [
        meta(pool, 0, 1), meta(token, 0, 0), meta(coll, 0, 0), meta(reward, 0, 0),
        meta(vault.toBase58(), 0, 0), meta(kp.publicKey.toBase58(), 1, 1), meta(rewardProg, 0, 0), meta(SYS, 0, 0),
      ], data: ixData(DISC.init_pool) },
    ];
    await send(conn, kp, ixs, "init_pool");
  } else { console.log("\n1) pool already exists — skipping init_pool"); }

  // 2) stake (burn `stakeAmt` of the paired token → weight on the NFT)
  console.log("\n2) stake (burn " + stakeAmt + ")");
  await send(conn, kp, [{ programId: PK(PROGRAM_ID), keys: [
    meta(pool, 0, 1), meta(pos, 0, 1), meta(asset, 0, 0), meta(token, 0, 1),
    meta(stakerTokens.toBase58(), 0, 1), meta(kp.publicKey.toBase58(), 1, 1), meta(tokenProg, 0, 0), meta(SYS, 0, 0),
  ], data: ixData(DISC.stake, u64le(stakeAmt)) }], "stake");

  // 3) deposit the reward into the vault (this is the KEEPER's job in prod)
  console.log("\n3) deposit reward + sync (the keeper's role)");
  const before = await bal(conn, dest);
  if (reward === WSOL) {
    const lamports = Math.floor(parseFloat(arg("depositSol", "0.02")) * 1e9);
    await send(conn, kp, [
      w3.SystemProgram.transfer({ fromPubkey: kp.publicKey, toPubkey: vault, lamports }),
      splToken.createSyncNativeInstruction(vault),   // WSOL: reflect the lamports as token balance
    ], "deposit " + lamports + " lamports → vault (wrapped)");
  } else {
    const raw = BigInt(arg("depositRaw", "0"));
    if (raw <= 0n) throw new Error("non-WSOL reward needs --depositRaw <amount>");
    const from = ata(reward, kp.publicKey.toBase58(), rewardProg);
    const dec = (await conn.getTokenAccountBalance(from)).value.decimals;
    await send(conn, kp, [splToken.createTransferCheckedInstruction(from, PK(reward), vault, kp.publicKey, raw, dec, [], PK(rewardProg))], "deposit " + raw + " → vault");
  }
  // sync folds the new vault balance into acc_per_weight
  await send(conn, kp, [{ programId: PK(PROGRAM_ID), keys: [meta(pool, 0, 1), meta(vault.toBase58(), 0, 0)], data: ixData(DISC.sync) }], "sync");

  // 4) claim → the payout lands in the owner's reward ATA
  console.log("\n4) claim");
  await send(conn, kp, [
    splToken.createAssociatedTokenAccountIdempotentInstruction(kp.publicKey, dest, kp.publicKey, PK(reward), PK(rewardProg)),
    { programId: PK(PROGRAM_ID), keys: [
      meta(pool, 0, 1), meta(pos, 0, 1), meta(asset, 0, 0), meta(vault.toBase58(), 0, 1),
      meta(reward, 0, 0), meta(dest.toBase58(), 0, 1), meta(kp.publicKey.toBase58(), 1, 0), meta(rewardProg, 0, 0),
    ], data: ixData(DISC.claim) },
  ], "claim");

  const after = await bal(conn, dest);
  const gained = after - before;
  console.log("\n── RESULT ──");
  console.log("  reward ATA before:", before.toString());
  console.log("  reward ATA after :", after.toString());
  console.log("  claimed          :", gained.toString(), gained > 0n ? "✓ LOOP PROVEN" : "✗ nothing claimed — check weight/deposit/sync");
})().catch((e) => { console.error("FATAL:", e.message); process.exit(1); });
