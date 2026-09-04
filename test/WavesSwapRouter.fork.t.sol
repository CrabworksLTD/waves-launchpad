// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import "forge-std/Test.sol";
import "../contracts/WavesSwapRouter.sol";

/**
 * The router, against the real Uniswap V4 on Robinhood Chain.
 *
 *   forge test --match-path test/WavesSwapRouter.fork.t.sol \
 *     --fork-url https://rpc.mainnet.chain.robinhood.com \
 *     --evm-version cancun -vv
 *
 * ⚠️ --evm-version cancun is not optional. V4 keeps its lock in transient
 * storage, and foundry.toml pins paris for the deployed contracts — under paris
 * every call into the PoolManager dies as `NotActivated`, which reads like a
 * bad address rather than a missing opcode.
 *
 * ⚠️ A mock cannot answer the question this contract poses. Everything risky
 * about it lives in the handshake with the PoolManager — who calls back, what a
 * BalanceDelta's sign means, whether native ETH settles with a value or needs a
 * sync first, whether an empty pool reverts or fills for nothing. A mock would
 * encode what I BELIEVE about all four, and the belief is the thing under test.
 * The last of those turned out to be wrong, and only the fork could say so.
 *
 * Kept deliberately lean: every quote is a full swap simulation, and Robinhood
 * drops the TLS connection outright when a run asks for too much state at once.
 *
 * Skipped rather than failed off-fork, so plain `forge test` stays green.
 */
