// POST /api/mint-sig  { chainId, collection, minter }  ->  { sig, deadline }
//
// The blessing mintSigned() checks during the allowlist window. Eligibility is
// recomputed HERE from the chain and the pinned list — never taken from the
// page's word, or a bot would simply ask nicely. The page's wave ladder is the
// UX; this is the enforcement.
//
// Ported from Moonpad's gate signer. Two WAVES differences:
//   - No on-chain registry to gate which collections we'll sign for. It is safe
//     to drop: baseURI is fetched only over ar:// / ipfs:// (no arbitrary-host
//     SSRF), and a signature is only USABLE on a collection whose on-chain
//     gateSigner equals ours — a stranger's collection carries a different
//     signer, so signing for it helps no one and steals nothing.
//   - The signer key is WAVES's own MINT_SIGNER_KEY; its address is baked into
//     each gated launch as `gateSigner` (see evm-chains MOONPAD_MINT_SIGNER).

const RPCS = {
  4663: "https://rpc.mainnet.chain.robinhood.com"
};
const SALE_TOGGLED = "0x37ae8f893f8baa4aef207505c0e4d730119d73dc1363bbee6fda5f5d52c3cf17";
const DEADLINE = 600;                    // seconds a blessing stays valid

// A decimal string of whole/fractional tokens -> integer base units, exactly,
// with no floating point. "100,000" and "100000.0" both land on 100000 * 10^d.
function toBaseUnits(v, d) {
  const s = String(v == null ? "" : v).replace(/,/g, "").trim();
  if (!/^\d+(\.\d+)?$/.test(s)) throw new Error("bad allowlist threshold: " + v);
  const [ip, fp = ""] = s.split(".");
  const frac = (fp + "0".repeat(d)).slice(0, d);
  return BigInt((ip || "0") + frac);
}

const cache = {};

async function rpc(url, method, params) {
  const r = await fetch(url, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params })
  }).then((x) => x.json());
  if (r.error) throw new Error(r.error.message);
  return r.result;
}
const call = (url, to, data, block) => rpc(url, "eth_call", [{ to, data }, block || "latest"]);

function decodeString(hex) {
  const h = (hex || "").replace(/^0x/, "");
  const len = parseInt(h.slice(64, 128), 16);
  let out = "";
  for (let i = 128; i < 128 + len * 2; i += 2) out += String.fromCharCode(parseInt(h.substr(i, 2), 16));
  return out;
}

async function facts(url, collection) {
  const k = collection.toLowerCase();
  if (cache[k]) return cache[k];

  const baseUri = decodeString(await call(url, collection, "0x6c0360eb")).trim(); // baseURI()
  if (!baseUri) throw new Error("collection has no baseURI");
  let list = null;
  const arMatch = baseUri.match(/^(?:ar:\/\/|https:\/\/arweave\.net\/)([^/]+)/);
  if (arMatch) {
    const manifestId = arMatch[1];
    // A fresh bundle 404s on arweave.net (which then caches the 404), and the
    // gateways' manifest path index lags behind the data items — so the direct
    // `<manifest>/_allowlist.json` path can miss while the item is servable by
    // its own id. Try several gateways, path route first, then resolve the file
    // to its data-item id through the manifest. (Same strategy as /api/meta.)
    const GW = ["https://arweave.net", "https://ar-io.dev", "https://permagate.io", "https://vilenarios.com"];
    const grab = (u) => fetch(u).then((r) => (r.ok ? r.json() : null)).catch(() => null);
    for (const gw of GW) {
      list = await grab(gw + "/" + manifestId + "/_allowlist.json");
      if (list) break;
      const mani = await grab(gw + "/raw/" + manifestId);
      const entry = mani && mani.paths && mani.paths["_allowlist.json"];
      if (entry && entry.id) {
        for (const g2 of GW) {
          list = await grab(g2 + "/" + entry.id);
          if (list) break;
        }
      }
      if (list) break;
    }
  } else if (baseUri.indexOf("ipfs://") === 0) {
    const http = "https://gateway.pinata.cloud/ipfs/" + baseUri.slice(7);
    list = await fetch(http + "_allowlist.json").then((r) => r.ok ? r.json() : null);
  } else {
    throw new Error("unsupported baseURI scheme");
  }
  if (!list || !list.phases || !list.phases.length) throw new Error("no allowlist on this collection");

  // Sale-open time straight from the contract's openedAt() view, NOT a
  // SaleToggled event scan. A drop that opens at deploy (openAtDeploy) sets
  // openedAt() in the constructor without emitting the event, so the scan found
  // nothing and the whole gate read as "sale has not opened" — which broke both
  // enforcement and the wave-ladder display. openedAt() is authoritative in
  // both the deploy-open and setSaleOpen paths.
  const t0 = parseInt((await call(url, collection, "0x38930203")) || "0x0", 16); // openedAt()
  if (!t0) throw new Error("the sale has not opened");

  cache[k] = {
    wm: parseInt(list.waveMinutes, 10) || 0,
    phases: list.phases,
    t0: t0
  };
  return cache[k];
}

// The earliest wave this wallet qualifies for. Balances are read at the current
// block: Robinhood's public nodes refuse historical/indexed reads, so a
// snapshot-block read would fail closed on every request. Current-holdings
// gating is what the launchpads on this chain do in practice.
async function waveOf(url, f, minter) {
  const me = minter.toLowerCase();
  const bal = async (token) => {
    const data = "0x70a08231" + me.replace(/^0x/, "").padStart(64, "0");
    return BigInt(await call(url, token, data) || "0x0");
  };
  for (let i = 0; i < f.phases.length; i++) {
    const p = f.phases[i];
    if (p.kind === "wallets") {
      if ((p.addresses || []).indexOf(me) > -1) return i;
    } else if (p.kind === "coin") {
      if (await bal(p.address) >= toBaseUnits(p.min, p.decimals || 18)) return i;
    } else if (p.kind === "nft") {
      // whole NFTs held; a bare integer, no decimals
      if (await bal(p.address) >= toBaseUnits(String(p.min).split(".")[0], 0)) return i;
    } else {
      throw new Error("unknown allowlist kind: " + p.kind);
    }
  }
  return null;
}

