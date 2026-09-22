// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IHooks} from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {Hooks} from "@uniswap/v4-core/src/libraries/Hooks.sol";
import {LPFeeLibrary} from "@uniswap/v4-core/src/libraries/LPFeeLibrary.sol";
import {StateLibrary} from "@uniswap/v4-core/src/libraries/StateLibrary.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {PoolId, PoolIdLibrary} from "@uniswap/v4-core/src/types/PoolId.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {BalanceDelta} from "@uniswap/v4-core/src/types/BalanceDelta.sol";
import {BeforeSwapDelta, BeforeSwapDeltaLibrary} from "@uniswap/v4-core/src/types/BeforeSwapDelta.sol";
import {ModifyLiquidityParams, SwapParams} from "@uniswap/v4-core/src/types/PoolOperation.sol";

import {StepMath} from "./StepMath.sol";

/// @title Stepguard
/// @notice A Uniswap v4 hook for pools that hold an ERC-8056 stock token.
///
/// A stock token's multiplier (how many shares one token stands for) steps on a schedule that is readable
/// on chain before it takes effect. The pool does not know: it keeps pricing the token at the old share
/// count, so the first buyer after a step up (or the first seller after a step down) takes the difference
/// out of the LPs.
///
/// Stepguard reads the same schedule. When the multiplier the pool's price reflects is about to change, or
/// has changed, it records the price the step implies and charges any swap in the profitable direction a
/// fee equal to the gap between the pool price and that target. The fee goes to the LPs. Swaps in the other
/// direction pay the base fee. The guard clears once the pool trades within the base fee of the target or
/// crosses it, or when the guard window ends.
///
/// @dev PROTOTYPE. Unaudited, undeployed. Known limits are listed in README.md. The hook address must carry
/// exactly the BEFORE_INITIALIZE, AFTER_INITIALIZE and BEFORE_SWAP permission bits, and pools must be
/// created with the dynamic fee flag.
contract Stepguard is IHooks {
    using PoolIdLibrary for PoolKey;
    using StateLibrary for IPoolManager;
    using LPFeeLibrary for uint24;

    uint256 internal constant ONE = StepMath.ONE;

    uint8 internal constant CLEARED_REPRICED = 1;
    uint8 internal constant CLEARED_WINDOW = 2;

    IPoolManager public immutable poolManager;
    /// @notice Fee outside a step, in hundredths of a bip (3000 = 0.30%).
    uint24 public immutable baseFee;
    /// @notice How far ahead a scheduled step is priced in, in seconds.
    uint256 public immutable lookahead;
    /// @notice How long a step stays guarded if the pool never trades back to the target, in seconds.
    uint256 public immutable guardWindow;

    struct Guard {
        bool registered;
        bool stock0;
        bool stock1;
        bool armed;
        bool protectZeroForOne; // direction that took value from LPs when the step was armed
        uint40 armedAt;
        uint256 m0; // multiplier currency0's price in this pool currently reflects (1e18 for a non-stock)
        uint256 m1; // same for currency1
        uint256 targetSqrtPriceX96; // pool price the recorded steps imply
    }

    mapping(PoolId => Guard) public guards;

    event PoolRegistered(PoolId indexed id, bool stock0, bool stock1, uint256 multiplier0, uint256 multiplier1);
    event StepArmed(
        PoolId indexed id,
        uint256 multiplier0From,
        uint256 multiplier0To,
        uint256 multiplier1From,
        uint256 multiplier1To,
        uint256 targetSqrtPriceX96
    );
    event StepFeeCharged(PoolId indexed id, bool zeroForOne, uint24 fee);
    event StepCleared(PoolId indexed id, uint8 reason);

    error NotPoolManager();
    error HookNotImplemented();
    error MustUseDynamicFee();
    error NoStockToken();

    constructor(IPoolManager _poolManager, uint24 _baseFee, uint256 _lookahead, uint256 _guardWindow) {
        require(_baseFee <= LPFeeLibrary.MAX_LP_FEE, "base fee");
        poolManager = _poolManager;
        baseFee = _baseFee;
        lookahead = _lookahead;
        guardWindow = _guardWindow;
    }

    modifier onlyPoolManager() {
        if (msg.sender != address(poolManager)) revert NotPoolManager();
        _;
    }

    function getHookPermissions() public pure returns (Hooks.Permissions memory) {
        return Hooks.Permissions({
            beforeInitialize: true,
            afterInitialize: true,
            beforeAddLiquidity: false,
            afterAddLiquidity: false,
            beforeRemoveLiquidity: false,
            afterRemoveLiquidity: false,
            beforeSwap: true,
            afterSwap: false,
            beforeDonate: false,
            afterDonate: false,
            beforeSwapReturnDelta: false,
            afterSwapReturnDelta: false,
            afterAddLiquidityReturnDelta: false,
            afterRemoveLiquidityReturnDelta: false
        });
    }

    // ------------------------------------------------------------------ hooks in use

    function beforeInitialize(address, PoolKey calldata key, uint160) external view onlyPoolManager returns (bytes4) {
        if (!key.fee.isDynamicFee()) revert MustUseDynamicFee();
        return IHooks.beforeInitialize.selector;
    }

    function afterInitialize(address, PoolKey calldata key, uint160, int24) external onlyPoolManager returns (bytes4) {
        (bool s0, uint256 m0) = StepMath.current(Currency.unwrap(key.currency0));
        (bool s1, uint256 m1) = StepMath.current(Currency.unwrap(key.currency1));
        if (!s0 && !s1) revert NoStockToken();
        PoolId id = key.toId();
        guards[id] = Guard({
            registered: true,
            stock0: s0,
            stock1: s1,
            armed: false,
            protectZeroForOne: false,
            armedAt: 0,
            m0: s0 ? m0 : ONE,
            m1: s1 ? m1 : ONE,
            targetSqrtPriceX96: 0
        });
        emit PoolRegistered(id, s0, s1, s0 ? m0 : ONE, s1 ? m1 : ONE);
        return IHooks.afterInitialize.selector;
    }

    function beforeSwap(address, PoolKey calldata key, SwapParams calldata params, bytes calldata)
        external
        onlyPoolManager
        returns (bytes4, BeforeSwapDelta, uint24)
    {
        PoolId id = key.toId();
        Guard storage g = guards[id];
        (uint160 sqrtPriceX96,,,) = poolManager.getSlot0(id);

        uint256 e0 = g.stock0 ? StepMath.expected(Currency.unwrap(key.currency0), g.m0, lookahead) : ONE;
        uint256 e1 = g.stock1 ? StepMath.expected(Currency.unwrap(key.currency1), g.m1, lookahead) : ONE;
        if (e0 != g.m0 || e1 != g.m1) {
            uint256 from = g.armed ? g.targetSqrtPriceX96 : sqrtPriceX96;
            uint256 target = StepMath.target(from, g.m0, e0, g.m1, e1);
            emit StepArmed(id, g.m0, e0, g.m1, e1, target);
            g.m0 = e0;
            g.m1 = e1;
            g.targetSqrtPriceX96 = target;
            g.armed = true;
            g.armedAt = uint40(block.timestamp);
            (g.protectZeroForOne,) = StepMath.fee(sqrtPriceX96, target);
        }

        uint24 fee = baseFee;
        if (g.armed) {
            if (block.timestamp > uint256(g.armedAt) + guardWindow) {
                g.armed = false;
                emit StepCleared(id, CLEARED_WINDOW);
            } else {
                (bool protectZeroForOne, uint24 stepFee) = StepMath.fee(sqrtPriceX96, g.targetSqrtPriceX96);
                // Cleared once the pool trades within the base fee of the target, or crosses it: past the
                // target the gap is ordinary market movement, not the step.
                if (stepFee <= baseFee || protectZeroForOne != g.protectZeroForOne) {
                    g.armed = false;
                    emit StepCleared(id, CLEARED_REPRICED);
                } else if (params.zeroForOne == protectZeroForOne) {
                    fee = stepFee;
                    emit StepFeeCharged(id, params.zeroForOne, stepFee);
                }
            }
        }
        return (IHooks.beforeSwap.selector, BeforeSwapDeltaLibrary.ZERO_DELTA, fee | LPFeeLibrary.OVERRIDE_FEE_FLAG);
    }

    // ------------------------------------------------------------------ read side for quoters and frontends

    /// @notice The fee the next swap in a direction would pay, and whether a step is priced in.
    /// @dev Mirrors beforeSwap without writing state. Frontends should show this before a user signs.
    function quoteFee(PoolKey calldata key, bool zeroForOne) external view returns (uint24 fee, bool stepPriced) {
        PoolId id = key.toId();
        Guard memory g = guards[id];
        if (!g.registered) return (baseFee, false);
        (uint160 sqrtPriceX96,,,) = poolManager.getSlot0(id);
        uint256 e0 = g.stock0 ? StepMath.expected(Currency.unwrap(key.currency0), g.m0, lookahead) : ONE;
        uint256 e1 = g.stock1 ? StepMath.expected(Currency.unwrap(key.currency1), g.m1, lookahead) : ONE;
        if (e0 != g.m0 || e1 != g.m1) {
            uint256 from = g.armed ? g.targetSqrtPriceX96 : sqrtPriceX96;
            g.targetSqrtPriceX96 = StepMath.target(from, g.m0, e0, g.m1, e1);
            g.armed = true;
            g.armedAt = uint40(block.timestamp);
            (g.protectZeroForOne,) = StepMath.fee(sqrtPriceX96, g.targetSqrtPriceX96);
        }
        if (!g.armed || block.timestamp > uint256(g.armedAt) + guardWindow) return (baseFee, false);
        (bool protectZeroForOne, uint24 stepFee) = StepMath.fee(sqrtPriceX96, g.targetSqrtPriceX96);
        if (stepFee <= baseFee || protectZeroForOne != g.protectZeroForOne) return (baseFee, false);
        return (zeroForOne == protectZeroForOne ? stepFee : baseFee, true);
    }

    // ------------------------------------------------------------------ hooks not in use

    function beforeAddLiquidity(address, PoolKey calldata, ModifyLiquidityParams calldata, bytes calldata)
        external
        pure
        returns (bytes4)
    {
        revert HookNotImplemented();
    }

    function afterAddLiquidity(
        address,
        PoolKey calldata,
        ModifyLiquidityParams calldata,
        BalanceDelta,
        BalanceDelta,
        bytes calldata
    ) external pure returns (bytes4, BalanceDelta) {
        revert HookNotImplemented();
    }

    function beforeRemoveLiquidity(address, PoolKey calldata, ModifyLiquidityParams calldata, bytes calldata)
        external
        pure
        returns (bytes4)
    {
        revert HookNotImplemented();
    }

    function afterRemoveLiquidity(
        address,
        PoolKey calldata,
        ModifyLiquidityParams calldata,
        BalanceDelta,
        BalanceDelta,
        bytes calldata
    ) external pure returns (bytes4, BalanceDelta) {
        revert HookNotImplemented();
    }

    function afterSwap(address, PoolKey calldata, SwapParams calldata, BalanceDelta, bytes calldata)
        external
        pure
        returns (bytes4, int128)
    {
        revert HookNotImplemented();
    }

    function beforeDonate(address, PoolKey calldata, uint256, uint256, bytes calldata) external pure returns (bytes4) {
        revert HookNotImplemented();
    }

    function afterDonate(address, PoolKey calldata, uint256, uint256, bytes calldata) external pure returns (bytes4) {
        revert HookNotImplemented();
    }
}
