// SPDX-License-Identifier: MIT

/*
 *   ~ ~ ~   W A V E S   ~ ~ ~
 *    sell a quote-paired token straight to ETH
 *        https://waveslaunchpad.xyz
 *
 * A stock-paired token trades against its quote (e.g. Ford), so the hook router
 * pays the SELLER that quote. Nobody wants Ford shares dropped in their wallet
 * for dumping a memecoin — they want ETH. This does token -> quote -> ETH in ONE
 * transaction: it sells the token on the curve through WavesHookRouter, then
 * swaps the quote it receives back to ETH on the quote's own canonical ETH pool,
 * and forwards the ETH to the seller. It holds no funds and has no owner.
 *
 * Single-hop only (quote must have a real ETH pool — 174 of the 175 listed
 * stocks do). A quote-only-against-USDG asset would need a quote->USDG->ETH
 * variant; out of scope here.
 */
pragma solidity ^0.8.26;

import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {IUnlockCallback} from "@uniswap/v4-core/src/interfaces/callback/IUnlockCallback.sol";
import {IHooks} from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {BalanceDelta} from "@uniswap/v4-core/src/types/BalanceDelta.sol";
import {SwapParams} from "@uniswap/v4-core/src/types/PoolOperation.sol";
import {IERC20Minimal} from "@uniswap/v4-core/src/interfaces/external/IERC20Minimal.sol";
import {CurrencySettler} from "./v4lib/CurrencySettler.sol";

interface IWavesHookRouter {
    function sell(address token, address quote, uint256 tokensIn, uint256 minQuoteOut, address to, uint256 deadline)
        external returns (uint256 quoteOut);
}

contract WavesSellRouter is IUnlockCallback {
    using CurrencySettler for Currency;

    IPoolManager public immutable manager;
    address public immutable hookRouter;

    // The ETH end of the quote's own ETH pool. A V4 pool sorts currencies by
    // address, and native ETH is address(0), so ETH is ALWAYS currency0 there —
    // which makes quote -> ETH the currency1 -> currency0 direction (!zeroForOne).
    uint160 internal constant MAX_SQRT_PRICE = 1461446703485210103287273052203988822378723970342 - 1;

    error Expired();
    error TooLittleReceived();
    error NotManager();
    error TransferFailed();
    error ZeroAmount();
    error NotEthPool();

    event SoldForEth(address indexed token, address indexed seller, address indexed to, uint256 tokensIn, uint256 ethOut);

    constructor(IPoolManager manager_, address hookRouter_) {
        manager = manager_;
        hookRouter = hookRouter_;
    }

    /* Sell `tokensIn` of a `quote`-paired `token` and receive ETH. `ethQuoteKey`
     * is the quote's canonical ETH pool (currency0 MUST be native ETH). Caller
     * approves this router for `tokensIn` first. Reverts below `minEthOut`. */
    function sellForEth(
        address token,
        address quote,
        uint256 tokensIn,
        PoolKey calldata ethQuoteKey,
        uint256 minEthOut,
        address to,
        uint256 deadline
    ) external returns (uint256 ethOut) {
        if (block.timestamp > deadline) revert Expired();
        if (tokensIn == 0) revert ZeroAmount();
        if (Currency.unwrap(ethQuoteKey.currency0) != address(0)) revert NotEthPool();
        // the ETH pool must actually be the quote's pool
        if (Currency.unwrap(ethQuoteKey.currency1) != quote) revert NotEthPool();
        // Canonical RH ETH pools are hookless. Pinning hooks to zero stops a caller
        // routing their quote leg through an arbitrary hook that would get control
        // inside this router's unlock — a swap on a real pool needs no hook here.
        if (address(ethQuoteKey.hooks) != address(0)) revert NotEthPool();

        // 1. pull the token and sell it on the curve for the quote (to us)
        if (!IERC20Minimal(token).transferFrom(msg.sender, address(this), tokensIn)) revert TransferFailed();
        IERC20Minimal(token).approve(hookRouter, tokensIn);
        uint256 before = IERC20Minimal(quote).balanceOf(address(this));
        IWavesHookRouter(hookRouter).sell(token, quote, tokensIn, 0, address(this), deadline);
        uint256 quoteGot = IERC20Minimal(quote).balanceOf(address(this)) - before;
        if (quoteGot == 0) revert TooLittleReceived();

        // 2. swap the quote -> ETH on its ETH pool, ETH straight to `to`
        ethOut = abi.decode(manager.unlock(abi.encode(quote, quoteGot, ethQuoteKey, to, msg.sender)), (uint256));
        if (ethOut < minEthOut) revert TooLittleReceived();
        emit SoldForEth(token, msg.sender, to, tokensIn, ethOut);
    }

    function unlockCallback(bytes calldata data) external returns (bytes memory) {
        if (msg.sender != address(manager)) revert NotManager();
        (address quote, uint256 quoteIn, PoolKey memory key, address to, address seller) =
            abi.decode(data, (address, uint256, PoolKey, address, address));

        Currency ethCur = key.currency0;   // native ETH (currency0)
        Currency quoteCur = key.currency1;  // the quote

        // quote -> ETH is currency1 -> currency0, i.e. !zeroForOne, exact-input
        BalanceDelta delta = manager.swap(
            key,
            SwapParams({zeroForOne: false, amountSpecified: -int256(quoteIn), sqrtPriceLimitX96: MAX_SQRT_PRICE}),
            ""
        );
        // currency1 (quote) delta negative: what we owe. currency0 (ETH) positive: what we get.
        uint256 quoteOwed = uint256(int256(-delta.amount1()));
        uint256 ethOut = uint256(int256(delta.amount0()));
        quoteCur.settle(manager, address(this), quoteOwed, false); // pay the quote in
        ethCur.take(manager, to, ethOut, false);                   // ETH to the seller

        // Any quote the pool did not consume (a hooked pool can take less) goes
        // back to the seller rather than staying here.
        uint256 leftover = quoteIn - quoteOwed;
        if (leftover > 0) {
            if (!IERC20Minimal(quote).transfer(seller, leftover)) revert TransferFailed();
        }
        return abi.encode(ethOut);
    }

    receive() external payable {}
}
