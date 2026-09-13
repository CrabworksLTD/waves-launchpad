// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {PoolId} from "@uniswap/v4-core/src/types/PoolId.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {IHooks} from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import {MockERC20} from "solmate/src/test/utils/mocks/MockERC20.sol";
import {HookMiner} from "../contracts/v4lib/HookMiner.sol";
import {WavesCurveHook} from "../contracts/WavesCurveHook.sol";
import {WavesHookRouter} from "../contracts/WavesHookRouter.sol";
import {WavesToken} from "../contracts/WavesToken.sol";

/**
 * The quote-asset hook, against the REAL Uniswap V4 PoolManager on Robinhood
 * Chain — the thing a local PoolManager instance cannot vouch for: that an
 * ERC-20-quoted pool initializes, prices, settles (via ERC-6909 claims) and
 * graduates identically on the deployed manager as it does in the unit tests.
 *
 *   FOUNDRY_PROFILE=v4 forge test --match-path test/WavesCurveHookQuote.fork.t.sol \
 *     --fork-url https://rpc.mainnet.chain.robinhood.com --evm-version cancun -vv
 *
 * ⚠️ --evm-version cancun is not optional (V4's lock is transient storage). A
 * mock ERC-20 stands in for the quote so the test needs no whale — the manager
 * does not care what the quote token is, only that the accounting balances.
 * Skipped (not failed) off-fork, so plain `forge test` stays green.
 */
contract WavesCurveHookQuoteForkTest is Test {
    address constant POOL_MANAGER = 0x8366a39CC670B4001A1121B8F6A443A643e40951;

    WavesCurveHook hook;
    WavesHookRouter router;
    MockERC20 quote;

    address platform = address(0xA11CE);
    address creator = address(0xC0FFEE);
    address buyer = address(0xB0BB);

    uint256 constant GRAD = 4 ether;
    uint256 constant VETH = 1.41 ether;
    uint256 constant VTOK = 1_073_000_000e18;
    uint256 constant SUPPLY = 1_000_000_000e18;
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
        require(address(hook.manager()) == POOL_MANAGER, "wrong manager");
        router = new WavesHookRouter(IPoolManager(POOL_MANAGER), address(hook));

        quote = new MockERC20("Quote", "Q", 18);
        vm.prank(platform);
        hook.setQuote(address(quote), true, uint96(GRAD));
    }

    function _key(address token) internal view returns (PoolKey memory key, bool tokenIs1) {
        (address c0, address c1) =
            address(quote) < token ? (address(quote), token) : (token, address(quote));
        tokenIs1 = (c1 == token);
        key = PoolKey({
            currency0: Currency.wrap(c0), currency1: Currency.wrap(c1),
            fee: 0, tickSpacing: 60, hooks: IHooks(address(hook))
        });
    }

    function _raised(PoolKey memory key) internal view returns (uint96 raised, bool full, bool grad) {
        (,,,,, raised,, full, grad,,,,) = hook.curves(key.toId());
    }

    // launch a quoted pool, buy with the quote through the router, then sell back
    function test_quoted_launch_buy_sell_on_real_manager() public onFork {
        vm.prank(creator);
        address token = hook.launch("Paired", "PAIR", 100, "l", "d", "s", address(quote), 0);
        (PoolKey memory key,) = _key(token);

        quote.mint(buyer, 1 ether);
        vm.startPrank(buyer);
        quote.approve(address(router), 1 ether);
        uint256 out = router.buy(token, address(quote), 1 ether, 0, buyer, block.timestamp);
        vm.stopPrank();

        assertGt(out, 0, "no tokens from the quoted buy");
        assertEq(WavesToken(token).balanceOf(buyer), out, "buyer did not receive the tokens");
        (uint96 raised,,) = _raised(key);
        assertGt(uint256(raised), 0, "curve took no quote");

        // sell half back for the quote
        uint256 sellAmt = out / 2;
        uint256 qBefore = quote.balanceOf(buyer);
        vm.startPrank(buyer);
        WavesToken(token).approve(address(router), sellAmt);
        uint256 back = router.sell(token, address(quote), sellAmt, 0, buyer, block.timestamp);
        vm.stopPrank();
        assertGt(back, 0, "no quote returned on sell");
        assertEq(quote.balanceOf(buyer) - qBefore, back, "seller did not get the quote");
    }

    // fill the curve with the quote and graduate it on the real manager
    function test_quoted_graduation_on_real_manager() public onFork {
        vm.prank(creator);
        address token = hook.launch("Grad", "GRAD", 100, "l", "d", "s", address(quote), 0);
        (PoolKey memory key, bool tokenIs1) = _key(token);

        quote.mint(buyer, GRAD + 1 ether);
        vm.startPrank(buyer);
        quote.approve(address(router), GRAD + 1 ether);
        router.buy(token, address(quote), GRAD + 1 ether, 0, buyer, block.timestamp);
        vm.stopPrank();

        (, bool full,) = _raised(key);
        assertTrue(full, "curve did not fill");

        hook.graduate(token);
        (,, bool grad) = _raised(key);
        assertTrue(grad, "did not graduate");

        // graduated pool trades as an ordinary AMM: another quoted buy lands tokens
        uint256 had = WavesToken(token).balanceOf(buyer);
        quote.mint(buyer, 0.2 ether);
        vm.startPrank(buyer);
        quote.approve(address(router), 0.2 ether);
        router.buy(token, address(quote), 0.2 ether, 0, buyer, block.timestamp);
        vm.stopPrank();
        assertGt(WavesToken(token).balanceOf(buyer), had, "post-grad AMM buy gave nothing");
        tokenIs1; // silence unused in case of compiler strictness
    }
}
