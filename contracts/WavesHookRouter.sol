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
    // WavesCurveHook: ETH is currency0, the token currency1, no LP fee, spacing 60.
    uint24 internal constant LP_FEE = 0;
    int24 internal constant TICK_SPACING = 60;

    error Expired();
    error TooLittleReceived();
    error NotManager();
    error TransferFailed();
    error ZeroAmount();

    event Buy(address indexed token, address indexed payer, address indexed to, uint256 ethIn, uint256 tokensOut);
    event Sell(address indexed token, address indexed payer, address indexed to, uint256 tokensIn, uint256 ethOut);

    constructor(IPoolManager manager_, address hook_) {
        manager = manager_;
        hook = hook_;
    }

    function _key(address token) internal view returns (PoolKey memory) {
        return PoolKey({
            currency0: Currency.wrap(address(0)),
            currency1: Currency.wrap(token),
            fee: LP_FEE,
            tickSpacing: TICK_SPACING,
            hooks: IHooks(hook)
        });
    }

    /* Buy `token` with the ETH sent. Exact-input: the whole msg.value is offered,
     * but the curve only accepts what fits (on the boundary buy it takes less and
     * the rest is refunded here). `to` receives the tokens; reverts if fewer than
     * `minTokensOut` would arrive. */
    function buy(address token, uint256 minTokensOut, address to, uint256 deadline)
        external
        payable
        returns (uint256 tokensOut)
    {
        if (block.timestamp > deadline) revert Expired();
        if (msg.value == 0) revert ZeroAmount();
        bytes memory res = manager.unlock(abi.encode(true, token, msg.value, msg.sender, to));
        (tokensOut, ) = abi.decode(res, (uint256, uint256));
        if (tokensOut < minTokensOut) revert TooLittleReceived();
        emit Buy(token, msg.sender, to, msg.value, tokensOut);
    }

    /* Sell `tokensIn` of `token` for ETH. Caller must approve this router for
     * `tokensIn` first. `to` receives the ETH; reverts below `minEthOut`. */
    function sell(address token, uint256 tokensIn, uint256 minEthOut, address to, uint256 deadline)
        external
        returns (uint256 ethOut)
    {
        if (block.timestamp > deadline) revert Expired();
        if (tokensIn == 0) revert ZeroAmount();
        // Pull the tokens in; the callback settles them to the manager.
        if (!IERC20Minimal(token).transferFrom(msg.sender, address(this), tokensIn)) revert TransferFailed();
        bytes memory res = manager.unlock(abi.encode(false, token, tokensIn, msg.sender, to));
        ethOut = abi.decode(res, (uint256));
        if (ethOut < minEthOut) revert TooLittleReceived();
        emit Sell(token, msg.sender, to, tokensIn, ethOut);
    }

    function unlockCallback(bytes calldata data) external returns (bytes memory) {
        if (msg.sender != address(manager)) revert NotManager();
        (bool isBuy, address token, uint256 amountIn, address payer, address to) =
            abi.decode(data, (bool, address, uint256, address, address));

        PoolKey memory key = _key(token);
        Currency eth = Currency.wrap(address(0));
        Currency tok = Currency.wrap(token);

        if (isBuy) {
            BalanceDelta delta = manager.swap(
                key,
                SwapParams({zeroForOne: true, amountSpecified: -int256(amountIn), sqrtPriceLimitX96: TickMath.MIN_SQRT_PRICE + 1}),
                ""
            );
            // ETH (currency0) delta is negative: what the router owes = accepted.
            uint256 accepted = uint256(int256(-delta.amount0()));
            uint256 tokensOut = uint256(int256(delta.amount1()));
            eth.settle(manager, address(this), accepted, false); // pay accepted native ETH
            tok.take(manager, to, tokensOut, false);             // tokens to recipient
            // Refund the overfill the curve did not take (boundary buy / dust) to
            // the original caller — not `to`, and not the manager (our msg.sender).
            uint256 refund = amountIn - accepted;
            if (refund > 0) {
                (bool ok, ) = payer.call{value: refund}("");
                if (!ok) revert TransferFailed();
            }
            return abi.encode(tokensOut, accepted);
        } else {
            BalanceDelta delta = manager.swap(
                key,
                SwapParams({zeroForOne: false, amountSpecified: -int256(amountIn), sqrtPriceLimitX96: TickMath.MAX_SQRT_PRICE - 1}),
                ""
            );
            // token (currency1) delta negative: router owes the tokens it holds.
            uint256 tokensOwed = uint256(int256(-delta.amount1()));
            uint256 ethOut = uint256(int256(delta.amount0()));
            tok.settle(manager, address(this), tokensOwed, false); // pay tokens the router pulled in
            eth.take(manager, to, ethOut, false);                  // ETH to recipient
            // Sweep any token the curve did not consume back to the seller.
            uint256 leftover = amountIn - tokensOwed;
            if (leftover > 0) {
                if (!IERC20Minimal(token).transfer(payer, leftover)) revert TransferFailed();
            }
            return abi.encode(ethOut);
        }
    }

    // The buy refund / sell sweep goes to the ORIGINAL caller of buy()/sell(),
    // which is carried through the unlock data as `payer` — unlockCallback is
    // invoked BY the manager, so its own msg.sender is the manager, not the user.

    receive() external payable {}
}
