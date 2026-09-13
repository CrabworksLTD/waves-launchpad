// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {PoolId} from "@uniswap/v4-core/src/types/PoolId.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {IHooks} from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import {IERC20Minimal} from "@uniswap/v4-core/src/interfaces/external/IERC20Minimal.sol";
import {HookMiner} from "../contracts/v4lib/HookMiner.sol";
import {WavesCurveHook} from "../contracts/WavesCurveHook.sol";
import {WavesHookRouter} from "../contracts/WavesHookRouter.sol";
import {WavesSellRouter} from "../contracts/WavesSellRouter.sol";
import {WavesToken} from "../contracts/WavesToken.sol";

/**
 * The sell-router's reverse zap (token -> quote -> ETH) against the REAL
 * PoolManager AND a REAL stock's ETH pool on Robinhood Chain. This is the leg a
 * local/mock test cannot vouch for: that Ford -> ETH actually settles on Ford's
 * own live pool. Uses Ford as the quote so the reverse swap hits real liquidity.
 *
 *   FOUNDRY_PROFILE=v4 forge test --match-path test/WavesSellRouter.fork.t.sol \
 *     --fork-url https://rpc.mainnet.chain.robinhood.com --evm-version cancun -vv
 *
 * ⚠️ --evm-version cancun is not optional (V4's lock is transient storage).
 * Skipped (not failed) off-fork so plain `forge test` stays green.
 */
contract WavesSellRouterForkTest is Test {
    address constant POOL_MANAGER = 0x8366a39CC670B4001A1121B8F6A443A643e40951;
    address constant FORD = 0x25C288E6D899b9BC30160965aD9644c67e73bE0C;

    WavesCurveHook hook;
    WavesHookRouter router;
    WavesSellRouter sellRouter;
    PoolKey fordEth; // Ford's canonical ETH pool (ETH=currency0)

    address platform = address(0xA11CE);
    address creator = address(0xC0FFEE);
    address buyer = address(0xB0BB);

    uint256 constant GRAD = 4 ether;
    uint256 constant VETH = 1.41 ether;
    uint256 constant VTOK = 1_073_000_000e18;
    uint256 constant SUPPLY = 1_000_000_000e18;
    // Ford is worth ~$14, so scale graduation up so a 2-Ford buy is a small
    // slice of the curve rather than nearly filling it.
    uint96 constant FORD_GRAD = 200e18;
    uint160 constant FLAGS = uint160(0x2888);

    modifier onFork() {
        if (block.chainid != 4663) return;
        _;
    }

    function setUp() public {
        if (block.chainid != 4663) return;
        bytes memory args = abi.encode(IPoolManager(POOL_MANAGER), platform, GRAD, VETH, VTOK, SUPPLY);
        (address hookAddr, bytes32 salt) =
            HookMiner.find(address(this), FLAGS, type(WavesCurveHook).creationCode, args);
        hook = new WavesCurveHook{salt: salt}(IPoolManager(POOL_MANAGER), platform, GRAD, VETH, VTOK, SUPPLY);
        require(address(hook) == hookAddr, "hook address mismatch");
        router = new WavesHookRouter(IPoolManager(POOL_MANAGER), address(hook));
        sellRouter = new WavesSellRouter(IPoolManager(POOL_MANAGER), address(router));

        vm.prank(platform);
        hook.setQuote(FORD, true, FORD_GRAD);

        fordEth = PoolKey({
            currency0: Currency.wrap(address(0)),
            currency1: Currency.wrap(FORD),
            fee: 50000,
            tickSpacing: 200,
            hooks: IHooks(address(0))
        });
    }

    function test_sell_ford_token_for_eth() public onFork {
        vm.prank(creator);
        address token = hook.launch("FordPair", "FP", 100, "l", "d", "s", FORD, 0);

        // fund the buyer with real Ford and buy on the curve
        deal(FORD, buyer, 2e18);
        vm.startPrank(buyer);
        IERC20Minimal(FORD).approve(address(router), 2e18);
        uint256 got = router.buy(token, FORD, 2e18, 0, buyer, block.timestamp);
        vm.stopPrank();
        assertGt(got, 0, "quoted buy returned no tokens");

        // sell half the position straight to ETH through the sell router
        uint256 sellAmt = got / 2;
        uint256 ethBefore = buyer.balance;
        vm.startPrank(buyer);
        WavesToken(token).approve(address(sellRouter), sellAmt);
        uint256 eth = sellRouter.sellForEth(token, FORD, sellAmt, fordEth, 0, buyer, block.timestamp);
        vm.stopPrank();

        assertGt(eth, 0, "sell returned no ETH");
        assertEq(buyer.balance - ethBefore, eth, "seller balance did not rise by ethOut");
        // router holds nothing afterwards
        assertEq(IERC20Minimal(FORD).balanceOf(address(sellRouter)), 0, "Ford dust stuck in router");
        assertEq(WavesToken(token).balanceOf(address(sellRouter)), 0, "token dust stuck in router");
        assertEq(address(sellRouter).balance, 0, "ETH dust stuck in router");
    }

    // L-2: a caller must not be able to route the quote leg through an arbitrary
    // hook — the ETH pool key's hooks field is pinned to zero.
    function test_sell_rejects_hooked_pool_key() public onFork {
        vm.prank(creator);
        address token = hook.launch("FordPair3", "FP3", 100, "l", "d", "s", FORD, 0);
        deal(FORD, buyer, 2e18);
        vm.startPrank(buyer);
        IERC20Minimal(FORD).approve(address(router), 2e18);
        uint256 got = router.buy(token, FORD, 2e18, 0, buyer, block.timestamp);
        WavesToken(token).approve(address(sellRouter), got);
        PoolKey memory bad = fordEth;
        bad.hooks = IHooks(address(0xDEAD));
        vm.expectRevert(WavesSellRouter.NotEthPool.selector);
        sellRouter.sellForEth(token, FORD, got, bad, 0, buyer, block.timestamp);
        vm.stopPrank();
    }

    // minEthOut must be enforced
    function test_sell_reverts_below_min() public onFork {
        vm.prank(creator);
        address token = hook.launch("FordPair2", "FP2", 100, "l", "d", "s", FORD, 0);
        deal(FORD, buyer, 2e18);
        vm.startPrank(buyer);
        IERC20Minimal(FORD).approve(address(router), 2e18);
        uint256 got = router.buy(token, FORD, 2e18, 0, buyer, block.timestamp);
        WavesToken(token).approve(address(sellRouter), got);
        vm.expectRevert(WavesSellRouter.TooLittleReceived.selector);
        sellRouter.sellForEth(token, FORD, got, fordEth, 100 ether, buyer, block.timestamp);
        vm.stopPrank();
    }
}
