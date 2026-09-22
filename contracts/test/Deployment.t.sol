// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";

import {PoolManager} from "@uniswap/v4-core/src/PoolManager.sol";
import {IHooks} from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import {Hooks} from "@uniswap/v4-core/src/libraries/Hooks.sol";
import {LPFeeLibrary} from "@uniswap/v4-core/src/libraries/LPFeeLibrary.sol";
import {TickMath} from "@uniswap/v4-core/src/libraries/TickMath.sol";
import {PoolSwapTest} from "@uniswap/v4-core/src/test/PoolSwapTest.sol";
import {PoolModifyLiquidityTest} from "@uniswap/v4-core/src/test/PoolModifyLiquidityTest.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {BalanceDelta} from "@uniswap/v4-core/src/types/BalanceDelta.sol";
import {ModifyLiquidityParams, SwapParams} from "@uniswap/v4-core/src/types/PoolOperation.sol";

import {Stepguard} from "../src/Stepguard.sol";
import {MockERC20} from "../src/mocks/MockERC20.sol";
import {MockStockToken} from "../src/mocks/MockStockToken.sol";

/// The real deployment path, with no vm.etch: mine a CREATE2 salt whose address carries exactly the hook's
/// permission bits, deploy there, let the PoolManager validate the address on initialize, and trade a step.
/// scripts/mine-salt.cjs runs the same search off chain for the real deployer.
contract DeploymentTest is Test {
    uint160 constant FLAGS = Hooks.BEFORE_INITIALIZE_FLAG | Hooks.AFTER_INITIALIZE_FLAG | Hooks.BEFORE_SWAP_FLAG;

    function test_mineDeployAndTradeWithoutEtch() public {
        vm.warp(1_790_000_000);
        PoolManager manager = new PoolManager(address(this));
        bytes memory args = abi.encode(manager, uint24(3000), uint256(2 hours), uint256(24 hours));
        bytes32 initHash = keccak256(abi.encodePacked(type(Stepguard).creationCode, args));

        (bytes32 salt, address predicted, uint256 tries) = _mine(address(this), initHash);
        emit log_named_uint("salts tried", tries);

        Stepguard hook = new Stepguard{salt: salt}(manager, 3000, 2 hours, 24 hours);
        assertEq(address(hook), predicted, "CREATE2 landed where the miner said");
        assertEq(uint160(address(hook)) & Hooks.ALL_HOOK_MASK, FLAGS, "exactly the three permission bits");
        Hooks.validateHookPermissions(IHooks(address(hook)), hook.getHookPermissions()); // reverts on mismatch

        MockStockToken stock = new MockStockToken("Test Stock", "TSTK");
        MockERC20 quote = new MockERC20("Test Dollar", "TUSD", 18);
        PoolSwapTest swapRouter = new PoolSwapTest(manager);
        PoolModifyLiquidityTest lpRouter = new PoolModifyLiquidityTest(manager);
        for (uint256 i = 0; i < 2; i++) {
            MockERC20 t = i == 0 ? MockERC20(address(stock)) : quote;
            t.mint(address(this), 1e30);
            t.approve(address(swapRouter), type(uint256).max);
            t.approve(address(lpRouter), type(uint256).max);
        }
        (address c0, address c1) = address(stock) < address(quote) ? (address(stock), address(quote)) : (address(quote), address(stock));
        PoolKey memory key = PoolKey(Currency.wrap(c0), Currency.wrap(c1), LPFeeLibrary.DYNAMIC_FEE_FLAG, 60, IHooks(address(hook)));
        bool stockIs0 = c0 == address(stock);
        manager.initialize(key, stockIs0 ? uint160(10 * 2 ** 96) : uint160(uint256(2 ** 96) / 10));
        lpRouter.modifyLiquidity(key, ModifyLiquidityParams(-887220, 887220, 1e22, 0), "");

        uint256 t0 = block.timestamp;
        stock.scheduleMultiplier(4e18, t0 + 10 minutes);
        vm.warp(t0 + 11 minutes);
        bool buy = !stockIs0;
        BalanceDelta d = swapRouter.swap(
            key,
            SwapParams(buy, -1_000e18, buy ? TickMath.MIN_SQRT_PRICE + 1 : TickMath.MAX_SQRT_PRICE - 1),
            PoolSwapTest.TestSettings(false, false),
            ""
        );
        (int128 s, int128 q) = stockIs0 ? (d.amount0(), d.amount1()) : (d.amount1(), d.amount0());
        int256 taken = int256(uint256(int256(s)) * 400) - int256(uint256(-int256(q)));
        assertLe(taken, 0, "the CREATE2-deployed hook guards the x4 step");
    }

    function _mine(address deployer, bytes32 initHash) internal pure returns (bytes32 salt, address addr, uint256 tries) {
        for (uint256 i = 0; i < 200_000; i++) {
            salt = bytes32(i);
            addr = address(uint160(uint256(keccak256(abi.encodePacked(bytes1(0xff), deployer, salt, initHash)))));
            if (uint160(addr) & Hooks.ALL_HOOK_MASK == FLAGS) return (salt, addr, i + 1);
        }
        revert("no salt in range");
    }
}
