// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {PoolKey, ModifyLiquidityParams, Currency} from "../contracts/WavesCurve.sol";

interface IERC20Min {
    function balanceOf(address) external view returns (uint256);
    function transfer(address, uint256) external returns (bool);
}

interface IUnlockCallback {
    function unlockCallback(bytes calldata data) external returns (bytes memory);
}

/**
 * Just enough Uniswap V4 to graduate into, locally.
 *
 * Robinhood rate-limits hard enough that anvil could not finish fetching a
 * single block, so a fork cannot serve an invariant run. This stands in.
 *
 * It is a mock and proves nothing about the real PoolManager. What it does
 * model faithfully is the part our contract can get WRONG: flash accounting.
 * A lock that closes with an unsettled debt reverts here exactly as it would
 * there, so "we added liquidity and forgot to pay for it" cannot pass.
 */
contract MockV4PoolManager {
    uint256 internal constant Q96 = 0x1000000000000000000000000;

    mapping(bytes32 => uint160) public priceOf;
    mapping(bytes32 => uint256) public liquidityOf;

    bool private unlocked;
    // currency => what the caller owes (negative) or is owed (positive)
    mapping(address => int256) private delta;
    address private syncing;
    uint256 private syncedBalance;

    // fees the test can hand to a position, to exercise collection
    mapping(bytes32 => uint128) public pendingFees0;
    mapping(bytes32 => uint128) public pendingFees1;

    error NotUnlocked();
    error AlreadyInitialised();
    error DebtOutstanding(address currency, int256 amount);

    function id(PoolKey memory key) public pure returns (bytes32) {
        return keccak256(abi.encode(key));
    }

    function initialize(PoolKey memory key, uint160 sqrtPriceX96) external returns (int24) {
        bytes32 k = id(key);
        if (priceOf[k] != 0) revert AlreadyInitialised();
        require(sqrtPriceX96 != 0, "price");
        priceOf[k] = sqrtPriceX96;
        return 0;
    }

    /// Open the lock, hand control back, then insist every currency is square.
    function unlock(bytes calldata data) external returns (bytes memory result) {
        unlocked = true;
        result = IUnlockCallback(msg.sender).unlockCallback(data);
        unlocked = false;
        if (delta[address(0)] != 0) revert DebtOutstanding(address(0), delta[address(0)]);
        if (syncing != address(0) && delta[syncing] != 0) {
            revert DebtOutstanding(syncing, delta[syncing]);
        }
        syncing = address(0);
    }

    function modifyLiquidity(PoolKey memory key, ModifyLiquidityParams memory params, bytes calldata)
        external returns (int256 callerDelta, int256 feesAccrued)
    {
        if (!unlocked) revert NotUnlocked();
        bytes32 k = id(key);
        uint160 p = priceOf[k];
        require(p != 0, "uninitialised");

        int128 d0;
        int128 d1;

        if (params.liquidityDelta > 0) {
            /* A full-range position, inverted from the same relation the curve
             * uses to size it: amount0 = L/sqrtP, amount1 = L*sqrtP. */
            uint256 L = uint256(params.liquidityDelta);
            uint256 a0 = (L * Q96) / p;
            uint256 a1 = (L * p) / Q96;
            liquidityOf[k] += L;
            d0 = -int128(int256(a0));
            d1 = -int128(int256(a1));
        } else {
            require(params.liquidityDelta == 0, "this contract must never remove liquidity");
            // a zero change settles up fees, which is how collection works
            d0 = int128(pendingFees0[k]);
            d1 = int128(pendingFees1[k]);
            pendingFees0[k] = 0;
            pendingFees1[k] = 0;
            feesAccrued = _pack(d0, d1);
        }

        address c0 = Currency.unwrap(key.currency0);
        address c1 = Currency.unwrap(key.currency1);
        delta[c0] += d0;
        delta[c1] += d1;
        callerDelta = _pack(d0, d1);
    }

    /// Native ETH arrives with the call; an ERC20 is measured against sync().
    function settle() external payable returns (uint256 paid) {
        if (!unlocked) revert NotUnlocked();
        if (msg.value > 0) {
            delta[address(0)] += int256(msg.value);
            return msg.value;
        }
        address c = syncing;
        require(c != address(0), "sync first");
        uint256 now_ = IERC20Min(c).balanceOf(address(this));
        paid = now_ - syncedBalance;
        delta[c] += int256(paid);
    }

    /* The manager measures what ARRIVED, so it must be told to take a reading
     * before the transfer. Getting this backwards is the classic V4 mistake and
     * the mock reproduces it: settle() would then credit zero. */
    function sync(Currency currency) external {
        address c = Currency.unwrap(currency);
        syncing = c;
        syncedBalance = c == address(0) ? 0 : IERC20Min(c).balanceOf(address(this));
    }

    function take(Currency currency, address to, uint256 amount) external {
        if (!unlocked) revert NotUnlocked();
        address c = Currency.unwrap(currency);
        delta[c] -= int256(amount);
        if (c == address(0)) {
            (bool ok, ) = to.call{value: amount}("");
            require(ok, "eth");
        } else {
            require(IERC20Min(c).transfer(to, amount), "erc20");
        }
    }

    // ── test helpers ─────────────────────────────────────────────────────────
    /// Pretend the position earned fees, so collection has something to move.
    function creditFees(PoolKey memory key, uint128 f0, uint128 f1) external payable {
        bytes32 k = id(key);
        pendingFees0[k] += f0;
        pendingFees1[k] += f1;
    }

    function _pack(int128 a0, int128 a1) internal pure returns (int256) {
        return (int256(a0) << 128) | int256(uint256(uint128(a1)));
    }

    receive() external payable {}
}
