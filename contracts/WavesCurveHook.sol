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
import {IERC20Minimal} from "@uniswap/v4-core/src/interfaces/external/IERC20Minimal.sol";
import {Hooks} from "@uniswap/v4-core/src/libraries/Hooks.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {PoolId, PoolIdLibrary} from "@uniswap/v4-core/src/types/PoolId.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {BalanceDelta, BalanceDeltaLibrary} from "@uniswap/v4-core/src/types/BalanceDelta.sol";
import {BeforeSwapDelta, toBeforeSwapDelta} from "@uniswap/v4-core/src/types/BeforeSwapDelta.sol";
import {SwapParams, ModifyLiquidityParams} from "@uniswap/v4-core/src/types/PoolOperation.sol";
import {TickMath} from "@uniswap/v4-core/src/libraries/TickMath.sol";
import {FullMath} from "@uniswap/v4-core/src/libraries/FullMath.sol";
import {StateLibrary} from "@uniswap/v4-core/src/libraries/StateLibrary.sol";
import {CurrencySettler} from "./v4lib/CurrencySettler.sol";
import {LiquidityAmounts} from "./v4lib/LiquidityAmounts.sol";
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
 * pump.fun-on-V4 and Robinhood's other launchpads (KLIK, Pons v2) use.
 *
 * ── One hook, every launch, any quote asset ─────────────────────────────────
 * V4 keys a hook inside the PoolKey, so ONE deployed hook serves every WAVES
 * pool. Only the ERC20 is deployed per launch — one audited money contract, as
 * before. Per-pool state is keyed by PoolId.
 *
 * A launch may quote its pool in native ETH (the default) OR in an approved
 * ERC-20 quote asset — USDG, or a tokenized RWA/stock — so the token trades
 * directly against that asset (Pons v2 / PAIR / long.xyz "stock-paired" model).
 * The quote is chosen from a platform-curated registry (`approvedQuotes`); each
 * entry carries a graduation target in that quote's own units. The curve SHAPE
 * is identical for every quote: virtual reserves scale from the ETH template by
 * the same dimensionless ratios, so only the denomination changes.
 *
 * ── Currency ordering ───────────────────────────────────────────────────────
 * V4 requires currency0 < currency1 numerically. Native ETH (address(0)) is
 * always currency0, so ETH launches are unchanged. For an ERC-20 quote the
 * quote-vs-token ordering is not fixed, so each Curve records `tokenIs1` and the
 * swap/graduation logic maps quote/token → currency0/currency1 through it. The
 * beforeSwap delta is expressed in swap-SPECIFIED space (input consumed, output
 * provided), which is ordering-independent; only the buy/sell direction test and
 * the graduation amount0/amount1 assignment depend on the ordering.
 *
 * ── The curve, unchanged ────────────────────────────────────────────────────
 * Constant product against VIRTUAL reserves — the exact math, clamps and
 * rounding of WavesCurve.sol, ported verbatim into `_beforeSwap`:
 *     x = virtualQuote + raised     y = virtualTokens - sold     k = x*y
 * Rounding goes to the pool; the room-clamp stops a single buy draining the
 * curve; graduation seeds the pool from the supply the virtual reserve leaves
 * behind. Every comment on those invariants in WavesCurve.sol applies here.
 *
 * ── Reserve model ───────────────────────────────────────────────────────────
 * Reserves (the whole token supply, and the quote the curve takes) are held as
 * ERC-6909 CLAIMS in the PoolManager, never as real balances — a take at
 * beforeSwap, before the swapper has settled, would find the manager empty.
 * Launch deposits the supply as a claim; a buy mints quote-claims and burns
 * token-claims, a sell does the reverse, claim() burns quote-claims back to the
 * quote asset, and graduation burns both to seed the pool.
 *
 * ── Lifecycle ───────────────────────────────────────────────────────────────
 * launch → live pool (supply as claims) → curve trading (beforeSwap prices every
 * swap) → curve fills → graduate() seeds one wide-range, hook-owned (=locked)
 * position and flips the pool to an ordinary AMM (beforeSwap steps aside). The
 * locked LP also clears the "Burnt/Locked LP" risk flag aggregators raise.
 *
 * ⚠️ AUDIT STATUS: the ETH path is validated on a local PoolManager. The
 * quote-asset generalisation (registry, order-aware key, ERC-20 first-buy/claim,
 * order-aware graduation) is NEW and unaudited. Still owed before any mainnet
 * launch: full unit + fork tests for the ERC-20-quote paths, a re-mined hook
 * deploy address, and a full audit — this moves other people's money. Exact-
 * output swaps and a bundled launch-buy beyond the atomic first buy are out of
 * scope for v1.
 */
