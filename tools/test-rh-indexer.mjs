/* node tools/test-rh-indexer.mjs
 *
 * Drive the real indexer against a real token, with an in-memory store instead
 * of Redis. Proves the log walking, the balance arithmetic and the exclusions —
 * everything except Upstash itself. */
import fs from "node:fs";

const store = new Map();
const db = {
  get: async (k) => store.get(k) ?? null,
  set: async (k, v) => void store.set(k, v),
  hgetall: async (k) => store.get(k) || null,
  hset: async (k, obj) => { store.set(k, { ...(store.get(k) || {}), ...obj }); },
  hdel: async (k, ...f) => { const h = store.get(k) || {}; f.forEach((x) => delete h[x]); store.set(k, h); },
  lrange: async () => [JSON.stringify(TOKEN)]
};

const TOKEN = {
  mint: "0xb0a7df5f6584955a45b3c55e4709a2a0f0ab6b63",   // FART, has real trades
  chain: "robinhood",
  feeSharePct: 100,
  block: null            // deliberately unset: the pre-fix records have no block
};

const src = fs.readFileSync("app/public/api/rh-indexer.js", "utf8")
  .replace('import { kv } from "./_guard.js";', "const kv = async () => db;")
  .replace("export const config", "const config")
  .replace("export default async function handler", "async function handler");
const mod = new Function("db", "fetch", "AbortSignal", src + "; return handler;")(db, fetch, AbortSignal);

const res = { code: 0, body: null, status(c){this.code=c;return this;}, json(b){this.body=b;return this;} };
await mod({ headers: {}, query: { token: TOKEN.mint } }, res);
console.log("  response:", JSON.stringify(res.body));

const holders = store.get("rhix:" + TOKEN.mint + ":h") || {};
const entries = Object.entries(holders);
console.log(`\n  holders found: ${entries.length}`);
for (const [a, bal] of entries.slice(0, 8)) {
  console.log(`    ${a}  ${(Number(bal) / 1e18).toLocaleString(undefined, {maximumFractionDigits: 0})}`);
}
const CURVE = "0x77ddd6ceb454e4b71a1952fcaafb8cf9975f55c0";
console.log("\n  curve excluded:", !(CURVE in holders) ? "yes" : "NO — BUG");
console.log("  zero excluded:", !("0x0000000000000000000000000000000000000000" in holders) ? "yes" : "NO — BUG");
console.log("  any negative balance:", entries.some(([,v]) => BigInt(v) <= 0n) ? "YES — BUG" : "no");
console.log("  cursor stored:", store.get("rhix:" + TOKEN.mint + ":cursor"));
