// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Script, console2} from "forge-std/Script.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {WavesSellRouter} from "../contracts/WavesSellRouter.sol";

/**
 * Deploys WavesSellRouter — sell a quote-paired token straight to ETH
 * (token -> quote via the hook router -> ETH via the quote's ETH pool).
 *
 * Plain CREATE; record the address in evm-chains.js as `sellRouter`. Pass the
 * hook router by env so this needs no edit:
 *   WAVES_HOOK_ROUTER=0x<router> FOUNDRY_PROFILE=v4 forge script \
 *     script/DeployWavesSellRouter.s.sol --rpc-url https://rpc.mainnet.chain.robinhood.com
 * Broadcast: add --broadcast --private-key <deployer> (or --ledger --sender ..)
 */
contract DeployWavesSellRouter is Script {
    address constant POOL_MANAGER = 0x8366a39CC670B4001A1121B8F6A443A643e40951;

    function run() external {
        address hookRouter = vm.envAddress("WAVES_HOOK_ROUTER");
        require(hookRouter != address(0), "set WAVES_HOOK_ROUTER");
        vm.startBroadcast();
        WavesSellRouter r = new WavesSellRouter(IPoolManager(POOL_MANAGER), hookRouter);
        vm.stopBroadcast();
        console2.log("deployed WavesSellRouter at:", address(r));
        console2.log("  manager:", address(r.manager()));
        console2.log("  hookRouter:", r.hookRouter());
    }
}
