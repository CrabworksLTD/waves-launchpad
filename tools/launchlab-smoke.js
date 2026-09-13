#!/usr/bin/env node
/*
 * launchlab-smoke.js — Phase 0 de-risk for the Raydium LaunchLab migration.
 *
 * Proves, on DEVNET, the exact mechanism StonkFun uses for stock-quoted launches:
 *   1. Create a WAVES-owned PlatformConfig (permissionless — no Raydium authority).
 *      This is our fee layer: feeRate (our %), our claim wallet, our LP split.
 *   2. Launch a token against a GLOBAL LaunchpadConfig we do NOT own, attaching
 *      OUR platformId. Base mint is Token-2022 WITH a transfer-fee extension —
 *      that's "reward mode" (a tax on every transfer).
 *   3. Buy on the curve.
 *   4. Decode the pool and confirm it references OUR platformId and that our
 *      platformFee accrued from the buy.
 *
 * What devnet CAN'T prove: the QUOTE being a real xStock (those Token-2022 quote
 * configs only exist on mainnet — 16 verified). The launch instruction handles a
 * T2022 quote generically (transferFeeConfigB / skipCheckMintB), and the quote
 * here is WSOL; the T2022-quote-config existence is already confirmed on mainnet.
 *
 * Usage:
 *   KEYFILE=~/waves-keys/devnet-stake-smoke.json node tools/launchlab-smoke.js
 */
const fs = require("fs");
const os = require("os");
const path = require("path");
const BN = require("bn.js");
const r = require("@raydium-io/raydium-sdk-v2");
const { Connection, Keypair, PublicKey } = require("@solana/web3.js");
const { TOKEN_2022_PROGRAM_ID } = require("@solana/spl-token");

const RPC = process.env.RPC || "https://api.devnet.solana.com";
const KEYFILE = (process.env.KEYFILE || "~/waves-keys/devnet-stake-smoke.json").replace(/^~/, os.homedir());
const STATE = path.join(process.env.TMPDIR || "/tmp", "launchlab-smoke-state.json");
const WSOL = new PublicKey("So11111111111111111111111111111111111111112");
const CPMM_CFG = new PublicKey("5MxLgy9oPdTC3YgkiePHqr3EoCRD9uLVYRQS2ANAs7wy"); // devnet CPMM AmmConfig idx0
const PROG = r.DEV_LAUNCHPAD_PROGRAM;

function loadState() { try { return JSON.parse(fs.readFileSync(STATE, "utf8")); } catch { return {}; } }
function saveState(s) { fs.writeFileSync(STATE, JSON.stringify(s, null, 2)); }
const log = (...a) => console.log(...a);

