# LaunchLab keeper — audit scope

**Scope:** the fund-moving off-chain keeper that services WAVES's Raydium LaunchLab
launches — fee-ladder forwarding and holder-reward distribution. It is written,
inert, and gated; this document is the review brief.

**One-line trust model:** the keeper is a trusted, single-key server process. It is
*not* a smart contract. It is **custodial in transit** — it claims fees WAVES is
already owed and forwards/distributes them — and, on a failure, funds sit **at rest
in the keeper's own escrow until manually swept** (never with a third party). The
audit question is not "can a user steal from it" — it is **"can it lose, double-pay,
or misroute the funds it moves, and does every payout survive a crash at any
instant."**

> **Revision note:** this brief was reviewed once; the findings (H-4, H-5, H-6,
> M-9, M-10, M-11 + lows) are **remediated** in the code — see "Remediation" at the
> bottom. Re-review targets those deltas.

---

## What to review

| File | What it is |
|---|---|
| `app/public/api/launchlab-keeper.js` | **the keeper** — the whole review target |
| `app/public/launchlab.js` → `postListing` (~L329) | writes the token record the keeper reads (`tier`, `rewardMode`, `pairedCollection`, `feeWallet`, `creator`, `pool`, `mint`) |
| `app/public/api/tokens.js` (~L108–170) | validates + stores that record; the keeper trusts these values |
| `program/programs/waves-staking/src/lib.rs` | the pair path calls this program (pool PDA, `sync`, vault) — the **program** was audited last round (C-1 fixed); here only to confirm the keeper calls it correctly |
| `app/public/stake.js` | the browser client for that program. **NOT audited in any prior round** — in scope here. A self-audit pass (see "stake.js self-audit" below) already fixed a Token-2022 vault-derivation bug; a second opinion is still wanted |
| `tools/launchlab-keeper-preflight.js` | read-only preflight; run it to see the live job set |

**Deployment reality:** not wired to any cron, `keeper.js` (the Meteora keeper)
excludes `backend:"launchlab"`, and both `launchlabLive`/`launchlabLadderLive`
flags gate it. It ships only after this review.

---

## The two boundaries that are the whole point

Every *deterministic* payout goes through `payOnce()` (below), which is safe to
interrupt. Two steps are built by third parties and **cannot** be wrapped that way.
These are the focus:

### 1. Raydium `claimPlatformFee` execute (fee ladder, `runFeeLadder`)
- We measure the escrow balance **before** and **after** the claim and treat the
  **delta** as this launch's fee. Deliberately not the whole balance: the platform
  fee is claimed in the pool's **quote mint**, and two SOL-quoted launches share the
  keeper's one WSOL ATA — the whole-balance shortcut would pay launch A's forward
  out of launch B's un-swept fees.
- **Residual crash window:** claim lands, process dies before the plan is persisted.
  On resume the re-claim adds ~0 (fees only accrue on trades), the delta is ~0, and
  the previously-claimed amount sits in the **keeper's own escrow** — deferred to a
  manual sweep, never lost to a third party.
- **Please verify:** (a) the before/after delta cannot be gamed by a concurrent
  trade inflating `after`; (b) `creatorFraction()` arithmetic (`(feeRate −
  wavesKeepBps)/feeRate`) and the bigint rounding in `toCreator` — *settled last
  round: conservation exact, rounding favours treasury < 1e-6*; (c) sequential job
  processing — *now enforced by the M-9 KV single-flight lock; confirm the lock
  actually covers the whole run and releases correctly*.

### 2. Jupiter swap (rewards, `runReward` → `jupSwap`)
- The reward pot is harvested in the **launched mint** (unique to one launch), so
  the keeper treats its whole ATA balance as the pot — *this* is what makes the
  harvest crash-safe (a resume re-reads the balance, which still holds the pot).
- We record `payAmount` the instant the swap lands, **before** any payout, so the
  pot is never spent without a persisted plan naming the payees.
- **Residual crash window:** swap lands, die before persist → the swapped asset sits
  in the keeper's own ATA. Recoverable, never a third-party loss.
- **Please verify:** (a) slippage (`slippageBps=100`) is acceptable — *the H-5 fix
  now pays the measured post-swap DELTA, not the quote, so a low fill can no longer
  over-commit; confirm the before/after read + retry loop is race-safe*; (b)
  `wrapAndUnwrapSol` is now **false** (input is never native SOL; keeping it true
  unwrapped a WSOL *output* and zeroed the delta read) — so a SOL dividend pays
  holders **WSOL tokens**, not native SOL. Confirm that's acceptable UX and that
  Jupiter creates the keeper's WSOL output ATA under `wrapAndUnwrapSol:false`; (c) a
  failed/partial swap can no longer leave `payAmount` set — `jupSwap` now **throws**
  on a confirmation failure or a zero delta; confirm no catch upstream swallows it.

