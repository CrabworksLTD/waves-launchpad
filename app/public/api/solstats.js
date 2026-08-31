// GET /api/solstats?cm=<machine>   -> { minted, supply }
// GET /api/solstats?mint=<mint>&pool=<pool>&config=<key> -> { raised, threshold, quote, migrated }
//
// The node-side chain reads behind /api/og. The card renders on the edge
// runtime (where @vercel/og's wasm actually loads); the Solana SDKs need
// node, so they live here and answer in JSON. Failures answer nulls — the
// card prints dashes and shortens its cache, it never 500s an unfurl.

const RPC = "https://solana-rpc.publicnode.com";

const DBC_CONFIGS = [
  { key: "DdHWKSqE7gvKrCUvcAnEVT7R1YWKY2SknBYFLUKxxsCN", quote: "SOL", dec: 9 },
  { key: "9xHSsPYmRuJJtGA3TYB7Q5P2oHWy4zpeugTf9EZ1S491", quote: "USDC", dec: 6 },
  { key: "AWar1Y1GALnT3TjL3d4K1qjH2ZLB5KiqrSw3gmaR9EGA", quote: "GOLD", dec: 6 }
];

export default async function handler(req, res) {
  res.setHeader("cache-control", "public, s-maxage=60, stale-while-revalidate=300");
  const cm = req.query.cm;
  const mint = req.query.mint;

  if (cm) {
    try {
      const { createUmi } = await import("@metaplex-foundation/umi-bundle-defaults");
      const { mplCandyMachine, fetchCandyMachine } =
        await import("@metaplex-foundation/mpl-core-candy-machine");
      const { publicKey } = await import("@metaplex-foundation/umi");
      const umi = createUmi(RPC, { commitment: "confirmed" }).use(mplCandyMachine());
      const m = await fetchCandyMachine(umi, publicKey(cm));
      return res.status(200).json({
        minted: Number(m.itemsRedeemed), supply: Number(m.data.itemsAvailable)
      });
    } catch (e) {
      return res.status(200).json({ minted: null, supply: null, failed: true });
    }
  }

  if (mint) {
    try {
      const w3 = await import("@solana/web3.js");
      const M = await import("@meteora-ag/dynamic-bonding-curve-sdk");
      const conn = new w3.Connection(RPC, "confirmed");
      const cli = new M.DynamicBondingCurveClient(conn, "confirmed");
      const poolPk = req.query.pool ? new w3.PublicKey(req.query.pool) : null;
      if (!poolPk) return res.status(200).json({ raised: null, failed: true });
      const pool = await cli.state.getPool(poolPk);
      const st = (pool && (pool.account || pool)) || null;
      const ps = st && (st.poolState || st);
      if (!ps) return res.status(200).json({ raised: null, failed: true });
      const cfg = DBC_CONFIGS.find((c) => c.key === String(req.query.config || ps.config)) ||
        DBC_CONFIGS[0];
      const raised = Number(BigInt(ps.quoteReserve.toString())) / Math.pow(10, cfg.dec);
      const migrated = Number(ps.isMigrated || 0) === 1;
      let threshold = null;
      const conf = await cli.state.getPoolConfig(ps.config);
      const cs = (conf && (conf.account || conf)) || null;
      if (cs && cs.migrationQuoteThreshold) {
        threshold = Number(BigInt(cs.migrationQuoteThreshold.toString())) / Math.pow(10, cfg.dec);
      }
      return res.status(200).json({ raised, threshold, quote: cfg.quote, migrated });
    } catch (e) {
      return res.status(200).json({ raised: null, failed: true });
    }
  }

  return res.status(400).json({ error: "cm or mint" });
}
