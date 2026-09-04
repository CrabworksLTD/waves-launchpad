/* node tools/test-rh-keeper-swap.mjs
 *
 * The keeper's swap leg: does the asset a creator chose actually reach their
 * holders, in the right proportions, exactly once?
 *
 * Every figure is worked out independently here rather than by rerunning the
 * keeper's own arithmetic — checking code against itself proves only that it is
 * consistent, which a wrong answer also is.
 *
 * Nothing is signed and nothing is sent: the RPC is a stub.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const CURVE = "0x77ddd6ceb454e4b71a1952fcaafb8cf9975f55c0";
const KEEPER = "0xAcA1d1bE05f47090a6d8D918AB26d4543fD3Af81";
const ROUTER = "0x1111100000000000000000000000000000011111";
const ETH = 10n ** 18n;

const A = "0xaaaa000000000000000000000000000000000001";   // pays USDG
const B = "0xbbbb000000000000000000000000000000000002";   // also USDG — settles alongside A
const C = "0xcccc000000000000000000000000000000000003";   // an asset with no pool
const USDG = "0x5fc5360d0400a0fd4f2af552add042d716f1d168";
const NOPOOL = "0xdead000000000000000000000000000000009999";

const H1 = "0x1111111111111111111111111111111111111111";
const H2 = "0x2222222222222222222222222222222222222222";
const H3 = "0x3333333333333333333333333333333333333333";
const H4 = "0x4444444444444444444444444444444444444444";

/* Each token trades 10 ETH at the 3% rung. Platform takes 0.6% of volume, so
 * the creator side is 0.3 - 0.06 = 0.24, all of it pledged. */
const EARNED = (10n * ETH * 300n / 10000n) - (10n * ETH * 60n / 10000n);   // 0.24
const POT = EARNED * 3n;                                                   // three tokens

// what the swap returns, in USDG's 6 decimals
const USDG_OUT = 1_000_000n;
// what the two-hop route returns, in NOPOOL's 18
const HOP_OUT = 5_000_000_000_000_000n;

/* Set by the second pass below: replays the run with every ERC20 transfer
 * reverting, which is what actually happened on the first mainnet payout. */
let REVERT_TRANSFERS = false;
const revertedHashes = new Set();

const store = new Map();
const db = {
  get: async (k) => store.get(k) ?? null,
  set: async (k, v) => void store.set(k, v),
  del: async (k) => void store.delete(k),
  hgetall: async (k) => store.get(k) || null,
  lpush: async () => {}, ltrim: async () => {},
  lrange: async () => [
    JSON.stringify({ mint: A, chain: "robinhood", feeSharePct: 100, block: 1000, rewardMint: USDG }),
    JSON.stringify({ mint: B, chain: "robinhood", feeSharePct: 100, block: 1000, rewardMint: USDG }),
    JSON.stringify({ mint: C, chain: "robinhood", feeSharePct: 100, block: 1000, rewardMint: NOPOOL })
  ]
};
store.set("rhix:" + A + ":h", { [H1]: (75n * ETH).toString(), [H2]: (25n * ETH).toString() });
store.set("rhix:" + B + ":h", { [H3]: (10n * ETH).toString() });
store.set("rhix:" + C + ":h", { [H4]: (10n * ETH).toString() });
for (const t of [A, B, C]) store.set("rhk:" + t + ":cursor", "1000");

const BOUGHT = "0x7ce543d1780f3bdc3dac42da06c95da802653cd1b212b8d74ec3e3c33ad7095c";
const hex32 = (v) => BigInt(v).toString(16).padStart(64, "0");
const sent = [];
let quoteCalls = 0;

