#!/usr/bin/env node
/* create-launch-alt.js — creates + populates an Address Lookup Table (ALT) with
 * WAVES's STATIC LaunchLab launch/trade accounts, so v0 launch and buy/sell txs
 * shrink and leave Phantom's Lighthouse enough headroom under the 1232-byte limit.
 *
 * Measured 2026-09-17: v0 launch 1061 B (171 headroom), sell 927 B (305). Raydium's
 * default ALT already tables the common system programs; this custom ALT adds the
 * LaunchLab program + its PDAs + OUR platform configs + the SOL/USDC curve configs,
 * which the default doesn't — tabling ~15 more static accounts saves ~480 B.
 *
 * Run (DRY-RUN by default — prints the plan; CONFIRM=1 actually creates it):
 *   KEYPAIR=~/waves-keys/some-funded-key.json CONFIRM=1 node tools/create-launch-alt.js
 * Needs ~0.01 SOL. The keypair is the ALT's authority (can extend/close it later).
 * Prints the ALT address to paste into brand.js `launchAlt["mainnet-beta"]`. */

const os = require("os");
const fs = require("fs");
const w3 = require("@solana/web3.js");
const r = require("@raydium-io/raydium-sdk-v2");

const RPC = process.env.SOLANA_RPC || process.env.RPC || "https://api.mainnet-beta.solana.com";
const CONFIRM = process.env.CONFIRM === "1";
const PROG = r.LAUNCHPAD_PROGRAM;
const PK = (s) => new w3.PublicKey(s);

function loadKey() {
  const p = process.env.KEYPAIR;
  if (!p) throw new Error("set KEYPAIR=<path to a funded keypair json (array or {secretArray})>");
  const raw = JSON.parse(fs.readFileSync(p.replace(/^~/, os.homedir()), "utf8"));
  if (Array.isArray(raw)) return w3.Keypair.fromSecretKey(Uint8Array.from(raw));
  if (raw.secretArray) return w3.Keypair.fromSecretKey(Uint8Array.from(raw.secretArray));
  if (raw.secretBase58) return w3.Keypair.fromSecretKey(require("bs58").decode(raw.secretBase58));
  throw new Error("unrecognized keypair format");
}

(async () => {
  const conn = new w3.Connection(RPC, "confirmed");
  const auth = loadKey();
  const WSOL = PK("So11111111111111111111111111111111111111112");
  const USDC = PK("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");

  const addresses = [
    // programs / sysvars every launch + trade touches
    PROG,
    PK("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"),          // Token
    PK("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb"),          // Token-2022
    PK("11111111111111111111111111111111"),                    // System
    PK("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL"),         // ATA
    PK("SysvarRent111111111111111111111111111111111"),         // Rent
    PK("metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s"),          // Metaplex metadata
    PK("ComputeBudget111111111111111111111111111111"),         // ComputeBudget
    // LaunchLab PDAs (static)
    r.getPdaLaunchpadAuth(PROG).publicKey,                     // vault authority
    w3.PublicKey.findProgramAddressSync([Buffer.from("__event_authority")], PROG)[0],
    // OUR platform configs (standard + tier ladder)
    PK("iaidSbPCBvzZVSnLdQUHWJFXL2j6oQt386QZ6fTfBoi"),          // standard
    PK("GfC5UWEn3WnFQcqB4ddBKRCYnKMaB6Ch5ReqS4MhVLze"),         // t2
    PK("Dcd5CnsLZkmzGa298XNBqiB7aQLmR6AC6c4LP4ELmuik"),         // t3
    PK("AoiEDaYTFVeLCaBtMToNWe2BEq4LiFAfzvjCetxuG1ux"),         // t4
    PK("3J6A7dtV2rS7GP7khzQBfRnpKrBjz5Srfjj51zTGefaT"),         // t5
    // the SOL + USDC quote mints + their global curve configs (the common quotes)
    WSOL, USDC,
    r.getPdaLaunchpadConfigId(PROG, WSOL, 0, 0).publicKey,
    r.getPdaLaunchpadConfigId(PROG, USDC, 0, 0).publicKey,
  ];

  console.log("cluster:", RPC.replace(/^https?:\/\//, ""));
  console.log("authority:", auth.publicKey.toBase58());
  console.log("addresses to table (" + addresses.length + "):");
  addresses.forEach((a) => console.log("  " + a.toBase58()));

  const bal = await conn.getBalance(auth.publicKey);
  console.log("\nauthority balance:", (bal / 1e9).toFixed(4), "SOL");

  if (!CONFIRM) {
    console.log("\nDRY RUN — set CONFIRM=1 to create the ALT and extend it with the above.");
    return;
  }
  if (bal < 0.01e9) throw new Error("fund the authority with ~0.01 SOL first");

  const slot = await conn.getSlot("finalized");
  const [createIx, altAddress] = w3.AddressLookupTableProgram.createLookupTable({
    authority: auth.publicKey, payer: auth.publicKey, recentSlot: slot,
  });
  console.log("\nALT address:", altAddress.toBase58());

  // create
  await sendIxs(conn, auth, [createIx]);
  // extend in chunks (≤ ~20 addresses per tx to stay under size)
  for (let i = 0; i < addresses.length; i += 18) {
    const chunk = addresses.slice(i, i + 18);
    await sendIxs(conn, auth, [w3.AddressLookupTableProgram.extendLookupTable({
      authority: auth.publicKey, payer: auth.publicKey, lookupTable: altAddress, addresses: chunk,
    })]);
    console.log("  extended +" + chunk.length);
  }

  console.log("\n✅ ALT created + populated:", altAddress.toBase58());
  console.log("Paste into brand.js  launchAlt: { \"mainnet-beta\": \"" + altAddress.toBase58() + "\" }");
  console.log("(An ALT must be one slot old before it can be used — wait a few seconds.)");
})().catch((e) => { console.error("FATAL:", e.message); process.exit(1); });

async function sendIxs(conn, payer, ixs) {
  const tx = new w3.Transaction().add(...ixs);
  tx.feePayer = payer.publicKey;
  tx.recentBlockhash = (await conn.getLatestBlockhash("confirmed")).blockhash;
  tx.sign(payer);
  const sig = await conn.sendRawTransaction(tx.serialize(), { maxRetries: 5 });
  await conn.confirmTransaction(sig, "confirmed");
  return sig;
}
