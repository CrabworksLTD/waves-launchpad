/* WavesStake — browser client for the waves-staking program.
 *
 * The program (jt5JegTBVPZP8V6a48fnKYPFKTbpcTfkz91Pemur82H) is AUDITED (C-1 fixed,
 * M-1 resolved, 8/8 tests) and DEPLOYED IMMUTABLE on mainnet 2026-09-13. The PDA
 * seeds, account layouts and discriminators here match the audited src/lib.rs —
 * in particular Position now carries a `pool` field and the position PDA is
 * seeded [b"pos", pool, asset]. ⚠️ still to prove before pairing opens: an
 * end-to-end stake → sync → claim on mainnet, and the keeper fee→vault deposit
 * path. stake.html stays gated on PAIRING_LIVE until both are done.
 *
 * The port target: Moonpad's stake.js (EVM). Same page shape — earned/claim-all,
 * staked/weight/burned, per-asset rows — but wired to Anchor instructions and
 * the accumulator instead of a Solidity vault.
 *
 * Everything is derived from program/target/idl/waves_staking.json and
 * program/programs/waves-staking/src/lib.rs. If the program changes, re-derive
 * the discriminators, PDA seeds, layouts and PRECISION here — they must match. */
(function () {
  "use strict";

  // Program ID is fixed by the program keypair in ~/waves-keys, so a mainnet
  // deploy lands on this same address — no per-cluster switch needed.
  var PROGRAM_ID = "jt5JegTBVPZP8V6a48fnKYPFKTbpcTfkz91Pemur82H";
  var PRECISION = 1000000000000n;                 // 1e12 — MUST equal program PRECISION
  var TOKEN_PROGRAM = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
  var ATA_PROGRAM = "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL";
  var SYS_PROGRAM = "11111111111111111111111111111111";

  // 8-byte anchor discriminators, from the IDL. Hardcoded rather than hashed so
  // there is no sha256 dependency and no chance of a "global:" prefix drift.
  var IX = {
    init_pool: [116, 233, 199, 204, 115, 159, 171, 36],
    stake: [206, 176, 202, 18, 200, 209, 179, 108],    // arg: amount u64
    sync:  [4, 219, 40, 164, 21, 157, 189, 88],
    claim: [62, 198, 214, 193, 213, 159, 108, 210]
  };
  var TOKEN22_PROGRAM = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb"; // xStocks are T22

  var mxMod;
  function mx() { if (!mxMod) mxMod = import("/vendor/metaplex.esm.js"); return mxMod; }
  function rpcUrl() {
    // the paid Helius proxy — DAS (searchAssets) and getAccountInfo both need it;
    // the free public node 403s indexed reads. Same endpoint the token page uses.
    return (window.location && window.location.origin) + "/api/rpc";
  }
  function conn(X) { return new X.Connection(rpcUrl(), "confirmed"); }
  function pk(X, s) { return new X.PublicKey(s); }

  /* ---- PDAs (seeds straight from the IDL) ---- */
  function poolPda(X, tokenMint, collection) {
    return X.PublicKey.findProgramAddressSync(
      [enc("pool"), pk(X, tokenMint).toBuffer(), pk(X, collection).toBuffer()],
      pk(X, PROGRAM_ID))[0];
  }
  function positionPda(X, pool, asset) {
    // C-1 (audited): the position PDA is bound to (pool, asset), not the asset
    // alone — so one asset's position can't be shared across pools to drain a
    // foreign vault. Must match program seeds = [b"pos", pool, asset].
    return X.PublicKey.findProgramAddressSync(
      [enc("pos"), pk(X, pool).toBuffer(), pk(X, asset).toBuffer()], pk(X, PROGRAM_ID))[0];
  }
  // The reward vault is the pool PDA's associated token account for the reward
  // mint (DESIGN.md: "a token account owned by the pool PDA"). The pool is off
  // the ed25519 curve, so this is the off-curve ATA.
  function vaultAta(X, rewardMint, pool) {
    return X.PublicKey.findProgramAddressSync(
      [pool.toBuffer(), pk(X, TOKEN_PROGRAM).toBuffer(), pk(X, rewardMint).toBuffer()],
      pk(X, ATA_PROGRAM))[0];
  }
  function ownerAta(X, mint, owner) {
    return X.PublicKey.findProgramAddressSync(
      [pk(X, owner).toBuffer(), pk(X, TOKEN_PROGRAM).toBuffer(), pk(X, mint).toBuffer()],
      pk(X, ATA_PROGRAM))[0];
  }
  function enc(s) { return new TextEncoder().encode(s); }

  /* ---- little-endian readers over raw account bytes ---- */
  function u64(buf, o) { return new DataView(buf.buffer, buf.byteOffset + o, 8).getBigUint64(0, true); }
  function u128(buf, o) {
    var lo = u64(buf, o), hi = u64(buf, o + 8);
    return lo + (hi << 64n);
  }
  async function accountBytes(c, addr) {
    var info = await c.getAccountInfo(addr, "confirmed");
    if (!info || !info.data) return null;
    // web3 returns a Uint8Array/Buffer already for getAccountInfo
    return info.data instanceof Uint8Array ? info.data : new Uint8Array(info.data);
  }

  /* ---- decoders (layouts from the IDL types) ---- */
  // RewardPool: 8 disc | token_mint 32 | collection 32 | reward_mint 32 |
  //             vault 32 | total_weight u64 | acc_per_weight u128 | vault_last u64 | bump u8
  function decodePool(buf, X) {
    if (!buf) return null;
    return {
      tokenMint: new X.PublicKey(buf.slice(8, 40)).toBase58(),
      collection: new X.PublicKey(buf.slice(40, 72)).toBase58(),
      rewardMint: new X.PublicKey(buf.slice(72, 104)).toBase58(),
      vault: new X.PublicKey(buf.slice(104, 136)).toBase58(),
      totalWeight: u64(buf, 136),
      accPerWeight: u128(buf, 144),
      vaultLast: u64(buf, 160)
    };
  }
  // Position (audited C-1 layout): 8 disc | pool 32 | asset 32 | weight u64 |
  //   debt u128 | pending_credit u64 | bump u8. The `pool` field was ADDED by the
  //   C-1 fix, shifting every field below it by 32 bytes — reading the old offsets
  //   returned garbage weights/debt.
  function decodePosition(buf, X) {
    if (!buf) return null;
    return {
      pool: new X.PublicKey(buf.slice(8, 40)).toBase58(),
      asset: new X.PublicKey(buf.slice(40, 72)).toBase58(),
      weight: u64(buf, 72),
      debt: u128(buf, 80),
      pendingCredit: u64(buf, 96)
    };
  }
  // SPL token account amount lives at byte 64 (u64). Used for the live vault
  // balance, which sync() has not yet folded into acc_per_weight.
  function tokenAmount(buf) { return buf ? u64(buf, 64) : 0n; }

  /* ---- pending reward, mirroring settle() with a simulated sync() ----
   * lib.rs sync():   acc_per_weight += (vaultBal - vault_last) * PRECISION / total_weight
   *      settle():   owed = weight * acc_per_weight / PRECISION - debt
   *      claim():    owed += pending_credit
   * We simulate the un-synced vault delta so "you've earned" is live without
   * first sending a sync. ⚠️ verify against the program before trusting a number. */
  function pending(pool, pos, vaultBal) {
    if (!pool || !pos) return 0n;
    var acc = pool.accPerWeight;
    if (pool.totalWeight > 0n && vaultBal > pool.vaultLast) {
      acc += (vaultBal - pool.vaultLast) * PRECISION / pool.totalWeight;
    }
    var entitled = pos.weight * acc / PRECISION;
    var owed = entitled > pos.debt ? entitled - pos.debt : 0n;
    return owed + pos.pendingCredit;
  }

  /* ---- instruction builders (duck-typed {keys, programId, data}, the shape
   *      the vendor bundle's Transaction accepts — see token.js) ---- */
  function key(X, s, signer, writable) {
    return { pubkey: (s.toBuffer ? s : pk(X, s)), isSigner: !!signer, isWritable: !!writable };
  }
  function data(disc, extra) {
    var out = new Uint8Array(8 + (extra ? extra.length : 0));
    out.set(disc, 0);
    if (extra) out.set(extra, 8);
    return out;
  }
  function u64bytes(n) {
    var b = new Uint8Array(8);
    new DataView(b.buffer).setBigUint64(0, BigInt(n), true);
    return b;
  }
  /* init_pool — create the RewardPool for one collection+token, once, before any
   * fees route to it. From program src: the `vault` is NOT init'd here — it is a
   * token account owned by the pool PDA (token::authority = pool) that the CALLER
   * creates first (an ATA of the pool PDA for reward_mint). And token_program must
   * match the reward mint's program: classic SPL for SOL/USDC, Token-2022 for the
   * xStocks — so a.tokenProgram is resolved from the reward mint's owner, not
   * hardcoded. ⚠️ UNTESTED against a live program. */
  function ixInitPool(X, a) {  // a: {pool, tokenMint, collection, rewardMint, vault, payer, tokenProgram}
    return {
      programId: pk(X, PROGRAM_ID),
      keys: [
        key(X, a.pool, 0, 1), key(X, a.tokenMint, 0, 0), key(X, a.collection, 0, 0),
        key(X, a.rewardMint, 0, 0), key(X, a.vault, 0, 0), key(X, a.payer, 1, 1),
        key(X, a.tokenProgram || TOKEN_PROGRAM, 0, 0), key(X, SYS_PROGRAM, 0, 0)
      ],
      data: data(IX.init_pool)
    };
  }
  function ixStake(X, a) {   // a: {pool, position, asset, tokenMint, stakerTokens, owner, amount}
    return {
      programId: pk(X, PROGRAM_ID),
      keys: [
        key(X, a.pool, 0, 1), key(X, a.position, 0, 1), key(X, a.asset, 0, 0),
        key(X, a.tokenMint, 0, 1), key(X, a.stakerTokens, 0, 1), key(X, a.owner, 1, 1),
        key(X, TOKEN_PROGRAM, 0, 0), key(X, SYS_PROGRAM, 0, 0)
      ],
      data: data(IX.stake, u64bytes(a.amount))
    };
  }
  function ixSync(X, a) {    // a: {pool, vault}
    return {
      programId: pk(X, PROGRAM_ID),
      keys: [key(X, a.pool, 0, 1), key(X, a.vault, 0, 0)],
      data: data(IX.sync)
    };
  }
  function ixClaim(X, a) {   // a: {pool, position, asset, vault, rewardMint, destination, owner}
    return {
      programId: pk(X, PROGRAM_ID),
      keys: [
        key(X, a.pool, 0, 1), key(X, a.position, 0, 1), key(X, a.asset, 0, 0),
        key(X, a.vault, 0, 1), key(X, a.rewardMint, 0, 0), key(X, a.destination, 0, 1),
        key(X, a.owner, 1, 0), key(X, TOKEN_PROGRAM, 0, 0)
      ],
      data: data(IX.claim)
    };
  }

  /* ---- DAS: which of this collection's NFTs the wallet holds ----
   * Helius searchAssets by owner + collection grouping. Returns asset ids so the
   * page can render a row per NFT and derive each position PDA. */
  async function myAssets(collection, owner) {
    var body = {
      jsonrpc: "2.0", id: "waves-stake", method: "searchAssets",
      params: { ownerAddress: owner, grouping: ["collection", collection], page: 1, limit: 1000 }
    };
    var r = await fetch(rpcUrl(), {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify(body)
    });
    var j = await r.json().catch(function () { return {}; });
    var items = (j.result && j.result.items) || [];
    return items.map(function (it) { return it.id; });
  }

  /* ---- read-side summary for one pair, for a wallet ----
   * { earned, staked, totalWeight, vaultLast, positions:[{asset, weight, pending}] }
   * all bigints in the reward mint's base units; the page formats them. */
  async function summary(pair, owner) {
    // pair: { tokenMint, collection, rewardMint }
    var X = await mx(), c = conn(X);
    var pool = poolPda(X, pair.tokenMint, pair.collection);
    var poolAcc = decodePool(await accountBytes(c, pool), X);
    if (!poolAcc) return { live: false };            // pool not initialised on this cluster
    var vault = vaultAta(X, poolAcc.rewardMint, pool);
    var vaultBal = tokenAmount(await accountBytes(c, vault));

    var assets = owner ? await myAssets(pair.collection, owner) : [];
    var positions = [];
    var earned = 0n, yourWeight = 0n, staked = 0;
    for (var i = 0; i < assets.length; i++) {
      var posPk = positionPda(X, pool, assets[i]);
      var pos = decodePosition(await accountBytes(c, posPk), X);
      var w = pos ? pos.weight : 0n;
      var p = pos ? pending(poolAcc, pos, vaultBal) : 0n;
      earned += p;
      yourWeight += w;               // weight rises only by burning, so this is
      if (w > 0n) staked += 1;       // also this wallet's tokens burned
      positions.push({ asset: assets[i], weight: w, pending: p, staked: w > 0n });
    }
    return {
      live: true, earned: earned,
      // the stat row is about THIS wallet, not the pool: staked NFTs, its summed
      // position weight, and the tokens it burned (== weight, since burn is the
      // stake). poolTotalWeight is kept only for a share calc if the page wants one.
      staked: staked, yourWeight: yourWeight, yourBurned: yourWeight,
      poolTotalWeight: poolAcc.totalWeight,
      vaultBalance: vaultBal, vaultLast: poolAcc.vaultLast,
      rewardMint: poolAcc.rewardMint, positions: positions,
      pool: pool.toBase58(), vault: vault.toBase58()
    };
  }

  // Is the program present on the cluster the proxy points at? The page uses
  // this to decide whether to wake up or stay a preview.
  async function live() {
    try {
      var X = await mx(), c = conn(X);
      var info = await c.getAccountInfo(pk(X, PROGRAM_ID), "confirmed");
      return !!(info && info.executable);
    } catch (e) { return false; }
  }

  /* ---- send: assemble the duck-typed ixs into a Transaction, sign via the
   * connected wallet, send. Mirrors token.js: signAndSendTransaction when the
   * wallet offers it, else signTransaction + sendRawTransaction. ---- */
  async function signSend(ixs, extraSigners) {
    var X = await mx(), c = conn(X);
    var w = window.Wallet && window.Wallet.current && window.Wallet.current();
    if (!w) throw new Error("connect a wallet first");
    var owner = pk(X, w.publicKey.toBase58 ? w.publicKey.toBase58() : w.publicKey);
    var tx = new X.Transaction();
    ixs.forEach(function (i) { tx.add(new X.TransactionInstruction(i)); });
    tx.feePayer = owner;
    tx.recentBlockhash = (await c.getLatestBlockhash("confirmed")).blockhash;
    if (extraSigners && extraSigners.length) tx.partialSign.apply(tx, extraSigners);
    if (w.canSignAndSend && w.signAndSendTransaction) {
      var r = await w.signAndSendTransaction(tx);
      var sig = r && (r.signature || r);
      await c.confirmTransaction(typeof sig === "string" ? sig : new TextDecoder().decode(sig), "confirmed").catch(function () {});
      return sig;
    }
    var signed = await w.signTransaction(tx);
    var raw = signed.serialize ? signed.serialize() : signed;
    var sig2 = await c.sendRawTransaction(raw, { skipPreflight: false, maxRetries: 5 });
    await c.confirmTransaction(sig2, "confirmed").catch(function () {});
    return sig2;
  }

  // idempotent ATA create (classic SPL or Token-2022). `payer` funds+signs;
  // `ataOwner` owns the account (the wallet for a claim dest, the pool PDA for a
  // vault — an off-curve owner is fine, the ATA program allows it).
  function ixCreateAtaIdem(X, payer, ata, ataOwner, mint, tokenProgram) {
    return {
      programId: pk(X, ATA_PROGRAM),
      keys: [
        key(X, payer, 1, 1), key(X, ata, 0, 1), key(X, ataOwner, 0, 0), key(X, mint, 0, 0),
        key(X, SYS_PROGRAM, 0, 0), key(X, tokenProgram || TOKEN_PROGRAM, 0, 0)
      ],
      data: new Uint8Array([1]) // createIdempotent
    };
  }

  /* Create the staking pool for a pair, at launch. Resolves the reward mint's
   * token program, creates the pool PDA's vault ATA, and runs init_pool — all
   * signed by the launcher's wallet. Returns { pool, vault }. Idempotent-ish:
   * a second call reverts on the existing pool, which the caller can ignore. */
  async function initPoolAction(pair) {
    var X = await mx(), c = conn(X);
    var w = window.Wallet.current(); var owner = pk(X, w.publicKey.toBase58 ? w.publicKey.toBase58() : w.publicKey);
    var pool = poolPda(X, pair.tokenMint, pair.collection);
    var rewardMint = pk(X, pair.rewardMint);
    var info = await c.getAccountInfo(rewardMint, "confirmed");
    var tp = (info && info.owner && info.owner.toBase58() === TOKEN22_PROGRAM) ? TOKEN22_PROGRAM : TOKEN_PROGRAM;
    var vault = X.PublicKey.findProgramAddressSync(
      [pool.toBuffer(), pk(X, tp).toBuffer(), rewardMint.toBuffer()], pk(X, ATA_PROGRAM))[0];
    await signSend([
      ixCreateAtaIdem(X, owner, vault, pool, rewardMint, tp),
      ixInitPool(X, { pool: pool, tokenMint: pk(X, pair.tokenMint), collection: pk(X, pair.collection),
        rewardMint: rewardMint, vault: vault, payer: owner, tokenProgram: tp })
    ]);
    return { pool: pool.toBase58(), vault: vault.toBase58() };
  }

  /* Burn `amount` (base units of the paired token) to add weight to one NFT. */
  async function stakeAction(pair, asset, amount) {
    var X = await mx();
    var w = window.Wallet.current(); var owner = pk(X, w.publicKey.toBase58 ? w.publicKey.toBase58() : w.publicKey);
    var pool = poolPda(X, pair.tokenMint, pair.collection);
    var pos = positionPda(X, pool, asset);
    var stakerTokens = ownerAta(X, pk(X, pair.tokenMint), owner);
    return signSend([ixStake(X, {
      pool: pool, position: pos, asset: pk(X, asset), tokenMint: pk(X, pair.tokenMint),
      stakerTokens: stakerTokens, owner: owner, amount: amount
    })]);
  }

  /* Sync the vault, then claim everything owed on one NFT to the wallet. */
  async function claimAction(pair, asset) {
    var X = await mx(), c = conn(X);
    var w = window.Wallet.current(); var owner = pk(X, w.publicKey.toBase58 ? w.publicKey.toBase58() : w.publicKey);
    var pool = poolPda(X, pair.tokenMint, pair.collection);
    var poolAcc = decodePool(await accountBytes(c, pool), X);
    var rewardMint = pk(X, poolAcc.rewardMint);
    // reward mint's token program (classic or Token-2022 for xStocks)
    var info = await c.getAccountInfo(rewardMint, "confirmed");
    var tp = (info && info.owner && info.owner.toBase58() === TOKEN22_PROGRAM) ? TOKEN22_PROGRAM : TOKEN_PROGRAM;
    var vault = X.PublicKey.findProgramAddressSync(
      [pool.toBuffer(), pk(X, tp).toBuffer(), rewardMint.toBuffer()], pk(X, ATA_PROGRAM))[0];
    var dest = X.PublicKey.findProgramAddressSync(
      [owner.toBuffer(), pk(X, tp).toBuffer(), rewardMint.toBuffer()], pk(X, ATA_PROGRAM))[0];
    var pos = positionPda(X, pool, asset);
    var ixs = [
      ixCreateAtaIdem(X, owner, dest, owner, rewardMint, tp),
      ixSync(X, { pool: pool, vault: vault }),
      { programId: pk(X, PROGRAM_ID), keys: [
        key(X, pool, 0, 1), key(X, pos, 0, 1), key(X, pk(X, asset), 0, 0),
        key(X, vault, 0, 1), key(X, rewardMint, 0, 0), key(X, dest, 0, 1),
        key(X, owner, 1, 0), key(X, tp, 0, 0)
      ], data: data(IX.claim) }
    ];
    return signSend(ixs);
  }

  window.WavesStake = {
    PROGRAM_ID: PROGRAM_ID,
    // high-level actions (build + sign via wallet + send) — proven on devnet
    stake: stakeAction,
    claim: claimAction,
    initPool: initPoolAction,
    // reads
    live: live,
    summary: summary,
    myAssets: myAssets,
    // pda helpers (async so callers do not need the bundle)
    pdas: async function (pair, asset) {
      var X = await mx();
      var pool = poolPda(X, pair.tokenMint, pair.collection);
      return {
        pool: pool.toBase58(),
        vault: vaultAta(X, pair.rewardMint, pool).toBase58(),
        position: asset ? positionPda(X, pool, asset).toBase58() : null
      };
    },
    // instruction builders — assemble into a Transaction and sign via the wallet
    // adapter the same way token.js does. UNTESTED: do not wire to buttons until
    // the program is live and the flow is rehearsed.
    buildInitPool: async function (a) { return ixInitPool(await mx(), a); },
    buildStake: async function (a) { return ixStake(await mx(), a); },
    buildSync:  async function (a) { return ixSync(await mx(), a); },
    buildClaim: async function (a) { return ixClaim(await mx(), a); },
    ownerAta:   async function (mint, owner) { return ownerAta(await mx(), mint, owner).toBase58(); },
    // the reward mint's owner program, needed to build the vault ATA and pass the
    // right token_program — classic SPL for SOL/USDC, Token-2022 for xStocks
    tokenProgramOf: async function (mint) {
      var X = await mx(), c = conn(X);
      var info = await c.getAccountInfo(pk(X, mint), "confirmed");
      var owner = info && info.owner && info.owner.toBase58 ? info.owner.toBase58() : String(info && info.owner);
      return owner === TOKEN22_PROGRAM ? TOKEN22_PROGRAM : TOKEN_PROGRAM;
    },
    // the vault a pair's fees flow into: the pool PDA's ATA for the reward mint,
    // derived with that mint's token program. The caller must CREATE it (an
    // idempotent ATA create) before init_pool — the program does not.
    vaultFor: async function (pair, tokenProgram) {
      var X = await mx();
      var pool = poolPda(X, pair.tokenMint, pair.collection);
      var tp = pk(X, tokenProgram || TOKEN_PROGRAM);
      var vault = X.PublicKey.findProgramAddressSync(
        [pool.toBuffer(), tp.toBuffer(), pk(X, pair.rewardMint).toBuffer()], pk(X, ATA_PROGRAM))[0];
      return { pool: pool.toBase58(), vault: vault.toBase58() };
    }
  };
})();
