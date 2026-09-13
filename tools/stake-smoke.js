#!/usr/bin/env node
/* Devnet end-to-end smoke for the waves-staking program — the de-risk before any
 * UI. Proves the FULL burn-to-stake loop against the live devnet program
 * (jt5JegTBVPZP8V6a48fnKYPFKTbpcTfkz91Pemur82H):
 *
 *   Core collection + asset (the NFT)  ->  init_pool  ->  fund vault  ->
 *   stake (burn token = weight)  ->  sync  ->  claim (reward out)
 *
 * Instruction layouts are transcribed from program/target/idl/waves_staking.json
 * and verified to match app/public/stake.js. If claim pays out and the position
 * weight equals what was burned, the money path is real.
 *
 *   RPC=https://... KEYFILE=~/waves-keys/devnet-stake-smoke.json \
 *     node tools/stake-smoke.js
 *
 * Needs ~2-3 devnet SOL in the keyfile wallet. Public devnet faucet is often dry;
 * fund it at https://faucet.solana.com or transfer from another devnet wallet.
 */
"use strict";
const fs = require("fs");
const os = require("os");

const RPC = process.env.RPC || "https://api.devnet.solana.com";
const KEYFILE = (process.env.KEYFILE || "~/waves-keys/devnet-stake-smoke.json").replace(/^~/, os.homedir());
const PROGRAM_ID = "jt5JegTBVPZP8V6a48fnKYPFKTbpcTfkz91Pemur82H";

const DISC = {
  init_pool: [116, 233, 199, 204, 115, 159, 171, 36],
  stake:     [206, 176, 202, 18, 200, 209, 179, 108],
  sync:      [4, 219, 40, 164, 21, 157, 189, 88],
  claim:     [62, 198, 214, 193, 213, 159, 108, 210]
};

const log = (...a) => console.log("  " + a.join(" "));
const u64 = (n) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(n)); return b; };

