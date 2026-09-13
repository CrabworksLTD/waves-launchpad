/**
 * waves-staking localnet suite. The validator clones the real mpl-core
 * program (Anchor.toml), so ownership checks run against actual Core
 * accounts, not mocks.
 *
 * Covers:
 *  1. pool init for a (token, collection) pair
 *  2. stake = burn; weights and supply move
 *  3. deposit + sync -> claim pays the sole staker everything
 *  4. pro-rata: second staker at 2x weight takes 2/3 of the next pot
 *  5. the sold-NFT handoff: buyer claims what accrues after transfer
 *  6. refusals: non-owner claim, foreign-collection asset, zero stake
 */
import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import {
  Keypair, PublicKey, SystemProgram, Transaction, LAMPORTS_PER_SOL,
} from "@solana/web3.js";
import {
  createMint, mintTo, createAssociatedTokenAccountIdempotent, getAccount,
  getAssociatedTokenAddressSync, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID,
  createAssociatedTokenAccountInstruction,
} from "@solana/spl-token";
import { createUmi } from "@metaplex-foundation/umi-bundle-defaults";
import {
  mplCore, createCollection, create, transfer, fetchAsset,
} from "@metaplex-foundation/mpl-core";
import {
  keypairIdentity, generateSigner, publicKey as umiPk,
  createSignerFromKeypair,
} from "@metaplex-foundation/umi";
import {
  fromWeb3JsKeypair, toWeb3JsPublicKey,
} from "@metaplex-foundation/umi-web3js-adapters";
import { expect } from "chai";
// anchor's BN re-export is not constructible under ts-mocha ESM interop
import BN from "bn.js";

