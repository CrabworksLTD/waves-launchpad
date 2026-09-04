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
      { address: NOPOOL, symbol: "NOPOOL", decimals: 18, ethPools: [] }
    ] }) };
  }

  const { method, params } = JSON.parse(opts.body);
  const reply = (result) => ({ ok: true, json: async () => ({ jsonrpc: "2.0", id: 1, result }) });

  if (method === "eth_blockNumber") return reply("0x" + (2000).toString(16));
  if (method === "eth_getBlockByNumber") return reply({ baseFeePerGas: "0x1" });
  if (method === "eth_getBalance") return reply("0x" + (100n * ETH).toString(16));
  if (method === "eth_getTransactionCount") return reply("0x0");
  if (method === "eth_getTransactionReceipt") return reply({ status: "0x1" });
  if (method === "eth_sendRawTransaction") {
    sent.push(params[0]);
    return reply("0x" + "ab".repeat(32));
  }

  if (method === "eth_call") {
    const to = String(params[0].to || "").toLowerCase();
    const d = params[0].data;

    if (to === ROUTER) {                       // quoteBest
      quoteCalls++;
      /* Pool 1 (fee 500) is the deep one; pool 0 is empty and quotes zero.
       * Returning index 1 is the answer a real quoteBest would give. */
      return reply("0x" + hex32(1) + hex32(USDG_OUT));
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
check("all three USDG holders were paid in USDG",
  erc20.length === 3 && erc20.every((t) => t.to.toLowerCase() === USDG),
  erc20.length + " erc20 transfers");
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
check("token C fell back to ETH when its asset had no pool",
  ethSends.some((t) => t.to.toLowerCase() === H4 && t.value === POT / 3n),
  ethSends.length + " eth sends");

// ── resumability ────────────────────────────────────────────────────────────
const plan = store.get("rhk:plan");
check("the plan was cleared once everything was paid", !plan);

console.log(bad ? `\n${bad} failed` : "\nthe swap leg pays the right asset to the right people");
process.exit(bad ? 1 : 0);
