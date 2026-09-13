# WAVES → Raydium LaunchLab migration (Solana) — design spec

**Goal:** let a WAVES token be priced in a **tokenised stock** (SPYx, NVDAx, TSLAx …)
on Solana, matching StonkFun. Those xStocks are **Token-2022**, and Meteora's DBC
program **rejects Token-2022 quote mints** (`InvalidQuoteMint`, 0x1778) — verified
on-chain and already guarded against in `config-create.html`. StonkFun runs on
**Raydium LaunchLab**, which does support stock quotes. This spec is how WAVES adds
LaunchLab as a second curve backend.

**Scope:** Solana only. Do **not** rip out Meteora — existing mainnet launches live
on it and must keep trading/graduating. LaunchLab is added **in parallel**, used
only when the chosen quote is a Token-2022 asset (or any mint Meteora can't take).

---

## ⚠️ Phase 0 — the de-risk, before any migration code

The whole migration rests on one unverified assumption:

> **Can LaunchLab create a launch whose QUOTE mint is a Token-2022 xStock?**

What the Raydium docs actually say:
- Default LaunchLab quote assets are **SOL, USDC, RAY** (protocol upgrade, Aug 17).
- Token-2022 is supported for the **base** mint (`InitializeWithToken2022`), which
  is *not* the same as a Token-2022 **quote**.
- A separate **"configurable quote assets"** upgrade exists — the likely path
  StonkFun uses to quote in xStocks (a permissioned config naming the xStock as
  the quote mint). Unconfirmed for a Token-2022 quote specifically.
- Token-2022 launches **must** graduate to **CPMM** (not AMM v4).
- Extensions `TransferHook` / `PermanentDelegate` are rejected even on the T22 path.

**Action (make-or-break, ~1–2 days):**
1. `npm i @raydium-io/raydium-sdk-v2` (not currently installed).
2. Write `tools/launchlab-smoke.js` (mirror `tools/stake-smoke.js`): on **devnet**,
   create a LaunchLab config/launch with a **Token-2022 quote mint**, do a buy on
   the curve, and graduate to CPMM. If the config/init reverts on the T22 quote,
   the migration is a non-starter as designed — fall back to "wrap the xStock into
   a classic-SPL wrapper" or "stocks stay reward-only."
3. Confirm the exact API: `Raydium.launchpad.createLaunchpad` / the config PDA
   (`getPdaLaunchpadConfigId`), whether a custom-quote config must be created by a
   Raydium-permissioned key or by us, and the CPMM migration params (`migrate_type=1`).

Everything below assumes Phase 0 passes.

---

## ✅ Phase 0 RESULT (2026-09-13) — technically passes, economically gated

Ran against mainnet with `@raydium-io/raydium-sdk-v2` installed.

**The T2022-quote question is YES — and stronger than assumed.** xStock quote
configs **already exist on mainnet and are global** (anyone can launch against
them, no Raydium permission). Confirmed a config for all 16 majors checked:
`SPYx, NVDAx, QQQx, TSLAx, AAPLx, MSTRx, COINx, HOODx, GOOGLx, AMZNx, METAx,
GMEx, MSFTx, PLTRx, MCDx, KOx`. SPYx config (PDA `B7ctMMdG…`) decodes clean:
`mintB` == SPYx, `curveType` 0.

**CORRECTION (same day):** a first read of the shared config looked economically
gated (`tradeFeeRate: 2500` → `protocolFeeOwner: rayvTLc…`, `maxShareFeeRate: 0`).
That was wrong — it conflated Raydium's **protocol** fee with the **platform**
fee. LaunchLab has **two independent fee layers**, and ours is the second:

1. **LaunchpadConfig** (global, Raydium-owned) — its `tradeFeeRate` (0.25%) is
   **Raydium's protocol cut**. We just *use* the existing xStock configs. The
   `maxShareFeeRate: 0` only caps the *referral* share, which is irrelevant to us.
2. **PlatformConfig** (each platform creates its own, **permissionless** —
   `createPlatformConfig` has exactly one signer, the payer; no Raydium authority).
   This is where our economics live. Fields map 1:1 to the WAVES model:
   - `feeRate` → creator-selectable trading fee (StonkFun's **1% / 2%**)
   - `platformScale` / `creatorScale` / `burnScale` → the **split** (our take /
     creator / **buyback-burn**)
   - `platformClaimFeeWallet` → **our treasury**; claimed via `claimPlatformFee`
   - `transferFeeExtensionAuth` → **reward-mode** hook: token mints with a T2022
     transfer-fee extension (1%/3%), harvested + redistributed in the paired asset
   - `restrictGlobalConfig` / `restrictCurveParam` / `curveRuleManager` →
     platform-scoped curve rules

`LaunchpadPool` accrues `protocolFee` **and** `platformFee` as separate fields and
carries both `configId` and `platformId` + `migrateType` (1 = CPMM for T2022).

**So there is NO Raydium partnership wall.** How StonkFun does it = create a
permissionless PlatformConfig with their fee split + fee wallet, then launch
against the existing **global** xStock LaunchpadConfigs. WAVES does the identical
thing; our fee ladder runs natively on the stock-quoted side.

**Revised bottom line — one path, no gate:**
- Create the WAVES PlatformConfig once (feeRate ladder, platform/creator/burn
  scale, treasury as `platformClaimFeeWallet`, `transferFeeExtensionAuth` for
  reward mode). Permissionless.
- Build `launchlab.js` (launch / buy / sell / graduate-to-CPMM / `claimPlatformFee`)
  and route T2022-quote launches to it. Still **audit-mandatory** (moves launch
  liquidity) and a real multi-week build — but no external dependency.
- Meteora path stays for classic-SPL quotes (already live).

Residual item for the smoke test (not a wall): confirm the global xStock configs
don't allow-list *which* platforms may launch against them (`PLATFORM_ALLOW_CONFIG`
is platform→config self-restriction, but verify the config side is open). Default
LaunchLab design is permissionless; prove it with one devnet launch against a
T2022-quote config under a fresh PlatformConfig.

### ✅ Devnet smoke PROVEN (`tools/launchlab-smoke.js`, 2026-09-13)

Ran the full path on devnet with a WAVES-owned platform. Result: **PASS.**
- Created a **WAVES PlatformConfig** permissionlessly (`EzwdaEx5…`), `feeRate` 1%.
  Devnet gotchas found: `platform_scale` must be 0 and `platform+creator+burn`
  must sum to 1e6 → used `0 / 0 / 1000000` (LP-split, set properly via curve rule
  later); and `createLaunchpad`'s `execute` needs `{ sequentially: true }` to
  actually broadcast (else returns signed-but-unsent txs).
- **Launched a token against config `7ZR4zD7P` (Raydium-owned, WSOL quote) under
  OUR `platformId`** — `pool.platformId == ours` ✓, `pool.configId` = the global
  config we don't own ✓. So a non-owner platform launches against a config it
  doesn't control — the permissionless claim holds on-chain.
- Base mint = **Token-2022 with a 1% transfer-fee extension** (`mintProgramFlag: 1`)
  = reward mode. `migrateType: 1` (CPMM). ✓
- **Our 1% platform fee accrues to our platform fee vault** (`5m8LjR27`, WSOL),
  claimable via `claimPlatformFee`. Verified by fee math: 30,000,000 in −75,000
  protocol (Raydium 0.25%) −300,000 platform (our 1%) = 29,625,000 = `pool.realB`.
  (Note: the fee lands in the platform vault, **not** the `pool.platformFee`
  accumulator — that field stays 0.)

**Mainnet unknown — CLOSED (2026-09-13).** Scanned mainnet LaunchpadPool accounts
by `mintB` (raw offset 237) for the xStock quotes, reading each pool's `platformId`
(offset 173): SPYx **1,574 pools / ~19 distinct third-party platforms** (only 1 on
Raydium's default), TSLAx **481 / all third-party**, NVDAx **1,919 / all third-party**.
The xStock configs carry **no platform allow-list** — dozens of independent
platforms already launch against them. WAVES creating its own platform and
launching against these configs is the standard, permissionless path. Dominant
platformIds `6BwHHDg3…` and `4E876qZT…` are StonkFun's.

**→ Phase 0 fully closed. No external dependency. Remaining work is `launchlab.js`
+ routing + keeper/stats branches, then audit before mainnet.**

---

## Architecture — a second backend, not a replacement

Meteora coupling today lives in **five files**:

| file | role | migration impact |
|---|---|---|
| `token.js` (1,190 ln) | launch, buy/sell on curve, graduation, fee claim | **new `launchlab.js` sibling**; `token.js` stays for Meteora |
| `launchpanel.js` | launch flow / quote picker | route T2022-quote launches to LaunchLab; keep Meteora path |
| `dbc-terms.js` | Meteora curve/config terms | **new `launchlab-terms.js`** (curve params in LaunchLab's shape) |
| `api/keeper.js` | claim + distribute creator fees | LaunchLab has its own fee-claim; keeper reads pool type and branches |
| `api/solstats.js` | price / mcap / graduation indexer | index LaunchLab pools (different account layout) + CPMM graduation |

**Routing rule:** the quote's token program decides the backend.
`Tokenkeg…` (classic SPL) → Meteora DBC (unchanged). `TokenzQd…` (Token-2022, i.e.
xStocks) → LaunchLab. Record `backend: "meteora" | "launchlab"` on every launch so
the keeper, stats, and the token page know which client to use.

## Per-piece work

1. **`launchlab.js`** — the money client, mirroring `token.js`'s surface:
   `launch(quoteMint, curveParams)`, `buy`, `sell`, `graduate`, `claimFees`,
   `readMarket`. Built on `@raydium-io/raydium-sdk-v2` launchpad module. This is
   the bulk of the work and is **audit-mandatory** (it moves launch liquidity).
2. **Config model** — LaunchLab configs (per quote asset) replace the DBC configs.
   If custom-quote configs must be created once per xStock (like the DBC configs),
   the batch signer (`tools/sign-rwa-configs.js`) gets a LaunchLab twin. Confirm in
   Phase 0 whether we can even create a config naming a T2022 quote.
3. **Launch flow** — `launchpanel.js` picks the backend by quote; the confirm
   screen and records carry `backend`. The pair/staking flow is unaffected (it's
   collection-side), but the paired token could itself be LaunchLab-backed.
4. **Graduation** — LaunchLab T2022 → **CPMM** (LP-locked). Different from Meteora's
   DAMM v2. The "LP locked at graduation" story holds; the pool type changes.
5. **Keeper** — branch on `backend`: claim LaunchLab creator fees via its own
   instruction, then the existing swap/distribute (or pair→vault) logic reuses.
6. **Indexer (`solstats.js`)** — decode LaunchLab pool + CPMM accounts for
   price/mcap/holders/graduation. New account layouts.

## Fees & rewards — reuse downstream
Fee split ladder, holder-reward pledge, dividend/buyback, and the keeper's
swap-to-reward-asset all live *after* the claim and are backend-agnostic. Only the
**claim** selector changes per backend.

---

## Honest sizing
This is a **multi-week** migration of the core Solana launch/trade/graduate/fee/
index stack against an SDK not yet installed, on top of a **live mainnet product**.
It is **not** a pre-hackathon task. The correct sequence:

1. **Now / hackathon:** ship **classic-SPL quote currencies on Meteora** — all the
   liquid altcoins/memes (WIF, BONK, POPCAT, JUP, RAY, …) + gold (GOLD, XAUt0,
   VNXAU). These work today, no new backend. Present LaunchLab stock-quotes as
   roadmap.
2. **Post-hackathon:** Phase 0 de-risk (the T2022-quote smoke). Only if it passes,
   build `launchlab.js` + the routing + keeper/stats branches, then **audit** before
   any mainnet launch — same gate as the RH v4-hook curve and the staking program.

## Open questions to settle in Phase 0
1. Does a LaunchLab config accept a **Token-2022 quote mint**? (StonkFun implies yes;
   confirm the exact instruction + who may create the config.)
2. Custom-quote config: self-serve, or Raydium-permissioned?
3. CPMM graduation params + LP-lock mechanics for a T2022-quoted pool.
4. Does the keeper's fee-claim + reward-swap work when the *quote* (and thus the
   accrued fees) is a Token-2022 stock? (Jupiter can route T2022; confirm the ATA +
   transfer-fee handling.)
