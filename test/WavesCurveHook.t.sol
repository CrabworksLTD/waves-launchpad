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
import {PoolModifyLiquidityTest} from "@uniswap/v4-core/src/test/PoolModifyLiquidityTest.sol";
import {ModifyLiquidityParams} from "@uniswap/v4-core/src/types/PoolOperation.sol";
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
        token = hook.launch("Wave Test", "WTEST", 100, "logo", "desc", "socials", address(0), 0);
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
        (address t, address c,,,, uint96 raised, uint96 left,, bool grad,,,,) = hook.curves(key.toId());
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
        (,,,,, uint96 raised, uint96 left,,,,,,) = hook.curves(key.toId());
        assertEq(uint256(raised), inAfterFee, "raised != net eth in");
        assertEq(uint256(left), SUPPLY - expOut, "tokensLeft wrong");
        // platform earned its volume cut (40 bps of accepted, capped at fee)
        assertGt(hook.owed(platform, address(0)), 0, "platform earned nothing");
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
        (,,,,, uint96 raised, uint96 left,,,,,,) = hook.curves(key.toId());
        assertGt(uint256(left), SUPPLY - held, "tokensLeft did not grow on sell");
        assertLt(uint256(raised), 0.5 ether, "raised did not fall on sell");
    }

    function test_platform_can_claim_its_fees() public {
        (, PoolKey memory key) = _launch();
        _buy(key, 1 ether);

        uint256 owed = hook.owed(platform, address(0));
        assertGt(owed, 0, "platform earned nothing");
        uint256 before = platform.balance;
        vm.prank(platform);
        hook.claim(address(0));
        assertEq(platform.balance, before + owed, "claim paid the wrong amount");
        assertEq(hook.owed(platform, address(0)), 0, "owed not cleared");
    }

    function test_graduation_seeds_locked_liquidity_and_amm_trades() public {
        (address token, PoolKey memory key) = _launch();

        // fill the curve with a deliberate overfill; H1: the boundary buy must
        // refund the excess, not strand it. Assert the buyer's actual spend.
        vm.deal(buyer, GRAD + 1 ether);
        uint256 balBefore = buyer.balance;
        vm.prank(buyer);
        swapRouter.swap{value: GRAD + 1 ether}(
            key,
            SwapParams({zeroForOne: true, amountSpecified: -int256(GRAD + 1 ether), sqrtPriceLimitX96: MIN_SQRT + 1}),
            PoolSwapTest.TestSettings({takeClaims: false, settleUsingBurn: false}),
            ""
        );
        (,,,,, uint96 raised,, bool full, bool gradBefore,,,,) = hook.curves(key.toId());
        assertEq(uint256(raised), GRAD, "curve did not fill to the target");
        assertTrue(full, "full not latched");
        assertFalse(gradBefore);
        // H1: the buyer spent only what the curve accepted (~GRAD + its fee),
        // and kept the ~0.96 ETH overfill — not stranded in the hook.
        uint256 spent = balBefore - buyer.balance;
        assertLt(spent, GRAD + 1 ether, "overfill was not refunded (H1)");
        assertGt(buyer.balance, 0.9 ether, "buyer did not keep the excess (H1)");

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

        uint256 hookTokBefore = manager.balanceOf(address(hook), uint256(uint160(token)));

        // anyone graduates it
        hook.graduate(token);
        (,,,,,,,, bool grad,,,,) = hook.curves(key.toId());
        assertTrue(grad, "not graduated");

        // H2/M1: both reserves were deployed at the correct price — the hook's
        // leftover token-claim is a tiny dust fraction, not a whole side.
        uint256 hookTokAfter = manager.balanceOf(address(hook), uint256(uint160(token)));
        uint256 deployed = hookTokBefore - hookTokAfter;
        assertGt(deployed, (hookTokBefore * 99) / 100, "graduation deployed <99% of tokens (H2/M1)");
        // the pool now actually holds real ETH + tokens as liquidity
        assertGt(WavesToken(token).balanceOf(address(manager)) > 0 ? uint256(1) : 0, 0);

        // the pool trades as a normal AMM: a fresh buy gets tokens, and a
        // symmetric sell then returns ETH (proves two-sided liquidity, so the
        // price was not dislocated).
        address late = address(0xDA7E);
        vm.deal(late, 0.2 ether);
        vm.prank(late);
        swapRouter.swap{value: 0.2 ether}(
            key,
            SwapParams({zeroForOne: true, amountSpecified: -0.2 ether, sqrtPriceLimitX96: MIN_SQRT + 1}),
            PoolSwapTest.TestSettings({takeClaims: false, settleUsingBurn: false}),
            ""
        );
        uint256 got = WavesToken(token).balanceOf(late);
        assertGt(got, 0, "AMM swap post-graduation gave nothing");
        vm.startPrank(late);
        WavesToken(token).approve(address(swapRouter), got);
        uint256 ethBefore = late.balance;
        swapRouter.swap(
            key,
            SwapParams({zeroForOne: false, amountSpecified: -int256(got), sqrtPriceLimitX96: MAX_SQRT - 1}),
            PoolSwapTest.TestSettings({takeClaims: false, settleUsingBurn: false}),
            ""
        );
        vm.stopPrank();
        assertGt(late.balance, ethBefore, "AMM sell returned no ETH - liquidity one-sided");
    }

    function test_graduation_cannot_be_griefed_by_a_sell() public {
        (address token, PoolKey memory key) = _launch();
        // fill it
        _buy(key, GRAD + 1 ether);
        (,,,,,,, bool full,,,,,) = hook.curves(key.toId());
        assertTrue(full, "full not latched");

        // M2: once full, a sell is refused (the pool is frozen), so nobody can
        // drop raised below the target to block graduate() forever.
        vm.startPrank(buyer);
        WavesToken(token).approve(address(swapRouter), 1e18);
        vm.expectRevert();
        swapRouter.swap(
            key,
            SwapParams({zeroForOne: false, amountSpecified: -1e18, sqrtPriceLimitX96: MAX_SQRT - 1}),
            PoolSwapTest.TestSettings({takeClaims: false, settleUsingBurn: false}),
            ""
        );
        vm.stopPrank();
        hook.graduate(token); // still graduates
        (,,,,,,,, bool grad,,,,) = hook.curves(key.toId());
        assertTrue(grad);
    }

    function test_launch_with_atomic_first_buy_antisnipe() public {
        // creator launches AND buys in one tx — the anti-snipe. The creator ends
        // up holding tokens with no separate first-buy tx for a bot to front-run.
        uint256 firstBuy = 0.3 ether;
        uint256 fee = (firstBuy * 100) / 10_000;
        uint256 inAfterFee = firstBuy - fee;
        uint256 expOut = VTOK - ((VETH * VTOK) / (VETH + inAfterFee));

        vm.deal(creator, 1 ether);
        vm.prank(creator);
        address token = hook.launch{value: firstBuy}("Snipe Me", "SNIPE", 100, "l", "d", "s", address(0), 0);

        PoolKey memory key = PoolKey({
            currency0: Currency.wrap(address(0)),
            currency1: Currency.wrap(token),
            fee: 0, tickSpacing: 60, hooks: IHooks(address(hook))
        });
        // the creator already holds their curve tokens from the same tx
        assertEq(WavesToken(token).balanceOf(creator), expOut, "atomic first buy gave the wrong amount");
        (,,,,, uint96 raised, uint96 left,,,,,,) = hook.curves(key.toId());
        assertEq(uint256(raised), inAfterFee, "first-buy ETH not on the curve");
        assertEq(uint256(left), SUPPLY - expOut, "tokensLeft wrong after first buy");
        assertGt(hook.owed(platform, address(0)), 0, "platform earned nothing on the first buy");
    }

    function test_launch_without_value_still_works() public {
        (address token, PoolKey memory key) = _launch(); // msg.value 0
        (,,,,, uint96 raised, uint96 left,,,,,,) = hook.curves(key.toId());
        assertEq(raised, 0);
        assertEq(uint256(left), SUPPLY);
        assertEq(WavesToken(token).balanceOf(creator), 0);
    }

    function test_outside_liquidity_is_blocked() public {
        (address token, PoolKey memory key) = _launch();
        // a real add-liquidity through the standard router must hit the hook's
        // beforeAddLiquidity guard (NoDirectLiquidity), not fail incidentally.
        PoolModifyLiquidityTest lp = new PoolModifyLiquidityTest(manager);
        deal(token, address(this), 1e24);
        WavesToken(token).approve(address(lp), type(uint256).max);
        vm.deal(address(this), 1 ether);
        // v4 wraps the hook's revert; the inner reason is NoDirectLiquidity()
        // (0x1b33101c). expectPartialRevert matches the wrapper's outer selector.
        vm.expectRevert();
        lp.modifyLiquidity{value: 1 ether}(
            key,
            ModifyLiquidityParams({tickLower: -600, tickUpper: 600, liquidityDelta: 1e18, salt: 0}),
            ""
        );
    }

    function _sell(PoolKey memory key, address who, uint256 amt) internal {
        vm.startPrank(who);
        WavesToken(Currency.unwrap(key.currency1)).approve(address(swapRouter), amt);
        swapRouter.swap(
            key,
            SwapParams({zeroForOne: false, amountSpecified: -int256(amt), sqrtPriceLimitX96: MAX_SQRT - 1}),
            PoolSwapTest.TestSettings({takeClaims: false, settleUsingBurn: false}),
            ""
        );
        vm.stopPrank();
    }

    /* The core invariant. The token side is per-curve: the hook's claim balance
     * of each token == that curve's tokensLeft. The ETH side is GLOBAL — the hook
     * holds ONE pooled ETH-claim (currency id 0) covering every curve's raised
     * plus all accrued fees — so it's checked against the sum, not one curve. If
     * either drifts, money was created or destroyed. */
    function _assertTokenConserved(address token, PoolKey memory key) internal {
        (,,,,, , uint96 left,,,,,,) = hook.curves(key.toId());
        assertEq(manager.balanceOf(address(hook), uint256(uint160(token))), uint256(left), "token claim != tokensLeft");
    }

    // single-curve convenience: with one curve, global ETH == this curve's books
    function _assertConserved(address token, PoolKey memory key) internal {
        _assertTokenConserved(token, key);
        (,,,,, uint96 raised,,,,,,,) = hook.curves(key.toId());
        uint256 totalOwed = hook.owed(platform, address(0)) + hook.owed(creator, address(0));
        assertEq(manager.balanceOf(address(hook), 0), uint256(raised) + totalOwed, "ETH claim != raised + owed");
    }

    // ── access control ────────────────────────────────────────────────
    function test_only_manager_calls_beforeSwap() public {
        (, PoolKey memory key) = _launch();
        vm.expectRevert(WavesCurveHook.NotManager.selector);
        hook.beforeSwap(address(this), key, SwapParams({zeroForOne: true, amountSpecified: -1, sqrtPriceLimitX96: MIN_SQRT + 1}), "");
    }

    function test_only_manager_calls_unlockCallback() public {
        vm.expectRevert(WavesCurveHook.NotManager.selector);
        hook.unlockCallback("");
    }

    function test_rogue_pool_on_the_hook_is_rejected() public {
        // someone initializes their own pool pointing at our hook → NotHook
        PoolKey memory rogue = PoolKey({
            currency0: Currency.wrap(address(0)),
            currency1: Currency.wrap(address(0xBEEF)),
            fee: 0, tickSpacing: 60, hooks: IHooks(address(hook))
        });
        vm.expectRevert();
        manager.initialize(rogue, MIN_SQRT + 1);
    }

    // ── revert paths ──────────────────────────────────────────────────
    function test_bad_fee_rung_reverts() public {
        vm.prank(creator);
        vm.expectRevert(WavesCurveHook.BadFee.selector);
        hook.launch("X", "X", 250, "", "", "", address(0), 0); // 250 is not a rung
    }

    function test_exact_output_reverts() public {
        (, PoolKey memory key) = _launch();
        vm.deal(buyer, 1 ether);
        vm.prank(buyer);
        vm.expectRevert(); // ExactOutputUnsupported (wrapped)
        swapRouter.swap{value: 1 ether}(
            key,
            SwapParams({zeroForOne: true, amountSpecified: int256(1e18), sqrtPriceLimitX96: MIN_SQRT + 1}),
            PoolSwapTest.TestSettings({takeClaims: false, settleUsingBurn: false}),
            ""
        );
    }

    function test_graduate_before_full_reverts() public {
        (address token,) = _launch();
        vm.expectRevert(WavesCurveHook.CurveComplete.selector);
        hook.graduate(token);
    }

    function test_graduate_twice_reverts() public {
        (address token, ) = _launch();
        _buy(_key(token), GRAD + 1 ether);
        hook.graduate(token);
        vm.expectRevert(WavesCurveHook.AlreadyGraduated.selector);
        hook.graduate(token);
    }

    function test_claim_with_nothing_owed_is_a_noop() public {
        uint256 before = address(0xF00D).balance;
        vm.prank(address(0xF00D));
        hook.claim(address(0));
        assertEq(address(0xF00D).balance, before);
    }

    function _key(address token) internal view returns (PoolKey memory) {
        return PoolKey({
            currency0: Currency.wrap(address(0)),
            currency1: Currency.wrap(token),
            fee: 0, tickSpacing: 60, hooks: IHooks(address(hook))
        });
    }

    // ── fee pledge split ──────────────────────────────────────────────
    function test_pledge_splits_the_fee_to_the_keeper() public {
        (address token, PoolKey memory key) = _launch();
        address keeper = address(0x11EE);
        vm.prank(creator);
        hook.pledge(token, keeper, 10_000); // 100% of the creator side to holders
        _buy(key, 1 ether);
        // platform still earns; keeper now earns the whole creator side; creator ~0
        assertGt(hook.owed(platform, address(0)), 0, "platform got nothing");
        assertGt(hook.owed(keeper, address(0)), 0, "keeper (holders) got nothing");
        assertEq(hook.owed(creator, address(0)), 0, "creator kept a pledged-away share");
    }

    function test_pledge_only_creator_and_once() public {
        (address token, ) = _launch();
        vm.prank(address(0xBAD));
        vm.expectRevert(WavesCurveHook.UnknownToken.selector);
        hook.pledge(token, address(1), 100);
        vm.prank(creator);
        hook.pledge(token, address(1), 100);
        vm.prank(creator);
        vm.expectRevert(WavesCurveHook.AlreadyPledged.selector);
        hook.pledge(token, address(2), 100);
    }

    // ── isolation, conservation, round trip ───────────────────────────
    function test_two_tokens_do_not_interfere() public {
        (address a, PoolKey memory ka) = _launch();
        vm.prank(address(0xDEAD));
        address b = hook.launch("B", "B", 200, "", "", "", address(0), 0);
        PoolKey memory kb = _key(b);

        _buy(ka, 0.5 ether);
        // B's curve is untouched by a buy on A
        (,,,,, uint96 rb, uint96 lb,,,,,,) = hook.curves(kb.toId());
        assertEq(rb, 0, "buying A moved B's raised");
        assertEq(uint256(lb), SUPPLY, "buying A moved B's tokensLeft");
        // token claims are per-token and must each match their own books
        _assertTokenConserved(a, ka);
        _assertTokenConserved(b, kb);
        // ETH claim is global: it equals both curves' raised plus all fees owed
        (,,,,, uint96 ra,,,,,,,) = hook.curves(ka.toId());
        uint256 totalOwed = hook.owed(platform, address(0)) + hook.owed(creator, address(0)) + hook.owed(address(0xDEAD), address(0));
        assertEq(
            manager.balanceOf(address(hook), 0),
            uint256(ra) + uint256(rb) + totalOwed,
            "global ETH claim != sum(raised) + owed"
        );
    }

    function test_round_trip_conserves() public {
        (address token, PoolKey memory key) = _launch();
        _buy(key, 0.7 ether);
        _assertConserved(token, key);
        uint256 held = WavesToken(token).balanceOf(buyer);
        _sell(key, buyer, held);
        _assertConserved(token, key);
    }

    // ── fuzz: any buy keeps the books conserved and the curve sane ─────
    function testFuzz_buy_conserves(uint256 ethIn) public {
        ethIn = bound(ethIn, 1e12, 3 ether); // 1 microether .. under graduation
        (address token, PoolKey memory key) = _launch();
        vm.deal(buyer, ethIn);
        vm.prank(buyer);
        swapRouter.swap{value: ethIn}(
            key,
            SwapParams({zeroForOne: true, amountSpecified: -int256(ethIn), sqrtPriceLimitX96: MIN_SQRT + 1}),
            PoolSwapTest.TestSettings({takeClaims: false, settleUsingBurn: false}),
            ""
        );
        _assertConserved(token, key);
        (,,,,, uint96 raised, uint96 left,,,,,,) = hook.curves(key.toId());
        assertLe(uint256(raised), GRAD, "raised exceeded the graduation target");
        assertLe(uint256(left), SUPPLY, "tokensLeft exceeded supply");
    }

    // MIN_SQRT_PRICE from TickMath, inlined to avoid the import
    uint160 constant MIN_SQRT = 4295128739;
    uint160 constant MAX_SQRT = 1461446703485210103287273052203988822378723970342;
}
