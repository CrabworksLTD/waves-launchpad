# WAVES Launchpad — Security Audit Package

**Chain:** Robinhood Chain (EVM, chainId **4663**), RPC `https://rpc.mainnet.chain.robinhood.com`
**AMM:** Uniswap **v4** — singleton `PoolManager` at `0x8366a39CC670B4001A1121B8F6A443A643e40951`
**Prepared:** 2026-09-06 · **Status:** deployed to RH mainnet, live on a *preview* front-end only; **production is NOT cut over pending this audit.**

> **⚠️ Post-first-round update:** findings M-1, L-1, L-2 are **fixed in source** and covered by regression tests (see `AUDIT-RESPONSE.md`). The deployed addresses in §2 below are the **pre-fix** build; the hook (and the router/aggregator/sell-router that reference it) will get **new addresses on redeploy**, held until re-review so the fixed code ships in one cutover. Flattened sources in `audit/flat/` and the hashes in `MANIFEST.txt` are the **fixed** versions.

This package is the scope + threat model for auditing the WAVES bonding-curve launchpad and its RWA-quote extension. Flattened sources are in `audit/flat/`; the full repo (with tests) is the source of truth.

---

## 1. What the system does

A creator launches an ERC-20 memecoin against a **bonding curve** implemented as a Uniswap-v4 **hook**. Buyers trade against the curve until it reaches a graduation target, at which point liquidity migrates into a normal full-range v4 pool. The novel part under audit is that a launch can be **priced in an approved ERC-20 "quote" asset** (USDG, or a tokenized stock like Ford) instead of native ETH — the pool trades `TOKEN/<quote>`, fees accrue in the quote, and two thin *zap* routers let users keep paying/receiving **ETH** while the quote is swapped under the hood.

Plain ETH launches remain the default and should behave identically to the pre-quote system.

---

## 2. In-scope contracts

