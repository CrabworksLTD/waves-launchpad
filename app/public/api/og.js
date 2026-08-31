// GET /api/og?id=<address>&to=mint|token  ->  a 1200x630 PNG share card.
//
// The card social platforms show when a WAVES link is shared: the subject's
// art, name, and live launchpad stats. Both chains, one function — a 0x
// address is a Robinhood Chain drop (read via eth_call), a base58 address is
// a Solana candy machine or token (records for identity, chain SDKs for
// numbers). Ported from Moonpad's og.js, which paid for these lessons:
//
//  - a read that FAILED is not a read that returned ZERO — unread values stay
//    null and print as a dash, and a dashed card is cached for a minute, not
//    a day (X re-hosts whatever it fetches, permanently)
//  - images go in as data URIs with mime sniffed from magic bytes — a data
//    URI whose declared mime disagrees with its bytes renders as nothing
//  - satori needs <img> src/width/height as real props, not style

export const config = { runtime: "nodejs" };

// @vercel/og loads its harfbuzz wasm LAZILY, during the render stream —
// after any try/catch — resolving "./hb.wasm" against the process CWD.
// vercel.json includeFiles ships the file; chdir aims the lookup at it.
let IR = null;
async function getImageResponse() {
  if (IR) return IR;
  try {
    const { createRequire } = await import("node:module");
    const path = await import("node:path");
    const fs = await import("node:fs");
    const req = createRequire(import.meta.url);
    let dist;
    try { dist = path.dirname(req.resolve("@vercel/og/dist/index.node.js")); }
    catch (e) { dist = path.join(path.dirname(req.resolve("@vercel/og/package.json")), "dist"); }
    if (fs.existsSync(path.join(dist, "hb.wasm"))) process.chdir(dist);
  } catch (e) {}
  IR = (await import("@vercel/og")).ImageResponse;
  return IR;
}

const BG = "#0a0a0a";
const RH = { rpc: "https://rpc.mainnet.chain.robinhood.com", label: "ROBINHOOD",
  accent: "#CCFF00", stops: ["#CCFF00", "#D0F248", "#D5E691", "#D9D9D9"] };
const SOL = { rpc: "https://solana-rpc.publicnode.com", label: "SOLANA",
  accent: "#14F195", stops: ["#9945FF", "#6D7EDC", "#40B8B8", "#14F195"] };

// DBC configs a WAVES token can be priced against (mirrors brand.js — the
// server can't load browser globals). quote decimals resolve raised amounts.
const DBC_CONFIGS = [
  { key: "DdHWKSqE7gvKrCUvcAnEVT7R1YWKY2SknBYFLUKxxsCN", quote: "SOL", dec: 9 },
  { key: "9xHSsPYmRuJJtGA3TYB7Q5P2oHWy4zpeugTf9EZ1S491", quote: "USDC", dec: 6 },
  { key: "AWar1Y1GALnT3TjL3d4K1qjH2ZLB5KiqrSw3gmaR9EGA", quote: "GOLD", dec: 6 }
];

// selectors, from evm-contract.js — verified, not typed from memory
const SEL = {
  name: "06fdde03", symbol: "95d89b41", maxSupply: "d5abeb01", minted: "a2309ff8",
  price: "a035b1fe", owner: "8da5cb5b", contractURI: "e8a3d485", baseURI: "6c0360eb",
  tokenURI1: "c87b56dd" + "1".padStart(64, "0")
};

const DASH = "—";
const B58 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

async function ethCall(to, sel) {
  const r = await fetch(RH.rpc, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_call",
      params: [{ to, data: "0x" + sel }, "latest"] }),
    signal: AbortSignal.timeout(4000)
  }).then((x) => { if (!x.ok) throw new Error("rpc http " + x.status); return x.json(); });
  if (r && r.error) return null;
  return r && r.result && r.result !== "0x" ? r.result : null;
}

