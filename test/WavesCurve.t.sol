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

    /* Robinhood Chain's real deployments. Uniswap V3 is NOT at its canonical
     * address there — 0x1F98431c… holds something that answers nothing — so
     * these are the verified ones, used by the fork test below. */
    address constant RH_FACTORY = 0x1f7d7550B1b028f7571E69A784071F0205FD2EfA;
    address constant RH_WETH    = 0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73;

    function setUp() public {
        curve = new WavesCurve(platform, GRAD, V_ETH, V_TOKENS, SUPPLY,
                               RH_FACTORY, RH_WETH, 10000);
        vm.deal(alice, 1000 ether);
        vm.deal(bob, 1000 ether);
        vm.deal(creator, 1000 ether);
    }

    function _launch(uint16 feeBps) internal returns (address token) {
        vm.prank(creator);
        token = curve.launch("Fart", "FART", feeBps, 0, "", "", "");
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
            curve.launch("A", "A", ok[i], 0, "", "", "");
        }
        uint16[4] memory bad = [uint16(0), 150, 999, 1100];
        for (uint256 i = 0; i < bad.length; i++) {
            vm.prank(creator);
            vm.expectRevert(WavesCurve.BadFee.selector);
            curve.launch("A", "A", bad[i], 0, "", "", "");
        }
    }

    function test_devBuyLandsInTheLaunchTransaction() public {
        vm.prank(creator);
        address token = curve.launch{value: 1 ether}("Fart", "FART", 300, 0, "", "", "");
        assertGt(WavesToken(token).balanceOf(creator), 0, "the dev buy must arrive");
    }

    /**
     * The picture has to be ON the token, because there is nowhere else to put
     * it. An ERC20 has no metadata account, so an indexer that cannot read this
     * shows a grey letter placeholder forever.
     */
    function test_theTokenCarriesItsOwnIdentity() public {
        vm.prank(creator);
        address token = curve.launch(
            "Fart", "FART", 300, 0,
            "https://arweave.net/abc/icon.png",
            "the smelliest coin on Robinhood",
            "https://x.com/fartcoin"
        );

        WavesToken t = WavesToken(token);
        assertEq(t.logo(), "https://arweave.net/abc/icon.png");
        assertEq(t.description(), "the smelliest coin on Robinhood");
        assertEq(t.socials(), "https://x.com/fartcoin");

        /* The CREATOR, not the curve. The curve is what runs `new`, so a naive
         * msg.sender here would record the launchpad as every token's deployer. */
        assertEq(t.deployer(), creator, "deployer must be the launcher");

        (address dep, string memory logo, string memory desc, string memory soc) = t.getTokenInfo();
        assertEq(dep, creator);
        assertEq(logo, "https://arweave.net/abc/icon.png");
        assertEq(desc, "the smelliest coin on Robinhood");
        assertEq(soc, "https://x.com/fartcoin");
    }

    /// A launch with no art must still work — the strings are optional.
    function test_identityMayBeEmpty() public {
        address token = _launch(300);
        assertEq(WavesToken(token).logo(), "");
        assertEq(WavesToken(token).deployer(), creator);
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
        // the first buy may have filled the curve, which legitimately refuses the second
        (, , , , uint96 mid, , ) = curve.curves(token);
        if (mid < GRAD) { vm.prank(bob); curve.buy{value: b}(token, 0); }

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

    /* 1 ether, not 10: a buy past the graduation threshold is now capped and
     * partly refunded, so 10 ether in is no longer 10 ether of volume. These
     * two measure the split, so they use an amount the curve takes whole. */
    function test_platformIsPaidItsShareOfVolume() public {
        address token = _launch(300);            // 3% fee, platform 0.6% of volume
        vm.prank(alice); curve.buy{value: 1 ether}(token, 0);
        assertEq(curve.owed(platform), 1 ether * 60 / 10_000, "platform cut wrong");
    }

    function test_creatorTakesTheRest() public {
        address token = _launch(300);
        vm.prank(alice); curve.buy{value: 1 ether}(token, 0);
        uint256 fee = 1 ether * 300 / 10_000;
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

    /**
     * Claiming to a nominated address — the EVM half of the Solana side's
     * feeWallet, and the reason it had to exist before deploy.
     */
    function test_claimToSendsElsewhereButSpendsYourOwnBalance() public {
        address token = _launch(300);
        vm.prank(alice); curve.buy{value: 1 ether}(token, 0);

        address vault = address(0xdeadbeef);
        uint256 owedToCreator = curve.owed(creator);
        assertGt(owedToCreator, 0);

        vm.prank(creator);
        curve.claimTo(vault);

        assertEq(vault.balance, owedToCreator, "the vault did not receive it");
        assertEq(curve.owed(creator), 0, "the creator's balance was not spent");
    }

    /// Nominating a destination must never let one address spend another's.
    function test_claimToCannotTakeSomeoneElsesBalance() public {
        address token = _launch(300);
        vm.prank(alice); curve.buy{value: 1 ether}(token, 0);
        assertGt(curve.owed(creator), 0);

        // bob is owed nothing, and naming the creator as destination changes that not at all
        vm.prank(bob);
        vm.expectRevert(WavesCurve.NothingOwed.selector);
        curve.claimTo(creator);
        assertGt(curve.owed(creator), 0, "the creator's balance moved");
    }

    function test_claimToRefusesTheZeroAddress() public {
        address token = _launch(300);
        vm.prank(alice); curve.buy{value: 1 ether}(token, 0);
        vm.prank(creator);
        vm.expectRevert(WavesCurve.ZeroAddress.selector);
        curve.claimTo(address(0));
    }

    /// A creator whose wallet reverts must not be able to wedge their own token.
    function test_aRevertingCreatorCannotBlockTrading() public {
        Reverter bad = new Reverter();
        vm.prank(address(bad));
        address token = curve.launch("A", "A", 300, 0, "", "", "");

        vm.prank(alice);
        curve.buy{value: 1 ether}(token, 0);       // must not revert
        assertGt(curve.owed(address(bad)), 0);
    }

    // ────────────────────────────────────────────────────────────── graduation

    function test_progressAndReadiness() public {
        address token = _launch(300);
        assertEq(curve.progressBps(token), 0);
        assertFalse(curve.ready(token));

        vm.prank(alice); curve.buy{value: 10 ether}(token, 0);   // capped at the threshold
        assertTrue(curve.ready(token), "should be ready past the threshold");
        assertEq(curve.progressBps(token), 10_000);
    }

    /**
     * A buy larger than the curve can absorb is capped, and the rest handed
     * back — rather than taken, at a price the curve had already left.
     */
    function test_anOversizedBuyIsCappedAndRefunded() public {
        address token = _launch(300);
        uint256 before = alice.balance;

        vm.prank(alice);
        curve.buy{value: 60 ether}(token, 0);

        (, , , , uint96 raised, uint96 left, ) = curve.curves(token);
        assertEq(raised, GRAD, "the curve should stop exactly at its threshold");
        assertGt(left, 0, "the curve must not sell out");
        assertLt(before - alice.balance, 60 ether, "nothing was refunded");
        assertTrue(curve.ready(token), "and it should now be ready to graduate");
    }

    /// No sequence of buys can empty the curve, however it is split up.
    function testFuzz_theCurveNeverSellsOut(uint96 a, uint96 b, uint96 c) public {
        address token = _launch(300);
        uint96[3] memory amounts = [uint96(bound(a, 1e12, 40 ether)),
                                    uint96(bound(b, 1e12, 40 ether)),
                                    uint96(bound(c, 1e12, 40 ether))];
        for (uint256 i = 0; i < 3; i++) {
            (, , , , uint96 raised, , ) = curve.curves(token);
            if (raised >= GRAD) break;                 // full: further buys revert by design
            vm.prank(alice);
            curve.buy{value: amounts[i]}(token, 0);
        }
        (, , , , , uint96 left, ) = curve.curves(token);
        assertGt(left, 0, "the curve sold out");
    }

    /// Once full, it must be graduated rather than take more money.
    function test_aFullCurveRefusesFurtherBuys() public {
        address token = _launch(300);
        vm.prank(alice); curve.buy{value: 60 ether}(token, 0);

        vm.prank(bob);
        vm.expectRevert(WavesCurve.CurveComplete.selector);
        curve.buy{value: 1 ether}(token, 0);
    }

    /// The quote must promise exactly what the buy delivers, cap included.
    function test_quoteMatchesTheCappedBuy() public {
        address token = _launch(300);
        uint256 quoted = curve.quoteBuy(token, 60 ether);
        vm.prank(alice); curve.buy{value: 60 ether}(token, 0);
        assertEq(WavesToken(token).balanceOf(alice), quoted, "quote and fill disagree");
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
