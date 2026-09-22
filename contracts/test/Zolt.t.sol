// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";

import {PoolManager} from "@uniswap/v4-core/src/PoolManager.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {IHooks} from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import {Hooks} from "@uniswap/v4-core/src/libraries/Hooks.sol";
import {LPFeeLibrary} from "@uniswap/v4-core/src/libraries/LPFeeLibrary.sol";
import {TickMath} from "@uniswap/v4-core/src/libraries/TickMath.sol";
import {PoolSwapTest} from "@uniswap/v4-core/src/test/PoolSwapTest.sol";
import {PoolModifyLiquidityTest} from "@uniswap/v4-core/src/test/PoolModifyLiquidityTest.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {PoolId, PoolIdLibrary} from "@uniswap/v4-core/src/types/PoolId.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {BalanceDelta} from "@uniswap/v4-core/src/types/BalanceDelta.sol";
import {ModifyLiquidityParams, SwapParams} from "@uniswap/v4-core/src/types/PoolOperation.sol";

import {Zolt} from "../src/Zolt.sol";
import {MockERC20} from "../src/mocks/MockERC20.sol";
import {MockStockToken} from "../src/mocks/MockStockToken.sol";

/// Every scenario runs the same trade against two pools that differ only in the hook:
///   bare    - a normal v4 pool, 0.30% static fee, no hook
///   guarded - a v4 pool with Zolt, 0.30% base fee
/// Both start at 100 quote per stock with the same full-range liquidity.
/// "Taken" = value of what the trader received at the post-step fair price, minus what they paid.
contract ZoltTest is Test {
    using PoolIdLibrary for PoolKey;

    uint24 constant BASE_FEE = 3000;
    uint256 constant LOOKAHEAD = 2 hours;
    uint256 constant WINDOW = 24 hours;
    int24 constant SPACING = 60;
    int24 constant MIN_TICK = -887220;
    int24 constant MAX_TICK = 887220;
    uint256 constant PRICE = 100; // quote per stock before any step
    uint256 constant ONE = 1e18;
    uint256 constant LIQUIDITY = 1e22;

    PoolManager manager;
    PoolSwapTest swapRouter;
    PoolModifyLiquidityTest lpRouter;
    Zolt hook;

    MockStockToken stock;
    MockERC20 quote;
    PoolKey bare;
    PoolKey guarded;

    function setUp() public {
        vm.warp(1_790_000_000);
        manager = new PoolManager(address(this));
        swapRouter = new PoolSwapTest(manager);
        lpRouter = new PoolModifyLiquidityTest(manager);

        Zolt impl = new Zolt(manager, BASE_FEE, LOOKAHEAD, WINDOW);
        address flagged = address(
            uint160(uint256(keccak256("zolt")) & ~uint256(Hooks.ALL_HOOK_MASK))
                | Hooks.BEFORE_INITIALIZE_FLAG | Hooks.AFTER_INITIALIZE_FLAG | Hooks.BEFORE_SWAP_FLAG
        );
        vm.etch(flagged, address(impl).code);
        hook = Zolt(flagged);

        stock = new MockStockToken("Test Stock", "TSTK");
        quote = new MockERC20("Test Dollar", "TUSD", 18);
        _fund(address(stock));
        _fund(address(quote));

        bare = _key(address(stock), address(quote), 3000, IHooks(address(0)));
        guarded = _key(address(stock), address(quote), LPFeeLibrary.DYNAMIC_FEE_FLAG, IHooks(address(hook)));
        _open(bare);
        _open(guarded);
    }

    // ------------------------------------------------------------------ the problem, and the fix

    function test_bareUnguardedPoolIsDrainedAtA4xStep() public {
        stock.scheduleMultiplier(4e18, block.timestamp + 10 minutes);
        vm.warp(block.timestamp + 11 minutes);
        int256 taken = _buyStockTaken(bare, 1_000e18, 4e18);
        // bought at ~100, worth 400 after the step
        assertGt(taken, 2_500e18, "a bare pool gives away most of the step");
    }

    function test_guardedPoolChargesThe4xStep() public {
        stock.scheduleMultiplier(4e18, block.timestamp + 10 minutes);
        vm.warp(block.timestamp + 11 minutes);
        int256 taken = _buyStockTaken(guarded, 1_000e18, 4e18);
        assertLe(taken, 0, "nothing is taken from the guarded pool");
    }

    function test_buyInsideTheLookaheadIsGuardedToo() public {
        stock.scheduleMultiplier(4e18, block.timestamp + 10 minutes);
        // still before effectiveAt: the token reports 1x, the schedule says 4x
        assertEq(stock.uiMultiplier(), 1e18);
        int256 takenBare = _buyStockTaken(bare, 1_000e18, 4e18);
        int256 takenGuarded = _buyStockTaken(guarded, 1_000e18, 4e18);
        assertGt(takenBare, 2_500e18, "positioning before the step pays on a bare pool");
        assertLe(takenGuarded, 0, "positioning before the step pays nothing on a guarded pool");
    }

    function test_scheduleBeyondTheLookaheadIsNotPricedYet() public {
        stock.scheduleMultiplier(2e18, block.timestamp + 3 days);
        (uint24 fee, bool priced) = hook.quoteFee(guarded, _buyStockZeroForOne(guarded));
        assertEq(fee, BASE_FEE);
        assertFalse(priced);
    }

    function test_sellsPayTheBaseFeeDuringAStepUp() public {
        stock.scheduleMultiplier(4e18, block.timestamp + 1 minutes);
        vm.warp(block.timestamp + 2 minutes);
        bool sell = !_buyStockZeroForOne(guarded);
        (uint24 fee, bool priced) = hook.quoteFee(guarded, sell);
        assertTrue(priced);
        assertEq(fee, BASE_FEE, "the side that loses to a stale price is not charged extra");
    }

    function test_reverseStepProtectsSells() public {
        stock.scheduleMultiplier(0.5e18, block.timestamp + 1 minutes);
        vm.warp(block.timestamp + 2 minutes);
        int256 takenBare = _sellStockTaken(bare, 10e18, 0.5e18);
        int256 takenGuarded = _sellStockTaken(guarded, 10e18, 0.5e18);
        assertGt(takenBare, 400e18, "selling into a stale price after a reverse split pays on a bare pool");
        assertLe(takenGuarded, 0, "and pays nothing on a guarded pool");
    }

    function test_twoStepsBeforeThePoolCatchesUpCompose() public {
        // absolute times: under via-IR, block.timestamp read after vm.warp can be the cached pre-warp value
        uint256 t0 = block.timestamp;
        stock.scheduleMultiplier(2e18, t0 + 1 minutes);
        vm.warp(t0 + 2 minutes);
        bool sell = !_buyStockZeroForOne(guarded);
        _swap(guarded, sell, 1e15); // a tiny trade arms the first step
        stock.scheduleMultiplier(4e18, t0 + 3 minutes); // 2x again, before any buyer reprices
        vm.warp(t0 + 4 minutes);
        int256 takenBare = _buyStockTaken(bare, 1_000e18, 4e18);
        int256 takenGuarded = _buyStockTaken(guarded, 1_000e18, 4e18);
        assertGt(takenBare, 2_500e18, "two steps stack on a bare pool");
        assertLe(takenGuarded, 0, "and stack in the guard's target");
    }

    /// The issuer schedules a step, the guard arms on it, then the issuer cancels before effectiveAt.
    /// Buyers must go back to the base fee: they must not pay for a step that will not happen.
    function test_cancelledScheduleDisarmsTheGuard() public {
        uint256 t0 = block.timestamp;
        stock.scheduleMultiplier(2e18, t0 + 10 minutes);
        bool buy = _buyStockZeroForOne(guarded);
        _swap(guarded, !buy, 1e15); // arms on the scheduled 2x
        (uint24 armedFee, bool armedPriced) = hook.quoteFee(guarded, buy);
        assertTrue(armedPriced);
        assertGt(armedFee, 400_000, "about 50% while the 2x is scheduled");
        stock.cancelSchedule();
        (uint24 fee,) = hook.quoteFee(guarded, buy);
        assertEq(fee, BASE_FEE, "cancelled: back to the base fee");
        int256 takenGuarded = _buyStockTaken(guarded, 100e18, 1e18);
        assertGt(takenGuarded, -1e18, "a buyer after the cancel pays about the base fee, not the step");
    }

    // ------------------------------------------------------------------ the guard ends

    function test_guardClearsOnceBuyersRepriceThePool() public {
        stock.scheduleMultiplier(1.02e18, block.timestamp + 1 minutes);
        vm.warp(block.timestamp + 2 minutes);
        bool buy = _buyStockZeroForOne(guarded);
        for (uint256 i = 0; i < 40; i++) {
            _swap(guarded, buy, 2_000e18);
            (,,, bool armed,,,,,) = hook.guards(guarded.toId());
            if (!armed) break;
        }
        (,,, bool stillArmed,,,,,) = hook.guards(guarded.toId());
        assertFalse(stillArmed, "organic buys at the fair price close the gap and the guard clears");
        (uint24 fee,) = hook.quoteFee(guarded, buy);
        assertEq(fee, BASE_FEE);
    }

    function test_guardWindowEnds() public {
        uint256 t0 = block.timestamp;
        stock.scheduleMultiplier(2e18, t0 + 1 minutes);
        vm.warp(t0 + 2 minutes);
        bool buy = _buyStockZeroForOne(guarded);
        _swap(guarded, !buy, 1e18); // any swap arms the guard
        (,,, bool armed,,,,,) = hook.guards(guarded.toId());
        assertTrue(armed);
        vm.warp(t0 + 2 minutes + WINDOW + 1);
        vm.expectEmit(true, false, false, true, address(hook));
        emit Zolt.StepCleared(guarded.toId(), 2); // 2 = window ended, not repriced
        _swap(guarded, !buy, 1e18);
        (,,, bool after_,,,,,) = hook.guards(guarded.toId());
        assertFalse(after_, "a guard does not hold a pool forever");
    }

    // ------------------------------------------------------------------ edges

    function test_twoStocksSteppingTogetherLeaveThePriceAlone() public {
        MockStockToken other = new MockStockToken("Other Stock", "OSTK");
        _fund(address(other));
        PoolKey memory pair = _key(address(stock), address(other), LPFeeLibrary.DYNAMIC_FEE_FLAG, IHooks(address(hook)));
        manager.initialize(pair, TickMath.getSqrtPriceAtTick(0));
        _addLiquidity(pair);
        stock.scheduleMultiplier(2e18, block.timestamp + 1 minutes);
        other.scheduleMultiplier(2e18, block.timestamp + 1 minutes);
        vm.warp(block.timestamp + 2 minutes);
        (uint24 f0,) = hook.quoteFee(pair, true);
        (uint24 f1,) = hook.quoteFee(pair, false);
        assertEq(f0, BASE_FEE);
        assertEq(f1, BASE_FEE);
    }

    function test_tokenThatStopsAnsweringFailsOpen() public {
        stock.setAnswers(false);
        bool buy = _buyStockZeroForOne(guarded);
        _swap(guarded, buy, 10e18); // does not revert
        (uint24 fee, bool priced) = hook.quoteFee(guarded, buy);
        assertEq(fee, BASE_FEE);
        assertFalse(priced);
    }

    function test_rejectsStaticFeePools() public {
        PoolKey memory k = _key(address(stock), address(quote), 3000, IHooks(address(hook)));
        k.tickSpacing = 10;
        vm.expectRevert();
        manager.initialize(k, TickMath.getSqrtPriceAtTick(0));
    }

    function test_rejectsPoolsWithoutAStockToken() public {
        MockERC20 a = new MockERC20("A", "A", 18);
        MockERC20 b = new MockERC20("B", "B", 18);
        PoolKey memory k = _key(address(a), address(b), LPFeeLibrary.DYNAMIC_FEE_FLAG, IHooks(address(hook)));
        vm.expectRevert();
        manager.initialize(k, TickMath.getSqrtPriceAtTick(0));
    }

    function test_onlyThePoolManagerCanCallTheHook() public {
        vm.expectRevert(Zolt.NotPoolManager.selector);
        hook.beforeSwap(address(this), guarded, SwapParams(true, -1, 0), "");
    }

    // ------------------------------------------------------------------ across step sizes

    /// Steps from 0.5% up to 5x, trades from 10 to 5,000 quote: a guarded pool never gives value away, and a
    /// bare pool always gives away more than the guarded one. (A large trade on a small step can lose money on
    /// a bare pool too, through price impact; that is not what this test claims.)
    function testFuzz_nothingTakenAcrossStepSizes(uint256 ratioBps, uint256 spend) public {
        ratioBps = bound(ratioBps, 10_050, 50_000); // 1.005x .. 5x
        spend = bound(spend, 10e18, 5_000e18);
        uint256 ratio = ratioBps * 1e14;
        stock.scheduleMultiplier(ratio, block.timestamp + 5 minutes);
        vm.warp(block.timestamp + 6 minutes);
        int256 takenBare = _buyStockTaken(bare, spend, ratio);
        int256 takenGuarded = _buyStockTaken(guarded, spend, ratio);
        assertLe(takenGuarded, 0, "guarded");
        assertGt(takenBare, takenGuarded, "bare gives away more");
    }

    // ------------------------------------------------------------------ helpers

    function _key(address a, address b, uint24 fee, IHooks hooks) internal pure returns (PoolKey memory) {
        (address c0, address c1) = a < b ? (a, b) : (b, a);
        return PoolKey({
            currency0: Currency.wrap(c0),
            currency1: Currency.wrap(c1),
            fee: fee,
            tickSpacing: SPACING,
            hooks: hooks
        });
    }

    function _stockIsToken0(PoolKey memory k) internal view returns (bool) {
        return Currency.unwrap(k.currency0) == address(stock);
    }

    /// Buying the stock means receiving it: oneForZero if the stock is token0.
    function _buyStockZeroForOne(PoolKey memory k) internal view returns (bool) {
        return !_stockIsToken0(k);
    }

    function _open(PoolKey memory k) internal {
        // price = token1 per token0
        uint160 sqrtP = _stockIsToken0(k)
            ? uint160(10 * 2 ** 96) // 100 quote per stock
            : uint160(uint256(2 ** 96) / 10); // 0.01 stock per quote
        manager.initialize(k, sqrtP);
        _addLiquidity(k);
    }

    function _addLiquidity(PoolKey memory k) internal {
        lpRouter.modifyLiquidity(
            k, ModifyLiquidityParams({tickLower: MIN_TICK, tickUpper: MAX_TICK, liquidityDelta: int256(LIQUIDITY), salt: 0}), ""
        );
    }

    function _fund(address token) internal {
        MockERC20(token).mint(address(this), 1e30);
        MockERC20(token).approve(address(swapRouter), type(uint256).max);
        MockERC20(token).approve(address(lpRouter), type(uint256).max);
    }

    function _swap(PoolKey memory k, bool zeroForOne, uint256 amountIn) internal returns (BalanceDelta) {
        return swapRouter.swap(
            k,
            SwapParams({
                zeroForOne: zeroForOne,
                amountSpecified: -int256(amountIn),
                sqrtPriceLimitX96: zeroForOne ? TickMath.MIN_SQRT_PRICE + 1 : TickMath.MAX_SQRT_PRICE - 1
            }),
            PoolSwapTest.TestSettings({takeClaims: false, settleUsingBurn: false}),
            ""
        );
    }

    /// Spend `quoteIn` on the stock; return the post-step value received minus what was paid, in quote.
    function _buyStockTaken(PoolKey memory k, uint256 quoteIn, uint256 ratio) internal returns (int256) {
        BalanceDelta d = _swap(k, _buyStockZeroForOne(k), quoteIn);
        (int128 s, int128 q) = _stockIsToken0(k) ? (d.amount0(), d.amount1()) : (d.amount1(), d.amount0());
        uint256 got = uint256(int256(s));
        uint256 paid = uint256(-int256(q));
        uint256 fairValue = got * PRICE * ratio / ONE;
        return int256(fairValue) - int256(paid);
    }

    /// Sell `stockIn`; return what was received minus the post-step value given up, in quote.
    function _sellStockTaken(PoolKey memory k, uint256 stockIn, uint256 ratio) internal returns (int256) {
        BalanceDelta d = _swap(k, !_buyStockZeroForOne(k), stockIn);
        (int128 s, int128 q) = _stockIsToken0(k) ? (d.amount0(), d.amount1()) : (d.amount1(), d.amount0());
        uint256 gave = uint256(-int256(s));
        uint256 got = uint256(int256(q));
        uint256 fairValue = gave * PRICE * ratio / ONE;
        return int256(got) - int256(fairValue);
    }
}
