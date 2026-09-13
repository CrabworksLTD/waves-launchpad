#!/usr/bin/env node
/* Create the LaunchLab fee-tier platform configs (2/3/4/5/10%).
 *
 * The platform PDA is keyed by ADMIN, so each tier needs its own admin keypair.
 * The claim wallet is ALWAYS feeOwner, so every tier's platform fee accrues to
 * the same treasury regardless of which throwaway admin created it. Total fee =
 * 0.25% Raydium + platform feeRate + 0.50% creator (the on-chain creator cap);
 * the KEEPER forwards the rest of the creator's intended share from the platform
 * fee (that piece is separate and audit-gated).
 *
 *   DRY RUN (generates keypairs, computes platformIds, prints the brand.js block):
 *     node tools/create-launchlab-tiers.js
 *   CREATE the configs on mainnet (funded admin keypairs required):
 *     CONFIRM=1 node tools/create-launchlab-tiers.js
 */
const fs = require("fs");
const os = require("os");
const r = require("@raydium-io/raydium-sdk-v2");
const { Connection, Keypair, PublicKey } = require("@solana/web3.js");
const BN = require("bn.js");

const CLUSTER = process.env.CLUSTER || "mainnet-beta";
const RPC = process.env.RPC || "https://api.mainnet-beta.solana.com";
const CONFIRM = process.env.CONFIRM === "1";
const KEYDIR = (process.env.KEYDIR || os.homedir() + "/waves-keys").replace(/^~/, os.homedir());
const FEE_OWNER = new PublicKey(process.env.FEE_OWNER || "BU9dYi7fGw5G3Wd54CUTmt1Y58jEJaPq8LKiL72ydeKJ");
const FEE_KEEPER = new PublicKey(process.env.FEE_KEEPER || "BU9dYi7fGw5G3Wd54CUTmt1Y58jEJaPq8LKiL72ydeKJ");
// A tier's platform fee is claimed HERE, then the keeper splits it — the creator's
// forwarded share to their wallet, WAVES's cut to the treasury. So it must be a
// keeper-controlled escrow, NOT the treasury: the escrow only ever holds freshly-
// claimed fees between claim and split (minimal exposure, like the Meteora partner
// claimer). Standard (1.15%) needs no forward, so it stays feeOwner.
const TIER_CLAIM = new PublicKey(process.env.TIER_CLAIM || FEE_KEEPER);

// tier → total fee %. platform feeRate = (total − 0.25 Raydium − 0.50 creator).
// denom 1e6, so 1% = 10000. WAVES's KEPT cut per tier (keeper forwards the rest
// to the creator) mirrors the Meteora ladder: 0.40/0.50/0.60/0.70/0.80/0.90%.
const TIERS = [
  { key: "t2",  pct: 2,  feeRate: 12500, wavesKeepBps: 5000 },
  { key: "t3",  pct: 3,  feeRate: 22500, wavesKeepBps: 6000 },
  { key: "t4",  pct: 4,  feeRate: 32500, wavesKeepBps: 7000 },
  { key: "t5",  pct: 5,  feeRate: 42500, wavesKeepBps: 8000 },
  // NOTE: 10% is impossible — the program caps platform feeRate at ~5% (50000 OK,
  // 60000 reverts Custom:6002). The ladder tops out at 5% total.
];
const CREATOR_FEE = 5000; // 0.50% on-chain cap

function loadOrGen(path) {
  if (fs.existsSync(path)) return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(path, "utf8"))));
  const kp = Keypair.generate();
  fs.writeFileSync(path, JSON.stringify(Array.from(kp.secretKey)), { mode: 0o600 });
  return kp;
}

(async () => {
  const conn = new Connection(RPC, "confirmed");
  const prog = CLUSTER === "devnet" ? r.DEV_LAUNCHPAD_PROGRAM : r.LAUNCHPAD_PROGRAM;
  const cpmmProg = CLUSTER === "devnet" ? r.DEVNET_PROGRAM_ID.CREATE_CPMM_POOL_PROGRAM : r.CREATE_CPMM_POOL_PROGRAM;
  const cpConfigId = r.getCpmmPdaAmmConfigId(cpmmProg, 0).publicKey;

  console.log("cluster:", CLUSTER, "| program:", prog.toBase58().slice(0, 8), "| claim wallet (feeOwner):", FEE_OWNER.toBase58());
  console.log("\nTier configs (admin keypairs in " + KEYDIR + "):\n");

  const brand = [];
  for (const t of TIERS) {
    const kfile = KEYDIR + "/launchlab-tier-" + t.key + "-admin.json";
    const admin = loadOrGen(kfile);
    const platformId = r.getPdaPlatformId(prog, admin.publicKey).publicKey;
    const exists = !!(await conn.getAccountInfo(platformId));
    const bal = await conn.getBalance(admin.publicKey);
    console.log("  " + t.key + " (" + t.pct + "%)  platformId " + platformId.toBase58() +
      "  admin " + admin.publicKey.toBase58().slice(0, 6) + "…  " + (exists ? "EXISTS" : "missing") +
      "  admin bal " + (bal / 1e9).toFixed(4) + " SOL");
    brand.push('        ' + t.key + ': { platformId: "' + platformId.toBase58() + '", pct: ' + t.pct +
      ', feeRate: ' + t.feeRate + ', creatorFeeRate: ' + CREATOR_FEE + ', wavesKeepBps: ' + t.wavesKeepBps + ' },');

    if (CONFIRM && !exists) {
      if (bal < 0.03 * 1e9) { console.log("    ⚠ admin underfunded — send ~0.03 SOL to " + admin.publicKey.toBase58() + " and re-run"); continue; }
      const raydium = await (r.Raydium || r.default).load({ connection: conn, owner: admin, cluster: CLUSTER, disableFeatureCheck: true, disableLoadToken: true });
      const { execute } = await raydium.launchpad.createPlatformConfig({
        programId: prog, platformAdmin: admin.publicKey,
        platformClaimFeeWallet: TIER_CLAIM, platformLockNftWallet: FEE_OWNER, platformVestingWallet: FEE_OWNER,
        cpConfigId,
        migrateCpLockNftScale: { platformScale: new BN(0), creatorScale: new BN(0), burnScale: new BN(1000000) },
        transferFeeExtensionAuth: FEE_KEEPER,
        creatorFeeRate: new BN(CREATOR_FEE), feeRate: new BN(t.feeRate),
        name: "WAVES", web: "https://waveslaunchpad.xyz", img: "https://waveslaunchpad.xyz/og.png",
        txVersion: r.TxVersion.LEGACY,
      });
      const sig = await execute({ sendAndConfirm: true });
      console.log("    ✓ created:", sig.txId || sig);
    }
  }

  console.log("\n=== brand.js launchlabConfigs[\"mainnet-beta\"].tiers block ===\n");
  console.log("      tiers: {\n" + brand.join("\n") + "\n      },");
  if (!CONFIRM) console.log("\n[dry run] keypairs generated + platformIds computed. Fund each admin ~0.03 SOL, then CONFIRM=1 to create.");
})().catch((e) => { console.error("FATAL:", e.message); process.exit(1); });
