# WAVES → GMGN launchpad listing (Robinhood Chain)

**What we're asking for:** recognize WAVES as a launchpad on Robinhood Chain so
our tokens show our badge and their images, instead of rendering as anonymous
"Uniswap V4" pools. Everything GMGN needs is already on-chain — this is a
labelling/onboarding request, not an indexing one.

## The single identifier
Every WAVES launch on Robinhood Chain — with no exceptions, forever — goes
through one contract:

- **WavesCurve (singleton):** `0x87c04ca8633a56c30e68919566c605fd970196d3`
- **Chain:** Robinhood Chain, chainId **4663**, RPC `https://rpc.mainnet.chain.robinhood.com`
- **Explorer:** https://robinhoodchain.blockscout.com (WavesCurve + every WavesToken are **source-verified** here)

A token is "a WAVES launch" **iff** its `Launched` event was emitted by that
address. There is no per-launch factory or per-launch curve — one contract holds
all of them, so this one address is the whole attribution key.

## The launch event to watch
```
Launched(address indexed token, address indexed creator, uint16 feeBps, string name, string symbol)
topic0 = 0xcf74280e4eafa3845516f297991e114213dc6a4c132199d8338fe6ba26b216e4
```
`token` (topic1) is the new ERC-20's address; `creator` (topic2) is the deployer.

## The image + metadata (on-chain, per token)
An ERC-20 has no metadata account, so each WavesToken carries its own, readable
straight off the token address — no IPFS/Arweave lookup required to *find* the
pointer, and no off-chain index that can go stale:

| call | selector | returns |
|---|---|---|
| `logo()` | `0xfb7f21eb` | image URL (PNG/JPG) |
| `description()` | `0x7284e416` | one-line description |
| `socials()` | `0x53cd512a` | JSON of links (x/telegram/website) |
| `getTokenInfo()` | `0xabb1dc44` | `(deployer, logo, description, socials)` in one call |

Live example — WAVETEST `0x9ca496ce59eb15a30d85da058db2d8155fc904d9`:
`logo()` → `https://www.waveslaunchpad.xyz/m/5bR5kmjoU4KzPCvDwuVrCLOgJiXGdctPRhUsKg9Do0E/icon.png`

(Those `/m/` URLs are our multi-gateway mirror — they answer 200 immediately at
launch and fall back across Arweave gateways, so a crawler that fetches at T+0
never caches a 404. That was a real failure mode we already closed.)

## Trading venue
Graduated tokens trade on **Uniswap V4** (singleton PoolManager
`0x8366a39cc670b4001a1121b8f6a443a643e40951`); pre-graduation they trade on the
WavesCurve bonding curve itself. The pool is **initialized by the WavesCurve**,
so the curve address is also the pool's creator.

> Note on the "Burnt/Locked LP < 80%" risk flag: pre-graduation liquidity lives
> in the bonding curve by design (same model as pump.fun / Meteora DBC), so a
> naive "is the LP locked" check reads it as unlocked. If GMGN special-cases
> known bonding-curve launchpads (as it does for pump.fun), recognizing the
> curve address above resolves this too.

## Branding for the badge
- **Name:** WAVES
- **Site:** https://waveslaunchpad.xyz
- **Logo:** `app/public/art/` — send the square mark PNG (`icon`/`pfp`).

## Contact
GMGN onboards launchpads through their team, not a public form. Reach out via
the GMGN partnerships/listing channel (their Telegram or the "list your
launchpad" contact) with this document. Ask specifically for:
1. Attribution of the curve address above as the **WAVES** launchpad (badge + name).
2. Reading token images from `logo()` (selector `0xfb7f21eb`) on each token.
3. Bonding-curve treatment for the LP risk flag, if they do that per-launchpad.
