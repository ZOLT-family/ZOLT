import { defineConfig } from "hardhat/config";

/**
 * Zolt: the hook and its Solidity tests. Sources in src/, tests in test/.
 * Tests run against the real Uniswap v4 PoolManager (@uniswap/v4-core 1.0.2) in
 * the EVM, with forge-std cheatcodes. No network is configured on purpose:
 * nothing here is deployed.
 *
 *   npm test        # compile and run every Solidity test
 */
export default defineConfig({
  solidity: {
    // v4-core's PoolManager pins 0.8.26 exactly, and needs transient storage (cancun).
    version: "0.8.26",
    settings: {
      evmVersion: "cancun",
      optimizer: { enabled: true, runs: 200 },
      viaIR: true,
      metadata: { bytecodeHash: "none" },
    },
  },
  paths: {
    sources: "src",
    tests: "test",
  },
  test: {
    solidity: {
      // Pinned so a recorded run can be repeated exactly.
      fuzz: { seed: "0x5e9a0d5e7c1b4f2a9d6e8c3b0a1f4e7d2c5b8a1e4d7c0b3a6f9e2d5c8b1a4e7d", runs: 256 },
    },
  },
});
