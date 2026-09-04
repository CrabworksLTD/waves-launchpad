#!/usr/bin/env node
/* Devnet smoke for the 5→3 INSTRUCTION-COMBINED deploy (not batching separate
 * txs — that gets Phantom-blocked; this puts dependent steps INSIDE one tx,
 * which is a normal single tx Phantom simulates fine).
 *
 * Validates the two risky assumptions before touching launch.js:
 *   TX1: createCollection + createCandyGuard in ONE tx
 *        → does the guard build before the machine EXISTS? does it fit?
 *   TX2: createCandyMachine + wrap in ONE tx
 *        → does wrap see the machine created earlier in the same tx? fit?
 *   #3 : all config lines batched (independent → Phantom-safe like the mint batch)
 * then a guarded mintV1 to prove the result is mintable.
 *
 *   node tools/deploy-combine-smoke.js
 */
"use strict";
const RPC = process.env.SOLANA_RPC || "https://api.devnet.solana.com";

(async () => {
  const { createUmi } = await import("@metaplex-foundation/umi-bundle-defaults");
  const { generateSigner, signerIdentity, sol, some, base58,
          createSignerFromKeypair, dateTime } = await import("@metaplex-foundation/umi");
  const { mplCore, createCollection, fetchAsset } = await import("@metaplex-foundation/mpl-core");
  const { mplCandyMachine, createCandyMachine, createCandyGuard, wrap, addConfigLines,
          mintV1, findCandyGuardPda, fetchCandyMachine } = await import("@metaplex-foundation/mpl-core-candy-machine");
  const { setComputeUnitLimit } = await import("@metaplex-foundation/mpl-toolbox");

  const umi = createUmi(RPC, "confirmed").use(mplCore()).use(mplCandyMachine());
  const fs = require("fs"), path = require("path");
  const KEYFILE = path.join(__dirname, "..", ".devnet-smoke.key");
  const payer = process.env.SMOKE_SECRET
    ? createSignerFromKeypair(umi, umi.eddsa.createKeypairFromSecretKey(base58.serialize(process.env.SMOKE_SECRET)))
    : createSignerFromKeypair(umi, umi.eddsa.createKeypairFromSecretKey(base58.serialize(fs.readFileSync(KEYFILE, "utf8").trim())));
  umi.use(signerIdentity(payer));
  console.log("  rpc   " + RPC + "\n  payer " + payer.publicKey);
  const bal = await umi.rpc.getBalance(payer.publicKey);
  console.log("  bal   " + (Number(bal.basisPoints) / 1e9).toFixed(3) + " SOL");
  if (Number(bal.basisPoints) < 0.05e9) { console.log("  too low — fund it"); process.exit(2); }

  const PRE = "https://arweave.net/0000000000000000000000000000000000000000000/";
  const guards = { solPayment: some({ lamports: sol(0.01), destination: payer.publicKey }),
                   startDate: some({ date: dateTime(new Date(Date.now() - 60000)) }) };
  const SUPPLY = 8;

  const confirm = (b) => b.sendAndConfirm(umi, { confirm: { commitment: "confirmed" } });

  const collection = generateSigner(umi);
  const candyMachine = generateSigner(umi);
  const candyGuard = findCandyGuardPda(umi, { base: candyMachine.publicKey });

  // ---- TX 1: collection + guard, one transaction ----
  console.log("\n  TX1  collection + createCandyGuard (guard before machine exists)");
  const tx1 = createCollection(umi, { collection, name: "Combine Smoke", uri: PRE + "_c.json",
      plugins: [{ type: "Royalties", basisPoints: 500, creators: [{ address: payer.publicKey, percentage: 100 }], ruleSet: { __kind: "None" } }] })
    .add(createCandyGuard(umi, { base: candyMachine, guards, groups: [] }));
  console.log("       instructions=" + tx1.getInstructions().length + "  fits=" + tx1.fitsInOneTransaction(umi));
  await confirm(tx1);
  console.log("       ok  collection " + collection.publicKey);
  console.log("       ok  guard      " + candyGuard[0]);

  // ---- TX 2: machine + wrap, one transaction ----
  console.log("\n  TX2  createCandyMachine + wrap (wrap sees the machine from same tx)");
  let tx2 = (await createCandyMachine(umi, { candyMachine, collection: collection.publicKey, collectionUpdateAuthority: payer,
      itemsAvailable: SUPPLY, authority: payer.publicKey, isMutable: true,
      configLineSettings: some({ prefixName: "S #", nameLength: 4, prefixUri: PRE, uriLength: 12, isSequential: false }) }))
    .add(wrap(umi, { candyGuard, candyMachine: candyMachine.publicKey }));
  console.log("       instructions=" + tx2.getInstructions().length + "  fits=" + tx2.fitsInOneTransaction(umi));
  await confirm(tx2);
  console.log("       ok  machine    " + candyMachine.publicKey);

  // ---- #3: config lines batched (independent → Phantom-safe) ----
  console.log("\n  #3   config lines (batched signAllTransactions)");
  const lineTxs = [];
  const bh = await umi.rpc.getLatestBlockhash();
  for (let start = 0; start < SUPPLY; start += 10) {
    const lines = [];
    for (let i = start; i < Math.min(start + 10, SUPPLY); i++) lines.push({ name: String(i + 1), uri: (i + 1) + ".json" });
    lineTxs.push(addConfigLines(umi, { candyMachine: candyMachine.publicKey, index: start, configLines: lines }).setBlockhash(bh).build(umi));
  }
  const signedLines = await umi.identity.signAllTransactions(lineTxs);
  for (const s of signedLines) {
    const sig = await umi.rpc.sendTransaction(s, { maxRetries: 5 });
    await umi.rpc.confirmTransaction(sig, { strategy: { type: "blockhash", blockhash: bh.blockhash, lastValidBlockHeight: bh.lastValidBlockHeight }, commitment: "confirmed" });
  }
  const cm = await fetchCandyMachine(umi, candyMachine.publicKey);
  if (Number(cm.itemsLoaded) !== SUPPLY) throw new Error("items loaded " + cm.itemsLoaded + "/" + SUPPLY);
  console.log("       ok  loaded " + cm.itemsLoaded + "/" + SUPPLY);

  // ---- prove it mints through the guard ----
  console.log("\n  mint through the wrapped guard");
  const asset = generateSigner(umi);
  await confirm((await mintV1(umi, { candyMachine: candyMachine.publicKey, asset, collection: collection.publicKey, mintArgs: { solPayment: some({ destination: payer.publicKey }) } }))
    .prepend(setComputeUnitLimit(umi, { units: 800000 })));
  await fetchAsset(umi, asset.publicKey);
  console.log("       ok  minted " + asset.publicKey);

  console.log("\n  PASS — 3-signature structure works. collection+guard=1, machine+wrap=1, config=1");
  console.log("  cm https://explorer.solana.com/address/" + candyMachine.publicKey + "?cluster=devnet");
})().catch((e) => {
  console.error("\n  FAIL — " + (e && e.message ? e.message : e));
  if (e && e.logs) console.error("  logs:\n   " + e.logs.join("\n   "));
  process.exit(1);
});
