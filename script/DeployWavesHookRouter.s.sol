// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Script, console2} from "forge-std/Script.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {WavesHookRouter} from "../contracts/WavesHookRouter.sol";

/**
 * Deploys the public WavesHookRouter — the user-facing buy/sell entry point for
 * WAVES tokens on the WavesCurveHook. Plain CREATE (no salt mining: a router has
 * no hook-permission bits to encode), so the address is not deterministic;
 * record whatever it deploys to in evm-chains.js as `v4Router`.
 *
 * Run (dry): FOUNDRY_PROFILE=v4 forge script script/DeployWavesHookRouter.s.sol \
 *              --rpc-url https://rpc.mainnet.chain.robinhood.com
 * Broadcast: add --broadcast --private-key <deployer>  (or --ledger --sender ..)
 */
contract DeployWavesHookRouter is Script {
    // Robinhood Chain V4 PoolManager (from app/public/evm-chains.js)
    address constant POOL_MANAGER = 0x8366a39CC670B4001A1121B8F6A443A643e40951;
    // The deployed singleton WavesCurveHook (recorded in evm-chains.js).
    address constant HOOK = 0xA02AAaCb311F49e7f55c4dF5b40b3cFCe0D76888;

    function run() external {
        vm.startBroadcast();
        WavesHookRouter router = new WavesHookRouter(IPoolManager(POOL_MANAGER), HOOK);
        vm.stopBroadcast();
        console2.log("deployed WavesHookRouter at:", address(router));
        console2.log("  manager:", address(router.manager()));
        console2.log("  hook:   ", router.hook());
    }
}
