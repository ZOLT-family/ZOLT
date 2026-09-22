// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {StateLibrary} from "@uniswap/v4-core/src/libraries/StateLibrary.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {PoolId, PoolIdLibrary} from "@uniswap/v4-core/src/types/PoolId.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {BalanceDelta} from "@uniswap/v4-core/src/types/BalanceDelta.sol";
import {SwapParams} from "@uniswap/v4-core/src/types/PoolOperation.sol";

import {StepMath} from "./StepMath.sol";

/// @notice The part of Doppler's DopplerHookInitializer this module calls. On Robinhood Chain 4663 the
/// initializer is 0x4e3468951d49f2eea976ed0d6e75ffcb44a9a544 (Sourcify match, read 2026-09-21); it is the hook
/// on 20,300 of the 30,862 v4 pools that hold a stock token whose multiplier has stepped.
interface IDopplerInitializerFees {
    function updateDynamicLPFee(address asset, uint24 lpFee) external;
}

/// @title ZoltDopplerModule
/// @notice The Zolt logic packaged as a Doppler Hook: a module that Doppler's DopplerHookInitializer calls
/// after every swap (`onSwap`) on the pools it is attached to, and that may set the pool's dynamic LP fee.
///
/// Differences from the Zolt hook, all forced by the Doppler module interface:
///   - It runs after a swap, not before, so it sets the fee for the next swap. Anyone can call `poke` when a
///     schedule is posted to set the fee before the first trade.
///   - The fee it sets applies to both directions. While a step is priced in, the side that would lose to a
///     stale price pays the step fee too.
///   - Doppler caps a module-set LP fee at 100_000 (10%): `MAX_LP_FEE` in the verified DopplerHookInitializer
///     source, enforced by `updateDynamicLPFee`. A step larger than that gap is only partly priced in.
///   - Attaching it needs Doppler governance to enable the module (`setDopplerHookState`) and the asset's
///     timelock or delegated authority to attach it (`setDopplerHook`), and a pool holds one module at a time.
///     Measured on chain 4663 on 2026-09-22: 20,279 of the 20,300 Doppler pools holding a stepped stock token
///     have a timelock of 0x0 or 0x…dEaD with no delegated authority, so their module slot can never change.
///     In practice this module is for new launches whose creator selects it, not for existing pools.
///
/// Safety rule: this contract never reverts inside onSwap. A revert there would revert every swap in the pool.
///
/// @dev PROTOTYPE. Unaudited, undeployed. Tested against a stand-in initializer with the same callback and
/// fee-update surface (including the 10% cap), not against Doppler's own contracts.
contract ZoltDopplerModule {
    using PoolIdLibrary for PoolKey;
    using StateLibrary for IPoolManager;

    uint256 internal constant ONE = StepMath.ONE;
    /// @notice Largest LP fee DopplerHookInitializer.updateDynamicLPFee accepts (MAX_LP_FEE in its source).
    uint24 public constant DOPPLER_MAX_LP_FEE = 100_000;

    address public immutable INITIALIZER;
    IPoolManager public immutable poolManager;
    uint24 public immutable defaultBaseFee;
    uint256 public immutable lookahead;
    uint256 public immutable guardWindow;

    struct Guard {
        bool registered;
        bool stock0;
        bool stock1;
        bool armed;
        bool protectZeroForOne;
        uint24 baseFee;
        uint24 feeSet; // last fee this module asked the initializer for
        uint40 armedAt;
        uint256 m0;
        uint256 m1;
        uint256 targetSqrtPriceX96;
        PoolKey key;
    }

    mapping(address asset => Guard) internal guards;

    /// Keepers index this to know which assets to poke when a stock token posts a schedule.
    event PoolRegistered(
        address indexed asset, address indexed currency0, address indexed currency1, bool stock0, bool stock1, uint24 baseFee
    );
    event StepArmed(address indexed asset, uint256 multiplier0To, uint256 multiplier1To, uint256 targetSqrtPriceX96);
    /// @param fee the fee set; @param gapFee the fee the step gap called for (larger than `fee` when capped)
    event StepFeeSet(address indexed asset, uint24 fee, uint24 gapFee);
    event StepCleared(address indexed asset, uint8 reason);
    event FeeUpdateFailed(address indexed asset, uint24 fee);

    error SenderNotInitializer();
    error NoStockToken();
    error NotRegistered();

    constructor(address initializer, IPoolManager _poolManager, uint24 _defaultBaseFee, uint256 _lookahead, uint256 _guardWindow) {
        INITIALIZER = initializer;
        poolManager = _poolManager;
        defaultBaseFee = _defaultBaseFee;
        lookahead = _lookahead;
        guardWindow = _guardWindow;
    }

    modifier onlyInitializer() {
        if (msg.sender != INITIALIZER) revert SenderNotInitializer();
        _;
    }

    // ------------------------------------------------------------------ Doppler Hook callbacks

    /// @param data abi.encode(uint24 baseFee): the fee the pool charges outside a step. Empty = defaultBaseFee.
    function onInitialization(address asset, PoolKey calldata key, bytes calldata data) external onlyInitializer {
        (bool s0, uint256 m0) = StepMath.current(Currency.unwrap(key.currency0));
        (bool s1, uint256 m1) = StepMath.current(Currency.unwrap(key.currency1));
        if (!s0 && !s1) revert NoStockToken();
        uint24 base = data.length >= 32 ? abi.decode(data, (uint24)) : defaultBaseFee;
        if (base > DOPPLER_MAX_LP_FEE) base = DOPPLER_MAX_LP_FEE;
        Guard storage g = guards[asset];
        g.registered = true;
        g.stock0 = s0;
        g.stock1 = s1;
        g.armed = false;
        g.baseFee = base;
        g.feeSet = base;
        g.m0 = s0 ? m0 : ONE;
        g.m1 = s1 ? m1 : ONE;
        g.key = key;
        IDopplerInitializerFees(INITIALIZER).updateDynamicLPFee(asset, base);
        emit PoolRegistered(asset, Currency.unwrap(key.currency0), Currency.unwrap(key.currency1), s0, s1, base);
    }

    function onSwap(address, PoolKey calldata key, SwapParams calldata, BalanceDelta, bytes calldata)
        external
        onlyInitializer
        returns (Currency, int128)
    {
        address asset = _assetOf(key);
        if (asset != address(0)) _update(asset); // never revert here: that would revert the swap
        return (key.currency0, 0); // the module takes nothing from the swap
    }

    function onGraduation(address, PoolKey calldata, bytes calldata) external onlyInitializer {}

    // ------------------------------------------------------------------ keeper entry point

    /// @notice Anyone may call this after a schedule is posted, so the step fee is in place before the first
    /// trade rather than after it.
    function poke(address asset) external {
        if (!guards[asset].registered) revert NotRegistered();
        _update(asset);
    }

    function feeFor(address asset) external view returns (uint24 fee, bool armed) {
        Guard storage g = guards[asset];
        return (g.feeSet, g.armed);
    }

    // ------------------------------------------------------------------ internals

    // Doppler passes the pool key; the asset is recovered from the registration made at onInitialization.
    mapping(bytes32 poolId => address asset) internal assetOf;

    function _assetOf(PoolKey calldata key) internal returns (address asset) {
        bytes32 id = bytes32(PoolId.unwrap(key.toId()));
        asset = assetOf[id];
        if (asset == address(0)) {
            // first swap after registration: find it by currency (a Doppler asset is one side of its pool)
            address c0 = Currency.unwrap(key.currency0);
            address c1 = Currency.unwrap(key.currency1);
            if (guards[c0].registered) asset = c0;
            else if (guards[c1].registered) asset = c1;
            else return address(0); // attached without onInitialization: stay inert
            assetOf[id] = asset;
        }
    }

    function _update(address asset) internal {
        Guard storage g = guards[asset];
        (uint160 sqrtPriceX96,,,) = poolManager.getSlot0(g.key.toId());

        uint256 e0 = g.stock0 ? StepMath.expected(Currency.unwrap(g.key.currency0), g.m0, lookahead) : ONE;
        uint256 e1 = g.stock1 ? StepMath.expected(Currency.unwrap(g.key.currency1), g.m1, lookahead) : ONE;
        if (e0 != g.m0 || e1 != g.m1) {
            uint256 from = g.armed ? g.targetSqrtPriceX96 : sqrtPriceX96;
            uint256 t = StepMath.target(from, g.m0, e0, g.m1, e1);
            g.m0 = e0;
            g.m1 = e1;
            g.targetSqrtPriceX96 = t;
            g.armed = true;
            g.armedAt = uint40(block.timestamp);
            (g.protectZeroForOne,) = StepMath.fee(sqrtPriceX96, t);
            emit StepArmed(asset, e0, e1, t);
        }

        uint24 want = g.baseFee;
        uint24 gap = 0;
        if (g.armed) {
            if (block.timestamp > uint256(g.armedAt) + guardWindow) {
                g.armed = false;
                emit StepCleared(asset, 2);
            } else {
                (bool protect, uint24 stepFee) = StepMath.fee(sqrtPriceX96, g.targetSqrtPriceX96);
                if (stepFee <= g.baseFee || protect != g.protectZeroForOne) {
                    g.armed = false;
                    emit StepCleared(asset, 1);
                } else {
                    gap = stepFee;
                    want = stepFee > DOPPLER_MAX_LP_FEE ? DOPPLER_MAX_LP_FEE : stepFee;
                }
            }
        }
        if (want != g.feeSet) {
            try IDopplerInitializerFees(INITIALIZER).updateDynamicLPFee(asset, want) {
                g.feeSet = want;
                emit StepFeeSet(asset, want, gap);
            } catch {
                emit FeeUpdateFailed(asset, want);
            }
        }
    }
}
