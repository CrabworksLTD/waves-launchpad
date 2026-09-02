// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {WavesCurve} from "../contracts/WavesCurve.sol";
import {WavesToken} from "../contracts/WavesToken.sol";
import {CurveHandler} from "./CurveHandler.sol";
import {MockV3Factory, MockWETH} from "./MockUniswap.sol";

/**
 * Invariants — the properties that must hold after EVERY call, in EVERY order.
 *
 * This is the suite that matters. One deployment holds the ETH of every live
 * curve at once, so the question is not "does a buy work" but "is there any
 * sequence of calls, by any set of people, across any set of tokens, after
 * which the contract owes more than it holds". A unit test cannot answer that.
 * The fuzzer generates the sequences and these assertions are checked after
 * each step of each one.
 */
contract WavesCurveInvariantTest is Test {
    WavesCurve curve;
    CurveHandler handler;

    address platform = address(0xFEE);
    address[] actors;
    address[] keepers;

    uint256 constant SUPPLY   = 1_000_000_000e18;
    uint256 constant V_TOKENS = 1_073_000_000e18;
    uint256 constant V_ETH    = 1.41 ether;
    uint256 constant GRAD     = 4 ether;

    /* A local stand-in for Uniswap, so graduation is in the sequence.
     *
     * Robinhood rate-limits a fork far below what an invariant run needs, and
     * the ordering bugs this suite hunts are ours, not Uniswap's. The real
     * factory is covered by Graduation.fork.t.sol. */
    MockV3Factory factory;
    MockWETH mockWeth;

    uint256 constant FUNDING = 10_000 ether;
    uint256 totalFunded;

    function setUp() public {
        factory = new MockV3Factory();
        mockWeth = new MockWETH();
        curve = new WavesCurve(platform, GRAD, V_ETH, V_TOKENS, SUPPLY,
                               address(factory), address(mockWeth), 10000);

        for (uint256 i = 1; i <= 6; i++) {
            address a = address(uint160(0xA000 + i));
            actors.push(a);
            vm.deal(a, FUNDING);
        }
        for (uint256 i = 1; i <= 2; i++) keepers.push(address(uint160(0xDEED0 + i)));

        /* Set every balance explicitly, then total what is really there.
         *
         * On a fork these addresses are not empty — they are real addresses on
         * a real chain, and some hold dust. Assuming they started at zero made
         * the ledger start 3e13 wei short, which is exactly the size of leak
         * this invariant exists to catch. An accounting check that begins by
         * guessing its own opening balance is not an accounting check. */
        for (uint256 i = 0; i < keepers.length; i++) vm.deal(keepers[i], 0);
        vm.deal(platform, 0);
        for (uint256 i = 0; i < actors.length; i++) totalFunded += actors[i].balance;
        for (uint256 i = 0; i < keepers.length; i++) totalFunded += keepers[i].balance;
        totalFunded += platform.balance;

        handler = new CurveHandler(curve, platform, actors, keepers);
        targetContract(address(handler));
    }

    // ───────────────────────────────────────────────────────── what is owed

    function _liabilities() internal view returns (uint256 total) {
        uint256 n = handler.tokenCount();
        for (uint256 i = 0; i < n; i++) {
            (, , , , uint96 raised, , ) = curve.curves(handler.tokens(i));
            total += raised;
        }
        uint256 p = handler.payeeCount();
        for (uint256 i = 0; i < p; i++) total += curve.owed(handler.payees(i));
    }

    /**
     * THE invariant. Everything else is a detail.
     *
     * If this can be broken the curve is a faucet: someone loops whatever
     * sequence breaks it and walks off with the reserves of every other token
     * on the launchpad, because all of it sits in this one balance.
     */
    function invariant_neverOwesMoreThanItHolds() public view {
        assertGe(address(curve).balance, _liabilities(), "the curve cannot cover what it owes");
    }

    /**
     * And the other direction: no wei may go missing either.
     *
     * Every path in or out moves the balance and the liability by the same
     * amount, so these must be equal, not merely ordered. A gap upward means
     * ETH is stranded in the contract with no way to claim it — locked money
     * that belongs to someone, which is a bug even though nobody can steal it.
     */
    function invariant_ethIsFullyAccountedFor() public view {
        assertEq(address(curve).balance, _liabilities(), "ETH is unaccounted for");
    }

    /**
     * The curve must really hold the tokens it thinks it can still sell.
     *
     * Fuzzing already caught this once: the buy wrote back the VIRTUAL reserve
     * as the real balance, `tokensLeft` drifted above what the contract held,
     * and the next buyer's transfer reverted. That bug wedges a token
     * permanently, so it gets its own invariant rather than being folded in.
     */
    function invariant_tokenBalancesMatchTheCurve() public view {
        uint256 n = handler.tokenCount();
        for (uint256 i = 0; i < n; i++) {
            address t = handler.tokens(i);
            (, , , , , uint96 left, bool graduated) = curve.curves(t);
            if (graduated) continue;                  // supply has moved to the pool
            assertEq(WavesToken(t).balanceOf(address(curve)), left, "curve does not hold what it is selling");
        }
    }

    /// Nothing may ever be sold that was not minted.
    function invariant_supplyIsNeverExceeded() public view {
        uint256 n = handler.tokenCount();
        for (uint256 i = 0; i < n; i++) {
            address t = handler.tokens(i);
            (, , , , uint96 raised, uint96 left, bool graduated) = curve.curves(t);
            assertLe(left, SUPPLY, "more tokens on the curve than exist");
            assertEq(WavesToken(t).totalSupply(), SUPPLY, "supply moved");
            if (graduated) {
                // a closed curve keeps nothing back
                assertEq(raised, 0, "graduated curve still holds ETH");
                assertEq(left, 0, "graduated curve still holds tokens");
            }
        }
    }

    /**
     * A live curve must always have tokens left and room to take money.
     *
     * The state this forbids is the one the fork run found: a single buy large
     * enough to take every remaining token, after which graduation reverts on a
     * zero price and further buyers pay ETH for nothing.
     */
    function invariant_aLiveCurveIsNeverSoldOut() public view {
        uint256 n = handler.tokenCount();
        for (uint256 i = 0; i < n; i++) {
            (, , , , uint96 raised, uint96 left, bool graduated) = curve.curves(handler.tokens(i));
            if (graduated) continue;
            assertGt(left, 0, "a live curve has nothing left to sell");
            assertLe(raised, GRAD, "a curve took more than it closes at");
        }
    }

    /// Nobody can end up with more ETH than everyone started with.
    function invariant_noEthIsCreated() public view {
        uint256 held = address(curve).balance;
        for (uint256 i = 0; i < actors.length; i++) held += actors[i].balance;
        for (uint256 i = 0; i < keepers.length; i++) held += keepers[i].balance;
        held += platform.balance;
        // graduated ETH is wrapped, not spent — it is still in the system
        held += address(mockWeth).balance;
        assertLe(held, totalFunded, "ETH was created out of nothing");
    }

    /**
     * A handler whose calls all quietly return satisfies every invariant above
     * while testing nothing, which is the usual way an invariant suite rots
     * into a green light that means nothing. So: drive each action once, by
     * hand, and insist it moved its counter.
     *
     * Deliberately a scripted test rather than an invariant — the invariants
     * are checked once before any call is made, when every counter is honestly
     * zero, and a check that must be excused at the start is not a check.
     */
    function test_everyHandlerActionDoesRealWork() public {
        handler.launch(0, 2, 1 ether);
        assertEq(handler.launches(), 1, "launch did nothing");

        handler.buy(1, 0, 2 ether);
        assertEq(handler.buys(), 1, "buy did nothing");

        handler.sell(1, 0, 5_000);
        assertEq(handler.sells(), 1, "sell did nothing");

        handler.pledge(0, 3_000, 0);
        assertEq(handler.pledges(), 1, "pledge did nothing");

        handler.claim(0);
        assertEq(handler.claims(), 1, "claim did nothing");

        // graduation needs the real Uniswap; on a fork this one counts too
        handler.buy(2, 0, 20 ether);
        handler.graduate(0);
        assertEq(handler.graduations(), 1, "graduate did nothing");
    }
}
