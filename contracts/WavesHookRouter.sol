// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

/*
 *   ~ ~ ~   W A V E S   ~ ~ ~
 *    public swap router for the WavesCurveHook
 *        https://waveslaunchpad.xyz
 *
 * The user-facing entry point for buying and selling a WAVES token while it is
 * on the curve (and after it graduates, since a graduated pool is just a normal
 * V4 AMM and the hook steps aside). Robinhood Chain has no single canonical
 * public router — every launchpad ships its own thin unlock->swap->settle
 * wrapper — so this is ours. It holds no funds between calls and has no owner.
 *
 * A swap through the singleton PoolManager triggers the hook's beforeSwap, which
 * prices the trade against the bonding curve and returns the delta; this router
 * only settles the input it owes and takes the output it is owed, then forwards
 * the output to the recipient. Slippage and deadline are enforced here.
 *
 * A WAVES pool may be quoted in native ETH OR an ERC-20 quote (USDG, a tokenized
 * RWA). The caller names the quote; the router builds the same order-aware pool
 * key the hook uses (currency0 < currency1), and pays/takes the quote as native
 * ETH or ERC-20 accordingly. To buy a token quoted in an illiquid RWA while only
 * holding USDG, route through WavesQuoteAggregator instead — it swaps USDG→quote
 * first, then calls this router.
 */

import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {IUnlockCallback} from "@uniswap/v4-core/src/interfaces/callback/IUnlockCallback.sol";
import {IHooks} from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {BalanceDelta} from "@uniswap/v4-core/src/types/BalanceDelta.sol";
import {SwapParams} from "@uniswap/v4-core/src/types/PoolOperation.sol";
import {TickMath} from "@uniswap/v4-core/src/libraries/TickMath.sol";
import {IERC20Minimal} from "@uniswap/v4-core/src/interfaces/external/IERC20Minimal.sol";
import {CurrencySettler} from "./v4lib/CurrencySettler.sol";

