// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {PoolManager} from "@uniswap/v4-core/src/PoolManager.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {PoolId} from "@uniswap/v4-core/src/types/PoolId.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {IHooks} from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import {HookMiner} from "../contracts/v4lib/HookMiner.sol";
import {WavesCurveHook} from "../contracts/WavesCurveHook.sol";
import {WavesHookRouter} from "../contracts/WavesHookRouter.sol";
import {WavesToken} from "../contracts/WavesToken.sol";

/**
 * The public router is the user-facing buy/sell path. These prove it delivers
 * the exact curve amount to the RECIPIENT, refunds the boundary-buy overfill to
 * the CALLER, enforces slippage + deadline, and never keeps funds itself.
 */
contract WavesHookRouterTest is Test {
    PoolManager manager;
    WavesCurveHook hook;
    WavesHookRouter router;

    address platform = address(0xA11CE);
    address creator = address(0xC0FFEE);
    address user = address(0xB0BB);      // buyer/seller (the caller)
    address recip = address(0xBEEF);     // where output should land

    uint256 constant GRAD = 4 ether;
    uint256 constant VETH = 1.41 ether;
    uint256 constant VTOK = 1_073_000_000e18;
    uint256 constant SUPPLY = 1_000_000_000e18;
    uint160 constant FLAGS = uint160(0x2888);

    function setUp() public {
        manager = new PoolManager(address(this));
        bytes memory args = abi.encode(IPoolManager(address(manager)), platform, GRAD, VETH, VTOK, SUPPLY);
        (address hookAddr, bytes32 salt) = HookMiner.find(address(this), FLAGS, type(WavesCurveHook).creationCode, args);
        hook = new WavesCurveHook{salt: salt}(IPoolManager(address(manager)), platform, GRAD, VETH, VTOK, SUPPLY);
        assertEq(address(hook), hookAddr, "hook address mismatch");
        router = new WavesHookRouter(IPoolManager(address(manager)), address(hook));
    }

    function _launch() internal returns (address token) {
        vm.prank(creator);
        token = hook.launch("Wave Test", "WTEST", 100, "logo", "desc", "socials", address(0), 0);
    }

    function _curve(address token) internal view returns (uint96 raised, uint96 left, bool full) {
        PoolKey memory key = PoolKey({
            currency0: Currency.wrap(address(0)), currency1: Currency.wrap(token),
            fee: 0, tickSpacing: 60, hooks: IHooks(address(hook))
        });
        (,,,,, raised, left, full, ,,,,) = hook.curves(key.toId());
    }

    // ── buy ───────────────────────────────────────────────────────────
    function test_buy_delivers_the_exact_curve_amount_to_the_recipient() public {
        address token = _launch();
        uint256 ethIn = 0.1 ether;
        // first buy: same math the hook runs, feeBps = 100
        uint256 fee = (ethIn * 100) / 10_000;
        uint256 inAfterFee = ethIn - fee;
        uint256 expOut = VTOK - ((VETH * VTOK) / (VETH + inAfterFee));

        vm.deal(user, 1 ether);
        vm.prank(user);
        uint256 out = router.buy{value: ethIn}(token, address(0), 0, 0, recip, block.timestamp);

        assertEq(out, expOut, "returned amount != curve");
        assertEq(WavesToken(token).balanceOf(recip), expOut, "recipient did not get the tokens");
        assertEq(WavesToken(token).balanceOf(user), 0, "caller should not receive tokens");
        (uint96 raised,,) = _curve(token);
        assertEq(uint256(raised), inAfterFee, "curve raised != net eth in");
        // router keeps nothing
        assertEq(address(router).balance, 0);
        assertEq(WavesToken(token).balanceOf(address(router)), 0);
    }

    function test_buy_refunds_overfill_to_the_caller_on_the_boundary() public {
        address token = _launch();
        uint256 sent = GRAD + 1 ether; // far more than the curve can accept
        vm.deal(user, sent);
        vm.prank(user);
        router.buy{value: sent}(token, address(0), 0, 0, recip, block.timestamp);

        (uint96 raised,, bool full) = _curve(token);
        assertTrue(full, "curve should latch full");
        uint256 accepted = sent - user.balance; // caller was refunded the rest
        assertGt(user.balance, 0, "no refund arrived");
        assertGt(accepted, 0, "nothing was accepted");
        assertLt(accepted, sent, "should not have taken everything");
        assertGt(uint256(raised), 0, "curve did not fill");
        assertEq(address(router).balance, 0, "router kept ETH");
        assertEq(WavesToken(token).balanceOf(address(router)), 0, "router kept tokens");
    }

    function test_buy_slippage_reverts() public {
        address token = _launch();
        vm.deal(user, 1 ether);
        vm.prank(user);
        vm.expectRevert(WavesHookRouter.TooLittleReceived.selector);
        router.buy{value: 0.1 ether}(token, address(0), 0, type(uint256).max, recip, block.timestamp);
    }

    function test_buy_deadline_reverts() public {
        address token = _launch();
        vm.deal(user, 1 ether);
        vm.warp(1000);
        vm.prank(user);
        vm.expectRevert(WavesHookRouter.Expired.selector);
        router.buy{value: 0.1 ether}(token, address(0), 0, 0, recip, 999);
    }

    // ── sell ──────────────────────────────────────────────────────────
    function test_sell_returns_eth_to_the_recipient() public {
        address token = _launch();
        // user buys first (to itself), then sells
        vm.deal(user, 1 ether);
        vm.prank(user);
        uint256 bought = router.buy{value: 0.5 ether}(token, address(0), 0, 0, user, block.timestamp);

        uint256 recipEthBefore = recip.balance;
        vm.startPrank(user);
        WavesToken(token).approve(address(router), bought);
        uint256 ethOut = router.sell(token, address(0), bought, 0, recip, block.timestamp);
        vm.stopPrank();

        assertGt(ethOut, 0, "no eth out");
        assertEq(recip.balance - recipEthBefore, ethOut, "recipient did not get the ETH");
        assertEq(WavesToken(token).balanceOf(user), 0, "tokens not consumed");
        assertEq(address(router).balance, 0, "router kept ETH");
        assertEq(WavesToken(token).balanceOf(address(router)), 0, "router kept tokens");
    }

    function test_sell_slippage_reverts() public {
        address token = _launch();
        vm.deal(user, 1 ether);
        vm.prank(user);
        uint256 bought = router.buy{value: 0.5 ether}(token, address(0), 0, 0, user, block.timestamp);
        vm.startPrank(user);
        WavesToken(token).approve(address(router), bought);
        vm.expectRevert(WavesHookRouter.TooLittleReceived.selector);
        router.sell(token, address(0), bought, type(uint256).max, recip, block.timestamp);
        vm.stopPrank();
    }

    // ── access control ────────────────────────────────────────────────
    function test_only_manager_calls_unlockCallback() public {
        vm.expectRevert(WavesHookRouter.NotManager.selector);
        router.unlockCallback("");
    }

    function test_buy_zero_reverts() public {
        address token = _launch();
        vm.prank(user);
        vm.expectRevert(WavesHookRouter.ZeroAmount.selector);
        router.buy{value: 0}(token, address(0), 0, 0, recip, block.timestamp);
    }
}
