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

    // ─────────────────────────────────────────────── two hops, via USDG

    address constant MSFT = 0xe93237C50D904957Cf27E7B1133b510C669c2e74;
    address constant NVDA = 0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC;
    address constant SPY  = 0x117cc2133c37B721F49dE2A7a74833232B3B4C0C;

    /// The near leg every route shares: the deepest ETH/USDG pool.
    function _ethToUsdg() internal pure returns (PoolKey memory) {
        return _key(USDG, 91, 1);
    }

    /* A pool between USDG and something else. Which side USDG sits on is fixed
     * by address order, not by us — MSFT sorts above it and SPY below — so the
     * two are built differently on purpose. */
    function _usdgPair(address other, uint24 fee, int24 spacing)
        internal pure returns (PoolKey memory)
    {
        bool usdgFirst = uint160(USDG) < uint160(other);
        return PoolKey({
            currency0: Currency.wrap(usdgFirst ? USDG : other),
            currency1: Currency.wrap(usdgFirst ? other : USDG),
            fee: fee,
            tickSpacing: spacing,
            hooks: address(0)
        });
    }

    /* MSFT's three hookless USDG pools, in the order the sweeper records them.
     * The first is empty and the other two are not — the same trap as the ETH
     * side, one leg further along, and the reason the far leg is chosen by
     * quoting rather than by position. */
    function _msftFarLegs() internal pure returns (PoolKey[] memory keys) {
        keys = new PoolKey[](3);
        keys[0] = _usdgPair(MSFT, 40000, 400);
        keys[1] = _usdgPair(MSFT, 10000, 200);
        keys[2] = _usdgPair(MSFT, 900, 9);
    }

    /**
     * MSFT has NO ETH pool at all — it was simply unpayable before this, and a
     * creator picking it got their holders ETH forever. USDG is currency0 in
     * its pools, so the second hop runs zero-for-one.
     */
    function test_twoHopReachesAnAssetEthCannot() public onFork {
        PoolKey memory a = _ethToUsdg();
        PoolKey[] memory legs = _msftFarLegs();

        (uint256 idx, uint256 quoted) = router.quoteBest2(a, legs, 0.001 ether);
        assertGt(quoted, 0, "no two-hop quote for MSFT");
        assertGt(idx, 0, "expected the first far leg to be the empty one");

        uint256 out = router.swap2{value: 0.001 ether}(a, legs[idx], 0, holder);
        assertEq(out, quoted, "the two-hop quote did not predict the fill");
        assertEq(IERC20(MSFT).balanceOf(holder), out, "recipient did not get MSFT");
        emit log_named_uint("MSFT out for 0.001 ETH (18dp)", out);
    }

    /**
     * ⚠️ An empty FAR leg must not strand the middle asset.
     *
     * The first hop credits USDG and the second is supposed to spend exactly
     * that. If the far pool fills nothing, the credit is left unresolved and V4
     * rejects the whole lock with CurrencyNotSettled rather than quietly
     * leaving USDG here — which is the right outcome and worth pinning down,
     * because the alternative would be the router silently accumulating a
     * balance that the next caller could spend.
     */
    function test_emptyFarLegRevertsRatherThanStrandingTheMiddle() public onFork {
        vm.expectRevert();
        router.swap2{value: 0.001 ether}(_ethToUsdg(), _usdgPair(MSFT, 40000, 400), 0, holder);
        assertEq(IERC20(USDG).balanceOf(address(router)), 0, "USDG stranded in the router");
    }

    /**
     * ⚠️ The direction of the second hop comes from the ADDRESSES, not the
     * caller. SPY sorts below USDG, so USDG is currency1 in that pair and the
     * hop must run one-for-zero; MSFT sorts above, so it runs zero-for-one.
     * Hard-coding either would silently swap the wrong way round for half the
     * assets on this chain.
     *
     * SPY's USDG pools happen to be empty, so this pins the ORIENTATION rather
     * than a fill: the route must be recognised as connected and priced (at
     * zero) rather than rejected as unroutable.
     */
    function test_theMiddleCanBeEitherCurrency() public onFork {
        PoolKey memory spyLeg = _usdgPair(SPY, 3000, 30);
        assertEq(Currency.unwrap(spyLeg.currency1), USDG, "expected USDG to sort second here");
        assertEq(Currency.unwrap(_usdgPair(MSFT, 900, 9).currency0), USDG,
            "expected USDG to sort first here");

        // connected, therefore priced rather than reverted — the pool is just empty
        assertEq(router.quote2(_ethToUsdg(), spyLeg, 0.001 ether), 0);
    }

    /// quoteBest2 must pick among the far legs, not just take the first.
    function test_quoteBest2PicksTheBestFarLeg() public onFork {
        PoolKey[] memory legs = _msftFarLegs();
        (uint256 idx, uint256 best) = router.quoteBest2(_ethToUsdg(), legs, 0.001 ether);

        assertGt(best, 0, "no MSFT route found");
        assertEq(best, router.quote2(_ethToUsdg(), legs[idx], 0.001 ether), "not reproducible");
        // it must not have settled for legs[0], which is the empty one
        assertGt(idx, 0, "quoteBest2 chose the empty far leg");
        emit log_named_uint("MSFT best far leg", idx);
        emit log_named_uint("MSFT out for 0.001 ETH (18dp)", best);
    }

    /// Two pools with nothing in common are not a route.
    function test_disconnectedPoolsAreRefused() public onFork {
        vm.expectRevert(WavesSwapRouter.PoolsDoNotConnect.selector);
        router.swap2{value: 0.001 ether}(_ethToUsdg(), _key(TSLA, 45000, 450), 0, holder);
    }

    /// The middle leg must never be left behind in the router.
    function test_twoHopKeepsNoUsdg() public onFork {
        router.swap2{value: 0.01 ether}(_ethToUsdg(), _usdgPair(MSFT, 900, 9), 0, holder);
        assertEq(IERC20(USDG).balanceOf(address(router)), 0, "router kept the middle leg");
        assertEq(address(router).balance, 0, "router kept ETH");
        assertEq(IERC20(MSFT).balanceOf(address(router)), 0, "router kept the output");
    }

    /// minOut protects the two-hop route too.
    function test_twoHopRevertsWhenShort() public onFork {
        PoolKey memory a = _ethToUsdg();
        PoolKey memory b = _usdgPair(MSFT, 900, 9);
        uint256 quoted = router.quote2(a, b, 0.001 ether);
        assertGt(quoted, 0, "expected a live far leg for this test");
        vm.expectRevert();
        router.swap2{value: 0.001 ether}(a, b, quoted * 2, holder);
    }
}
