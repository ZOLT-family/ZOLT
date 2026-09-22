// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {IHooks} from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {PoolId, PoolIdLibrary} from "@uniswap/v4-core/src/types/PoolId.sol";
import {BalanceDelta} from "@uniswap/v4-core/src/types/BalanceDelta.sol";
import {SwapParams} from "@uniswap/v4-core/src/types/PoolOperation.sol";

import {StepguardDopplerModule} from "../StepguardDopplerModule.sol";

/// @notice Test stand-in for Doppler's DopplerHookInitializer, reduced to the surface a Doppler Hook sees:
///   - it is the pool's v4 hook and, after every swap, calls the attached module's onSwap
///     (DopplerHookInitializer._afterSwap, lines 528-560 of the verified source on chain 4663)
///   - it lets only the attached module set the pool's dynamic LP fee
///     (DopplerHookInitializer.updateDynamicLPFee, lines 425-431)
///   - it caps the fee at 10%, as DopplerHookInitializer does (MAX_LP_FEE = 100_000, line 171)
/// It does not model Doppler's curve, airlock, governance, timelock or graduation.
contract MockDopplerInitializer {
    using PoolIdLibrary for PoolKey;

    IPoolManager public immutable poolManager;

    struct State {
        PoolKey key;
        address module;
    }

    mapping(address asset => State) internal states;
    mapping(PoolId => address asset) public assetOf;

    constructor(IPoolManager _poolManager) {
        poolManager = _poolManager;
    }

    /// Attach a module to an already-initialized pool, as setDopplerHook does.
    function attach(address asset, PoolKey calldata key, address module, bytes calldata initData) external {
        states[asset] = State({key: key, module: module});
        assetOf[key.toId()] = asset;
        StepguardDopplerModule(module).onInitialization(asset, key, initData);
    }

    /// Same cap as DopplerHookInitializer: MAX_LP_FEE = 100_000 (10%), `require(lpFee <= MAX_LP_FEE)`.
    uint24 public constant MAX_LP_FEE = 100_000;
    bool public rejectUpdates; // test switch: make every fee update revert

    function setRejectUpdates(bool r) external {
        rejectUpdates = r;
    }

    function updateDynamicLPFee(address asset, uint24 lpFee) external {
        State memory s = states[asset];
        require(msg.sender == s.module, "not the module");
        require(!rejectUpdates, "rejected");
        require(lpFee <= MAX_LP_FEE, "LPFeeTooHigh");
        poolManager.updateDynamicLPFee(s.key, lpFee);
    }

    // v4 hook entry point (AFTER_SWAP permission only)
    function afterSwap(address sender, PoolKey calldata key, SwapParams calldata params, BalanceDelta delta, bytes calldata data)
        external
        returns (bytes4, int128)
    {
        require(msg.sender == address(poolManager), "not the pool manager");
        address module = states[assetOf[key.toId()]].module;
        if (module != address(0)) {
            StepguardDopplerModule(module).onSwap(sender, key, params, delta, data);
        }
        return (IHooks.afterSwap.selector, 0);
    }
}
