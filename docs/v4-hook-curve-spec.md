# WAVES V4-hook bonding curve (Robinhood Chain) — design spec

**Goal:** every WAVES launch is a live Uniswap V4 pool from block zero, so GMGN /
DexScreener / Photon index it natively with its image — no per-aggregator
partnership, no anonymous pre-graduation window. This is what KLIK
(`Factory_whook.sol`, "V4 Edition") does, and it's the only real fix for the
discoverability gap.

**Scope:** Robinhood Chain only. Solana (Meteora DBC) already launches natively
and shows on GMGN — leave it alone. This replaces the standalone `WavesCurve` on
EVM with a V4 hook.

---

## The one architectural decision: ONE shared hook, many pools

V4 keys a hook in the `PoolKey`, so a single deployed hook can serve every WAVES
pool. Keep the current model's best property — **one audited money contract**,
not a fresh one per launch. The hook is the singleton; only the ERC20 is deployed
per launch, exactly as today.

- `WavesCurveHook` — deployed once, at a CREATE2-mined address whose low bits
  encode its permissions (see "Hook mining").
- Each launch: deploy `WavesToken`, then `poolManager.initialize(key, …)` with
  `key.hooks = WavesCurveHook` and `key.currency0 = address(0)` (native ETH).
  Per-token curve params (virtualEth, virtualTokens, curveSupply, feeBps,
  creator) are stored in the hook's own `mapping(PoolId => Curve)`, set in
  `beforeInitialize` / a `launch()` entrypoint — NOT in `hookData` (which a
  caller could forge).

## How pricing works — the "custom curve" hook pattern

Pre-graduation the pool has **no AMM liquidity**; the hook prices everything.
This is the standard v4 custom-curve / CSMM pattern (see v4-periphery examples),
the same one pump.fun-on-v4 and KLIK use.

- **Permissions:** `beforeSwap = true`, `beforeSwapReturnDelta = true`,
  `beforeInitialize = true`, `beforeAddLiquidity = true` (to *block* external LPs
  pre-graduation). Everything else off.
- **`_beforeSwap`:** read the `Curve` for this `PoolId`, run the *existing*
  constant-product math from `WavesCurve.sol` (`x = virtualEth + raised`,
  `k = x·y`), take the platform+creator fee, and return a `BeforeSwapDelta` that
  makes the PoolManager move exactly those amounts. The AMM's own swap is
  no-op'd. **This is a port of code we already have and already invariant-test,
  not new curve math.**
- **`_beforeAddLiquidity`:** revert pre-graduation. The curve owns the reserves;
  nobody seeds or removes liquidity until it graduates.

## Graduation

When `raised >= graduationEth`, the hook flips the pool from curve-priced to a
normal AMM in one of two ways (pick in build):

1. **In-place release (simpler):** stop overriding swaps (`beforeSwap` returns
   zero delta), mint the accumulated ETH+token reserves as real V4 liquidity into
   this same pool at the curve's final price, locked/burned. Pool address never
   changes → aggregators keep the same chart. **Preferred.**
