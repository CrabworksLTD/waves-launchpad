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

    fair-launch bonding curves. hold, earn, ride.
    https://waveslaunchpad.xyz

*/
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

    /* ── On-chain identity ───────────────────────────────────────────────────
     *
     * A picture, a description and a link, readable from the chain.
     *
     * ⚠️ This is not decoration. On Solana a mint points at a metadata account
     * and every aggregator reads the image from there. An ERC20 has no such
     * thing, so a token with only a name and a symbol shows up on GMGN as a
     * grey letter placeholder — forever, because nothing off-chain can be
     * attached to it later.
     *
     * The names and shapes here copy what tokens launched by Pons expose on
     * this chain (`logo()`, `description()`, `socials()`, `getTokenInfo()`),
     * because those are the ones the indexers on Robinhood are already reading.
     * `logo()` is the one that matters and the one we are most confident about;
     * the rest cost a few words of storage and might as well be right.
     *
     * Set once in the constructor and never written again. There is no setter:
     * a token whose picture can be changed after people have bought it is a
     * token whose picture means nothing. */
    string public logo;
    string public description;
    string public socials;

    /// Who launched it. The curve passes this through; it is not msg.sender,
    /// which at construction time is the curve itself.
    address public immutable deployer;

    /// Everything an indexer wants, in one call.
    function getTokenInfo()
        external
        view
        returns (address, string memory, string memory, string memory)
    {
        return (deployer, logo, description, socials);
    }

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
     * @param deployer_ who launched it (the curve's caller, not the curve)
     * @param logo_     an image URI an indexer can fetch — see the note above
     * @param desc_     one-line description
     * @param socials_  a link, usually x.com
     */
    constructor(
        string memory name_,
        string memory symbol_,
        uint256 supply_,
        address mintTo_,
        address deployer_,
        string memory logo_,
        string memory desc_,
        string memory socials_
    ) {
        if (mintTo_ == address(0)) revert ZeroAddress();
        name = name_;
        symbol = symbol_;
        totalSupply = supply_;
        deployer = deployer_;
        logo = logo_;
        description = desc_;
        socials = socials_;
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
