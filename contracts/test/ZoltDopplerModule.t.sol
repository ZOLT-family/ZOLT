// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";

import {PoolManager} from "@uniswap/v4-core/src/PoolManager.sol";
import {IHooks} from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import {Hooks} from "@uniswap/v4-core/src/libraries/Hooks.sol";
import {LPFeeLibrary} from "@uniswap/v4-core/src/libraries/LPFeeLibrary.sol";
import {TickMath} from "@uniswap/v4-core/src/libraries/TickMath.sol";
import {StateLibrary} from "@uniswap/v4-core/src/libraries/StateLibrary.sol";
import {PoolSwapTest} from "@uniswap/v4-core/src/test/PoolSwapTest.sol";
import {PoolModifyLiquidityTest} from "@uniswap/v4-core/src/test/PoolModifyLiquidityTest.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {PoolIdLibrary} from "@uniswap/v4-core/src/types/PoolId.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {BalanceDelta} from "@uniswap/v4-core/src/types/BalanceDelta.sol";
import {ModifyLiquidityParams, SwapParams} from "@uniswap/v4-core/src/types/PoolOperation.sol";

import {ZoltDopplerModule} from "../src/ZoltDopplerModule.sol";
import {MockDopplerInitializer} from "../src/mocks/MockDopplerInitializer.sol";
import {MockERC20} from "../src/mocks/MockERC20.sol";
import {MockStockToken} from "../src/mocks/MockStockToken.sol";

