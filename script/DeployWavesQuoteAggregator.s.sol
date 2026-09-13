// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Script, console2} from "forge-std/Script.sol";
import {WavesQuoteAggregator, IWavesSwapRouter, IWavesHookRouter} from "../contracts/WavesQuoteAggregator.sol";

/**
 * Deploys WavesQuoteAggregator — the ETH zap that lets a buyer pay ETH for a
 * token quoted in USDG or a stock: ETH -> quote (via WavesSwapRouter) -> token
 * (via WavesHookRouter), one tx, holding no funds.
 *
 * Plain CREATE (no salt to mine); record the address in evm-chains.js as
 * `aggregator`. Both dependencies are passed by env so this file needs no edit:
 *
 *   WAVES_SWAP=0x<WavesSwapRouter>  WAVES_HOOK_ROUTER=0x<WavesHookRouter> \
 *     FOUNDRY_PROFILE=v4 forge script script/DeployWavesQuoteAggregator.s.sol \
 *     --rpc-url https://rpc.mainnet.chain.robinhood.com
 * Broadcast: add --broadcast --private-key <deployer>  (or --ledger --sender ..)
 *
 * WAVES_SWAP is the SAME WavesSwapRouter the keeper uses (its SWAP_ROUTER /
 * RH_SWAP_ROUTER); WAVES_HOOK_ROUTER is the freshly-deployed WavesHookRouter.
 */
contract DeployWavesQuoteAggregator is Script {
    function run() external {
        address swap = vm.envAddress("WAVES_SWAP");
        address hookRouter = vm.envAddress("WAVES_HOOK_ROUTER");
        require(swap != address(0) && hookRouter != address(0), "set WAVES_SWAP and WAVES_HOOK_ROUTER");

        vm.startBroadcast();
        WavesQuoteAggregator agg = new WavesQuoteAggregator(
            IWavesSwapRouter(swap), IWavesHookRouter(hookRouter)
        );
        vm.stopBroadcast();

        console2.log("deployed WavesQuoteAggregator at:", address(agg));
        console2.log("  swapRouter:", address(agg.swapRouter()));
        console2.log("  hookRouter:", address(agg.hookRouter()));
    }
}
