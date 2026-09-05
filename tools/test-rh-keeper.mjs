/* node tools/test-rh-keeper.mjs
 *
 * The keeper's arithmetic, which is the part that decides where money goes.
 *
 * Two tokens pledging to the same keeper share one `owed` balance on the curve,
 * so the pot has to be split by what each token actually earned before it is
 * split again by what each holder holds. Getting either wrong pays the wrong
 * people, silently, with real money — so both are checked against figures
 * worked out independently here rather than by rerunning the same code.
 *
 * Nothing is signed and nothing is sent: the RPC is a stub.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const CURVE = "0x77ddd6ceb454e4b71a1952fcaafb8cf9975f55c0";
const KEEPER = "0xAcA1d1bE05f47090a6d8D918AB26d4543fD3Af81";
const ETH = 10n ** 18n;

const A = "0xaaaa000000000000000000000000000000000001";   // 3% rung, all pledged
const B = "0xbbbb000000000000000000000000000000000002";   // 1% rung, half pledged

/* Trades, and what each SHOULD contribute to the keeper.
 *
 * platform takes bps-of-volume by rung (3% -> 60bps, 1% -> 40bps); the creator
 * side is the rest of the fee; the holders' share is the pledged fraction. */
const trades = {
  [A]: [{ volume: 10n * ETH, fee: 10n * ETH * 300n / 10000n }],   // 3% of 10 = 0.3
  [B]: [{ volume: 20n * ETH, fee: 20n * ETH * 100n / 10000n }]    // 1% of 20 = 0.2
};
const expected = {
  // A: fee 0.3, platform 0.6% of 10 = 0.06, creator 0.24, 100% pledged -> 0.24
  [A]: (10n * ETH * 300n / 10000n) - (10n * ETH * 60n / 10000n),
  // B: fee 0.2, platform 0.4% of 20 = 0.08, creator 0.12, 50% pledged -> 0.06
  [B]: ((20n * ETH * 100n / 10000n) - (20n * ETH * 40n / 10000n)) / 2n
};

const holders = {
  [A]: { "0x1111111111111111111111111111111111111111": (75n * ETH).toString(),
         "0x2222222222222222222222222222222222222222": (25n * ETH).toString() },
  [B]: { "0x3333333333333333333333333333333333333333": (10n * ETH).toString() }
};

const POT = expected[A] + expected[B];        // the curve owes exactly this

const store = new Map();
const db = {
  get: async (k) => store.get(k) ?? null,
  set: async (k, v) => void store.set(k, v),
  del: async (k) => void store.delete(k),
  hgetall: async (k) => store.get(k) || null,
  lpush: async () => {}, ltrim: async () => {},
  lrange: async () => [
    JSON.stringify({ mint: A, chain: "robinhood", feeSharePct: 100, block: 1000 }),
    JSON.stringify({ mint: B, chain: "robinhood", feeSharePct: 50, block: 1000 })
  ]
};
store.set("rhix:" + A + ":h", holders[A]);
store.set("rhix:" + B + ":h", holders[B]);
store.set("rhk:" + A + ":cursor", "1000");
store.set("rhk:" + B + ":cursor", "1000");

const BOUGHT = "0x7ce543d1780f3bdc3dac42da06c95da802653cd1b212b8d74ec3e3c33ad7095c";
const hex32 = (v) => BigInt(v).toString(16).padStart(64, "0");
const sent = [];

