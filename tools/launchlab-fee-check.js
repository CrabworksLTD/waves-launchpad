#!/usr/bin/env node
/*
 * launchlab-fee-check.js — PROVE the WAVES Solana fee structure on devnet:
 *   0.25% Raydium (config) + 0.40% platform + 0.50% creator = 1.15% total.
 *
 * Creates a FRESH platform (new admin keypair, funded from the smoke wallet)
 * with feeRate=4000 (0.4%) + creatorFeeRate=5000 (0.5%, the cap), launches a token,
 * buys a clean round amount, and decomposes every fee lamport: protocol (pool),
 * platform (fee vault), and creator (wherever it lands). Also checks that the
 * xStock configs on MAINNET are uniformly 0.25%.
 *
 *   KEYFILE=~/waves-keys/devnet-stake-smoke.json node tools/launchlab-fee-check.js
 */
"use strict";
const fs = require("fs"), os = require("os");
const BN = require("bn.js");
const r = require("@raydium-io/raydium-sdk-v2");
const { Connection, Keypair, PublicKey, SystemProgram, Transaction } = require("@solana/web3.js");

const KEYFILE = (process.env.KEYFILE || "~/waves-keys/devnet-stake-smoke.json").replace(/^~/, os.homedir());
const WSOL = new PublicKey("So11111111111111111111111111111111111111112");