(async () => {
  const conn = new Connection(RPC, "confirmed");
  const secret = Uint8Array.from(JSON.parse(fs.readFileSync(KEYFILE, "utf8")));
  const owner = Keypair.fromSecretKey(secret);
  const Raydium = r.Raydium || r.default;
  const raydium = await Raydium.load({ connection: conn, owner, cluster: "devnet", disableFeatureCheck: true, disableLoadToken: true });
  const lp = raydium.launchpad;
  const state = loadState();

  log("payer:", owner.publicKey.toBase58());
  log("balance:", (await conn.getBalance(owner.publicKey)) / 1e9, "SOL");
  log("launchpad program:", PROG.toBase58(), "(devnet)");

  // ---- config we launch against (global, not ours) ----
  const configId = r.getPdaLaunchpadConfigId(PROG, WSOL, 0, 0).publicKey;
  const cfgAcc = await conn.getAccountInfo(configId);
  if (!cfgAcc) throw new Error("devnet WSOL config missing: " + configId.toBase58());
  const configInfo = r.LaunchpadConfig.decode(cfgAcc.data);
  log("\nglobal config (Raydium-owned):", configId.toBase58().slice(0, 8),
      "quote=WSOL protocolFeeOwner=" + configInfo.protocolFeeOwner.toBase58().slice(0, 8));

  // ================= STEP 1: create OUR platform (permissionless) =================
  const platformId = r.getPdaPlatformId(PROG, owner.publicKey).publicKey;
  const existing = await conn.getAccountInfo(platformId);
  if (existing) {
    log("\n[1] platform already exists (reusing):", platformId.toBase58());
  } else {
    log("\n[1] creating WAVES platform config:", platformId.toBase58());
    const { execute } = await lp.createPlatformConfig({
      programId: PROG,
      platformAdmin: owner.publicKey,
      platformClaimFeeWallet: owner.publicKey,   // our treasury (test: payer)
      platformLockNftWallet: owner.publicKey,
      platformVestingWallet: owner.publicKey,
      cpConfigId: CPMM_CFG,
      migrateCpLockNftScale: {                    // devnet: platform=0, creator=0, must sum to 1e6 → burn all LP
        platformScale: new BN(0),
        creatorScale: new BN(0),
        burnScale: new BN(1000000),
      },
      transferFeeExtensionAuth: owner.publicKey,  // reward-mode fee authority
      creatorFeeRate: new BN(0),
      feeRate: new BN(10000),                     // 1% platform trading fee (denom 1e6)
      name: "WAVES",
      web: "https://waveslaunchpad.xyz",
      img: "https://waveslaunchpad.xyz/og.png",
      txVersion: r.TxVersion.LEGACY,
    });
    const sig = await execute({ sendAndConfirm: true });
    log("    platform tx:", (sig.txId || sig));
  }
  state.platformId = platformId.toBase58();
  saveState(state);

  // ================= STEP 2: launch a T2022 base token vs the global config, OUR platform =================
  const mintKp = Keypair.generate();
  log("\n[2] launching token — base mint:", mintKp.publicKey.toBase58());
  log("    quote=WSOL config (not ours), platformId=OURS, base=Token-2022 + 1% transfer fee (reward mode)");
  const { execute: execLaunch, extInfo } = await lp.createLaunchpad({
    programId: PROG,
    mintA: mintKp.publicKey,
    decimals: 6,
    name: "WavesSmoke",
    symbol: "WVSMK",
    uri: "https://waveslaunchpad.xyz/meta/smoke.json",
    configId,
    configInfo,
    platformId,                                    // <-- OUR platform on someone else's config
    migrateType: "cpmm",                           // T2022 base must graduate to CPMM
    buyAmount: new BN(10_000_000),                 // 0.01 SOL initial dev buy
    slippage: new BN(100),                         // 1%
    token2022: true,                               // Token-2022 base
    transferFeeExtensionParams: {                  // reward mode: 1% transfer fee
      transferFeeBasePoints: 100,
      maxinumFee: new BN("1000000000000000"),
    },
    createOnly: false,
    extraSigners: [mintKp],
    txVersion: r.TxVersion.LEGACY,
  });
  const launchSig = await execLaunch({ sendAndConfirm: true, sequentially: true });
  log("    launch tx:", (launchSig.txId || (launchSig.txIds && launchSig.txIds[0]) || launchSig));
  const poolId = (extInfo && extInfo.address && extInfo.address.poolId)
    ? new PublicKey(extInfo.address.poolId)
    : r.getPdaLaunchpadPoolId(PROG, mintKp.publicKey, WSOL).publicKey;
  log("    poolId:", poolId.toBase58());
  state.mint = mintKp.publicKey.toBase58();
  state.poolId = poolId.toBase58();
  saveState(state);

  // ================= STEP 3: buy on the curve =================
  log("\n[3] buying on the curve (0.02 SOL)...");
  const { execute: execBuy } = await lp.buyToken({
    programId: PROG,
    mintA: mintKp.publicKey,
    mintB: WSOL,
    buyAmount: new BN(20_000_000),
    slippage: new BN(100),
    configInfo,
    platformFeeRate: new BN(10000),
    txVersion: r.TxVersion.LEGACY,
  });
  const buySig = await execBuy({ sendAndConfirm: true, sequentially: true });
  log("    buy tx:", (buySig.txId || (buySig.txIds && buySig.txIds[0]) || buySig));

  // ================= STEP 4: verify =================
  log("\n[4] verifying pool...");
  const poolAcc = await conn.getAccountInfo(poolId);
  const pool = r.LaunchpadPool.decode(poolAcc.data);
  const ok = pool.platformId.toBase58() === platformId.toBase58();
  log("    pool.platformId == OURS:", ok, "(" + pool.platformId.toBase58().slice(0, 8) + ")");
  log("    pool.configId:", pool.configId.toBase58().slice(0, 8), "(the global config we don't own)");
  log("    accrued protocolFee (Raydium's):", pool.protocolFee.toString());
  log("    mintProgramFlag:", pool.mintProgramFlag, "(1 = T2022 base)");
  log("    migrateType:", pool.migrateType, "(1 = CPMM)");
  // our platform fee lands in the platform's fee vault (WSOL), not pool.platformFee
  const pVault = r.getPdaPlatformVault(PROG, platformId, WSOL).publicKey;
  const vBal = await conn.getTokenAccountBalance(pVault).catch(() => null);
  const platformFeeAccrued = vBal ? new BN(vBal.value.amount) : new BN(0);
  log("    WAVES platform fee vault:", pVault.toBase58().slice(0, 8),
      "balance:", platformFeeAccrued.toString(), "lamports WSOL (our 1% fee, claimable via claimPlatformFee)");

  log("\n===== RESULT =====");
  if (ok && platformFeeAccrued.gt(new BN(0))) {
    log("✅ PASS — WAVES launched against a config it doesn't own, under its own");
    log("   permissionless platform, and collected a platform fee. Reward-mode");
    log("   (T2022 transfer fee) base minted. Mechanism = how StonkFun quotes stocks.");
  } else {
    log("⚠️  Launch/buy succeeded but platform attach or fee accrual needs a look.");
  }
})().catch((e) => { console.error("\n❌ FAILED:", e.message); if (process.env.DEBUG) console.error(e); process.exit(1); });