| Contract | Deployed (RH mainnet) | Runtime size | Purpose |
|---|---|---|---|
| `WavesCurveHook.sol` | `0x944d7ef6760ad407c4E9cCb841c50821b08Ce888` | 20,216 B | **The core.** v4 hook: bonding curve in `beforeSwap`, quote registry, order-aware currency handling, per-quote fee accrual, graduation into a full-range pool. |
| `WavesHookRouter.sol` | `0x47245b8b5f1e4aee42fe9ca996c88e74b4799ec0` | 3,825 B | Public buy/sell entrypoint. `buy(token,quote,quoteIn,minOut,to,deadline)` (payable for ETH, `transferFrom` for ERC-20), `sell(...)` returns the quote. |
| `WavesQuoteAggregator.sol` | `0xfe5ffab5458f03419460ae5e228c336dd956c8ed` | 2,033 B | Buy-side zap: pay **ETH**, get a quote-paired token in one tx (ETH→quote via `WavesSwapRouter`, then quote→token via the hook router). Holds no funds. |
| `WavesSellRouter.sol` | `0xce174616c1aaa5a18dd267bded70d4eb89433fd4` | 3,082 B | Sell-side zap (**new**): sell a quote-paired token straight to **ETH** in one tx (token→quote via the hook router, then quote→ETH on the quote's own ETH pool). Holds no funds, no owner. |
| `WavesToken.sol` | *(per-launch, cloned by the hook)* | — | The launched ERC-20. Fixed supply minted to the hook at launch. |
| `WavesSwapRouter.sol` | `0x39add3410af091e4c6c254da0f861cb10a441361` | 4,885 B | **Pre-existing, already live.** ETH-in v4 swap router (ETH→quote, or ETH→USDG→quote). Used by the aggregator. Included for completeness — its ETH-in path is exercised by every quoted buy. |
| `v4lib/CurrencySettler.sol` | *(library, inlined)* | — | settle/take helper, native + ERC-20 + ERC-6909-claim branches. Vendored from Uniswap examples. |
| `v4lib/HookMiner.sol` | *(off-chain / test only)* | — | Mines a CREATE2 salt so the hook address carries the required permission bits. Not on the hot path. |

**Highest-risk surfaces, in order:** (1) `WavesCurveHook` order-aware currency mapping + `beforeSwap` curve math + graduation; (2) the two zap routers' settle/refund/no-retention logic; (3) the quote registry trust boundary.

---

## 3. Out of scope

- `WavesCurve.sol` (the legacy standalone bonding curve) — being retired by the hook; not part of the launch path under audit.
- The Solana programs / Core Candy Machine side of WAVES (separate chain).
- The staking program (`WavesStake`) and NFT-pairing panel — **gated off** (`PAIRING_LIVE = false`), untested, explicitly not launching.
- Off-chain services (`app/public/api/rh-*.js`: keeper, indexer) — trusted operator code, not on-chain. Their *interaction assumptions* are noted in §6 where they affect on-chain safety.
- The Uniswap v4-core `PoolManager` itself (audited upstream).

---

## 4. Build & test

- **solc** `0.8.26`, **evm_version** `cancun` (v4 requires transient storage for its lock), **optimizer** on, **`optimizer_runs = 200`**, **via-IR** on. The low run count is deliberate: it optimizes for **size** — the hook's added logic pushed it against the **EIP-170** 24,576-byte limit (now 20,216 B). Profile: `[profile.v4]` in `foundry.toml`.
- **Hook address** is CREATE2-mined (`HookMiner`) so its low bits equal the `0x2888` permission flags v4 checks; any bytecode change re-mines a new address.
- **Deploys** were done as browser self-serve signature pages (the maintainer holds the only key; no automated broadcasting). Hook via the Arachnid CREATE2 proxy `0x4e59b44847b379578588920cA78FbF26c0B4956C`; routers via plain CREATE.

**Tests** (`forge test`; the v4 unit set needs `FOUNDRY_PROFILE=v4 … --use 0.8.26`):

| Suite | Cases | Notes |
|---|---|---|
| `WavesCurveHook.t.sol` | 22 | ETH-path hook: curve math, first-buy, graduation, fees, boundaries. |
| `WavesCurveHookQuote.t.sol` | 10 | ERC-20 quote: registry gating, both currency orderings, ERC-20 first-buy + refund, claim-in-quote, graduation. |
| `WavesHookRouter.t.sol` | 8 | buy/sell both quote kinds. |
| `WavesQuoteAggregator.t.sol` | 6 | ETH→quote→token + reverse, per-leg min-out, retains-nothing. |
| `WavesSellRouter.fork.t.sol` | 2 | **Fork** vs the real PoolManager + real Ford/ETH pool: token→Ford→ETH lands ETH, no dust, `minEthOut` enforced. |
| `WavesCurveHookQuote.fork.t.sol` | 2 | **Fork**: quoted launch/buy/sell + graduation on the real manager. |
| `WavesSwapRouter.fork.t.sol` | 17 | **Fork**: the pre-existing ETH-in router. |
| `WavesCurve.t.sol` / `.invariant.t.sol` | 31 / 1 | Legacy curve (out of scope, kept green). |

Current status: **46/46** v4 unit tests pass; all fork tests pass against RH mainnet state.

---

## 5. Roles & trust model

- **platform** (`0xE52f574AC7006614EBe1c8a82913a5C07eC73CC7`, a Ledger) — set in the hook constructor. Can `setQuote` / `setQuotes` (enable/disable an ERC-20 as a quote and set its graduation target), and receives graduation residuals. **It cannot touch curve reserves, cannot mint, and cannot move user funds.** A malicious/compromised platform can (a) enable a bad quote or set a nonsense graduation target for *future* launches, and (b) disable a quote (does not retroactively brick existing pools — confirm this). It is a trusted role; the question for audit is the *blast radius* if it misbehaves.
- **creator** — per launch. Owns the launch's pledged fee share; no special power over other launches or the curve.
- **buyers/sellers** — permissionless via the routers.
- **keeper (off-chain)** — harvests accrued fees (`claim(quote)`) and distributes rewards. It is a fee *recipient's* automation; it has no privileged on-chain role beyond calling `claim` for addresses that granted it a pledge. Its safety assumption: fees accrue **per quote**, and a run processes **one quote at a time** (crash-recovery). Verify `claim` cannot be used to drain another address.

---

## 6. Invariants to verify

1. **No fund retention in the routers.** `WavesHookRouter`, `WavesQuoteAggregator`, and `WavesSellRouter` must end every external call holding **zero** of every token and zero ETH (any residue is swept to the user). Fork test asserts this for the sell router; please prove it generally, including on the refund/boundary paths.
2. **ETH-path parity.** An ETH-quoted launch (quote = `address(0)`) must behave exactly as the pre-quote system — same curve, same graduation, same fee math.
3. **Order-aware correctness.** v4 requires `currency0 < currency1`. ETH is always `currency0`; for an ERC-20 quote the token/quote ordering is not fixed and the hook records `tokenIs1`. Every place that maps quote/token → currency0/currency1 (beforeSwap direction, graduation `amount0/amount1`, residual/dust routing, router encode) must be correct for **both** orderings.
4. **Curve conservation.** Tokens out on a buy and quote out on a sell must match the constant-product virtual-reserve math; the curve must never pay out more quote than it holds; graduation must seed the pool with exactly the curve's accumulated reserves and route residual/dust deterministically.
5. **Fee accounting.** `owed[who][quote]` accrues only real fees; `claim(quote)` pays exactly what is owed in that quote and zeroes it; no cross-quote or cross-account leakage.
6. **Registry gating.** `launch` with an unapproved quote must revert; only `platform` can change the registry; ERC-20 first-buy `transferFrom` amount is exactly `firstBuy`, with any boundary overfill refunded.
7. **Reentrancy.** The hook runs inside v4's `unlock`/lock; the zaps make **sequential** (not nested) unlocks (sell router: hook-router sell completes, *then* its own unlock for quote→ETH). Confirm no path re-enters mid-settlement and that CEI holds around the external ERC-20 transfers.

---

## 7. Known issues / accepted limitations (not "please fix", but please confirm they're bounded)

- **Zap slippage floors are loose.** The aggregator and sell router pass `minOut = 0` on the internal swap legs today (front-end relies on the pool's own empty-pool guard). This is a **known** UX/MEV exposure on the zap path, accepted for now; confirm it cannot be leveraged to harm anyone **other** than the opt-in zapper (i.e., no pool/curve invariant breaks, only the caller eats slippage).
- **Sell router is single-hop.** `sellForEth` requires the quote to have a direct ETH pool (`currency0 == address(0)`, `currency1 == quote`); 174/175 listed stocks and USDG qualify. A quote without an ETH pool falls back (front-end) to the hook router returning the quote asset. No two-hop (quote→USDG→ETH) sell path exists yet.
- **Platform centralization** (see §5) — a trusted-role design, deliberate.
- **Front-end display** — the sell preview currently shows the quote-denominated estimate rather than ETH (cosmetic; funds are correct). Not a contract issue.

---

## 8. External dependencies

- Uniswap **v4-core** (`lib/v4-core`) — `PoolManager`, `PoolKey`, `Currency`, `BalanceDelta`, `SwapParams`, `IUnlockCallback`, `IHooks`. Pinned to solc `0.8.26`, cancun.
- `v4lib/CurrencySettler.sol` — vendored settle/take helper (native / ERC-20 / ERC-6909-claim branches). **In scope** because the hook and both zaps depend on it. **Provenance:** byte-identical to `lib/v4-core/test/utils/CurrencySettler.sol` apart from import paths — a v4-core *test util* used here in production. Correct because `PoolManager._settle` credits by measured reserve delta, not by the (ignored) `transfer`/`transferFrom` return. Kept unmodified to stay byte-identical to upstream. **Constraint:** `settle(payer, …, burn=false)` ignores `payer` on the native branch and spends this contract's own ETH — every current call site passes `payer = address(this)`; any future call site must too.
- No external oracles on-chain. USD figures are off-chain only.

---

## 9. Files

- Flattened, self-contained sources for review: `audit/flat/*.flat.sol`.
- Canonical sources: `contracts/*.sol` (+ `contracts/v4lib/`).
- Tests: `test/Waves*.t.sol`. Run the core set with
  `FOUNDRY_PROFILE=v4 forge test --no-match-path "test/*fork*" --use 0.8.26`
  and the fork set by adding `--fork-url https://rpc.mainnet.chain.robinhood.com --evm-version cancun`.

**Please focus effort on `WavesCurveHook` (order-aware currency handling + graduation) and the two zap routers' no-retention/settlement paths** — that is where the new risk lives.
