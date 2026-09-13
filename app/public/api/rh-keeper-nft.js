// GET /api/rh-keeper-nft — fund NFT-pairing reward vaults, on a schedule.
//
// The sibling of /api/rh-keeper. That one pays a token's own holders; this one
// pays the NFT holders of the COLLECTION a token is paired with. Both read the
// same V4 hook, but they are pledged to different keeper addresses, so the hook
// keeps their pots separate on its own owed[] mapping:
//
//   rh-keeper      ← tokens that pledged to `rewardsKeeper`  → pays token holders
//   rh-keeper-nft  ← tokens that pledged to `nftKeeper`      → funds the vault
//
// What this does per run, for one quote asset:
//   1. resume anything a previous run left half-done (crash-safe plan)
//   2. list paired tokens (recorded keeper:"nft", with a vault address)
//   3. confirm on chain each really pledged to THIS keeper, and read its quote
//   4. claim this keeper's pot, hold back a gas reserve (self-funding, ETH pots)
//   5. attribute the pot across the tokens that earned it (same fee-walk)
//   6. forward each token's slice into its collection's vault
//
// The vault (contracts/MoonpadVault.sol, escrow=0 direct-send mode) takes the
// forward through its receive(), splits it across ACTIVATED NFTs by weight, and
// NFT holders claim their share themselves — so the keeper never pays a holder
// and its gas does not scale with holder count. One forward per token per run.
//
// v1 handles ETH-quoted pairs only: the pot is ETH, forwarded by a value
// transfer the vault's receive() deposits. A stock/USDG-quoted pair's fees
// arrive as an ERC-20 the vault's receive() cannot take, so those are skipped
// with a note until v2 wires an ERC-20 deposit path.
//
// Ordering (inherited from rh-keeper): claiming is the first irreversible step,
// so everything that can fail is done before it, and the plan is written before
// a wei is spent — a crash resumes by asking whether each forward's hash landed.

import { kv } from "./_guard.js";

export const config = { runtime: "nodejs" };

const RPC = process.env.RH_RPC || "https://rpc.mainnet.chain.robinhood.com";
// Same V4-hook singleton the token keeper reads (contracts/WavesCurveHook.sol).
const CURVE = process.env.RH_HOOK || "0xA02AAaCb311F49e7f55c4dF5b40b3cFCe0D76888";
// The address paired tokens pledge to. Must equal evm-chains.js `nftKeeper` and
// the address RH_NFT_KEEPER_SECRET signs for (the ?whoami check proves it).
const NFT_KEEPER = (process.env.RH_NFT_KEEPER || "0x527c31c6755213492bA40D71752ae34c7b42F9F9").toLowerCase();

// Bought(address,address,uint256,uint256,uint256) / Sold(...)
const BOUGHT = "0x7ce543d1780f3bdc3dac42da06c95da802653cd1b212b8d74ec3e3c33ad7095c";
const SOLD   = "0x9be8a5ca22b7e6e81f04b5879f0248227bb770114291bd47dfaee4c3a82ad60e";

// owed(who,quote) / claim(quote) / poolOf(token) / curves(poolId) on the hook
const SEL_OWED = "0x28079e4a";
const SEL_CLAIM = "0x1e83409a";
const SEL_POOL_OF = "0x988b1fa7";
const SEL_CURVES = "0x66903e80";
const ETH_ADDR = "0x0000000000000000000000000000000000000000";
const isEthQuote = (q) => !q || /^0x0+$/i.test(String(q));

const CHUNK = 50000n;
const MAX_CHUNKS = 12;
const GAS_CLAIM = 80000n;
/* The forward is a value transfer into the vault, but the vault's receive()
 * runs its deposit + per-weight accounting, so it is dearer than a bare 21000
 * send. Generous — an unused limit costs nothing, the sender pays gas USED. */
const GAS_FORWARD = 200000n;
/* The pot must be worth this many times the run's gas to move it, so forwarding
 * a dollar never costs a dollar. */
const WORTH_IT = 5n;

