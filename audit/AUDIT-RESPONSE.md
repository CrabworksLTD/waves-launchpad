# WAVES — Response to Audit Findings

Prepared 2026-09-06, after the first-round findings (M-1, L-1, L-2 + the "confirmed sound" and "not covered" notes). All three findings are fixed in source and covered by regression tests. **56/56** unit tests pass (`FOUNDRY_PROFILE=v4 forge test --no-match-path "test/*fork*" --use 0.8.26`) and the fork suite passes against RH mainnet state.

> **Deployment status:** the addresses in `AUDIT.md` are the **pre-fix** deployment (preview only; prod never cut over). These fixes change the hook bytecode, so the hook (and the router/aggregator/sell-router that reference it) get **new addresses on redeploy** — which we are holding until this re-review, so the fixed code is what ships, in one cutover.

---

## M-1 — derived virtual reserve now floored (fixed)

**Change.** The guard now validates the number the curve runs on, not just the input. Added `MIN_VIRTUAL_QUOTE = 1e6` and a helper `_virtualQuoteFor(graduationQuote) = mulDiv(graduationQuote, virtualEth, graduationEth)`; every place a target is set or used checks the derived reserve against it:

- `setQuote` — `if (enabled && _virtualQuoteFor(graduationQuote) < MIN_VIRTUAL_QUOTE) revert BadConfig();` (this subsumes the old zero-only check).
- `setQuotes` (batch) — same check per enabled element; one bad target reverts the whole batch.
- `launch` — defensive floor on the derived reserve before it reaches the curve, so a degenerate value can't be launched even if it somehow bypassed registration.

**Why reject rather than floor the reserve.** You noted either closes it. Rejecting keeps the curve-shape invariant intact (a floored reserve with an unfloored target would break the `virtualQuote : graduationQuote` ratio you verified under "curve shape is quote-invariant", so residuals would stop being dust). Rejecting a misconfiguration at the source is also the louder failure.

**Floor rationale.** With the live template the derived reserve is `target × 0.3525`. `1e6` sits ~5 orders above the degenerate range (0 and single digits) and ~3 below the smallest realistic derived reserve (a ~$2.8 target on a 6-dec quote), so it rejects only misconfiguration. Every one of the 172 stock targets derives ≥ ~1e9 and is unaffected; they will be re-approved against the new hook and re-verified.

**Tests.** `test/WavesAudit.t.sol::test_AUDIT_tiny_graduation_target_zeroes_the_virtual_reserve` now asserts the rejection (targets 1 and 3 revert `BadConfig`, quote stays disabled). Added in `test/WavesCurveHookQuote.t.sol`: `test_setQuote_rejects_degenerate_derived_reserve`, `test_setQuote_accepts_realistic_targets` (incl. your $12k/6-dec control), `test_setQuotes_batch_rejects_degenerate`, `test_setQuote_can_still_disable`. Your `test_AUDIT_six_decimal_quote_scales_sanely` control still passes.

---

## L-1 — aggregator sweep scoped to per-call leftovers (fixed)

**Change.** `WavesQuoteAggregator` now captures `quoteBefore` / `ethBefore` **before** the swap adds anything (`ethBefore = address(this).balance - msg.value`), and `_buyAndSweep` sweeps only the increase (`quoteNow - quoteBefore`, `ethNow - ethBefore`). A balance that arrived out of band is left untouched instead of going to whoever calls next.

**Sell router.** No change needed — `WavesSellRouter` already scopes to per-call deltas (`quoteGot = balanceOf − before`; the callback takes exactly `ethOut` and transfers exactly `leftover`). Confirmed against your description.

**WavesSwapRouter.** The same whole-balance-refund pattern exists here, but this contract is **not** in the redeploy (it doesn't reference the hook, and it is the keeper's battle-tested, mainnet-proven ETH→quote path). Given the Low severity ("misdirected donations and dust, no user funds at risk"), we are **not** redeploying it in this cutover to avoid disturbing a proven path — flagging it for your call as an accepted-Low / separate follow-up rather than folding it in silently.

**Test.** `test/WavesQuoteAggregator.t.sol::test_prior_donation_is_not_swept_to_next_caller` — donate quote + ETH to the aggregator, run a buy, assert the donation remains and the buyer gets no windfall.