export default async function handler(req, res) {
  /* ?whoami — the signer ADDRESS derived from MINT_SIGNER_KEY (public, no key
   * leaked). Lets the launcher confirm it matches the gateSigner baked into
   * gated collections; a mismatch would revert every gated mint. */
  if (req.query && req.query.whoami !== undefined) {
    const kh = (process.env.MINT_SIGNER_KEY || "").trim().replace(/^0x/, "");
    if (!kh) return res.status(200).json({ ok: false, error: "MINT_SIGNER_KEY not set" });
    try {
      const { secp256k1 } = await import("ethereum-cryptography/secp256k1.js");
      const { keccak256 } = await import("ethereum-cryptography/keccak.js");
      const pub = secp256k1.getPublicKey(Buffer.from(kh, "hex"), false).slice(1); // drop 0x04
      const addr = "0x" + Buffer.from(keccak256(pub)).slice(-20).toString("hex");
      return res.status(200).json({ ok: true, signer: addr });
    } catch (e) { return res.status(200).json({ ok: false, error: String(e && e.message || e).slice(0, 120) }); }
  }
  /* ?facts — the wave ladder for the mint page to DISPLAY (names, kinds, per-
   * wave open times). Read-only and cheap; the POST path is what actually
   * enforces eligibility. If `minter` is given, also returns which wave that
   * wallet qualifies for (wave index, or -1 once public is open). */
  if (req.query && req.query.facts !== undefined) {
    const url = RPCS[parseInt(req.query.chainId, 10)];
    const collection = String(req.query.collection || "");
    if (!url || !/^0x[a-fA-F0-9]{40}$/.test(collection)) {
      return res.status(200).json({ error: "bad chain/collection" });
    }
    try {
      const f = await facts(url, collection);
      const now = Math.floor(Date.now() / 1000);
      const publicAt = f.t0 + f.phases.length * f.wm * 60;
      const phases = f.phases.map((p, i) => ({
        label: p.label, name: p.name || null, kind: p.kind,
        openAt: f.t0 + i * f.wm * 60,
        min: p.min != null ? String(p.min) : null,
        address: p.address || null
      }));
      const out = { waveMinutes: f.wm, t0: f.t0, publicAt, phases };
      const minter = String(req.query.minter || "");
      if (/^0x[a-fA-F0-9]{40}$/.test(minter)) {
        out.wave = now >= publicAt ? -1 : await waveOf(url, f, minter);
      }
      return res.status(200).json(out);
    } catch (e) {
      return res.status(200).json({ error: String(e && e.message ? e.message : e).slice(0, 200) });
    }
  }
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "POST only" });
  }
  const keyHex = (process.env.MINT_SIGNER_KEY || "").trim().replace(/^0x/, "");
  if (!keyHex) return res.status(500).json({ error: "MINT_SIGNER_KEY is not set" });

  const body = typeof req.body === "string" ? JSON.parse(req.body || "{}") : (req.body || {});
  const { chainId, collection, minter } = body;
  const url = RPCS[parseInt(chainId, 10)];
  if (!url) return res.status(400).json({ error: "Unknown chain" });
  if (!/^0x[a-fA-F0-9]{40}$/.test(collection || "") || !/^0x[a-fA-F0-9]{40}$/.test(minter || "")) {
    return res.status(400).json({ error: "Bad addresses" });
  }

  try {
    const f = await facts(url, collection);
    const now = Math.floor(Date.now() / 1000);
    const publicAt = f.t0 + f.phases.length * f.wm * 60;

    let opensAt;
    if (now >= publicAt) {
      opensAt = 0;                        // ladder done; sign for anyone (clock skew)
    } else {
      const wave = await waveOf(url, f, minter);
      if (wave === null) {
        return res.status(403).json({
          error: "Not on the allowlist. Public opens at " + publicAt + ".", publicAt
        });
      }
      opensAt = f.t0 + wave * f.wm * 60;
      if (now < opensAt) {
        return res.status(403).json({ error: "Your wave has not opened yet.", opensAt });
      }
    }

    const { keccak256 } = await import("ethereum-cryptography/keccak.js");
    const { secp256k1 } = await import("ethereum-cryptography/secp256k1.js");

    const deadline = now + DEADLINE;
    // The permit the contract's mintSigned() verifies: keccak(collection|minter|
    // deadline), wrapped as an eth-signed message, recovered against gateSigner.
    const pack = Buffer.concat([
      Buffer.from(collection.slice(2).padStart(40, "0"), "hex"),
      Buffer.from(minter.slice(2).padStart(40, "0"), "hex"),
      Buffer.from(deadline.toString(16).padStart(64, "0"), "hex")
    ]);
    const inner = keccak256(pack);
    const digest = keccak256(Buffer.concat([
      Buffer.from("\x19Ethereum Signed Message:\n32", "utf8"),
      Buffer.from(inner)
    ]));
    const s = secp256k1.sign(digest, Buffer.from(keyHex, "hex"));
    const sig = "0x" + s.r.toString(16).padStart(64, "0") +
                s.s.toString(16).padStart(64, "0") +
                (s.recovery + 27).toString(16).padStart(2, "0");

    return res.status(200).json({ sig, deadline });
  } catch (e) {
    return res.status(502).json({ error: String(e && e.message ? e.message : e).slice(0, 300) });
  }
}