/* The platform's cut of volume by rung — mirrors platformVolumeBps() in the
 * hook. Only used to work out what is left for the creator/holder side. */
const PLATFORM_BPS = { 100: 40, 200: 50, 300: 60, 400: 70, 500: 80, 1000: 90 };

let rpcId = 0;
async function rpc(method, params) {
  // Retried with backoff — Robinhood's public node throttles bursts (429).
  for (let attempt = 0; attempt < 6; attempt++) {
    try {
      const r = await fetch(RPC, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method, params }),
        signal: AbortSignal.timeout(25000)
      });
      if (!r.ok) throw new Error("rpc " + r.status);
      const j = await r.json();
      if (j.error) throw new Error(j.error.message || "rpc error");
      return j.result;
    } catch (e) {
      if (attempt === 5) throw e;
      await new Promise((s) => setTimeout(s, 700 * Math.pow(2, attempt)));
    }
  }
}

const pad = (v) => BigInt(v).toString(16).padStart(64, "0");
const encAddr = (a) => String(a).replace(/^0x/, "").toLowerCase().padStart(64, "0");
const word = (d, i) => BigInt("0x" + String(d).replace(/^0x/, "").slice(i * 64, i * 64 + 64) || "0");

function keeperKey() {
  const raw = String(process.env.RH_NFT_KEEPER_SECRET || "").trim();
  if (!raw) return null;
  const hex = raw.startsWith("0x") ? raw : "0x" + raw;
  if (!/^0x[0-9a-fA-F]{64}$/.test(hex)) {
    throw new Error("RH_NFT_KEEPER_SECRET is not a 32-byte hex private key");
  }
  return hex;
}

/* What a token has earned for its paired holders since the last payout. The
 * pledged fraction of each trade's fee, net of the platform's cut. Identical
 * walk to the token keeper — the cursor namespace differs (rhkn:) so the two
 * keepers never consume each other's progress. */
async function accrued(db, token, feeBps, rewardsBps, fromBlock, latest) {
  const key = "rhkn:" + token + ":cursor";
  let cursor = BigInt((await db.get(key).catch(() => null)) || fromBlock || 0);
  if (cursor <= 0n || cursor >= latest) return { wei: 0n, upTo: cursor };

  const platBps = BigInt(PLATFORM_BPS[feeBps] ?? 40);
  const topic = "0x" + "0".repeat(24) + String(token).replace(/^0x/, "").toLowerCase();
  let total = 0n;

  for (let i = 0; i < MAX_CHUNKS && cursor < latest; i++) {
    const to = cursor + CHUNK > latest ? latest : cursor + CHUNK;
    let logs;
    try {
      logs = await rpc("eth_getLogs", [{
        address: CURVE,
        fromBlock: "0x" + cursor.toString(16),
        toBlock: "0x" + to.toString(16),
        topics: [[BOUGHT, SOLD], topic]
      }]);
    } catch (e) {
      break;                      // refused window: keep what we have, resume later
    }
    for (const lg of logs) {
      // fee is the third data word; the ETH volume it was charged on is word 0
      // on a buy and word 1 on a sell.
      const isBuy = String(lg.topics[0]).toLowerCase() === BOUGHT;
      const volume = isBuy ? word(lg.data, 0) : word(lg.data, 1);
      const fee = word(lg.data, 2);
      let toPlatform = (volume * platBps) / 10000n;
      if (toPlatform > fee) toPlatform = fee;
      const creatorSide = fee - toPlatform;
      total += (creatorSide * BigInt(rewardsBps)) / 10000n;
    }
    cursor = to;
  }
  return { wei: total, upTo: cursor };
}

/* Wait for a transaction and REFUSE one that reverted — a reverted forward that
 * counted as success would advance the cursor while the money never reached the
 * vault. */
async function mined(hash) {
  for (let i = 0; i < 60; i++) {
    const r = await rpc("eth_getTransactionReceipt", [hash]).catch(() => null);
    if (r) {
      if (r.status === "0x0") {
        throw new Error("transaction reverted (" + hash + ")");
      }
      return r;
    }
    await new Promise((s) => setTimeout(s, 2000));
  }
  throw new Error("not mined");
}

