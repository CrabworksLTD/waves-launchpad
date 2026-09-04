// GET /api/rh-keeper — pay Robinhood holders their share, on a schedule.
//
// For every launch that pledged: work out what that token earned, claim it,
// then split it across holders in proportion to what they hold.
//
// ── The ordering rule, inherited from the Solana keeper ──────────────────────
// Claiming moves money OUT of the curve and into a hot wallet. Once claimed the
// curve reports nothing owed, so a later failure does not retry — it strands.
// Everything that can fail is therefore done BEFORE the claim:
//
//   1. read the holder table   (built by /api/rh-indexer)
//   2. attribute the pot       (which token earned what — see below)
//   3. check gas               (the keeper's float, never the pot)
//   4. claim                   ← the first irreversible step
//   5. persist the plan to KV
//   6. execute, marking progress as each transfer lands
//
// A crash after step 4 leaves a plan, and the next run finishes it instead of
// claiming again. That is what makes this safe to run unattended.
//
// ── ⚠️ Why attribution is not optional ───────────────────────────────────────
// The curve keeps ONE balance per address:
//
//     mapping(address => uint256) public owed;
//
// so every token that pledges to this keeper pays into the same pot, and
// claiming returns a single number with no record of where it came from. On
// Solana each pool holds its own fees and the question never arises.
//
// Paying that pot out by holder share alone would take one token's fees and
// hand them to another token's holders. So each token's contribution is
// recomputed from its own trades: every Bought and Sold carries the fee it
// paid, and the split is fixed by the rung, so the keeper's share of each trade
// is arithmetic. Sum it, and the pot divides honestly.
//
// ── The minimum pot ──────────────────────────────────────────────────────────
// Gas comes from the keeper's own float. Paying 100 holders costs about $2, so
// a token earning pennies would burn our ETH forwarding them. A run therefore
// waits until the pot is worth several times the gas to distribute it.

import { kv } from "./_guard.js";

export const config = { runtime: "nodejs" };

const RPC = process.env.RH_RPC || "https://rpc.mainnet.chain.robinhood.com";
const CURVE = process.env.RH_CURVE || "0x77ddd6ceb454e4b71a1952fcaafb8cf9975f55c0";

// Bought(address,address,uint256,uint256,uint256) / Sold(...)
const BOUGHT = "0x7ce543d1780f3bdc3dac42da06c95da802653cd1b212b8d74ec3e3c33ad7095c";
const SOLD   = "0x9be8a5ca22b7e6e81f04b5879f0248227bb770114291bd47dfaee4c3a82ad60e";

const CHUNK = 50000n;
const MAX_CHUNKS = 12;
const GAS_PER_TRANSFER = 21000n;
const GAS_CLAIM = 80000n;
/* The pot must be worth this many times the gas to move it. Below that the run
 * waits: forwarding a dollar at a cost of a dollar helps nobody. */
const WORTH_IT = 5n;

let rpcId = 0;
async function rpc(method, params) {
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
}

const addrOf = (t) => "0x" + String(t).slice(-40).toLowerCase();
const word = (d, i) => BigInt("0x" + String(d).replace(/^0x/, "").slice(i * 64, i * 64 + 64));

/* The platform's cut, in basis points OF VOLUME, by rung. Mirrors
 * platformVolumeBps() in the curve — the contract is the authority, this is
 * only used to work out what is left for the creator side. */
const PLATFORM_BPS = { 100: 40, 200: 50, 300: 60, 400: 70, 500: 80, 1000: 90 };

/**
 * The keeper's key, in the form viem wants.
 *
 * MetaMask exports a private key as bare hex with no 0x, and viem rejects that
 * with "invalid private key, expected hex or 32 bytes, got string". Refusing a
 * correct key over a missing prefix is a pointless way to break a payout run,
 * so both forms are accepted and anything else is rejected clearly.
 */
function keeperKey() {
  const raw = String(process.env.RH_KEEPER_SECRET || "").trim();
  if (!raw) return null;
  const hex = raw.startsWith("0x") ? raw : "0x" + raw;
  if (!/^0x[0-9a-fA-F]{64}$/.test(hex)) {
    throw new Error("RH_KEEPER_SECRET is not a 32-byte hex private key");
  }
  return hex;
}

/**
 * What this token has earned for its holders since the last payout.
 *
 * Walked from the curve's own trade events. `fee` on each is what the trader
 * paid; the platform's share of that trade comes off first, and the pledged
 * fraction of what remains is the holders'.
 */
