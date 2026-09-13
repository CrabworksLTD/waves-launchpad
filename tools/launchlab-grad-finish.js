#!/usr/bin/env node
/* Finish + graduate the standard-SPL pool the previous run got to 99.997%.
 *   MINT=EF4hFgkb… POOL=DStiftDt… KEYFILE=~/waves-keys/devnet-stake-smoke.json node tools/launchlab-grad-finish.js
 */
const fs = require("fs");
const r = require("@raydium-io/raydium-sdk-v2");
const { Connection, Keypair, PublicKey } = require("@solana/web3.js");
const BN = require("bn.js");

const RPC = process.env.RPC || "https://api.devnet.solana.com";
const KEYFILE = (process.env.KEYFILE || process.env.HOME + "/waves-keys/devnet-stake-smoke.json").replace(/^~/, process.env.HOME);
const PROG = r.DEV_LAUNCHPAD_PROGRAM;
const WSOL = new PublicKey("So11111111111111111111111111111111111111112");
const MINT = new PublicKey(process.env.MINT || "EF4hFgkbCnQjMBJsCdN5yLLuseFGU9KR5mVLksPyFXAc");
const POOL = new PublicKey(process.env.POOL || "DStiftDtdmMCQH85CwPeCAJiFRxeAGUyucYq1yHTXE7G");
const log = (...a) => console.log(...a);
const sleep = (ms) => new Promise((res) => setTimeout(res, ms));

(async () => {
  const conn = new Connection(RPC, "confirmed");
  const owner = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(KEYFILE, "utf8"))));
  const raydium = await (r.Raydium || r.default).load({ connection: conn, owner, cluster: "devnet", disableFeatureCheck: true, disableLoadToken: true });
  const lp = raydium.launchpad;
  const configInfo = r.LaunchpadConfig.decode((await conn.getAccountInfo(r.getPdaLaunchpadConfigId(PROG, WSOL, 0, 0).publicKey)).data);
  const readPool = async () => r.LaunchpadPool.decode((await conn.getAccountInfo(POOL)).data);

  let pool = await readPool();
  log("start: realB", pool.realB.toString(), "/", pool.totalFundRaisingB.toString(), "| status", pool.status, "| mintProgramFlag", pool.mintProgramFlag, "| migrateType", pool.migrateType);

  // ---- complete the curve ----
  for (let i = 0; i < 12 && pool.status === 0; i++) {
    const remaining = new BN(pool.totalFundRaisingB).sub(new BN(pool.realB));
    if (remaining.lten(0)) break;
    try {
      const { execute } = await lp.buyToken({
        programId: PROG, mintA: MINT, mintB: WSOL,
        buyAmount: remaining.add(new BN(5_000_000)), slippage: new BN(2000),
        configInfo, platformFeeRate: new BN(configInfo.tradeFeeRate || 10000), txVersion: r.TxVersion.LEGACY,
      });
      const sig = await execute({ sendAndConfirm: true, sequentially: true });
      log("  buy →", String(sig.txId || (sig.txIds && sig.txIds[0]) || sig).slice(0, 14) + "…");
    } catch (e) { log("  buy retry:", String(e.message || e).slice(0, 90)); }
    await sleep(3000);
    pool = await readPool();
    log("    realB", pool.realB.toString(), "/", pool.totalFundRaisingB.toString(), "| status", pool.status);
  }

  if (pool.status === 0) { log("\n✗ still not complete — remaining", new BN(pool.totalFundRaisingB).sub(new BN(pool.realB)).toString(), "lamports"); return; }
  log("\n✓ curve COMPLETE (status", pool.status + "). Migrating to CPMM…");

  // ---- graduate ----
  let migrated = false;
  for (const params of [{ programId: PROG, poolId: POOL }, { programId: PROG, poolId: POOL, mintA: MINT, mintB: WSOL }]) {
    try {
      const { execute } = await lp.migrateToCpmmWallet(params);
      const sig = await execute({ sendAndConfirm: true, sequentially: true });
      log("  migrate tx:", sig.txId || (sig.txIds && sig.txIds[0]) || sig);
      migrated = true; break;
    } catch (e) { log("  migrate attempt failed:", String(e.message || e).slice(0, 140)); await sleep(2000); }
  }
  if (!migrated) { log("\n✗ migrate did not land — see errors above"); return; }

  await sleep(3000);
  pool = await readPool();
  log("\n[done] pool status now", pool.status, "— standard-SPL 'none' token graduated via CPMM.");
  log("mint:", MINT.toBase58(), "pool:", POOL.toBase58());
})().catch((e) => { console.error("FATAL:", e.message); process.exit(1); });