---

## `payOnce` — the crash-safety primitive (lifted verbatim from the audited Meteora keeper)

```
if already done → return
if a signature was recorded → check the chain; landed → mark done
build tx, sign, RECORD THE SIGNATURE, persist plan, THEN broadcast, confirm, mark done
```

The write-then-send ordering is the invariant: the worst case is a recorded
signature that was never broadcast, which resolves to "did not land, send it." A
signature is **never** recorded after a broadcast. **Please verify** this holds for
every payout site: fee forward, treasury sweep, burn, vault deposit, `sync`, and
each holder batch (`batch<offset>`), and that `plan.done` advances only after a
batch is confirmed so a resume never re-pays a landed batch nor skips an unlanded one.

---

## Fund-flow invariants the keeper must never break

1. **Conservation.** For a fee job: `toCreator + toKeep == claimed`. For a reward
   job: `toBurn + toPay == pot`, and `payAmount` (post-swap) is fully distributed
   (holder shares sum to ≤ `payAmount`; the dust floor drops remainders, never
   over-pays).
2. **Destination integrity.** Every destination comes from the **token record**
   (`feeWallet`/`creator` for the forward, the on-chain holder set for a dividend,
   the derived pool PDA for a pair) — **never** from the HTTP request. Confirm no
   request field reaches a transfer destination. NOTE: this holds only because
   `api/tokens.js`'s `FILLABLE` allow-list (a prior-round C-2 fix) prevents a
   stranger from filling a blank `feeWallet` on someone else's listing — the keeper
   *inherits* that guarantee, it does not re-enforce it. Do not widen `FILLABLE`
   without re-checking this dependency.
3. **Auth is fail-closed.** Missing `CRON_SECRET` → 500 (never authenticates);
   wrong bearer → 401; missing `KEEPER_SECRET` → no-op 200. Confirm no path signs
   without both.
4. **Pair correctness.** The keeper derives `pool = PDA(["pool", mint, collection])`
   and `vault = ATA(rewardMint, pool)` and must match what `stake.js`/`lib.rs`
   created at launch. The `sync` instruction is hand-built (`SYNC_DISC` +
   `[pool(w), vault(r)]`) — confirm the discriminator and account metas/writable
   flags match the program.
5. **Job selection.** Only `backend === "launchlab"` records with a non-standard
   `tier` or a `dividend`/`burn`/`split` `rewardMode` are serviced. Confirm a
   standard/`none` launch is never touched, and that a Meteora (`backend: null`)
   record cannot be mis-selected.

---

## Explicitly OUT of scope (already reviewed or unchanged)

- The `waves-staking` Anchor **program** (`lib.rs`) — audited last round (C-1
  vault-drain fixed + tested 7/7). Here only as the keeper's callee. (Its browser
  client `stake.js` is NOT out of scope — see the review table.)
- The LaunchLab launch path itself (`launchToken`), the Meteora `keeper.js`, the
  indexer, and the app-layer hardening — prior audit round.
- The tier platform configs are already created on-chain (t2–t5); their creation
  tool (`tools/create-launchlab-tiers.js`) is not fund-moving.

---

## How to see the live job set

```
# read-only, signs and sends nothing
KV_REST_API_URL=… KV_REST_API_TOKEN=… node tools/launchlab-keeper-preflight.js
```

It prints, per serviceable job: tier config existence, that the mint is Token-2022
with the keeper as `withdrawWithheldAuthority` (else harvest reverts), pair pool +
vault existence, and keeper gas. A clean preflight is a precondition for the first
real run; a tiny-pot mainnet dividend rehearsal (Jupiter has no devnet) is the
other.

---

## Remediation (applied after the first review)

Every finding from the first pass is fixed in `api/launchlab-keeper.js` (and the
two support files). Re-review these deltas.

- **H-4 · dividend paid the curve's unrecoverable vault.** `runReward`'s dividend
  now decodes the LaunchLab pool, excludes the base vault **by account**
  (`pool.vaultA`) and everything the **pool authority PDA** / pool own **by owner**,
  and `snapshotHolders` takes both a skip-owners and a skip-accounts set. If the
  pool can't be read, the job is skipped rather than risk stranding funds. (Note:
  a `dataSize:165` filter was deliberately NOT added — a Token-2022 dividend mint's
  accounts carry the `TransferFeeAmount` extension and exceed 165 bytes, so that
  filter would match nothing. Documented at `snapshotHolders`.)
