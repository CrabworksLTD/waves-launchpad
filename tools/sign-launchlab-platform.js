#!/usr/bin/env node
/*
 * sign-launchlab-platform.js — create the WAVES PlatformConfig on Raydium
 * LaunchLab (once per cluster). This is the LaunchLab analogue of the DBC config
 * signer: it's what makes stock-quoted launches earn OUR fee. Permissionless —
 * createPlatformConfig has a single signer (the payer/admin); no Raydium key.
 *
 * The platform carries: our trading feeRate, our fee-claim wallet, the LP split,
 * and the reward-mode transfer-fee authority. platformId is a PDA of
 * (program, platformAdmin), so it's deterministic and created exactly once.
 *
 * After it lands, paste the printed platformId into
 *   brand.js → launchlabConfigs[<cluster>].platformId
 *
 * Dry-run by default (prints params + the derived platformId). Set CONFIRM=1 to
 * actually create it.
 *
 * Usage:
 *   CLUSTER=mainnet-beta KEYFILE=~/waves-keys/<admin>.json node tools/sign-launchlab-platform.js
 *   CLUSTER=mainnet-beta KEYFILE=... CONFIRM=1 node tools/sign-launchlab-platform.js  (defaults: 0.4% platform + 0.5% creator = 1.15% with Raydium's 0.25%)
 *
 * ⚠️ platformAdmin = the payer keypair. It controls the platform (updatePlatformConfig)
 * forever, so use a key you keep. Devnet gotchas baked in (proven in launchlab-smoke.js):
 * platform_scale must be 0; platform+creator+burn must sum to 1e6.
 */
"use strict";
const fs = require("fs");
const os = require("os");
const BN = require("bn.js");
const r = require("@raydium-io/raydium-sdk-v2");
const { Connection, Keypair, PublicKey } = require("@solana/web3.js");

const CLUSTER = process.env.CLUSTER || "mainnet-beta";
const KEYFILE = (process.env.KEYFILE || "").replace(/^~/, os.homedir());
const RPC = process.env.RPC || (CLUSTER === "devnet"
  ? "https://api.devnet.solana.com" : "https://api.mainnet-beta.solana.com");
// On-chain fee rates use denominator 1e6, so 1% = 10000 (verified: SPYx config's
// tradeFeeRate 2500 = 0.25%). WAVES Solana fee ladder totals 1.15% on a trade:
//   0.25% Raydium (the global config's fixed protocol fee, not set here)
// + 0.40% platform  (feeRate → our fee vault)
// + 0.50% creator   (creatorFeeRate → the pool creator, charged on the curve)
// All three ADD (proven additive + landing exactly, in launchlab-fee-check.js).
// ⚠️ creatorFeeRate is HARD-CAPPED at 5000 (0.5%) by the program — 5001 reverts
// (RequireGt/InvalidPlatformInfo). Rates are raw 1e6 units, not basis points.
const PLATFORM_FEE = parseInt(process.env.PLATFORM_FEE || "4000", 10);   // 0.40%
const CREATOR_FEE  = parseInt(process.env.CREATOR_FEE  || "5000", 10);   // 0.50% (program max)
const CONFIRM = process.env.CONFIRM === "1";

// WAVES treasury addresses (kept in sync with app/public/brand.js)
const FEE_OWNER = "BU9dYi7fGw5G3Wd54CUTmt1Y58jEJaPq8LKiL72ydeKJ";
const FEE_KEEPER = "EFFY1LjZbzzEYuUr24udxWponKqtta8MaxZxs6HGPswH";

(async () => {
  if (!KEYFILE) throw new Error("Set KEYFILE to the platform-admin keypair (JSON secret array).");
  const conn = new Connection(RPC, "confirmed");
  const admin = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(KEYFILE, "utf8"))));
  const prog = CLUSTER === "devnet" ? r.DEV_LAUNCHPAD_PROGRAM : r.LAUNCHPAD_PROGRAM;
  const platformId = r.getPdaPlatformId(prog, admin.publicKey).publicKey;

  // A CPMM AmmConfig for the graduated pool. Derived index-0 for the cluster's
  // CPMM program (matches what Raydium's own default platform stores).
  const cpmmProg = CLUSTER === "devnet"
    ? r.DEVNET_PROGRAM_ID.CREATE_CPMM_POOL_PROGRAM
    : r.CREATE_CPMM_POOL_PROGRAM;
  const cpConfigId = r.getCpmmPdaAmmConfigId(cpmmProg, 0).publicKey;

  const feeOwner = new PublicKey(FEE_OWNER);
  const feeKeeper = new PublicKey(FEE_KEEPER);

  console.log("cluster:      ", CLUSTER);
  console.log("program:      ", prog.toBase58());
  console.log("platformAdmin:", admin.publicKey.toBase58(), "(payer, controls the platform)");
  console.log("platformId:   ", platformId.toBase58(), "  <-- paste into brand.js");
  console.log("platform fee: ", PLATFORM_FEE, "(" + (PLATFORM_FEE / 10000) + "% → our vault)");
  console.log("creator fee:  ", CREATOR_FEE, "(" + (CREATOR_FEE / 10000) + "% → creator)");
  console.log("+ Raydium protocol fee 0.25% (fixed on the config) = 1.15% total");
  console.log("claim wallet: ", feeOwner.toBase58(), "(where our platform fees claim to)");
  console.log("xferFeeAuth:  ", feeKeeper.toBase58(), "(reward-mode harvest authority)");
  console.log("cpConfigId:   ", cpConfigId.toBase58());

  const existing = await conn.getAccountInfo(platformId);
  if (existing) { console.log("\n✓ platform already exists — nothing to do."); return; }

  if (!CONFIRM) {
    console.log("\n[dry run] set CONFIRM=1 to create it. No transaction sent.");
    return;
  }

  const Raydium = r.Raydium || r.default;
  const raydium = await Raydium.load({ connection: conn, owner: admin, cluster: CLUSTER,
    disableFeatureCheck: true, disableLoadToken: true });
  const { execute } = await raydium.launchpad.createPlatformConfig({
    programId: prog,
    platformAdmin: admin.publicKey,
    platformClaimFeeWallet: feeOwner,
    platformLockNftWallet: feeOwner,
    platformVestingWallet: feeOwner,
    cpConfigId,
    // LP split at graduation. platform_scale MUST be 0; the rest must sum to 1e6.
    // 100% burn matches a buyback-burn posture; adjust later via updatePlatformConfig.
    migrateCpLockNftScale: { platformScale: new BN(0), creatorScale: new BN(0), burnScale: new BN(1000000) },
    transferFeeExtensionAuth: feeKeeper,
    creatorFeeRate: new BN(CREATOR_FEE),
    feeRate: new BN(PLATFORM_FEE),
    name: "WAVES",
    web: "https://waveslaunchpad.xyz",
    img: "https://waveslaunchpad.xyz/og.png",
    txVersion: r.TxVersion.LEGACY,
  });
  const sig = await execute({ sendAndConfirm: true, sequentially: true });
  console.log("\n✅ platform created. tx:", (sig.txId || (sig.txIds && sig.txIds[0]) || sig));
  console.log("   → set brand.js launchlabConfigs['" + CLUSTER + "'].platformId =",
    JSON.stringify(platformId.toBase58()));
})().catch((e) => { console.error("\n❌", e.message); process.exit(1); });