contract WavesSwapRouterForkTest is Test {
    address constant POOL_MANAGER = 0x8366a39CC670B4001A1121B8F6A443A643e40951;
    address constant USDG = 0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168;
    address constant TSLA = 0x322F0929c4625eD5bAd873c95208D54E1c003b2d;

    WavesSwapRouter router;
    address holder = address(0xBEEF);

    modifier onFork() {
        if (block.chainid != 4663) return;
        _;
    }

    /**
     * ⚠️ Deploys the bytes that SHIP, not forge's build of the same source.
     *
     * tools/build-contract.js and forge compile the same file with the same
     * solc, optimizer and viaIR settings and still produce output that differs
     * by 74 bytes. That is almost certainly only metadata — and "almost
     * certainly" is not a standard to apply to a contract that moves other
     * people's payouts. The artifact the site deploys is the artifact tested.
     */
    function setUp() public {
        if (block.chainid != 4663) return;

        bytes memory code = vm.parseBytes(vm.readFile("forge-out/shipped/WavesSwapRouter.hex"));
        bytes memory initCode = abi.encodePacked(code, abi.encode(POOL_MANAGER));
        address deployed;
        assembly { deployed := create(0, add(initCode, 0x20), mload(initCode)) }
        require(deployed != address(0), "shipped bytecode failed to deploy");
        router = WavesSwapRouter(payable(deployed));

        // it must be the same contract, not merely a contract
        require(address(router.poolManager()) == POOL_MANAGER, "wrong poolManager");
    }

    function _key(address token, uint24 fee, int24 spacing) internal pure returns (PoolKey memory) {
        return PoolKey({
            currency0: Currency.wrap(address(0)),
            currency1: Currency.wrap(token),
            fee: fee,
            tickSpacing: spacing,
            hooks: address(0)
        });
    }

    /* Three real TSLA pools, in the order the sweeper records them. Only the
     * first is funded — which is the point: that is the shape of every asset on
     * this chain, and picking by position rather than by depth pays nothing. */
    function _tslaPools() internal pure returns (PoolKey[] memory keys) {
        keys = new PoolKey[](3);
        keys[0] = _key(TSLA, 45000, 450);
        keys[1] = _key(TSLA, 700000, 7000);
        keys[2] = _key(TSLA, 69999, 700);
    }

    /**
     * ⚠️ The finding that shaped the design: an EMPTY pool does not revert. It
     * is initialised, it has no liquidity, and V4 fills it for zero and hands
     * the ETH straight back.
     *
     * USDG's fee-86 pool is one of these, and it is the FIRST ETH pair the
     * sweeper records for USDG — so a keeper that trusted the first key it
     * found would have paid every holder nothing and got a successful receipt
     * for it. Hence quoteBest, and hence the router refusing a zero fill.
     */
    function test_emptyPoolIsRefusedRatherThanFillingForZero() public onFork {
        PoolKey memory key = _key(USDG, 86, 1);

        assertEq(router.quote(key, 0.001 ether), 0, "expected this pool to be empty");
        vm.expectRevert(WavesSwapRouter.NothingOut.selector);
        router.swap{value: 0.001 ether}(key, 0, holder);
    }

    /// A pool that was never initialised must fail loudly too.
    function test_unknownPoolDoesNotSilentlyPayNothing() public onFork {
        PoolKey memory key = _key(USDG, 1234, 77);
        assertEq(router.quote(key, 0.001 ether), 0, "an uninitialised pool quoted a price");
        vm.expectRevert();
        router.swap{value: 0.001 ether}(key, 0, holder);
    }

    /// ETH in, tokens to the recipient, and the router keeps nothing.
    function test_swapsEthForTsla() public onFork {
        PoolKey memory key = _key(TSLA, 45000, 450);

        uint256 before = IERC20(TSLA).balanceOf(holder);
        uint256 out = router.swap{value: 0.001 ether}(key, 0, holder);

        assertGt(out, 0, "swap returned nothing");
        assertEq(IERC20(TSLA).balanceOf(holder) - before, out, "recipient did not get the output");
        assertEq(address(router).balance, 0, "router kept ETH");
        assertEq(IERC20(TSLA).balanceOf(address(router)), 0, "router kept tokens");
        emit log_named_uint("TSLA out for 0.001 ETH (18dp)", out);
    }

    /**
     * ⚠️ The property the keeper depends on: a quote predicts the fill.
     *
     * The keeper chooses its pool and its slippage floor from quoteBest. If the
     * quoted number were not the delivered number, every minOut it computed
     * would be wrong — too high and payouts revert, too low and they get
     * sandwiched. Nothing else in the design checks this.
     */
    function test_quoteMatchesExecution() public onFork {
        PoolKey memory key = _key(TSLA, 45000, 450);
        uint256 quoted = router.quote(key, 0.001 ether);
        uint256 actual = router.swap{value: 0.001 ether}(key, 0, holder);
        assertEq(quoted, actual, "a quote did not predict the fill");
    }

    /// quoteBest must find the funded pool among dead ones, in a single call.
    function test_quoteBestFindsTheLivePool() public onFork {
        PoolKey[] memory keys = _tslaPools();
        (uint256 idx, uint256 best) = router.quoteBest(keys, 0.001 ether);

        assertGt(best, 0, "quoteBest found nothing");
        assertEq(best, router.quote(keys[idx], 0.001 ether), "the winning quote is not reproducible");
        emit log_named_uint("best pool index", idx);
        emit log_named_uint("best TSLA quote for 0.001 ETH (18dp)", best);
    }

    /// A quote must leave the pool exactly as it found it.
    function test_quotingChangesNothing() public onFork {
        PoolKey memory key = _key(TSLA, 45000, 450);
        uint256 first = router.quote(key, 0.001 ether);
        router.quote(key, 0.001 ether);
        assertEq(router.quote(key, 0.001 ether), first, "quoting moved the price");
        assertEq(address(router).balance, 0, "quoting left ETH behind");
    }

    /// minOut is the only sandwich protection there is; it must actually bite.
    function test_revertsWhenOutputIsShort() public onFork {
        PoolKey memory key = _key(TSLA, 45000, 450);
        uint256 quoted = router.quote(key, 0.001 ether);
        vm.expectRevert();
        router.swap{value: 0.001 ether}(key, quoted * 2, holder);
    }

    /**
     * Larger amounts must still settle. The keeper swaps a whole pot, not a
     * test-sized nibble, and a thin pool is where a partial fill would show up
     * as ETH stranded in the router.
     */
    function test_largerSwapLeavesNothingBehind() public onFork {
        PoolKey memory key = _key(TSLA, 45000, 450);
        uint256 out = router.swap{value: 0.05 ether}(key, 0, holder);
        assertGt(out, 0);
        assertEq(address(router).balance, 0, "router kept ETH after a large swap");
    }

    /// Only the PoolManager may open the lock; anyone else is an impostor.
    function test_callbackRejectsStrangers() public onFork {
        vm.expectRevert(WavesSwapRouter.NotPoolManager.selector);
        router.unlockCallback("");
    }

    /// quoteRevert moves no money, but it should still not be callable directly.
    function test_quoteRevertIsInternalOnly() public onFork {
        vm.expectRevert(WavesSwapRouter.NotSelf.selector);
        router.quoteRevert(_key(TSLA, 45000, 450), 0.001 ether);
    }
}