- **H-5 · `jupSwap` returned the quote, swallowed failures.** Rewritten to mirror
  `keeper.js` `doSwap`: read the destination ATA before, send, `confirmed()` (which
  **throws** on failure), then read after with retries and return the **actual
  delta**. A reverted swap now throws (never sets `payAmount`); the payable figure
  is what arrived, so batches can't over-commit.
- **H-6 · burn launches were un-serviceable.** Pure `burn` is removed from the job
  filter (it's now a standard-SPL token with no transfer-fee to harvest). `split`
  still runs — it keeps the transfer-fee extension, so its burn-half destroys
  harvested tokens directly. The preflight surfaces burn launches as a warning. A
  quote→burn pipeline is a **follow-up** (see below).
- **M-9 · no cross-invocation lock.** A KV single-flight lock (`SET llkeeper:lock
  NX EX 300`, released in `finally`) serialises runs so the fee path's delta window
  can't overlap; `maxDuration: 300` added. (The delta griefing question is settled:
  sending mintB to inflate `claimed` returns only `frac` to the attacker and
  donates the rest — a cost to them, not extraction.)
- **M-10 · derived vault vs. actual.** The pair path now reads the pool's real
  `vault` field (offset 104) and deposits straight to it, instead of deriving the
  ATA — making invariant #4 true by construction even if a pool was created with a
  non-ATA vault.
- **M-11 · misconfigured tier swept 100% to treasury.** A non-standard tier that
  resolves to `frac === 0` now **skips loudly and claims nothing** on the fresh
  path, instead of forwarding the creator nothing and sweeping the whole fee to us.
  (Arithmetic is settled: `toKeep = claimed − toCreator` makes `toCreator + toKeep
  == claimed` exact; rounding favours the treasury by < 1e-6.)
- **Lows.** Reward path now checks gas **before** the irreversible harvest;
  `snapshotHolders` skip logic hardened (above). `payOnce` is unchanged from the
  audited `keeper.js` — the retry-rebuilds-with-a-fresh-blockhash caveat stands, so
  this brief does **not** present it as fully settled; it is safe at cron cadence.
  `loadBrand()`'s `new Function` executes our own checked-in `brand.js` (no
  injection vector, but it assumes brand.js touches only `window`).

## Known follow-ups (not regressions — scoped out on purpose)

- **Quote→burn pipeline** so pure-burn launches do a real buyback (claim fees in
  the quote → swap → burn). Until built, burn is excluded and should probably be
  hidden in the launch UI so it isn't offered.
- **Post-graduation dividends:** H-4 excludes the *bonding-curve* base vault. After
  CPMM migration the token's liquidity vault changes; a dividend run post-migration
  should also exclude the CPMM pool vault. Rewards accrue mostly pre-graduation, so
  this is a follow-up, but flagged so it isn't forgotten.

---

## Staking program — VERIFIED BUILD (not just "deployed")

The `waves-staking` program is deployed **immutable** on mainnet (`jt5Je…`, no
upgrade authority). We verified the deployed bytecode is the current fixed source,
not just that *something* is there:

- `solana program dump jt5Je… onchain.so` → sha256 **d4bccc29…**
- a fresh `anchor build` of `programs/waves-staking/src/lib.rs` → **byte-identical**
  (same sha256), reproduced twice.

So the immutable on-chain program provably IS the C-1-fixed source (the auditor can
reproduce this). Immutability also closes the earlier "program-ID keypair in git
history" flag — an immutable program has no upgrade authority, so that key is inert.

## stake.js self-audit (2026-09-13)

Client reviewed against `lib.rs`; account orders, discriminators, and the
accumulator math (`pending()` vs `sync()`+`settle()`) all match. Fixes applied:

- **Vault derivation (was wrong for Token-2022 rewards — the common case).**
  `summary`/`pdas` derived the vault as `ATA(rewardMint, pool)` with the **classic**
  token program hardcoded, so for a Token-2022 reward mint (every xStock) they read
  a non-existent account and showed **zero earned**. Now they read the pool
  account's stored `vault` field (authoritative for any program) — same lesson as
  the keeper's M-10. `vaultAta()` is marked deprecated.
- **Staked-token program.** `stake` hardcoded the classic program for the burn +
  staker ATA. Now resolved from the mint (classic today, but no longer a trap if a
  pair ever launches a Token-2022 token).

Still wanted from the auditor on the client: confirm `verify_core_asset`'s byte
offsets vs the pinned mpl-core, the `signSend` wallet-adapter paths, and that
`pending()` can never over-report vs an on-chain `claim`.
