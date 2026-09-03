/* node tools/test-evm-token.mjs
 *
 * Drives app/public/evm-token.js against a real EVM.
 *
 * The module hand-rolls its ABI encoding, decoding and event parsing, because
 * pulling in ethers or viem would cost more than everything else the page
 * loads. That is a fine trade only if the encoding is actually right, and
 * "looks right" is not a test — a wrong offset produces a transaction that
 * decodes into nonsense and reverts after taking the gas.
 *
 * So: start anvil, deploy the real WavesCurve, and drive it through the real
 * module with the browser globals shimmed. No fork needed — the curve does not
 * touch Uniswap until graduate(), which has its own tests.
 */
import fs from "node:fs";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const RPC = "http://127.0.0.1:8545";
const DEPLOYER = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266";   // anvil #0
const BUYER = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8";      // anvil #1

let id = 0;
async function rpc(method, params) {
  const r = await fetch(RPC, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params })
  });
  const j = await r.json();
  if (j.error) throw new Error(method + ": " + (j.error.message || JSON.stringify(j.error)));
  return j.result;
}

async function mined(hash) {
  for (let i = 0; i < 100; i++) {
    const r = await rpc("eth_getTransactionReceipt", [hash]);
    if (r) return r;
    await new Promise((s) => setTimeout(s, 100));
  }
  throw new Error("never mined");
}

// ── boot anvil ───────────────────────────────────────────────────────────────
const anvil = spawn(process.env.HOME + "/.foundry/bin/anvil", ["--silent"], { stdio: "ignore" });
process.on("exit", () => anvil.kill());
for (let i = 0; i < 60; i++) {
  try { await rpc("eth_blockNumber", []); break; } catch { await new Promise((s) => setTimeout(s, 250)); }
}

// ── shim just enough browser ─────────────────────────────────────────────────
let FROM = DEPLOYER;
global.window = {
  BRAND: { evmChainId: 31337, evmCurves: {} },
  MOONPAD_CHAINS: [{ id: 31337, name: "anvil", rpc: RPC, explorer: "http://localhost" }],
  MoonpadRPC: { send: (_url, method, params) => rpc(method, params) },
  ethereum: { request: ({ method, params }) => rpc(method, params) },
  MoonpadLaunch: { connect: async () => FROM, switchChain: async () => {} }
};
eval(fs.readFileSync(path.join(root, "app/public/evm-wavescurve.js"), "utf8"));
eval(fs.readFileSync(path.join(root, "app/public/evm-token.js"), "utf8"));
const T = window.MoonpadToken;

let bad = 0;
const check = (label, ok, detail) => {
  if (!ok) bad++;
  console.log((ok ? "  ok  " : " FAIL ") + label + (detail ? "  " + detail : ""));
};

// ── deploy the curve through the module's own encoder ────────────────────────
const ETH = 10n ** 18n;
const hash = await T.deployCurve({
  platform: "0x000000000000000000000000000000000000fee5",
  graduationEth: 4n * ETH,
  virtualEth: 1410000000000000000n,
  virtualTokens: 1073000000n * ETH,
  curveSupply: 1000000000n * ETH,
  factory: "0x1f7d7550B1b028f7571E69A784071F0205FD2EfA",
  weth: "0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73",
  poolFee: 10000
});
const curve = (await mined(hash)).contractAddress;
window.BRAND.evmCurves[31337] = curve;
check("the curve deploys from the module's constructor encoding", !!curve, curve);

// terms must read back exactly what was deployed
const terms = await T.terms();
check("terms() reads back the deployed parameters",
  terms.graduationEth === 4n * ETH && terms.curveSupply === 1000000000n * ETH,
  `grad=${terms.graduationEth / ETH} ETH`);

// ── launch ───────────────────────────────────────────────────────────────────
const lh = await T.launch({ name: "Fart", symbol: "FART", feeBps: 300, devBuyWei: ETH });
const launched = await T.waitForLaunch(lh.hash);
check("the token address comes back out of the Launched event",
  /^0x[0-9a-f]{40}$/i.test(launched.token), launched.token);
check("the creator in the event is the sender",
  launched.creator.toLowerCase() === DEPLOYER.toLowerCase());

const tok = launched.token;
const c0 = await T.curveOf(tok);
check("curves() decodes into the right shape",
  c0.creator.toLowerCase() === DEPLOYER.toLowerCase() && c0.feeBps === 300 &&
  c0.graduated === false && c0.raised > 0n,
  `fee=${c0.feeBps}bps raised=${c0.raised}`);

const devBal = await T.balanceOf(tok, DEPLOYER);
check("the dev buy landed in the same transaction", devBal > 0n,
  (devBal / ETH).toString() + " tokens");

// ── quote then buy, and see that the quote was honest ────────────────────────
FROM = BUYER;
const quoted = await T.quoteBuy(tok, 2n * ETH);
await mined(await T.buy(tok, 2n * ETH, 0, BUYER));
const got = await T.balanceOf(tok, BUYER);
check("quoteBuy predicts the fill exactly", quoted === got,
  `quoted=${quoted} got=${got}`);

