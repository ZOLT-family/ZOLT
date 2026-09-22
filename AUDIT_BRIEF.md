# Zolt Odds — audit brief

For an independent reviewer. Everything here is checkable from the repo; nothing in it has been audited yet.

## Scope

- `contracts/src/ZoltOdds.sol` (about 280 lines, Solidity 0.8.26, no dependencies beyond an interface).
- Its only external dependency: `PonsV2LaunchFactory.getLaunchedToken(address)` at
  `0x7ed598bcef8bd9edd8c97a195c6d13f40801ec7e` on chain 4663 (Robinhood Chain, Arbitrum Orbit). Verified on
  Sourcify (exact match). The market reads `phase` and `exists` from the returned struct and nothing else.
- Out of scope: the page, the keeper, the relay (they hold no funds), and the earlier `Zolt.sol` hook.

## What it is

Parimutuel Yes/No markets on whether a Pons V2 launch leaves its bonding curve (`phase != NotGraduated`) before a
deadline. ETH only. Three windows (10 min / 1 h / 6 h); staking for the first half. Stakes are weighted by seconds
to the close. Resolution by witness calls anyone can make; a market nobody could witness is voided a day after
its deadline and refunded. 1% of the losing pool to an immutable treasury. No owner, no pause, no upgrade.

## Invariants we believe hold (and test)

1. `sum(payouts) + fee ≤ yesPool + noPool`, and the difference is division dust only (fuzzed, 256 runs).
2. A market with `yesPool == 0 || noPool == 0` never pays a pot; it refunds principals.
3. No stake is accepted when `block.timestamp >= closesAt`, when the market is not `Open`, or when the launch's
   phase is not `NotGraduated`.
4. `witnessYes` succeeds only if `block.timestamp <= deadline && phase != 0`; `witnessNo` only if
   `block.timestamp > deadline && phase == 0`; `voidUnobserved` only if `block.timestamp > deadline + 1 day`.
5. `claim` pays each address at most once per market and cannot be re-entered.
6. Weight is `amount * (closesAt - block.timestamp)`; a stake at `closesAt - 1` has weight `amount`.
7. If every winning stake has zero weight, the pot is shared by principal (not stranded).

## Threats we considered

- **Late information.** Graduation is visible on chain seconds before it lands (a large buy pending). Weighting
  by time-to-close is the mitigation; it is economic, not absolute.
- **Creator collusion.** A creator can stake YES and then buy the curve. Intended: the market prices it.
- **Witness griefing.** Nobody can block a witness; the calls are permissionless and idempotent by outcome.
- **Unobservable order.** Graduation after the deadline, before any NO witness: void + refund. Is a day the right
  wait? Could a shorter one strand a legitimate NO?
- **Factory drift.** A factory upgrade that changes `LaunchedToken`'s layout would make `_phase` decode a wrong
  word. The factory is a plain contract (not a proxy), so its code cannot change in place; a new factory is a new
  address and a new market. Should the market still pin `factory.codehash`?
- **Treasury that reverts.** `_resolve` sends the fee before claims; a reverting treasury would block resolution.
  Mitigation is deployment discipline (an EOA). Should the fee be pulled instead of pushed?
- **Timestamp.** The sequencer's timestamp is used directly. Windows are minutes to hours.
- **Chain halt.** Robinhood Chain stopped producing blocks for 14 minutes on 4 September 2026. A halt across a
  deadline delays all witnesses equally.
- **Denial of service by opening.** Opening is free (gas only) and unlimited; empty markets refund. Is there a
  storage-growth concern worth a fee or a bond?

## Questions we would most like answered

1. Any path by which ETH can leave the contract other than `claim` and the fee transfer in `_resolve`?
2. Any state in which a market can be neither resolved nor voided?
3. Any way a stake can enter after the launch has graduated, given the factory read in `stake`?
4. Is the time-weighting sound against a wallet that splits a stake across many transactions?
5. Anything in `PonsV2LaunchFactory` (owner functions: `forceSweptGraduation`, `rescueSweptGraduation`,
   `setLaunchEnabled`, config updates) that changes the meaning of `phase` in a way the market should refuse?

## How to run what we ran

```bash
cd contracts && npx hardhat test solidity                   # 43 tests (17 on the market)
RH_FORK=1 RH_FORK_RPC=<rpc> RH_FORK_TOKEN=0x… npx hardhat test solidity --grep fork   # against the real factory
```

`contracts/SECURITY-ODDS.md` maps each promise to its test. `evidence/fork-run.txt` records the fork run.
