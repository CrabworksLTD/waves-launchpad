// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {PoolManager} from "@uniswap/v4-core/src/PoolManager.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {IHooks} from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import {SwapParams} from "@uniswap/v4-core/src/types/PoolOperation.sol";
import {PoolSwapTest} from "@uniswap/v4-core/src/test/PoolSwapTest.sol";
import {MockERC20} from "solmate/src/test/utils/mocks/MockERC20.sol";
import {HookMiner} from "../contracts/v4lib/HookMiner.sol";
import {WavesCurveHook} from "../contracts/WavesCurveHook.sol";
import {WavesToken} from "../contracts/WavesToken.sol";

/**
 * Adversarial probes written during review — these ask questions the existing
 * suite does not, and each one is here because the answer was not obvious from
 * reading the source.
 */
contract WavesAuditTest is Test {
    PoolManager manager;
    WavesCurveHook hook;
    PoolSwapTest swapRouter;

    address platform = address(0xA11CE);
    address creator = address(0xC0FFEE);
    address buyer = address(0xB0BB);
    address attacker = address(0xBAD);

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
        (, bytes32 salt) = HookMiner.find(address(this), FLAGS, type(WavesCurveHook).creationCode, args);
        hook = new WavesCurveHook{salt: salt}(IPoolManager(address(manager)), platform, GRAD, VETH, VTOK, SUPPLY);
    }

    function _key(address token, address quote) internal view returns (PoolKey memory key, bool tokenIs1) {
        (address c0, address c1) = quote < token ? (quote, token) : (token, quote);
        tokenIs1 = (c1 == token);
        key = PoolKey({
            currency0: Currency.wrap(c0), currency1: Currency.wrap(c1),
            fee: 0, tickSpacing: 60, hooks: IHooks(address(hook))
        });
    }

    function _buyQuoted(address quote, PoolKey memory key, bool tokenIs1, uint256 amountIn, address who) internal {
        MockERC20(quote).mint(who, amountIn);
        vm.startPrank(who);
        MockERC20(quote).approve(address(swapRouter), amountIn);
        swapRouter.swap(
            key,
            SwapParams({
                zeroForOne: tokenIs1,
                amountSpecified: -int256(amountIn),
                sqrtPriceLimitX96: tokenIs1 ? MIN_SQRT + 1 : MAX_SQRT - 1
            }),
            PoolSwapTest.TestSettings({takeClaims: false, settleUsingBurn: false}),
            ""
        );
        vm.stopPrank();
    }

    /**
     * ⚠️ FINDING — a quote whose graduation target collapses the derived virtual
     * reserve. EXPECTED TO FAIL until setQuote validates the derived reserve.
     *
     *   virtualQuote = mulDiv(graduationQuote, virtualEth, graduationEth)
     *
     * With the live template (1.41 / 4) that is graduationQuote * 0.3525, so any
     * target below 3 units floors to zero. setQuote only rejects a target of
     * exactly zero, so this configuration is reachable.
     *
     * Two regimes, both bad and neither caught:
     *   target 1-2  -> virtualQuote floors to 0, and launch() reverts with a bare
     *                  Panic(0x11) from `curveSupply - (virtualTokens - yAtGrad)`.
     *                  The quote looks enabled and every launch on it fails.
     *   target >= 3 -> virtualQuote collapses to a handful of units. The constant
     *                  product is then so small that the first buy walks most of
     *                  the curve: measured at 71.5% of total supply for TWO units
     *                  of the quote.
     *
     * setQuote already validates config (it rejects a zero target), so the shape
     * of the guard exists — it just checks the input rather than the number
     * actually derived from it.
     */
    /* FIXED (M-1). The guard now checks the number the curve actually runs on:
     * setQuote/setQuotes/launch reject any target whose DERIVED virtual reserve
     * (`graduationQuote × virtualEth/graduationEth`) falls below MIN_VIRTUAL_QUOTE.
     * Both regimes the finding described are closed at registration, so the
     * degenerate curve can never be created — this asserts the rejection rather
     * than measuring the walk it used to enable. */
    function test_AUDIT_tiny_graduation_target_zeroes_the_virtual_reserve() public {
        MockERC20 q = new MockERC20("Quote", "Q", 18);
        // target 1 -> derived reserve 0 (would have panicked at launch)
        vm.prank(platform);
        vm.expectRevert(WavesCurveHook.BadConfig.selector);
        hook.setQuote(address(q), true, 1);
        // target 3 -> derived reserve 1 (would have let a 2-unit buy walk 71.5%)
        vm.prank(platform);
        vm.expectRevert(WavesCurveHook.BadConfig.selector);
        hook.setQuote(address(q), true, 3);
        // the quote never became usable
        (bool enabled,) = hook.approvedQuotes(address(q));
        assertFalse(enabled, "a degenerate target must not leave an enabled quote");
    }

    /**
     * The same guard question from the other end: does a sane 6-decimal quote
     * (USDG-like) survive the scaling? This should PASS — it is the control that
     * shows the finding above is about the missing floor, not about small
     * decimals in general.
     */
    function test_AUDIT_six_decimal_quote_scales_sanely() public {
        MockERC20 q = new MockERC20("USDG", "USDG", 6);
        vm.prank(platform);
        hook.setQuote(address(q), true, 10_000e6);

        vm.prank(creator);
        address token = hook.launch("Ok", "OK", 100, "", "", "", address(q), 0);
        (PoolKey memory key,) = _key(token, address(q));
        (,,,,,,,,,,, , uint128 vQuote) = hook.curves(key.toId());
        emit log_named_uint("virtualQuote for a 10,000 USDG target", vQuote);
        assertGt(vQuote, 0, "a sane 6-decimal target must not floor to zero");
    }

    /**
     * Disabling a quote must not strand a live pool — the brief asks for this to
     * be confirmed rather than assumed.
     */
    function test_AUDIT_disabling_a_quote_does_not_brick_live_pools() public {
        MockERC20 q = new MockERC20("Quote", "Q", 18);
        vm.prank(platform);
        hook.setQuote(address(q), true, uint96(GRAD));
        vm.prank(creator);
        address token = hook.launch("Live", "LIVE", 100, "", "", "", address(q), 0);
        (PoolKey memory key, bool tokenIs1) = _key(token, address(q));

        vm.prank(platform);
        hook.setQuote(address(q), false, 0); // pull the quote from the registry

        _buyQuoted(address(q), key, tokenIs1, 1 ether, buyer);
        assertGt(WavesToken(token).balanceOf(buyer), 0, "an existing pool stopped trading when its quote was disabled");
    }

    /**
     * claim() must pay only the caller's own accrual, and must not be usable to
     * reach another address's balance.
     */
    function test_AUDIT_claim_cannot_reach_another_accrual() public {
        MockERC20 q = new MockERC20("Quote", "Q", 18);
        vm.prank(platform);
        hook.setQuote(address(q), true, uint96(GRAD));
        vm.prank(creator);
        address token = hook.launch("Fees", "FEE", 100, "", "", "", address(q), 0);
        (PoolKey memory key, bool tokenIs1) = _key(token, address(q));

        _buyQuoted(address(q), key, tokenIs1, 1 ether, buyer);

        uint256 creatorOwed = hook.owed(creator, address(q));
        assertGt(creatorOwed, 0, "the creator should have accrued");

        // an unrelated address claiming the same quote gets nothing and cannot
        // touch what the creator is owed
        vm.prank(attacker);
        hook.claim(address(q));
        assertEq(MockERC20(q).balanceOf(attacker), 0, "a stranger drew from the fee pot");
        assertEq(hook.owed(creator, address(q)), creatorOwed, "another account's accrual moved");
    }

    /**
     * A launch must never let the caller name a quote the registry has not
     * approved — the registry is the whole trust boundary for what a pool can be
     * denominated in.
     */
    function test_AUDIT_unapproved_quote_cannot_launch() public {
        MockERC20 q = new MockERC20("Rogue", "RG", 18);
        vm.prank(creator);
        vm.expectRevert();
        hook.launch("Rogue", "RG", 100, "", "", "", address(q), 0);
    }
}
