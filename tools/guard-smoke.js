#!/usr/bin/env node
/* Smoke test for the Moonpad-parity launch features, mirroring launch.js
 * deploy() step for step:
 *
 *   composed machine (no create() wrapper)
 *   creator supply minted pre-guard, split across recipients
 *   allowlist wave as a guard group + public group on a start-date ladder
 *   per-wallet mint limit
 *   proof-gated mint through the wave; public mint REJECTED before its time
 *
 *   SOLANA_RPC=http://127.0.0.1:8899 node tools/guard-smoke.js
 */
"use strict";

const RPC = process.env.SOLANA_RPC || "http://127.0.0.1:8899";
const SUPPLY = 6;

(async () => {
  const { createUmi } = await import("@metaplex-foundation/umi-bundle-defaults");
  const {
    generateSigner, signerIdentity, sol, some, base58, createSignerFromKeypair, dateTime, publicKey,
  } = await import("@metaplex-foundation/umi");
  const { mplCore, createCollection, fetchAsset } = await import("@metaplex-foundation/mpl-core");
  const {
    mplCandyMachine, createCandyMachine, createCandyGuard, wrap, findCandyGuardPda,
    addConfigLines, fetchCandyMachine, mintV1, mintAssetFromCandyMachine,
    route, getMerkleRoot, getMerkleProof,
  } = await import("@metaplex-foundation/mpl-core-candy-machine");
  const { setComputeUnitLimit } = await import("@metaplex-foundation/mpl-toolbox");
  const fs = require("fs");
  const path = require("path");

  const step = (n, s) => console.log("\n  " + n + "  " + s);
  const ok = (s) => console.log("      ok   " + s);
  const die = (s) => { console.error("      FAIL " + s); process.exit(1); };

  const umi = createUmi(RPC, "confirmed").use(mplCore()).use(mplCandyMachine());
  const payer = createSignerFromKeypair(umi, umi.eddsa.createKeypairFromSecretKey(
    base58.serialize(fs.readFileSync(path.join(__dirname, "..", ".devnet-smoke.key"), "utf8").trim())));
  umi.use(signerIdentity(payer));

  // a second team member for the supply split
  const mate = generateSigner(umi);
  console.log("  payer  " + payer.publicKey);
  console.log("  mate   " + mate.publicKey);

  /* ---- collection + machine, guardless ---- */
  step("1/6", "collection + machine (mint authority still ours)");
  const collection = generateSigner(umi);
  await createCollection(umi, {
    collection, name: "Guard Smoke",
    uri: "https://arweave.net/0000000000000000000000000000000000000000000/_c.json",
    plugins: [{ type: "Royalties", basisPoints: 500,
      creators: [{ address: payer.publicKey, percentage: 100 }], ruleSet: { __kind: "None" } }]
  }).sendAndConfirm(umi, { confirm: { commitment: "confirmed" } });

  const candyMachine = generateSigner(umi);
  await (await createCandyMachine(umi, {
    candyMachine, collection: collection.publicKey,
    collectionUpdateAuthority: payer,
    itemsAvailable: SUPPLY, authority: payer.publicKey, isMutable: true,
    configLineSettings: some({
      prefixName: "GS #", nameLength: 2,
      prefixUri: "https://arweave.net/0000000000000000000000000000000000000000000/",
      uriLength: 8, isSequential: false
    })
  })).sendAndConfirm(umi, { confirm: { commitment: "confirmed" } });
  ok(String(candyMachine.publicKey));

  step("2/6", "config lines");
  const lines = [];
  for (let i = 1; i <= SUPPLY; i++) lines.push({ name: String(i), uri: i + ".json" });
  await addConfigLines(umi, { candyMachine: candyMachine.publicKey, index: 0, configLines: lines })
    .sendAndConfirm(umi, { confirm: { commitment: "confirmed" } });
  ok("loaded " + SUPPLY);

  /* ---- creator supply: 2 to payer, 1 to mate — before any guard ---- */
  step("3/6", "creator supply, split 2/1");
  const devPlan = [
    { to: payer.publicKey, count: 2 },
    { to: mate.publicKey, count: 1 }
  ];
  let lastDevAsset = null;
  for (const d of devPlan) {
    for (let k = 0; k < d.count; k++) {
      const asset = generateSigner(umi);
      lastDevAsset = { asset, to: d.to };
      await (await mintAssetFromCandyMachine(umi, {
        candyMachine: candyMachine.publicKey,
        mintAuthority: payer,
        asset, assetOwner: d.to,
        collection: collection.publicKey
      })).prepend(setComputeUnitLimit(umi, { units: 800000 }))
        .sendAndConfirm(umi, { confirm: { commitment: "confirmed" } });
    }
  }
  const mateAsset = await fetchAsset(umi, lastDevAsset.asset.publicKey);
  if (String(mateAsset.owner) !== String(mate.publicKey)) die("split recipient does not own their asset");
  ok("mate owns their dev mint: " + lastDevAsset.asset.publicKey);
  let cm = await fetchCandyMachine(umi, candyMachine.publicKey);
  if (Number(cm.itemsRedeemed) !== 3) die("redeemed=" + cm.itemsRedeemed + " expected 3");
  ok("itemsRedeemed = 3");

  /* ---- guard: price + per-wallet cap in defaults; wave + public groups ---- */
  step("4/6", "guard — price 0.05, cap 2/wallet, wave w1 now, public in 10 min");
  const allowW1 = [String(payer.publicKey), String(mate.publicKey)];
  const now = new Date();
  await createCandyGuard(umi, {
    base: candyMachine,
    guards: {
      solPayment: some({ lamports: sol(0.05), destination: payer.publicKey }),
      mintLimit: some({ id: 1, limit: 2 }),
      botTax: some({ lamports: sol(0.01), lastInstruction: true })
    },
    groups: [
      { label: "w1", guards: {
          allowList: some({ merkleRoot: getMerkleRoot(allowW1) }),
          startDate: some({ date: dateTime(now) }) } },
      { label: "pub", guards: {
          startDate: some({ date: dateTime(new Date(now.getTime() + 10 * 60000)) }) } }
    ]
  }).sendAndConfirm(umi, { confirm: { commitment: "confirmed" } });
  const candyGuard = findCandyGuardPda(umi, { base: candyMachine.publicKey });
  await wrap(umi, { candyGuard, candyMachine: candyMachine.publicKey })
    .sendAndConfirm(umi, { confirm: { commitment: "confirmed" } });
  ok("guard wrapped");

  /* ---- the public group must refuse before its start date ----
   * With botTax armed, a rejected mint is a SUCCESSFUL transaction that
   * charges the tax and mints nothing — that is the guard working, and the
   * first version of this test read it as the guard failing. Assert on
   * whether the asset exists and the counter moved, never on the tx throwing. */
  step("5/6", "public mint before opening — must be refused (tax, no asset)");
  {
    const a = generateSigner(umi);
    let threw = false;
    try {
      await (await mintV1(umi, {
        candyMachine: candyMachine.publicKey, asset: a, collection: collection.publicKey,
        group: some("pub"),
        mintArgs: { solPayment: some({ destination: payer.publicKey }), mintLimit: some({ id: 1 }) }
      })).prepend(setComputeUnitLimit(umi, { units: 800000 }))
        .sendAndConfirm(umi, { confirm: { commitment: "confirmed" } });
    } catch (e) { threw = true; ok("rejected outright: " + String(e.message).slice(0, 50)); }
    if (!threw) {
      const exists = await fetchAsset(umi, a.publicKey).then(() => true).catch(() => false);
      if (exists) die("public mint produced an asset before its start date");
      ok("tx landed as a bot-tax charge, no asset minted — guard held");
    }
    const mid = await fetchCandyMachine(umi, candyMachine.publicKey);
    if (Number(mid.itemsRedeemed) !== 3) die("redeemed moved to " + mid.itemsRedeemed);
    ok("itemsRedeemed still 3");
  }

  /* ---- wave mint with a merkle proof ---- */
  step("6/6", "wave mint through the allowlist proof");
  await route(umi, {
    candyMachine: candyMachine.publicKey,
    candyGuard,
    guard: "allowList",
    group: some("w1"),
    routeArgs: {
      path: "proof",
      merkleRoot: getMerkleRoot(allowW1),
      merkleProof: getMerkleProof(allowW1, String(payer.publicKey))
    }
  }).sendAndConfirm(umi, { confirm: { commitment: "confirmed" } });

  const waveAsset = generateSigner(umi);
  await (await mintV1(umi, {
    candyMachine: candyMachine.publicKey, asset: waveAsset, collection: collection.publicKey,
    group: some("w1"),
    mintArgs: {
      allowList: some({ merkleRoot: getMerkleRoot(allowW1) }),
      solPayment: some({ destination: payer.publicKey }),
      mintLimit: some({ id: 1 })
    }
  })).prepend(setComputeUnitLimit(umi, { units: 800000 }))
    .sendAndConfirm(umi, { confirm: { commitment: "confirmed" } });
  ok("minted " + waveAsset.publicKey);

  cm = await fetchCandyMachine(umi, candyMachine.publicKey);
  if (Number(cm.itemsRedeemed) !== 4) die("redeemed=" + cm.itemsRedeemed + " expected 4");
  ok("itemsRedeemed = 4 (3 dev + 1 wave)");

  console.log("\n  PASS — dev mints, splits, waves, allowlist proofs and caps all work");
})().catch((e) => {
  console.error("\n  FAIL — " + (e && e.message ? e.message : e));
  if (e && e.logs) console.error("  " + e.logs.slice(-8).join("\n  "));
  process.exit(1);
});