contract WavesHookRouter is IUnlockCallback {
    using CurrencySettler for Currency;

    IPoolManager public immutable manager;
    address public immutable hook;

    // The pool params every WAVES pool is opened with — MUST match
    // WavesCurveHook: no LP fee, spacing 60, this hook. currency0/currency1 are
    // the (quote, token) pair in numeric order.
    uint24 internal constant LP_FEE = 0;
    int24 internal constant TICK_SPACING = 60;

    error Expired();
    error TooLittleReceived();
    error NotManager();
    error TransferFailed();
    error ZeroAmount();
    error BadValue();

    event Buy(address indexed token, address indexed payer, address indexed to, uint256 quoteIn, uint256 tokensOut);
    event Sell(address indexed token, address indexed payer, address indexed to, uint256 tokensIn, uint256 quoteOut);

    constructor(IPoolManager manager_, address hook_) {
        manager = manager_;
        hook = hook_;
    }

    /* Order-aware key for (token, quote), matching WavesCurveHook._key. Returns
     * whether the token is currency1 (quote is currency0). */
    function _key(address token, address quote) internal view returns (PoolKey memory key, bool tokenIs1) {
        (address c0, address c1) = quote < token ? (quote, token) : (token, quote);
        tokenIs1 = (c1 == token);
        key = PoolKey({
            currency0: Currency.wrap(c0),
            currency1: Currency.wrap(c1),
            fee: LP_FEE,
            tickSpacing: TICK_SPACING,
            hooks: IHooks(hook)
        });
    }

    /* Buy `token` (quoted in `quote`) with the quote asset. Exact-input: the
     * whole input is offered, but the curve only accepts what fits (on the
     * boundary buy it takes less and the rest is refunded here). For an ETH quote
     * send the input as msg.value and pass quoteIn = 0; for an ERC-20 quote
     * approve this router and pass quoteIn (msg.value must be 0). `to` receives
     * the tokens; reverts if fewer than `minTokensOut` would arrive. */
    function buy(address token, address quote, uint256 quoteIn, uint256 minTokensOut, address to, uint256 deadline)
        external
        payable
        returns (uint256 tokensOut)
    {
        if (block.timestamp > deadline) revert Expired();

        uint256 amountIn;
        if (quote == address(0)) {
            if (msg.value == 0) revert ZeroAmount();
            amountIn = msg.value;
        } else {
            if (msg.value != 0) revert BadValue();
            if (quoteIn == 0) revert ZeroAmount();
            // Pull the quote in; the callback settles it to the manager.
            if (!IERC20Minimal(quote).transferFrom(msg.sender, address(this), quoteIn)) revert TransferFailed();
            amountIn = quoteIn;
        }

        bytes memory res = manager.unlock(abi.encode(true, token, quote, amountIn, msg.sender, to));
        (tokensOut, ) = abi.decode(res, (uint256, uint256));
        if (tokensOut < minTokensOut) revert TooLittleReceived();
        emit Buy(token, msg.sender, to, amountIn, tokensOut);
    }

    /* Sell `tokensIn` of `token` for its quote asset. Caller must approve this
     * router for `tokensIn` first. `to` receives the quote; reverts below
     * `minQuoteOut`. */
    function sell(address token, address quote, uint256 tokensIn, uint256 minQuoteOut, address to, uint256 deadline)
        external
        returns (uint256 quoteOut)
    {
        if (block.timestamp > deadline) revert Expired();
        if (tokensIn == 0) revert ZeroAmount();
        // Pull the tokens in; the callback settles them to the manager.
        if (!IERC20Minimal(token).transferFrom(msg.sender, address(this), tokensIn)) revert TransferFailed();
        bytes memory res = manager.unlock(abi.encode(false, token, quote, tokensIn, msg.sender, to));
        quoteOut = abi.decode(res, (uint256));
        if (quoteOut < minQuoteOut) revert TooLittleReceived();
        emit Sell(token, msg.sender, to, tokensIn, quoteOut);
    }

    function unlockCallback(bytes calldata data) external returns (bytes memory) {
        if (msg.sender != address(manager)) revert NotManager();
        (bool isBuy, address token, address quote, uint256 amountIn, address payer, address to) =
            abi.decode(data, (bool, address, address, uint256, address, address));

        (PoolKey memory key, bool tokenIs1) = _key(token, quote);
        Currency quoteCur = Currency.wrap(quote);
        Currency tokCur = Currency.wrap(token);

        if (isBuy) {
            // A buy is quote→token. zeroForOne (currency0→currency1) is true when
            // the quote is currency0, i.e. the token is currency1.
            bool zeroForOne = tokenIs1;
            BalanceDelta delta = manager.swap(
                key,
                SwapParams({
                    zeroForOne: zeroForOne,
                    amountSpecified: -int256(amountIn),
                    sqrtPriceLimitX96: zeroForOne ? TickMath.MIN_SQRT_PRICE + 1 : TickMath.MAX_SQRT_PRICE - 1
                }),
                ""
            );
            // Map the delta to quote/token by ordering.
            (int128 quoteDelta, int128 tokenDelta) =
                tokenIs1 ? (delta.amount0(), delta.amount1()) : (delta.amount1(), delta.amount0());
            uint256 accepted = uint256(int256(-quoteDelta)); // router owes this much quote
            uint256 tokensOut = uint256(int256(tokenDelta)); // router is owed this many tokens
            quoteCur.settle(manager, address(this), accepted, false); // pay accepted quote (native or ERC-20)
            tokCur.take(manager, to, tokensOut, false);               // tokens to recipient
            // Refund the overfill the curve did not take (boundary buy / dust) to
            // the original caller — in the quote asset.
            uint256 refund = amountIn - accepted;
            if (refund > 0) _refund(quote, payer, refund);
            return abi.encode(tokensOut, accepted);
        } else {
            // A sell is token→quote. zeroForOne is true when the token is
            // currency0, i.e. the token is NOT currency1.
            bool zeroForOne = !tokenIs1;
            BalanceDelta delta = manager.swap(
                key,
                SwapParams({
                    zeroForOne: zeroForOne,
                    amountSpecified: -int256(amountIn),
                    sqrtPriceLimitX96: zeroForOne ? TickMath.MIN_SQRT_PRICE + 1 : TickMath.MAX_SQRT_PRICE - 1
                }),
                ""
            );
            (int128 quoteDelta, int128 tokenDelta) =
                tokenIs1 ? (delta.amount0(), delta.amount1()) : (delta.amount1(), delta.amount0());
            uint256 tokensOwed = uint256(int256(-tokenDelta)); // router owes the tokens it holds
            uint256 quoteOut = uint256(int256(quoteDelta));    // router is owed this much quote
            tokCur.settle(manager, address(this), tokensOwed, false); // pay tokens the router pulled in
            quoteCur.take(manager, to, quoteOut, false);              // quote to recipient
            // Sweep any token the curve did not consume back to the seller.
            uint256 leftover = amountIn - tokensOwed;
            if (leftover > 0) {
                if (!IERC20Minimal(token).transfer(payer, leftover)) revert TransferFailed();
            }
            return abi.encode(quoteOut);
        }
    }

    /* Send `amount` of the quote asset to `to` — native call or ERC-20 transfer. */
    function _refund(address quote, address to, uint256 amount) private {
        if (quote == address(0)) {
            (bool ok, ) = to.call{value: amount}("");
            if (!ok) revert TransferFailed();
        } else {
            if (!IERC20Minimal(quote).transfer(to, amount)) revert TransferFailed();
        }
    }

    // The buy refund / sell sweep goes to the ORIGINAL caller of buy()/sell(),
    // which is carried through the unlock data as `payer` — unlockCallback is
    // invoked BY the manager, so its own msg.sender is the manager, not the user.

    receive() external payable {}
}
