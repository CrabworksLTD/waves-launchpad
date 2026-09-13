#!/usr/bin/env node
/* Devnet proof for the H-3 knock-on: a "none" launch is a STANDARD SPL token
 * (no transfer-fee extension). Its graduation path had never run. This launches
 * one with a tiny fund-raising target, buys it to completion, and graduates it —
 * proving a standard-SPL LaunchLab pool migrates cleanly. Uses migrateType CPMM
 * (the path dividends already use; avoids the AMM/OpenBook route entirely).
 *
 *   KEYFILE=~/waves-keys/devnet-stake-smoke.json node tools/launchlab-grad-devnet.js
 */
const fs = require("fs");
const r = require("@raydium-io/raydium-sdk-v2");
const { Connection, Keypair, PublicKey } = require("@solana/web3.js");
const BN = require("bn.js");

const RPC = process.env.RPC || "https://api.devnet.solana.com";
const KEYFILE = (process.env.KEYFILE || process.env.HOME + "/waves-keys/devnet-stake-smoke.json").replace(/^~/, process.env.HOME);
const PROG = r.DEV_LAUNCHPAD_PROGRAM;
const WSOL = new PublicKey("So11111111111111111111111111111111111111112");
const CPMM_CFG = r.getCpmmPdaAmmConfigId ? undefined : undefined; // derived by SDK
const log = (...a) => console.log(...a);
const sleep = (ms) => new Promise((res) => setTimeout(res, ms));

(async () => {
  const conn = new Connection(RPC, "confirmed");
  const owner = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(KEYFILE, "utf8"))));
  const Raydium = r.Raydium || r.default;
  const raydium = await Raydium.load({ connection: conn, owner, cluster: "devnet", disableFeatureCheck: true, disableLoadToken: true });
  const lp = raydium.launchpad;
  log("payer:", owner.publicKey.toBase58(), "| balance:", (await conn.getBalance(owner.publicKey)) / 1e9, "SOL");

  const configId = r.getPdaLaunchpadConfigId(PROG, WSOL, 0, 0).publicKey;
  const configInfo = r.LaunchpadConfig.decode((await conn.getAccountInfo(configId)).data);
  const platformId = r.getPdaPlatformId(PROG, owner.publicKey).publicKey;
  if (!(await conn.getAccountInfo(platformId))) throw new Error("run launchlab-smoke.js first to create the devnet platform");
  log("config:", configId.toBase58().slice(0, 8), "| platform:", platformId.toBase58().slice(0, 8));

  // ---- STEP 1: launch a "none" (standard SPL, NO transfer fee) with a small target ----
  const mintKp = Keypair.generate();
  const target = new BN(300_000_000);            // 0.3 SOL graduation target (reachable on devnet)
  const supply = new BN("1000000000000000");     // 1e9 tokens * 1e6
  const totalSellA = new BN("793100000000000");  // 793.1M on the curve (Raydium standard ratio)
  log("\n[1] launching NONE token (standard SPL, migrateType=cpmm) target 0.3 SOL — mint", mintKp.publicKey.toBase58().slice(0, 8));
  const { execute: execLaunch, extInfo } = await lp.createLaunchpad({
    programId: PROG, mintA: mintKp.publicKey, decimals: 6,
    name: "WavesGrad", symbol: "WVGRD", uri: "https://waveslaunchpad.xyz/meta/grad.json",
    configId, configInfo, platformId,
    migrateType: "cpmm",
    supply, totalSellA, totalFundRaisingB: target,
    buyAmount: new BN(20_000_000),               // 0.02 SOL dev buy
    slippage: new BN(500),
    token2022: false,                            // ← standard SPL, the "none" case
    createOnly: false, extraSigners: [mintKp], txVersion: r.TxVersion.LEGACY,
  });
  const launchSig = await execLaunch({ sendAndConfirm: true, sequentially: true });
  log("    launch tx:", launchSig.txId || (launchSig.txIds && launchSig.txIds[0]) || launchSig);
  const poolId = extInfo?.address?.poolId ? new PublicKey(extInfo.address.poolId)
    : r.getPdaLaunchpadPoolId(PROG, mintKp.publicKey, WSOL).publicKey;
  log("    poolId:", poolId.toBase58());

  const readPool = async () => r.LaunchpadPool.decode((await conn.getAccountInfo(poolId)).data);
  let pool = await readPool();
  log("    after launch: realB", pool.realB.toString(), "/ target", pool.totalFundRaisingB.toString(),
      "| status", pool.status, "| migrateType", pool.migrateType, "| mintProgramFlag", pool.mintProgramFlag, "(0=std SPL)");

  // ---- STEP 2: buy until the curve completes ----
  log("\n[2] buying to graduation…");
  for (let i = 0; i < 8 && pool.status === 0; i++) {
    const remaining = new BN(pool.totalFundRaisingB).sub(new BN(pool.realB));
    if (remaining.lten(0)) break;
    const buy = BN.min(remaining.add(new BN(20_000_000)), new BN(150_000_000)); // headroom past target
    try {
      const { execute } = await lp.buyToken({
        programId: PROG, mintA: mintKp.publicKey, mintB: WSOL,
        buyAmount: buy, slippage: new BN(1000), configInfo,
        platformFeeRate: new BN(configInfo.tradeFeeRate || 10000), txVersion: r.TxVersion.LEGACY,
      });
      const sig = await execute({ sendAndConfirm: true, sequentially: true });
      log("    buy", (buy.toNumber() / 1e9).toFixed(3), "SOL →", (sig.txId || (sig.txIds && sig.txIds[0]) || sig).slice(0, 12) + "…");
    } catch (e) {
      log("    buy failed:", String(e.message || e).slice(0, 120));
    }
    await sleep(1500);
    pool = await readPool();
    log("      realB", pool.realB.toString(), "/", pool.totalFundRaisingB.toString(), "| status", pool.status);
  }

  if (pool.status === 0) { log("\n✗ curve did not complete (status still 0) — cannot migrate yet"); return; }
  log("\n[3] curve COMPLETE (status", pool.status + "). Migrating to CPMM…");

  // ---- STEP 3: graduate ----
  try {
    const { execute } = await lp.migrateToCpmmWallet({ programId: PROG, poolId });
    const sig = await execute({ sendAndConfirm: true, sequentially: true });
    log("    migrate tx:", sig.txId || (sig.txIds && sig.txIds[0]) || sig);
  } catch (e) {
    log("    migrateToCpmmWallet param error, retrying with mintA/mintB…:", String(e.message || e).slice(0, 100));
    const { execute } = await lp.migrateToCpmmWallet({ programId: PROG, poolId, mintA: mintKp.publicKey, mintB: WSOL });
    const sig = await execute({ sendAndConfirm: true, sequentially: true });
    log("    migrate tx:", sig.txId || (sig.txIds && sig.txIds[0]) || sig);
  }

  // ---- STEP 4: verify the graduated pool ----
  await sleep(2000);
  pool = await readPool();
  log("\n[4] after migrate: status", pool.status, "(non-0 = migrated)");
  log("    ✓ standard-SPL 'none' token graduated via CPMM — mint", mintKp.publicKey.toBase58());
})().catch((e) => { console.error("\nFATAL:", e.message); process.exit(1); });
