// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {WavesCurve} from "../contracts/WavesCurve.sol";
import {WavesToken} from "../contracts/WavesToken.sol";

/**
 * The thing that actually drives the curve during an invariant run.
 *
 * The unit tests check one actor doing one sensible thing. That is not how a
 * launchpad gets drained. It gets drained by an ordering nobody wrote a test
 * for: eight people trading four tokens at once, someone selling into a curve
 * another person is buying, a creator pledging halfway through, a claim landing
 * between a buy and a sell. This hands all of that to the fuzzer and lets it
 * look for the sequence.
 *
 * Every entry point bounds its inputs so calls do real work rather than
 * reverting — a handler that reverts on most calls passes every invariant while
 * testing nothing, which is the usual way an invariant suite is quietly
 * worthless. The counters exist so that failure is visible.
 */
contract CurveHandler is Test {
    WavesCurve public immutable curve;

    address[] public tokens;
    address[] public actors;
    /* Everyone the curve might owe money to: the actors, the platform, and the
     * keepers. Summing `owed` over the wrong set would make the solvency check
     * pass by ignoring a liability. */
    address[] public payees;
    mapping(address => bool) private isPayee;

    uint256 public launches;
    uint256 public buys;
    uint256 public sells;
    uint256 public claims;
    uint256 public pledges;
    uint256 public graduations;

    uint16[6] internal RUNGS = [uint16(100), 200, 300, 400, 500, 1000];
    uint256 internal constant MAX_TOKENS = 4;

    constructor(WavesCurve curve_, address platform_, address[] memory actors_, address[] memory keepers_) {
        curve = curve_;
        for (uint256 i = 0; i < actors_.length; i++) {
            actors.push(actors_[i]);
            _payee(actors_[i]);
        }
        for (uint256 i = 0; i < keepers_.length; i++) _payee(keepers_[i]);
        _payee(platform_);
    }

    function _payee(address a) private {
        if (a != address(0) && !isPayee[a]) { isPayee[a] = true; payees.push(a); }
    }

    function payeeCount() external view returns (uint256) { return payees.length; }
    function tokenCount() external view returns (uint256) { return tokens.length; }

    function _actor(uint256 seed) internal view returns (address) {
        return actors[seed % actors.length];
    }

    function _token(uint256 seed) internal view returns (address) {
        if (tokens.length == 0) return address(0);
        return tokens[seed % tokens.length];
    }

    // ───────────────────────────────────────────────────────────────── actions

    function launch(uint256 actorSeed, uint256 rungSeed, uint256 devBuy) external {
        if (tokens.length >= MAX_TOKENS) return;      // keep the state space walkable
        address who = _actor(actorSeed);
        devBuy = bound(devBuy, 0, 30 ether);
        if (devBuy > who.balance) devBuy = who.balance;

        vm.prank(who);
        address t = curve.launch{value: devBuy}("Fart", "FART", RUNGS[rungSeed % 6], 0, "", "", "");
        tokens.push(t);
        launches++;
    }

    function buy(uint256 actorSeed, uint256 tokenSeed, uint256 amount) external {
        address t = _token(tokenSeed);
        if (t == address(0)) return;
        (, , , , , , bool graduated) = curve.curves(t);
        if (graduated) return;

        address who = _actor(actorSeed);
        // up past graduationEth on purpose: overrunning the curve is the
        // case that produced a token nobody could graduate.
        amount = bound(amount, 1e12, 60 ether);
        if (amount > who.balance) return;

        vm.prank(who);
        curve.buy{value: amount}(t, 0);
        buys++;
    }

    function sell(uint256 actorSeed, uint256 tokenSeed, uint256 pctBps) external {
        address t = _token(tokenSeed);
        if (t == address(0)) return;
        (, , , , , , bool graduated) = curve.curves(t);
        if (graduated) return;

        address who = _actor(actorSeed);
        uint256 bal = WavesToken(t).balanceOf(who);
        if (bal == 0) return;
        uint256 amount = (bal * bound(pctBps, 1, 10_000)) / 10_000;
        if (amount == 0) return;

        vm.startPrank(who);
        WavesToken(t).approve(address(curve), amount);
        curve.sell(t, amount, 0);
        vm.stopPrank();
        sells++;
    }

    function claim(uint256 payeeSeed) external {
        address who = payees[payeeSeed % payees.length];
        if (curve.owed(who) == 0) return;
        vm.prank(who);
        curve.claim();
        claims++;
    }

    function pledge(uint256 tokenSeed, uint256 bps, uint256 keeperSeed) external {
        address t = _token(tokenSeed);
        if (t == address(0)) return;
        (address creator, , uint16 rewardsBps, , , , ) = curve.curves(t);
        if (rewardsBps != 0) return;                  // one way, so only ever once

        address keeper = payees[keeperSeed % payees.length];
        if (keeper == address(0)) return;
        vm.prank(creator);
        curve.pledgeToHolders(t, uint16(bound(bps, 1, 10_000)), keeper);
        pledges++;
    }

    /**
     * Graduation needs the real Uniswap, so locally this is a no-op and the run
     * only exercises the curve. On a fork it closes curves mid-sequence, which
     * is where the interesting orderings are — a sell arriving on a token that
     * graduated three calls ago, a claim after the ETH left for the pool.
     */
    function graduate(uint256 tokenSeed) external {
        address t = _token(tokenSeed);
        if (t == address(0)) return;
        if (address(curve.factory()).code.length == 0) return;
        if (!curve.ready(t)) return;
        curve.graduate(t);
        graduations++;
    }
}
