#!/usr/bin/env node
/* Batch-sign Meteora DBC partner configs for tokenised-stock QUOTE currencies.
 *
 * One config is created per (stock mint × fee rung). The config fixes the quote
 * mint, curve shape, fee split and migration rules forever — see dbc-terms.js,
 * the SAME terms the sign-in-browser page and tools/create-dbc-config.js use, so
 * these can never drift from a hand-signed one.
 *
 * The eligible-stock analysis lives in the chat that produced this file: of the
 * 749 in rwa.json only ~22 have enough liquidity to graduate into cleanly. This
 * tool re-derives that from rwa.json at run time so it can't go stale.
 *
 *   DRY RUN (builds every curve, fetches prices, sends NOTHING):
 *     node tools/sign-rwa-configs.js --dry-run
 *
 *   REAL (mainnet, standard 1% rung only, funded deployer as payer, treasury
 *   as the forever fee-claimer):
 *     CONFIG_KEYFILE=~/waves-keys/dbc-deployer.json \
 *     FEE_CLAIMER=<sweep/keeper claim key> \
 *     RPC=https://mainnet.helius-rpc.com/?api-key=... \
 *     node tools/sign-rwa-configs.js
 *
 *   ALL SIX rungs (1/2/3/4/5/10%):  add  RUNGS=all
 *   Add the real Backpack-tokenised stocks (MU, SK Hynix, Sandisk):
 *     INCLUDE=MU,SKHY,SNDK
 *
 * Options (env):
 *   CLUSTER          mainnet-beta (default) | devnet
 *   RPC              full RPC url; STRONGLY recommend a paid one — the public
 *                    endpoint will rate-limit long before 132 sends finish
 *   CONFIG_KEYFILE   solana-keygen json for the PAYER (pays rent + signs). The
 *   CONFIG_SECRET    base58 alternative. Payer need NOT be the fee owner.
 *   FEE_CLAIMER      who claims the platform's share forever (default: payer).
 *                    Set this to the same sweep key the SOL/USDC configs use.
 *   LEFTOVER_RECEIVER post-graduation remainder (default: FEE_CLAIMER/payer).
 *   MIN_LIQ          liquidity floor in USD (default 100000)
 *   RUNGS            standard (default, 1% only) | all (the six-rung LADDER)
 *   INCLUDE          extra symbols to allow, comma-sep (e.g. real non-"backed")
 *   EXCLUDE          symbols to drop, comma-sep
 *   PRICE_OVERRIDE   sym=usd,sym=usd  to hand-set a price the API can't return
 *
 * Idempotent: results append to .rwa-configs-<cluster>.json; a (mint,tier)
 * already recorded there is skipped, so a rate-limited run just resumes.
 */
"use strict";

const fs = require("fs");
const path = require("path");

const CLUSTER = process.env.CLUSTER || "mainnet-beta";
const PUBLIC_RPC = {
  "mainnet-beta": "https://api.mainnet-beta.solana.com",
  devnet: "https://api.devnet.solana.com"
};
const RPC = process.env.RPC || PUBLIC_RPC[CLUSTER];
const DRY = process.argv.includes("--dry-run") || process.env.DRY === "1";
const MIN_LIQ = Number(process.env.MIN_LIQ || 100000);
const ALL_RUNGS = (process.env.RUNGS || "standard").toLowerCase() === "all";

/* dbc-terms.js is UMD but lives under app/public, which is `type: module`, so a
 * plain require() loads it as ESM and its UMD wrapper throws. Run it in a CJS
 * sandbox instead — same terms file, no drift, no package.json surgery. */
function loadDbcTerms() {
  const src = fs.readFileSync(path.join(__dirname, "..", "app", "public", "dbc-terms.js"), "utf8");
  const m = { exports: {} };
  new Function("module", "exports", src)(m, m.exports);
  return m.exports;
}
const { TERMS, LADDER, rwaQuote, buildParams } = loadDbcTerms();

// pre-IPO / prediction / synthetic — real liquidity, no redemption anchor, so a
// terrible thing to denominate other people's tokens against. Excluded unless a
// human puts one in INCLUDE on purpose.
const PRESTOCK = new Set(["ANTHROPIC", "OPENAI", "SPCX", "ANDURIL", "POLYMARKET",
  "tOpenAI", "tSpaceX", "tKalshi", "SILV"]);

