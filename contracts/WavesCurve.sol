// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {WavesToken} from "./WavesToken.sol";

interface IUniswapV3Factory {
    function getPool(address a, address b, uint24 fee) external view returns (address);
    function createPool(address a, address b, uint24 fee) external returns (address);
}

interface IUniswapV3Pool {
    function initialize(uint160 sqrtPriceX96) external;
    function mint(address recipient, int24 tickLower, int24 tickUpper, uint128 amount, bytes calldata data)
        external returns (uint256 amount0, uint256 amount1);
    function collect(address recipient, int24 tickLower, int24 tickUpper, uint128 a0, uint128 a1)
        external returns (uint128, uint128);
}

interface IWETH {
    function deposit() external payable;
    function transfer(address to, uint256 value) external returns (bool);
}

/**
 * WavesCurve — the bonding curve every WAVES token on an EVM chain launches on.
 *
 * One deployment holds every launch. Only the ERC20 is deployed per token, so a
 * launch is cheap and there is exactly one contract holding money to review,
 * rather than a fresh unreviewed one each time.
 *
 * ── The curve ────────────────────────────────────────────────────────────────
 * Constant product against virtual reserves, the same shape pump.fun and
 * Meteora's DBC use. The pool starts with no real ETH, so the virtual reserves
 * are what set the opening price and how steeply it climbs:
 *
 *     x = virtualEth + raised          y = tokensLeft
 *     k = x * y                        held constant across a trade
 *
 * A buy of `dx` moves x up and y down; the buyer receives the difference. The
 * price is therefore continuous, always defined, and needs no counterparty —
 * which is the whole point of a curve rather than a pool.
 *
 * ── Fees ─────────────────────────────────────────────────────────────────────
 * Taken in ETH on the way in and out, before the curve maths, so the reserves
 * only ever see money that stays in the pool. Split platform / creator by the
 * same ladder as the Solana side. The creator's share can be pledged to holders
 * later, exactly as it is there: a separate, irreversible step, never bundled
 * into the launch transaction.
 *
 * ── Graduation ───────────────────────────────────────────────────────────────
 * At a fixed amount raised, the curve closes and the ETH plus the remaining
 * tokens seed a Uniswap V3 position that nobody can withdraw. Until then the
 * ETH is in this contract and cannot be taken out by anyone, including us —
 * there is no owner withdrawal, no sweep, no upgrade.
 *
 * ⚠️ NOT AUDITED. Nothing should launch on this with real money until it is.
 */