---

## L-2 — sell-router pool key hooks pinned to zero (fixed)

**Change.** `WavesSellRouter.sellForEth` now also requires `ethQuoteKey.hooks == address(0)` (reverts `NotEthPool`). The canonical RH ETH pools are hookless, so this loses no legitimate route and removes the arbitrary-hook-inside-unlock question entirely. (We left `fee`/`tickSpacing` caller-supplied: a wrong pool there is self-harm — a bad price or a revert — consistent with the accepted "zapper eats slippage" limitation, and the front-end always passes the canonical pool.)

**Test.** `test/WavesSellRouter.fork.t.sol::test_sell_rejects_hooked_pool_key` — a key with a non-zero hook reverts.

---

## On "confirmed sound"

Noted and appreciated — those are exactly the properties we wanted a second set of eyes on (registry-snapshot vs. live reads, `claim` isolation, the locked LP, `beforeInitialize` gating, and the quote-invariant curve shape). No changes; M-1 is precisely the degenerate case of that last invariant, which is why the floor is framed around it.

## On "not covered" — CurrencySettler second pass

Agreed, and it stays **in scope** for the re-review: since the hook custodies every launch's reserves as ERC-6909 claims, `v4lib/CurrencySettler.sol` is the piece to check line-by-line against v4-core (native / ERC-20 / claim branches). It is unchanged by these fixes. We did not run the fork suite or verify deployed-vs-source as part of your pass — the fork suite passes on our side, and deployed-vs-source is moot until the post-fix redeploy, at which point the new `MANIFEST.txt` keccaks will be regenerated for verification.

---

## What changed, file by file

| File | Change | New source SHA-256 (see MANIFEST) |
|---|---|---|
| `contracts/WavesCurveHook.sol` | M-1 floor (`MIN_VIRTUAL_QUOTE` + checks) | `679638…f120b4` |
| `contracts/WavesQuoteAggregator.sol` | L-1 per-call sweep scoping | `81ff25…27be2a` |
| `contracts/WavesSellRouter.sol` | L-2 pin `hooks == 0` | `590f31…08beec` |
| `contracts/WavesHookRouter.sol` · `WavesToken.sol` · `WavesSwapRouter.sol` | unchanged | (hashes unchanged) |

Flattened fixed sources are in `audit/flat/`. Ready for your re-review; redeploy + prod cutover held until you sign off.

---

## Round 2 — response to the re-review (Informational + notes)

**Informational (constructor seeds ETH without the floor) — fixed.** The constructor now runs the same guard: `require(virtualEth_ >= MIN_VIRTUAL_QUOTE, "virtualEth below floor")` before seeding `approvedQuotes[address(0)]`. For ETH the derived reserve is exactly `virtualEth`, so this is the identical floor every other quote clears. Test: `test/WavesCurveHookQuote.t.sol::test_constructor_rejects_degenerate_virtualEth` (deploy with `virtualEth = 1` reverts). Live template is `1.41e18`, unaffected. Hook re-flattened; new source hash in `MANIFEST.txt`. **57/57** unit tests now pass.

**Note — CurrencySettler provenance.** Recorded in `AUDIT.md §8` and `MANIFEST.txt`: `v4lib/CurrencySettler.sol` is byte-identical to `lib/v4-core/test/utils/CurrencySettler.sol` apart from import paths — a v4-core test util used in production here, correct because `PoolManager._settle` credits by measured reserve delta (`reservesNow − reservesBefore`), not by the ignored `transfer`/`transferFrom` return. **Left unmodified on purpose** so it stays byte-identical to upstream (adding even a comment would break the property you verified).

**Note — `settle(payer, …, burn=false)` ignores `payer` for native.** Acknowledged as a latent footgun. Every current call site passes `payer = address(this)`, so it spends only this contract's own ETH and is correct today. Not changing the vendored file (see above); tracking it as a constraint on any future call site rather than a code change.

**Deployed-vs-source.** Understood — moot until the post-fix redeploy. At cutover we regenerate the runtime-bytecode keccaks in `MANIFEST.txt` for your final deployed-vs-source pass, which is the last gap.
