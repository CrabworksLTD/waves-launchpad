#!/usr/bin/env node
/* End-to-end devnet smoke test of the launch sequence.
 *
 *   node tools/devnet-smoke.js
 *
 * Runs the exact chain calls the launch panel will make, headless, against
 * devnet: create a Core collection, create a Candy Machine over it, insert
 * config lines, then mint one asset through the guards. If this passes the UI
 * is plumbing; if it fails, no amount of UI work matters.
 *
 * Uses a throwaway keypair funded by airdrop. Devnet airdrops are rate limited,
 * so a wallet can be supplied instead:
 *
 *   SMOKE_SECRET=<base58 64-byte secret key> node tools/devnet-smoke.js
 */
"use strict";

const RPC = process.env.SOLANA_RPC || "https://api.devnet.solana.com";
const SUPPLY = 5;                 // small: every config line is a transaction slot

(async () => {
  const {
    createUmi,
  } = await import("@metaplex-foundation/umi-bundle-defaults");
  const {
    generateSigner, signerIdentity, sol, some, none, percentAmount, base58,
    createSignerFromKeypair, dateTime,
  } = await import("@metaplex-foundation/umi");
  const {
    mplCore, createCollection, fetchCollection,
  } = await import("@metaplex-foundation/mpl-core");
  const {
    mplCandyMachine, create: createCandyMachine, addConfigLines,
    fetchCandyMachine, mintV1,
  } = await import("@metaplex-foundation/mpl-core-candy-machine");
  const { setComputeUnitLimit } = await import("@metaplex-foundation/mpl-toolbox");

  const step = (n, s) => console.log("\n  " + n + "  " + s);
  const ok = (s) => console.log("      ok   " + s);

  const umi = createUmi(RPC).use(mplCore()).use(mplCandyMachine());

  /* ---- wallet ----
     The keypair is persisted so a funded one survives reruns. Devnet faucets
     are frequently dry or rate limited, and burning a fresh unfunded address on
     every attempt makes that failure permanent. Gitignored — it is a devnet
     throwaway, but a secret key is a secret key. */
  const fs = require("fs");
  const path = require("path");
  const KEYFILE = path.join(__dirname, "..", ".devnet-smoke.key");

  let payer;
  if (process.env.SMOKE_SECRET) {
    payer = createSignerFromKeypair(umi,
      umi.eddsa.createKeypairFromSecretKey(base58.serialize(process.env.SMOKE_SECRET)));
  } else if (fs.existsSync(KEYFILE)) {
    payer = createSignerFromKeypair(umi,
      umi.eddsa.createKeypairFromSecretKey(base58.serialize(fs.readFileSync(KEYFILE, "utf8").trim())));
    console.log("  (reusing " + path.basename(KEYFILE) + ")");
  } else {
    payer = generateSigner(umi);
    fs.writeFileSync(KEYFILE, base58.deserialize(payer.secretKey)[0], { mode: 0o600 });
    console.log("  (new keypair written to " + path.basename(KEYFILE) + ")");
  }
  umi.use(signerIdentity(payer));
  console.log("  rpc     " + RPC);
  console.log("  payer   " + payer.publicKey);

  step("0/5", "funding");
  let bal = await umi.rpc.getBalance(payer.publicKey);
  if (Number(bal.basisPoints) < 0.5e9) {
    try {
      await umi.rpc.airdrop(payer.publicKey, sol(2));
      bal = await umi.rpc.getBalance(payer.publicKey);
    } catch (e) {
      console.log("      airdrop refused — " + String(e.message || e).split("\n")[0]);
      console.log("");
      console.log("      Fund this address with devnet SOL, then rerun:");
      console.log("");
      console.log("        " + payer.publicKey);
      console.log("");
      console.log("      Either faucet.solana.com, or Phantom set to devnet.");
      console.log("      ~0.1 SOL is plenty. The key persists, so it only needs doing once.");
      process.exit(2);
    }
  }
  ok((Number(bal.basisPoints) / 1e9).toFixed(3) + " SOL");

  /* ---- 1. the Core collection ---- */
  step("1/5", "create Core collection");
  const collection = generateSigner(umi);
  await createCollection(umi, {
    collection,
    name: "Smoke Test",
    uri: "https://arweave.net/0000000000000000000000000000000000000000000/_collection.json",
    plugins: [
      // Royalties live on the collection, not on each asset — this is what
      // MoonpadVault + FeeSplitter + Distributor were doing by hand on the EVM
      // side. `ruleSet: none()` means no transfer restrictions.
      {
        type: "Royalties",
        basisPoints: 500,
        creators: [{ address: payer.publicKey, percentage: 100 }],
        ruleSet: { __kind: "None" },
      },
    ],
  }).sendAndConfirm(umi, { confirm: { commitment: "confirmed" } });
  ok(collection.publicKey);

  /* ---- 2. the Candy Machine ---- */
  step("2/5", "create Candy Machine");
  const candyMachine = generateSigner(umi);
  await (await createCandyMachine(umi, {
    candyMachine,
    collection: collection.publicKey,
    collectionUpdateAuthority: payer,
    itemsAvailable: SUPPLY,
    authority: payer.publicKey,
    isMutable: true,
    configLineSettings: some({
      // Prefixes are stored once on the machine, not per item. name + uri per
      // line then only carries the differing tail, which is what keeps a 10k
      // insert affordable.
      prefixName: "Smoke #",
      nameLength: 4,
      prefixUri: "https://arweave.net/0000000000000000000000000000000000000000000/",
      uriLength: 12,
      isSequential: false,
    }),
    guards: {
      solPayment: some({ lamports: sol(0.01), destination: payer.publicKey }),
      startDate: some({ date: dateTime(new Date(Date.now() - 60000)) }),
    },
  })).sendAndConfirm(umi, { confirm: { commitment: "confirmed" } });
  ok(candyMachine.publicKey);

  /* ---- 3. config lines ---- */
  step("3/5", "insert " + SUPPLY + " config lines");
  const lines = [];
  for (let i = 1; i <= SUPPLY; i++) lines.push({ name: String(i), uri: i + ".json" });
  await addConfigLines(umi, {
    candyMachine: candyMachine.publicKey,
    index: 0,
    configLines: lines,
  }).sendAndConfirm(umi, { confirm: { commitment: "confirmed" } });

  let cm = await fetchCandyMachine(umi, candyMachine.publicKey);
  ok("loaded " + cm.itemsLoaded + "/" + cm.data.itemsAvailable);
  if (cm.itemsLoaded !== SUPPLY) throw new Error("config lines did not all land");

  /* ---- 4. mint one through the guards ---- */
  step("4/5", "mint one asset through the guards");
  const asset = generateSigner(umi);
  await (await mintV1(umi, {
    candyMachine: candyMachine.publicKey,
    asset,
    collection: collection.publicKey,
    mintArgs: {
      solPayment: some({ destination: payer.publicKey }),
    },
  }))
    .prepend(setComputeUnitLimit(umi, { units: 800000 }))
    .sendAndConfirm(umi, { confirm: { commitment: "confirmed" } });
  ok(asset.publicKey);

  /* ---- 5. verify it actually exists and is in the collection ---- */
  step("5/5", "verify on chain");
  cm = await fetchCandyMachine(umi, candyMachine.publicKey);
  ok("itemsRedeemed = " + cm.itemsRedeemed);
  if (Number(cm.itemsRedeemed) !== 1) throw new Error("mint did not register");

  const { fetchAsset } = await import("@metaplex-foundation/mpl-core");
  const a = await fetchAsset(umi, asset.publicKey);
  ok("asset name  = " + a.name);
  ok("asset uri   = " + a.uri);
  ok("owner       = " + a.owner);
  if (a.updateAuthority.type !== "Collection") throw new Error("asset is not in the collection");
  ok("in collection " + a.updateAuthority.address);

  const col = await fetchCollection(umi, collection.publicKey);
  ok("collection minted = " + col.numMinted);

  console.log("\n  PASS — the full launch sequence works on devnet");
  console.log("  collection    https://explorer.solana.com/address/" + collection.publicKey + "?cluster=devnet");
  console.log("  candy machine https://explorer.solana.com/address/" + candyMachine.publicKey + "?cluster=devnet");
  console.log("  minted asset  https://explorer.solana.com/address/" + asset.publicKey + "?cluster=devnet");
})().catch((e) => {
  console.error("\n  FAIL — " + (e && e.message ? e.message : e));
  if (e && e.logs) console.error("\n  program logs:\n    " + e.logs.join("\n    "));
  process.exit(1);
});
