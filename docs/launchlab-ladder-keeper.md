# LaunchLab fee ladder + keeper — build plan

The one remaining WAVES project. It unlocks two things at once: the **creator fee
ladder** (1.15 / 2 / 3 / 4 / 5 / 10%) and **holder-reward auto-distribution**
(dividend / buyback / split). Both need the same keeper, and it moves real money,
so it ships only after an audit.

## Why a keeper is required

LaunchLab caps the creator's on-chain fee at **0.5%** (`creatorFeeRate ≤ 5000`;
5001 reverts `6014 InvalidPlatformInfo`). So a higher tier can't route more to the
creator on-chain — the excess accrues to the **platform** wallet, and the keeper
forwards the creator's share back. This is exactly the Meteora model, on LaunchLab's
claim API.

## Economics (proposed — mirrors the Meteora ladder)

Total fee = `0.25% Raydium (global config) + feeRate (platform) + 0.50% creator (cap)`.
WAVES keeps `wavesKeepBps` of each trade; the keeper forwards the rest of the
platform fee to the creator.

| Tier | Total | Raydium | Platform feeRate | Creator on-chain | WAVES keeps | Creator total (after forward) |
|------|-------|---------|------------------|------------------|-------------|-------------------------------|
| std  | 1.15% | 0.25%   | 0.40% (4000)     | 0.50%            | 0.40%       | 0.50% (no forward)            |
| t2   | 2%    | 0.25%   | 1.25% (12500)    | 0.50%            | 0.50%       | 1.25%                         |
| t3   | 3%    | 0.25%   | 2.25% (22500)    | 0.50%            | 0.60%       | 2.15%                         |
| t4   | 4%    | 0.25%   | 3.25% (32500)    | 0.50%            | 0.70%       | 3.05%                         |
| t5   | 5%    | 0.25%   | 4.25% (42500)    | 0.50%            | 0.80%       | 3.95%                         |

> **Cap:** the program limits platform `feeRate` to ~5% (`50000` OK, `60000`
> reverts `Custom:6002`), so the ladder tops out at **5% total** — a 10% tier is
> impossible on LaunchLab. Configs t2/t3/t4/t5 are live on-chain (created
> 2026-09-13, claim wallet = keeper escrow EFFY1LjZ…).

Platform IDs + admin keypairs: `tools/create-launchlab-tiers.js` (admins in
`~/waves-keys/launchlab-tier-*-admin.json`; claim wallet is always feeOwner).

## Phases

**Phase 0 — foundation (DONE):** tier config tool + admin keypairs + platformIds;
`tiers{}` + `launchlabLadderLive:false` in brand.js (inert).

**Phase 1 — create the configs (operator, no money risk):** fund each tier admin
~0.03 SOL, run `CONFIRM=1 node tools/create-launchlab-tiers.js`. Creates the 5
platform configs on mainnet. Reviewable, reversible-by-ignoring.

**Phase 2 — panel wiring (behind `launchlabLadderLive`):** `tierRungs()` returns
the tiers on LaunchLab; the launch attaches `tiers[flow.tier].platformId`;
`launchToken` passes it. Still inert until the flag flips.

**Phase 3 — the keeper (FUND-MOVING, AUDIT-GATED): BUILT, awaiting audit.**
`api/launchlab-keeper.js` — inert (no cron, `keeper.js` still excludes
`backend:"launchlab"`, both flags false). What it does:
- **Fee ladder** — `claimPlatformFee` to the keeper escrow, forward the creator's
  tier share to their fee wallet, sweep `wavesKeepBps` to the treasury. Uses the
  DELTA the claim adds (the quote mint is shared across SOL-quoted launches, so the
  whole-balance shortcut would rob a sibling).
- **Holder rewards** — harvest the Token-2022 transfer fee (the pot, in the launched
  mint, so whole-balance IS crash-safe); dividend pays holders pro-rata after a
  Jupiter swap into the reward asset; burn destroys it; split does half each; **pair**
  deposits into the staking pool's reward-mint ATA + calls `sync` (holders CLAIM).
- Reuses `keeper.js`'s crash-safe primitive verbatim: `payOnce` records the sig
  BEFORE broadcast, persists the plan the instant a non-idempotent step (Raydium
  claim, Jupiter swap) lands, resumes each batch at `plan.done`. Fail-closed auth;
  destination always from the token record, never the request.
- **The two boundaries for the auditor to focus on** are the only non-`payOnce`
  steps: the Raydium `claimPlatformFee` execute and the Jupiter swap. Both persist
  immediately on landing; the residual crash window leaves funds in the keeper's OWN
  escrow (recoverable), never a third-party loss — documented at each call site.
- Verified against the deployed staking program: pool PDA seeds `["pool", tokenMint,
  collection]`, sync accounts `[pool(w), vault(r)]`, vault = pool's reward-mint ATA —
  all match `stake.js` and `program/src/lib.rs`.

**Record fields the keeper reads (WIRED 2026-09-13):** the keeper services jobs
off the token record, so `launchlab.js` now persists `tier`, `rewardMode`, and
`pairedCollection` on launch (they were dropped before — the keeper would have
seen zero jobs), and `api/tokens.js` stores them chain-aware (`pairedCollection`
validated base58 for Solana, not EVM-only). Without this the ladder + rewards are
invisible to the keeper regardless of the flag.

**Pair-launch orchestration (ALREADY WIRED):** `launchpanel.js` calls
`WavesStake.initPool({tokenMint, collection, rewardMint})` on a pair launch
(best-effort — the token already launched), creating the staking pool + reward
vault. The keeper then *feeds* that vault; it does not create it.

**Preflight (READ-ONLY):** `tools/launchlab-keeper-preflight.js` validates every
serviceable job's invariants without moving funds — tier config exists, mint is
Token-2022 with the keeper as withdraw authority, pair pool + vault exist, keeper
gas. Run it against live KV before any real keeper run and hand it to the auditor.

**Phase 4 — audit + go live:** hand Phase 3 to the auditor (same as the last
round), rehearse one dividend payout on mainnet with a tiny pot (Jupiter has no
devnet, so the swap path can only be proven with real liquidity), deploy, then
flip `launchlabLadderLive` mainnet:true. The ladder and the rewards turn on
together.

## Do NOT flip the ladder before Phase 3 ships
Higher tiers would charge the creator more and pay them only the 0.5% on-chain cap
— worse than one honest 1.15% option.
