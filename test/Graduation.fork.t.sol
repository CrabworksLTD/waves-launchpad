// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {WavesCurve} from "../contracts/WavesCurve.sol";
import {WavesToken} from "../contracts/WavesToken.sol";

interface IPool {
    function slot0() external view returns (uint160 sqrtPriceX96, int24 tick, uint16, uint16, uint16, uint8, bool);
    function liquidity() external view returns (uint128);
    function token0() external view returns (address);
    function token1() external view returns (address);
    function fee() external view returns (uint24);
}

/**
 * Graduation, against the real Uniswap V3 on Robinhood Chain.
 *
 * Everything else is tested in a vacuum, which proves the arithmetic and not
 * much else. This runs the same code against the factory that will actually
 * receive it — a deployment at a non-canonical address, on a Nitro rollup,
 * neither of which a local test would have caught being wrong about.
 *
 *   forge test --match-path test/Graduation.fork.t.sol \
 *     --fork-url https://rpc.mainnet.chain.robinhood.com
 */
contract GraduationForkTest is Test {
    address constant FACTORY = 0x1f7d7550B1b028f7571E69A784071F0205FD2EfA;
    address constant WETH    = 0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73;
    uint24  constant FEE     = 10000;                 // the 1% tier, spacing 200

    uint256 constant SUPPLY   = 1_000_000_000e18;
    uint256 constant V_TOKENS = 1_073_000_000e18;
    uint256 constant V_ETH    = 1.41 ether;
    uint256 constant GRAD     = 4 ether;

    WavesCurve curve;
    address creator = address(0xC0FFEE);
    address alice   = address(0xA11CE);
    address platform = address(0xFEE);

    function setUp() public {
        /* These need the real Uniswap, so they only mean anything on a fork.
         * Run without one they failed rather than skipped, which turns a green
         * suite into four red lines that say nothing about the code. */
        if (FACTORY.code.length == 0) {
            vm.skip(true);
            return;
        }
        curve = new WavesCurve(platform, GRAD, V_ETH, V_TOKENS, SUPPLY, FACTORY, WETH, FEE);
        vm.deal(alice, 100 ether);
        vm.deal(creator, 10 ether);
    }

    function test_graduatesIntoARealPool() public {
        vm.prank(creator);
        address token = curve.launch("Fart", "FART", 300, 0, "", "", "");

        // fill the curve past its threshold
        vm.prank(alice);
        curve.buy{value: 6 ether}(token, 0);
        assertTrue(curve.ready(token), "should be past the threshold");

        (, , , , uint96 raised, uint96 left, ) = curve.curves(token);
        emit log_named_decimal_uint("raised at graduation", raised, 18);
        emit log_named_decimal_uint("tokens left for the pool", left, 18);

        curve.graduate(token);

        address pool = curve.poolOf(token);
        assertTrue(pool != address(0), "no pool was created");

        // the pool is real, priced, and holds the liquidity
        (uint160 sqrtP, , , , , , ) = IPool(pool).slot0();
        assertGt(sqrtP, 0, "pool was never initialised");
        assertGt(IPool(pool).liquidity(), 0, "pool has no liquidity");
        assertEq(IPool(pool).fee(), FEE);

        // and it is the pair we meant to make
        address t0 = IPool(pool).token0();
        address t1 = IPool(pool).token1();
        assertTrue((t0 == token && t1 == WETH) || (t0 == WETH && t1 == token), "wrong pair");

        // the curve kept nothing back
        (, , , , uint96 raisedAfter, uint96 leftAfter, bool graduated) = curve.curves(token);
        assertTrue(graduated);
        assertEq(raisedAfter, 0);
        assertEq(leftAfter, 0);

        emit log_named_uint("pool liquidity", IPool(pool).liquidity());
    }

    function test_cannotTradeOnTheCurveAfterGraduation() public {
        vm.prank(creator);
        address token = curve.launch("Fart", "FART", 300, 0, "", "", "");
        vm.prank(alice); curve.buy{value: 6 ether}(token, 0);
        curve.graduate(token);

        vm.prank(alice);
        vm.expectRevert(WavesCurve.AlreadyGraduated.selector);
        curve.buy{value: 1 ether}(token, 0);
    }

    function test_cannotGraduateTwice() public {
        vm.prank(creator);
        address token = curve.launch("Fart", "FART", 300, 0, "", "", "");
        vm.prank(alice); curve.buy{value: 6 ether}(token, 0);
        curve.graduate(token);

        vm.expectRevert(WavesCurve.AlreadyGraduated.selector);
        curve.graduate(token);
    }

    function test_cannotGraduateEarly() public {
        vm.prank(creator);
        address token = curve.launch("Fart", "FART", 300, 0, "", "", "");
        vm.prank(alice); curve.buy{value: 1 ether}(token, 0);

        vm.expectRevert(WavesCurve.NotGraduated.selector);
        curve.graduate(token);
    }

    /// The whole point of the lock: no path exists to take the liquidity back.
    function test_thereIsNoWayToWithdrawTheLiquidity() public {
        vm.prank(creator);
        address token = curve.launch("Fart", "FART", 300, 0, "", "", "");
        vm.prank(alice); curve.buy{value: 6 ether}(token, 0);
        curve.graduate(token);

        uint128 before = IPool(curve.poolOf(token)).liquidity();

        // nothing on the contract can reduce it — not for the creator, not for us
        vm.prank(creator); curve.collectPoolFees(token);
        vm.prank(platform); curve.collectPoolFees(token);

        assertEq(IPool(curve.poolOf(token)).liquidity(), before, "liquidity moved");
    }
}