/// The module sits behind a stand-in for Doppler's initializer (see MockDopplerInitializer). Same comparison as
/// the hook tests: a bare pool (0.30% static fee, no hook) against a Doppler-style pool with the module attached
/// (0.30% base fee), both opened at 100 quote per stock with the same liquidity.
contract ZoltDopplerModuleTest is Test {
    using PoolIdLibrary for PoolKey;
    using StateLibrary for PoolManager;

    uint24 constant BASE_FEE = 3000;
    uint256 constant LOOKAHEAD = 2 hours;
    uint256 constant WINDOW = 24 hours;
    int24 constant SPACING = 60;
    uint256 constant PRICE = 100;
    uint256 constant ONE = 1e18;

    PoolManager manager;
    PoolSwapTest swapRouter;
    PoolModifyLiquidityTest lpRouter;
    MockDopplerInitializer initializer;
    ZoltDopplerModule module;
    MockStockToken stock;
    MockERC20 quote;
    PoolKey bare;
    PoolKey doppler;

    function setUp() public {
        vm.warp(1_790_000_000);
        manager = new PoolManager(address(this));
        swapRouter = new PoolSwapTest(manager);
        lpRouter = new PoolModifyLiquidityTest(manager);

        MockDopplerInitializer impl = new MockDopplerInitializer(manager);
        address flagged = address(
            uint160(uint256(keccak256("doppler-initializer")) & ~uint256(Hooks.ALL_HOOK_MASK)) | Hooks.AFTER_SWAP_FLAG
        );
        vm.etch(flagged, address(impl).code);
        initializer = MockDopplerInitializer(flagged);
        module = new ZoltDopplerModule(flagged, manager, BASE_FEE, LOOKAHEAD, WINDOW);

        stock = new MockStockToken("Test Stock", "TSTK");
        quote = new MockERC20("Test Dollar", "TUSD", 18);
        _fund(address(stock));
        _fund(address(quote));

        bare = _key(3000, IHooks(address(0)));
        doppler = _key(LPFeeLibrary.DYNAMIC_FEE_FLAG, IHooks(flagged));
        _open(bare);
        _open(doppler);
        initializer.attach(address(stock), doppler, address(module), abi.encode(uint24(BASE_FEE)));
    }

    function test_attachSetsTheBaseFee() public view {
        (,,, uint24 lpFee) = manager.getSlot0(doppler.toId());
        assertEq(lpFee, BASE_FEE);
    }

    /// A step inside Doppler's 10% fee cap (+5%): poked when the schedule is posted, nothing is taken.
    function test_pokedWhenTheScheduleIsPostedNothingIsTaken() public {
        stock.scheduleMultiplier(1.05e18, block.timestamp + 10 minutes);
        module.poke(address(stock)); // a keeper reacting to UIMultiplierUpdated
        int256 takenBare = _buyTaken(bare, 100e18, 1.05e18);
        int256 takenGuarded = _buyTaken(doppler, 100e18, 1.05e18);
        assertGt(takenBare, 3e18, "about 5% of 100, less 0.3% fee and impact");
        assertLe(takenGuarded, 0);
    }

    /// The limit of the module form, stated as a test: without a poke, the first trade after the step runs at
    /// the old fee (the module only hears about swaps after they happen). The trade after it is charged.
    function test_withoutAPokeTheFirstTradeGetsThroughAndTheSecondIsCharged() public {
        uint256 t0 = block.timestamp;
        stock.scheduleMultiplier(1.05e18, t0 + 1 minutes);
        vm.warp(t0 + 2 minutes);
        int256 first = _buyTaken(doppler, 100e18, 1.05e18);
        int256 second = _buyTaken(doppler, 100e18, 1.05e18);
        assertGt(first, 0, "first trade after the step still takes");
        assertLe(second, 0, "the module has set the step fee for everyone after it");
    }

    /// Doppler caps a module's fee at 10%. A x4 split needs 75%: the module charges 10%, so it only takes the
    /// edge off. Stated as a test so nobody reads the module as split-proof.
    function test_bigSplitIsOnlyPartlyPricedUnderDopplersTenPercentCap() public {
        stock.scheduleMultiplier(4e18, block.timestamp + 10 minutes);
        module.poke(address(stock));
        (,,, uint24 lpFee) = manager.getSlot0(doppler.toId());
        assertEq(lpFee, 100_000, "capped at Doppler's MAX_LP_FEE");
        int256 takenBare = _buyTaken(bare, 1_000e18, 4e18);
        int256 takenGuarded = _buyTaken(doppler, 1_000e18, 4e18);
        assertGt(takenGuarded, 2_000e18, "most of a x4 still gets through the cap");
        assertLt(takenGuarded, takenBare, "but less than on a bare pool");
    }

    function test_whileArmedTheFeeAppliesToBothDirections() public {
        stock.scheduleMultiplier(1.05e18, block.timestamp + 10 minutes);
        module.poke(address(stock));
        (,,, uint24 lpFee) = manager.getSlot0(doppler.toId());
        assertGt(lpFee, 40_000, "about 1 - 1/1.05 = 4.8%");
        // the pool has one LP fee: a seller pays it too. Documented, not hidden.
    }

    /// Safety rule: a failing fee update must not revert the swap that triggered it.
    function test_aFailingFeeUpdateNeverBlocksSwaps() public {
        uint256 t0 = block.timestamp;
        stock.scheduleMultiplier(1.05e18, t0 + 1 minutes);
        vm.warp(t0 + 2 minutes);
        initializer.setRejectUpdates(true);
        _swap(doppler, _buyZeroForOne(doppler), 10e18); // would revert if the module propagated the failure
        _swap(doppler, !_buyZeroForOne(doppler), 1e18);
        (uint24 fee,) = module.feeFor(address(stock));
        assertEq(fee, BASE_FEE, "the module keeps the fee it last managed to set");
    }

    function test_feeReturnsToBaseOnceBuyersReprice() public {
        uint256 t0 = block.timestamp;
        stock.scheduleMultiplier(1.02e18, t0 + 1 minutes);
        vm.warp(t0 + 2 minutes);
        module.poke(address(stock));
        bool buy = _buyZeroForOne(doppler);
        for (uint256 i = 0; i < 40; i++) {
            _swap(doppler, buy, 2_000e18);
            (, bool armed) = module.feeFor(address(stock));
            if (!armed) break;
        }
        (uint24 fee, bool stillArmed) = module.feeFor(address(stock));
        assertFalse(stillArmed);
        assertEq(fee, BASE_FEE);
        (,,, uint24 lpFee) = manager.getSlot0(doppler.toId());
        assertEq(lpFee, BASE_FEE);
    }

    function test_onlyTheInitializerCanCallTheCallbacks() public {
        vm.expectRevert(ZoltDopplerModule.SenderNotInitializer.selector);
        module.onInitialization(address(stock), doppler, "");
        vm.expectRevert(ZoltDopplerModule.SenderNotInitializer.selector);
        module.onSwap(address(this), doppler, SwapParams(true, -1, 0), BalanceDelta.wrap(0), "");
    }

    function test_pokeRejectsUnknownAssets() public {
        vm.expectRevert(ZoltDopplerModule.NotRegistered.selector);
        module.poke(address(quote));
    }

    // ------------------------------------------------------------------ helpers

    function _key(uint24 fee, IHooks hooks) internal view returns (PoolKey memory) {
        (address c0, address c1) = address(stock) < address(quote) ? (address(stock), address(quote)) : (address(quote), address(stock));
        return PoolKey({currency0: Currency.wrap(c0), currency1: Currency.wrap(c1), fee: fee, tickSpacing: SPACING, hooks: hooks});
    }

    function _stockIsToken0(PoolKey memory k) internal view returns (bool) {
        return Currency.unwrap(k.currency0) == address(stock);
    }

    function _buyZeroForOne(PoolKey memory k) internal view returns (bool) {
        return !_stockIsToken0(k);
    }

    function _open(PoolKey memory k) internal {
        uint160 sqrtP = _stockIsToken0(k) ? uint160(10 * 2 ** 96) : uint160(uint256(2 ** 96) / 10);
        manager.initialize(k, sqrtP);
        lpRouter.modifyLiquidity(k, ModifyLiquidityParams({tickLower: -887220, tickUpper: 887220, liquidityDelta: 1e22, salt: 0}), "");
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

    function _buyTaken(PoolKey memory k, uint256 quoteIn, uint256 ratio) internal returns (int256) {
        BalanceDelta d = _swap(k, _buyZeroForOne(k), quoteIn);
        (int128 s, int128 q) = _stockIsToken0(k) ? (d.amount0(), d.amount1()) : (d.amount1(), d.amount0());
        return int256(uint256(int256(s)) * PRICE * ratio / ONE) - int256(uint256(-int256(q)));
    }
}
