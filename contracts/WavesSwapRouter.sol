// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/**
 * WavesSwapRouter — turn ETH into a reward asset, on Uniswap V4.
 *
 * ── Why this contract has to exist ───────────────────────────────────────────
 * The rewards keeper is an ordinary wallet. It claims a pot of ETH from the
 * curve and owes holders whatever asset their creator chose. On Solana that is
 * one Jupiter call. On V4 it cannot be a call at all: a swap only happens
 * inside a lock the PoolManager hands out, and it hands it to a CONTRACT — it
 * calls `unlockCallback` back on whoever asked. An externally owned account has
 * no callback to receive, so a wallet cannot swap on V4 at any price.
 *
 * That is the whole reason the keeper pays ETH today regardless of what the
 * creator picked, and this is the missing piece.
 *
 * ── Quoting, and why it is half of this file ─────────────────────────────────
 * Picking the pool is the hard part, not swapping through it. There is no such
 * thing as "the ETH/USDG pool": USDG alone has eighty ETH pairs on this chain,
 * most of them initialised once and never funded. An empty pool does not
 * revert — it fills for ZERO and hands the ETH back — so a keeper that trusted
 * the first key it found would pay holders nothing and report success.
 *
 * So the keeper has to price them. Eighty RPC round trips per payout is not
 * viable against a node that rate-limits, and this chain refuses JSON-RPC
 * batching, so the loop runs on chain instead: `quoteBest` prices every pool in
 * one `eth_call` and names the deepest.
 *
 * Each quote performs a REAL swap and then reverts, carrying the result out in
 * the revert data — Uniswap's own quoter trick. The revert is what makes it
 * honest and what makes it free: pool state unwinds, so nothing is spent, no
 * debt is settled, and the number is the true fill rather than a reimplementation
 * of the curve that can only ever be approximately right.
 *
 * ⚠️ It holds nothing. There is no owner, no withdrawal, no upgrade and no
 * storage that survives a call. Anyone may call it; they are spending their own
 * ETH and naming their own recipient, so there is nothing here to steal and no
 * privileged caller to impersonate. That is deliberate: a keeper-only router
 * would be a contract whose failure mode is "the keeper's money is stuck in
 * it", and this way there is never any money in it to be stuck.
 *
 * ⚠️ NOT AUDITED.
 */

type Currency is address;

struct PoolKey {
    Currency currency0;      // the lower address; native ETH is zero, so always first
    Currency currency1;
    uint24 fee;
    int24 tickSpacing;
    address hooks;
}

struct SwapParams {
    bool zeroForOne;
    /* Negative is EXACT INPUT — "spend this much" — which is what a payout
     * needs: the pot is a fixed number of wei and whatever it buys is what
     * holders get. Positive would mean "obtain this much", and the amount we
     * would then owe is not known until the swap runs. */
    int256 amountSpecified;
    uint160 sqrtPriceLimitX96;
}

interface IPoolManager {
    function unlock(bytes calldata data) external returns (bytes memory);
    /* Returns BalanceDelta: two int128s packed into one int256, amount0 in the
     * high half. Negative means this contract owes the pool. */
    function swap(PoolKey memory key, SwapParams memory params, bytes calldata hookData)
        external returns (int256 delta);
    function settle() external payable returns (uint256);
    function sync(Currency currency) external;
    function take(Currency currency, address to, uint256 amount) external;
}

interface IERC20 {
    function transfer(address to, uint256 amount) external returns (bool);
    function balanceOf(address account) external view returns (uint256);
}