async function stubFetch(_url, opts) {
  const { method, params } = JSON.parse(opts.body);
  const reply = (result) => ({ ok: true, json: async () => ({ jsonrpc: "2.0", id: 1, result }) });

  if (method === "eth_blockNumber") return reply("0x" + (2000).toString(16));
  if (method === "eth_getBlockByNumber") return reply({ baseFeePerGas: "0x1" });  // ~free gas
  if (method === "eth_getBalance") return reply("0x" + (ETH).toString(16));
  if (method === "eth_getTransactionCount") return reply("0x0");
  if (method === "eth_getTransactionReceipt") return reply({ status: "0x1" });
  if (method === "eth_sendRawTransaction") return reply("0x" + "ab".repeat(32));

  if (method === "eth_call") {
    const d = params[0].data;
    if (d.startsWith("0xdf18e047")) return reply("0x" + hex32(POT));          // owed(keeper)
    if (d.startsWith("0x2cc3dc6e")) {                                          // curves(token)
      const tok = "0x" + d.slice(34);
      const feeBps = tok === A ? 300 : 100;
      const rewardsBps = tok === A ? 10000 : 5000;
      return reply("0x" + hex32(0) + hex32(feeBps) + hex32(rewardsBps) +
                   hex32(0) + hex32(0) + hex32(0) + hex32(0));
    }
  }
  if (method === "eth_getLogs") {
    const tok = "0x" + (params[0].topics[1] || "").slice(26);
    const list = trades[tok] || [];
    return reply(list.map((t) => ({
      topics: [BOUGHT, params[0].topics[1]],
      data: "0x" + hex32(t.volume) + hex32(0) + hex32(t.fee),
      blockNumber: "0x" + (1500).toString(16)
    })));
  }
  return reply(null);
}

// a signer whose "transactions" are just recorded
const viemStub = {
  privateKeyToAccount: () => ({
    address: KEEPER,
    signTransaction: async (tx) => { sent.push(tx); return "0xsigned"; }
  })
};

process.env.RH_KEEPER_SECRET = "0x" + "11".repeat(32);
process.env.RH_CURVE = CURVE;
delete process.env.CRON_SECRET;

const src = fs.readFileSync(path.join(root, "app/public/api/rh-keeper.js"), "utf8")
  .replace('import { kv } from "./_guard.js";', "const kv = async () => db;")
  .replace(/await import\("viem\/accounts"\)/g, "viemStub")
  .replace("export const config", "const config")
  /* new Function() cannot parse a module, so every export has to become a
   * plain declaration — including the named one the indexer imports. */
  .replace("export async function bestRoute", "async function bestRoute")
  .replace("export default async function handler", "async function handler");
const handler = new Function("db", "fetch", "AbortSignal", "viemStub", "process",
  src + "; return handler;")(db, stubFetch, AbortSignal, viemStub, process);

const res = { code: 0, body: null, status(c){this.code=c;return this;}, json(b){this.body=b;return this;} };
await handler({ headers: {}, query: {} }, res);

let bad = 0;
const check = (l, ok, d) => { if (!ok) bad++; console.log((ok ? "  ok  " : " FAIL ") + l + (d ? "  " + d : "")); };

console.log("  keeper said:", JSON.stringify(res.body).slice(0, 160), "\n");

// the transfers, excluding the claim (which goes to the curve with no value)
const transfers = sent.filter((t) => t.value > 0n);
const paid = new Proxy(
  Object.fromEntries(transfers.map((t) => [t.to.toLowerCase(), t.value])),
  { get: (o, k) => (typeof k === "string" && k in o ? o[k] : 0n) }   // a missed holder is zero, not undefined
);
const total = transfers.reduce((a, t) => a + t.value, 0n);

check("every holder was paid", transfers.length === 3, transfers.length + " transfers");
check("the whole pot went out (within rounding)",
  POT - total < 10n, `pot ${POT} paid ${total}`);

/* A earned 0.24 of the 0.30 pot and B earned 0.06. Its holders split A's slice
 * 75/25; B's single holder takes all of B's. */
const sliceA = (POT * expected[A]) / (expected[A] + expected[B]);
const sliceB = POT - sliceA;
check("token A's slice matches what it earned",
  paid["0x1111111111111111111111111111111111111111"] + paid["0x2222222222222222222222222222222222222222"] - sliceA < 10n,
  `expected ${sliceA}`);
check("token B's holder gets B's slice, not a share of A's",
  sliceB - paid["0x3333333333333333333333333333333333333333"] < 10n,
  `expected ${sliceB}`);
check("the 75/25 holder split is proportional",
  paid["0x1111111111111111111111111111111111111111"] * 25n /
  paid["0x2222222222222222222222222222222222222222"] / 75n === 1n);

// and the cursors only move once the money is out
check("cursors advanced after a complete run",
  store.get("rhk:" + A + ":cursor") === "2000");
check("the plan was cleared", !store.get("rhk:plan"));

console.log(bad ? `\n${bad} failed` : "\nthe keeper splits the pot correctly");
process.exit(bad ? 1 : 0);
