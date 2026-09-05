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
        // the supply is deposited into the manager as the hook's 6909 claim
        assertEq(WavesToken(token).balanceOf(address(manager)), SUPPLY);
        assertEq(manager.balanceOf(address(hook), uint256(uint160(token))), SUPPLY);
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

    function _buy(PoolKey memory key, uint256 ethIn) internal {
        vm.deal(buyer, ethIn);
        vm.prank(buyer);
        swapRouter.swap{value: ethIn}(
            key,
            SwapParams({zeroForOne: true, amountSpecified: -int256(ethIn), sqrtPriceLimitX96: MIN_SQRT + 1}),
            PoolSwapTest.TestSettings({takeClaims: false, settleUsingBurn: false}),
            ""
        );
    }

    function test_sell_returns_eth_and_reprices() public {
        (address token, PoolKey memory key) = _launch();
        _buy(key, 0.5 ether);

        uint256 held = WavesToken(token).balanceOf(buyer);
        assertGt(held, 0);

        // sell half of it back
        uint256 sellAmt = held / 2;
        vm.startPrank(buyer);
        WavesToken(token).approve(address(swapRouter), sellAmt);
        uint256 ethBefore = buyer.balance;
        swapRouter.swap(
            key,
            SwapParams({zeroForOne: false, amountSpecified: -int256(sellAmt), sqrtPriceLimitX96: MAX_SQRT - 1}),
            PoolSwapTest.TestSettings({takeClaims: false, settleUsingBurn: false}),
            ""
        );
        vm.stopPrank();

        assertGt(buyer.balance, ethBefore, "seller received no ETH");
        (,,,,, uint96 raised, uint96 left,) = hook.curves(key.toId());
        assertGt(uint256(left), SUPPLY - held, "tokensLeft did not grow on sell");
        assertLt(uint256(raised), 0.5 ether, "raised did not fall on sell");
    }

    function test_platform_can_claim_its_fees() public {
        (, PoolKey memory key) = _launch();
        _buy(key, 1 ether);

        uint256 owed = hook.owed(platform);
        assertGt(owed, 0, "platform earned nothing");
        uint256 before = platform.balance;
        vm.prank(platform);
        hook.claim();
        assertEq(platform.balance, before + owed, "claim paid the wrong amount");
        assertEq(hook.owed(platform), 0, "owed not cleared");
    }

    function test_graduation_seeds_locked_liquidity_and_amm_trades() public {
        (address token, PoolKey memory key) = _launch();

        // fill the curve: buy the whole graduation target (the clamp caps it)
        _buy(key, GRAD + 1 ether);
        (,,,,, uint96 raised,, bool gradBefore) = hook.curves(key.toId());
        assertEq(uint256(raised), GRAD, "curve did not fill to the target");
        assertFalse(gradBefore);

        // the next buy is refused — the curve is complete until it graduates
        vm.deal(buyer, 0.1 ether);
        vm.prank(buyer);
        vm.expectRevert();
        swapRouter.swap{value: 0.1 ether}(
            key,
            SwapParams({zeroForOne: true, amountSpecified: -0.1 ether, sqrtPriceLimitX96: MIN_SQRT + 1}),
            PoolSwapTest.TestSettings({takeClaims: false, settleUsingBurn: false}),
            ""
        );

        // anyone graduates it
        hook.graduate(token);
        (,,,,,,, bool grad) = hook.curves(key.toId());
        assertTrue(grad, "not graduated");

        // real, locked liquidity is now in the pool — a normal AMM buy works and
        // the hook no longer overrides (a fresh buyer gets tokens from the AMM)
        address late = address(0xDA7E);
        vm.deal(late, 0.2 ether);
        vm.prank(late);
        swapRouter.swap{value: 0.2 ether}(
            key,
            SwapParams({zeroForOne: true, amountSpecified: -0.2 ether, sqrtPriceLimitX96: MIN_SQRT + 1}),
            PoolSwapTest.TestSettings({takeClaims: false, settleUsingBurn: false}),
            ""
        );
        assertGt(WavesToken(token).balanceOf(late), 0, "AMM swap post-graduation gave nothing");
    }

    function test_outside_liquidity_is_blocked() public {
        (, PoolKey memory key) = _launch();
        vm.expectRevert();
        manager.unlock(abi.encode(key)); // any external add-liquidity path is refused
    }

    // MIN_SQRT_PRICE from TickMath, inlined to avoid the import
    uint160 constant MIN_SQRT = 4295128739;
    uint160 constant MAX_SQRT = 1461446703485210103287273052203988822378723970342;
}