async function stubFetch(url, opts) {
  // the asset list the keeper reads to find pools
  if (typeof url === "string" && url.includes("rh-assets.json")) {
    return { ok: true, json: async () => ({ tokens: [
      { address: USDG, symbol: "USDG", decimals: 6, ethPools: [
        { currency0: "0x" + "0".repeat(40), currency1: USDG, fee: 86, tickSpacing: 1,
          hooks: "0x" + "0".repeat(40) },
        { currency0: "0x" + "0".repeat(40), currency1: USDG, fee: 500, tickSpacing: 10,
          hooks: "0x" + "0".repeat(40) },
        // hooked: must be ignored entirely
        { currency0: "0x" + "0".repeat(40), currency1: USDG, fee: 100, tickSpacing: 1,
          hooks: "0x" + "9".repeat(40) }
      ] },
      /* No ETH pool at all — the MSFT case. Only reachable through USDG, which
       * is exactly what a creator picking it is promised. */
      { address: NOPOOL, symbol: "NOPOOL", decimals: 18, ethPools: [],
        usdgPools: [
          { currency0: USDG, currency1: NOPOOL, fee: 900, tickSpacing: 9,
            hooks: "0x" + "0".repeat(40) }
        ] }
    ] }) };
  }

  const { method, params } = JSON.parse(opts.body);
  const reply = (result) => ({ ok: true, json: async () => ({ jsonrpc: "2.0", id: 1, result }) });

  if (method === "eth_blockNumber") return reply("0x" + (2000).toString(16));
  if (method === "eth_getBlockByNumber") return reply({ baseFeePerGas: "0x1" });
  if (method === "eth_getBalance") return reply("0x" + (100n * ETH).toString(16));
  if (method === "eth_getTransactionCount") return reply("0x0");
  if (method === "eth_getTransactionReceipt") {
    /* ⚠️ The ERC20 transfers revert here, deliberately.
     *
     * On the first real run they did — Robinhood's tokenised equities cost more
     * gas than a plain ERC20 and the budget was too low — and the keeper
     * reported "paid 1 of 1, complete" anyway, because a receipt was taken as
     * success without reading its status. The holder had nothing and the asset
     * sat in the keeper. This fixture reproduces that exactly. */
    if (REVERT_TRANSFERS && revertedHashes.has(params[0])) {
      return reply({ status: "0x0", gasUsed: "0xfbf4" });
    }
    return reply({ status: "0x1" });
  }
  if (method === "eth_sendRawTransaction") {
    sent.push(params[0]);
    /* The hash a signed transaction gets here is derived from its raw bytes the
     * same way the keeper derives it, so a specific one can be failed. */
    const h = viemCore.keccak256(params[0]);
    const tx = signedTxs[parseInt(params[0].slice(2), 16) - 1];
    if (REVERT_TRANSFERS && tx && String(tx.data || "").startsWith("0xa9059cbb")) {
      revertedHashes.add(h);
    }
    return reply(h);
  }

  if (method === "eth_call") {
    const to = String(params[0].to || "").toLowerCase();
    const d = params[0].data;

    if (to === ROUTER) {
      quoteCalls++;
      // quoteBest2 — the two-hop route, which is all NOPOOL has
      if (d.startsWith("0x09edbcc5")) return reply("0x" + hex32(0) + hex32(HOP_OUT));
      /* quoteBest. Pool 1 (fee 500) is the deep one; pool 0 is empty and quotes
       * zero. Returning index 1 is the answer a real quoteBest would give. */
      return reply("0x" + hex32(1) + hex32(USDG_OUT));
    }
    if (to === NOPOOL) {
      const hops = signedTxs.filter(
        (t) => String(t.data || "").startsWith("0xe235cc1c")).length;
      return reply("0x" + hex32(BigInt(hops) * HOP_OUT));
    }
    if (to === USDG) {
      /* balanceOf. Grows by USDG_OUT with every swap already signed, so the
       * keeper's before/after delta is a real measurement rather than a
       * constant that would pass whatever it computed. */
      const swapsSoFar = signedTxs.filter(
        (t) => String(t.data || "").startsWith("0x4ea88ad7")).length;
      return reply("0x" + hex32(BigInt(swapsSoFar) * USDG_OUT));
    }
    if (d.startsWith("0xdf18e047")) return reply("0x" + hex32(POT));
    if (d.startsWith("0x2cc3dc6e")) {
      return reply("0x" + hex32(0) + hex32(300) + hex32(10000) +
                   hex32(0) + hex32(0) + hex32(0) + hex32(0));
    }
  }
  if (method === "eth_getLogs") {
    const tok = "0x" + (params[0].topics[1] || "").slice(26);
    if (![A, B, C].includes(tok)) return reply([]);
    return reply([{
      topics: [BOUGHT, params[0].topics[1]],
      data: "0x" + hex32(10n * ETH) + hex32(0) + hex32(10n * ETH * 300n / 10000n),
      blockNumber: "0x" + (1500).toString(16)
    }]);
  }
  return reply(null);
}