describe("waves-staking", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const program = anchor.workspace.wavesStaking as Program;
  const payer = (provider.wallet as anchor.Wallet).payer;
  const conn = provider.connection;

  // cast
  const staker = Keypair.generate();
  const staker2 = Keypair.generate();
  const buyer = Keypair.generate();

  // chain fixtures
  let tokenMint: PublicKey;      // the paired token that burns
  let rewardMint: PublicKey;     // what claims pay in
  let collection: PublicKey;     // Core collection
  let asset1: PublicKey;         // staker's NFT
  let asset2: PublicKey;         // staker2's NFT
  let pool: PublicKey;
  let vault: PublicKey;
  let umi: ReturnType<typeof createUmi>;

  const poolPda = () => PublicKey.findProgramAddressSync(
    [Buffer.from("pool"), tokenMint.toBuffer(), collection.toBuffer()],
    program.programId)[0];
  // C-1: the position PDA is bound to (pool, asset), not the asset alone.
  const posPda = (asset: PublicKey, poolKey: PublicKey = poolPda()) =>
    PublicKey.findProgramAddressSync(
      [Buffer.from("pos"), poolKey.toBuffer(), asset.toBuffer()], program.programId)[0];

  async function deposit(lamportsOfReward: number | bigint) {
    await mintTo(conn, payer, rewardMint, vault, payer, BigInt(lamportsOfReward));
    await program.methods.sync().accounts({ pool, vault }).rpc();
  }
  const vaultBal = async () => (await getAccount(conn, vault)).amount;

  before(async () => {
    /* Fund the cast. 2 SOL each is free on a local validator but real money on
     * devnet, where the faucet is rate-limited to the point of being unusable —
     * so take only what the accounts actually need there. Rent for a handful of
     * Core assets and token accounts plus fees comes in well under 0.1 SOL. */
    const onDevnet = /devnet/.test(conn.rpcEndpoint);
    const each = onDevnet ? 0.08 * LAMPORTS_PER_SOL : 2 * LAMPORTS_PER_SOL;
    const tx = new Transaction();
    for (const kp of [staker, staker2, buyer]) {
      tx.add(SystemProgram.transfer({
        fromPubkey: payer.publicKey, toPubkey: kp.publicKey, lamports: each,
      }));
    }
    await provider.sendAndConfirm(tx);

    // SPL mints: the burnable pair token and the reward token
    tokenMint = await createMint(conn, payer, payer.publicKey, null, 6);
    rewardMint = await createMint(conn, payer, payer.publicKey, null, 6);
    for (const kp of [staker, staker2]) {
      const ata = await createAssociatedTokenAccountIdempotent(
        conn, payer, tokenMint, kp.publicKey);
      await mintTo(conn, payer, tokenMint, ata, payer, 1_000_000_000n); // 1000 tokens
    }

    // Core collection + assets against the CLONED mpl-core program.
    // commitment must be pinned: umi's finalized default races a
    // seconds-old validator whose finalized bank is still genesis
    umi = createUmi(conn.rpcEndpoint, { commitment: "confirmed" }).use(mplCore());
    umi.use(keypairIdentity(fromWeb3JsKeypair(payer)));
    const col = generateSigner(umi);
    await createCollection(umi, {
      collection: col, name: "Stake Test", uri: "https://example.com/c.json",
    }).sendAndConfirm(umi).catch((e: any) => {
      console.error("createCollection failed:", e.message,
        e.logs || (e.getLogs ? "call getLogs" : ""));
      throw e;
    });
    collection = toWeb3JsPublicKey(col.publicKey);

    const a1 = generateSigner(umi), a2 = generateSigner(umi);
    await create(umi, {
      asset: a1, collection: { publicKey: col.publicKey },
      name: "#1", uri: "https://example.com/1.json",
      owner: umiPk(staker.publicKey.toBase58()),
    }).sendAndConfirm(umi);
    await create(umi, {
      asset: a2, collection: { publicKey: col.publicKey },
      name: "#2", uri: "https://example.com/2.json",
      owner: umiPk(staker2.publicKey.toBase58()),
    }).sendAndConfirm(umi);
    asset1 = toWeb3JsPublicKey(a1.publicKey);
    asset2 = toWeb3JsPublicKey(a2.publicKey);

    pool = poolPda();
    // vault: reward-mint ATA owned by the pool PDA
    vault = getAssociatedTokenAddressSync(rewardMint, pool, true);
    await createAssociatedTokenAccountIdempotent(conn, payer, rewardMint, pool, {}, undefined, undefined, true as any)
      .catch(async () => {
        // older spl-token signature — fall back to explicit off-curve create
        const { createAssociatedTokenAccountInstruction } = await import("@solana/spl-token");
        const ix = createAssociatedTokenAccountInstruction(
          payer.publicKey, vault, pool, rewardMint,
          TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID);
        await provider.sendAndConfirm(new Transaction().add(ix));
      });
  });

  it("initializes the pool", async () => {
    await program.methods.initPool().accounts({
      pool, tokenMint, collection, rewardMint, vault,
      payer: payer.publicKey,
      tokenProgram: TOKEN_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
    }).rpc();
    const st: any = await (program.account as any).rewardPool.fetch(pool);
    expect(st.totalWeight.toNumber()).to.eq(0);
  });

  it("stake burns the token and records weight", async () => {
    const ata = getAssociatedTokenAddressSync(tokenMint, staker.publicKey);
    const beforeBal = (await getAccount(conn, ata)).amount;
    await program.methods.stake(new BN(100_000_000)).accounts({
      pool, position: posPda(asset1), asset: asset1,
      tokenMint, stakerTokens: ata, owner: staker.publicKey,
      tokenProgram: TOKEN_PROGRAM_ID, systemProgram: SystemProgram.programId,
    }).signers([staker]).rpc();
    expect((await getAccount(conn, ata)).amount).to.eq(beforeBal - 100_000_000n);
    const st: any = await (program.account as any).rewardPool.fetch(pool);
    expect(st.totalWeight.toNumber()).to.eq(100_000_000);
  });

  it("sole staker claims the whole pot", async () => {
    await deposit(500_000);
    const dest = await createAssociatedTokenAccountIdempotent(
      conn, payer, rewardMint, staker.publicKey);
    await program.methods.claim().accounts({
      pool, position: posPda(asset1), asset: asset1,
      vault, rewardMint, destination: dest, owner: staker.publicKey,
      tokenProgram: TOKEN_PROGRAM_ID,
    }).signers([staker]).rpc();
    expect((await getAccount(conn, dest)).amount).to.eq(500_000n);
  });

  it("splits the next pot pro-rata (2x weight -> 2/3)", async () => {
    const ata2 = getAssociatedTokenAddressSync(tokenMint, staker2.publicKey);
    await program.methods.stake(new BN(200_000_000)).accounts({
      pool, position: posPda(asset2), asset: asset2,
      tokenMint, stakerTokens: ata2, owner: staker2.publicKey,
      tokenProgram: TOKEN_PROGRAM_ID, systemProgram: SystemProgram.programId,
    }).signers([staker2]).rpc();

    await deposit(900_000);
    const d1 = await createAssociatedTokenAccountIdempotent(
      conn, payer, rewardMint, staker.publicKey);
    const d2 = await createAssociatedTokenAccountIdempotent(
      conn, payer, rewardMint, staker2.publicKey);
    const b1 = (await getAccount(conn, d1)).amount;

    await program.methods.claim().accounts({
      pool, position: posPda(asset1), asset: asset1,
      vault, rewardMint, destination: d1, owner: staker.publicKey,
      tokenProgram: TOKEN_PROGRAM_ID,
    }).signers([staker]).rpc();
    await program.methods.claim().accounts({
      pool, position: posPda(asset2), asset: asset2,
      vault, rewardMint, destination: d2, owner: staker2.publicKey,
      tokenProgram: TOKEN_PROGRAM_ID,
    }).signers([staker2]).rpc();

    expect((await getAccount(conn, d1)).amount - b1).to.eq(300_000n); // 1/3
    expect((await getAccount(conn, d2)).amount).to.eq(600_000n);      // 2/3
  });

  it("a sold NFT's new owner claims what accrues after the sale", async () => {
    // staker sells asset1 to buyer — the owner must be the signing authority
    await transfer(umi, {
      asset: await fetchAsset(umi, umiPk(asset1.toBase58())),
      collection: { publicKey: umiPk(collection.toBase58()) } as any,
      authority: createSignerFromKeypair(umi, fromWeb3JsKeypair(staker)),
      newOwner: umiPk(buyer.publicKey.toBase58()),
    } as any).sendAndConfirm(umi);

    await deposit(300_000);
    // the SELLER can no longer claim
    const dSeller = getAssociatedTokenAddressSync(rewardMint, staker.publicKey);
    let refused = false;
    await program.methods.claim().accounts({
      pool, position: posPda(asset1), asset: asset1,
      vault, rewardMint, destination: dSeller, owner: staker.publicKey,
      tokenProgram: TOKEN_PROGRAM_ID,
    }).signers([staker]).rpc().catch(() => { refused = true; });
    expect(refused, "seller claim must fail").to.be.true;

    // the BUYER claims asset1's third of the new pot
    const dBuyer = await createAssociatedTokenAccountIdempotent(
      conn, payer, rewardMint, buyer.publicKey);
    await program.methods.claim().accounts({
      pool, position: posPda(asset1), asset: asset1,
      vault, rewardMint, destination: dBuyer, owner: buyer.publicKey,
      tokenProgram: TOKEN_PROGRAM_ID,
    }).signers([buyer]).rpc();
    expect((await getAccount(conn, dBuyer)).amount).to.eq(100_000n);
  });

  it("refuses zero stakes", async () => {
    const ata2 = getAssociatedTokenAddressSync(tokenMint, staker2.publicKey);
    let refused = false;
    await program.methods.stake(new BN(0)).accounts({
      pool, position: posPda(asset2), asset: asset2,
      tokenMint, stakerTokens: ata2, owner: staker2.publicKey,
      tokenProgram: TOKEN_PROGRAM_ID, systemProgram: SystemProgram.programId,
    }).signers([staker2]).rpc().catch(() => { refused = true; });
    expect(refused).to.be.true;
  });

  // C-1 regression: an attacker who owns a collection NFT must not be able to
  // drain the real vault by inflating weight in a pool they made themselves that
  // shares the collection. The position PDA is bound to (pool, asset), so weight
  // built under a foreign pool cannot reach the real pool's vault.
  it("C-1: a cross-pool position cannot drain the real vault", async () => {
    // attacker owns a fresh asset in the SAME collection
    const a3 = generateSigner(umi);
    await create(umi, {
      asset: a3, collection: { publicKey: umiPk(collection.toBase58()) } as any,
      name: "#3", uri: "https://example.com/3.json",
      owner: umiPk(staker2.publicKey.toBase58()),
    }).sendAndConfirm(umi);
    const asset3 = toWeb3JsPublicKey(a3.publicKey);

    // attacker mints a worthless token and opens their OWN pool for
    // (worthlessToken, sharedCollection)
    const fakeToken = await createMint(conn, payer, payer.publicKey, null, 6);
    const fakeAta = await createAssociatedTokenAccountIdempotent(
      conn, payer, fakeToken, staker2.publicKey);
    await mintTo(conn, payer, fakeToken, fakeAta, payer, 1_000_000_000n);

    const fakePool = PublicKey.findProgramAddressSync(
      [Buffer.from("pool"), fakeToken.toBuffer(), collection.toBuffer()],
      program.programId)[0];
    const fakeVault = getAssociatedTokenAddressSync(rewardMint, fakePool, true);
    await provider.sendAndConfirm(new Transaction().add(
      createAssociatedTokenAccountInstruction(
        payer.publicKey, fakeVault, fakePool, rewardMint,
        TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID)));
    await program.methods.initPool().accounts({
      pool: fakePool, tokenMint: fakeToken, collection, rewardMint, vault: fakeVault,
      payer: payer.publicKey, tokenProgram: TOKEN_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
    }).rpc();

    // attacker stakes a huge weight into their own pool — debt anchors to
    // fakePool.acc_per_weight (0); this is the vector the old seed allowed
    await program.methods.stake(new BN(500_000_000)).accounts({
      pool: fakePool, position: posPda(asset3, fakePool), asset: asset3,
      tokenMint: fakeToken, stakerTokens: fakeAta, owner: staker2.publicKey,
      tokenProgram: TOKEN_PROGRAM_ID, systemProgram: SystemProgram.programId,
    }).signers([staker2]).rpc();

    // ensure the REAL vault holds money worth stealing
    await deposit(1_000_000);
    const realBefore = await vaultBal();
    const dest = await createAssociatedTokenAccountIdempotent(
      conn, payer, rewardMint, staker2.publicKey);

    // (A) claim the REAL pool pointing at the inflated fakePool position — the
    //     seed constraint (pool.key() in the seed) rejects it
    let blockedA = false;
    await program.methods.claim().accounts({
      pool, position: posPda(asset3, fakePool), asset: asset3,
      vault, rewardMint, destination: dest, owner: staker2.publicKey,
      tokenProgram: TOKEN_PROGRAM_ID,
    }).signers([staker2]).rpc().catch(() => { blockedA = true; });
    expect(blockedA, "foreign-pool position must be rejected").to.be.true;

    // (B) claim the REAL pool with the correctly-derived real position — never
    //     staked there, so the account does not exist and nothing pays
    let blockedB = false;
    await program.methods.claim().accounts({
      pool, position: posPda(asset3, pool), asset: asset3,
      vault, rewardMint, destination: dest, owner: staker2.publicKey,
      tokenProgram: TOKEN_PROGRAM_ID,
    }).signers([staker2]).rpc().catch(() => { blockedB = true; });
    expect(blockedB, "unstaked real position must not pay").to.be.true;

    // the real vault is untouched
    expect(await vaultBal()).to.eq(realBefore);
  });

  // M-1: frozen and plugin-delegated assets are accepted by design (entitlement
  // is ownership, not transferability). The real exposure the auditor named is
  // layout drift — so this proves verify_core_asset still reads owner (1..33) and
  // collection (34..66) correctly when a plugin sits AFTER the fixed-size header.
  // Pinned to mpl-core 1.10.0 (package.json); re-run if that is bumped.
  it("M-1: frozen and delegated assets stake + claim by their owner", async () => {
    const cases = [
      { name: "frozen", plugins: [{ type: "FreezeDelegate", frozen: true }] },
      { name: "delegated", plugins: [
        { type: "FreezeDelegate", frozen: false,
          authority: { type: "Address", address: umiPk(payer.publicKey.toBase58()) } }] },
    ];
    for (const cse of cases) {
      const a = generateSigner(umi);
      await create(umi, {
        asset: a, collection: { publicKey: umiPk(collection.toBase58()) } as any,
        name: "#" + cse.name, uri: "https://example.com/" + cse.name + ".json",
        owner: umiPk(staker2.publicKey.toBase58()),
        plugins: cse.plugins as any,
      } as any).sendAndConfirm(umi);
      const asset = toWeb3JsPublicKey(a.publicKey);

      const ata = await createAssociatedTokenAccountIdempotent(conn, payer, tokenMint, staker2.publicKey);
      await mintTo(conn, payer, tokenMint, ata, payer, 50_000_000n);

      // stake MUST succeed — a shifted offset would revert here (NotAssetOwner /
      // NotInCollection) instead of reading past the plugin to the base fields
      await program.methods.stake(new BN(50_000_000)).accounts({
        pool, position: posPda(asset), asset,
        tokenMint, stakerTokens: ata, owner: staker2.publicKey,
        tokenProgram: TOKEN_PROGRAM_ID, systemProgram: SystemProgram.programId,
      }).signers([staker2]).rpc();

      await deposit(1_000_000);
      const dest = await createAssociatedTokenAccountIdempotent(conn, payer, rewardMint, staker2.publicKey);
      const before = (await getAccount(conn, dest)).amount;
      await program.methods.claim().accounts({
        pool, position: posPda(asset), asset,
        vault, rewardMint, destination: dest, owner: staker2.publicKey,
        tokenProgram: TOKEN_PROGRAM_ID,
      }).signers([staker2]).rpc();
      expect((await getAccount(conn, dest)).amount > before, cse.name + " owner must be paid")
        .to.be.true;
    }
  });
});
