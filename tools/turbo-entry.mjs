/* Bundle entry for the Turbo (Arweave) client.
 *
 * HexSolanaSigner, not SolanaSigner — Turbo maps token:"solana" to
 * HexSolanaSigner in utils/common.js, and the name is misleading: it takes the
 * same base58 64-byte secret key, it just signs a hex-encoded message. Passing
 * the wrong one produces signatures Turbo's backend rejects.
 *
 * Moonpad's entry exported only EthereumSigner, which is why its vendored
 * bundle contains the Solana signers but does not expose them. */
export { TurboFactory, HexSolanaSigner, ArweaveSigner } from "@ardrive/turbo-sdk/web";