/* A signer whose transactions are recorded rather than sent. The raw form has
 * to be real hex: the keeper hashes it to get an id it can look up later. */
let signCount = 0;
const signedTxs = [];
const viemStub = {
  privateKeyToAccount: () => ({
    address: KEEPER,
    signTransaction: async (tx) => {
      signedTxs.push(tx);
      return "0x" + (++signCount).toString(16).padStart(64, "0");
    }
  })
};
const viemCore = { keccak256: (raw) => "0x" + raw.replace(/^0x/, "").slice(0, 64) };

process.env.RH_KEEPER_SECRET = "0x" + "11".repeat(32);
process.env.RH_CURVE = CURVE;
process.env.RH_SWAP_ROUTER = ROUTER;
delete process.env.CRON_SECRET;

const src = fs.readFileSync(path.join(root, "app/public/api/rh-keeper.js"), "utf8")
  .replace('import { kv } from "./_guard.js";', "const kv = async () => db;")
  .replace(/await import\("viem\/accounts"\)/g, "viemStub")
  .replace(/await import\("viem"\)/g, "viemCore")
  .replace(/await import\("node:fs\/promises"\)/g, "({ readFile: async () => { throw new Error('no'); } })")
  .replace("export const config", "const config")
  .replace("export default async function handler", "async function handler");
const handler = new Function("db", "fetch", "AbortSignal", "viemStub", "viemCore", "process",
  src + "; return handler;")(db, stubFetch, AbortSignal, viemStub, viemCore, process);

const res = { code: 0, body: null, status(c){this.code=c;return this;}, json(b){this.body=b;return this;} };
await handler({ headers: {}, query: {} }, res);

let bad = 0;
const check = (l, ok, d) => { if (!ok) bad++; console.log((ok ? "  ok  " : " FAIL ") + l + (d ? "  " + d : "")); };

console.log("  keeper said:", JSON.stringify(res.body).slice(0, 200), "\n");

/* Decode what was actually signed. An asset payment is a transfer ON the token
 * contract; an ETH payment is value on a bare send. */
const erc20 = signedTxs.filter((t) => String(t.data || "").startsWith("0xa9059cbb"));
const swaps = signedTxs.filter((t) => String(t.data || "").startsWith("0x4ea88ad7"));
const ethSends = signedTxs.filter((t) => (t.data === "0x" || !t.data) && t.value > 0n);

const decodeTransfer = (t) => ({
  token: t.to.toLowerCase(),
  to: "0x" + t.data.slice(10 + 24, 10 + 64),
  amount: BigInt("0x" + t.data.slice(10 + 64, 10 + 128))
});
const paid = Object.fromEntries(erc20.map(decodeTransfer).map((x) => [x.to, x.amount]));

// ── the swap itself ─────────────────────────────────────────────────────────
check("both USDG tokens swapped", swaps.length === 2, swaps.length + " swaps");
check("the swap spent token A's slice, not the whole pot",
  swaps[0] && swaps[0].value === POT / 3n, "value " + (swaps[0] && swaps[0].value));

/* minOut must be the quote less slippage — never zero. An unprotected swap of
 * someone else's payout is a free lunch for the mempool. */
const minOut = swaps[0] && BigInt("0x" + swaps[0].data.slice(10 + 5 * 64, 10 + 6 * 64));
check("minOut is the quote less 3%, not zero",
  minOut === (USDG_OUT * 9700n) / 10000n, "minOut " + minOut);

/* The picker must choose the DEEP pool. The stub reports index 1, and index 1
 * of the HOOKLESS list is fee 500 — if hooked pools were not filtered out the
 * indexes would shift and this would silently swap through the wrong pool. */
const swappedFee = swaps[0] && Number(BigInt("0x" + swaps[0].data.slice(10 + 2 * 64, 10 + 3 * 64)));
check("it swapped through the pool the quote named", swappedFee === 500, "fee " + swappedFee);

// ── who got paid, and how much ──────────────────────────────────────────────
check("the USDG holders were paid in USDG",
  erc20.filter((t) => t.to.toLowerCase() === USDG).length === 3,
  erc20.length + " erc20 transfers in total");
