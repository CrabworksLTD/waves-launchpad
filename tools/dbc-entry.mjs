/* Bundle entry for Meteora's Dynamic Bonding Curve client.
 *
 * Separate from metaplex.esm.js on purpose: the editor and the mint page never
 * touch this, and it is only loaded on the token-launch path. Bundling it into
 * the Metaplex file would make every page pay for it.
 *
 * Named exports only — `export *` drags in 268 symbols including every derive
 * helper and constant in the SDK. */
export {
  DynamicBondingCurveClient,
  DYNAMIC_BONDING_CURVE_PROGRAM_ID,
  buildCurveWithMarketCap,
  buildCurve,
  convertToLamports,
  bpsToFeeNumerator,
  feeNumeratorToBps,
  ActivationType,
  BaseFeeMode,
  CollectFeeMode,
  TokenDecimal,
  MigrationOption,
  MigrationFeeOption,
  TokenType,
  TokenAuthorityOption,
} from "@meteora-ag/dynamic-bonding-curve-sdk";

/* BN for fee-claim maxima — the claim instructions type their limits as BN and
 * reject null; u64::MAX as a BN is how "claim everything" is spelled. */
export { default as BN } from "bn.js";
