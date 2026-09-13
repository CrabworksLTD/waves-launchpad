# Mainnet stake → claim rehearsal

The one blocker left before pairing can flip to mainnet: proving the full loop
against the real immutable program and real infra (Helius DAS, real Core NFTs), not
just the local validator the anchor tests use. `tools/staking-rehearse.js` runs the
whole loop headless; this is the operator sequence around it.

Everything the program does is already **verified** — the deployed bytecode is a
byte-identical build of the fixed source (sha256 `d4bccc29…`), and the anchor suite
passes. This rehearsal proves the *client + keeper + real-asset* path.

## What you need

1. **A funded keypair** — the rehearsal uses one wallet as launcher + staker +
   keeper (fine for a proof; production keeps the keeper separate). ~0.1 SOL covers
   rent + the wrapped reward. Point `--keypair` at a JSON secret-key file (or the
   `{secretArray}` shape in `~/waves-keys/`).
2. **A paired token you hold** — the thing that gets burned. Any SPL mint you have a
   balance of works; the cleanest is to launch a small token on WAVES.
3. **A Core NFT you own + its collection address** — the NFT is what accrues the
   reward. Launch a tiny collection on WAVES (mint yourself one), and grab the asset
   address + the collection address from the mint result.
4. **A reward mint** — default WSOL. The script wraps `--depositSol` SOL into the
   vault to simulate the keeper's deposit.

## Steps

**1. Dry run — derive everything, send nothing.** Confirms the PDAs and that the
token programs resolve correctly (classic vs Token-2022) before any funds move:

```
DRY=1 node tools/staking-rehearse.js \
  --keypair ~/waves-keys/<funded>.json \
  --token <paired token mint> \
  --collection <core collection address> \
  --asset <your NFT address> \
  --reward So11111111111111111111111111111111111111112 \
  --stake 1000000 --depositSol 0.02 \
  --rpc <your Helius URL>
```

Check the printed pool / position / vault PDAs look right. Use a Helius RPC for
`--rpc` — public nodes rate-limit the confirmations.

**2. Real run — drop `DRY=1`.** It executes, in order, printing each signature:

- `init_pool` (+ creates the pool's reward vault) — skipped if the pool exists
- `stake` — burns `--stake` of the paired token, raising the NFT's weight
- **deposit + `sync`** — wraps `--depositSol` SOL into the vault and folds it into
  the accumulator. *This is exactly what the keeper does in production;* here we do
  it inline so the loop closes.
- `claim` — pays the owner, and the script prints the reward-ATA before/after delta

**3. Read the result.** `claimed: <n> ✓ LOOP PROVEN` means the whole path works on
mainnet — the NFT staked, the reward flowed through the vault, and the owner
claimed it. That's the blocker cleared.

## After it passes

1. Flip `PAIRING_LIVE()` in `app/public/launchpanel.js` to allow mainnet (it's
   currently `cluster() === "devnet"` only).
2. Wire the keeper's LaunchLab vault-deposit path into the cron (still gated on the
   keeper audit — the rehearsal proves the *program* loop, not the keeper's
   crash-safety, which is what the audit covers).
3. The keeper then plays the role step 3 did here, automatically, per pair.

## Notes

- If `claimed: 0`, check in order: did `stake` land (weight > 0)? did the deposit +
  `sync` run (vault balance and `acc_per_weight` moved)? A deposit made while
  `total_weight == 0` correctly sits until the first stake syncs — stake before you
  deposit, as this script does.
- Non-WSOL reward: pass `--reward <mint> --depositRaw <base units>` and make sure
  the keypair holds that token; the script transfers it to the vault instead of
  wrapping SOL.
- The rehearsal is idempotent-ish: re-running re-stakes and re-deposits (weight and
  rewards accumulate); `init_pool` is skipped once the pool exists.
