/* Bundle entry for the Raydium LaunchLab client (Solana stock-quoted launches).
 *
 * Loaded only on the launch path when the chosen quote is a Token-2022 asset
 * (xStocks), which Meteora's DBC can't take. Separate from dbc.esm.js so the
 * Meteora path never pays for it.
 *
 * Named exports only — `export *` from raydium-sdk-v2 drags in hundreds of
 * CLMM/CPMM/farm symbols. This is exactly the surface launchlab.js uses.
 */
export {
  Raydium,
  TxVersion,
  // program ids
  LAUNCHPAD_PROGRAM,
  DEV_LAUNCHPAD_PROGRAM,
  LAUNCHPAD_AUTH,
  DEV_LAUNCHPAD_AUTH,
  // PDA derivations
  getPdaLaunchpadConfigId,
  getPdaLaunchpadPoolId,
  getPdaPlatformId,
  getPdaPlatformVault,
  getPdaLaunchpadVaultId,
  // CPMM config for the graduated pool (platform creation needs cpConfigId)
  getCpmmPdaAmmConfigId,
  CREATE_CPMM_POOL_PROGRAM,
  DEVNET_PROGRAM_ID,
  // account decoders
  LaunchpadConfig,
  LaunchpadPool,
  PlatformConfig,
  // curve math for on-curve quotes
  Curve,
  CurveCalculator,
} from "@raydium-io/raydium-sdk-v2";

/* BN for amounts / fee maxima — the launch + claim instructions type their
 * numeric args as BN. */
export { default as BN } from "bn.js";
