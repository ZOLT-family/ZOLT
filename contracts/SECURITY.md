# Zolt — internal security review

**This is not an audit.** It is the author's own review of the prototype, written so an auditor starts from
what is already known. Nothing here is deployed. Do not put liquidity behind these contracts before an
independent audit.

Scope: `src/Zolt.sol`, `src/ZoltDopplerModule.sol`, `src/StepMath.sol` (mocks are test-only).
Reviewed 2026-09-22 against `@uniswap/v4-core` 1.0.2 and the verified `DopplerHookInitializer` source on chain
4663 (`0x4e3468951d49f2eea976ed0d6e75ffcb44a9a544`).

## Found and fixed during development

| # | Contract | Issue | Fix | Test |
|---|---|---|---|---|
| 1 | Zolt | Once buyers pushed the price past the target, the guard flipped direction and charged sellers a "step" fee for ordinary market movement. | The guard records the protected direction when it arms and clears when the pool crosses the target. | `test_guardClearsOnceBuyersRepriceThePool` |
| 2 | Doppler module | **Pool lock.** Doppler rejects an LP fee above `MAX_LP_FEE = 100_000` (10%). The module asked for up to 99.99% on large steps; the revert inside Doppler's `afterSwap` would have reverted every swap in the pool. | Fee capped at `DOPPLER_MAX_LP_FEE`; the fee update is wrapped in `try/catch`; the stand-in initializer enforces the same cap. | `test_bigSplitIsOnlyPartlyPricedUnderDopplersTenPercentCap`, `test_aFailingFeeUpdateNeverBlocksSwaps` |
| 3 | Doppler module | **Pool lock.** A module attached without `onInitialization` reverted `NotRegistered` inside `onSwap`, again reverting every swap. | `onSwap` stays inert for unregistered pools. Rule written into the contract: it never reverts inside `onSwap`. | covered by the same rule; `poke` still reverts for unknown assets (`test_pokeRejectsUnknownAssets`) |
| 4 | Zolt | A cancelled schedule (ERC-8056 `UIMultiplierUpdateCancelled`) could have left buyers paying for a step that would not happen. | Not a code change: arming compares the expected multiplier on every swap, so a cancel re-arms with the inverse ratio and the gap closes. Now tested. | `test_cancelledScheduleDisarmsTheGuard` |

## Checked, no issue found

- **Reentrancy.** The only external calls in `beforeSwap` are `view` calls on the stock token (`STATICCALL`) and
  `extsload` reads on the PoolManager. No state-changing call leaves the hook. The Doppler module's one
  state-changing call (`updateDynamicLPFee`) goes to its fixed `INITIALIZER`.
- **Access control.** Hook callbacks: `onlyPoolManager`. Module callbacks: `onlyInitializer`. `poke` is open by
  design; it can only apply the fee the token's own schedule implies, never an arbitrary fee.
- **Arming on manipulated prices.** The target is anchored on the pool price *before* the swap that arms it,
  so a trader cannot move the anchor with the same swap. Moving the price earlier costs the manipulator the
  usual arbitrage loss.
- **Arithmetic.** Multipliers are 1e18 fixed point; `target` uses `FullMath.mulDiv` and a Babylonian sqrt on
  `ratio x 1e18` (no overflow below a ratio of about 1e59). Fees round up, so a guarded buyer never pays less
  than the gap. Fees are capped below v4's 100% (`999_999`) and at Doppler's 10% in the module.
- **Decimals and native ETH.** The ratio does not depend on token decimals. Native ETH (`address(0)`) and
  code-less addresses are treated as non-stock sides.
- **Deployment address.** `test/Deployment.t.sol` mines a salt, deploys through CREATE2 with no `vm.etch`, and
  the PoolManager's own `validateHookPermissions` accepts the address. `scripts/mine-salt.cjs` produced
  `0xed3D93c9dD52A7e52Ff038d4311Be9AF4eDd7080` for chain 4663, and `eth_call` against the live chain returned
  that address (`deploy/zolt-4663.json`).

## Open risks an auditor should look at

1. **Gas griefing by a hostile token.** A pool creator can pair an arbitrary "stock-like" token. Its
   `uiMultiplier()` can burn the 63/64 gas `try/catch` forwards and make swaps in *that pool* fail. It cannot
   affect other pools. Consider a gas cap on the ERC-8056 reads.
2. **Target drift.** The target is fixed when armed. If the underlying moves while armed, the step fee can be
   too high (buyers overpay LPs) or too low (a trader takes the remainder). Bounded by the crossing rule and
   `guardWindow`, not eliminated.
3. **Stale pools after the window.** A pool nobody trades during `guardWindow` is exposed again afterwards.
4. **Issuer control.** The issuer can pause, block, `adminBurn`, and upgrade all 194 tokens through one beacon.
   A beacon upgrade that changes the ERC-8056 reads makes the hook fail open (last known multiplier, base fee).
5. **Doppler module is one step behind.** It runs after swaps. Without a keeper `poke` when the schedule is
   posted, the first trade after a step goes through at the old fee (`test_withoutAPoke...`).
6. **Doppler cap.** Steps whose gap exceeds 10% are only partly priced by the module. For splits, only the hook
   form protects fully.
7. **Only tested against a stand-in for Doppler.** `MockDopplerInitializer` reproduces the callback, the
   fee-update call and the 10% cap from the verified source, not the rest of Doppler.
8. **Keeper key.** `keeper/keeper.cjs --send` signs with `KEEPER_PRIVATE_KEY`. A leaked key can only call
   `poke`, which is harmless, but it can drain the key's gas balance.
