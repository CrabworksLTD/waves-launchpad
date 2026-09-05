#!/usr/bin/env node
/* node tools/verify-contract.js <ContractName> <address> [--wait]
 *
 * Publish a contract's source to Robinhood Chain's Blockscout, so it stops
 * reading as "Unknown Contract".
 *
 * ── Why this matters more than it sounds ─────────────────────────────────────
 * GMGN shows every one of our launches with a warning triangle and "Unknown
 * Contract / Decompiled source". A trader looking at a token they have never
 * heard of, on a launchpad they have never heard of, sees an unverified
 * contract flagged in red. Verification is the difference between "new" and
 * "suspicious", and it costs nothing but getting the compiler input exactly
 * right.
 *
 * ── Exactly right meaning exactly ────────────────────────────────────────────
 * Verification recompiles the source and compares bytecode. Any difference in
 * optimizer runs, evmVersion, viaIR or even the set of source files produces
 * different output and a failed verification — so this rebuilds the SAME
 * standard-json input that tools/build-contract.js compiles, from the same
 * files, rather than describing the settings a second time and hoping the two
 * descriptions agree.
 *
 * ⚠️ Blockscout here sits behind Cloudflare and answers a default curl
 * User-Agent with a 403 challenge page. It is not blocking API use — a browser
 * UA gets a normal 200 — but a script that does not send one looks like it is
 * being refused for a completely different reason.
 */
"use strict";
const fs = require("fs");
const path = require("path");
const solc = require("solc");

const root = path.join(__dirname, "..");
const srcDir = path.join(root, "contracts");
const EXPLORER = process.env.RH_EXPLORER || "https://robinhoodchain.blockscout.com";
const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36";

/* The same input tools/build-contract.js compiles. Kept in one place on
 * purpose: two descriptions of the same settings drift, and the failure mode is
 * a verification that fails with no explanation of which field was wrong. */
function standardInput(name) {
  const file = name + ".sol";
  const source = fs.readFileSync(path.join(srcDir, file), "utf8");
  const sources = { [file]: { content: source } };
  const seen = new Set([file]);
  const queue = [source];
  while (queue.length) {
    const text = queue.pop();
    for (const m of text.matchAll(/import\s*(?:\{[^}]*\}\s*from\s*)?"\.\/([^"]+)"/g)) {
      const dep = m[1];
      if (seen.has(dep)) continue;
      seen.add(dep);
      const body = fs.readFileSync(path.join(srcDir, dep), "utf8");
      sources[dep] = { content: body };
      queue.push(body);
    }
  }
  return {
    language: "Solidity",
    sources,
    settings: {
      optimizer: { enabled: true, runs: 800 },
      viaIR: true,
      evmVersion: "paris",
      outputSelection: { "*": { "*": ["abi", "evm.bytecode.object"] } }
    }
  };
}

async function api(pathname, init) {
  const r = await fetch(EXPLORER + pathname, {
    ...init,
    headers: { "User-Agent": UA, ...(init && init.headers) },
    signal: AbortSignal.timeout(60000)
  });
  const text = await r.text();
  let json = null;
  try { json = JSON.parse(text); } catch (e) { /* html challenge or a 404 page */ }
  return { status: r.status, json, text };
}

async function status(address) {
  const r = await api("/api/v2/smart-contracts/" + address);
  if (!r.json) return { verified: false, note: "explorer returned no json (" + r.status + ")" };
  return {
    verified: !!r.json.is_verified,
    name: r.json.name || null,
    via: r.json.is_verified_via_sourcify ? "sourcify"
       : r.json.is_verified_via_eth_bytecode_db ? "bytecode-db" : null
  };
}

async function main() {
  const [name, address] = process.argv.slice(2);
  const wait = process.argv.includes("--wait");
  if (!name || !/^0x[0-9a-fA-F]{40}$/.test(address || "")) {
    console.error("usage: node tools/verify-contract.js <ContractName> <0xaddress> [--wait]");
    process.exit(1);
  }

  const before = await status(address);
  if (before.verified) {
    console.log(`  already verified as ${before.name}` + (before.via ? ` (via ${before.via})` : ""));
    return;
  }
  console.log(`  ${address} is not verified — submitting ${name}`);

  const input = standardInput(name);
  console.log(`  sources: ${Object.keys(input.sources).join(", ")}`);
  console.log(`  solc ${solc.version()} -> submitting as ` +
    `${/^v?(\d+\.\d+\.\d+\+commit\.[0-9a-f]+)/.exec(solc.version())[1]}`);
  console.log(`  optimizer ${input.settings.optimizer.runs} runs, ` +
    `viaIR ${input.settings.viaIR}, evm ${input.settings.evmVersion}`);

  const form = new FormData();
  /* ⚠️ Version, not build tag. solc-js reports
   * "0.8.28+commit.7893614a.Emscripten.clang", and the trailing platform is its
   * own build detail — the explorer knows compilers as "v0.8.28+commit.7893614a"
   * and silently fails to match anything else. The submission is still accepted
   * with a cheerful "verification started", so the only symptom is a contract
   * that never becomes verified and never says why. */
  const m = /^v?(\d+\.\d+\.\d+\+commit\.[0-9a-f]+)/.exec(solc.version());
  if (!m) throw new Error("cannot read a compiler version from " + solc.version());
  const compiler = "v" + m[1];
  form.append("compiler_version", compiler);
  form.append("contract_name", name);
  /* Let the explorer recover the constructor arguments from the creation
   * transaction. They are known to the chain and not to this script — a token
   * is deployed by the curve, not by us, so we do not have them to hand. */
  form.append("autodetect_constructor_args", "true");
  form.append("license_type", "mit");
  form.append("files[0]", new Blob([JSON.stringify(input)], { type: "application/json" }),
    name + ".json");

  const r = await api(
    "/api/v2/smart-contracts/" + address + "/verification/via/standard-input",
    { method: "POST", body: form });

  console.log(`  submitted -> ${r.status} ${JSON.stringify(r.json || r.text.slice(0, 200))}`);

  if (!wait) return;
  /* Verification is queued, so a 200 means "accepted", not "verified". Polling
   * is the only way to learn which. */
  for (let i = 0; i < 30; i++) {
    await new Promise((s) => setTimeout(s, 4000));
    const st = await status(address);
    if (st.verified) { console.log(`  ✅ verified as ${st.name}`); return; }
    process.stdout.write(`\r  waiting… ${(i + 1) * 4}s`);
  }
  console.log("\n  still not verified — check the explorer for the reason");
}

main().catch((e) => { console.error(e); process.exit(1); });
