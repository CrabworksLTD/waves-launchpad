// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

interface IERC20Min {
    function balanceOf(address) external view returns (uint256);
    function transfer(address, uint256) external returns (bool);
}

interface IMintCallback {
    function uniswapV3MintCallback(uint256 amount0, uint256 amount1, bytes calldata data) external;
}

/**
 * Just enough Uniswap V3 to graduate into, locally.
 *
 * Robinhood Chain rate-limits hard enough that a fork cannot serve an invariant
 * run — anvil could not even finish fetching the block. Without something local
 * the fuzzer only ever sees curves that never close, and graduation is exactly
 * where the sold-out bug surfaced, so that is the wrong half to leave untested.
 *
 * This is a mock, so it proves nothing about the real Uniswap. It does not need
 * to: Graduation.fork.t.sol runs the same code against the real factory and is
 * the authority on that. What this is for is ORDERING — a sell arriving on a
 * token that graduated three calls ago, a claim after the ETH has left for the
 * pool — which is about our contract, not theirs.
 *
 * The one thing it models faithfully is that the pool demands payment inside
 * the mint callback and reverts if it does not arrive. That is the part of the
 * handshake we could get wrong.
 */
contract MockV3Pool {
    address public immutable token0;
    address public immutable token1;
    uint24  public immutable fee;

    uint160 public sqrtPriceX96;
    uint128 public liquidity;

    uint256 internal constant Q96 = 0x1000000000000000000000000;

    error AlreadyInitialised();
    error ZeroPrice();
    error NotPaid();

    constructor(address a, address b, uint24 fee_) {
        (token0, token1) = a < b ? (a, b) : (b, a);
        fee = fee_;
    }

    function initialize(uint160 p) external {
        if (sqrtPriceX96 != 0) revert AlreadyInitialised();
        // the real pool reverts on a zero price; that is how the bug announced itself
        if (p == 0) revert ZeroPrice();
        sqrtPriceX96 = p;
    }

    function slot0() external view returns (uint160, int24, uint16, uint16, uint16, uint8, bool) {
        return (sqrtPriceX96, int24(0), 0, 0, 0, 0, true);
    }

    function mint(address, int24, int24, uint128 amount, bytes calldata data)
        external returns (uint256 amount0, uint256 amount1)
    {
        /* A full-range position, inverted from the same relation the curve uses
         * to size it: amount0 = L/sqrtP, amount1 = L*sqrtP. */
        amount0 = (uint256(amount) * Q96) / sqrtPriceX96;
        amount1 = (uint256(amount) * sqrtPriceX96) / Q96;

        uint256 before0 = IERC20Min(token0).balanceOf(address(this));
        uint256 before1 = IERC20Min(token1).balanceOf(address(this));
        IMintCallback(msg.sender).uniswapV3MintCallback(amount0, amount1, data);
        if (IERC20Min(token0).balanceOf(address(this)) < before0 + amount0) revert NotPaid();
        if (IERC20Min(token1).balanceOf(address(this)) < before1 + amount1) revert NotPaid();

        liquidity += amount;
    }

    /// Nothing has traded here, so there is nothing to collect. Must not revert.
    function collect(address, int24, int24, uint128, uint128) external pure returns (uint128, uint128) {
        return (0, 0);
    }
}

contract MockV3Factory {
    mapping(bytes32 => address) internal pools;

    function _key(address a, address b, uint24 fee) internal pure returns (bytes32) {
        (address t0, address t1) = a < b ? (a, b) : (b, a);
        return keccak256(abi.encode(t0, t1, fee));
    }

    function getPool(address a, address b, uint24 fee) external view returns (address) {
        return pools[_key(a, b, fee)];
    }

    function createPool(address a, address b, uint24 fee) external returns (address pool) {
        bytes32 k = _key(a, b, fee);
        require(pools[k] == address(0), "exists");
        pool = address(new MockV3Pool(a, b, fee));
        pools[k] = pool;
    }
}

/// WETH, to the extent the curve uses it: wrap on graduation, then transfer.
contract MockWETH {
    string public constant name = "Wrapped Ether";
    uint8 public constant decimals = 18;
    mapping(address => uint256) public balanceOf;

    function deposit() external payable { balanceOf[msg.sender] += msg.value; }

    function transfer(address to, uint256 value) external returns (bool) {
        require(balanceOf[msg.sender] >= value, "balance");
        balanceOf[msg.sender] -= value;
        balanceOf[to] += value;
        return true;
    }
}
