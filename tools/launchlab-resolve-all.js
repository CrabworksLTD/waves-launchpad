#!/usr/bin/env node
/* Resolve EVERY enumerated LaunchLab quote mint (no filtering) via on-chain
 * metadata, so we can see the full universe — not just Backed xStocks and a
 * curated token list. Metaplex Token Metadata PDA for classic SPL; inline
 * Token-2022 TokenMetadata TLV for Token-2022 mints. Batched getMultipleAccounts. */
const { Connection, PublicKey } = require("@solana/web3.js");
const fs = require("fs");

const RPC = process.env.RPC || "https://api.mainnet-beta.solana.com";
const MPL = new PublicKey("metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s");
const TOKEN_2022 = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";

const rows = JSON.parse(fs.readFileSync("tools/launchlab-quotes.json", "utf8"));
const mints = rows.map((r) => r.mint);

function chunk(a, n) { const o = []; for (let i = 0; i < a.length; i += n) o.push(a.slice(i, i + n)); return o; }

function mplPda(mint) {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("metadata"), MPL.toBuffer(), new PublicKey(mint).toBuffer()], MPL)[0];
}
function decodeMpl(data) {
  // Metaplex Metadata: 1 key + 32 updateAuth + 32 mint = 65, then name(4+len), symbol(4+len)
  let p = 65;
  const nameLen = data.readUInt32LE(p); p += 4;
  const name = data.slice(p, p + nameLen).toString("utf8").replace(/\0+$/, "").trim(); p += nameLen;
  const symLen = data.readUInt32LE(p); p += 4;
  const symbol = data.slice(p, p + symLen).toString("utf8").replace(/\0+$/, "").trim();
  return { name, symbol };
}
function decodeT2022(data) {
  let o = 166;
  while (o + 4 <= data.length) {
    const type = data.readUInt16LE(o), len = data.readUInt16LE(o + 2), start = o + 4;
    if (type === 19) {
      let p = start + 64;
      const nl = data.readUInt32LE(p); p += 4; const name = data.slice(p, p + nl).toString("utf8"); p += nl;
      const sl = data.readUInt32LE(p); p += 4; const symbol = data.slice(p, p + sl).toString("utf8");
      return { name, symbol };
    }
    o = start + len;
  }
  return null;
}

(async () => {
  const conn = new Connection(RPC, "confirmed");
  const meta = {};

  // 1) mint accounts (owner → token program + decimals) and Token-2022 inline meta
  for (const batch of chunk(mints, 100)) {
    const infos = await conn.getMultipleAccountsInfo(batch.map((m) => new PublicKey(m)));
    infos.forEach((info, i) => {
      const m = batch[i];
      meta[m] = { mint: m, owner: info ? info.owner.toBase58() : null, decimals: info ? info.data[44] : null };
      if (info && info.owner.toBase58() === TOKEN_2022) {
        const d = decodeT2022(info.data);
        if (d) { meta[m].symbol = d.symbol.trim(); meta[m].name = d.name.trim(); }
      }
    });
  }

  // 2) Metaplex metadata for everything still unresolved
  const need = mints.filter((m) => !meta[m].symbol);
  for (const batch of chunk(need, 100)) {
    const pdas = batch.map(mplPda);
    const infos = await conn.getMultipleAccountsInfo(pdas);
    infos.forEach((info, i) => {
      if (!info) return;
      try { const d = decodeMpl(info.data); meta[batch[i]].symbol = d.symbol; meta[batch[i]].name = d.name; } catch (e) {}
    });
  }

  const out = Object.values(meta).map((m) => {
    const sym = m.symbol || "", name = m.name || "";
    const t2022 = m.owner === TOKEN_2022;
    const stocky = /x$/.test(sym) && (m.mint.startsWith("Xs") || /xstock|stock| x$/i.test(name));
    return { ...m, symbol: sym, name, t2022, stocky };
  });
  // buckets
  const stocks = out.filter((m) => m.stocky);
  const namedTokens = out.filter((m) => !m.stocky && m.symbol && !/pump$|bonk$/i.test(m.mint));
  const junk = out.filter((m) => !m.stocky && (!m.symbol || /pump$|bonk$/i.test(m.mint)));
  fs.writeFileSync("tools/launchlab-quotes-resolved.json", JSON.stringify(out, null, 2));

  const show = (arr) => arr.sort((a, b) => (a.symbol || "z").localeCompare(b.symbol || "z"))
    .forEach((m) => console.log("  " + (m.symbol || "?").padEnd(12), (m.decimals ?? "?") + "d",
      (m.t2022 ? "T22 " : "SPL "), (m.name || "").slice(0, 34).padEnd(34), m.mint));

  console.log("\n=== STOCK-LIKE (symbol ends x / xStock) — " + stocks.length + " ===");
  show(stocks);
  console.log("\n=== NAMED NON-STOCK TOKENS (not pump/bonk) — " + namedTokens.length + " ===");
  show(namedTokens);
  console.log("\n=== unnamed / pump / bonk (junk quotes) — " + junk.length + " ===");
  console.log("  (suppressed; see tools/launchlab-quotes-resolved.json)");
})().catch((e) => { console.error(e); process.exit(1); });
