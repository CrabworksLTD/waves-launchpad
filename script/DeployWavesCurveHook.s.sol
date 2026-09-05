// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Script, console2} from "forge-std/Script.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {HookMiner} from "../contracts/v4lib/HookMiner.sol";
import {WavesCurveHook} from "../contracts/WavesCurveHook.sol";

/**
 * Deploys the singleton WavesCurveHook at a CREATE2-mined address whose low bits
 * carry the four permissions the hook declares (beforeInitialize |
 * beforeAddLiquidity | beforeSwap | beforeSwapReturnsDelta = 0x2888). Without the
 * mined salt, PoolManager.initialize reverts on a bad hook address.
 *
 * Run (dry, prints the address + salt):
 *   FOUNDRY_PROFILE=v4 forge script script/DeployWavesCurveHook.s.sol \
 *     --rpc-url https://rpc.mainnet.chain.robinhood.com
 * Add --broadcast --private-key <deployer> to actually deploy.
 *
 * The economics args match the standalone WavesCurve's documented template and
 * are IMMUTABLE once deployed — the deployed address is the only truthful source
 * for them thereafter.
 */
contract DeployWavesCurveHook is Script {
    // Robinhood Chain, from app/public/evm-chains.js
    address constant POOL_MANAGER = 0x8366a39CC670B4001A1121B8F6A443A643e40951;
    // ⚠️ SET THESE before broadcasting:
    address constant PLATFORM = address(0);       // WAVES fee-owner wallet
    // curve template (same as WavesCurve.sol immutables)
    uint256 constant GRAD_ETH = 4 ether;
    uint256 constant VIRTUAL_ETH = 1.41 ether;
    uint256 constant VIRTUAL_TOKENS = 1_073_000_000e18;
    uint256 constant CURVE_SUPPLY = 1_000_000_000e18;

    // beforeInitialize | beforeAddLiquidity | beforeSwap | beforeSwapReturnsDelta
    uint160 constant FLAGS = uint160(0x2888);
    // Deterministic CREATE2 proxy Foundry uses in scripts
    address constant CREATE2_DEPLOYER = 0x4e59b44847b379578588920cA78FbF26c0B4956C;

    function run() external {
        require(PLATFORM != address(0), "set PLATFORM before deploying");

        bytes memory args =
            abi.encode(IPoolManager(POOL_MANAGER), PLATFORM, GRAD_ETH, VIRTUAL_ETH, VIRTUAL_TOKENS, CURVE_SUPPLY);
        (address hookAddr, bytes32 salt) =
            HookMiner.find(CREATE2_DEPLOYER, FLAGS, type(WavesCurveHook).creationCode, args);

        console2.log("mined hook address:", hookAddr);
        console2.logBytes32(salt);

        vm.startBroadcast();
        WavesCurveHook hook = new WavesCurveHook{salt: salt}(
            IPoolManager(POOL_MANAGER), PLATFORM, GRAD_ETH, VIRTUAL_ETH, VIRTUAL_TOKENS, CURVE_SUPPLY
        );
        vm.stopBroadcast();

        require(address(hook) == hookAddr, "address mismatch");
        console2.log("deployed WavesCurveHook at:", address(hook));
    }
}