async function signKeeperTx(to, data, value, gas) {
  const { privateKeyToAccount } = await import("viem/accounts");
  const account = privateKeyToAccount(keeperKey());
  const [nonce, block] = await Promise.all([
    rpc("eth_getTransactionCount", [account.address, "pending"]),
    rpc("eth_getBlockByNumber", ["latest", false])
  ]);
  const base = BigInt(block.baseFeePerGas || 0);
  const tip = await rpc("eth_maxPriorityFeePerGas", [])
    .then((t) => { const n = BigInt(t || 0); return n < 10000000n ? 10000000n : n; })
    .catch(() => base / 10n + 1n);
  const raw = await account.signTransaction({
    to, data: data || "0x", value: value || 0n, gas,
    maxFeePerGas: base * 2n + tip, maxPriorityFeePerGas: tip,
    nonce: parseInt(nonce, 16), chainId: 4663, type: "eip1559"
  });
  const { keccak256 } = await import("viem");
  return { raw, hash: keccak256(raw) };
}
async function keeperTx(to, data, value, gas) {
  const { raw } = await signKeeperTx(to, data, value, gas);
  return rpc("eth_sendRawTransaction", [raw]);
}

/* Forward one token's slice into its vault, resumably. The intended hash is
 * written to the plan BEFORE broadcast, so a crash mid-forward resumes by
 * asking whether that exact hash landed rather than sending a second time. */
async function forwardToVault(db, planKey, record, slice) {
  if (slice.done) return;
  if (!slice.hash) {
    const signed = await signKeeperTx(slice.vault, "0x", BigInt(slice.wei), GAS_FORWARD);
    slice.hash = signed.hash;
    await db.set(planKey, JSON.stringify(record));   // remember before spending
    try {
      await rpc("eth_sendRawTransaction", [signed.raw]);
    } catch (e) {
      // already-known / nonce-used means it is already out there; fall through
      // to mined() which is the real arbiter. Anything else rethrows.
      if (!/already known|nonce|replacement/i.test(String(e && e.message))) throw e;
    }
  }
  await mined(slice.hash);
  slice.done = true;
  await db.set(planKey, JSON.stringify(record));
  // the token has now been paid up to this cursor; never re-count those blocks
  await db.set("rhkn:" + slice.mint + ":cursor", slice.upTo);
}

async function finishPlan(db, planKey, record, keeper) {
  for (const slice of record.slices) await forwardToVault(db, planKey, record, slice);
  await db.del(planKey);
  return {
    forwarded: record.slices.map((s) => ({ token: s.mint, vault: s.vault, wei: s.wei, hash: s.hash })),
    gasReserveWei: record.gasReserveWei, distributableWei: record.distributableWei
  };
}