// ── sell it back ─────────────────────────────────────────────────────────────
await mined(await T.approve(tok, got, BUYER));
check("allowance is set after approve", (await T.allowance(tok, BUYER)) === got);
const before = BigInt(await rpc("eth_getBalance", [BUYER, "latest"]));
await mined(await T.sell(tok, got, 0, BUYER));
check("selling everything back returns the tokens to the curve",
  (await T.balanceOf(tok, BUYER)) === 0n);
check("and returns ETH to the seller",
  BigInt(await rpc("eth_getBalance", [BUYER, "latest"])) > before - ETH / 10n);

// ── progress and readiness track the curve ───────────────────────────────────
const p = await T.progressBps(tok);
check("progressBps is a sane fraction of graduation", p > 0 && p < 10000, p + " bps");
check("ready() is false well before the threshold", (await T.ready(tok)) === false);

// ── the fee ladder is enforced on chain, not by the UI ───────────────────────
let rejected = false;
try { await T.launch({ name: "X", symbol: "X", feeBps: 250, devBuyWei: 0n }); }
catch (e) { rejected = /rung/i.test(e.message); }
check("an off-ladder fee is refused with a readable reason", rejected);

// ── pledging is creator-only and one-way ─────────────────────────────────────
FROM = DEPLOYER;
await mined(await T.pledgeToHolders(tok, 10000, "0x000000000000000000000000000000000000dEaD", DEPLOYER));
const c1 = await T.curveOf(tok);
check("a pledge is recorded on the curve", c1.rewardsBps === 10000);
let twice = false;
try { await T.pledgeToHolders(tok, 5000, "0x000000000000000000000000000000000000dEaD", DEPLOYER); }
catch (e) { twice = /already pledged/i.test(e.message); }
check("pledging twice is refused with a readable reason", twice);

// ── the buy cap, the bug the fuzzer found ────────────────────────────────────
FROM = BUYER;
await mined(await T.buy(tok, 60n * ETH, 0, BUYER));
const c2 = await T.curveOf(tok);
check("an oversized buy is capped at the threshold, not swallowed",
  c2.raised === 4n * ETH && c2.tokensLeft > 0n,
  `raised=${c2.raised / ETH} ETH left=${c2.tokensLeft / ETH}`);
check("and the curve now reports itself ready", (await T.ready(tok)) === true);

let full = false;
try { await T.buy(tok, ETH, 0, BUYER); } catch (e) { full = /full/i.test(e.message); }
check("a full curve refuses more money with a readable reason", full);

// ── the adapter the token page's trade box talks to ──────────────────────────
FROM = BUYER;
window.MoonpadWallet = { account: BUYER };
const ad = T.adapter();

const lh2 = await T.launch({ name: "Ad", symbol: "AD", feeBps: 300, devBuyWei: ETH });
const tok2 = (await T.waitForLaunch(lh2.hash)).token;

const mk = await ad.readMarket(tok2);
check("readMarket reports a live curve",
  mk.migrated === false && mk.price > 0 && mk.supply === 1e9 && mk.quote === "ETH",
  `price=${mk.price.toExponential(3)} mcap=${Math.round(mk.mcap)} ETH`);
check("progress tracks the threshold",
  mk.progress > 0 && mk.progress < 1 && mk.threshold === 4,
  `${(mk.progress * 100).toFixed(1)}%`);

const q = await ad.getQuote(tok2, 0.5, "buy");
check("a quote carries a slippage floor below the expected fill",
  q.minOut < BigInt(Math.floor(q.out * 1e18)) && q.minOut > 0n);

await mined(await ad.swap(tok2, "buy", q.amountIn, q.minOut));
const held = await ad.balanceOf(tok2);
check("adapter buy fills at or above the floor", held >= q.out * 0.99,
  `held=${held.toFixed(0)}`);

/* The one that matters: a sell has to approve FIRST and wait for it to mine.
 * An approval still in the mempool is not an allowance. */
const sq = await ad.getQuote(tok2, held / 2, "sell");
const ethBefore = BigInt(await rpc("eth_getBalance", [BUYER, "latest"]));
await mined(await ad.swap(tok2, "sell", sq.amountIn, sq.minOut));
check("adapter sell approves, waits, then sells in one call",
  BigInt(await rpc("eth_getBalance", [BUYER, "latest"])) > ethBefore - ETH / 20n);
check("and the tokens left the wallet", (await ad.balanceOf(tok2)) < held * 0.6);

check("rewardsActive is false before any pledge", (await ad.rewardsActive(tok2)) === false);
FROM = BUYER;
await mined(await T.pledgeToHolders(tok2, 5000, "0x000000000000000000000000000000000000dEaD", BUYER));
check("rewardsActive is true once pledged", (await ad.rewardsActive(tok2)) === true);

anvil.kill();
console.log(bad ? `\n${bad} failed` : "\nevm-token.js drives the real contract correctly");
process.exit(bad ? 1 : 0);
