# Zolt Odds — X copy (draft, NOT POSTED)

## Bio

> The first launch odds market on Robinhood Chain. Yes/No on whether a Pons launch graduates in time, settled by the chain itself. Not for US persons.

(148 characters.)

Shorter, if the field is tight:

> The first launch odds market on Robinhood Chain. Settled by the chain, not by us.

## First post (one post, not a thread)

> 9,930 tokens launched on Pons yesterday. 120 reached 4.2 ETH. Median time for the ones that did: 3 minutes.
>
> Zolt Odds is a Yes/No market on exactly that moment, for any launch still on its curve. No oracle: the outcome is read from Pons's own factory, by whoever asks first.
>
> Parimutuel, 1% fee, weight falls with time so last-second money can't dilute early money.
>
> Live on chain 4663 at 0xaC86…b097, not for US persons. zolt-smoky.vercel.app · github.com/ZOLT-family/ZOLT

## A market post (any time a market is open)

Press *share* on the market on the board; it copies this line with the live numbers, and the link carries the
market's own card:

> Will $AGE graduate in 1 h? YES 0.010 / NO 0.000 ETH on Zolt Odds → zolt-smoky.vercel.app/m/17

Add one line of your own if you like ("curve at 58%, 13 minutes in"), from the board, not from memory.

## For the bot crowd (a reply or a second post, later)

> Every open market, with the exact calldata to stake either side: zolt-smoky.vercel.app/api/markets — read-only JSON, no key, no account. AGENTS.md in the repo has the rest.

## Rules for anything posted

- Never "guaranteed", "risk-free", "insured". No talk of audits, either way.
- Never a number that is not in `evidence/` or a test file. Rerun `node research/figures.cjs`-style reads before quoting a new day.
- "The first" is a claim about what we could find on 23 Sep 2026 (Meridian is a curated RFQ venue, PopDEX is perps, no launch-outcome market was found). If someone shows an earlier one, the bio changes the same day.
- Every post that names the contract names its address.