export default async function handler(req, res) {
  /* ?whoami — does the deployed key sign for the address paired tokens pledge
   * to? Discloses nothing (the address is public and written into every pledge);
   * a mismatch is permanent per token, so it is worth knowing before a pot
   * exists. Also reports the wallet's gas balance so the float is visible. */
  if (req.query && req.query.whoami !== undefined) {
    if (!process.env.RH_NFT_KEEPER_SECRET) {
      return res.status(200).json({ ok: false, error: "RH_NFT_KEEPER_SECRET is not set" });
    }
    try {
      const { privateKeyToAccount } = await import("viem/accounts");
      const derived = privateKeyToAccount(keeperKey()).address;
      const match = derived.toLowerCase() === NFT_KEEPER;
      let balanceWei = null;
      try { balanceWei = BigInt(await rpc("eth_getBalance", [derived, "latest"])).toString(); } catch (e) {}
      return res.status(200).json({
        ok: match, derived, expected: NFT_KEEPER, balanceWei,
        note: match
          ? "key signs for the NFT keeper" + (balanceWei ? "; float " + (Number(balanceWei) / 1e18).toFixed(4) + " ETH" : "")
          : "MISMATCH — paired pledges name an address this key cannot sign for"
      });
    } catch (e) {
      return res.status(200).json({ ok: false, error: String(e.message || e).slice(0, 160) });
    }
  }

  // Cron-gated, like the token keeper.
  const secret = process.env.CRON_SECRET;
  if (!secret) return res.status(500).json({ error: "CRON_SECRET is not set" });
  const authed = (req.headers.authorization || "") === "Bearer " + secret;
  if (!authed) return res.status(401).json({ error: "no" });
  if (!process.env.RH_NFT_KEEPER_SECRET) {
    return res.status(200).json({ ok: true, skipped: "RH_NFT_KEEPER_SECRET is not set" });
  }

  const db = await kv();
  if (!db) return res.status(500).json({ error: "no KV configured" });

  const { privateKeyToAccount } = await import("viem/accounts");
  const keeper = privateKeyToAccount(keeperKey()).address;
  if (keeper.toLowerCase() !== NFT_KEEPER) {
    return res.status(200).json({
      ok: false, error: "RH_NFT_KEEPER_SECRET does not match nftKeeper (" + NFT_KEEPER + ")", derived: keeper
    });
  }

  const log = [];
  try {
    // ── 1. resume a half-done plan ────────────────────────────────────────────
    const planKey = "rhkn:plan";
    const planRaw = await db.get(planKey).catch(() => null);
    if (planRaw) {
      const p = typeof planRaw === "string" ? JSON.parse(planRaw) : planRaw;
      const done = await finishPlan(db, planKey, p, keeper);
      return res.status(200).json({ ok: true, keeper, resumed: true, ...done });
    }

    // ── 2. the paired tokens this keeper serves ───────────────────────────────
    const rawToks = await db.lrange("tokens", 0, 199);
    const toks = (rawToks || [])
      .map((r) => (typeof r === "string" ? JSON.parse(r) : r))
      .filter((t) => t && t.chain === "robinhood" && t.keeper === "nft" &&
        /^0x[0-9a-fA-F]{40}$/.test(String(t.vault || "")) &&
        /^0x[0-9a-fA-F]{40}$/.test(String(t.pairedCollection || "")));
    if (!toks.length) return res.status(200).json({ ok: true, keeper, note: "no paired tokens" });

    const latest = BigInt(await rpc("eth_blockNumber", []));

    // ── 3. confirm each on chain: pledged to US, and its quote asset ──────────
    // curves struct: token(0) creator(1) feeBps(2) rewardsBps(3) keeper(4) ...
    //                raised(5) tokensLeft(6) full(7) graduated(8) quote(9)
    const descs = [];
    for (const t of toks) {
      const mint = String(t.mint).toLowerCase();
      const poolId = await rpc("eth_call", [{
        to: CURVE, data: SEL_POOL_OF + "0".repeat(24) + mint.slice(2)
      }, "latest"]).catch(() => null);
      if (!poolId || /^0x0*$/.test(poolId)) continue;
      const curve = await rpc("eth_call", [{
        to: CURVE, data: SEL_CURVES + String(poolId).replace(/^0x/, "")
      }, "latest"]).catch(() => null);
      if (!curve) continue;
      const rewardsBps = Number(word(curve, 3));
      if (!rewardsBps) continue;
      const pledgedKeeper = ("0x" + String(curve).replace(/^0x/, "").slice(4 * 64 + 24, 5 * 64)).toLowerCase();
      if (pledgedKeeper !== NFT_KEEPER) continue;   // pledged elsewhere — not ours
      const q9 = String(curve).replace(/^0x/, "").slice(9 * 64, 10 * 64);
      const quote = q9.length === 64 ? ("0x" + q9.slice(24)).toLowerCase() : ETH_ADDR;
      descs.push({ t, mint, feeBps: Number(word(curve, 2)), rewardsBps, quote, vault: String(t.vault) });
    }
    if (!descs.length) return res.status(200).json({ ok: true, keeper, note: "nothing pledged to this keeper on chain", log });

    // v1: ETH-quoted pairs only. A non-ETH pot is an ERC-20 the vault's
    // receive() cannot take — skip with a note rather than forward money the
    // vault cannot deposit.
    const eth = descs.filter((d) => isEthQuote(d.quote));
    for (const d of descs) if (!isEthQuote(d.quote)) log.push({ token: d.mint, note: "non-ETH quote not supported yet" });
    if (!eth.length) return res.status(200).json({ ok: true, keeper, note: "no ETH-quoted paired tokens ready", log });

    // ── 4. this keeper's ETH pot ──────────────────────────────────────────────
    const owedHex = await rpc("eth_call", [{
      to: CURVE, data: SEL_OWED + "0".repeat(24) + keeper.slice(2).toLowerCase() + "0".repeat(24) + ETH_ADDR.slice(2)
    }, "latest"]);
    const pot = BigInt(owedHex || "0x0");
    if (pot === 0n) return res.status(200).json({ ok: true, keeper, note: "nothing owed yet", log });

    // ── 5. attribute the pot across the tokens that earned it ─────────────────
    const shares = [];
    let attributed = 0n;
    for (const d of eth) {
      const a = await accrued(db, d.mint, d.feeBps, d.rewardsBps, d.t.block, latest);
      if (a.wei > 0n) {
        shares.push({ mint: d.mint, vault: d.vault, wei: a.wei, upTo: a.upTo.toString() });
        attributed += a.wei;
      } else {
        log.push({ token: d.mint, earned: "0" });
      }
    }
    if (!attributed) return res.status(200).json({ ok: true, keeper, note: "no attributable earnings yet", log });

    // ── 6. worth the gas? and self-funding reserve ────────────────────────────
    const block = await rpc("eth_getBlockByNumber", ["latest", false]);
    const gasPrice = BigInt(block.baseFeePerGas || 0) * 2n;
    const gasCost = (GAS_CLAIM + GAS_FORWARD * BigInt(shares.length)) * gasPrice;
    const force = !!(req.query && req.query.force);
    if (!force && pot < gasCost * WORTH_IT) {
      return res.status(200).json({
        ok: true, keeper, note: "pot too small", potWei: pot.toString(), gasWei: gasCost.toString(), log
      });
    }
    const bal = BigInt(await rpc("eth_getBalance", [keeper, "latest"]));
    if (bal < gasCost * 2n) {
      return res.status(200).json({
        ok: true, keeper, note: "keeper is low on gas — top it up",
        balanceWei: bal.toString(), needWei: (gasCost * 2n).toString()
      });
    }

    // ── 7. claim, hold back gas, then write the plan before spending ──────────
    const claimHash = await keeperTx(CURVE, SEL_CLAIM + encAddr(ETH_ADDR), 0n, GAS_CLAIM);
    await mined(claimHash);

    // Keep this run's gas OUT of the pot (1.3x guards a price bump) so the
    // keeper trends flat instead of bleeding down — the token keeper's rule.
    const gasReserve = (gasCost * 13n) / 10n;
    const distributablePot = pot > gasReserve ? pot - gasReserve : 0n;

    const record = {
      at: Date.now(), claimHash, quote: ETH_ADDR,
      potWei: pot.toString(), gasReserveWei: gasReserve.toString(),
      distributableWei: distributablePot.toString(),
      slices: shares.map((s) => ({
        mint: s.mint, vault: s.vault, upTo: s.upTo,
        wei: ((distributablePot * s.wei) / attributed).toString(),
        hash: null, done: false
      }))
    };
    await db.set(planKey, JSON.stringify(record));

    const done = await finishPlan(db, planKey, record, keeper);
    return res.status(200).json({ ok: true, keeper, claimHash, ...done, log });
  } catch (e) {
    return res.status(200).json({ ok: false, keeper, error: String(e && e.message ? e.message : e).slice(0, 300), log });
  }
}