async function accrued(db, token, feeBps, rewardsBps, fromBlock, latest) {
  const key = "rhk:" + token + ":cursor";
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
      /* Bought(token, buyer, ethIn, tokensOut, fee)
       * Sold  (token, seller, tokensIn, ethOut, fee)
       * — the fee is the third data word either way. The volume it was charged
       * on is the ETH side, which is word 0 on a buy and word 1 on a sell. */
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

async function keeperTx(to, data, value, gas) {
  const { privateKeyToAccount } = await import("viem/accounts");
  const account = privateKeyToAccount(keeperKey());
  const [nonce, block] = await Promise.all([
    rpc("eth_getTransactionCount", [account.address, "pending"]),
    rpc("eth_getBlockByNumber", ["latest", false])
  ]);
  const base = BigInt(block.baseFeePerGas || 0);
  const tip = base / 10n + 1n;
  const signed = await account.signTransaction({
    to, data: data || "0x", value: value || 0n, gas,
    maxFeePerGas: base * 2n + tip, maxPriorityFeePerGas: tip,
    nonce: parseInt(nonce, 16), chainId: 4663, type: "eip1559"
  });
  return rpc("eth_sendRawTransaction", [signed]);
}

async function mined(hash) {
  for (let i = 0; i < 60; i++) {
    const r = await rpc("eth_getTransactionReceipt", [hash]).catch(() => null);
    if (r) return r;
    await new Promise((s) => setTimeout(s, 2000));
  }
  throw new Error("not mined");
}

export default async function handler(req, res) {
  /* ?whoami — does the deployed key match the keeper pledges name on chain?
   *
   * Open, because it discloses nothing: the address is already in
   * evm-chains.js and written into every pledge on a public chain. What it
   * confirms is that the SERVER holds a key for it, which is the one thing
   * worth knowing before a pot exists — a mismatch is permanent per token, and
   * finding out afterwards means those holders can never be paid.
   *
   * It signs nothing, reads no balances and moves nothing. */
  if (req.query && req.query.whoami) {
    if (!process.env.RH_KEEPER_SECRET) {
      return res.status(200).json({ ok: false, error: "RH_KEEPER_SECRET is not set" });
    }
    try {
      const { privateKeyToAccount } = await import("viem/accounts");
      const derived = privateKeyToAccount(keeperKey()).address;
      const expected = "0xAcA1d1bE05f47090a6d8D918AB26d4543fD3Af81";
      return res.status(200).json({
        ok: derived.toLowerCase() === expected.toLowerCase(),
        derived, expected,
        note: derived.toLowerCase() === expected.toLowerCase()
          ? "the deployed key signs for the keeper on chain"
          : "MISMATCH — pledges name an address this key cannot sign for"
      });
    } catch (e) {
      return res.status(200).json({ ok: false, error: String(e.message || e).slice(0, 160) });
    }
  }

  const secret = process.env.CRON_SECRET;
  if (secret && req.headers.authorization !== "Bearer " + secret) {
    return res.status(401).json({ error: "no" });
  }
  if (!process.env.RH_KEEPER_SECRET) {
    return res.status(200).json({ ok: true, skipped: "RH_KEEPER_SECRET is not set" });
  }

  const log = [];
  try {
    const db = await kv();
    const { privateKeyToAccount } = await import("viem/accounts");
    const keeper = privateKeyToAccount(keeperKey()).address;

    /* ⚠️ Reported every run so it can be eyeballed against evm-chains.js. If
     * this key does not match the rewardsKeeper written into pledges, those
     * tokens named a keeper nobody can sign for — permanently, per token. */
    const expected = "0xAcA1d1bE05f47090a6d8D918AB26d4543fD3Af81";
    if (keeper.toLowerCase() !== expected.toLowerCase()) {
      return res.status(500).json({
        ok: false, keeper,
        error: "RH_KEEPER_SECRET does not match the rewardsKeeper on chain (" + expected + ")"
      });
    }

    // ── 1. resume anything a previous run left half-done ──────────────────────
    const planKey = "rhk:plan";
    const plan = await db.get(planKey).catch(() => null);
    if (plan) {
      const p = typeof plan === "string" ? JSON.parse(plan) : plan;
      const done = await payOut(db, planKey, p);
      return res.status(200).json({ ok: true, keeper, resumed: true, ...done });
    }

    const raw = await db.lrange("tokens", 0, 199);
    const toks = (raw || [])
      .map((r) => (typeof r === "string" ? JSON.parse(r) : r))
      .filter((t) => t && t.chain === "robinhood" && (t.feeSharePct || 0) > 0);
    if (!toks.length) return res.status(200).json({ ok: true, keeper, note: "nothing pledged" });

    const latest = BigInt(await rpc("eth_blockNumber", []));
    const owedHex = await rpc("eth_call", [{
      to: CURVE, data: "0xdf18e047" + "0".repeat(24) + keeper.slice(2).toLowerCase()
    }, "latest"]);
    const pot = BigInt(owedHex || "0x0");
    if (pot === 0n) return res.status(200).json({ ok: true, keeper, note: "nothing owed" });

    // ── 2. attribute the pot across the tokens that earned it ────────────────
    const shares = [];
    let attributed = 0n;
    for (const t of toks) {
      const mint = String(t.mint).toLowerCase();
      const curve = await rpc("eth_call", [{
        to: CURVE, data: "0x2cc3dc6e" + "0".repeat(24) + mint.slice(2)
      }, "latest"]);
      const feeBps = Number(word(curve, 1));
      const rewardsBps = Number(word(curve, 2));
      if (!rewardsBps) continue;
      const a = await accrued(db, mint, feeBps, rewardsBps, t.block, latest);
      if (a.wei > 0n) { shares.push({ mint, wei: a.wei, upTo: a.upTo }); attributed += a.wei; }
      else log.push({ mint, earned: "0" });
    }
    if (!attributed) return res.status(200).json({ ok: true, keeper, note: "no attributable earnings", log });

    // ── 3. is it worth the gas? ──────────────────────────────────────────────
    const block = await rpc("eth_getBlockByNumber", ["latest", false]);
    const gasPrice = BigInt(block.baseFeePerGas || 0) * 2n;
    let holderCount = 0;
    const tables = {};
    for (const s of shares) {
      const h = (await db.hgetall("rhix:" + s.mint + ":h").catch(() => null)) || {};
      tables[s.mint] = h;
      holderCount += Object.keys(h).length;
    }
    if (!holderCount) return res.status(200).json({ ok: true, keeper, note: "no holders indexed yet" });

    const gasCost = (GAS_CLAIM + GAS_PER_TRANSFER * BigInt(holderCount)) * gasPrice;
    if (pot < gasCost * WORTH_IT) {
      return res.status(200).json({
        ok: true, keeper, note: "pot too small to be worth the gas",
        potWei: pot.toString(), gasWei: gasCost.toString(), holders: holderCount
      });
    }

    const bal = BigInt(await rpc("eth_getBalance", [keeper, "latest"]));
    if (bal < gasCost * 2n) {
      return res.status(200).json({
        ok: true, keeper, note: "keeper is low on gas — top it up",
        balanceWei: bal.toString(), needWei: (gasCost * 2n).toString()
      });
    }

    // ── 4. claim, then 5. write the plan BEFORE spending any of it ───────────
    const claimHash = await keeperTx(CURVE, "0x4e71d92d", 0n, GAS_CLAIM);
    await mined(claimHash);

    const payments = [];
    for (const s of shares) {
      const table = tables[s.mint];
      const supply = Object.values(table).reduce((a, b) => a + BigInt(b), 0n);
      if (supply === 0n) continue;
      // this token's slice of the pot, then each holder's slice of that
      const slice = (pot * s.wei) / attributed;
      for (const [addr, held] of Object.entries(table)) {
        const amount = (slice * BigInt(held)) / supply;
        if (amount > 0n) payments.push({ to: addr, wei: amount.toString(), mint: s.mint });
      }
    }
    const record = {
      at: Date.now(), claimHash, potWei: pot.toString(),
      cursors: shares.map((s) => ({ mint: s.mint, upTo: s.upTo.toString() })),
      payments, sent: 0
    };
    await db.set(planKey, JSON.stringify(record));

    const done = await payOut(db, planKey, record);
    return res.status(200).json({ ok: true, keeper, claimHash, ...done, log });
  } catch (e) {
    return res.status(200).json({ ok: false, error: String(e.message || e).slice(0, 300), log });
  }
}

/**
 * Send what the plan says, marking progress as each one lands.
 *
 * Resumable on purpose: the plan is the only record that money was claimed and
 * not yet delivered, so it is updated after every transfer rather than at the
 * end. A run that dies halfway is finished by the next one.
 */
async function payOut(db, planKey, plan) {
  let sent = plan.sent || 0;
  const failures = [];
  for (let i = sent; i < plan.payments.length; i++) {
    const p = plan.payments[i];
    try {
      const h = await keeperTx(p.to, "0x", BigInt(p.wei), GAS_PER_TRANSFER);
      await mined(h);
      sent = i + 1;
      await db.set(planKey, JSON.stringify({ ...plan, sent }));
    } catch (e) {
      failures.push({ to: p.to, error: String(e.message || e).slice(0, 100) });
      break;               // stop on the first failure; the next run resumes here
    }
  }

  if (sent >= plan.payments.length) {
    /* Only now: the cursors move once the money is actually out. Advancing them
     * earlier would mean a failed run forgot earnings it never paid. */
    for (const c of plan.cursors || []) {
      await db.set("rhk:" + c.mint + ":cursor", c.upTo);
    }
    await db.del(planKey);
    await db.lpush("rhkeeperlog", JSON.stringify({
      at: plan.at, potWei: plan.potWei, paid: sent, claimHash: plan.claimHash
    }));
    await db.ltrim("rhkeeperlog", 0, 499);
  }
  return { paid: sent, of: plan.payments.length, failures, complete: sent >= plan.payments.length };
}
