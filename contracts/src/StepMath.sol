// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {FullMath} from "@uniswap/v4-core/src/libraries/FullMath.sol";

/// @notice The read side of ERC-8056 (scaled UI amount), as implemented by the Robinhood Chain stock tokens.
/// Selectors checked live on chain 4663 on 2026-09-21: uiMultiplier 0xa60bf13d, newUIMultiplier 0xdc767007,
/// effectiveAt 0x97a4064f. Before effectiveAt, uiMultiplier() returns the old value and newUIMultiplier()
/// already returns the scheduled one.
interface IERC8056 {
    function uiMultiplier() external view returns (uint256);
    function newUIMultiplier() external view returns (uint256);
    function effectiveAt() external view returns (uint256);
}

/// @title StepMath
/// @notice The arithmetic shared by the Zolt hook and the Zolt Doppler module: read a stock token's
/// multiplier schedule, turn a step into a target pool price, and turn the gap to that target into a fee.
library StepMath {
    uint256 internal constant ONE = 1e18;
    uint24 internal constant MAX_STEP_FEE = 999_999; // v4 caps LP fees at 1_000_000 (100%)

    /// @dev Is this token an ERC-8056 token, and what multiplier does it report now?
    function current(address token) internal view returns (bool isStock, uint256 m) {
        if (token == address(0) || token.code.length == 0) return (false, 0);
        try IERC8056(token).uiMultiplier() returns (uint256 v) {
            if (v == 0) return (false, 0);
            return (true, v);
        } catch {
            return (false, 0);
        }
    }

    /// @dev The multiplier a pool should price: the scheduled one if it takes effect within `lookahead`,
    /// otherwise the active one. If the token stops answering (paused logic, beacon upgrade), keep the last
    /// known value: callers fail open rather than blocking every swap.
    function expected(address token, uint256 last, uint256 lookahead) internal view returns (uint256) {
        IERC8056 t = IERC8056(token);
        uint256 active;
        try t.uiMultiplier() returns (uint256 v) {
            active = v;
        } catch {
            return last;
        }
        if (active == 0) return last;
        try t.newUIMultiplier() returns (uint256 next) {
            if (next == 0 || next == active) return active;
            try t.effectiveAt() returns (uint256 at) {
                if (at > block.timestamp && at - block.timestamp <= lookahead) return next;
            } catch {}
        } catch {}
        return active;
    }

    /// @dev Price is token1 per token0. If token0's share count grows by r0 and token1's by r1, the fair
    /// price grows by r0 / r1, and the sqrt price by sqrt(r0 / r1).
    function target(uint256 fromSqrtPriceX96, uint256 m0From, uint256 m0To, uint256 m1From, uint256 m1To)
        internal
        pure
        returns (uint256)
    {
        uint256 ratio = FullMath.mulDiv(FullMath.mulDiv(m0To, ONE, m0From), m1From, m1To);
        return FullMath.mulDiv(fromSqrtPriceX96, sqrt(ratio * ONE), ONE);
    }

    /// @dev Which direction takes value from LPs at the current price, and the fee that removes it.
    /// If the target is above the pool price, token0 is underpriced: buying token0 (oneForZero) is protected,
    /// and a fee of 1 - P/T makes the buyer pay T. If below, token0 is overpriced: selling token0 (zeroForOne)
    /// is protected with a fee of 1 - T/P. Rounded up: never charge less than the gap.
    function fee(uint256 sqrtPriceX96, uint256 targetSqrtPriceX96)
        internal
        pure
        returns (bool protectZeroForOne, uint24 f)
    {
        uint256 q = FullMath.mulDiv(targetSqrtPriceX96, ONE, sqrtPriceX96);
        uint256 r = FullMath.mulDiv(q, q, ONE); // T / P, 1e18 scale
        uint256 fee18;
        if (r > ONE) {
            protectZeroForOne = false;
            fee18 = ONE - FullMath.mulDiv(ONE, ONE, r);
        } else {
            protectZeroForOne = true;
            fee18 = ONE - r;
        }
        uint256 pips = (fee18 + 1e12 - 1) / 1e12;
        f = pips > MAX_STEP_FEE ? MAX_STEP_FEE : uint24(pips);
    }

    function sqrt(uint256 x) internal pure returns (uint256 y) {
        if (x == 0) return 0;
        uint256 z = (x >> 1) + 1;
        y = x;
        while (z < y) {
            y = z;
            z = (x / z + z) >> 1;
        }
    }
}
