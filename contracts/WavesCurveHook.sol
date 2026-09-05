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

    fair-launch bonding curves, live on Uniswap V4 from block zero.
    https://waveslaunchpad.xyz

*/
pragma solidity ^0.8.26;

import {IHooks} from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {Hooks} from "@uniswap/v4-core/src/libraries/Hooks.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {PoolId, PoolIdLibrary} from "@uniswap/v4-core/src/types/PoolId.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {BalanceDelta} from "@uniswap/v4-core/src/types/BalanceDelta.sol";
import {BeforeSwapDelta, toBeforeSwapDelta} from "@uniswap/v4-core/src/types/BeforeSwapDelta.sol";
import {SwapParams, ModifyLiquidityParams} from "@uniswap/v4-core/src/types/PoolOperation.sol";
import {CurrencySettler} from "./v4lib/CurrencySettler.sol";
import {WavesToken} from "./WavesToken.sol";

/**
 * WavesCurveHook — the WAVES bonding curve, expressed as a Uniswap V4 hook.
 *
 * ── Why a hook, and not the standalone curve ────────────────────────────────
 * The standalone WavesCurve is not a Uniswap pool, so aggregators (GMGN,
 * DexScreener, Photon) cannot see a token until it graduates — a launch is
 * anonymous for its whole discovery window. A hook makes the curve BE a live V4
 * pool from block zero: the pool exists on the singleton PoolManager, indexers
 * pick it up natively with its image, and the hook prices every swap against the
 * same constant-product curve the standalone contract used. This is the pattern
 * pump.fun-on-V4 and Robinhood's other launchpads (KLIK) use.
 *
 * ── One hook, every launch ──────────────────────────────────────────────────
 * V4 keys a hook inside the PoolKey, so ONE deployed hook serves every WAVES
 * pool. Only the ERC20 is deployed per launch — one audited money contract, as
 * before. Per-pool state is keyed by PoolId.
 *
 * ── The curve, unchanged ────────────────────────────────────────────────────
 * Constant product against VIRTUAL reserves — the exact math, clamps and
 * rounding of WavesCurve.sol, ported verbatim into `_beforeSwap`:
 *     x = virtualEth + raised     y = virtualTokens - sold     k = x*y
 * Rounding goes to the pool; the room-clamp stops a single buy draining the
 * curve; graduation seeds the pool from the supply the virtual reserve leaves
 * behind. Every comment on those invariants in WavesCurve.sol applies here.
 *
 * ⚠️ RESERVE MODEL: the hook now holds its ETH as ERC-6909 CLAIMS in the
 * PoolManager (buys mint the claim; sells/fees burn it). claim() below
 * still pays real ETH via call{value} — it must first burn the hook's ETH
 * claims back to native ETH inside a manager unlock. That conversion, and
 * the sell path's claim burn, are validated for the BUY path only so far;
 * claim()/sell need their own fork tests. FOLLOW-UP before any mainnet use.
 *
 * ⚠️ AUDIT STATUS: the `_beforeSwap` delta accounting and `_graduate` liquidity
 * provision move other people's money and have NOT been audited. This is a
 * first implementation for fork-testing and review — do not point mainnet
 * launches at it until both are audited. Same gate as the staking program.
 */
