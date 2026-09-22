# Stepguard contracts

The Stepguard logic for pools that hold a Robinhood Chain stock token (ERC-8056), in two forms:

- **`Stepguard`**, a Uniswap v4 hook for new pools, and
- **`StepguardDopplerModule`**, a Doppler Hook module for new launches on Doppler's `DopplerHookInitializer`.

Both use the same arithmetic in `StepMath`.

**Status: prototype. Unaudited. Not deployed anywhere.** Do not put liquidity behind it.

## What it does

A stock token's multiplier (how many shares one raw token stands for) steps on a schedule that the token
publishes on chain before it takes effect (`newUIMultiplier()`, `effectiveAt()`). A v4 pool prices raw tokens
and never reads the multiplier. After a step up, the pool sells the token at the old share count; after a
step down, it buys it at the old share count. Whoever trades first in the profitable direction takes the
difference from the LPs.

Stepguard reads the same schedule:

1. `afterInitialize` records which side(s) of the pool are ERC-8056 tokens and the multiplier the opening
   price reflects. Pools without a stock token, and static-fee pools, are rejected.
2. `beforeSwap` compares the multiplier the price reflects with the one the token reports (or has scheduled
   within `lookahead`). On a change it records the target price the step implies
   (`price x newMultiplier / oldMultiplier`, composed for two-stock pools and for back-to-back steps).
3. While armed, a swap in the direction that would take value from LPs pays a fee equal to the gap between
   the pool price and the target (`1 - P/T` for buys after a step up, `1 - T/P` for sells after a step
   down), rounded up. The fee goes to in-range LPs. The other direction pays `baseFee`.
4. The guard clears when the pool trades within `baseFee` of the target, when it crosses the target (past
   that point the gap is ordinary market movement), or after `guardWindow`.

`quoteFee(key, zeroForOne)` returns the fee the next swap would pay, without writing state, for routers and
frontends.

## The Doppler module

On chain 4663, Doppler's `DopplerHookInitializer` (`0x4e3468951d49f2eea976ed0d6e75ffcb44a9a544`, Sourcify match) is the
hook on 20,300 of the 30,862 v4 pools that hold a stock token whose multiplier has stepped, and 20,136 of those pools
use a dynamic LP fee. Doppler lets a module (a "Doppler Hook") be attached per asset: it gets `onSwap` after
every swap and may call `updateDynamicLPFee(asset, fee)`. `StepguardDopplerModule` is that module. It differs from
the hook in three ways, all forced by the module interface:

- it runs after a swap, so it sets the fee for the next one; anyone can call `poke(asset)` when a schedule is
  posted so the fee is in place before the first trade;
- the pool has one LP fee, so while a step is priced in both directions pay it;
- Doppler caps a module-set LP fee at 10% (`MAX_LP_FEE = 100_000`), so a step whose gap exceeds 10% (any split)
  is only partly priced; the module never asks for more, because a rejected update inside Doppler's
  `afterSwap` would revert every swap in the pool.

**Who can attach it, measured on 2026-09-22** (`research/doppler-probe.cjs`, `research/doppler-authorities.cjs`):

- Enabling a module is up to the Airlock owner, a Safe 1.4.1 with a 3-of-6 threshold
  (`0x21E2ce70511e4FE542a97708e89520471DAa7A66`).
- Attaching it to a pool is up to that asset's timelock (or its delegate). For 20,279 of the 20,300 Doppler pools
  holding a stepped token, the timelock is `0x…dEaD` (11,540) or `0x0` (8,739) with no delegate, so **their module
  slot can never change**. 20,136 of those slots already hold a module: an unverified one at
  `0x6f02…0f77` (11,632 pools) and `RehypeDopplerHookInitializer` (8,293 pools; fees, buybacks, LP reinvestment).

So the module reaches **new** Doppler launches whose creator selects it, not the existing pools. For existing
pools the realistic route is the authors of those two modules adding the `StepMath` check to their next version.

It is tested against `MockDopplerInitializer`, a stand-in with the same callback, fee-update call and 10% cap,
not against Doppler's own contracts.

## Tests

```bash
npm install
npm test
```

26 Solidity tests, all against the real `PoolManager` from `@uniswap/v4-core` 1.0.2 (forge-std cheatcodes, run
by Hardhat 3), plus 5 keeper tests (`npm run test:keeper`). 16 cover the hook. Every scenario runs the same trade on a bare pool (0.30% static fee, no hook) and a guarded pool
(0.30% base fee), both opened at 100 quote per stock with the same full-range liquidity:

| Scenario | Bare pool | Stepguard pool |
|---|---|---|
| 1,000 quote buy after a 4x step | more than 2,500 quote taken | 0 or less |
| Same buy inside the lookahead, before `effectiveAt` | more than 2,500 taken | 0 or less |
| 10-token sell after a 0.5x reverse step | more than 400 taken | 0 or less |
| Two 2x steps before any buyer reprices | more than 2,500 taken | 0 or less |
| Fuzz, 256 runs: steps 1.005x to 5x, trades 10 to 5,000 quote | always more than guarded | never above 0 |