check("the whole swap output went out",
  (paid[H1] || 0n) + (paid[H2] || 0n) === USDG_OUT,
  `expected ${USDG_OUT}, paid ${(paid[H1] || 0n) + (paid[H2] || 0n)}`);
check("75/25 split of the ASSET, not of the ETH",
  paid[H1] === (USDG_OUT * 75n) / 100n && paid[H2] === (USDG_OUT * 25n) / 100n,
  `${paid[H1]} / ${paid[H2]}`);

// ── the two rules that stop money going twice ───────────────────────────────
/* ⚠️ The bug this replaced: B swapped its ETH, was deferred, and had its
 * cursor advanced anyway — so its holders got nothing and the USDG stayed in
 * the keeper. Each swap now measures its own delta, so B settles too. */
check("token B's holder got B's swap, not a share of A's",
  paid[H3] === USDG_OUT, "H3 got " + (paid[H3] || 0n));
check("A and B did not double-count the same balance",
  (paid[H1] || 0n) + (paid[H2] || 0n) + (paid[H3] || 0n) === USDG_OUT * 2n,
  `total ${(paid[H1] || 0n) + (paid[H2] || 0n) + (paid[H3] || 0n)}`);
/* ⚠️ Token C's asset has NO ETH pool — before two-hop routing its holders were
 * paid ETH and nobody was told the choice had been silently dropped. It should
 * now be reached through USDG. */
const hops = signedTxs.filter((t) => String(t.data || "").startsWith("0xe235cc1c"));
check("the asset with no ETH pool was reached through USDG",
  hops.length === 1, hops.length + " two-hop swaps");
check("the two-hop swap spent token C's slice",
  hops[0] && hops[0].value === POT / 3n, "value " + (hops[0] && hops[0].value));
check("its holder was paid the asset, not ETH",
  paid[H4] === HOP_OUT, "H4 got " + (paid[H4] || 0n));
check("nothing fell back to an ETH payout",
  ethSends.length === 0, ethSends.length + " eth sends");

/* The near leg is shared by every hopped asset and must be a REAL quote, not
 * assumed: routing through an empty ETH/USDG pool would land the whole payout
 * in a pool that pays nothing. */
check("the two-hop route carries both legs",
  hops[0] && hops[0].data.length === 2 + 8 + 64 * 12,
  "calldata words " + (hops[0] ? (hops[0].data.length - 10) / 64 : 0));

// ── resumability ────────────────────────────────────────────────────────────
const plan = store.get("rhk:plan");
check("the plan was cleared once everything was paid", !plan);

/* ── and again, with the transfers reverting ────────────────────────────────
 *
 * The property under test is that a run which cannot pay says so. Before this,
 * a reverted transfer advanced `sent`, moved the cursors, deleted the plan and
 * reported success — the worst possible failure mode, because nothing after it
 * would ever retry. */
console.log("\n  replaying with every ERC20 transfer reverting:\n");

store.clear();
store.set("rhix:" + A + ":h", { [H1]: (75n * ETH).toString(), [H2]: (25n * ETH).toString() });
store.set("rhix:" + B + ":h", { [H3]: (10n * ETH).toString() });
store.set("rhix:" + C + ":h", { [H4]: (10n * ETH).toString() });
for (const t of [A, B, C]) store.set("rhk:" + t + ":cursor", "1000");
signedTxs.length = 0; sent.length = 0; signCount = 0;
REVERT_TRANSFERS = true;

const res2 = { code: 0, body: null, status(c){this.code=c;return this;}, json(b){this.body=b;return this;} };
await handler({ headers: {}, query: {} }, res2);

const b2 = res2.body || {};
check("a reverted payout is NOT reported complete", b2.complete !== true,
  "complete=" + b2.complete);
check("the failure is reported rather than swallowed",
  Array.isArray(b2.failures) && b2.failures.length > 0,
  (b2.failures || []).length + " failures");
check("the plan survives so the next run can retry", !!store.get("rhk:plan"));
check("the cursors did NOT advance past unpaid earnings",
  store.get("rhk:" + A + ":cursor") === "1000",
  "cursor " + store.get("rhk:" + A + ":cursor"));

console.log(bad ? `\n${bad} failed` : "\nthe swap leg pays the right asset to the right people, and says so when it cannot");
process.exit(bad ? 1 : 0);
