# ZoltOdds — internal review

This is the authors' own review of `src/ZoltOdds.sol`, written before any outside audit. It is not an audit. It
lists what the contract promises, how each promise is tested, and what it does not promise.

## What it promises

| promise | how it holds | test |
| --- | --- | --- |
| A market can only be opened on a Pons V2 launch that is still on its curve | `open` reads `factory.getLaunchedToken(token)` and requires `exists` and `phase == 0` | `test_openRequiresAPonsLaunchStillOnItsCurve` |
| One open market per (token, window) | `openMarket[token][window]` holds id+1 while open; cleared on resolution | `test_openSetsTheWindowAndRefusesADuplicate`, `test_resolvedMarketFreesTheSlotForANewOne` |
| Stakes stop at the close and the moment the launch graduates | `stake` requires `block.timestamp < closesAt` and re-reads the factory phase | `test_stakeWeightFallsToZeroAtClose`, `test_noStakesOnceTheLaunchHasGraduated` |
| Late money cannot dilute early money | weight = amount × seconds to close; payout shares by weight | `test_earlyMoneyIsNotDilutedByLateMoney` |
| YES only before the deadline, only after graduation | `witnessYes` requires `block.timestamp <= deadline` and `phase != 0` | `test_yesIsWitnessedOnlyBeforeTheDeadlineAndOnlyAfterGraduation`, `test_yesCannotBeWitnessedAfterTheDeadline` |
| NO only after the deadline, only while on the curve | `witnessNo` requires `block.timestamp > deadline` and `phase == 0` | `test_noIsWitnessedOnlyAfterTheDeadlineWhileStillOnCurve` |
| An unobservable market refunds everyone | `voidUnobserved` a day after the deadline sets Void; payout returns principal | `test_aGraduationAfterTheDeadlineThatNobodyWitnessedIsVoidedAndRefunded` |
| A one-sided market refunds, never pays | `_resolve` turns Yes/No into Void when either pool is empty | `test_oneSidedMarketIsRefundedNotPaid` |
| Every wei is paid out or taken as fee | payout = principal + pot × weight / totalWeight; fee = 1% of the losing pool at resolution | `testFuzz_everyWeiIsAccountedFor` (256 runs) |
| Claim pays once, cannot be re-entered | `claimed` flag set before the send; `nonReentrant` guard | `test_claimPaysOnceAndOnlyWinners`, `test_claimIsNotReenterable` |
| Nobody can change the rules | no owner, no pause, no upgrade; `factory` and `treasury` are immutable | by construction |
| It resolves against Pons's real contracts | on a fork of chain 4663, buying a live launch's curve past 4.2 ETH made Pons's own factory move the phase to `Swept`, after which `witnessYes` resolved and paid exactly; `witnessNo` resolved after a warped deadline | `test/ZoltOddsFork.t.sol` (opt-in, `evidence/fork-run.txt`) |

## What it does not promise

- **That the factory is honest.** The market trusts `PonsV2LaunchFactory` at the address it was deployed with. If
  that contract is upgraded, paused or replaced, this market keeps reading it. Pons's owner can move a launch out
  of `NotGraduated` with `forceSweptGraduation` (only when the launch is ready to graduate and its pool cannot
  be seeded); the market counts that as YES, deliberately: the threshold was reached.
- **That a witness arrives in time.** YES must be recorded before the deadline. A launch that graduates one
  second before the deadline in a block nobody acts on is voided a day later, not paid. The keeper exists to
  make that rare; anyone may run one; YES holders can always record it themselves.
- **That the odds are fair.** A parimutuel pays what the other side staked. There is no market maker.
- **That the creator will not buy the answer.** They can, by buying the curve to 4.2 ETH. The market is a market
  on that.
- **That a chain halt is survivable.** Robinhood Chain stopped producing blocks for 14 minutes on 4 September
  2026. A halt across a deadline delays every witness equally; the void rule is the backstop.

## Things we looked at and decided

- **Rounding.** Shares use integer division; dust stays in the contract (at most a few wei per market) and is never
  created. The fuzz test asserts `paid + fee ≤ pools` and `paid + fee + 3 ≥ pools`.
- **Zero-weight winners.** If every winning stake landed at the last second, total weight is 0; the pot is then
  shared by principal instead of by weight so the pot is not stranded.
- **Fee timing.** The fee is sent to the treasury at resolution, before any claim. A treasury that reverts on
  receive would block resolution; the treasury is therefore an EOA or a contract that accepts plain ETH, chosen
  at deployment and never changed.
- **`sweptAt`.** The factory's `sweptAt` is zeroed when the pool is created, so it cannot be read back later.
  Resolution uses `phase`, which only moves forward.
- **Denial of service by opening.** Anyone can open a market for free (gas only). Empty markets resolve to Void
  or one-sided refunds, so they cost their opener gas and nobody else anything. There is no per-token limit on
  windows beyond one open market per window.
- **Re-entrancy.** `claim` is guarded and sets `claimed` before sending. `_resolve` sends the fee to the
  treasury; it is called from `witnessYes`, `witnessNo`, `voidUnobserved`, which are not guarded but write the
  outcome before the send and can only run once per market (`outcome != Open` afterwards).
- **Block timestamp.** Windows are minutes and hours; the sequencer's timestamp is used as is.

## Open questions for an auditor

1. Is reading `getLaunchedToken` (a struct with strings elsewhere in the factory's storage, but a fixed-size
   struct here) robust to a factory upgrade that changes the struct layout? Today the ABI is verified on
   Sourcify (exact match); a layout change would make `_phase` decode garbage. Should the market pin the
   factory's code hash and refuse to resolve if it changes?
2. Should the void window be shorter than a day?
3. Should there be a maximum stake per address per market, to keep a single wallet from making a market
   one-sided at the last second?
