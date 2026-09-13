// SPDX-License-Identifier: MIT

/*

    ██     ██  █████  ██    ██ ███████ ███████
    ██     ██ ██   ██ ██    ██ ██      ██
    ██  █  ██ ███████ ██    ██ █████   ███████
    ██ ███ ██ ██   ██  ██  ██  ██           ██
     ███ ███  ██   ██   ████   ███████ ███████

     .-~~-.__.-~~-.__.-~~-.__.-~~-.__.-~~-.__.-~
    ~-.__.-~~-.__.-~~-.__.-~~-.__.-~~-.__.-~~-.__
     .-~~-.__.-~~-.__.-~~-.__.-~~-.__.-~~-.__.-~

    pay in ETH, land in any paired token.
    https://waveslaunchpad.xyz

*/
pragma solidity ^0.8.26;

/**
 * WavesQuoteAggregator — buy a quote-asset-paired WAVES token with plain ETH.
 *
 * A token can be quoted in an RWA/stock (its pool trades TOKEN ↔ $AAPLx). Buying
 * it normally means already holding $AAPLx — the annoying "go buy the stock
 * first" step. This removes it: pay ETH, and this contract swaps ETH → the quote
 * asset (through the existing WavesSwapRouter, which the keeper already uses for
 * exactly this) and then buys the curve through WavesHookRouter — one tx.
 *
 * ── Two shapes, matching the swap router ─────────────────────────────────────
 *   buyWithEth    ETH → quote directly            (quote has a good ETH pool: USDG,
 *                                                   or a stock with an ETH pair)
 *   buyWithEth2   ETH → USDG → quote              (stocks with no usable ETH pool;
 *                                                   USDG is the universal middle leg)
 * If a buyer already holds the quote asset they skip this entirely and call
 * WavesHookRouter.buy directly.
 *
 * ── It holds nothing ─────────────────────────────────────────────────────────
 * No owner, no upgrade, no storage that survives a call. Every leg's proceeds
 * pass straight through, and anything left over (the swap router's ETH dust, the
 * hook router's boundary-buy refund in the quote asset) is swept to the caller
 * before the call returns — there is never a balance here for the next caller to
 * spend. minOut is enforced on BOTH the ETH→quote leg and the final token-out,
 * so a sandwiched or empty-pool route reverts rather than delivering dust.
 */

/* Mirrors WavesSwapRouter.PoolKey / WavesHookRouter pool key ABI:
 * (address,address,uint24,int24,address). The front-end picks the leg pool from
 * rh-assets.json and passes it here. */
struct LegKey {
    address currency0;
    address currency1;
    uint24 fee;
    int24 tickSpacing;
    address hooks;
}

interface IWavesSwapRouter {
    function swap(LegKey calldata key, uint256 minOut, address recipient)
        external payable returns (uint256 amountOut);
    function swap2(LegKey calldata keyA, LegKey calldata keyB, uint256 minOut, address recipient)
        external payable returns (uint256 amountOut);
}

interface IWavesHookRouter {
    function buy(address token, address quote, uint256 quoteIn, uint256 minTokensOut, address to, uint256 deadline)
        external payable returns (uint256 tokensOut);
}

interface IERC20 {
    function approve(address spender, uint256 amount) external returns (bool);
    function transfer(address to, uint256 amount) external returns (bool);
    function balanceOf(address account) external view returns (uint256);
}