(async () => {
  // ---- (1) mainnet config-fee uniformity ----
  console.log("=== xStock config protocol fees (mainnet) ===");
  const mnet = new Connection("https://api.mainnet-beta.solana.com", "confirmed");
  const stocks = { SPYx: "XsoCS1TfEyfFhfvj8EtZ528L3CaKBDBRqRapnBbDF2W",
    NVDAx: "Xsc9qvGR1efVDFGLrVsmkzv3qi45LTBjeUKSPmx9qEh",
    TSLAx: "XsDoVfqeBukxuZHWhdvWHBhgEHjGNst4MLodqsJHzoB",
    AAPLx: "XsbEhLAtcf6HdfpFZ5xEMdqW8nfAvcsP5bdudRLJzJp",
    METAx: "Xsa62P5mvPszXL1krVUnU5ar38bBSVcWAB6fmPCo5Zu" };
  for (const [sym, mint] of Object.entries(stocks)) {
    try {
      const id = r.getPdaLaunchpadConfigId(r.LAUNCHPAD_PROGRAM, new PublicKey(mint), 0, 0).publicKey;
      const info = await mnet.getAccountInfo(id);
      if (!info) { console.log("  " + sym + ": (no config)"); continue; }
      const d = r.LaunchpadConfig.decode(info.data);
      console.log("  " + sym + ": tradeFeeRate=" + d.tradeFeeRate.toString() +
        " (" + (Number(d.tradeFeeRate) / 10000) + "%)");
    } catch (e) { console.log("  " + sym + " err:", e.message.slice(0, 60)); }
  }

  // ---- (2) devnet fee-split proof ----
  console.log("\n=== fee-split proof (devnet, fresh platform 0.4% plat / 0.5% creator) ===");
  const conn = new Connection("https://api.devnet.solana.com", "confirmed");
  const funder = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(KEYFILE, "utf8"))));
  const admin = Keypair.generate();
  console.log("fresh admin:", admin.publicKey.toBase58());

  // fund the fresh admin from the smoke wallet
  const fund = new Transaction().add(SystemProgram.transfer({
    fromPubkey: funder.publicKey, toPubkey: admin.publicKey, lamports: 300_000_000 }));
  fund.feePayer = funder.publicKey;
  fund.recentBlockhash = (await conn.getLatestBlockhash()).blockhash;
  fund.sign(funder);
  await conn.confirmTransaction(await conn.sendRawTransaction(fund.serialize()), "confirmed");
  console.log("funded 0.3 SOL");

  const Raydium = r.Raydium || r.default;
  const prog = r.DEV_LAUNCHPAD_PROGRAM;
  const raydium = await Raydium.load({ connection: conn, owner: admin, cluster: "devnet",
    disableFeatureCheck: true, disableLoadToken: true });

  // create platform with the target rates
  const cpConfigId = r.getCpmmPdaAmmConfigId(r.DEVNET_PROGRAM_ID.CREATE_CPMM_POOL_PROGRAM, 0).publicKey;
  const platformId = r.getPdaPlatformId(prog, admin.publicKey).publicKey;
  await (await raydium.launchpad.createPlatformConfig({
    programId: prog, platformAdmin: admin.publicKey,
    platformClaimFeeWallet: admin.publicKey, platformLockNftWallet: admin.publicKey,
    platformVestingWallet: admin.publicKey, cpConfigId,
    migrateCpLockNftScale: { platformScale: new BN(0), creatorScale: new BN(0), burnScale: new BN(1000000) },
    transferFeeExtensionAuth: admin.publicKey,
    creatorFeeRate: new BN(5000),   // 0.5% (program cap)
    feeRate: new BN(4000),          // 0.4%
    name: "WAVES-feecheck", web: "https://waveslaunchpad.xyz", img: "https://waveslaunchpad.xyz/og.png",
    txVersion: r.TxVersion.LEGACY,
  })).execute({ sendAndConfirm: true, sequentially: true });
  const platCfg = r.PlatformConfig.decode((await conn.getAccountInfo(platformId)).data);
  console.log("platform feeRate=" + platCfg.feeRate + " creatorFeeRate=" + platCfg.creatorFeeRate);

  // launch (no dev buy — keep the volume clean) then one buy of exactly 1 SOL
  const configId = r.getPdaLaunchpadConfigId(prog, WSOL, 0, 0).publicKey;
  const configInfo = r.LaunchpadConfig.decode((await conn.getAccountInfo(configId)).data);
  const mintKp = Keypair.generate();
  const launch = await raydium.launchpad.createLaunchpad({
    programId: prog, mintA: mintKp.publicKey, decimals: 6,
    name: "FeeChk", symbol: "FEECHK", uri: "https://waveslaunchpad.xyz/x.json",
    configId, configInfo, platformId, migrateType: "cpmm",
    buyAmount: new BN(10_000_000), slippage: new BN(500),
    extraSigners: [mintKp], txVersion: r.TxVersion.LEGACY,
  });
  await launch.execute({ sendAndConfirm: true, sequentially: true });
  const poolId = r.getPdaLaunchpadPoolId(prog, mintKp.publicKey, WSOL).publicKey;

  const BUY = 100_000_000; // 0.1 SOL
  const buy = await raydium.launchpad.buyToken({
    programId: prog, mintA: mintKp.publicKey, mintB: WSOL,
    buyAmount: new BN(BUY), slippage: new BN(500), configInfo, txVersion: r.TxVersion.LEGACY,
  });
  await buy.execute({ sendAndConfirm: true, sequentially: true });

  // measure
  const pool = r.LaunchpadPool.decode((await conn.getAccountInfo(poolId)).data);
  const pv = r.getPdaPlatformVault(prog, platformId, WSOL).publicKey;
  const pvBal = await conn.getTokenAccountBalance(pv).catch(() => null);
  const platformFee = pvBal ? Number(pvBal.value.amount) : 0;
  const protocolFee = Number(pool.protocolFee.toString());
  const realB = Number(pool.realB.toString());
  // no dev buy — total in = this buy only
  const totalIn = 10_000_000 + BUY;  // dev buy + curve buy
  const totalFees = totalIn - realB;
  const creatorish = totalFees - protocolFee - platformFee;

  const pct = (n) => (100 * n / totalIn).toFixed(4) + "%";
  console.log("\n  buy amount:      " + BUY + " (0.1 SOL) + 0.01 dev buy");
  console.log("  pool.realB:      " + realB);
  console.log("  protocolFee:     " + protocolFee + "  = " + pct(protocolFee) + "  (expect 0.25%)");
  console.log("  platform vault:  " + platformFee + "  = " + pct(platformFee) + "  (expect 0.40%)");
  console.log("  remainder:       " + creatorish + "  = " + pct(creatorish) + "  (creator, expect 0.50%)");
  console.log("  total fees:      " + totalFees + "  = " + pct(totalFees) + "  (expect ~1.15%)");
  console.log("  pool.migrateFee: " + pool.migrateFee.toString());
  console.log("\n  → If remainder ≈ 0.60% the creator fee IS charged on the curve.");
  console.log("    If remainder ≈ 0, creatorFeeRate is a POST-graduation (CPMM) fee only.");
})().catch((e) => { console.error("\n❌", e.message); if (process.env.DEBUG) console.error(e); process.exit(1); });