2. **Migrate (Doppler's model):** initialize a fresh unhooked pool, move
   liquidity, lock the LP. More moving parts; only needed if the hooked pool
   can't hold post-graduation liquidity cleanly.

Either way, **the LP is locked or burned at graduation** — which also clears the
"Burnt/Locked LP < 80%" HIGH-risk flag that the current model can't satisfy.

## Fees & holder rewards — unchanged downstream

Fees accrue in the hook per `PoolId`, same split ladder as today
(platform / creator, creator's cut pledgeable to holders). The keeper
(`api/rh-keeper.js`) already claims and distributes from a curve contract; it
reads from the hook instead — the selectors change, the flow doesn't. `logo()`
etc. stay on `WavesToken`, so the on-chain image story is unchanged.

## Hook mining (the one genuinely new bit of tooling)

A V4 hook's address must have specific low bits set matching its permissions, or
`initialize` reverts. Deploy via CREATE2 with a mined salt (HookMiner from
v4-periphery). One-time, at deploy — add to `tools/`. Every launch after that
just references the mined address; no per-launch mining.

---

## Effort & what to reuse vs build

| piece | source | effort |
|---|---|---|
| Constant-product curve math, fee ladder, graduation trigger | **reuse** `WavesCurve.sol` (already invariant-tested) | port |
| V4 hook skeleton (`BaseHook`, permission flags, callbacks) | **reuse** v4-periphery `BaseHook` (~225 lines, standard) | wire |
| `_beforeSwap` returning `BeforeSwapDelta` (custom-curve) | v4-periphery custom-curve example as reference | **new, careful** |
| `beforeAddLiquidity` guard, graduation → locked LP | Doppler migrator as *reference only* (don't fork the framework) | **new** |
| Hook CREATE2 mining tool | v4-periphery `HookMiner` | new tool |
| Keeper read-path selectors | edit `api/rh-keeper.js` | small |
| Fork tests against RH V4 (PoolManager `0x8366…0951`, cancun) | extend existing `WavesSwapRouter.fork.t.sol` harness | medium |

**Do NOT fork Doppler wholesale** — it's a dynamic-auction framework with
governance, DN404, rehypothecation, multiple migrators (1400-line hooks). We want
one constant-product hook. Reference its graduation/migration and BaseHook only.

**Honest sizing:** the curve logic is done; the real work is (1) the custom-curve
`beforeSwap` delta accounting — the part that moves money and must be exact — and
(2) graduation-to-locked-LP. Both are **audit-mandatory**; this is launch
liquidity in a hook. Ballpark: ~1–2 weeks to a testable implementation on an RH
fork, then an audit gate before any mainnet launch. Same class of work the
staking program still awaits (unaudited per project notes).

## Open questions to settle before coding
1. Graduation model: in-place release (1) vs migrate (2). Recommend (1).
2. Does RH's V4 PoolManager permit the hook flag bits we need? (Canonical v4 does;
   confirm on a fork before committing to addresses.)
3. First-buy / anti-snipe on the very first block — the current curve handles the
   creator's launch buy; preserve that in `beforeSwap`.
4. Native ETH as currency0 with a custom-curve delta — verify settle/take
   accounting on ETH specifically (v4's native-currency path).

---

## STATUS — implemented on branch `v4-hook-curve` (2026-09-05)

`contracts/WavesCurveHook.sol` + `test/WavesCurveHook.t.sol` + `script/DeployWavesCurveHook.s.sol`.
Build/test under `FOUNDRY_PROFILE=v4` (solc 0.8.26 + cancun; v4-core/periphery gitignored, `forge install` to fetch).

**Done & tested (6/6 on a local PoolManager):**
- ✅ launch opens a live V4 pool from block zero; supply held as an ERC-6909 claim
- ✅ buy prices EXACTLY against the ported curve, settles exact amounts, platform earns its cut
- ✅ sell returns ETH and reprices
- ✅ platform fee-claim converts claims → real ETH
- ✅ graduation: filled curve → `graduate()` seeds one full-range hook-owned (=locked) position, pool flips to a normal AMM, later swaps trade against it (also clears the "Burnt/Locked LP" flag)
- ✅ outside liquidity blocked during the curve phase
- ✅ deploy script mines the CREATE2 salt for the hook's permission bits (mining proven in test setUp)
- ✅ default (standalone-curve) build + 31 tests unaffected

**Still owed before mainnet (audit-gated):**
1. Fork tests against RH's real PoolManager (`0x8366a39C…e40951`) — run in a network-enabled env.
2. Front-end wiring: point `evm-token.js` launch/trade at the deployed hook + its `launch()`/swap-router path; keeper reads fees from the hook.
3. **Audit** — launch liquidity in a hook. Non-negotiable.
4. Out of v1 scope by choice: exact-output swaps; a bundled first-buy inside `launch()`.