function decodeString(hex) {
  if (!hex) return "";
  const h = hex.replace(/^0x/, "");
  try {
    const len = parseInt(h.slice(64, 128), 16);
    const bytes = h.slice(128, 128 + len * 2);
    let s = "";
    for (let i = 0; i < bytes.length; i += 2) s += String.fromCharCode(parseInt(bytes.slice(i, i + 2), 16));
    return decodeURIComponent(escape(s));
  } catch (e) { return ""; }
}
const toInt = (hex) => (hex ? BigInt(hex) : 0n);
const short = (a) => (a ? a.slice(0, 6) + "…" + a.slice(-4) : "");
const arw = (u) => (u ? u.replace(/^ar:\/\//, "https://arweave.net/") : null);

async function toDataUri(url) {
  if (!url) return null;
  try {
    const r = await fetch(url, { redirect: "follow", signal: AbortSignal.timeout(6000) });
    if (!r.ok) return null;
    const buf = new Uint8Array(await r.arrayBuffer());
    let mime = "image/png";
    if (buf[0] === 0xFF && buf[1] === 0xD8) mime = "image/jpeg";
    else if (buf[0] === 0x89 && buf[1] === 0x50) mime = "image/png";
    else if (buf[0] === 0x47 && buf[1] === 0x49) mime = "image/gif";
    else if (buf[0] === 0x52 && buf[1] === 0x49 && buf[8] === 0x57) mime = "image/webp";
    let bin = "";
    for (let i = 0; i < buf.length; i += 8192) bin += String.fromCharCode.apply(null, buf.subarray(i, i + 8192));
    return "data:" + mime + ";base64," + btoa(bin);
  } catch (e) { return null; }
}

let FONTS = null;
async function loadFonts(origin) {
  if (FONTS) return FONTS;
  const grab = (f) => fetch(origin + "/fonts/" + f).then((r) => r.arrayBuffer());
  const [display, mono, monoSemi] = await Promise.all([
    grab("archivo-extrabold.ttf"), grab("ibm-plex-mono.ttf"), grab("ibm-plex-mono-semibold.ttf")
  ]);
  FONTS = [
    { name: "Display", data: display, weight: 800, style: "normal" },
    { name: "Mono", data: mono, weight: 400, style: "normal" },
    { name: "Mono", data: monoSemi, weight: 600, style: "normal" }
  ];
  return FONTS;
}

function h(type, style, children) { return { type, props: { style, children } }; }
const img = (src, w, hgt, style) => ({ type: "img", props: { src, width: w, height: hgt, style } });
function fmt(n) { return Number(n).toLocaleString("en-US"); }
const fmtOr = (n) => (n === null || n === undefined ? DASH : fmt(n));

async function records(origin, kind) {
  try {
    const j = await fetch(origin + "/api/" + kind, { signal: AbortSignal.timeout(4000) })
      .then((r) => r.json());
    return (kind === "tokens" ? j.tokens : j.collections) || [];
  } catch (e) { return []; }
}

export default async function handler(req) {
  try { return await render(req); }
  catch (e) {
    return new Response("og error: " + (e && e.stack ? e.stack : String(e)),
      { status: 500, headers: { "content-type": "text/plain" } });
  }
}

async function render(req) {
  const url = new URL(req.url);
  const origin = url.origin;

  if (url.searchParams.get("test")) {
    const f = await fetch(origin + "/fonts/archivo-extrabold.ttf").then((r) => r.arrayBuffer());
    const ImageResponse = await getImageResponse();
    return new ImageResponse(
      h("div", { width: "1200px", height: "630px", display: "flex", alignItems: "center",
        justifyContent: "center", backgroundColor: BG, color: SOL.accent,
        fontFamily: "Display", fontSize: 80 }, "WAVES TEST"),
      { width: 1200, height: 630, fonts: [{ name: "Display", data: f, weight: 700, style: "normal" }] });
  }

  // ?demo=token|mint — the card layouts with representative data, so the
  // design can be reviewed before anything has launched
  const demo = url.searchParams.get("demo");
  if (demo) {
    const fonts = await loadFonts(origin);
    const rh = url.searchParams.get("rh");
    return respond(buildCard(demo === "token" ? {
      accent: rh ? RH.accent : SOL.accent,
      stops: (rh ? RH : SOL).stops,
      name: "$WAVE · First Wave",
      chips: (rh ? RH.label : SOL.label) + "  ·  BONDING CURVE",
      avatarUri: null, bannerUri: null,
      stats: [["RAISED", "12.4 / 85 SOL"], ["CURVE", "14.6%"], ["CHAIN", rh ? "Robinhood" : "Solana"]]
    } : {
      accent: rh ? RH.accent : SOL.accent,
      stops: (rh ? RH : SOL).stops,
      name: "Tide Runners",
      chips: (rh ? RH.label : SOL.label) + "  ·  3,333 ITEMS  ·  METAPLEX CORE",
      avatarUri: null, bannerUri: null,
      stats: [["ITEMS", "3,333"], ["MINTED", "1,204 / 3,333"], ["PRICE", "0.1 SOL"],
        ["CHAIN", rh ? "Robinhood" : "Solana"]]
    }), fonts, true);
  }

  const id = url.searchParams.get("id") || "";
  const to = url.searchParams.get("to") === "token" ? "token" : "mint";

  if (/^0x[0-9a-fA-F]{40}$/.test(id)) return evmCard(origin, id.toLowerCase());
  if (B58.test(id)) {
    return to === "token" ? solTokenCard(origin, id) : solMintCard(origin, id);
  }
  return new Response("bad id", { status: 400 });
}

// -------------------------------------------------- the card, one layout
function buildCard(o) {
  // o: { accent, chainLabel, name, chips, avatarUri, bannerUri, stats: [[l,v]..] }
  const stat = (label, value) => h("div",
    { display: "flex", flexDirection: "column", marginRight: 64 }, [
      h("div", { fontFamily: "Mono", fontSize: 20, letterSpacing: 1,
        color: "rgba(255,255,255,.45)", marginBottom: 6 }, label),
      h("div", { fontFamily: "Mono", fontWeight: 600, fontSize: 34, color: "#fff" }, value)
    ]);

  // no banner: the WAVES staircase fills the corner exactly as it does on the
  // brand share card — bottom-left flush, climbing off the top edge — in the
  // chain's colours, dimmed under the same scrim a banner would get
  const S = 210;
  const st = o.stops || [];
  const mark = [[0, 630 - S, 0], [S, 630 - 2 * S, 1], [2 * S, 0, 2]]
    .map((p) => h("div", { position: "absolute", left: p[0], top: p[1],
      width: S, height: S, display: "flex",
      backgroundImage: "linear-gradient(45deg, " + st[p[2]] + " 0%, " + st[p[2] + 1] + " 100%)" }, null));

  return h("div", {
    width: "1200px", height: "630px", display: "flex", flexDirection: "column",
    justifyContent: "flex-end", position: "relative", backgroundColor: BG,
    color: "#fff", fontFamily: "Mono"
  }, [
    o.bannerUri ? img(o.bannerUri, 1200, 630,
      { position: "absolute", top: 0, left: 0, objectFit: "cover", objectPosition: "center" }) : null,
    ...(o.bannerUri ? [] : mark),
    h("div", { position: "absolute", top: 0, left: 0, width: "1200px", height: "630px", display: "flex",
      backgroundImage: o.bannerUri
        ? "linear-gradient(180deg, rgba(10,10,10,.25) 0%, rgba(10,10,10,.55) 52%, rgba(10,10,10,.96) 100%)"
        : "linear-gradient(180deg, rgba(10,10,10,.35) 0%, rgba(10,10,10,.66) 52%, rgba(10,10,10,.94) 100%)" }, null),
    h("div", { position: "absolute", top: 44, right: 56, display: "flex", fontFamily: "Display",
      fontSize: 30, letterSpacing: 2, color: o.accent }, "WAVES"),
    h("div", { display: "flex", flexDirection: "column", padding: "0 56px 52px 56px", zIndex: 1 }, [
      h("div", { display: "flex", alignItems: "flex-end", marginBottom: 34 }, [
        o.avatarUri
          ? img(o.avatarUri, 176, 176,
              { borderRadius: 22, border: "3px solid " + o.accent, marginRight: 30, objectFit: "cover" })
          : h("div", { width: 176, height: 176, borderRadius: 22, border: "3px solid " + o.accent,
              marginRight: 30, backgroundColor: "#191c21", display: "flex", alignItems: "center",
              justifyContent: "center", fontFamily: "Display", fontSize: 84,
              color: "rgba(255,255,255,.85)" }, (o.name || "?").slice(0, 1).toUpperCase()),
        h("div", { display: "flex", flexDirection: "column" }, [
          h("div", { fontFamily: "Display", fontSize: 72, lineHeight: 1, color: "#fff",
            marginBottom: 16 }, (o.name || "").slice(0, 26)),
          h("div", { display: "flex", fontFamily: "Mono", fontSize: 22, letterSpacing: 1,
            color: "rgba(255,255,255,.62)" }, o.chips)
        ])
      ]),
      h("div", { display: "flex", flexDirection: "row" },
        o.stats.map((s) => stat(s[0], s[1])))
    ])
  ].filter(Boolean));
}

async function respond(card, fonts, degraded) {
  const ImageResponse = await getImageResponse();
  return new ImageResponse(card, {
    width: 1200, height: 630, fonts,
    headers: {
      // no `no-transform`: X re-encodes OG images onto its CDN and forbidding
      // that breaks the unfurl entirely (Moonpad found out the hard way)
      "cache-control": degraded
        ? "public, max-age=60, s-maxage=60"
        : "public, max-age=300, s-maxage=86400, stale-while-revalidate=604800"
    }
  });
}

// -------------------------------------------------- Robinhood Chain drop
async function evmCard(origin, c) {
  let failed = false;
  const read = (sel) => ethCall(c, sel).catch(() => { failed = true; return null; });

  const [nameHex, supHex, mintHex, priceHex, symHex, ownerHex, cuHex] = await Promise.all([
    read(SEL.name), read(SEL.maxSupply), read(SEL.minted), read(SEL.price),
    read(SEL.symbol), read(SEL.owner), read(SEL.contractURI)
  ]);

  const name = decodeString(nameHex) || "Collection";
  const supply = supHex === null ? null : Number(toInt(supHex));
  const minted = mintHex === null ? null : Number(toInt(mintHex));
  const price = priceHex === null ? null : toInt(priceHex);
  const owner = ownerHex ? "0x" + ownerHex.slice(-40) : "";

  let metaImage = null, metaBanner = null;
  const cu = decodeString(cuHex);
  if (cu) {
    try {
      const meta = await fetch(arw(cu), { signal: AbortSignal.timeout(5000) }).then((r) => r.json());
      metaImage = meta && meta.image;
      metaBanner = meta && meta.banner_image_url;
    } catch (e) {}
  }
  if (!metaImage) {
    // no contract-level metadata: token #1's image stands in
    try {
      const uri = decodeString(await read(SEL.baseURI));
      if (uri) {
        const meta = await fetch(arw(uri) + "1.json", { signal: AbortSignal.timeout(5000) })
          .then((r) => r.json());
        metaImage = meta && meta.image;
      }
    } catch (e) {}
  }
  const [avatarUri, bannerUri] = await Promise.all([
    toDataUri(arw(metaImage)), toDataUri(arw(metaBanner))
  ]);

  const priceTxt = price === null ? DASH
    : price === 0n ? "Free"
    : (Number(price) / 1e18).toString().slice(0, 8) + " ETH";

  const fonts = await loadFonts(origin);
  return respond(buildCard({
    accent: RH.accent, stops: RH.stops, name,
    chips: ("BY " + short(owner) + "  ·  " + RH.label + "  ·  " +
      fmtOr(supply) + " ITEMS").toUpperCase(),
    avatarUri, bannerUri,
    stats: [
      ["ITEMS", fmtOr(supply)],
      ["MINTED", fmtOr(minted) + " / " + fmtOr(supply)],
      ["PRICE", priceTxt],
      ["CHAIN", "Robinhood"]
    ]
  }), fonts, failed);
}

// -------------------------------------------------- Solana collection
async function solMintCard(origin, cm) {
  let failed = false;
  const recs = await records(origin, "collections");
  const rec = recs.find((r) => r.candyMachine === cm) || {};

  let minted = null, supply = null;
  try {
    // the SDK reads live in /api/solstats (node runtime) — this render runs
    // on the edge, where @vercel/og's wasm actually loads
    const st = await fetch(origin + "/api/solstats?cm=" + cm,
      { signal: AbortSignal.timeout(6000) }).then((r) => r.json());
    if (st.failed) failed = true;
    minted = st.minted; supply = st.supply;
  } catch (e) { failed = true; }

  // the launch pins _collection.json next to the avatar — the banner uploaded
  // in the launch window lives there and fills the card background
  let banner = null, avatar = rec.avatar || null;
  if (rec.avatar) {
    try {
      const dir = rec.avatar.replace(/[^/]*$/, "");
      const col = await fetch(dir + "_collection.json",
        { signal: AbortSignal.timeout(5000) }).then((r) => (r.ok ? r.json() : null));
      if (col && col.banner) banner = col.banner;
      if (col && col.image && !avatar) avatar = col.image;
    } catch (e) {}
  }
  const [avatarUri, bannerUri] = await Promise.all([
    toDataUri(arw(avatar)), toDataUri(arw(banner))
  ]);
  const fonts = await loadFonts(origin);
  return respond(buildCard({
    accent: SOL.accent, stops: SOL.stops,
    name: rec.name || "Collection",
    chips: (SOL.label + "  ·  " + fmtOr(supply) + " ITEMS  ·  METAPLEX CORE").toUpperCase(),
    avatarUri, bannerUri,
    stats: [
      ["ITEMS", fmtOr(supply)],
      ["MINTED", fmtOr(minted) + " / " + fmtOr(supply)],
      ["CHAIN", "Solana"]
    ]
  }), fonts, failed);
}

// -------------------------------------------------- Solana token
async function solTokenCard(origin, mint) {
  let failed = false;
  const recs = await records(origin, "tokens");
  const rec = recs.find((r) => r.mint === mint) || {};

  let raised = null, threshold = null, quote = rec.quote || "SOL", migrated = false;
  try {
    const q = "mint=" + mint + (rec.pool ? "&pool=" + rec.pool : "") +
      (rec.config ? "&config=" + rec.config : "");
    const st = await fetch(origin + "/api/solstats?" + q,
      { signal: AbortSignal.timeout(8000) }).then((r) => r.json());
    if (st.failed) failed = true;
    raised = st.raised; threshold = st.threshold;
    if (st.quote) quote = st.quote;
    migrated = !!st.migrated;
  } catch (e) { failed = true; }

  const sym = (rec.symbol || "").toUpperCase();
  const pct = raised !== null && threshold ? Math.min(100, raised / threshold * 100) : null;
  const avatarUri = await toDataUri(arw(rec.icon));
  const fonts = await loadFonts(origin);
  return respond(buildCard({
    accent: SOL.accent, stops: SOL.stops,
    name: (sym ? "$" + sym : "") + (rec.name ? (sym ? " · " : "") + rec.name : "") || "Token",
    chips: (SOL.label + "  ·  BONDING CURVE" +
      (migrated ? "  ·  GRADUATED" : "")).toUpperCase(),
    avatarUri, bannerUri: await toDataUri(arw(rec.banner)),
    stats: [
      ["RAISED", raised === null ? DASH
        : raised.toFixed(2).replace(/\.00$/, "") + " / " +
          (threshold === null ? DASH : fmt(threshold)) + " " + quote],
      ["CURVE", migrated ? "Graduated" : pct === null ? DASH : pct.toFixed(1) + "%"],
      ["CHAIN", "Solana"]
    ]
  }), fonts, failed);
}
