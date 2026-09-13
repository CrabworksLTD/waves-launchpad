// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

interface IERC721Owned {
    function ownerOf(uint256 tokenId) external view returns (address);
}

interface IERC20Burnable {
    function balanceOf(address account) external view returns (uint256);
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
    function transfer(address to, uint256 amount) external returns (bool);
}

/// Pons' fee escrow. Trading fees are credited there under the recipient's
/// name and only the recipient itself may claim — a pull-payment design with
/// no keeper and no threshold, which is why the vault has to do its own
/// pulling (see _harvest).
interface IFeeEscrow {
    function claim() external returns (uint256);
    function claimToken(address token) external returns (uint256);
}

/// @title MoonpadVault
/// @notice Pays a collection's holders out of the trading fees of the coin
///         paired with it. One per collection, deployed unchanged, all variation
///         in constructor arguments — the same shape as every other contract
///         here. No owner, no pause, no rescue, no upgrade.
///
/// Two assets, one job each:
///
///   the coin   what a holder spends to activate a token. Burned outright.
///   ETH        what they earn, arriving from the coin's creator fees.
///
/// The spec this comes from had a fixed bag of coin bought at launch and dripped
/// over a fixed period. Pons V2 has no creator pre-allocation — the whole supply
/// goes onto the curve and a creator buys like anyone else — so funding a bag
/// would mean front-running your own launch, which is the exact behaviour Pons
/// advertises it prevents. Pointing the coin's creator fees here instead needs no
/// bag, cannot be front-run, and pays only while the coin is actually traded.
///
/// Nothing is scheduled. There is no drip rate and no end date: ETH is shared out
/// as it arrives, in proportion to the weight active at that moment. A vault that
/// promised a rate would have to hold enough to keep the promise, and this one
/// never holds anything it has not already been given.
contract MoonpadVault {
    IERC721Owned public immutable collection;

    /// The paired coin, bound once after deploy.
    ///
    /// Not a constructor argument, and not because that would be nicer. Pons
    /// sets a launch's fee recipient at creation, so the vault's address has to
    /// exist before the coin does; and a vault's address depends on its
    /// constructor arguments, so the coin's address cannot be one of them. One
    /// of the two has to be bound afterwards, and the coin is the safe one — a
    /// vault holding no coin and paying nobody is inert, whereas a coin pointing
    /// its fees at the wrong address is not recoverable.
    IERC20Burnable public coin;

    /// Who may bind it, fixed at deploy. Not an owner: this address can do
    /// exactly one thing, once, and then the contract has no privileged caller
    /// for the rest of its life.
    address public immutable binder;

    /// Where burned coin goes. Most tokens have no burn function, and sending to
    /// address(0) reverts in a lot of ERC-20 implementations, so the convention
    /// is an address nobody holds the key to.
    address public constant DEAD = 0x000000000000000000000000000000000000dEaD;

    /// Four rungs, not three. Both the cost and the weight of each are
    /// constructor arguments, so the shape of the ladder is a deploy decision
    /// and not a property of this contract — a collection paying its own coin's
    /// trading fees wants a steep one, and anything with a passive base wants a
    /// flat one. What is fixed here is only how many rungs there are.
    uint256 public constant TIERS = 4;

    /// Cost in coin to activate at each tier, and the share of each payout a
    /// token at that tier receives. Fixed at deploy: a holder buying in at tier 3
    /// is buying a known position, and a vault that could re-weight afterwards
    /// would be selling something it can take back.
    uint256[TIERS] public tierCost;
    uint256[TIERS] public tierWeight;

    struct Slot {
        address holder;   // who activated it; the current owner is who can claim
        uint8 tier;       // 1-indexed; 0 means not active
        uint256 mark;     // accPerWeight when this slot last settled
        uint256 owed;     // settled but unclaimed
    }
    mapping(uint256 => Slot) public slots;

    /// Total weight currently active. Scaled by nothing — weights are small.
    uint256 public totalWeight;

    /// Cumulative wei per unit of weight, scaled by 1e18 so integer division
    /// does not discard the remainder on every deposit. Over many small fee
    /// payments an unscaled accumulator loses real money.
    uint256 public accPerWeight;

    /// ETH that arrived while nothing was active. It cannot be shared — there is
    /// nobody to share it with — so it is held and folded into the next deposit
    /// rather than being stranded or, worse, silently kept.
    uint256 public pending;

    /// Until this timestamp, every deposit is banked into `pending` regardless
    /// of who has activated, and the whole pot folds across everyone active
    /// once the moment passes — a first distribution shared by all who
    /// activated in the window, weighted by tier. Without it the bank folds at
    /// the first deposit after weight exists, which hands everything banked to
    /// whoever happened to activate first. Zero keeps that immediate fold, for
    /// vaults whose fees only start flowing once holders exist anyway.
    /// Immutable like everything else here: nobody can move the date.
    uint256 public immutable pendingRelease;

    uint256 public totalReceived;
    uint256 public totalClaimed;
    uint256 public totalBurned;

    event CoinBound(address coin);
    event Received(uint256 amount, uint256 perWeight, uint256 heldBack);
    event Activated(uint256 indexed tokenId, address indexed holder, uint8 tier, uint256 burned);
    event Deactivated(uint256 indexed tokenId, address indexed was);
    event Claimed(uint256 indexed tokenId, address indexed to, uint256 amount);

    error BadConfig();
    error CoinAlreadySet();
    error CoinNotSet();
    error NotBinder();
    error NotOwner();
    error BadTier();
    error AlreadyActive();
    error NotActive();
    error NothingOwed();
    error TransferFailed();
    error BurnFailed();
    error TooEarly();
    error NotEthVault();
    error Reentrant();

    /// The fee escrow this vault harvests from, or zero for a vault whose fees
    /// arrive by direct send only. Immutable like everything else here: the
    /// escrow is protocol infrastructure fixed before the vault exists, and an
    /// updatable pointer would be an owner by another name.
    address public immutable escrow;

    /// What this vault pays out in. Zero is native ETH; anything else is the
    /// ERC-20 the launch was paired against, and the asset Pons credits its
    /// creator fees in.
    ///
    /// Immutable like everything else here. A vault pointed at the wrong asset
    /// is a redeploy, not a fix — and one whose payToken disagrees with its
    /// launch's pairToken could never be paid at all, because Pons would credit
    /// fees in an asset this contract does not account.
    address public immutable payToken;

    constructor(
        address collection_,
        address binder_,
        uint256[TIERS] memory costs,
        uint256[TIERS] memory weights,
        uint256 pendingRelease_,
        address escrow_,
        address payToken_
    ) {
        if (collection_ == address(0) || binder_ == address(0)) revert BadConfig();
        for (uint256 i = 0; i < TIERS; i++) {
            if (weights[i] == 0) revert BadConfig();      // a zero weight earns nothing
            if (i > 0 && weights[i] <= weights[i - 1]) revert BadConfig();
            if (i > 0 && costs[i] <= costs[i - 1]) revert BadConfig();
        }
        collection = IERC721Owned(collection_);
        binder = binder_;
        tierCost = costs;
        tierWeight = weights;
        pendingRelease = pendingRelease_;
        // The two additions were the only constructor arguments accepted without
        // question, and both have configurations that brick the vault for good.
        // A codeless payToken makes balanceOf revert outside the try, so every
        // entrypoint fails forever; a token vault with no escrow has no path
        // that can ever credit anything, because receive() refuses ETH — it
        // would take activations, burning real coin, and never pay.
        if (payToken_ != address(0)) {
            if (escrow_ == address(0)) revert BadConfig();
            if (payToken_.code.length == 0) revert BadConfig();
            if (payToken_ == collection_ || payToken_ == binder_) revert BadConfig();
        }
        escrow = escrow_;
        payToken = payToken_;
    }

    /// Bind the paired coin. Once, by the binder, and never again.
    /// @dev Until this is called nothing can be activated, so a vault deployed
    ///      and then abandoned pays nobody and takes nothing — which is the
    ///      correct failure for a step that might not complete.
    function setCoin(address coin_) external {
        if (msg.sender != binder) revert NotBinder();
        if (address(coin) != address(0)) revert CoinAlreadySet();
        if (coin_ == address(0)) revert BadConfig();
        coin = IERC20Burnable(coin_);
        emit CoinBound(coin_);
    }

    // ------------------------------------------------------------------ money in

    /// Fees arrive here. Anyone may send; the coin's fee recipient is expected to.
    ///
    /// A token vault refuses ETH outright rather than banking it. Taking it
    /// would credit stakers in an asset this vault has no way to pay out, and
    /// the revert is the safe failure: MoonpadDrop catches a failed fee send,
    /// books it to feesOwed, and withdrawFees() recovers the money.
    receive() external payable {
        if (payToken != address(0)) revert NotEthVault();
        _take(msg.value);
    }

    /// Pull whatever the escrow is holding for this vault, as a side effect of
    /// actions stakers already take for their own reasons. Pons never pushes —
    /// its escrow pays only the recipient, only when the recipient calls — so
    /// without this the fees would sit there until somebody sent a transaction
    /// nobody has a personal reason to send. Riding activate/claim instead
    /// means ordinary traffic keeps the pot flowing and no keeper exists.
    ///
    /// @dev try/catch because claim() reverts on a zero balance, and a quiet
    ///      day at the escrow must never break staking. The payout re-enters
    ///      receive() above mid-call, which is just _take doing its usual
    ///      accounting — the escrow sends with full gas and is nonReentrant on
    ///      its side. Deliberately NOT called from retire(): that runs inside
    ///      the collection's transfer hook under a 90k gas cap, and a harvest
    ///      there could make transfers fail.
    /// Re-entrancy latch for the harvest window.
    ///
    /// Between the two balanceOf reads sits an external call. A payToken with a
    /// receiver-side hook — ERC-777, or the transfer-agent shape that regulated
    /// RWA tokens commonly use, which is exactly the class this feature is for —
    /// can re-enter claim() there. The re-entrant payout lands inside the window
    /// and is subtracted from the measured delta, so those tokens are never
    /// credited and can never be: a later harvest reads them as part of `before`.
    ///
    /// It also removes the redundant re-harvest claimMany caused by calling
    /// claim() per id, each one paying for a guaranteed-empty escrow call.
    bool private entered;

    /// One at a time, across every entrypoint that moves money.
    ///
    /// A latch on _harvest alone was not enough, and the distinction matters:
    /// it stopped a re-entrant *harvest*, but the re-entrant *claim* still ran
    /// and its payout landed inside the two-balanceOf measurement window, where
    /// it was subtracted from the delta and never credited. Those tokens stay
    /// in the vault with no accounting entry, and a later harvest reads them as
    /// part of `before` — uncreditable forever, on a contract with no owner and
    /// no rescue. Measured at 250e18 stranded on an 800e18 harvest.
    ///
    /// Reachable only through a pay token that calls out during transfer — the
    /// ERC-777 and transfer-agent shapes that regulated RWA tokens use, which
    /// is exactly the class this feature exists for. Every pair asset Pons has
    /// approved today is a plain ERC-20 that cannot re-enter, so this is a
    /// guard against the day that changes rather than a live hole.
    modifier oneAtATime() {
        if (entered) revert Reentrant();
        entered = true;
        _;
        entered = false;
    }

    function _harvest() private {
        if (escrow == address(0)) return;
        if (payToken == address(0)) {
            try IFeeEscrow(escrow).claim() {} catch {}
            return;
        }
        // An ERC-20 payout notifies nobody — there is no receive() to run — so
        // the token path has to measure what arrived rather than be told.
        //
        // The delta, never the escrow's return value: a token that takes a cut
        // in transfer would have this credit more than the vault actually holds,
        // and the shortfall stays invisible until some staker cannot be paid.
        uint256 before = IERC20Burnable(payToken).balanceOf(address(this));
        try IFeeEscrow(escrow).claimToken(payToken) {} catch { return; }
        // Clamped, not subtracted. The escrow call is guarded but this line was
        // not, and balanceOf is not guaranteed to be monotonic — a downward
        // rebase, a transfer hook, or a hostile token can leave the vault
        // holding less than before. An underflow here panics outside the try,
        // and since _harvest is the first statement of activate, activateMany,
        // claim, claimMany and release, that bricks every entrypoint at once on
        // a contract with no owner and no rescue.
        uint256 nowHeld = IERC20Burnable(payToken).balanceOf(address(this));
        uint256 got = nowHeld > before ? nowHeld - before : 0;
        if (got > 0) _take(got);
    }

    function _take(uint256 amount) private {
        if (amount == 0) return;
        totalReceived += amount;

        uint256 share = amount + pending;
        if (totalWeight == 0 || block.timestamp < pendingRelease) {
            // Nothing active — or the first-distribution window is still open,
            // in which case everything banks for the shared fold at the
            // deadline rather than dividing among however few are in early.
            pending = share;
            emit Received(amount, 0, share);
            return;
        }
        pending = 0;
        uint256 perWeight = (share * 1e18) / totalWeight;
        accPerWeight += perWeight;
        emit Received(amount, perWeight, 0);
    }

    /// Fold the banked pot without waiting for another deposit. Anyone may
    /// call once the release time has passed — the people with a reason to are
    /// exactly the ones it pays. Deposits after the deadline fold on their own,
    /// so this only matters when the fees have stopped and the pot has not.
    function release() external oneAtATime {
        _harvest();
        if (block.timestamp < pendingRelease) revert TooEarly();
        if (totalWeight == 0 || pending == 0) revert NothingOwed();
        uint256 share = pending;
        pending = 0;
        uint256 perWeight = (share * 1e18) / totalWeight;
        accPerWeight += perWeight;
        emit Received(0, perWeight, 0);
    }

    // --------------------------------------------------------------- activation

    /// Activate a token by burning coin.
    /// @dev The caller must own it now. Ownership is checked again at claim, so a
    ///      token that changes hands stops paying its old holder without needing
    ///      a transfer hook on the collection — which is why MoonpadDrop needs no
    ///      changes to support any of this.
    function activate(uint256 tokenId, uint8 tier) external oneAtATime {
        _harvest();
        if (address(coin) == address(0)) revert CoinNotSet();
        if (tier == 0 || tier > TIERS) revert BadTier();

        uint256 cost = _switchOn(tokenId, tier);
        if (cost > 0) _burn(cost);
    }

    /// Switch on many tokens at the same tier in one transaction.
    ///
    /// @dev A reserve is the case this exists for. One call per token is fine
    ///      for somebody activating the two they own and impossible for a team
    ///      holding 777 — that is 777 wallet confirmations, and nobody completes
    ///      that. Measured at ~35,000 gas per token after the first, so a few
    ///      hundred at a time is comfortable.
    ///
    ///      The coin moves once, for the total, rather than per token. Every
    ///      slot is written before that single call for the same reason
    ///      activate() writes before its own: the coin is not ours, and a
    ///      re-entrant call must find the state already settled.
    ///
    ///      Not payable, no partial success: a token in the list that the caller
    ///      does not own, or that is already at or above the tier, reverts the
    ///      lot. A batch that quietly skipped entries would leave a holder
    ///      believing they had switched on 777 when they had switched on 700.
    function activateMany(uint256[] calldata tokenIds, uint8 tier) external oneAtATime {
        _harvest();
        if (address(coin) == address(0)) revert CoinNotSet();
        if (tier == 0 || tier > TIERS) revert BadTier();

        uint256 total;
        for (uint256 i = 0; i < tokenIds.length; i++) {
            total += _switchOn(tokenIds[i], tier);
        }
        if (total > 0) _burn(total);
    }

    function _burn(uint256 amount) private {
        if (!coin.transferFrom(msg.sender, DEAD, amount)) revert BurnFailed();
        totalBurned += amount;
    }

    /// Everything about switching a token on except paying for it, so one
    /// transfer can cover a whole batch. Returns what this token costs.
    function _switchOn(uint256 tokenId, uint8 tier) private returns (uint256) {
        if (collection.ownerOf(tokenId) != msg.sender) revert NotOwner();

        Slot storage s = slots[tokenId];
        uint256 cost = tierCost[tier - 1];

        if (s.tier != 0 && s.holder == msg.sender) {
            // Moving up. Without this a holder was sealed into whichever tier
            // they first chose: activate refused a second call, and retire only
            // works on a token that has changed hands, so there was no way out
            // short of selling the token and buying it back.
            if (tier <= s.tier) revert AlreadyActive();

            // Settle what the old weight earned and keep it on the slot, so
            // moving up a rung never costs a holder what the old one earned.
            s.owed += _accrued(s);
            totalWeight -= tierWeight[s.tier - 1];

            // The difference, not the whole tier. Laddering up costs the same as
            // going straight to the top, so nobody is punished for starting
            // small. tierCost is ascending by construction, so this cannot
            // underflow.
            cost -= tierCost[s.tier - 1];
        } else if (s.tier != 0) {
            // A token whose owner changed while active is settled and cleared
            // first, so the previous holder keeps what they earned and nothing
            // carries over to whoever takes the slot next.
            _retire(tokenId, s);
        }

        // State before the burn. The burn is a call into the coin, which the
        // vault does not control — re-entering it while the slot was still
        // unwritten let the guards above pass a second time and counted the
        // weight twice, permanently under-paying every holder. Written first, a
        // re-entrant call hits AlreadyActive and takes the whole thing down.
        s.holder = msg.sender;
        s.tier = tier;
        s.mark = accPerWeight;      // earns only from deposits after this point
        totalWeight += tierWeight[tier - 1];

        emit Activated(tokenId, msg.sender, tier, cost);
        return cost;
    }

    /// Settle a token whose activation is no longer valid, and free its weight.
    /// @dev Callable by anyone, and deliberately so: weight held by a token that
    ///      has been sold would otherwise dilute every honest holder until its
    ///      new owner happened to act. What was earned before the sale stays owed
    ///      to whoever earned it.
    function retire(uint256 tokenId) external {
        Slot storage s = slots[tokenId];
        if (s.tier == 0) revert NotActive();
        if (collection.ownerOf(tokenId) == s.holder) revert NotOwner();
        _retire(tokenId, s);
    }

    /// Close every slot in the list that has changed hands, and skip the rest.
    ///
    /// @dev Sweeping is the reason this is here. A sold token keeps its weight
    ///      until somebody retires it, which dilutes every honest holder in the
    ///      meantime — so closing them has to be cheap enough that anyone will
    ///      bother, and one transaction per token is not.
    ///
    ///      Unlike activateMany this skips rather than reverts, and the
    ///      difference is deliberate. A sweep is built from a list of candidates
    ///      read off the chain a block ago; by the time it lands some of them
    ///      will have been retired by somebody else, or reactivated by their new
    ///      owner. Reverting the batch would mean the honest sweeper loses a race
    ///      they had no way to see coming, and nobody would run it twice.
    ///      Returns how many it actually closed.
    function retireMany(uint256[] calldata tokenIds) external returns (uint256 closed) {
        for (uint256 i = 0; i < tokenIds.length; i++) {
            Slot storage s = slots[tokenIds[i]];
            if (s.tier == 0) continue;                                  // not active
            if (collection.ownerOf(tokenIds[i]) == s.holder) continue;  // still theirs
            _retire(tokenIds[i], s);
            closed++;
        }
    }

    /// Whether this token's activation is stale — active, but the wallet that
    /// switched it on no longer owns it. What a sweeper filters on.
    function isStale(uint256 tokenId) external view returns (bool) {
        Slot storage s = slots[tokenId];
        return s.tier != 0 && collection.ownerOf(tokenId) != s.holder;
    }

    /// Close a slot, settling what it earned onto the token itself. Whoever
    /// holds the token can then claim what is sitting on it — so a seller who
    /// has not claimed hands those earnings to the buyer along with the token.
    /// SellUnclaimed.t.sol pins this behaviour; the UI tells holders to claim
    /// before they sell.
    function _retire(uint256 tokenId, Slot storage s) private {
        address was = s.holder;

        // Settle onto the slot, not onto the person. What a token earned stays
        // with the token: sell it and the balance goes with it, and the buyer
        // claims what is sitting there. That is the whole point of the design —
        // a Moonbaby is a thing that can be carrying money, not a receipt for
        // an account somewhere else.
        s.owed += _accrued(s);

        totalWeight -= tierWeight[s.tier - 1];
        s.tier = 0;
        s.mark = 0;
        emit Deactivated(tokenId, was);
    }

    // ------------------------------------------------------------------ money out

    function _accrued(Slot storage s) private view returns (uint256) {
        if (s.tier == 0) return 0;
        return ((accPerWeight - s.mark) * tierWeight[s.tier - 1]) / 1e18;
    }

    /// What a token can claim right now.
    function owed(uint256 tokenId) public view returns (uint256) {
        Slot storage s = slots[tokenId];
        return s.owed + _accrued(s);
    }

    /// Claim, to an address of the caller's choosing.
    /// @dev `to` is free so earnings can be sent into the token's own ERC-6551
    ///      account rather than a wallet, which keeps the value with the NFT.
    function claim(uint256 tokenId, address to) public oneAtATime returns (uint256 amount) {
        _harvest();
        return _claimOne(tokenId, to);
    }

    /// The body of a claim, without the guard. claimMany holds the guard for the
    /// whole batch and harvests once, so routing every id back through the
    /// public claim() would trip that guard — and used to pay for a second,
    /// guaranteed-empty escrow call per id.
    function _claimOne(uint256 tokenId, address to) private returns (uint256 amount) {
        // Whoever holds the token collects what it holds. Not whoever switched
        // it on — they may have sold it since, and the balance went with it.
        if (collection.ownerOf(tokenId) != msg.sender) revert NotOwner();

        Slot storage s = slots[tokenId];
        if (s.tier != 0) {
            if (s.holder != msg.sender) {
                // Active, but activated by a previous owner: the activation
                // does not survive the sale, so it is closed here and its
                // earnings — including anything it accrued after the transfer —
                // settle onto the slot for the caller to take.
                _retire(tokenId, s);
            } else {
                s.owed += _accrued(s);
                s.mark = accPerWeight;
            }
        }

        amount = s.owed;
        if (amount == 0) revert NothingOwed();
        s.owed = 0;                                   // effects before interaction

        address dest = to == address(0) ? msg.sender : to;
        totalClaimed += amount;
        if (payToken == address(0)) {
            (bool ok, ) = payable(dest).call{ value: amount }("");
            if (!ok) revert TransferFailed();
        } else {
            // The return value is checked rather than assuming a revert on
            // failure. s.owed is already zeroed by this point, so a token that
            // reports false instead of reverting would leave the holder with
            // nothing and no balance to try again with.
            if (!IERC20Burnable(payToken).transfer(dest, amount)) revert TransferFailed();
        }
        emit Claimed(tokenId, dest, amount);
    }


    /// @dev Skips ids this caller cannot claim rather than reverting the batch.
    ///      A single token bought with dust still owed to its previous holder
    ///      used to roll back every successful claim beside it.
    function claimMany(uint256[] calldata ids, address to) external oneAtATime returns (uint256 total) {
        _harvest();
        for (uint256 i = 0; i < ids.length; i++) {
            if (collection.ownerOf(ids[i]) != msg.sender) continue;
            if (owed(ids[i]) == 0) continue;
            total += _claimOne(ids[i], to);
        }
    }

    // ---------------------------------------------------------------------- views

    function tierOf(uint256 tokenId) external view returns (uint8) {
        return slots[tokenId].tier;
    }

    function isActive(uint256 tokenId) external view returns (bool) {
        Slot storage s = slots[tokenId];
        return s.tier != 0 && collection.ownerOf(tokenId) == s.holder;
    }

    function tiers() external view returns (uint256[TIERS] memory, uint256[TIERS] memory) {
        return (tierCost, tierWeight);
    }
}
