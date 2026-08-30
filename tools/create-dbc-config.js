#!/usr/bin/env node
/* Create the Meteora DBC partner config key. Run once per quote asset.
 *
 *   CONFIG_SECRET=<base58 64-byte secret key> node tools/create-dbc-config.js
 *   CONFIG_SECRET=... QUOTE=usdc CLUSTER=devnet node tools/create-dbc-config.js
 *
 * The config key is the launchpad. It fixes the quote mint, the curve shape,
 * the fee split and the migration rules for every token launched against it,
 * and those are not editable afterwards — a new config means a new launchpad
 * and tokens already launched keep the old terms. Read the numbers below
 * before running this against mainnet.
 *
 * Fee split, 60 platform / 20 creator as decided 2026-08-30:
 *   20%  Meteora, fixed by the protocol
 *   80%  LP fee, of which creatorTradingFeePercentage goes to the creator
 *        -> 25 means 60% platform / 20% creator of the total trading fee
 *
 * The wallet that signs this owns the config and is the address that claims the
 * platform's share forever. Use a key you are willing to still control in two
 * years, not a throwaway.
 */
"use strict";

const fs = require("fs");
const path = require("path");

const CLUSTERS = {
  "mainnet-beta": "https://api.mainnet-beta.solana.com",
  devnet: "https://api.devnet.solana.com"
};

/* The terms live in app/public/dbc-terms.js, SHARED with the sign-in-browser
 * page (config-create.html) so the two can never drift. The unit warnings and
 * the reasoning behind every enum live there too. */
const { TERMS, QUOTES, buildParams } = require(path.join(__dirname, "..", "app", "public", "dbc-terms.js"));

const CLUSTER = process.env.CLUSTER || "devnet";
const QUOTE = QUOTES[(process.env.QUOTE || "sol").toLowerCase()];
const DRY = process.argv.includes("--dry-run");

