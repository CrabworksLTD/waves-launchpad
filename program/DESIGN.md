# WAVES burn-to-stake — design notes

One custom program in the whole product. Everything else is Metaplex Core,
Core Candy Machine and Meteora DBC.

## Invariants the audit must hold us to
1. **No loops over holders.** Distribution is the accumulator:
   `acc_per_weight += deposit * 1e12 / total_weight`; a position's claim is
   `weight * acc / 1e12 - debt`. O(1) for any holder count.
2. **The burn is the stake.** No unstake instruction exists. No vault ever
   holds a user's NFT or unburned tokens.
3. **Tier travels with the asset.** Position PDA is seeded on the Core asset;
   claim/stake verify the SIGNER currently owns the asset (byte-level Core
   AssetV1 check: key tag, owner, UpdateAuthority::Collection == pool's).
4. **vault_last accounting.** `sync` distributes only balance deltas; `claim`
   decrements vault_last by what it paid. Deposits during zero-weight periods
   roll forward, never burn.

## Deliberately out of scope (keeper's job, off-chain)
- Converting creator fees to the reward asset (Jupiter swap on a schedule —
  xStocks liquidity thins outside market hours).
- Calling `claimCreatorTradingFeeToReceiver` with the vault as receiver.

## Open audit questions (marked AUDIT: in lib.rs)
- Core account layout pinning across mpl-core versions; burned/frozen assets;
  regrouped assets; plugin delegates.
- Zero-weight deposit griefing via dust.
- pending_credit path (stake settles to credit, claim pays) — double-claim
  and rounding-dust analysis. Rounding truncates toward the pool by design.

## Status
- 2026-08-31: full first implementation written. NOT compiled — no Rust or
  Anchor toolchain on this machine yet. Next: install rustup + solana + avm,
  `anchor build`, write the localnet test suite (stake/sync/claim happy path,
  sold-NFT claim handoff, zero-weight deposits, overflow bounds), then audit.
