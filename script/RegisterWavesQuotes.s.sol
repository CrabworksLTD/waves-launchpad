// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Script, console2} from "forge-std/Script.sol";
import {WavesCurveHook} from "../contracts/WavesCurveHook.sol";

/**
 * Approve the quote assets a launch may price its pool in. Platform-only:
 * broadcast from the hook's `platform` address (the RH feeTo). ETH is approved
 * in the hook's constructor; this adds USDG and any tokenised stocks.
 *
 * `graduationQuote` is how much of the quote a curve raises before it graduates,
 * IN THE QUOTE'S OWN UNITS (USDG has 6 decimals, the stocks 8). Pick each to hit
 * a sensible USD market cap at graduation — the hook scales the virtual reserve
 * from this, keeping the curve shape identical to the ETH template.
 *
 *   WAVES_HOOK=0x<hook> FOUNDRY_PROFILE=v4 forge script \
 *     script/RegisterWavesQuotes.s.sol --rpc-url https://rpc.mainnet.chain.robinhood.com
 * Broadcast: add --broadcast --private-key <platform key> (or --ledger --sender <platform>)
 */
contract RegisterWavesQuotes is Script {
    // Robinhood Chain USDG (6 decimals), from app/public/rh-assets.json
    address constant USDG = 0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168;

    function run() external {
        WavesCurveHook hook = WavesCurveHook(payable(vm.envAddress("WAVES_HOOK")));

        vm.startBroadcast();
        /* USDG: graduate at 12,000 USDG (~4 ETH at ~$3k), matching the ETH
         * template's target. 12_000 * 1e6 = 1.2e10 — set to whatever cap you
         * want a stablecoin-quoted launch to graduate at. */
        hook.setQuote(USDG, true, uint96(12_000 * 1e6));
        console2.log("approved USDG as a quote");

        /* Stocks (8 decimals) follow the same call — enable the ones you want to
         * offer, each with a graduation target in that stock's units. E.g. to
         * graduate an AAPLx pool at ~ $12k with AAPLx ~$180:
         *   uint96 grad = uint96((12_000e8) / 180);   // ~66.7 AAPLx
         *   hook.setQuote(AAPLX, true, grad);
         * Only enable stocks with a deep enough USDG/ETH market that the zap can
         * route into them (see the `liquid` flag in rh-assets.json). */
        vm.stopBroadcast();
    }
}
