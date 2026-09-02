// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/**
 * WavesToken — a fixed-supply ERC20 for a WAVES launch on an EVM chain.
 *
 * Deliberately the smallest thing that can be a memecoin. Everything a holder
 * has to trust is decided at construction and cannot move afterwards:
 *
 *   - the entire supply is minted once, in the constructor, and there is no
 *     mint function at all — not an owner-gated one, not a disabled one
 *   - there is no owner, no admin, no pause, no blacklist, no transfer hook
 *     and no upgrade path, so there is no key whose loss or misuse matters
 *   - name, symbol and decimals are immutable
 *
 * That means the only interesting thing about a launch is where the supply
 * goes, which is the launcher's job, not this contract's.
 *
 * No inheritance and no library: the whole of ERC20 is ~40 lines, and a reader
 * checking whether their money is safe should not have to follow an import
 * graph to find out. Deliberately NOT ERC20Permit — signatures are the part of
 * a token people lose money to, and a memecoin does not need them.
 */
contract WavesToken {
    string public name;
    string public symbol;
    uint8 public constant decimals = 18;
    uint256 public immutable totalSupply;

    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);

    error InsufficientBalance();
    error InsufficientAllowance();
    error ZeroAddress();

    /**
     * @param name_     display name, immutable
     * @param symbol_   ticker, immutable
     * @param supply_   the entire supply, in wei-equivalent units (18 dp)
     * @param mintTo_   who receives it — the launcher, which then seeds the pool
     */
    constructor(string memory name_, string memory symbol_, uint256 supply_, address mintTo_) {
        if (mintTo_ == address(0)) revert ZeroAddress();
        name = name_;
        symbol = symbol_;
        totalSupply = supply_;
        balanceOf[mintTo_] = supply_;
        // a mint is a transfer from nowhere; indexers expect to see it
        emit Transfer(address(0), mintTo_, supply_);
    }

    function transfer(address to, uint256 value) external returns (bool) {
        return _move(msg.sender, to, value);
    }

    function approve(address spender, uint256 value) external returns (bool) {
        allowance[msg.sender][spender] = value;
        emit Approval(msg.sender, spender, value);
        return true;
    }

    function transferFrom(address from, address to, uint256 value) external returns (bool) {
        uint256 allowed = allowance[from][msg.sender];
        /* An infinite approval is not decremented. It is the convention every
         * router and pool expects, and rewriting a full-slot allowance on every
         * swap costs gas to change a number that is already effectively
         * unlimited. */
        if (allowed != type(uint256).max) {
            if (allowed < value) revert InsufficientAllowance();
            unchecked { allowance[from][msg.sender] = allowed - value; }
        }
        return _move(from, to, value);
    }

    function _move(address from, address to, uint256 value) private returns (bool) {
        /* Sending to address(0) is not a burn here — this token has no burn, so
         * it would be a silent, permanent loss that still counts in
         * totalSupply. Refusing it is the honest answer. */
        if (to == address(0)) revert ZeroAddress();
        uint256 bal = balanceOf[from];
        if (bal < value) revert InsufficientBalance();
        unchecked {
            balanceOf[from] = bal - value;
            // cannot overflow: the sum of all balances is totalSupply
            balanceOf[to] += value;
        }
        emit Transfer(from, to, value);
        return true;
    }
}