(async () => {
  const {
    DynamicBondingCurveClient, buildCurveWithMarketCap,
    ActivationType, BaseFeeMode, CollectFeeMode, TokenDecimal,
    TokenType, MigrationOption, MigrationFeeOption, TokenAuthorityOption
  } = await import("@meteora-ag/dynamic-bonding-curve-sdk");
  const { Connection, Keypair, PublicKey } = await import("@solana/web3.js");
  const bs58 = (await import("bs58")).default;

  if (!QUOTE) { console.error("QUOTE must be sol or usdc"); process.exit(1); }

  console.log("  cluster      " + CLUSTER);
  console.log("  quote        " + QUOTE.label + "  " + QUOTE.mint);
  console.log("  supply       " + TERMS.totalTokenSupply.toLocaleString());
  // Print the USD equivalent too. The units are the single easiest thing to get
  // wrong here and the hardest to notice, because a wrong number still looks
  // like a number.
  let usd = null;
  try {
    const px = await fetch("https://api.coinbase.com/v2/prices/" +
      (QUOTE.label === "SOL" ? "SOL-USD" : "USDC-USD") + "/spot").then((r) => r.json());
    usd = Number(px.data.amount);
  } catch (e) { /* summary only */ }
  const inUsd = (n) => (usd ? "  (~$" + Math.round(n * usd).toLocaleString() + ")" : "");
  console.log("  curve        " + QUOTE.initialMarketCap.toLocaleString() + " " + QUOTE.label +
              inUsd(QUOTE.initialMarketCap));
  console.log("               -> " + QUOTE.migrationMarketCap.toLocaleString() + " " + QUOTE.label +
              inUsd(QUOTE.migrationMarketCap) + "  at graduation");
  console.log("  trading fee  " + (TERMS.baseFeeBps / 100) + "%");
  console.log("  split        20% Meteora / " +
              (80 * (100 - TERMS.creatorTradingFeePercentage) / 100) + "% platform / " +
              (80 * TERMS.creatorTradingFeePercentage / 100) + "% creator");
  console.log();

  /* The params are nested by concern, not flat. Every enum here is a real
   * decision:
   *   Immutable          — the token's metadata cannot be changed after launch,
   *                        which removes the "dev edited the name" rug
   *   QuoteToken         — fees accrue in SOL/USDC rather than in the new token,
   *                        so a reward vault holds something worth holding
   *   flat fee schedule  — start and end at the same bps. A decaying schedule
   *                        taxes early buyers, which is a launchpad choosing
   *                        sides against the people taking the most risk
   *   locked LP 50/50    — neither side can pull liquidity after graduation
   */
  const curve = buildCurveWithMarketCap(buildParams({
    ActivationType, BaseFeeMode, CollectFeeMode, TokenDecimal,
    TokenType, MigrationOption, MigrationFeeOption, TokenAuthorityOption
  }, (process.env.QUOTE || "sol").toLowerCase()));

  if (DRY) {
    // Only BN and PublicKey get stringified; a blanket toString() turns every
    // nested object into "[object Object]" and reviews nothing.
    const show = (k, v) => {
      if (v && typeof v === "object" && !Array.isArray(v)) {
        const c = v.constructor && v.constructor.name;
        if (c === "BN" || c === "PublicKey") return v.toString();
      }
      return v;
    };
    console.log("  --dry-run: curve built, nothing sent\n");
    console.log(JSON.stringify(curve, show, 2));
    return;
  }

  // CONFIG_KEYFILE (a solana-keygen JSON file) is preferred: the secret never
  // appears in the shell environment or history, only a path does.
  let secret = null;
  if (process.env.CONFIG_KEYFILE) {
    secret = Uint8Array.from(JSON.parse(fs.readFileSync(process.env.CONFIG_KEYFILE, "utf8")));
  } else if (process.env.CONFIG_SECRET) {
    secret = bs58.decode(process.env.CONFIG_SECRET);
  } else {
    console.error("  Set CONFIG_KEYFILE=<path to solana-keygen json> (preferred)");
    console.error("  or CONFIG_SECRET=<base58 secret key>.\n");
    console.error("  This wallet permanently owns the config and claims the platform's");
    console.error("  fee share. Use a key you will still control in two years.");
    process.exit(1);
  }

  const payer = Keypair.fromSecretKey(secret);
  const conn = new Connection(CLUSTERS[CLUSTER], "confirmed");
  const client = new DynamicBondingCurveClient(conn, "confirmed");
  const config = Keypair.generate();

  console.log("  owner        " + payer.publicKey.toBase58());
  console.log("  config       " + config.publicKey.toBase58());
  console.log();

  const tx = await client.partner.createConfig({
    config: config.publicKey,
    feeClaimer: payer.publicKey,
    leftoverReceiver: payer.publicKey,
    payer: payer.publicKey,
    quoteMint: new PublicKey(QUOTE.mint),
    ...curve
  });

  tx.feePayer = payer.publicKey;
  tx.recentBlockhash = (await conn.getLatestBlockhash("confirmed")).blockhash;
  tx.sign(payer, config);
  const sig = await conn.sendRawTransaction(tx.serialize());
  await conn.confirmTransaction(sig, "confirmed");

  console.log("  created      " + sig);
  console.log();
  console.log("  Put this in app/public/brand.js as dbcConfig:");
  console.log();
  console.log("    dbcConfig: \"" + config.publicKey.toBase58() + "\",");
  console.log();

  const out = path.join(__dirname, "..", ".dbc-config-" + CLUSTER + "-" + (process.env.QUOTE || "sol") + ".json");
  fs.writeFileSync(out, JSON.stringify({
    cluster: CLUSTER, quote: QUOTE.label, quoteMint: QUOTE.mint,
    config: config.publicKey.toBase58(), owner: payer.publicKey.toBase58(),
    terms: TERMS, signature: sig, createdAt: new Date().toISOString()
  }, null, 2) + "\n");
  console.log("  recorded in " + path.basename(out));
})().catch((e) => {
  console.error("\n  FAILED — " + (e && e.message ? e.message : e));
  if (e && e.logs) console.error("\n  " + e.logs.join("\n  "));
  process.exit(1);
});