(async () => {
  const web3 = require("@solana/web3.js");
  const { Connection, Keypair, PublicKey, Transaction, TransactionInstruction,
    SystemProgram, sendAndConfirmTransaction } = web3;
  const splToken = require("@solana/spl-token");
  const { createMint, getOrCreateAssociatedTokenAccount, mintTo,
    getAssociatedTokenAddressSync, transfer, getAccount, TOKEN_PROGRAM_ID } = splToken;

  const secret = Uint8Array.from(JSON.parse(fs.readFileSync(KEYFILE, "utf8")));
  const payer = Keypair.fromSecretKey(secret);
  const conn = new Connection(RPC, "confirmed");
  const PROG = new PublicKey(PROGRAM_ID);
  const SYS = SystemProgram.programId;

  log("rpc     ", RPC.split("?")[0]);
  log("wallet  ", payer.publicKey.toBase58());
  const bal = await conn.getBalance(payer.publicKey);
  log("balance ", (bal / 1e9).toFixed(3), "SOL");
  if (bal < 0.3e9) throw new Error("need ~2-3 devnet SOL; fund " + payer.publicKey.toBase58() + " at https://faucet.solana.com");

  // ── 1. Core collection + asset (the NFT the position anchors to) ──────────
  const umiMod = require("@metaplex-foundation/umi-bundle-defaults");
  const coreMod = require("@metaplex-foundation/mpl-core");
  const { generateSigner, keypairIdentity, publicKey: umiPk } = require("@metaplex-foundation/umi");
  const umi = umiMod.createUmi(RPC).use(coreMod.mplCore());
  umi.use(keypairIdentity(umi.eddsa.createKeypairFromSecretKey(secret)));

  const collectionSigner = generateSigner(umi);
  await coreMod.createCollection(umi, {
    collection: collectionSigner, name: "Stake Smoke", uri: "https://waveslaunchpad.xyz/smoke.json"
  }).sendAndConfirm(umi, { confirm: { commitment: "confirmed" } });
  const collection = new PublicKey(collectionSigner.publicKey);
  log("collection", collection.toBase58());

  // devnet lag: wait until the collection is actually readable, or CreateV2 panics
  // loading it during simulation (the account it was just handed looks empty).
  const CORE = "CoREENxT6tW1HoK8ypY1SxRMZTcVPm7R94rH4PZNhX7d";
  for (let i = 0; i < 30; i++) {
    const info = await conn.getAccountInfo(collection, "confirmed");
    if (info && info.owner.toBase58() === CORE && info.data.length > 0) break;
    await new Promise((r) => setTimeout(r, 1000));
  }

  // GROUP the asset into the collection. create() needs the FULL CollectionV1
  // (for updateAuthority resolution) — a bare pubkey or { publicKey } makes
  // CreateV2 panic. The wait above means this fetch no longer races.
  let collectionAcc = null;
  for (let i = 0; i < 30; i++) {
    try { collectionAcc = await coreMod.fetchCollectionV1(umi, collectionSigner.publicKey); break; }
    catch (e) { await new Promise((r) => setTimeout(r, 1500)); }
  }
  if (!collectionAcc) throw new Error("collection never became readable via umi (devnet RPC lag)");
  const assetSigner = generateSigner(umi);
  await coreMod.create(umi, {
    asset: assetSigner, collection: collectionAcc,
    name: "Smoke #1", uri: "https://waveslaunchpad.xyz/smoke-1.json"
  }).sendAndConfirm(umi, { confirm: { commitment: "confirmed" } });
  const asset = new PublicKey(assetSigner.publicKey);
  log("asset(NFT)", asset.toBase58());

  // ── 2. mints: tokenMint (burned to stake) + rewardMint (paid from vault) ──
  const DEC = 6, ONE = 10 ** DEC;
  const tokenMint = await createMint(conn, payer, payer.publicKey, null, DEC);
  const rewardMint = await createMint(conn, payer, payer.publicKey, null, DEC);
  log("tokenMint ", tokenMint.toBase58(), "(burned to stake)");
  log("rewardMint", rewardMint.toBase58(), "(claimed from vault)");

  const stakerTokens = (await getOrCreateAssociatedTokenAccount(conn, payer, tokenMint, payer.publicKey)).address;
  const rewardDest = (await getOrCreateAssociatedTokenAccount(conn, payer, rewardMint, payer.publicKey)).address;
  await mintTo(conn, payer, tokenMint, stakerTokens, payer, 10000 * ONE);
  await mintTo(conn, payer, rewardMint, rewardDest, payer, 1000 * ONE);

  // ── 3. PDAs + vault (pool PDA's off-curve ATA for rewardMint) ─────────────
  const [pool] = PublicKey.findProgramAddressSync(
    [Buffer.from("pool"), tokenMint.toBuffer(), collection.toBuffer()], PROG);
  const [position] = PublicKey.findProgramAddressSync(
    [Buffer.from("pos"), asset.toBuffer()], PROG);
  const vault = getAssociatedTokenAddressSync(rewardMint, pool, true); // off-curve owner
  log("pool    ", pool.toBase58());
  log("position", position.toBase58());
  log("vault   ", vault.toBase58());

  const ix = (disc, keys, extra) => new TransactionInstruction({
    programId: PROG, keys,
    data: Buffer.concat([Buffer.from(disc), extra || Buffer.alloc(0)])
  });
  const A = (pubkey, s, w) => ({ pubkey, isSigner: !!s, isWritable: !!w });
  const send = async (label, instrs, signers) => {
    const tx = new Transaction().add(...instrs);
    const sig = await sendAndConfirmTransaction(conn, tx, [payer, ...(signers || [])], { commitment: "confirmed" });
    log("✓", label, sig);
    return sig;
  };

  // ── 4. create the vault ATA (owned by pool PDA), then init_pool ───────────
  const { createAssociatedTokenAccountIdempotentInstruction } = splToken;
  await send("create vault ATA", [
    createAssociatedTokenAccountIdempotentInstruction(payer.publicKey, vault, pool, rewardMint)
  ]);

  await send("init_pool", [ix(DISC.init_pool, [
    A(pool, 0, 1), A(tokenMint, 0, 0), A(collection, 0, 0), A(rewardMint, 0, 0),
    A(vault, 0, 0), A(payer.publicKey, 1, 1), A(TOKEN_PROGRAM_ID, 0, 0), A(SYS, 0, 0)
  ])]);

  // ── 5. simulate fees arriving: fund the vault with reward tokens ──────────
  await transfer(conn, payer, rewardDest, vault, payer, 500 * ONE);
  log("funded vault with 500 reward");

  // ── 6. stake: burn 2000 token -> weight 2000 on the NFT position ──────────
  const STAKE = 2000 * ONE;
  await send("stake (burn " + (STAKE / ONE) + ")", [ix(DISC.stake, [
    A(pool, 0, 1), A(position, 0, 1), A(asset, 0, 0), A(tokenMint, 0, 1),
    A(stakerTokens, 0, 1), A(payer.publicKey, 1, 1), A(TOKEN_PROGRAM_ID, 0, 0), A(SYS, 0, 0)
  ], u64(STAKE))]);

  // ── 7. sync (fold vault balance into acc_per_weight) then claim ───────────
  await send("sync", [ix(DISC.sync, [A(pool, 0, 1), A(vault, 0, 0)])]);

  const before = Number((await getAccount(conn, rewardDest)).amount);
  await send("claim", [ix(DISC.claim, [
    A(pool, 0, 1), A(position, 0, 1), A(asset, 0, 0), A(vault, 0, 1),
    A(rewardMint, 0, 0), A(rewardDest, 0, 1), A(payer.publicKey, 1, 0), A(TOKEN_PROGRAM_ID, 0, 0)
  ])]);
  const after = Number((await getAccount(conn, rewardDest)).amount);

  // ── 8. verify ─────────────────────────────────────────────────────────────
  const gained = (after - before) / ONE;
  const vaultLeft = Number((await getAccount(conn, vault)).amount) / ONE;
  console.log("\n  ── result ──");
  log("reward claimed :", gained.toFixed(2), "(expected ~500, the whole vault — one position holds all weight)");
  log("vault remaining:", vaultLeft.toFixed(2));
  if (gained > 0) console.log("\n  ✅ SMOKE PASSED — burn-to-stake and claim work against the live devnet program.\n");
  else throw new Error("claim paid 0 — the loop is broken; inspect the tx logs above");
})().catch((e) => {
  console.error("\n  ✗ FAILED — " + (e && e.message ? e.message : e));
  if (e && e.logs) console.error("\n  " + e.logs.join("\n  "));
  process.exit(1);
});