const INCLUDE = new Set((process.env.INCLUDE || "").split(",").map((s) => s.trim()).filter(Boolean));
const EXCLUDE = new Set((process.env.EXCLUDE || "").split(",").map((s) => s.trim()).filter(Boolean));
const RUNGS = ALL_RUNGS ? LADDER : ["standard"];

const PRICE_OVERRIDE = {};
(process.env.PRICE_OVERRIDE || "").split(",").map((s) => s.trim()).filter(Boolean).forEach((pair) => {
  const [k, v] = pair.split("=");
  if (k && Number(v) > 0) PRICE_OVERRIDE[k] = Number(v);
});

function eligible(t) {
  const liq = t.liquidity || 0;
  if (liq < MIN_LIQ) return false;
  if (EXCLUDE.has(t.symbol)) return false;
  if (INCLUDE.has(t.symbol)) return true;        // explicit opt-in wins
  if (PRESTOCK.has(t.symbol)) return false;
  // default: real, redeemable assets only
  return t.issuer === "backed" || t.kind === "commodity";
}

/* Altcoins as quote currencies — same config path as stocks, just fed by an
 * explicit mint list instead of rwa.json. MINTS="BONK:mint,JUP:mint" (symbol
 * optional; decimals + liquidity come from Jupiter). These are the user's
 * deliberate choice, so they bypass the real-asset filter (MIN_LIQ still warns). */
async function loadAltcoins() {
  const spec = (process.env.MINTS || "").split(",").map((s) => s.trim()).filter(Boolean);
  const out = [];
  for (const item of spec) {
    const hasSym = item.includes(":");
    const mint = (hasSym ? item.split(":")[1] : item).trim();
    let symbol = hasSym ? item.split(":")[0].trim() : "";
    let dec = 6, liq = 0;
    try {
      const rec = (await (await fetch("https://lite-api.jup.ag/price/v3?ids=" + mint)).json())[mint];
      if (rec) { dec = rec.decimals != null ? rec.decimals : 6; liq = rec.liquidity || 0; }
    } catch (e) { /* priced later; decimals default 6 */ }
    if (!symbol) {
      try { symbol = (await (await fetch("https://lite-api.jup.ag/tokens/v1/token/" + mint)).json()).symbol || mint.slice(0, 5); }
      catch (e) { symbol = mint.slice(0, 5); }
    }
    out.push({ symbol, name: symbol, mint, issuer: "altcoin", kind: "altcoin", liquidity: liq, decimals: dec });
  }
  return out;
}

async function fetchPrices(mints) {
  // Jupiter Price API v3: flat map { "<mint>": { usdPrice, decimals, ... } }.
  const out = {};
  const hosts = ["https://lite-api.jup.ag/price/v3", "https://api.jup.ag/price/v3"];
  for (let i = 0; i < mints.length; i += 50) {
    const batch = mints.slice(i, i + 50);
    let got = null;
    for (const h of hosts) {
      try {
        const r = await fetch(h + "?ids=" + batch.join(","));
        if (!r.ok) continue;
        const j = await r.json();
        if (j && typeof j === "object") { got = j; break; }
      } catch (e) { /* try next host */ }
    }
    if (got) for (const m of batch) {
      const p = got[m] && Number(got[m].usdPrice);
      if (p > 0) out[m] = p;
    }
  }
  return out;
}