contract WavesQuoteAggregator {
    IWavesSwapRouter public immutable swapRouter;
    IWavesHookRouter public immutable hookRouter;

    error Expired();
    error ZeroValue();
    error TooLittleQuote();
    error TransferFailed();

    event ZapBought(
        address indexed token, address indexed quote, address indexed to,
        uint256 ethIn, uint256 quoteMid, uint256 tokensOut
    );

    constructor(IWavesSwapRouter swapRouter_, IWavesHookRouter hookRouter_) {
        swapRouter = swapRouter_;
        hookRouter = hookRouter_;
    }

    /* Pay ETH, land `token`. `legKey` is the ETH→quote pool (front-end picks the
     * deepest from rh-assets.json). `minQuoteOut` protects the ETH→quote leg;
     * `minTokensOut` protects the final buy. Tokens go to `to`; any leftover ETH
     * or quote is refunded to the caller. */
    function buyWithEth(
        address token,
        address quote,
        LegKey calldata legKey,
        uint256 minQuoteOut,
        uint256 minTokensOut,
        address to,
        uint256 deadline
    ) external payable returns (uint256 tokensOut) {
        if (block.timestamp > deadline) revert Expired();
        if (msg.value == 0) revert ZeroValue();
        // Baselines BEFORE this call adds anything, so the sweep returns only what
        // this call leaves behind — never a prior donation (L-1).
        uint256 quoteBefore = IERC20(quote).balanceOf(address(this));
        uint256 ethBefore = address(this).balance - msg.value;
        uint256 quoteMid = swapRouter.swap{value: msg.value}(legKey, minQuoteOut, address(this));
        tokensOut = _buyAndSweep(token, quote, quoteMid, minTokensOut, to, deadline, quoteBefore, ethBefore);
        emit ZapBought(token, quote, to, msg.value, quoteMid, tokensOut);
    }

    /* Pay ETH for a quote only reachable via USDG. `ethToMid` is an ETH pair
     * (ETH→USDG), `midToQuote` shares that middle currency (USDG→quote). */
    function buyWithEth2(
        address token,
        address quote,
        LegKey calldata ethToMid,
        LegKey calldata midToQuote,
        uint256 minQuoteOut,
        uint256 minTokensOut,
        address to,
        uint256 deadline
    ) external payable returns (uint256 tokensOut) {
        if (block.timestamp > deadline) revert Expired();
        if (msg.value == 0) revert ZeroValue();
        uint256 quoteBefore = IERC20(quote).balanceOf(address(this));
        uint256 ethBefore = address(this).balance - msg.value;
        uint256 quoteMid = swapRouter.swap2{value: msg.value}(ethToMid, midToQuote, minQuoteOut, address(this));
        tokensOut = _buyAndSweep(token, quote, quoteMid, minTokensOut, to, deadline, quoteBefore, ethBefore);
        emit ZapBought(token, quote, to, msg.value, quoteMid, tokensOut);
    }

    /* Buy the curve with the quote just acquired, then sweep every stray balance
     * back to the caller so nothing is ever left in this contract. */
    function _buyAndSweep(
        address token,
        address quote,
        uint256 quoteMid,
        uint256 minTokensOut,
        address to,
        uint256 deadline,
        uint256 quoteBefore,
        uint256 ethBefore
    ) private returns (uint256 tokensOut) {
        if (quoteMid == 0) revert TooLittleQuote();
        // Approve exactly what we hold for this buy (reset to 0 first for tokens
        // that require it), then buy the curve; tokens go straight to `to`.
        IERC20(quote).approve(address(hookRouter), 0);
        IERC20(quote).approve(address(hookRouter), quoteMid);
        tokensOut = hookRouter.buy(token, quote, quoteMid, minTokensOut, to, deadline);

        // Sweep only what THIS call left behind (the hook router refunds a
        // boundary-buy overfill in the quote asset; the swap router can return ETH
        // dust) — measured against the pre-call baselines, so a prior donation is
        // left untouched rather than paid to whoever calls next (L-1).
        uint256 quoteNow = IERC20(quote).balanceOf(address(this));
        if (quoteNow > quoteBefore) {
            if (!IERC20(quote).transfer(msg.sender, quoteNow - quoteBefore)) revert TransferFailed();
        }
        uint256 ethNow = address(this).balance;
        if (ethNow > ethBefore) {
            (bool ok, ) = msg.sender.call{value: ethNow - ethBefore}("");
            if (!ok) revert TransferFailed();
        }
    }

    receive() external payable {}
}
