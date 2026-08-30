/* Bundle entry for the Metaplex client.
 *
 * Built once into app/public/vendor/metaplex.esm.js and loaded lazily by the
 * launch and mint pages. Same pattern as vendor/turbo.esm.js: the runtime
 * stays dependency-free and there is no build step in the normal edit loop.
 *
 *   node tools/build-metaplex.js
 *
 * Re-export explicitly rather than `export *`. A wildcard drags in every
 * instruction builder in both programs, and the difference is megabytes on a
 * file the mint page has to download before anyone can buy anything. */

export {
  createUmi,
} from "@metaplex-foundation/umi-bundle-defaults";

export {
  generateSigner,
  publicKey,
  signerIdentity,
  createNoopSigner,
  sol,
  lamports,
  some,
  none,
  dateTime,
  transactionBuilder,
  publicKeyBytes,
  base58,
} from "@metaplex-foundation/umi";

export {
  mplCore,
  createCollection,
  create as createAsset,
  fetchCollection,
  fetchAsset,
  ruleSet,
} from "@metaplex-foundation/mpl-core";

export {
  mplCandyMachine,
  create as createCandyMachine,
  addConfigLines,
  fetchCandyMachine,
  fetchCandyGuard,
  mintV1,
  updateCandyGuard,
  deleteCandyMachine,
} from "@metaplex-foundation/mpl-core-candy-machine";

export {
  setComputeUnitLimit,
  setComputeUnitPrice,
  transferSol,
} from "@metaplex-foundation/mpl-toolbox";

/* Bridges our wallet layer into umi. walletAdapterIdentity wants a
   wallet-adapter shaped object, so wallet.js is adapted to that shape in
   launch.js rather than umi being adapted to ours — this is the interface with
   the most eyes on it. PublicKey and VersionedTransaction come along because
   the injected-provider path signs transaction objects, not bytes. */
export { walletAdapterIdentity } from "@metaplex-foundation/umi-signer-wallet-adapters";
export { PublicKey, VersionedTransaction } from "@solana/web3.js";
export { percentAmount, createSignerFromKeypair } from "@metaplex-foundation/umi";
