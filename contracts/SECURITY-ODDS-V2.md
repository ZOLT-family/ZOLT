# ZoltOddsV2 — internal review

The authors' own review of `src/ZoltOddsV2.sol`: what it adds to ZoltOdds, how each addition is tested, and what it does
not promise. Everything ZoltOdds promises (see `SECURITY-ODDS.md`) is carried over unchanged, with the market core
copied rather than inherited so the two contracts can be read side by side.

## What it adds

| promise | how it holds | test |
| --- | --- | --- |
| A bond is locked seven days from the last deposit, on the whole amount | `bond` sets `lockedUntil = now + BOND_LOCK`; `unbond` reverts with `BondLocked(until)` before it | `test_bondLocksForSevenDaysAndEveryDepositRestartsTheLock` |
| A bond needs real tokens | `transferFrom` through a raw call; a false return or a revert is `TokenTransferFailed` | `test_bondNeedsTokens` |
| The fee is 0.5% for a winner bonded with at least `discountBond`, else 1% | `feeBpsOf` reads the bond at claim; `payoutAndFee` charges the fee on the share of the losing pool, not on principal | `test_bondedWinnerPaysHalfTheFee`, `test_feeAndKeeperStatusFollowTheBond` |
| A bond placed after resolution still earns the discount, and is still locked for it | the fee is evaluated at claim, and the lock runs from the deposit | `test_theFeeIsReadAtClaimSoABondPlacedAfterResolutionCountsAndIsLocked` |
| A witness bonded with at least `keeperBond` is paid 0.2% of the losing pool at once; anyone else records for nothing | `_resolve` pays the bounty only when `isKeeper(msg.sender)`; it is subtracted from the pot winners share | `test_bondedWitnessIsPaidTheBountyOutOfTheLosingPool`, `test_yesWitnessIsPaidTheSameWay`, `test_witnessWithoutTheBondIsNotPaid` |
| A void market pays no bounty and no fee | one-sided or unobserved markets resolve Void before the bounty branch; `payoutAndFee` returns principal, fee 0 | `test_noBountyAndNoFeeOnAVoidMarket` |
| Every wei is accounted for: claims + fees + bounty never exceed the pools, and fall short only by rounding | fuzz over three stakes, a time offset, both outcomes, a bonded or unbonded witness and a bonded or unbonded winner | `testFuzz_everyWeiIsAccountedFor` |
| `claim` cannot be re-entered; witnesses and bonds cannot either | `nonReentrant` on `claim`, `witnessYes`, `witnessNo`, `voidUnobserved`, `bond`, `unbond` | `test_claimIsNotReenterable` |
| `market()` decodes like v1 | the first ten fields are laid out as ZoltOdds.Market; `bounty` is word 10 | `test_marketWordsMatchTheV1LayoutWithBountyAppended` |
| No zero addresses, no zero bonds | constructor requires | `test_constructorRejectsZeroes` |

## What it does not promise

- **Nothing to slash.** Outcomes come from the factory, so a bonded witness cannot lie; the bond gates the bounty, it does
  not insure anything.
- **The token is whatever was passed in.** The contract trusts `zolt` to be an ordinary ERC-20 (a Pons launcher token is
  an OpenZeppelin ERC-20 with no transfer hooks). A token that reverts on transfer would freeze bonds, never ETH:
  markets, stakes and claims do not touch the token.
- **The fee is per claim.** A winner who never claims leaves both their share and the treasury's fee in the contract,
  as in v1.
- **Bonds are not positions.** ZOLT in a bond earns nothing by itself; it only changes the fee a winner pays and whether a
  witness is paid.

## Open questions

1. Should the bounty also be paid on a Void that a keeper had to record (empty markets cost the keeper gas today)?
   Paying from an empty pool is impossible, so it would need a separate source; v2 keeps it simple and pays nothing.
2. Should `discountBond` and `keeperBond` scale with the token's supply automatically? They are plain immutables, chosen
   at deploy time in whole ZOLT.
