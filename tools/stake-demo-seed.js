#!/usr/bin/env node
/* Seed a devnet demo pair so a real wallet (your Phantom on devnet) can stake in
 * the browser. Creates a Core collection + an NFT OWNED BY YOU, a paired token
 * (sent to you, to burn), a reward mint, inits the staking pool, and funds the
 * vault. Prints the /stake URL to open.
 *
 * Same proven path as tools/stake-smoke.js — this just mints to YOUR wallet
 * instead of the payer and stops before staking, so you do that step live.
 *
 *   OWNER=<your devnet Phantom address> \
 *   KEYFILE=~/waves-keys/devnet-stake-smoke.json \
 *   node tools/stake-demo-seed.js
 */
"use strict";
const fs = require("fs"), os = require("os");
const RPC = process.env.RPC || "https://api.devnet.solana.com";
const KEYFILE = (process.env.KEYFILE || "~/waves-keys/devnet-stake-smoke.json").replace(/^~/, os.homedir());
const OWNER = process.env.OWNER;
const PROGRAM_ID = "jt5JegTBVPZP8V6a48fnKYPFKTbpcTfkz91Pemur82H";
const DISC = { init_pool: [116, 233, 199, 204, 115, 159, 171, 36] };
const log = (...a) => console.log("  " + a.join(" "));

(async () => {
  if (!OWNER) throw new Error("set OWNER=<your devnet wallet address>");
  const web3 = require("@solana/web3.js");
  const { Connection, Keypair, PublicKey, Transaction, TransactionInstruction, SystemProgram, sendAndConfirmTransaction } = web3;
  const spl = require("@solana/spl-token");
  const secret = Uint8Array.from(JSON.parse(fs.readFileSync(KEYFILE, "utf8")));
  const payer = Keypair.fromSecretKey(secret);
  const conn = new Connection(RPC, "confirmed");
  const PROG = new PublicKey(PROGRAM_ID), owner = new PublicKey(OWNER);
  const DEC = 6, ONE = 10 ** DEC;

  log("payer ", payer.publicKey.toBase58());
  log("owner ", owner.toBase58(), "(gets the NFT + tokens)");
  if ((await conn.getBalance(payer.publicKey)) < 0.3e9) throw new Error("fund the payer with devnet SOL");

  // Core collection + asset owned by OWNER
  const umiMod = require("@metaplex-foundation/umi-bundle-defaults");
  const core = require("@metaplex-foundation/mpl-core");
  const { generateSigner, keypairIdentity, publicKey: uPk } = require("@metaplex-foundation/umi");
  const umi = umiMod.createUmi(RPC).use(core.mplCore());
  umi.use(keypairIdentity(umi.eddsa.createKeypairFromSecretKey(secret)));

  const cSigner = generateSigner(umi);
  await core.createCollection(umi, { collection: cSigner, name: "WAVES Demo Pair", uri: "https://waveslaunchpad.xyz/demo.json" })
    .sendAndConfirm(umi, { confirm: { commitment: "confirmed" } });
  const collection = new PublicKey(cSigner.publicKey);
  log("collection", collection.toBase58());
  const CORE = "CoREENxT6tW1HoK8ypY1SxRMZTcVPm7R94rH4PZNhX7d";
  for (let i = 0; i < 30; i++) { const x = await conn.getAccountInfo(collection, "confirmed"); if (x && x.owner.toBase58() === CORE) break; await new Promise((r) => setTimeout(r, 1000)); }
  let cAcc = null;
  for (let i = 0; i < 30; i++) { try { cAcc = await core.fetchCollectionV1(umi, cSigner.publicKey); break; } catch (e) { await new Promise((r) => setTimeout(r, 1500)); } }

  const aSigner = generateSigner(umi);
  await core.create(umi, { asset: aSigner, collection: cAcc, owner: uPk(owner.toBase58()), name: "WAVES Demo #1", uri: "https://waveslaunchpad.xyz/demo-1.json" })
    .sendAndConfirm(umi, { confirm: { commitment: "confirmed" } });
  log("NFT -> owner", aSigner.publicKey);

  // mints
  const tokenMint = await spl.createMint(conn, payer, payer.publicKey, null, DEC);
  const rewardMint = await spl.createMint(conn, payer, payer.publicKey, null, DEC);
  log("tokenMint ", tokenMint.toBase58());
  log("rewardMint", rewardMint.toBase58());
  // send paired tokens to OWNER so they can burn-to-stake
  const ownerTok = (await spl.getOrCreateAssociatedTokenAccount(conn, payer, tokenMint, owner)).address;
  await spl.mintTo(conn, payer, tokenMint, ownerTok, payer, 100000 * ONE);
  log("sent 100000 token to owner");

  // pool + vault
  const [pool] = PublicKey.findProgramAddressSync([Buffer.from("pool"), tokenMint.toBuffer(), collection.toBuffer()], PROG);
  const vault = spl.getAssociatedTokenAddressSync(rewardMint, pool, true);
  await sendAndConfirmTransaction(conn, new Transaction().add(
    spl.createAssociatedTokenAccountIdempotentInstruction(payer.publicKey, vault, pool, rewardMint)), [payer], { commitment: "confirmed" });
  const A = (pubkey, s, w) => ({ pubkey, isSigner: !!s, isWritable: !!w });
  await sendAndConfirmTransaction(conn, new Transaction().add(new TransactionInstruction({
    programId: PROG, data: Buffer.from(DISC.init_pool),
    keys: [A(pool, 0, 1), A(tokenMint, 0, 0), A(collection, 0, 0), A(rewardMint, 0, 0), A(vault, 0, 0),
      A(payer.publicKey, 1, 1), A(spl.TOKEN_PROGRAM_ID, 0, 0), A(SystemProgram.programId, 0, 0)]
  })), [payer], { commitment: "confirmed" });
  log("init_pool ok, pool", pool.toBase58());
  // fund the vault with reward tokens (simulate accrued fees)
  const payerReward = (await spl.getOrCreateAssociatedTokenAccount(conn, payer, rewardMint, payer.publicKey)).address;
  await spl.mintTo(conn, payer, rewardMint, payerReward, payer, 5000 * ONE);
  await spl.transfer(conn, payer, payerReward, vault, payer, 5000 * ONE);
  log("funded vault with 5000 reward");

  console.log("\n  ✅ demo pair ready. Open (on a DEVNET-pointed build), connect the OWNER wallet, and stake:\n");
  console.log("     /stake?token=" + tokenMint.toBase58() + "&collection=" + collection.toBase58() + "&sym=DEMO\n");
})().catch((e) => { console.error("\n  ✗ " + (e && e.message ? e.message : e)); if (e && e.logs) console.error("  " + e.logs.join("\n  ")); process.exit(1); });