contract WavesCurve {
    // ─────────────────────────────────────────────────────────── configuration

    /* Set once, at deployment, and never again. There is deliberately no owner
     * and no setter on this contract: a launchpad that can change its own fee
     * split after you launch on it is a launchpad you have to trust. */
    address public immutable platform;
    uint256 public immutable graduationEth;

    /* Where a graduated token goes to trade. Uniswap V3 is on Robinhood Chain
     * at a NON-canonical address, so this is a constructor argument rather than
     * the usual constant — the deployment at 0x1F98431c… on that chain is
     * something else entirely and answers nothing. */
    IUniswapV3Factory public immutable factory;
    address public immutable weth;
    uint24  public immutable poolFee;

    /* Full range, aligned to the 1% tier's spacing of 200. Full range because a
     * locked position should never fall out of its band and stop being
     * liquidity — a narrower one would earn more fees right up until the price
     * left it, and then the token would look rugged. */
    int24 internal constant MIN_TICK = -887200;
    int24 internal constant MAX_TICK = 887200;
    uint256 internal constant Q96 = 0x1000000000000000000000000;

    /* Virtual reserves, which together decide the opening market cap and the
     * shape of the climb.
     *
     * The intended deployment, scaled from pump.fun's ratios so a launch here
     * feels like a launch on the Solana side rather than a different product:
     *
     *     virtualEth      1.41 ether
     *     virtualTokens   1,073,000,000e18
     *     curveSupply     1,000,000,000e18
     *     graduationEth   4 ether
     *
     * which opens at about $5.3k, graduates at about $77k, and sells 79.3% of
     * supply on the curve — leaving 20.7% to seed the pool. Solana opens ~$5k,
     * graduates ~$69k and sells ~80%, raising ~82 SOL against this 4 ETH: the
     * two raises land within a few hundred dollars of each other.
     *
     * They are constructor arguments rather than constants so the same reviewed
     * bytecode can be deployed on another chain at another ETH price without
     * editing the source. */
    uint256 public immutable virtualEth;
    uint256 public immutable virtualTokens;
    uint256 public immutable curveSupply;

    /* The rungs, and only these. The same ladder as the Solana side: 1, 2, 3,
     * 4, 5 and 10 percent, chosen at launch and immutable afterwards. */
    uint16 public constant MAX_FEE_BPS = 1000;
    uint16 public constant MIN_FEE_BPS = 100;

    /**
     * The platform's cut, in basis points OF TRADING VOLUME, by rung — a tenth
     * of a percent per step, exactly as on Solana: 0.4, 0.5, 0.6, 0.7, 0.8, 0.9.
     *
     * ⚠️ Derived here, never passed in. An earlier draft took this as an
     * argument to launch(), which meant any launcher could pass zero and use
     * the platform for free. A launchpad's own revenue must not be a parameter
     * the caller controls.
     *
     * The creator takes everything else. There is no third party on this chain
     * — Meteora's fixed fifth has no equivalent here — so a creator keeps more
     * than they would on Solana at the same rung.
     */
    function platformVolumeBps(uint16 feeBps) public pure returns (uint16) {
        if (feeBps == 100) return 40;
        if (feeBps == 200) return 50;
        if (feeBps == 300) return 60;
        if (feeBps == 400) return 70;
        if (feeBps == 500) return 80;
        if (feeBps == 1000) return 90;
        revert BadFee();
    }

    // ────────────────────────────────────────────────────────────────── state

    struct Curve {
        address creator;       // who launched it, and who earns the creator side
        uint16  feeBps;        // the trading fee, immutable per launch
        uint16  rewardsBps;    // of the creator's side, pledged to holders
        address keeper;        // who distributes that pledge, once set
        uint96  raised;        // ETH held by the curve for this token
        uint96  tokensLeft;    // tokens still on the curve
        bool    graduated;
    }

    mapping(address => Curve) public curves;
    /* Fees owed, in ETH, held here until claimed. Kept apart from `raised` so a
     * fee can never be spent as liquidity, or liquidity paid out as a fee. */
    mapping(address => uint256) public owed;

    event Launched(address indexed token, address indexed creator, uint16 feeBps, string name, string symbol);
    event Bought(address indexed token, address indexed buyer, uint256 ethIn, uint256 tokensOut, uint256 fee);
    event Sold(address indexed token, address indexed seller, uint256 tokensIn, uint256 ethOut, uint256 fee);
    event Graduated(address indexed token, uint256 ethIn, uint256 tokensIn);
    event Claimed(address indexed who, uint256 amount);
    event Pledged(address indexed token, address indexed keeper, uint16 bps);

    error BadFee();
    error UnknownToken();
    error AlreadyGraduated();
    error NotGraduated();
    error NothingOwed();
    error Slippage();
    error ZeroAmount();
    error TransferFailed();
    error NotCreator();
    error AlreadyPledged();
    /// The curve has taken everything it is going to take; graduate it.
    error CurveComplete();
    /// Claiming to nowhere would burn the money silently.
    error ZeroAddress();

    constructor(
        address platform_,
        uint256 graduationEth_,
        uint256 virtualEth_,
        uint256 virtualTokens_,
        uint256 curveSupply_,
        address factory_,
        address weth_,
        uint24  poolFee_
    ) {
        factory = IUniswapV3Factory(factory_);
        weth = weth_;
        poolFee = poolFee_;
        platform = platform_;
        graduationEth = graduationEth_;
        virtualEth = virtualEth_;
        virtualTokens = virtualTokens_;
        curveSupply = curveSupply_;
    }

    // ───────────────────────────────────────────────────────────────── launch

    /**
     * Deploy a token and open its curve. Any ETH sent buys on the same
     * transaction, which is what closes the window a sniper would otherwise
     * have between the curve opening and the creator's first buy.
     */
    function launch(
        string calldata name,
        string calldata symbol,
        uint16 feeBps,
        uint256 minTokensOut,
        string calldata logo,
        string calldata description,
        string calldata socials
    ) external payable returns (address token) {
        platformVolumeBps(feeBps);            // reverts unless it is a real rung

        /* The picture goes ON CHAIN, at launch, or not at all.
         *
         * An ERC20 has no metadata account for an aggregator to read, so a
         * token that ships with only a name and a symbol is a grey letter
         * placeholder on every indexer for as long as it exists — there is no
         * later step that fixes it. Carrying three strings through the launch
         * is the whole price of a token that looks like something.
         *
         * msg.sender, not this contract, is recorded as the deployer: the curve
         * is what constructs the token, but the creator is who called us. */
        token = address(new WavesToken(
            name, symbol, curveSupply, address(this), msg.sender, logo, description, socials
        ));
        /* Written field by field rather than as a struct literal. The literal
         * builds the whole Curve on the stack before storing it, and with the
         * metadata strings also live that is "stack too deep". The zero fields
         * — rewardsBps, keeper, raised, graduated — are already zero in fresh
         * storage; pledging happens later and never at launch. */
        Curve storage c = curves[token];
        c.creator = msg.sender;
        c.feeBps = feeBps;
        c.tokensLeft = uint96(curveSupply);
        emit Launched(token, msg.sender, feeBps, name, symbol);

        if (msg.value > 0) _buy(token, msg.value, minTokensOut);
    }

    // ────────────────────────────────────────────────────────────────── trade

    function buy(address token, uint256 minTokensOut) external payable {
        if (msg.value == 0) revert ZeroAmount();
        _buy(token, msg.value, minTokensOut);
    }

    function _buy(address token, uint256 value, uint256 minTokensOut) private {
        Curve storage c = curves[token];
        if (c.creator == address(0)) revert UnknownToken();
        if (c.graduated) revert AlreadyGraduated();

        /* Never take more ETH than the curve has room for before it closes.
         *
         * ⚠️ Without this a single large buy empties the curve outright — the
         * clamp below hands over every remaining token — and that state is
         * poison twice over: graduation computes an opening price from a zero
         * token amount and reverts forever, and the next buyer pays ETH for
         * nothing, because there is nothing left to give them. Found by running
         * the invariant handler against the real Uniswap, where graduation is
         * in the sequence and the pool refused `initialize(0)`.
         *
         * Capping at the threshold is also just correct: money paid in past the
         * point the curve was meant to close was going into the pool at a price
         * the curve had already left behind. The excess is refunded instead. */
        uint256 room = c.raised >= graduationEth ? 0 : graduationEth - c.raised;
        if (room == 0) revert CurveComplete();

        uint256 accepted = value;
        uint256 fee = (accepted * c.feeBps) / 10_000;
        uint256 inAfterFee = accepted - fee;
        uint256 refund;
        if (inAfterFee > room) {
            /* Take exactly what fills the curve, and the fee that belongs to
             * it. fee/accepted stays equal to feeBps, so the buyer is charged
             * the same rate on the smaller amount rather than the fee on money
             * that was handed back. */
            inAfterFee = room;
            fee = (room * c.feeBps) / (10_000 - c.feeBps);
            accepted = room + fee;
            refund = value - accepted;
        }

        /* The curve, in the order that matters: reserves BEFORE this trade.
         * x grows by what the buyer pays, y shrinks by what they receive, and
         * k is preserved. Rounding goes to the pool — the buyer gets the floor
         * — so repeated trades can never drain it by a wei at a time. */
        /* The curve runs on VIRTUAL token reserves, not the real balance.
         *
         * That is what leaves supply behind at graduation: the virtual reserve
         * is larger than what is actually for sale, so the curve approaches its
         * limit without ever reaching it, and the remainder seeds the pool. An
         * earlier draft priced against the real balance, which would have sold
         * every last token and left nothing to graduate with. */
        uint256 sold = curveSupply - c.tokensLeft;
        uint256 x = virtualEth + c.raised;
        uint256 y = virtualTokens - sold;
        uint256 out = y - ((virtualEth * virtualTokens) / (x + inAfterFee));

        if (out > c.tokensLeft) out = c.tokensLeft;   // never more than is really here
        if (out < minTokensOut) revert Slippage();

        c.raised += uint96(inAfterFee);
        /* ⚠️ Off the REAL balance, not off `y`. y is the virtual reserve and is
         * larger than what the contract actually holds; writing it back here
         * inflated tokensLeft above the real balance, and the next buyer's
         * transfer reverted with InsufficientBalance. Found by fuzzing. */
        c.tokensLeft = uint96(c.tokensLeft - out);
        /* `accepted`, not `value` — the platform's cut is a share of volume, and
         * refunded money was never volume. */
        _accrue(c, accepted, fee);

        if (!WavesToken(token).transfer(msg.sender, out)) revert TransferFailed();
        emit Bought(token, msg.sender, accepted, out, fee);

        // last, with every bit of state already written
        if (refund > 0) {
            (bool ok, ) = msg.sender.call{value: refund}("");
            if (!ok) revert TransferFailed();
        }
    }

    function sell(address token, uint256 amount, uint256 minEthOut) external {
        if (amount == 0) revert ZeroAmount();
        Curve storage c = curves[token];
        if (c.creator == address(0)) revert UnknownToken();
        if (c.graduated) revert AlreadyGraduated();

        /* Tokens come back first, so the reserves this trade is priced against
         * are the ones the seller is actually selling into. */
        if (!WavesToken(token).transferFrom(msg.sender, address(this), amount)) revert TransferFailed();

        uint256 sold = curveSupply - c.tokensLeft;
        uint256 x = virtualEth + c.raised;
        uint256 y = virtualTokens - sold;
        /* Rounding can put the quotient a wei or two above x on a very small
         * round trip, which underflows rather than returning ~0. Clamp instead:
         * the seller gets nothing, which is the correct answer for a trade too
         * small to move the curve, and the pool keeps the dust. */
        uint256 back = (virtualEth * virtualTokens) / (y + amount);
        uint256 gross = back >= x ? 0 : x - back;
        if (gross > c.raised) gross = c.raised;    // never pay out virtual ETH

        uint256 fee = (gross * c.feeBps) / 10_000;
        uint256 net = gross - fee;
        if (net < minEthOut) revert Slippage();

        c.raised -= uint96(gross);
        c.tokensLeft = uint96(c.tokensLeft + amount);   // real balance, as above
        _accrue(c, gross, fee);

        (bool ok, ) = msg.sender.call{value: net}("");
        if (!ok) revert TransferFailed();
        emit Sold(token, msg.sender, amount, net, fee);
    }

    // ─────────────────────────────────────────────────────────────────── fees

    function _accrue(Curve storage c, uint256 volume, uint256 fee) private {
        if (fee == 0) return;
        /* The platform's cut is a share of VOLUME, not of the fee, so it does
         * not move when a creator picks a different rung. Capped at the fee
         * itself so it can never eat into the creator's side or the reserves. */
        uint256 toPlatform = (volume * platformVolumeBps(c.feeBps)) / 10_000;
        if (toPlatform > fee) toPlatform = fee;
        owed[platform] += toPlatform;

        uint256 rest = fee - toPlatform;
        /* Whatever the creator pledged goes to the keeper, which distributes it
         * to holders. Unpledged, it is simply theirs. Same shape as Solana:
         * the creator chooses afterwards, and cannot take it back. */
        if (c.rewardsBps > 0 && c.keeper != address(0)) {
            uint256 toHolders = (rest * c.rewardsBps) / 10_000;
            owed[c.keeper] += toHolders;
            rest -= toHolders;
        }
        owed[c.creator] += rest;
    }

    /**
     * Pledge a share of your fees to the people holding your token.
     *
     * Deliberately not part of launch(): on Solana, naming our keeper inside
     * the launch transaction made it require a signature from an address the
     * creator had never seen, and Phantom blocked it as a possible drainer. The
     * same reasoning applies to any wallet's heuristics here, and the same
     * answer works — a second, small, obvious transaction.
     *
     * One way, like its Solana counterpart. A pledge a creator can quietly
     * reverse is worth nothing to the buyer it was made to.
     */
    function pledgeToHolders(address token, uint16 bps, address keeper_) external {
        Curve storage c = curves[token];
        if (c.creator != msg.sender) revert NotCreator();
        if (c.rewardsBps != 0) revert AlreadyPledged();
        if (bps == 0 || bps > 10_000) revert BadFee();
        if (keeper_ == address(0)) revert UnknownToken();
        c.rewardsBps = bps;
        c.keeper = keeper_;
        emit Pledged(token, keeper_, bps);
    }

    /**
     * Take what you are owed, and send it wherever you like.
     *
     * The destination is an argument because the Solana side has the same
     * choice — a creator there nominates the address their kept fees claim to,
     * which is how a reward vault or a cold wallet receives them without ever
     * passing through the launch wallet. Without it here the two chains would
     * be different products, and it cannot be added afterwards: this contract
     * has no owner and no upgrade path.
     *
     * The BALANCE is still msg.sender's. Nominating a destination moves where
     * the money lands, never whose money it is, so there is nothing here for
     * one address to take from another.
     *
     * Pull, not push, as before: a creator whose wallet reverts on receive must
     * not be able to brick every trade on their own token.
     */
    function claimTo(address to) public {
        if (to == address(0)) revert ZeroAddress();
        uint256 amount = owed[msg.sender];
        if (amount == 0) revert NothingOwed();
        owed[msg.sender] = 0;
        (bool ok, ) = to.call{value: amount}("");
        if (!ok) revert TransferFailed();
        emit Claimed(msg.sender, amount);
    }

    /// The common case, kept so nothing that already calls it has to change.
    function claim() external {
        claimTo(msg.sender);
    }

    // ─────────────────────────────────────────────────────────────────── view

    /// What a given ETH amount would buy right now, after the fee.
    function quoteBuy(address token, uint256 value) external view returns (uint256) {
        Curve storage c = curves[token];
        if (c.creator == address(0) || c.graduated) return 0;
        uint256 inAfterFee = value - (value * c.feeBps) / 10_000;
        // the same cap the buy applies, so a quote never promises more than it gives
        uint256 room = c.raised >= graduationEth ? 0 : graduationEth - c.raised;
        if (inAfterFee > room) inAfterFee = room;
        uint256 sold = curveSupply - c.tokensLeft;
        uint256 y = virtualTokens - sold;
        uint256 out = y - ((virtualEth * virtualTokens) / (virtualEth + c.raised + inAfterFee));
        return out > c.tokensLeft ? c.tokensLeft : out;
    }

    /// What selling a given number of tokens would return right now, after the fee.
    function quoteSell(address token, uint256 amount) external view returns (uint256) {
        Curve storage c = curves[token];
        if (c.creator == address(0) || c.graduated) return 0;
        uint256 sold = curveSupply - c.tokensLeft;
        uint256 x = virtualEth + c.raised;
        uint256 y = virtualTokens - sold;
        uint256 back = (virtualEth * virtualTokens) / (y + amount);
        uint256 gross = back >= x ? 0 : x - back;
        if (gross > c.raised) gross = c.raised;
        return gross - (gross * c.feeBps) / 10_000;
    }

    /// How far along the curve a token is, in basis points of graduation.
    function progressBps(address token) external view returns (uint256) {
        Curve storage c = curves[token];
        if (c.graduated) return 10_000;
        if (graduationEth == 0) return 0;
        uint256 p = (uint256(c.raised) * 10_000) / graduationEth;
        return p > 10_000 ? 10_000 : p;
    }

    function ready(address token) public view returns (bool) {
        Curve storage c = curves[token];
        return !c.graduated && c.creator != address(0) && c.raised >= graduationEth;
    }

    // ────────────────────────────────────────────────────────────── graduation

    mapping(address => address) public poolOf;   // token => its pool, once graduated

    /**
     * Close the curve and put everything into a pool nobody can withdraw from.
     *
     * Permissionless on purpose: the threshold is a fact about the chain, so
     * anyone may push the button once it is true. Leaving it to us would mean a
     * token that has met its terms sits waiting on our keeper being awake.
     *
     * The remaining tokens and the raised ETH become one full-range position
     * owned by this contract. There is no function anywhere in here that calls
     * burn() or decreaseLiquidity() on a pool — that is what makes the lock
     * real. Not a timelock, not a promise: the code to remove liquidity does
     * not exist, so it cannot be called.
     */
    function graduate(address token) external {
        Curve storage c = curves[token];
        if (c.creator == address(0)) revert UnknownToken();
        if (c.graduated) revert AlreadyGraduated();
        if (c.raised < graduationEth) revert NotGraduated();

        uint256 ethIn = c.raised;
        uint256 tokensIn = c.tokensLeft;
        c.graduated = true;
        c.raised = 0;
        c.tokensLeft = 0;

        address pool = factory.getPool(token, weth, poolFee);
        if (pool == address(0)) pool = factory.createPool(token, weth, poolFee);
        poolOf[token] = pool;

        bool tokenIsZero = token < weth;
        (uint256 amount0, uint256 amount1) = tokenIsZero ? (tokensIn, ethIn) : (ethIn, tokensIn);

        /* The opening price is whatever the curve finished at — the ratio of
         * what was raised to what is left. Continuity matters: a pool that
         * opens anywhere else hands the difference to whoever arbitrages it,
         * and that money came from the people who bought on the curve. */
        uint160 sqrtPriceX96 = uint160(_sqrt((amount1 * (1 << 96) / amount0) * (1 << 96)));
        /* Belt and braces. The buy cap above means neither side can be zero, so
         * this cannot trigger — but a price of zero is what a sold-out curve
         * produced before that cap existed, and it surfaced as a bare "R" from
         * inside the pool. If it ever comes back it should say so here. */
        if (sqrtPriceX96 == 0) revert ZeroAmount();
        IUniswapV3Pool(pool).initialize(sqrtPriceX96);

        IWETH(weth).deposit{value: ethIn}();

        /* Liquidity for a full-range position, taking whichever side binds.
         * Deliberately a hair under: the callback must be payable from what we
         * hold, and dust left behind is locked here forever, which is the safe
         * direction to be wrong in. */
        uint256 l0 = (amount0 * sqrtPriceX96) / Q96;
        uint256 l1 = (amount1 * Q96) / sqrtPriceX96;
        uint256 liquidity = ((l0 < l1 ? l0 : l1) * 999) / 1000;

        _mintPayer = token;
        IUniswapV3Pool(pool).mint(address(this), MIN_TICK, MAX_TICK, uint128(liquidity), "");
        _mintPayer = address(0);

        emit Graduated(token, ethIn, tokensIn);
    }

    address private _mintPayer;

    /// Uniswap calls this to collect what the position costs. Only during a mint we started.
    function uniswapV3MintCallback(uint256 owed0, uint256 owed1, bytes calldata) external {
        address token = _mintPayer;
        if (token == address(0)) revert NotGraduated();
        if (msg.sender != poolOf[token]) revert UnknownToken();

        bool tokenIsZero = token < weth;
        (uint256 owedToken, uint256 owedWeth) = tokenIsZero ? (owed0, owed1) : (owed1, owed0);
        if (owedToken > 0 && !WavesToken(token).transfer(msg.sender, owedToken)) revert TransferFailed();
        if (owedWeth > 0 && !IWETH(weth).transfer(msg.sender, owedWeth)) revert TransferFailed();
    }

    /**
     * Sweep the locked position's trading fees to whoever the creator pledged
     * to — them, or the keeper paying their holders.
     *
     * This is the reason to hold the position rather than send it to a burn
     * address: locked liquidity that also pays its holders forever, which is
     * what the Solana side does from its locked LP.
     */
    function collectPoolFees(address token) external {
        address pool = poolOf[token];
        if (pool == address(0)) revert NotGraduated();
        Curve storage c = curves[token];
        address to = (c.rewardsBps > 0 && c.keeper != address(0)) ? c.keeper : c.creator;
        IUniswapV3Pool(pool).collect(to, MIN_TICK, MAX_TICK, type(uint128).max, type(uint128).max);
    }

    function _sqrt(uint256 x) private pure returns (uint256 y) {
        if (x == 0) return 0;
        uint256 z = (x + 1) / 2;
        y = x;
        while (z < y) { y = z; z = (x / z + z) / 2; }
    }

    receive() external payable {}
}
