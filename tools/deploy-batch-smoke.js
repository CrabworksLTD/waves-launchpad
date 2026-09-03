#!/usr/bin/env node
/* Devnet smoke of the BATCHED NFT deploy (app/public/launch.js).
 *
 *   node tools/deploy-batch-smoke.js
 *
 * Proves the new one/two-approval flow end to end on real devnet: build every
 * deploy transaction up front, sign the whole batch in ONE approval via
 * umi.identity.signAllTransactions (the SAME umi API the browser wallet uses —
 * here the identity is the smoke keypair), then broadcast in dependency order.
 * Runs BOTH paths:
 *   - no dev mints  → setup + guard in ONE approval  (the "1 signature" case)
 *   - with dev mints → setup, then dev mints + guard  (two approvals)
 * and finishes each with a guarded mintV1 to prove the wrapped guard works.
 *
 * Uses the persisted .devnet-smoke.key (already funded). SMOKE_SECRET overrides.
 */
"use strict";
const RPC = process.env.SOLANA_RPC || "https://api.devnet.solana.com";

(async () => {
  const { createUmi } = await import("@metaplex-foundation/umi-bundle-defaults");
  const { generateSigner, signerIdentity, sol, some, base58,
          createSignerFromKeypair, dateTime } = await import("@metaplex-foundation/umi");
  const { mplCore, createCollection, fetchAsset } = await import("@metaplex-foundation/mpl-core");
  const { mplCandyMachine, createCandyMachine, createCandyGuard, wrap, addConfigLines,
          mintAssetFromCandyMachine, mintV1, findCandyGuardPda,
          fetchCandyMachine } = await import("@metaplex-foundation/mpl-core-candy-machine");
  const { setComputeUnitLimit } = await import("@metaplex-foundation/mpl-toolbox");

  const umi = createUmi(RPC, "confirmed").use(mplCore()).use(mplCandyMachine());
  const fs = require("fs"), path = require("path");
  const KEYFILE = path.join(__dirname, "..", ".devnet-smoke.key");
  const payer = process.env.SMOKE_SECRET
    ? createSignerFromKeypair(umi, umi.eddsa.createKeypairFromSecretKey(base58.serialize(process.env.SMOKE_SECRET)))
    : createSignerFromKeypair(umi, umi.eddsa.createKeypairFromSecretKey(base58.serialize(fs.readFileSync(KEYFILE, "utf8").trim())));
  umi.use(signerIdentity(payer));
  console.log("  rpc   " + RPC);
  console.log("  payer " + payer.publicKey);

  let bal = await umi.rpc.getBalance(payer.publicKey);
  if (Number(bal.basisPoints) < 0.1e9) {   // both runs cost ~0.12 SOL; airdrop only if truly low
    try { await umi.rpc.airdrop(payer.publicKey, sol(2)); bal = await umi.rpc.getBalance(payer.publicKey); }
    catch (e) { console.log("  fund this address with devnet SOL, then rerun:\n    " + payer.publicKey); process.exit(2); }
  }
  console.log("  bal   " + (Number(bal.basisPoints) / 1e9).toFixed(3) + " SOL");

  // ---- the batch() helper, copied verbatim from launch.js ----
  async function batch(items) {
    items = items.filter(Boolean);
    if (!items.length) return;
    if (typeof umi.identity.signAllTransactions !== "function") {
      for (const it of items) await it.b.sendAndConfirm(umi, { confirm: { commitment: "confirmed" } });
      return;
    }
    const CAP = 12;
    for (let s = 0; s < items.length; s += CAP) {
      const chunk = items.slice(s, s + CAP);
      const bh = await umi.rpc.getLatestBlockhash();
      const unsigned = [];
      for (let j = 0; j < chunk.length; j++) {
        let tx = chunk[j].b.setBlockhash(bh).build(umi);
        for (const sg of (chunk[j].signers || [])) tx = await sg.signTransaction(tx);
        unsigned.push(tx);
      }
      const signed = await umi.identity.signAllTransactions(unsigned);
      for (let n = 0; n < signed.length; n++) {
        const sig = await umi.rpc.sendTransaction(signed[n], { maxRetries: 5 });
        await umi.rpc.confirmTransaction(sig, {
          strategy: { type: "blockhash", blockhash: bh.blockhash, lastValidBlockHeight: bh.lastValidBlockHeight },
          commitment: "confirmed"
        });
      }
    }
  }

  const PRE = "https://arweave.net/0000000000000000000000000000000000000000000/";
  const lineSettings = () => some({ prefixName: "S #", nameLength: 4, prefixUri: PRE, uriLength: 12, isSequential: false });
  const guards = { solPayment: some({ lamports: sol(0.01), destination: payer.publicKey }),
                   startDate: some({ date: dateTime(new Date(Date.now() - 60000)) }) };

  async function runDeploy(label, supply, devCount) {
    console.log("\n== " + label + " ==");
    const collection = generateSigner(umi);
    const candyMachine = generateSigner(umi);
    const cg = findCandyGuardPda(umi, { base: candyMachine.publicKey });
    const guardOps = () => ([
      { b: createCandyGuard(umi, { base: candyMachine, guards, groups: [] }), signers: [candyMachine] },
      { b: wrap(umi, { candyGuard: cg, candyMachine: candyMachine.publicKey }), signers: [] },
    ]);
    const setup = [
      { b: createCollection(umi, { collection, name: label, uri: PRE + "_c.json",
            plugins: [{ type: "Royalties", basisPoints: 500, creators: [{ address: payer.publicKey, percentage: 100 }], ruleSet: { __kind: "None" } }] }),
        signers: [collection] },
      { b: await createCandyMachine(umi, { candyMachine, collection: collection.publicKey, collectionUpdateAuthority: payer,
            itemsAvailable: supply, authority: payer.publicKey, isMutable: true, configLineSettings: lineSettings() }),
        signers: [candyMachine] },
    ];
    for (let start = 0; start < supply; start += 10) {
      const lines = [];
      for (let i = start; i < Math.min(start + 10, supply); i++) lines.push({ name: String(i + 1), uri: (i + 1) + ".json" });
      setup.push({ b: addConfigLines(umi, { candyMachine: candyMachine.publicKey, index: start, configLines: lines }), signers: [] });
    }

    console.log("  approval 1 (setup" + (devCount ? "" : " + guard") + ") …");
    await batch(devCount > 0 ? setup : setup.concat(guardOps()));
    let cm = await fetchCandyMachine(umi, candyMachine.publicKey);
    if (Number(cm.itemsLoaded) !== supply) throw new Error("items loaded " + cm.itemsLoaded + "/" + supply);
    console.log("  items loaded " + cm.itemsLoaded + "/" + supply + " ok");

    if (devCount > 0) {
      const dev = [];
      for (let k = 0; k < devCount; k++) {
        const asset = generateSigner(umi);
        const mb = (await mintAssetFromCandyMachine(umi, { candyMachine: candyMachine.publicKey, mintAuthority: payer, asset, assetOwner: payer.publicKey, collection: collection.publicKey }))
          .prepend(setComputeUnitLimit(umi, { units: 800000 }));
        dev.push({ b: mb, signers: [asset], asset });
      }
      console.log("  approval 2 (dev x" + devCount + " + guard) …");
      await batch(dev.concat(guardOps()));
      for (const d of dev) await fetchAsset(umi, d.asset.publicKey);
      console.log("  " + devCount + " dev mints ok");
    }

    // the guard is now wrapped — a guarded public mint must work
    const asset = generateSigner(umi);
    await (await mintV1(umi, { candyMachine: candyMachine.publicKey, asset, collection: collection.publicKey, mintArgs: { solPayment: some({ destination: payer.publicKey }) } }))
      .prepend(setComputeUnitLimit(umi, { units: 800000 }))
      .sendAndConfirm(umi, { confirm: { commitment: "confirmed" } });
    await fetchAsset(umi, asset.publicKey);
    cm = await fetchCandyMachine(umi, candyMachine.publicKey);
    console.log("  guarded mint ok, itemsRedeemed=" + cm.itemsRedeemed);
    console.log("  PASS " + label);
    console.log("       cm https://explorer.solana.com/address/" + candyMachine.publicKey + "?cluster=devnet");
  }

  await runDeploy("no-dev (ONE approval)", 5, 0);
  await runDeploy("with-dev (two approvals)", 5, 2);
  console.log("\n  ALL PASS — the batched deploy works on devnet");
})().catch((e) => {
  console.error("\n  FAIL — " + (e && e.message ? e.message : e));
  if (e && e.logs) console.error("  logs:\n   " + e.logs.join("\n   "));
  process.exit(1);
});