contract WavesCurveHook is IHooks {
    using PoolIdLibrary for PoolKey;
    using CurrencySettler for Currency;

    // ─────────────────────────────────────────────────────────── immutables
    IPoolManager public immutable manager;
    address public immutable platform;

    /* Shared launch template — identical for every pool, exactly as the
     * standalone curve's immutables were identical per deployment. */
    uint256 public immutable graduationEth;
    uint256 public immutable virtualEth;
    uint256 public immutable virtualTokens;
    uint256 public immutable curveSupply;

    /* The V4 pool every launch opens: native ETH (currency0 = address(0)) against
     * the token, one fee tier, widest tick spacing. The LP fee is set to zero —
     * WAVES fees are taken by this hook, not by the pool. */
    uint24 internal constant LP_FEE = 0;
    int24 internal constant TICK_SPACING = 60;

    uint16 public constant MAX_FEE_BPS = 1000;
    uint16 public constant MIN_FEE_BPS = 100;

    // ─────────────────────────────────────────────────────────────── state
    struct Curve {
        address token;
        address creator;
        uint16 feeBps;
        uint16 rewardsBps;
        address keeper;
        uint96 raised;
        uint96 tokensLeft;
        bool graduated;
    }

    mapping(PoolId => Curve) public curves;
    /* token → its PoolId, so the keeper and the UI can go token-first. */
    mapping(address => PoolId) public poolOf;
    /* Fees owed in ETH, held until claimed — identical to the standalone curve. */
    mapping(address => uint256) public owed;

    // ────────────────────────────────────────────────────────────── events
    event Launched(address indexed token, address indexed creator, uint16 feeBps, string name, string symbol);
    event Bought(address indexed token, address indexed buyer, uint256 ethIn, uint256 tokensOut, uint256 fee);
    event Sold(address indexed token, address indexed seller, uint256 tokensIn, uint256 ethOut, uint256 fee);
    event Pledged(address indexed token, address indexed keeper, uint16 bps);
    event Graduated(address indexed token, uint256 ethIn, uint256 tokensIn);
    event Claimed(address indexed who, uint256 amount);

    // ────────────────────────────────────────────────────────────── errors
    error NotManager();
    error NotHook();
    error UnknownToken();
    error AlreadyGraduated();
    error CurveComplete();
    error Slippage();
    error BadFee();
    error TransferFailed();
    error NoDirectLiquidity();
    error ExactOutputUnsupported();
    error AlreadyPledged();

    constructor(
        IPoolManager manager_,
        address platform_,
        uint256 graduationEth_,
        uint256 virtualEth_,
        uint256 virtualTokens_,
        uint256 curveSupply_
    ) {
        manager = manager_;
        platform = platform_;
        graduationEth = graduationEth_;
        virtualEth = virtualEth_;
        virtualTokens = virtualTokens_;
        curveSupply = curveSupply_;
        /* Reverts unless this address has exactly the permission bits below — the
         * whole point of mining the deploy salt (tools/mine-hook.js). */
        Hooks.validateHookPermissions(this, getHookPermissions());
    }

    modifier onlyManager() {
        if (msg.sender != address(manager)) revert NotManager();
        _;
    }

    // ───────────────────────────────────────────── the platform fee ladder
    function platformVolumeBps(uint16 feeBps) public pure returns (uint16) {
        if (feeBps == 100) return 40;
        if (feeBps == 200) return 50;
        if (feeBps == 300) return 60;
        if (feeBps == 400) return 70;
        if (feeBps == 500) return 80;
        if (feeBps == 1000) return 90;
        revert BadFee();
    }

    // ──────────────────────────────────────────────────────────── launching
    /* Deploy the ERC20 and open its live V4 pool in one call. The pool exists
     * and is indexable the instant this returns; buys and sells are ordinary V4
     * swaps that this hook prices.
     *
     * A first buy is NOT bundled here in v1 — the creator buys with a normal
     * swap right after. Bundling it means a swap inside the initialize lock, and
     * keeping the two apart is what keeps this reviewable. */
    function launch(
        string calldata name,
        string calldata symbol,
        uint16 feeBps,
        string calldata logo,
        string calldata description,
        string calldata socials
    ) external returns (address token) {
        platformVolumeBps(feeBps); // reverts unless a real rung

        token = address(new WavesToken(
            name, symbol, curveSupply, address(this), msg.sender, logo, description, socials
        ));

        PoolKey memory key = _key(token);
        PoolId id = key.toId();

        Curve storage c = curves[id];
        c.token = token;
        c.creator = msg.sender;
        c.feeBps = feeBps;
        c.tokensLeft = uint96(curveSupply);
        poolOf[token] = id;

        /* Opening price is the curve's own: sqrtPriceX96 of virtualEth/virtualTokens.
         * The hook prices every swap, so the AMM's stored price only has to be a
         * valid non-zero starting point in the right ballpark. */
        manager.initialize(key, _openingSqrtPrice());

        emit Launched(token, msg.sender, feeBps, name, symbol);
    }

    /* The token's fee/rewards split can be pledged to holders once, after launch
     * — identical to the standalone curve, so the keeper distributes it. */
    function pledge(address token, address keeper_, uint16 bps) external {
        PoolId id = poolOf[token];
        Curve storage c = curves[id];
        if (c.creator != msg.sender) revert UnknownToken();
        if (c.rewardsBps != 0) revert AlreadyPledged();
        if (bps == 0 || bps > 10_000) revert BadFee();
        c.rewardsBps = bps;
        c.keeper = keeper_;
        emit Pledged(token, keeper_, bps);
    }

    function claim() external {
        uint256 amount = owed[msg.sender];
        owed[msg.sender] = 0;
        if (amount == 0) return;
        (bool ok, ) = msg.sender.call{value: amount}("");
        if (!ok) revert TransferFailed();
        emit Claimed(msg.sender, amount);
    }

    // ──────────────────────────────────────────────────────── hook: config
    function getHookPermissions() public pure returns (Hooks.Permissions memory) {
        return Hooks.Permissions({
            beforeInitialize: true,      // only our launch() may open a pool on this hook
            afterInitialize: false,
            beforeAddLiquidity: true,    // block outside LPs while on the curve
            afterAddLiquidity: false,
            beforeRemoveLiquidity: false,
            afterRemoveLiquidity: false,
            beforeSwap: true,            // price against the curve
            afterSwap: false,
            beforeDonate: false,
            afterDonate: false,
            beforeSwapReturnDelta: true, // and take the swap's amounts
            afterSwapReturnDelta: false,
            afterAddLiquidityReturnDelta: false,
            afterRemoveLiquidityReturnDelta: false
        });
    }

    // ───────────────────────────────────────────────────── hook: callbacks
    function beforeInitialize(address sender, PoolKey calldata, uint160)
        external
        view
        onlyManager
        returns (bytes4)
    {
        /* A pool on this hook can only be created by our own launch(). Otherwise
         * anyone could spin up a rogue pool that our indexer and keeper would
         * treat as a WAVES launch. */
        if (sender != address(this)) revert NotHook();
        return IHooks.beforeInitialize.selector;
    }

    function beforeAddLiquidity(address sender, PoolKey calldata, ModifyLiquidityParams calldata, bytes calldata)
        external
        view
        onlyManager
        returns (bytes4)
    {
        /* While the curve owns the reserves, nobody adds or removes liquidity —
         * the price is the curve's, not an LP book. After graduation the hook
         * itself seeds the pool (see _graduate), and only it may. */
        if (sender != address(this)) revert NoDirectLiquidity();
        return IHooks.beforeAddLiquidity.selector;
    }

    /* The curve. A buy is ETH→token (zeroForOne); a sell is token→ETH. Only
     * exact-input is supported — the shape every launchpad UI trades in, and the
     * one the curve math is written for. */
    function beforeSwap(address, PoolKey calldata key, SwapParams calldata params, bytes calldata)
        external
        onlyManager
        returns (bytes4, BeforeSwapDelta, uint24)
    {
        if (params.amountSpecified > 0) revert ExactOutputUnsupported();

        PoolId id = key.toId();
        Curve storage c = curves[id];
        if (c.creator == address(0)) revert UnknownToken();
        if (c.graduated) revert AlreadyGraduated();

        uint256 amountIn = uint256(-params.amountSpecified);
        Currency ethCur = key.currency0;   // native ETH, always currency0
        Currency tokCur = key.currency1;

        int128 unspecified;
        if (params.zeroForOne) {
            // BUY: ETH in, tokens out
            uint256 tokensOut = _buy(c, amountIn);
            /* Take the incoming ETH as an ERC-6909 CLAIM, not real ETH: at
             * beforeSwap the swapper has not settled yet, so a native take
             * would find the manager empty (OutOfFunds). The claim is pure
             * accounting the swapper's settle then backs; the hook holds its
             * reserves as claims and burns them to pay out. */
            ethCur.take(manager, address(this), amountIn, true);      // claims=true
            tokCur.settle(manager, address(this), tokensOut, false);  // real tokens → pool → user
            unspecified = -int128(int256(tokensOut));
            emit Bought(c.token, tx.origin, amountIn, tokensOut, _lastFee);
            if (c.raised >= graduationEth) _graduate(id, c, key);
        } else {
            // SELL: tokens in, ETH out
            uint256 ethOut = _sell(c, amountIn);
            tokCur.take(manager, address(this), amountIn, true);      // claims=true
            ethCur.settle(manager, address(this), ethOut, true);      // burn ETH claims → user
            unspecified = -int128(int256(ethOut));
            emit Sold(c.token, tx.origin, amountIn, ethOut, _lastFee);
        }

        // -amountSpecified consumes the whole specified (input) side; `unspecified`
        // provides the output side. This no-ops the concentrated-liquidity swap.
        BeforeSwapDelta delta = toBeforeSwapDelta(int128(-params.amountSpecified), unspecified);
        return (IHooks.beforeSwap.selector, delta, 0);
    }

    /* Scratch for the event only — set inside _buy/_sell, read right after. */
    uint256 private _lastFee;

    // ──────────────────────────────────────────────────────── curve math
    /* Ported verbatim from WavesCurve._buy. Returns tokens out, mutates the
     * curve, accrues the fee. `amountIn` is the ETH the user is paying (fee
     * included, as on the standalone curve). */
    function _buy(Curve storage c, uint256 value) private returns (uint256 out) {
        uint256 room = c.raised >= graduationEth ? 0 : graduationEth - c.raised;
        if (room == 0) revert CurveComplete();

        uint256 accepted = value;
        uint256 fee = (accepted * c.feeBps) / 10_000;
        uint256 inAfterFee = accepted - fee;
        if (inAfterFee > room) {
            inAfterFee = room;
            fee = (room * c.feeBps) / (10_000 - c.feeBps);
            accepted = room + fee;
            /* NOTE (v1 vs standalone): the standalone curve refunds `value -
             * accepted`. Under exact-input V4 the swap's input is fixed, so a
             * refund path has to hand ETH back to the swapper here. Left for the
             * audited version; until then a buy that would overfill reverts via
             * the room clamp on the *next* wei rather than partially filling.
             * ⚠️ AUDIT: decide refund-vs-revert for the boundary buy. */
        }

        uint256 sold = curveSupply - c.tokensLeft;
        uint256 x = virtualEth + c.raised;
        uint256 y = virtualTokens - sold;
        out = y - ((virtualEth * virtualTokens) / (x + inAfterFee));
        if (out > c.tokensLeft) out = c.tokensLeft;

        c.raised += uint96(inAfterFee);
        c.tokensLeft = uint96(uint256(c.tokensLeft) - out);
        _accrue(c, accepted, fee);
        _lastFee = fee;
    }

    /* Ported verbatim from WavesCurve.sell. `amountIn` is tokens in; returns net
     * ETH out to the seller (fee already removed). */
    function _sell(Curve storage c, uint256 amount) private returns (uint256 net) {
        uint256 sold = curveSupply - c.tokensLeft;
        uint256 x = virtualEth + c.raised;
        uint256 y = virtualTokens - sold;

        uint256 back = (virtualEth * virtualTokens) / (y + amount);
        uint256 gross = back >= x ? 0 : x - back;
        if (gross > c.raised) gross = c.raised;

        uint256 fee = (gross * c.feeBps) / 10_000;
        net = gross - fee;

        c.raised -= uint96(gross);
        c.tokensLeft = uint96(uint256(c.tokensLeft) + amount);
        _accrue(c, gross, fee);
        _lastFee = fee;
    }

    /* Ported verbatim from WavesCurve._accrue. */
    function _accrue(Curve storage c, uint256 volume, uint256 fee) private {
        if (fee == 0) return;
        uint256 toPlatform = (volume * platformVolumeBps(c.feeBps)) / 10_000;
        if (toPlatform > fee) toPlatform = fee;
        owed[platform] += toPlatform;

        uint256 rest = fee - toPlatform;
        if (c.rewardsBps > 0 && c.keeper != address(0)) {
            uint256 toHolders = (rest * c.rewardsBps) / 10_000;
            owed[c.keeper] += toHolders;
            rest -= toHolders;
        }
        owed[c.creator] += rest;
    }

    // ───────────────────────────────────────────────────────── graduation
    /* When the curve fills, the token leaves the curve and its accumulated
     * ETH + leftover tokens become real, locked V4 liquidity in this same pool —
     * the pool address never changes, so every chart and aggregator entry
     * carries straight through.
     *
     * ⚠️ AUDIT / NOT IMPLEMENTED: minting full-range liquidity via
     * manager.modifyLiquidity inside a lock, computing the liquidity amount from
     * the two reserves at the curve's final price, and locking/burning the LP
     * position, is the money-critical half of this contract and is deliberately
     * left as an explicit revert rather than hand-waved. Graduation must be built
     * and fork-tested against RH's PoolManager before mainnet. Flipping
     * `graduated` without seeding liquidity would strand the reserves, so we do
     * neither here — a filled curve simply stops accepting buys (CurveComplete)
     * until this is finished. */
    function _graduate(PoolId id, Curve storage c, PoolKey calldata /*key*/) private {
        emit Graduated(c.token, c.raised, c.tokensLeft);
        // c.graduated = true;  // enabled only once liquidity provision below exists
        // TODO(audit): unlock → modifyLiquidity(full range) → lock LP → set graduated
        revert("GRADUATION_NOT_IMPLEMENTED");
    }

    // ─────────────────────────────────────────────────────────── helpers
    function _key(address token) internal view returns (PoolKey memory) {
        return PoolKey({
            currency0: Currency.wrap(address(0)),   // native ETH
            currency1: Currency.wrap(token),
            fee: LP_FEE,
            tickSpacing: TICK_SPACING,
            hooks: IHooks(address(this))
        });
    }

    /* sqrt(virtualEth / virtualTokens) * 2^96, the curve's opening price. Uses a
     * simple integer sqrt; the hook re-prices every swap, so this only has to be
     * a valid, correctly-scaled starting tick. */
    function _openingSqrtPrice() internal view returns (uint160) {
        uint256 ratioX192 = (virtualEth << 192) / virtualTokens;
        return uint160(_sqrt(ratioX192));
    }

    function _sqrt(uint256 x) internal pure returns (uint256 y) {
        if (x == 0) return 0;
        uint256 z = (x + 1) / 2;
        y = x;
        while (z < y) { y = z; z = (x / z + z) / 2; }
    }

    // ───────────────────────── unused IHooks callbacks (revert / passthrough)
    function afterInitialize(address, PoolKey calldata, uint160, int24) external pure returns (bytes4) {
        return IHooks.afterInitialize.selector;
    }
    function afterAddLiquidity(
        address, PoolKey calldata, ModifyLiquidityParams calldata, BalanceDelta, BalanceDelta, bytes calldata
    ) external pure returns (bytes4, BalanceDelta) {
        return (IHooks.afterAddLiquidity.selector, BalanceDelta.wrap(0));
    }
    function beforeRemoveLiquidity(address, PoolKey calldata, ModifyLiquidityParams calldata, bytes calldata)
        external pure returns (bytes4) { return IHooks.beforeRemoveLiquidity.selector; }
    function afterRemoveLiquidity(
        address, PoolKey calldata, ModifyLiquidityParams calldata, BalanceDelta, BalanceDelta, bytes calldata
    ) external pure returns (bytes4, BalanceDelta) {
        return (IHooks.afterRemoveLiquidity.selector, BalanceDelta.wrap(0));
    }
    function afterSwap(address, PoolKey calldata, SwapParams calldata, BalanceDelta, bytes calldata)
        external pure returns (bytes4, int128) { return (IHooks.afterSwap.selector, int128(0)); }
    function beforeDonate(address, PoolKey calldata, uint256, uint256, bytes calldata)
        external pure returns (bytes4) { return IHooks.beforeDonate.selector; }
    function afterDonate(address, PoolKey calldata, uint256, uint256, bytes calldata)
        external pure returns (bytes4) { return IHooks.afterDonate.selector; }

    receive() external payable {}
}