contract WavesCurveHook is IHooks {
    using PoolIdLibrary for PoolKey;
    using CurrencySettler for Currency;
    using BalanceDeltaLibrary for BalanceDelta;
    using StateLibrary for IPoolManager;

    // ─────────────────────────────────────────────────────────── immutables
    IPoolManager public immutable manager;
    address public immutable platform;

    /* The ETH-quote template. Every other quote scales its virtual reserve from
     * these by the same ratio, so the curve shape is identical across quotes. */
    uint256 public immutable graduationEth;
    uint256 public immutable virtualEth;
    uint256 public immutable virtualTokens;
    uint256 public immutable curveSupply;

    /* One fee tier, widest tick spacing. The LP fee is zero — WAVES fees are
     * taken by this hook, not by the pool. */
    uint24 internal constant LP_FEE = 0;
    int24 internal constant TICK_SPACING = 60;

    uint16 public constant MAX_FEE_BPS = 1000;
    uint16 public constant MIN_FEE_BPS = 100;

    /* A quote's registered `graduationQuote` is not the number the curve runs on —
     * the virtual quote reserve is DERIVED from it (`graduationQuote × virtualEth /
     * graduationEth`, ~0.35× with the live template). Validating only that the
     * target is non-zero (setQuote below) still lets an absurdly small target
     * derive a reserve of 0 (launch reverts with a bare arithmetic panic) or a
     * handful of wei (the constant product degenerates and the first buy walks
     * most of the supply). Both are platform-set-error cases, but the floor closes
     * them at the source. 1e6 sits ~3 orders below the smallest realistic derived
     * reserve (a ~$2.8 target on a 6-dec quote) and ~5 orders above the degenerate
     * range, so it rejects only misconfiguration, never a real launch. */
    uint128 public constant MIN_VIRTUAL_QUOTE = 1e6;

    // ─────────────────────────────────────────────────── the quote registry
    /* Which assets a launch may quote its pool in. `graduationQuote` is how much
     * of the quote the curve raises before it graduates, in the quote's own
     * units. Platform-curated: only quotes with a deep enough real market (so the
     * USDG aggregator can route into them, and aggregators can price them) are
     * enabled. address(0) = native ETH is seeded in the constructor. */
    struct QuoteConfig {
        bool enabled;
        uint96 graduationQuote;
    }
    mapping(address => QuoteConfig) public approvedQuotes;

    // ─────────────────────────────────────────────────────────────── state
    struct Curve {
        address token;
        address creator;
        uint16 feeBps;
        uint16 rewardsBps;
        address keeper;
        uint96 raised;       // quote raised so far, in quote units
        uint96 tokensLeft;
        bool full;           // latched once raised first reaches graduationQuote
        bool graduated;
        address quote;        // the pool's quote asset; address(0) = native ETH
        bool tokenIs1;        // token is currency1 (quote is currency0) — V4 ordering
        uint96 gradQuote;     // graduation threshold in quote units (snapshot at launch)
        uint128 virtualQuote; // virtual quote reserve, derived from the ETH template
    }

    mapping(PoolId => Curve) public curves;
    /* token → its PoolId, so the keeper and the UI can go token-first. */
    mapping(address => PoolId) public poolOf;
    /* Fees owed, held until claimed, keyed by asset: who → quote asset → amount.
     * Fees accrue in whatever the pool is quoted in. */
    mapping(address => mapping(address => uint256)) public owed;

    // ────────────────────────────────────────────────────────────── events
    event Launched(
        address indexed token, address indexed creator, address indexed quote, uint16 feeBps, string name, string symbol
    );
    event Bought(address indexed token, address indexed buyer, uint256 quoteIn, uint256 tokensOut, uint256 fee);
    event Sold(address indexed token, address indexed seller, uint256 tokensIn, uint256 quoteOut, uint256 fee);
    event Pledged(address indexed token, address indexed keeper, uint16 bps);
    event Graduated(address indexed token, uint256 quoteIn, uint256 tokensIn);
    event Claimed(address indexed who, address indexed quote, uint256 amount);
    event QuoteSet(address indexed quote, bool enabled, uint96 graduationQuote);

    // ────────────────────────────────────────────────────────────── errors
    error NotManager();
    error NotHook();
    error NotPlatform();
    error UnknownToken();
    error AlreadyGraduated();
    error CurveComplete();
    error BadFee();
    error BadConfig();
    error QuoteNotApproved();
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
        /* raised and tokensLeft are uint96; a config whose reserves would not fit
         * must be rejected here rather than truncated silently later. */
        require(curveSupply_ <= type(uint96).max && graduationEth_ <= type(uint96).max, "config too large");
        /* The ETH quote's derived reserve is exactly virtualEth (mulDiv(g,vEth,g)),
         * so hold it to the same MIN_VIRTUAL_QUOTE floor every other quote must
         * clear — the guard exists three lines down for every ERC-20 quote, and a
         * deploy with a degenerate virtualEth would otherwise seed the exact curve
         * M-1's fix closes everywhere else. */
        require(virtualEth_ >= MIN_VIRTUAL_QUOTE, "virtualEth below floor");
        /* Native ETH is always an approved quote, with the template's target. */
        approvedQuotes[address(0)] = QuoteConfig({enabled: true, graduationQuote: uint96(graduationEth_)});
        /* Reverts unless this address has exactly the permission bits below — the
         * whole point of mining the deploy salt (script/DeployWavesCurveHook). */
        Hooks.validateHookPermissions(this, getHookPermissions());
    }

    modifier onlyManager() {
        if (msg.sender != address(manager)) revert NotManager();
        _;
    }

    // ─────────────────────────────────────────────── quote-asset registry
    /* Platform-only. Enable/disable a quote asset and set its graduation target
     * (in the quote's own units). Only affects FUTURE launches — a live curve
     * snapshots its config at launch. */
    /* The virtual quote reserve derived from a target — the number the curve
     * actually runs on. Validated against MIN_VIRTUAL_QUOTE wherever a target is
     * set or used, so a degenerate reserve can neither be registered nor launched. */
    function _virtualQuoteFor(uint96 graduationQuote) internal view returns (uint256) {
        return FullMath.mulDiv(graduationQuote, virtualEth, graduationEth);
    }

    function setQuote(address quote, bool enabled, uint96 graduationQuote) external {
        if (msg.sender != platform) revert NotPlatform();
        if (enabled && _virtualQuoteFor(graduationQuote) < MIN_VIRTUAL_QUOTE) revert BadConfig();
        approvedQuotes[quote] = QuoteConfig({enabled: enabled, graduationQuote: graduationQuote});
        emit QuoteSet(quote, enabled, graduationQuote);
    }

    /* Approve (or disable) many quote assets in one call — platform-only, so the
     * whole stock catalogue can be seeded without a signature per asset. A
     * positive graduationQuote enables that quote; a zero disables it. The arrays
     * line up index-for-index. */
    function setQuotes(address[] calldata quotes, uint96[] calldata grads) external {
        if (msg.sender != platform) revert NotPlatform();
        if (quotes.length != grads.length) revert BadConfig();
        for (uint256 i = 0; i < quotes.length; i++) {
            bool en = grads[i] > 0;
            if (en && _virtualQuoteFor(grads[i]) < MIN_VIRTUAL_QUOTE) revert BadConfig();
            approvedQuotes[quotes[i]] = QuoteConfig({enabled: en, graduationQuote: grads[i]});
            emit QuoteSet(quotes[i], en, grads[i]);
        }
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
     * `quote` selects the pool's quote asset (address(0) = native ETH). It must
     * be an approved quote. For an ETH quote the atomic first buy is msg.value;
     * for an ERC-20 quote it is `firstBuy`, pulled from the creator via
     * transferFrom (approve first) — msg.value must be zero.
     *
     * Anti-snipe: the first buy runs on the curve in this same transaction,
     * atomically after the pool opens (the standard Pons-level defence). It
     * closes the one-block window a bot would otherwise have between the pool
     * opening and the creator's first buy. */
    function launch(
        string calldata name,
        string calldata symbol,
        uint16 feeBps,
        string calldata logo,
        string calldata description,
        string calldata socials,
        address quote,
        uint256 firstBuy
    ) external payable returns (address token) {
        platformVolumeBps(feeBps); // reverts unless a real rung
        QuoteConfig memory qc = approvedQuotes[quote];
        if (!qc.enabled) revert QuoteNotApproved();

        token = address(new WavesToken(
            name, symbol, curveSupply, address(this), msg.sender, logo, description, socials
        ));

        (PoolKey memory key, bool tokenIs1) = _key(token, quote);
        PoolId id = key.toId();

        Curve storage c = curves[id];
        c.token = token;
        c.creator = msg.sender;
        c.feeBps = feeBps;
        c.tokensLeft = uint96(curveSupply);
        c.quote = quote;
        c.tokenIs1 = tokenIs1;
        c.gradQuote = qc.graduationQuote;
        /* Scale the virtual quote reserve from the ETH template by the same ratio
         * the graduation target scales, so the curve shape is identical. Floored so
         * a degenerate reserve (see MIN_VIRTUAL_QUOTE) can never reach the curve
         * math even if a bad target slipped past registration. */
        uint256 vq = _virtualQuoteFor(qc.graduationQuote);
        if (vq < MIN_VIRTUAL_QUOTE) revert BadConfig();
        c.virtualQuote = uint128(vq);
        poolOf[token] = id;

        /* Opening price is the curve's own graduation ratio. The hook prices
         * every swap, so the AMM's stored price only has to be a valid non-zero
         * starting point in the right ballpark. */
        manager.initialize(key, _openingSqrtPrice(c.virtualQuote, qc.graduationQuote, tokenIs1));

        /* Determine the atomic first-buy amount and, for an ERC-20 quote, pull it
         * into the hook so op-0 can settle it inside the lock. */
        uint256 buyValue;
        if (quote == address(0)) {
            buyValue = msg.value;
        } else {
            if (msg.value != 0) revert TransferFailed(); // no ETH on a token-quoted launch
            buyValue = firstBuy;
            if (buyValue > 0) {
                if (!IERC20Minimal(quote).transferFrom(msg.sender, address(this), buyValue)) revert TransferFailed();
            }
        }

        /* Deposit the whole supply into the PoolManager as the hook's ERC-6909
         * claim, and (op 0) carry the atomic first buy — both inside one lock. */
        manager.unlock(abi.encode(uint8(0), token, curveSupply, buyValue, msg.sender));

        emit Launched(token, msg.sender, quote, feeBps, name, symbol);
    }

    /* The manager's callback. Jobs tagged by the leading byte:
     *   0 = deposit a launch's supply as a token-claim + the atomic first buy
     *   1 = burn quote-claims back to the quote asset and forward it (from claim)
     *   2 = seed the graduated pool with the reserves as locked liquidity
     * Only the manager can call this, and only we ever ask it to. */
    function unlockCallback(bytes calldata data) external returns (bytes memory) {
        if (msg.sender != address(manager)) revert NotManager();
        uint8 op = uint8(data[31]); // first abi word's low byte

        if (op == 0) {
            (, address token, uint256 amount, uint256 buyValue, address buyer) =
                abi.decode(data, (uint8, address, uint256, uint256, address));
            Curve storage c = curves[poolOf[token]];
            Currency tok = Currency.wrap(token);
            manager.sync(tok);
            WavesToken(token).transfer(address(manager), amount); // real tokens in
            manager.settle();
            manager.mint(address(this), tok.toId(), amount);      // ← as our claim

            if (buyValue > 0) {
                // Atomic first buy: price it on the curve, hold the quote as our
                // claim, and hand the buyer their tokens — all inside this lock.
                Currency q = Currency.wrap(c.quote);
                (uint256 out, uint256 accepted, uint256 fee) = _buy(c, buyValue);
                // Settle the accepted quote into the manager (native or ERC-20;
                // the hook holds it — msg.value for ETH, the pulled tokens else).
                if (c.quote == address(0)) {
                    manager.settle{value: accepted}();
                } else {
                    q.settle(manager, address(this), accepted, false);
                }
                manager.mint(address(this), q.toId(), accepted);  // ← as our quote-claim
                manager.burn(address(this), tok.toId(), out);     // burn token-claims
                manager.take(tok, buyer, out);                    // → tokens to the creator
                emit Bought(token, buyer, accepted, out, fee);
                // Refund the overfill (buyValue - accepted) if the first buy alone
                // fills the curve — in the quote asset the hook still holds.
                if (buyValue > accepted) {
                    _refund(c.quote, buyer, buyValue - accepted);
                }
            }
        } else if (op == 1) {
            (, address to, uint256 amount, address quote) = abi.decode(data, (uint8, address, uint256, address));
            Currency q = Currency.wrap(quote);
            manager.burn(address(this), q.toId(), amount);        // burn quote-claims
            manager.take(q, to, amount);                          // → quote asset out
        } else {
            // op == 2: seed the graduated pool with the reserves as locked liquidity
            (, address token,) = abi.decode(data, (uint8, address, uint256));
            _seedGraduation(token);
        }
        return "";
    }

    /* Refund an overfill in the pool's quote asset — native call or ERC-20 send. */
    function _refund(address quote, address to, uint256 amount) private {
        if (quote == address(0)) {
            (bool ok, ) = to.call{value: amount}("");
            if (!ok) revert TransferFailed();
        } else {
            if (!IERC20Minimal(quote).transfer(to, amount)) revert TransferFailed();
        }
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

    /* Claim accrued fees in a given quote asset. Fees accrue per asset, so a
     * platform/creator/keeper that has earned in several quotes claims each. */
    function claim(address quote) external {
        uint256 amount = owed[msg.sender][quote];
        owed[msg.sender][quote] = 0;
        if (amount == 0) return;
        /* The fees accrued as the hook's quote-claims; unlock to burn them back
         * to the quote asset and forward it in one step. */
        manager.unlock(abi.encode(uint8(1), msg.sender, amount, quote));
        emit Claimed(msg.sender, quote, amount);
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

    /* The curve. A buy is quote→token; a sell is token→quote. Only exact-input is
     * supported — the shape every launchpad UI trades in, and the one the curve
     * math is written for. Which V4 direction (zeroForOne) a buy is depends on
     * the currency ordering, recorded per curve as `tokenIs1`. */
    function beforeSwap(address sender, PoolKey calldata key, SwapParams calldata params, bytes calldata)
        external
        onlyManager
        returns (bytes4, BeforeSwapDelta, uint24)
    {
        PoolId id = key.toId();
        Curve storage c = curves[id];
        if (c.creator == address(0)) revert UnknownToken();
        /* Once graduated, the pool trades as an ordinary V4 AMM against the
         * locked liquidity — the hook steps aside and lets the swap through
         * with a zero delta. */
        if (c.graduated) return (IHooks.beforeSwap.selector, toBeforeSwapDelta(0, 0), 0);
        /* Full but not yet graduated: the curve is closed. No buys, no sells —
         * anyone may call graduate(); until then the pool is frozen so a sell
         * cannot un-fill it (griefing). */
        if (c.full) revert CurveComplete();

        if (params.amountSpecified > 0) revert ExactOutputUnsupported();
        uint256 amountIn = uint256(-params.amountSpecified);

        Currency quoteCur = Currency.wrap(c.quote);
        Currency tokCur = Currency.wrap(c.token);
        /* A buy is quote-in → token-out. In V4, zeroForOne means currency0→
         * currency1. If the token is currency1, currency0 is the quote, so a buy
         * is zeroForOne; otherwise it is the reverse. */
        bool isBuy = c.tokenIs1 ? params.zeroForOne : !params.zeroForOne;

        int128 specified;
        int128 unspecified;
        if (isBuy) {
            // BUY: quote in, tokens out. `accepted` is what the curve actually
            // takes — on the boundary buy it is less than amountIn, and only
            // `accepted` is consumed so the swapper keeps the overfill (H1).
            (uint256 tokensOut, uint256 accepted, uint256 fee) = _buy(c, amountIn);
            /* Take/settle as ERC-6909 CLAIMS, not real assets: at beforeSwap the
             * swapper has not settled yet, so a real take would find the manager
             * empty (OutOfFunds). The delta is expressed in swap-SPECIFIED space
             * (input consumed positive, output provided negative), which is the
             * same regardless of which currency sorts first. */
            quoteCur.take(manager, address(this), accepted, true);   // quote in → our claim
            tokCur.settle(manager, address(this), tokensOut, true);  // burn token-claims → user
            specified = int128(int256(accepted));                    // consume only `accepted`
            unspecified = -int128(int256(tokensOut));
            emit Bought(c.token, sender, accepted, tokensOut, fee);
        } else {
            // SELL: tokens in, quote out
            (uint256 quoteOut, uint256 fee) = _sell(c, amountIn);
            tokCur.take(manager, address(this), amountIn, true);     // tokens in → our claim
            quoteCur.settle(manager, address(this), quoteOut, true); // burn quote-claims → user
            specified = int128(int256(amountIn));                    // whole input consumed
            unspecified = -int128(int256(quoteOut));
            emit Sold(c.token, sender, amountIn, quoteOut, fee);
        }

        BeforeSwapDelta delta = toBeforeSwapDelta(specified, unspecified);
        return (IHooks.beforeSwap.selector, delta, 0);
    }

    // ──────────────────────────────────────────────────────── curve math
    /* Ported from WavesCurve._buy. Returns (tokens out, quote accepted, fee).
     * `accepted` <= value on the boundary buy: the excess is never taken, so the
     * swapper keeps it — the V4 form of the standalone curve's refund. Reads the
     * per-curve virtual reserve and graduation target so the math is denominated
     * in the pool's quote asset. */
    function _buy(Curve storage c, uint256 value)
        private
        returns (uint256 out, uint256 accepted, uint256 fee)
    {
        uint256 grad = c.gradQuote;
        uint256 vQuote = c.virtualQuote;
        uint256 room = c.raised >= grad ? 0 : grad - c.raised;
        if (room == 0) revert CurveComplete();

        accepted = value;
        fee = (accepted * c.feeBps) / 10_000;
        uint256 inAfterFee = accepted - fee;
        if (inAfterFee > room) {
            // clamp to exactly what fills the curve; charge the same rate on it
            inAfterFee = room;
            fee = (room * c.feeBps) / (10_000 - c.feeBps);
            accepted = room + fee;  // < value; the difference is the swapper's refund
        }

        uint256 sold = curveSupply - c.tokensLeft;
        uint256 x = vQuote + c.raised;
        uint256 y = virtualTokens - sold;
        out = y - FullMath.mulDiv(vQuote, virtualTokens, x + inAfterFee);
        if (out > c.tokensLeft) out = c.tokensLeft;

        c.raised += uint96(inAfterFee);
        c.tokensLeft = uint96(uint256(c.tokensLeft) - out);
        if (c.raised >= grad) c.full = true;  // latch (M2)
        _accrue(c, accepted, fee);
    }

    /* Ported from WavesCurve.sell. `amount` is tokens in; returns (net quote out
     * to the seller with fee removed, fee). */
    function _sell(Curve storage c, uint256 amount) private returns (uint256 net, uint256 fee) {
        uint256 vQuote = c.virtualQuote;
        uint256 sold = curveSupply - c.tokensLeft;
        uint256 x = vQuote + c.raised;
        uint256 y = virtualTokens - sold;

        uint256 back = FullMath.mulDiv(vQuote, virtualTokens, y + amount);
        uint256 gross = back >= x ? 0 : x - back;
        if (gross > c.raised) gross = c.raised;

        fee = (gross * c.feeBps) / 10_000;
        net = gross - fee;

        c.raised -= uint96(gross);
        c.tokensLeft = uint96(uint256(c.tokensLeft) + amount);
        _accrue(c, gross, fee);
    }

    /* Ported verbatim from WavesCurve._accrue, now keyed by the pool's quote
     * asset — fees accrue in whatever the pool trades against. */
    function _accrue(Curve storage c, uint256 volume, uint256 fee) private {
        if (fee == 0) return;
        address q = c.quote;
        uint256 toPlatform = (volume * platformVolumeBps(c.feeBps)) / 10_000;
        if (toPlatform > fee) toPlatform = fee;
        owed[platform][q] += toPlatform;

        uint256 rest = fee - toPlatform;
        if (c.rewardsBps > 0 && c.keeper != address(0)) {
            uint256 toHolders = (rest * c.rewardsBps) / 10_000;
            owed[c.keeper][q] += toHolders;
            rest -= toHolders;
        }
        owed[c.creator][q] += rest;
    }

    // ───────────────────────────────────────────────────────── graduation
    /* Once the curve is full, anyone may finish it: the accumulated quote and the
     * tokens the curve left behind become one wide-range V4 position, owned by
     * this hook forever (there is no path in this contract that removes it), so
     * the launch's liquidity is permanently locked, and the pool then trades as
     * an ordinary AMM (beforeSwap steps aside).
     *
     * Gated on the LATCHED `full` flag, not the live `raised` (M2). Permissionless
     * because there is nothing to steal: the amounts and the position are fixed by
     * the curve's final state, and the LP goes to the hook regardless of caller. */
    function graduate(address token) external {
        PoolId id = poolOf[token];
        Curve storage c = curves[id];
        if (c.creator == address(0)) revert UnknownToken();
        if (c.graduated) revert AlreadyGraduated();
        if (!c.full) revert CurveComplete(); // not full yet
        c.graduated = true;
        emit Graduated(token, c.raised, c.tokensLeft);
        manager.unlock(abi.encode(uint8(2), token, uint256(0)));
    }

    /* The graduation add-liquidity, run inside the unlock. The pool's stored price
     * is reset to the reserves' ratio, then a wide-range position deploys both the
     * raised quote and the leftover tokens. The hook owes those two amounts to the
     * pool afterwards and pays them by burning the claims it has held all along.
     *
     * Order-aware: quote and token map to currency0/currency1 by `tokenIs1`. */
    function _seedGraduation(address token) private {
        PoolId id = poolOf[token];
        Curve storage c = curves[id];
        bool tokenIs1 = c.tokenIs1;
        (PoolKey memory key,) = _key(token, c.quote);

        /* Reset the stored price to the reserves' ratio (curve-phase swaps slid it
         * to a price limit) with a zero-liquidity swap to that exact limit —
         * moves the price, trades nothing. graduated is already true, so
         * beforeSwap passes this swap straight through. */
        uint160 sqrtP = _openingSqrtPrice(c.virtualQuote, c.gradQuote, tokenIs1);
        (uint160 cur,,,) = manager.getSlot0(id);
        if (cur != sqrtP) {
            manager.swap(
                key,
                SwapParams({zeroForOne: cur > sqrtP, amountSpecified: 1, sqrtPriceLimitX96: sqrtP}),
                ""
            );
        }
        int24 curTick = TickMath.getTickAtSqrtPrice(sqrtP);
        /* A very wide band around the price rather than the absolute MIN/MAX ticks:
         * a true full-range position overflows a uint128 intermediate in the pool's
         * amount math when the price sits far from centre. ±300k ticks is ~1e13x
         * either way — effectively full-range for a meme token. */
        int24 lower = _alignTick(curTick - 300_000, true);
        int24 upper = _alignTick(curTick + 300_000, false);

        uint256 quoteAmt = uint256(c.raised);
        uint256 tokenAmt = uint256(c.tokensLeft);
        uint256 amount0 = tokenIs1 ? quoteAmt : tokenAmt;
        uint256 amount1 = tokenIs1 ? tokenAmt : quoteAmt;

        uint128 liq = LiquidityAmounts.getLiquidityForAmounts(
            sqrtP,
            TickMath.getSqrtPriceAtTick(lower),
            TickMath.getSqrtPriceAtTick(upper),
            amount0,
            amount1
        );

        (BalanceDelta delta, ) = manager.modifyLiquidity(
            key,
            ModifyLiquidityParams({tickLower: lower, tickUpper: upper, liquidityDelta: int256(uint256(liq)), salt: 0}),
            ""
        );

        /* delta is what the hook owes the pool (negative on each side). Pay both
         * by burning the reserves it holds as claims. */
        int128 owe0 = delta.amount0();
        int128 owe1 = delta.amount1();
        uint256 used0 = owe0 < 0 ? uint256(uint128(-owe0)) : 0;
        uint256 used1 = owe1 < 0 ? uint256(uint128(-owe1)) : 0;
        if (used0 > 0) key.currency0.settle(manager, address(this), used0, true);
        if (used1 > 0) key.currency1.settle(manager, address(this), used1, true);

        /* Sweep any reserve the wide-range position could not absorb (M1). The
         * quote residual goes to the platform as a fee-claim; the token residual
         * (dust) is burned to the dead address so it can never re-enter supply. */
        uint256 usedQuote = tokenIs1 ? used0 : used1;
        uint256 usedToken = tokenIs1 ? used1 : used0;

        uint256 quoteResidual = quoteAmt > usedQuote ? quoteAmt - usedQuote : 0;
        if (quoteResidual > 0) owed[platform][c.quote] += quoteResidual; // stays a quote-claim
        uint256 tokResidual = tokenAmt > usedToken ? tokenAmt - usedToken : 0;
        if (tokResidual > 0) {
            Currency tokCur = Currency.wrap(token);
            manager.burn(address(this), tokCur.toId(), tokResidual);
            manager.take(tokCur, address(0xdEaD), tokResidual);
        }
    }

    /* Snap a tick to TICK_SPACING and into the usable range. `down` rounds toward
     * MIN (for the lower tick), else toward MAX. */
    function _alignTick(int256 t, bool down) internal pure returns (int24) {
        int256 minU = (int256(TickMath.MIN_TICK) / TICK_SPACING) * TICK_SPACING;
        int256 maxU = (int256(TickMath.MAX_TICK) / TICK_SPACING) * TICK_SPACING;
        if (t < minU) t = minU;
        if (t > maxU) t = maxU;
        int256 snapped = (t / TICK_SPACING) * TICK_SPACING;
        if (down && snapped > t) snapped -= TICK_SPACING;
        if (!down && snapped < t) snapped += TICK_SPACING;
        if (snapped < minU) snapped = minU;
        if (snapped > maxU) snapped = maxU;
        return int24(snapped);
    }

    // ─────────────────────────────────────────────────────────── helpers
    /* Build the pool key for (token, quote), ordered as V4 requires
     * (currency0 < currency1). Returns whether the token is currency1 (i.e. the
     * quote is currency0) — the natural ETH-quote case, since address(0) sorts
     * below every token. */
    function _key(address token, address quote) internal view returns (PoolKey memory key, bool tokenIs1) {
        (address c0, address c1) = quote < token ? (quote, token) : (token, quote);
        tokenIs1 = (c1 == token);
        key = PoolKey({
            currency0: Currency.wrap(c0),
            currency1: Currency.wrap(c1),
            fee: LP_FEE,
            tickSpacing: TICK_SPACING,
            hooks: IHooks(address(this))
        });
    }

    /* The pool's stored price is the price the curve GRADUATES at — the ratio of
     * the reserves it hands the pool (tokensLeftAtGrad tokens : gradQuote quote).
     * During the curve phase the hook overrides every swap, so this stored price
     * is dormant; at graduation the wide-range position deploys both reserves
     * cleanly because the price already matches them. Aggregators chart the curve
     * phase from Swap events, not this value.
     *
     * Order-aware: price is currency1/currency0, so the token/quote ratio is
     * inverted when the token is currency0. */
    function _openingSqrtPrice(uint256 vQuote, uint256 gradQuote, bool tokenIs1) internal view returns (uint160) {
        uint256 yAtGrad = FullMath.mulDiv(vQuote, virtualTokens, vQuote + gradQuote);
        uint256 tokensLeftAtGrad = curveSupply - (virtualTokens - yAtGrad);
        /* Reserves at graduation: gradQuote of quote, tokensLeftAtGrad of token.
         * amount1/amount0 · 2^192; the numerator can need ~280 bits, so
         * FullMath.mulDiv does the full 512-bit multiply then divide (H2). */
        uint256 amount0 = tokenIs1 ? gradQuote : tokensLeftAtGrad;
        uint256 amount1 = tokenIs1 ? tokensLeftAtGrad : gradQuote;
        uint256 ratioX192 = FullMath.mulDiv(amount1, uint256(1) << 192, amount0);
        uint160 p = uint160(_sqrt(ratioX192));
        // clamp into the valid V4 range, just in case of extreme params
        if (p <= MIN_SQRT_PRICE) return MIN_SQRT_PRICE + 1;
        if (p >= MAX_SQRT_PRICE) return MAX_SQRT_PRICE - 1;
        return p;
    }

    uint160 internal constant MIN_SQRT_PRICE = 4295128739;
    uint160 internal constant MAX_SQRT_PRICE = 1461446703485210103287273052203988822378723970342;

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
