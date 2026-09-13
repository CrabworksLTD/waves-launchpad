// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {PoolManager} from "@uniswap/v4-core/src/PoolManager.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {PoolId} from "@uniswap/v4-core/src/types/PoolId.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {IHooks} from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import {MockERC20} from "solmate/src/test/utils/mocks/MockERC20.sol";
import {HookMiner} from "../contracts/v4lib/HookMiner.sol";
import {WavesCurveHook} from "../contracts/WavesCurveHook.sol";
import {WavesHookRouter} from "../contracts/WavesHookRouter.sol";
import {WavesToken} from "../contracts/WavesToken.sol";
import {WavesQuoteAggregator, LegKey, IWavesSwapRouter, IWavesHookRouter} from "../contracts/WavesQuoteAggregator.sol";

/* Stand-in for WavesSwapRouter (ETH-in only, skipped in this profile). Simulates
 * an ETH→quote swap at 1:1 into an 18-dec quote, minting the quote to recipient
 * and enforcing minOut just as the real one does. */
contract MockSwapRouter is IWavesSwapRouter {
    MockERC20 public immutable quote;
    constructor(MockERC20 q) { quote = q; }
    function swap(LegKey calldata, uint256 minOut, address recipient) external payable returns (uint256 out) {
        out = msg.value;
        require(out >= minOut, "minOut");
        quote.mint(recipient, out);
    }
    function swap2(LegKey calldata, LegKey calldata, uint256 minOut, address recipient)
        external payable returns (uint256 out)
    {
        out = msg.value;
        require(out >= minOut, "minOut");
        quote.mint(recipient, out);
    }
    receive() external payable {}
}

/**
 * Proves the ETH zap: pay ETH, land a quote-asset-paired token in one call, with
 * min-out enforced and nothing left behind. Composes the REAL hook + router with
 * a mock ETH→quote swap leg.
 */
