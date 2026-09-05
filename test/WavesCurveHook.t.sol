// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {PoolManager} from "@uniswap/v4-core/src/PoolManager.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {PoolId} from "@uniswap/v4-core/src/types/PoolId.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {IHooks} from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import {SwapParams} from "@uniswap/v4-core/src/types/PoolOperation.sol";
import {BalanceDelta} from "@uniswap/v4-core/src/types/BalanceDelta.sol";
import {PoolSwapTest} from "@uniswap/v4-core/src/test/PoolSwapTest.sol";
import {HookMiner} from "../contracts/v4lib/HookMiner.sol";
import {WavesCurveHook} from "../contracts/WavesCurveHook.sol";
import {WavesToken} from "../contracts/WavesToken.sol";

/**
 * Proves the hook prices a swap against the WAVES curve and settles the exact
 * amounts — the money-critical accounting. Runs on a local PoolManager (no RH
 * RPC), which is the deterministic first gate before fork tests.
 */
contract WavesCurveHookTest is Test {
    PoolManager manager;
    WavesCurveHook hook;
    PoolSwapTest swapRouter;

    address platform = address(0xA11CE);
    address creator = address(0xC0FFEE);
    address buyer = address(0xB0BB);

    // same template the standalone curve documents
    uint256 constant GRAD = 4 ether;
    uint256 constant VETH = 1.41 ether;
    uint256 constant VTOK = 1_073_000_000e18;
    uint256 constant SUPPLY = 1_000_000_000e18;

    // beforeInitialize | beforeAddLiquidity | beforeSwap | beforeSwapReturnsDelta
    uint160 constant FLAGS = uint160(0x2888);

    function setUp() public {
        manager = new PoolManager(address(this));
        swapRouter = new PoolSwapTest(manager);

        bytes memory args = abi.encode(IPoolManager(address(manager)), platform, GRAD, VETH, VTOK, SUPPLY);
        (address hookAddr, bytes32 salt) =
            HookMiner.find(address(this), FLAGS, type(WavesCurveHook).creationCode, args);
        hook = new WavesCurveHook{salt: salt}(IPoolManager(address(manager)), platform, GRAD, VETH, VTOK, SUPPLY);
        assertEq(address(hook), hookAddr, "hook address mismatch");
    }

    function _launch() internal returns (address token, PoolKey memory key) {
        vm.prank(creator);
        token = hook.launch("Wave Test", "WTEST", 100, "logo", "desc", "socials");
        key = PoolKey({
            currency0: Currency.wrap(address(0)),
            currency1: Currency.wrap(token),
            fee: 0,
            tickSpacing: 60,
            hooks: IHooks(address(hook))
        });
    }

    function test_launch_opens_a_live_pool() public {
        (address token, PoolKey memory key) = _launch();
        (address t, address c,,,, uint96 raised, uint96 left, bool grad) = hook.curves(key.toId());
        assertEq(t, token);
        assertEq(c, creator);
        assertEq(raised, 0);
        assertEq(uint256(left), SUPPLY);
        assertFalse(grad);
        // the whole point: the token's supply sits on the hook, ready to sell
        assertEq(WavesToken(token).balanceOf(address(hook)), SUPPLY);
    }

    function test_buy_matches_the_curve_math() public {
        (address token, PoolKey memory key) = _launch();

        uint256 ethIn = 0.1 ether;
        // expected out, computed exactly as the contract does (feeBps = 100)
        uint256 fee = (ethIn * 100) / 10_000;
        uint256 inAfterFee = ethIn - fee;
        uint256 expOut = VTOK - ((VETH * VTOK) / (VETH + inAfterFee));

        vm.deal(buyer, 1 ether);
        vm.prank(buyer);
        swapRouter.swap{value: ethIn}(
            key,
            SwapParams({zeroForOne: true, amountSpecified: -int256(ethIn), sqrtPriceLimitX96: MIN_SQRT + 1}),
            PoolSwapTest.TestSettings({takeClaims: false, settleUsingBurn: false}),
            ""
        );

        assertEq(WavesToken(token).balanceOf(buyer), expOut, "buyer got the wrong token amount");
        (,,,,, uint96 raised, uint96 left,) = hook.curves(key.toId());
        assertEq(uint256(raised), inAfterFee, "raised != net eth in");
        assertEq(uint256(left), SUPPLY - expOut, "tokensLeft wrong");
        // platform earned its volume cut (40 bps of accepted, capped at fee)
        assertGt(hook.owed(platform), 0, "platform earned nothing");
    }

    function test_outside_liquidity_is_blocked() public {
        (, PoolKey memory key) = _launch();
        vm.expectRevert();
        manager.unlock(abi.encode(key)); // any external add-liquidity path is refused
    }

    // MIN_SQRT_PRICE from TickMath, inlined to avoid the import
    uint160 constant MIN_SQRT = 4295128739;
}
