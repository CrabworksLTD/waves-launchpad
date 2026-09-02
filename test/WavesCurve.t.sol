// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {WavesCurve} from "../contracts/WavesCurve.sol";
import {WavesToken} from "../contracts/WavesToken.sol";

/**
 * Tests for the bonding curve.
 *
 * The ones that matter are the invariants, not the happy path. A launchpad
 * fails in exactly two ways: it lets someone take money that is not theirs, or
 * it wedges and lets nobody take money that is. Everything below is aimed at
 * the first, because the second is loud and the first is silent.
 */
contract WavesCurveTest is Test {
    WavesCurve curve;

    address platform = address(0xFEE);
    address creator  = address(0xC0FFEE);
    address alice    = address(0xA11CE);
    address bob      = address(0xB0B);
    address keeper   = address(0xDEED);

    uint256 constant SUPPLY   = 1_000_000_000e18;
    uint256 constant V_TOKENS = 1_073_000_000e18;
    uint256 constant V_ETH    = 1.41 ether;
    uint256 constant GRAD     = 4 ether;

    function setUp() public {
        curve = new WavesCurve(platform, GRAD, V_ETH, V_TOKENS, SUPPLY);
        vm.deal(alice, 1000 ether);
        vm.deal(bob, 1000 ether);
        vm.deal(creator, 1000 ether);
    }

    function _launch(uint16 feeBps) internal returns (address token) {
        vm.prank(creator);
        token = curve.launch("Fart", "FART", feeBps, 0);
    }

    // ─────────────────────────────────────────────────────────────── the basics

    function test_launchMintsEverythingToTheCurve() public {
        address token = _launch(300);
        assertEq(WavesToken(token).totalSupply(), SUPPLY);
        assertEq(WavesToken(token).balanceOf(address(curve)), SUPPLY);
        assertEq(WavesToken(token).balanceOf(creator), 0, "creator must not be pre-allocated");
    }

    function test_onlyRealRungsAreAccepted() public {
        uint16[6] memory ok = [uint16(100), 200, 300, 400, 500, 1000];
        for (uint256 i = 0; i < ok.length; i++) {
            vm.prank(creator);
            curve.launch("A", "A", ok[i], 0);
        }
        uint16[4] memory bad = [uint16(0), 150, 999, 1100];
        for (uint256 i = 0; i < bad.length; i++) {
            vm.prank(creator);
            vm.expectRevert(WavesCurve.BadFee.selector);
            curve.launch("A", "A", bad[i], 0);
        }
    }

    function test_devBuyLandsInTheLaunchTransaction() public {
        vm.prank(creator);
        address token = curve.launch{value: 1 ether}("Fart", "FART", 300, 0);
        assertGt(WavesToken(token).balanceOf(creator), 0, "the dev buy must arrive");
    }

    // ───────────────────────────────────────────────────────── the invariants

    /**
     * Buy then immediately sell must never return more than was put in.
     *
     * This is the one that matters. If it can be broken the curve is a faucet:
     * anyone loops it and drains every other token's reserves, because the ETH
     * is pooled in one contract.
     */
    function testFuzz_roundTripNeverProfits(uint96 amount) public {
        amount = uint96(bound(amount, 1e12, 50 ether));
        address token = _launch(300);

        uint256 before = alice.balance;
        vm.startPrank(alice);
        curve.buy{value: amount}(token, 0);
        uint256 got = WavesToken(token).balanceOf(alice);
        WavesToken(token).approve(address(curve), got);
        curve.sell(token, got, 0);
        vm.stopPrank();

        assertLe(alice.balance, before, "a round trip returned a profit");
    }

    /// The contract must always hold at least what it owes: reserves plus fees.
    function testFuzz_solvent(uint96 a, uint96 b) public {
        a = uint96(bound(a, 1e12, 20 ether));
        b = uint96(bound(b, 1e12, 20 ether));
        address token = _launch(300);

        vm.prank(alice); curve.buy{value: a}(token, 0);
        vm.prank(bob);   curve.buy{value: b}(token, 0);

        (, , , , uint96 raised, , ) = curve.curves(token);
        uint256 liabilities = uint256(raised) + curve.owed(platform) + curve.owed(creator);
        assertGe(address(curve).balance, liabilities, "curve cannot cover what it owes");
    }

    /// Selling everything back must never take more ETH than the curve holds.
    function test_fullExitCannotOverdraw() public {
        address token = _launch(300);
        vm.startPrank(alice);
        curve.buy{value: 3 ether}(token, 0);
        uint256 got = WavesToken(token).balanceOf(alice);
        WavesToken(token).approve(address(curve), got);
        curve.sell(token, got, 0);
        vm.stopPrank();

        (, , , , uint96 raised, , ) = curve.curves(token);
        assertGe(address(curve).balance, uint256(raised) + curve.owed(platform) + curve.owed(creator));
    }

    /// One token's buyers must never be able to touch another token's ETH.
    function test_curvesAreIsolated() public {
        address one = _launch(300);
        address two = _launch(300);

        vm.prank(alice); curve.buy{value: 2 ether}(one, 0);
        (, , , , uint96 raisedTwo, , ) = curve.curves(two);
        assertEq(raisedTwo, 0, "a buy on one curve moved another");

        vm.startPrank(alice);
        uint256 got = WavesToken(one).balanceOf(alice);
        WavesToken(one).approve(address(curve), got);
        curve.sell(one, got, 0);
        vm.stopPrank();
        (, , , , raisedTwo, , ) = curve.curves(two);
        assertEq(raisedTwo, 0, "a sell on one curve moved another");
    }

    // ──────────────────────────────────────────────────────────────────── fees

    function test_platformShareMatchesTheLadder() public {
        uint16[6] memory rungs = [uint16(100), 200, 300, 400, 500, 1000];
        uint16[6] memory want  = [uint16(40), 50, 60, 70, 80, 90];
        for (uint256 i = 0; i < rungs.length; i++) {
            assertEq(curve.platformVolumeBps(rungs[i]), want[i]);
        }
    }

    function test_platformIsPaidItsShareOfVolume() public {
        address token = _launch(300);            // 3% fee, platform 0.6% of volume
        vm.prank(alice); curve.buy{value: 10 ether}(token, 0);
        assertEq(curve.owed(platform), 10 ether * 60 / 10_000, "platform cut wrong");
    }

    function test_creatorTakesTheRest() public {
        address token = _launch(300);
        vm.prank(alice); curve.buy{value: 10 ether}(token, 0);
        uint256 fee = 10 ether * 300 / 10_000;
        assertEq(curve.owed(creator), fee - curve.owed(platform));
    }

    // ───────────────────────────────────────────────────────────────── pledges

    function test_pledgeRoutesToTheKeeper() public {
        address token = _launch(300);
        vm.prank(creator);
        curve.pledgeToHolders(token, 10_000, keeper);   // all of it

        vm.prank(alice); curve.buy{value: 10 ether}(token, 0);
        assertEq(curve.owed(creator), 0, "creator kept a pledged share");
        assertGt(curve.owed(keeper), 0, "keeper received nothing");
    }

    function test_pledgeIsOneWay() public {
        address token = _launch(300);
        vm.startPrank(creator);
        curve.pledgeToHolders(token, 5_000, keeper);
        vm.expectRevert(WavesCurve.AlreadyPledged.selector);
        curve.pledgeToHolders(token, 0 + 1, keeper);
        vm.stopPrank();
    }

    function test_onlyTheCreatorCanPledge() public {
        address token = _launch(300);
        vm.prank(alice);
        vm.expectRevert(WavesCurve.NotCreator.selector);
        curve.pledgeToHolders(token, 5_000, keeper);
    }

    // ────────────────────────────────────────────────────────────────── claims

    function test_claimPaysAndZeroes() public {
        address token = _launch(300);
        vm.prank(alice); curve.buy{value: 10 ether}(token, 0);

        uint256 owed = curve.owed(creator);
        uint256 before = creator.balance;
        vm.prank(creator); curve.claim();
        assertEq(creator.balance, before + owed);
        assertEq(curve.owed(creator), 0);

        vm.prank(creator);
        vm.expectRevert(WavesCurve.NothingOwed.selector);
        curve.claim();
    }

    /// A creator whose wallet reverts must not be able to wedge their own token.
    function test_aRevertingCreatorCannotBlockTrading() public {
        Reverter bad = new Reverter();
        vm.prank(address(bad));
        address token = curve.launch("A", "A", 300, 0);

        vm.prank(alice);
        curve.buy{value: 1 ether}(token, 0);       // must not revert
        assertGt(curve.owed(address(bad)), 0);
    }

    // ────────────────────────────────────────────────────────────── graduation

    function test_progressAndReadiness() public {
        address token = _launch(300);
        assertEq(curve.progressBps(token), 0);
        assertFalse(curve.ready(token));

        vm.prank(alice); curve.buy{value: 10 ether}(token, 0);
        assertTrue(curve.ready(token), "should be ready past the threshold");
        assertEq(curve.progressBps(token), 10_000);
    }

    /// About a fifth of supply should survive the curve, to seed the pool.
    function test_supplyRemainsForThePool() public {
        address token = _launch(300);
        vm.prank(alice); curve.buy{value: GRAD}(token, 0);
        (, , , , , uint96 left, ) = curve.curves(token);
        uint256 pct = uint256(left) * 100 / SUPPLY;
        assertGt(pct, 10, "too little left to graduate with");
        assertLt(pct, 40, "too much left unsold");
    }
}

contract Reverter {
    receive() external payable { revert("no"); }
}