const RESULTS_FILE = path.join(__dirname, "..", ".rwa-configs-" + CLUSTER + ".json");
function loadResults() {
  try { return JSON.parse(fs.readFileSync(RESULTS_FILE, "utf8")); } catch (e) { return []; }
}
function saveResults(rows) { fs.writeFileSync(RESULTS_FILE, JSON.stringify(rows, null, 2) + "\n"); }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const toks = JSON.parse(fs.readFileSync(
    path.join(__dirname, "..", "app", "public", "rwa.json"), "utf8")).tokens;

  let stocks = toks.filter(eligible);
  const alts = await loadAltcoins();                 // explicit MINTS= quote coins
  stocks = stocks.concat(alts).sort((a, b) => (b.liquidity || 0) - (a.liquidity || 0));
  if (!stocks.length) { console.error("no stocks pass the filter (MIN_LIQ=" + MIN_LIQ + ")"); process.exit(1); }

  console.log("\n  cluster   " + CLUSTER + "   rpc " + (RPC.split("?")[0]));
  console.log("  min liq   $" + MIN_LIQ.toLocaleString());
  console.log("  rungs     " + RUNGS.join(", ") + "   (" + RUNGS.length + " per stock)");
  console.log("  stocks    " + stocks.length + "   ->   " + (stocks.length * RUNGS.length) + " configs total\n");

  // prices
  const need = stocks.map((s) => s.mint);
  const prices = await fetchPrices(need);
  stocks.forEach((s) => { if (PRICE_OVERRIDE[s.symbol] > 0) prices[s.mint] = PRICE_OVERRIDE[s.symbol]; });

  const priced = [], unpriced = [];
  for (const s of stocks) (prices[s.mint] > 0 ? priced : unpriced).push(s);
  console.log("  eligible stocks (sorted by liquidity):");
  for (const s of stocks) {
    const p = prices[s.mint];
    console.log("    " + s.symbol.padEnd(11) + " $" + String(Math.round(s.liquidity)).padStart(10) +
      "  price " + (p > 0 ? "$" + p.toFixed(2) : "— (SKIP: no price)") +
      (INCLUDE.has(s.symbol) ? "  [included]" : ""));
  }
  if (unpriced.length) {
    console.log("\n  ⚠️  " + unpriced.length + " have no price from Jupiter and will be SKIPPED:");
    console.log("     " + unpriced.map((s) => s.symbol).join(", "));
    console.log("     (set PRICE_OVERRIDE=SYM=usd,... to include them)");
  }
  console.log();

  const sdk = await import("@meteora-ag/dynamic-bonding-curve-sdk");
  const { Connection, Keypair, PublicKey } = await import("@solana/web3.js");
  const enums = {
    ActivationType: sdk.ActivationType, BaseFeeMode: sdk.BaseFeeMode,
    CollectFeeMode: sdk.CollectFeeMode, TokenDecimal: sdk.TokenDecimal,
    TokenType: sdk.TokenType, MigrationOption: sdk.MigrationOption,
    MigrationFeeOption: sdk.MigrationFeeOption, TokenAuthorityOption: sdk.TokenAuthorityOption
  };

  // build the curve for every (stock, rung) up front so a dry run reviews them all
  const jobs = [];
  for (const s of priced) {
    const q = rwaQuote(s.mint, s.decimals, s.symbol, prices[s.mint]);
    for (const rung of RUNGS) {
      const curve = sdk.buildCurveWithMarketCap(buildParams(enums, q, rung));
      jobs.push({ symbol: s.symbol, mint: s.mint, decimals: s.decimals, tier: rung,
        priceUsd: prices[s.mint], curve });
    }
  }

  if (!jobs.length) { console.log("  nothing to build — no eligible stock had a usable price.\n"); return; }

  if (DRY) {
    const j0 = jobs[0];
    console.log("  --dry-run: built " + jobs.length + " configs, sent NOTHING.");
    console.log("  graduation target is $69,000 in stock-units per config; e.g. " +
      j0.symbol + " migrates at " + (69000 / j0.priceUsd).toFixed(2) + " " + j0.symbol + ".");
    console.log("\n  sample curve (" + j0.symbol + " / " + j0.tier + "):");
    const show = (k, v) => (v && v.constructor && (v.constructor.name === "BN" || v.constructor.name === "PublicKey"))
      ? v.toString() : v;
    console.log(JSON.stringify(buildParams(enums, rwaQuote(j0.mint, j0.decimals, j0.symbol, j0.priceUsd), j0.tier), show, 2));
    console.log("\n  Re-run without --dry-run (and with CONFIG_KEYFILE) to sign for real.");
    return;
  }

  // payer
  let secret = null;
  if (process.env.CONFIG_KEYFILE) {
    secret = Uint8Array.from(JSON.parse(fs.readFileSync(process.env.CONFIG_KEYFILE.replace(/^~/, process.env.HOME), "utf8")));
  } else if (process.env.CONFIG_SECRET) {
    secret = (await import("bs58")).default.decode(process.env.CONFIG_SECRET);
  } else {
    console.error("  Set CONFIG_KEYFILE=<solana-keygen json> (the funded PAYER) or CONFIG_SECRET=<base58>.");
    console.error("  The payer only pays rent + signs; FEE_CLAIMER is who claims fees forever.");
    process.exit(1);
  }
  const payer = Keypair.fromSecretKey(secret);
  const feeClaimer = new PublicKey(process.env.FEE_CLAIMER || payer.publicKey.toBase58());
  const leftover = new PublicKey(process.env.LEFTOVER_RECEIVER || feeClaimer.toBase58());
  const conn = new Connection(RPC, "confirmed");
  const client = new sdk.DynamicBondingCurveClient(conn, "confirmed");

  const bal = await conn.getBalance(payer.publicKey);
  console.log("  payer      " + payer.publicKey.toBase58() + "   (" + (bal / 1e9).toFixed(3) + " SOL)");
  console.log("  feeClaimer " + feeClaimer.toBase58());
  console.log("  leftoverTo " + leftover.toBase58() + "\n");
  if (bal < 0.05e9 * jobs.length / 6) console.log("  ⚠️  payer balance looks low for " + jobs.length + " configs; top it up if sends start failing.\n");

  const rows = loadResults();
  const done = new Set(rows.map((r) => r.mint + ":" + r.tier));
  let created = 0, skipped = 0, failed = 0;

  for (const job of jobs) {
    const key = job.mint + ":" + job.tier;
    if (done.has(key)) { skipped++; continue; }

    let ok = false, lastErr = null;
    for (let attempt = 1; attempt <= 3 && !ok; attempt++) {
      try {
        const config = Keypair.generate();
        const tx = await client.partner.createConfig({
          config: config.publicKey,
          feeClaimer, leftoverReceiver: leftover, payer: payer.publicKey,
          quoteMint: new PublicKey(job.mint),
          ...job.curve
        });
        tx.feePayer = payer.publicKey;
        tx.recentBlockhash = (await conn.getLatestBlockhash("confirmed")).blockhash;
        tx.sign(payer, config);
        const sig = await conn.sendRawTransaction(tx.serialize(), { maxRetries: 3 });
        await conn.confirmTransaction(sig, "confirmed");
        rows.push({ symbol: job.symbol, mint: job.mint, decimals: job.decimals,
          tier: job.tier, config: config.publicKey.toBase58(), feeClaimer: feeClaimer.toBase58(),
          priceUsdAtCreation: job.priceUsd, signature: sig, createdAt: new Date().toISOString() });
        saveResults(rows);
        console.log("  ✓ " + job.symbol.padEnd(10) + " " + job.tier.padEnd(9) + " " + config.publicKey.toBase58());
        created++; ok = true;
      } catch (e) {
        lastErr = e && e.message ? e.message : String(e);
        await sleep(1200 * attempt);
      }
    }
    if (!ok) { failed++; console.log("  ✗ " + job.symbol.padEnd(10) + " " + job.tier.padEnd(9) + " FAILED: " + lastErr); }
    await sleep(400); // be kind to the RPC
  }

  console.log("\n  created " + created + "   skipped(existing) " + skipped + "   failed " + failed);
  console.log("  recorded in " + path.basename(RESULTS_FILE));
  emitBrandBlock(rows);
})().catch((e) => {
  console.error("\n  FAILED — " + (e && e.message ? e.message : e));
  if (e && e.logs) console.error("\n  " + e.logs.join("\n  "));
  process.exit(1);
});

/* Print a paste-ready brand.js block. RWA configs live under each tier family's
 * `rwa` map (standard = the cluster object's own top-level rwa), keyed by mint:
 *   rwa: { "<mint>": { config, symbol, decimals } }  */
function emitBrandBlock(rows) {
  const byTier = {};
  for (const r of rows) (byTier[r.tier] = byTier[r.tier] || {})[r.mint] =
    { config: r.config, symbol: r.symbol, decimals: r.decimals };
  const fmt = (map) => "{\n" + Object.entries(map).map(([m, v]) =>
    '      "' + m + '": { config: "' + v.config + '", symbol: "' + v.symbol + '", decimals: ' + v.decimals + " }")
    .join(",\n") + "\n    }";
  console.log("\n  ── paste into app/public/brand.js dbcConfigs[\"" + CLUSTER + "\"] ──\n");
  if (byTier.standard) console.log("  // standard (1%) rung — the cluster object's OWN rwa:\n    rwa: " + fmt(byTier.standard) + ",\n");
  for (const t of ["t2", "t3", "t4", "t5", "t10"]) {
    if (byTier[t]) console.log("  // inside " + t + ": {...}, set its rwa:\n    rwa: " + fmt(byTier[t]) + ",\n");
  }
}