Plus: sells pay the base fee during a step up; schedules beyond the lookahead are not priced; the guard
clears on repricing and on the window (event reason checked); two stocks stepping together leave the price
alone; a cancelled schedule disarms the guard; a token that stops answering fails open; static-fee and no-stock
pools are rejected; only the PoolManager can call the hook.

9 cover the Doppler module: attaching sets the base fee; a keeper poke at the schedule leaves nothing taken on a
+5% step; **without a poke the first trade after the step still takes, and the second is charged**; **a ×4 split
is only partly priced under Doppler's 10% cap** (most of it still gets through); the fee applies to both
directions while armed; a failing fee update never blocks a swap; the fee returns to base once buyers reprice;
only the initializer can call the callbacks; poke rejects unknown assets.

1 rehearses deployment with no `vm.etch` (`test/Deployment.t.sol`): mine a CREATE2 salt, deploy, let the
PoolManager validate the address, trade a ×4 step.

The last run is recorded in `../evidence/tests.txt`. The author's own review is in `SECURITY.md` (not an audit).

## Deployment (prepared, not sent)

```bash
npm run build
npm run mine        # chain 4663; for testnet: node scripts/mine-salt.cjs --chain 46630 --rpc <url> --pool-manager 0x...
```

`scripts/mine-salt.cjs` mines a salt for the deterministic CREATE2 proxy (`0x4e59b44847b379578588920cA78FbF26c0B4956C`,
present on 4663), checks the proxy and the PoolManager exist, simulates the deployment against the live chain with
`eth_call` and `eth_estimateGas`, and writes the unsigned transaction to `deploy/stepguard-<chainId>.json`. For 4663
with the default parameters: hook address `0xed3D93c9dD52A7e52Ff038d4311Be9AF4eDd7080`, the simulation returns that
address, about 1.45M gas, 6,357 bytes of runtime code. Nothing has been sent. The address changes with any change to
the bytecode or constructor arguments.

## Keeper

`../keeper/keeper.cjs` watches `UIMultiplierUpdated` on the 194 stock tokens and pokes the Doppler module for every
registered asset while a step is inside the lookahead or the guard window. Dry run by default; it signs only with
`--send`, `--module` and `KEEPER_PRIVATE_KEY`. `npm run keeper:replay` walks the 31 recorded steps. The hook form
needs no keeper.

## Known limits

- **Existing pools cannot adopt either form.** A v4 pool's hook is fixed when the pool is created, and 27,646 of the
  30,862 v4 pools holding a stepped token already carry one (930 distinct hooks). In the largest group, Doppler's,
  the module slot is frozen for 20,279 of 20,300 pools (timelock `0x0` or `0x…dEaD`). Both forms are for new pools.
- **The hook cannot move the price.** It charges the gap; the pool reprices only as swaps arrive. A pool
  nobody trades stays stale, and after `guardWindow` it is exposed again.
- **The target is anchored at arming time.** If the underlying moves while a step is armed, the fee can be
  larger or smaller than the true gap. The crossing rule and the window bound how long that lasts.
- **It protects its own LPs only.** A trader can still take a step from an unguarded pool.
- **Fails open.** If the token stops answering the ERC-8056 reads (for example after a beacon upgrade that
  drops them), the hook keeps the last known multiplier and charges the base fee.
- **Lookahead depends on the issuer.** ERC-8056 only requires `effectiveAt` to be in the future. With no lead
  time, the first swap after the step still arms and pays the gap; only positioning before the step goes
  unpriced.
- **Gas.** Up to three extra external reads per stock side per swap.
- **Deployment** needs an address whose low 14 bits are exactly `BEFORE_INITIALIZE | AFTER_INITIALIZE |
  BEFORE_SWAP` (mined with CREATE2). Tests place the code at such an address with `vm.etch`.

## Layout

```
src/Stepguard.sol              the hook
src/StepguardDopplerModule.sol the Doppler Hook module
src/StepMath.sol               the shared arithmetic
src/mocks/MockDopplerInitializer.sol  stand-in for Doppler's initializer (tests only)
src/mocks/MockStockToken.sol   ERC20 + ERC-8056 schedule, mirroring the reference behaviour
src/mocks/MockERC20.sol        plain ERC20
test/Stepguard.t.sol           hook tests
test/StepguardDopplerModule.t.sol  module tests
test/Deployment.t.sol          CREATE2 deployment rehearsal
scripts/mine-salt.cjs          salt miner + live simulation, writes deploy/stepguard-<chainId>.json
SECURITY.md                    internal review (not an audit)
../keeper/                     keeper for the Doppler module
```
