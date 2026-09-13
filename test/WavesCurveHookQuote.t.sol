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
import {PoolSwapTest} from "@uniswap/v4-core/src/test/PoolSwapTest.sol";
import {MockERC20} from "solmate/src/test/utils/mocks/MockERC20.sol";
import {HookMiner} from "../contracts/v4lib/HookMiner.sol";
import {WavesCurveHook} from "../contracts/WavesCurveHook.sol";
import {WavesToken} from "../contracts/WavesToken.sol";

/**
 * The ERC-20-quote generalisation: a launch may price its pool in an approved
 * ERC-20 (USDG, a tokenized stock) instead of ETH. These prove the order-aware
 * key (token sorts either side of the quote), that fees accrue AND pay in the
 * quote asset, the ERC-20 first-buy pull + boundary refund, and graduation into
 * a locked TOKEN/quote position — for BOTH currency orderings.
 */
contract WavesCurveHookQuoteTest is Test {
    PoolManager manager;
    WavesCurveHook hook;
    PoolSwapTest swapRouter;

    address platform = address(0xA11CE);
    address creator = address(0xC0FFEE);
    address buyer = address(0xB0BB);

    uint256 constant GRAD = 4 ether;
    uint256 constant VETH = 1.41 ether;
    uint256 constant VTOK = 1_073_000_000e18;
    uint256 constant SUPPLY = 1_000_000_000e18;
    uint160 constant FLAGS = uint160(0x2888);

    uint160 constant MIN_SQRT = 4295128739;
    uint160 constant MAX_SQRT = 1461446703485210103287273052203988822378723970342;

    function setUp() public {
        manager = new PoolManager(address(this));
        swapRouter = new PoolSwapTest(manager);
        bytes memory args = abi.encode(IPoolManager(address(manager)), platform, GRAD, VETH, VTOK, SUPPLY);
        (address hookAddr, bytes32 salt) =
            HookMiner.find(address(this), FLAGS, type(WavesCurveHook).creationCode, args);
        hook = new WavesCurveHook{salt: salt}(IPoolManager(address(manager)), platform, GRAD, VETH, VTOK, SUPPLY);
        assertEq(address(hook), hookAddr, "hook address mismatch");
    }

    // ── helpers ────────────────────────────────────────────────────────
    function _key(address token, address quote) internal view returns (PoolKey memory key, bool tokenIs1) {
        (address c0, address c1) = quote < token ? (quote, token) : (token, quote);
        tokenIs1 = (c1 == token);
        key = PoolKey({
            currency0: Currency.wrap(c0),
            currency1: Currency.wrap(c1),
            fee: 0,
            tickSpacing: 60,
            hooks: IHooks(address(hook))
        });
    }

    /* Launch a quote-asset pool whose ordering matches `wantTokenIs1`. Both the
     * fresh token and each candidate quote get new addresses, so retrying lands
     * on either ordering; capped so a test never spins forever. */
    function _launchQuoted(bool wantTokenIs1, uint96 gradQuote, uint8 dec)
        internal
        returns (address token, address quote, PoolKey memory key)
    {
        for (uint256 i = 0; i < 120; i++) {
            MockERC20 q = new MockERC20("Quote", "Q", dec);
            vm.prank(platform);
            hook.setQuote(address(q), true, gradQuote);
            vm.prank(creator);
            address t = hook.launch("Paired", "PAIR", 100, "logo", "desc", "socials", address(q), 0);
            bool tokenIs1 = address(q) < t;
            if (tokenIs1 == wantTokenIs1) {
                (key,) = _key(t, address(q));
                return (t, address(q), key);
            }
        }
        revert("could not find the requested ordering");
    }

    // buy `amountIn` of the quote asset into `token`
    function _buy(address token, address quote, PoolKey memory key, bool tokenIs1, uint256 amountIn) internal {
        MockERC20(quote).mint(buyer, amountIn);
        vm.startPrank(buyer);
        MockERC20(quote).approve(address(swapRouter), amountIn);
        bool zeroForOne = tokenIs1; // buy = quote->token; quote is currency0 iff tokenIs1
        swapRouter.swap(
            key,
            SwapParams({
                zeroForOne: zeroForOne,
                amountSpecified: -int256(amountIn),
                sqrtPriceLimitX96: zeroForOne ? MIN_SQRT + 1 : MAX_SQRT - 1
            }),
            PoolSwapTest.TestSettings({takeClaims: false, settleUsingBurn: false}),
            ""
        );
        vm.stopPrank();
    }

    function _curve(PoolKey memory key)
        internal
        view
        returns (uint96 raised, uint96 left, bool full, bool grad, address quote, bool tokenIs1)
    {
        (,,,,, raised, left, full, grad, quote, tokenIs1,,) = hook.curves(key.toId());
    }

    // ── launch + ordering ───────────────────────────────────────────────
    function test_launch_quoted_records_the_quote_and_ordering() public {
        for (uint256 k = 0; k < 2; k++) {
            bool want = k == 0;
            (address token, address quote, PoolKey memory key) = _launchQuoted(want, uint96(GRAD), 18);
            (uint96 raised, uint96 left,,, address q, bool tokenIs1) = _curve(key);
            assertEq(q, quote, "quote not recorded");
            assertEq(tokenIs1, want, "ordering not recorded");
            assertEq(raised, 0);
            assertEq(uint256(left), SUPPLY);
            assertEq(manager.balanceOf(address(hook), uint256(uint160(token))), SUPPLY, "supply not deposited as claim");
        }
    }

    // ── buy accrues + prices in the quote, both orderings ────────────────
    function test_buy_quoted_matches_curve_and_accrues_in_quote() public {
        for (uint256 k = 0; k < 2; k++) {
            bool want = k == 0;
            (address token, address quote, PoolKey memory key) = _launchQuoted(want, uint96(GRAD), 18);
            (,,,,, bool tokenIs1) = _curve(key);

            uint256 amountIn = 0.1 ether;
            uint256 vQuote = (uint256(GRAD) * VETH) / GRAD; // == VETH for an 18-dec grad==GRAD
            uint256 fee = (amountIn * 100) / 10_000;
            uint256 inAfterFee = amountIn - fee;
            uint256 expOut = VTOK - (vQuote * VTOK) / (vQuote + inAfterFee);

            _buy(token, quote, key, tokenIs1, amountIn);

            assertEq(WavesToken(token).balanceOf(buyer), expOut, "buyer got the wrong amount");
            (uint96 raised, uint96 left,,,,) = _curve(key);
            assertEq(uint256(raised), inAfterFee, "raised != net quote in");
            assertEq(uint256(left), SUPPLY - expOut, "tokensLeft wrong");
            // fees accrue in the QUOTE asset, not ETH
            assertGt(hook.owed(platform, quote), 0, "platform earned nothing in the quote");
            assertEq(hook.owed(platform, address(0)), 0, "platform must not accrue ETH on a quoted pool");
        }
    }

    // ── sell returns the quote asset ─────────────────────────────────────
    function test_sell_quoted_returns_the_quote() public {
        (address token, address quote, PoolKey memory key) = _launchQuoted(true, uint96(GRAD), 18);
        (,,,,, bool tokenIs1) = _curve(key);
        _buy(token, quote, key, tokenIs1, 0.5 ether);

        uint256 held = WavesToken(token).balanceOf(buyer);
        assertGt(held, 0);
        uint256 sellAmt = held / 2;
        uint256 qBefore = MockERC20(quote).balanceOf(buyer);

        vm.startPrank(buyer);
        WavesToken(token).approve(address(swapRouter), sellAmt);
        bool zeroForOne = !tokenIs1; // sell = token->quote
        swapRouter.swap(
            key,
            SwapParams({
                zeroForOne: zeroForOne,
                amountSpecified: -int256(sellAmt),
                sqrtPriceLimitX96: zeroForOne ? MIN_SQRT + 1 : MAX_SQRT - 1
            }),
            PoolSwapTest.TestSettings({takeClaims: false, settleUsingBurn: false}),
            ""
        );
        vm.stopPrank();

        assertGt(MockERC20(quote).balanceOf(buyer), qBefore, "seller got no quote back");
    }

    // ── claim pays the quote asset ───────────────────────────────────────
    function test_claim_pays_the_quote_asset() public {
        (address token, address quote, PoolKey memory key) = _launchQuoted(false, uint96(GRAD), 18);
        (,,,,, bool tokenIs1) = _curve(key);
        _buy(token, quote, key, tokenIs1, 1 ether);

        uint256 owedQuote = hook.owed(platform, quote);
        assertGt(owedQuote, 0);
        uint256 before = MockERC20(quote).balanceOf(platform);
        vm.prank(platform);
        hook.claim(quote);
        assertEq(MockERC20(quote).balanceOf(platform), before + owedQuote, "claim paid the wrong quote amount");
        assertEq(hook.owed(platform, quote), 0, "owed not cleared");
    }

    // ── ERC-20 first buy: pulled from the creator, atomic, refunds overfill ─
    function test_erc20_first_buy_and_boundary_refund() public {
        // register a quote and launch with a first buy that OVERFILLS the curve
        MockERC20 q = new MockERC20("Quote", "Q", 18);
        vm.prank(platform);
        hook.setQuote(address(q), true, uint96(GRAD));

        uint256 firstBuy = GRAD + 1 ether;
        q.mint(creator, firstBuy);
        vm.startPrank(creator);
        q.approve(address(hook), firstBuy);
        address token = hook.launch("Paired", "PAIR", 100, "l", "d", "s", address(q), firstBuy);
        vm.stopPrank();

        (PoolKey memory key,) = _key(token, address(q));
        (uint96 raised,, bool full,,,) = _curve(key);
        assertEq(uint256(raised), GRAD, "first buy did not fill to target");
        assertTrue(full, "not latched full");
        // the overfill came back to the creator in the quote asset
        assertGt(q.balanceOf(creator), 0.9 ether, "overfill not refunded in quote");
        assertEq(q.balanceOf(address(hook)), 0, "hook stranded quote");
        assertGt(WavesToken(token).balanceOf(creator), 0, "creator got no tokens");
    }

    // ── graduation seeds a locked TOKEN/quote position, both orderings ───
    function test_graduation_quoted_seeds_locked_lp() public {
        for (uint256 k = 0; k < 2; k++) {
            bool want = k == 0;
            (address token, address quote, PoolKey memory key) = _launchQuoted(want, uint96(GRAD), 18);
            (,,,,, bool tokenIs1) = _curve(key);

            _buy(token, quote, key, tokenIs1, GRAD + 1 ether);
            (,, bool full,,,) = _curve(key);
            assertTrue(full, "curve not full");

            uint256 hookTokBefore = manager.balanceOf(address(hook), uint256(uint160(token)));
            hook.graduate(token);
            (,,, bool grad,,) = _curve(key);
            assertTrue(grad, "not graduated");

            // most of the token reserve was deployed into the LP (dust may remain)
            uint256 deployed = hookTokBefore - manager.balanceOf(address(hook), uint256(uint160(token)));
            assertGt(deployed, (hookTokBefore * 99) / 100, "graduation deployed <99% of tokens");

            // the graduated pool trades as an ordinary AMM: a fresh quote buy lands tokens
            uint256 gotBefore = WavesToken(token).balanceOf(buyer);
            _buy(token, quote, key, tokenIs1, 0.2 ether);
            assertGt(WavesToken(token).balanceOf(buyer), gotBefore, "post-grad AMM buy gave nothing");
        }
    }

    // ── 6-decimal (USDG-like) quote works end to end ─────────────────────
    function test_six_decimal_quote_buy_and_grad() public {
        uint96 gradQ = uint96(10_000e6); // graduate at 10k of a 6-dec stable
        (address token, address quote, PoolKey memory key) = _launchQuoted(true, gradQ, 6);
        (,,,,, bool tokenIs1) = _curve(key);
        _buy(token, quote, key, tokenIs1, 100e6); // buy with 100 USDG-equivalents
        assertGt(WavesToken(token).balanceOf(buyer), 0, "6-dec buy gave no tokens");
        assertGt(hook.owed(platform, quote), 0, "no fee accrued in the 6-dec quote");
        // fill and graduate
        _buy(token, quote, key, tokenIs1, uint256(gradQ) + 1_000e6);
        (,, bool full,,,) = _curve(key);
        assertTrue(full, "6-dec curve did not fill");
        hook.graduate(token);
        (,,, bool grad,,) = _curve(key);
        assertTrue(grad, "6-dec pool did not graduate");
    }

    // ── registry gating ──────────────────────────────────────────────────
    function test_launch_with_unapproved_quote_reverts() public {
        MockERC20 q = new MockERC20("Nope", "NO", 18);
        vm.prank(creator);
        vm.expectRevert(WavesCurveHook.QuoteNotApproved.selector);
        hook.launch("X", "X", 100, "", "", "", address(q), 0);
    }

    function test_setQuote_is_platform_only() public {
        MockERC20 q = new MockERC20("Q", "Q", 18);
        vm.prank(creator);
        vm.expectRevert(WavesCurveHook.NotPlatform.selector);
        hook.setQuote(address(q), true, uint96(GRAD));
        // platform can, and then a launch succeeds
        vm.prank(platform);
        hook.setQuote(address(q), true, uint96(GRAD));
        vm.prank(creator);
        hook.launch("X", "X", 100, "", "", "", address(q), 0);
    }

    function test_eth_quote_still_default_and_zero_addr_approved() public {
        // address(0) is seeded enabled in the constructor
        (bool enabled, uint96 g) = hook.approvedQuotes(address(0));
        assertTrue(enabled, "ETH not approved by default");
        assertEq(uint256(g), GRAD, "ETH grad target wrong");
    }

    // ── M-1: the DERIVED virtual reserve is floored, not just the target ──
    // With this template virtualQuote = graduationQuote × VETH/GRAD = ×0.3525, so
    // a target below ~2.84e6 derives a reserve under MIN_VIRTUAL_QUOTE (1e6): zero
    // for a target of 1–2 (launch would panic), single digits for a few more (the
    // constant product degenerates and the first buy walks most of the supply).
    function test_setQuote_rejects_degenerate_derived_reserve() public {
        address q = address(new MockERC20("Q", "Q", 18));
        vm.startPrank(platform);
        vm.expectRevert(WavesCurveHook.BadConfig.selector);
        hook.setQuote(q, true, 2); // derives 0
        vm.expectRevert(WavesCurveHook.BadConfig.selector);
        hook.setQuote(q, true, 2_000_000); // derives ~705k, still < 1e6
        vm.stopPrank();
        (bool enabled,) = hook.approvedQuotes(q);
        assertFalse(enabled, "a degenerate quote must not read as enabled");
    }

    function test_setQuote_accepts_realistic_targets() public {
        // just over the floor
        address q = address(new MockERC20("Q", "Q", 18));
        vm.prank(platform);
        hook.setQuote(q, true, 4_000_000); // derives ~1.41e6 >= 1e6
        (bool e1,) = hook.approvedQuotes(q);
        assertTrue(e1, "target just over the floor should be accepted");
        // and a real USDG-scale target ($12k, 6dp) — the auditor's passing control
        address u = address(new MockERC20("U", "U", 6));
        vm.prank(platform);
        hook.setQuote(u, true, uint96(12_000e6)); // derives ~4.2e9
        (bool e2,) = hook.approvedQuotes(u);
        assertTrue(e2, "a realistic USDG target should be accepted");
    }

    function test_setQuotes_batch_rejects_degenerate() public {
        address[] memory qs = new address[](2);
        uint96[] memory gs = new uint96[](2);
        qs[0] = address(new MockERC20("A", "A", 18));
        gs[0] = uint96(12_000e6); // fine
        qs[1] = address(new MockERC20("B", "B", 18));
        gs[1] = 5; // degenerate — must sink the whole batch
        vm.prank(platform);
        vm.expectRevert(WavesCurveHook.BadConfig.selector);
        hook.setQuotes(qs, gs);
    }

    // M-1 (informational follow-up): the constructor seeds the ETH quote, whose
    // derived reserve is exactly virtualEth — so it must clear the same floor.
    function test_constructor_rejects_degenerate_virtualEth() public {
        vm.expectRevert(bytes("virtualEth below floor"));
        new WavesCurveHook(IPoolManager(address(manager)), platform, GRAD, 1, VTOK, SUPPLY);
    }

    function test_setQuote_can_still_disable() public {
        // disabling must not trip the floor (grad 0 / enabled false)
        address q = address(new MockERC20("Q", "Q", 18));
        vm.startPrank(platform);
        hook.setQuote(q, true, 4_000_000);
        hook.setQuote(q, false, 0);
        vm.stopPrank();
        (bool enabled,) = hook.approvedQuotes(q);
        assertFalse(enabled, "quote should be disabled");
    }
}