contract WavesQuoteAggregatorTest is Test {
    PoolManager manager;
    WavesCurveHook hook;
    WavesHookRouter router;
    MockSwapRouter swap;
    WavesQuoteAggregator agg;
    MockERC20 quote;

    address platform = address(0xA11CE);
    address creator = address(0xC0FFEE);
    address buyer = address(0xB0BB);

    uint256 constant GRAD = 4 ether;
    uint256 constant VETH = 1.41 ether;
    uint256 constant VTOK = 1_073_000_000e18;
    uint256 constant SUPPLY = 1_000_000_000e18;
    uint160 constant FLAGS = uint160(0x2888);

    address token;
    PoolKey key;

    function setUp() public {
        manager = new PoolManager(address(this));
        bytes memory args = abi.encode(IPoolManager(address(manager)), platform, GRAD, VETH, VTOK, SUPPLY);
        (address hookAddr, bytes32 salt) =
            HookMiner.find(address(this), FLAGS, type(WavesCurveHook).creationCode, args);
        hook = new WavesCurveHook{salt: salt}(IPoolManager(address(manager)), platform, GRAD, VETH, VTOK, SUPPLY);
        assertEq(address(hook), hookAddr);
        router = new WavesHookRouter(IPoolManager(address(manager)), address(hook));

        quote = new MockERC20("Quote", "Q", 18);
        vm.prank(platform);
        hook.setQuote(address(quote), true, uint96(GRAD));
        vm.prank(creator);
        token = hook.launch("Paired", "PAIR", 100, "l", "d", "s", address(quote), 0);

        (address c0, address c1) =
            address(quote) < token ? (address(quote), token) : (token, address(quote));
        key = PoolKey({
            currency0: Currency.wrap(c0), currency1: Currency.wrap(c1),
            fee: 0, tickSpacing: 60, hooks: IHooks(address(hook))
        });

        swap = new MockSwapRouter(quote);
        agg = new WavesQuoteAggregator(IWavesSwapRouter(address(swap)), IWavesHookRouter(address(router)));
    }

    function _leg() internal view returns (LegKey memory) {
        return LegKey({currency0: address(0), currency1: address(quote), fee: 0, tickSpacing: 60, hooks: address(0)});
    }

    function _raised() internal view returns (uint96 raised) {
        (,,,,, raised,,,,,,,) = hook.curves(key.toId());
    }

    function test_zap_buys_a_quoted_token_with_eth() public {
        vm.deal(buyer, 1 ether);
        vm.prank(buyer);
        uint256 out = agg.buyWithEth{value: 0.5 ether}(
            token, address(quote), _leg(), 0.4 ether, 1, buyer, block.timestamp
        );
        assertGt(out, 0, "zap returned no tokens");
        assertEq(WavesToken(token).balanceOf(buyer), out, "buyer did not receive the tokens");
        // the curve took the quote the zap acquired
        assertGt(uint256(_raised()), 0, "curve did not take the quote");
        // aggregator keeps nothing
        assertEq(quote.balanceOf(address(agg)), 0, "aggregator kept quote");
        assertEq(address(agg).balance, 0, "aggregator kept ETH");
    }

    function test_zap_sweeps_boundary_overfill_back_to_caller() public {
        // acquire more quote than the curve can take → hook router refunds the
        // overfill in quote to the aggregator, which sweeps it to the buyer.
        vm.deal(buyer, GRAD + 1 ether);
        vm.prank(buyer);
        agg.buyWithEth{value: GRAD + 1 ether}(
            token, address(quote), _leg(), 0, 1, buyer, block.timestamp
        );
        assertEq(uint256(_raised()), GRAD, "curve did not fill to target");
        assertGt(quote.balanceOf(buyer), 0.9 ether, "overfill not swept back to caller");
        assertEq(quote.balanceOf(address(agg)), 0, "aggregator kept the overfill");
        assertEq(address(agg).balance, 0, "aggregator kept ETH");
    }

    // L-1: a balance that arrived out of band (donation, stray transfer) is NOT
    // handed to the next caller — the sweep is scoped to this call's own leftovers.
    function test_prior_donation_is_not_swept_to_next_caller() public {
        quote.mint(address(agg), 5 ether);   // someone donates quote
        vm.deal(address(agg), 3 ether);       // and ETH
        uint256 buyerBefore = quote.balanceOf(buyer);

        vm.deal(buyer, 1 ether);
        vm.prank(buyer);
        agg.buyWithEth{value: 0.5 ether}(
            token, address(quote), _leg(), 0.4 ether, 1, buyer, block.timestamp
        );

        // the donation stays in the aggregator; the buyer got no windfall
        assertEq(quote.balanceOf(address(agg)), 5 ether, "quote donation was swept away");
        assertEq(address(agg).balance, 3 ether, "ETH donation was swept away");
        assertLt(quote.balanceOf(buyer) - buyerBefore, 1 ether, "buyer received the donation");
    }

    function test_zap_reverts_when_leg_underdelivers() public {
        vm.deal(buyer, 1 ether);
        vm.prank(buyer);
        // demand more quote out of the ETH leg than the 1:1 mock can give
        vm.expectRevert(bytes("minOut"));
        agg.buyWithEth{value: 0.5 ether}(
            token, address(quote), _leg(), 0.6 ether, 1, buyer, block.timestamp
        );
    }

    function test_zap_reverts_on_final_slippage() public {
        vm.deal(buyer, 1 ether);
        vm.prank(buyer);
        // impossible minTokensOut → the hook router's TooLittleReceived
        vm.expectRevert();
        agg.buyWithEth{value: 0.5 ether}(
            token, address(quote), _leg(), 0, type(uint256).max, buyer, block.timestamp
        );
    }

    function test_zap_deadline_reverts() public {
        vm.warp(1000);
        vm.deal(buyer, 1 ether);
        vm.prank(buyer);
        vm.expectRevert(WavesQuoteAggregator.Expired.selector);
        agg.buyWithEth{value: 0.5 ether}(token, address(quote), _leg(), 0, 1, buyer, 999);
    }

    function test_zap_zero_value_reverts() public {
        vm.prank(buyer);
        vm.expectRevert(WavesQuoteAggregator.ZeroValue.selector);
        agg.buyWithEth{value: 0}(token, address(quote), _leg(), 0, 1, buyer, block.timestamp);
    }
}