contract WavesSwapRouter {
    IPoolManager public immutable poolManager;

    uint8 internal constant MODE_SWAP = 0;
    uint8 internal constant MODE_QUOTE = 1;

    /* The ends of the tick range, as sqrt prices. A V4 swap will not run
     * without a limit, and for a payout there is no price we want to stop at —
     * slippage is enforced by minOut, which is a number of TOKENS and therefore
     * the thing actually being promised. A price limit would silently deliver a
     * partial fill instead, leaving ETH unspent and holders short. */
    uint160 internal constant MIN_SQRT_PRICE = 4295128739 + 1;

    error NotPoolManager();
    error NotNative();
    error NothingIn();
    error NothingOut();
    error TooLittleOut(uint256 got, uint256 wanted);
    error TransferFailed();
    error NotSelf();

    /// Not a failure: how a quote returns its answer. See `quote`.
    error QuoteResult(uint256 amountOut);

    event Swapped(
        address indexed token, address indexed recipient,
        uint256 ethIn, uint256 amountOut
    );

    constructor(address _poolManager) {
        poolManager = IPoolManager(_poolManager);
    }

    // ───────────────────────────────────────────────────────────── swapping

    /**
     * Spend `msg.value` of ETH on `key`'s token and send the proceeds to
     * `recipient`. Returns how much was bought.
     *
     * ⚠️ minOut 0 is never safe to SEND. An unprotected swap on a public
     * mempool is a sandwich waiting to happen, and this money belongs to a
     * token's holders rather than to whoever is running the keeper. Get the
     * number from `quoteBest` and take a few percent off it.
     */
    function swap(PoolKey calldata key, uint256 minOut, address recipient)
        external payable returns (uint256 amountOut)
    {
        if (Currency.unwrap(key.currency0) != address(0)) revert NotNative();
        if (msg.value == 0) revert NothingIn();

        address to = recipient == address(0) ? msg.sender : recipient;
        bytes memory out = poolManager.unlock(abi.encode(MODE_SWAP, key, msg.value, to));
        amountOut = abi.decode(out, (uint256));

        /* An empty pool fills for zero rather than reverting — it is
         * initialised, it just has no liquidity, and V4 is under no obligation
         * to complain about that. Left alone, the keeper would send a payout,
         * get a successful receipt, and have moved nothing. Refuse instead. */
        if (amountOut == 0) revert NothingOut();
        if (amountOut < minOut) revert TooLittleOut(amountOut, minOut);

        emit Swapped(Currency.unwrap(key.currency1), to, msg.value, amountOut);
    }

    // ───────────────────────────────────────────────────────────── quoting

    /**
     * What `amountIn` wei would actually buy through this pool, right now.
     * Zero if the pool is empty, uninitialised, or refuses the trade.
     *
     * Costs nothing and settles nothing: the swap runs and is then thrown away
     * by reverting out of the lock. Safe to call on chain, though the keeper
     * calls it with `eth_call` and never pays for it at all.
     */
    function quote(PoolKey calldata key, uint256 amountIn) public returns (uint256) {
        if (amountIn == 0) return 0;
        try this.quoteRevert(key, amountIn) {
            return 0;                      // unreachable: quoteRevert always reverts
        } catch (bytes memory reason) {
            return _decodeQuote(reason);
        }
    }

    /**
     * Price every pool in one call and name the best.
     *
     * The reason quoting is on chain at all. Assets here have dozens of ETH
     * pairs and the deepest one changes; asking a rate-limited node about each
     * separately is both slow and a good way to get throttled mid-payout.
     *
     * `bestOut` of zero means none of them can fill — the caller must treat
     * that as "do not swap", not as "use pool 0".
     */
    function quoteBest(PoolKey[] calldata keys, uint256 amountIn)
        external returns (uint256 bestIndex, uint256 bestOut)
    {
        for (uint256 i = 0; i < keys.length; i++) {
            uint256 out = quote(keys[i], amountIn);
            if (out > bestOut) { bestOut = out; bestIndex = i; }
        }
    }

    /**
     * Runs the swap and then throws the result, so the pool unwinds.
     *
     * External because a contract cannot catch its own internal reverts —
     * try/catch needs a real call frame — but restricted to this contract so it
     * is not mistaken for a way to move money.
     */
    function quoteRevert(PoolKey calldata key, uint256 amountIn) external {
        if (msg.sender != address(this)) revert NotSelf();
        poolManager.unlock(abi.encode(MODE_QUOTE, key, amountIn, address(0)));
    }

    /* A quote comes back as QuoteResult(uint256) in revert data. Anything else
     * is a genuine failure — an uninitialised pool, a hook saying no — and
     * reads as zero, which is exactly what the caller should do with it. */
    function _decodeQuote(bytes memory reason) internal pure returns (uint256 out) {
        if (reason.length != 36) return 0;
        bytes4 sig;
        assembly {
            sig := mload(add(reason, 0x20))
            out := mload(add(reason, 0x24))
        }
        if (sig != QuoteResult.selector) return 0;
    }

    // ───────────────────────────────────────────────────────────── the lock

    /**
     * Everything that touches the pool happens in here. On a swap the debt has
     * to be square before it returns; on a quote it never returns at all.
     */
    function unlockCallback(bytes calldata data) external returns (bytes memory) {
        if (msg.sender != address(poolManager)) revert NotPoolManager();

        (uint8 mode, PoolKey memory key, uint256 ethIn, address recipient) =
            abi.decode(data, (uint8, PoolKey, uint256, address));

        int256 delta = poolManager.swap(
            key,
            SwapParams({
                // ETH is currency0, so buying the token is always zero-for-one
                zeroForOne: true,
                amountSpecified: -int256(ethIn),
                sqrtPriceLimitX96: MIN_SQRT_PRICE
            }),
            ""
        );

        // amount0 is the ETH side and comes back negative: what we owe the pool
        int128 owed0 = int128(delta >> 128);
        int128 got1 = int128(delta);
        uint256 amountOut = got1 > 0 ? uint256(uint128(got1)) : 0;

        /* A quote stops here and unwinds. Nothing is settled and nothing is
         * taken, so the pool is left exactly as it was found — which is the
         * point, and also why no ETH is needed to ask. */
        if (mode == MODE_QUOTE) revert QuoteResult(amountOut);

        if (owed0 < 0) {
            // native: handed over with the call, so no sync/measure step
            poolManager.settle{value: uint256(uint128(-owed0))}();
        }
        if (amountOut > 0) {
            poolManager.take(key.currency1, recipient, amountOut);
        }

        /* Exact input should consume the lot, but a hooked pool can take less
         * than it was offered. Whatever the pool did not take goes back rather
         * than staying here — this contract must never hold a balance, because
         * a balance is something the next caller could spend. */
        uint256 unspent = address(this).balance;
        if (unspent > 0) {
            (bool ok, ) = recipient.call{value: unspent}("");
            if (!ok) revert TransferFailed();
        }

        return abi.encode(amountOut);
    }

    /* The PoolManager sends native currency here when taking it out of a pool.
     * Nothing else should, and anything that lands is forwarded on by the
     * callback above before the call ends. */
    receive() external payable {}
}
