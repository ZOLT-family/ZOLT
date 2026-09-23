# Zolt Odds for bots and agents

Everything a program needs to read the markets and stake in them. Nothing here needs a key from us: a bot reads the
chain (or the JSON below) and sends its own transactions from its own wallet.

## Read

**`GET https://zolt-smoky.vercel.app/api/markets`** — the last 24 markets, open ones first, read from chain 4663 on
request (cached a few seconds). `?id=12` for one market. Fields per market:

| field | meaning |
| --- | --- |
| `id`, `token`, `symbol` | the market and the Pons launch it is about |
| `launchPhase` | `0` still on its bonding curve; `1`–`3` graduated (YES is now recordable) |
| `window`, `windowLabel`, `windowSeconds` | `0` = 10 min, `1` = 1 h, `2` = 6 h |
| `openedAt`, `closesAt`, `deadline` | unix seconds; staking is open until `closesAt` (half the window), graduation must be witnessed by `deadline` |
| `stakingOpen`, `secondsToClose`, `secondsToDeadline` | derived from the block timestamp at read time |
| `yesPool`, `noPool`, `impliedYesBps` | ETH on each side and the raw implied probability of YES (no weighting) |
| `outcome` | `open`, `yes`, `no`, `void` |
| `stake.to`, `stake.yes`, `stake.no`, `stake.minValueWei` | the exact calldata for a YES or NO stake, sent with ETH as value |

**`https://zolt-smoky.vercel.app/m/<id>`** is the page for one market, with link-preview tags and a card
(`/api/card?id=<id>`, a 1200×630 PNG of its pools and clock) so a shared link shows that market. `/api/card` alone is
the site's card.

Or read the contract directly (any RPC to chain 4663; the public one is `https://rpc.mainnet.chain.robinhood.com`):
`marketCount()`, `market(id)` (struct: token, openedAt, closesAt, deadline, window, outcome, yesPool, noPool, yesWeight,
noWeight), `payout(id, who)`, `impliedYesBps(id)`. Selectors and event topics are in the page's `<script id="data">`
block and in `site/build-site.cjs`.

## Stake

Send ETH (at least 0.0001) to the market contract with `openAndStake(address token, uint8 window, bool yes)`: it opens
the market if none is open for that launch and window, otherwise joins the one that is. Weight = amount × seconds left
until `closesAt`, so an early stake earns more of the pot than a late one of the same size. Stakes are refused once the
launch has graduated. The `stake.yes` / `stake.no` calldata in the JSON is exactly this call.

## Resolve and claim

Anyone may record an outcome, and a bot that holds a position has every reason to: `witnessYes(id)` while the deadline
has not passed and the launch has graduated; `witnessNo(id)` after the deadline while it is still on its curve;
`voidUnobserved(id)` a day after the deadline if neither was possible. A keeper this site runs does it as a backstop
two minutes after a deadline. Then `payout(id, who)` says what `who` can take and `claim(id)` pays it: principal plus
a weighted share of the losing pool for winners, principal back for a void, nothing for losers. 1% of the losing pool
goes to the treasury.

## What to know before automating

- The base rate is public: about 1.2% of launches reach the 4.2 ETH threshold, median 3 minutes for those that do
  (`evidence/pons-24h.json`, `evidence/pons-calibration.json`). A launch under 0.05 ETH at two minutes almost never
  sweeps; one past 3 ETH almost always does.
- A creator can buy their own curve to 4.2 ETH. That is the thing the market is about; price it.
- One-sided markets refund. Thin pools pay thin.
- The relay at `/api/rpc` forwards read-only calls only (`eth_call`, `eth_getLogs` bounded to one address and six hours
  of blocks, and block reads), 120 requests a minute per address.
- Not offered to persons in the United States or anywhere else it is not lawful.

## Addresses (chain 4663)

| what | address |
| --- | --- |
| market contract (v1) | `0xaC86B04D48033b2454b132EDED596E0c61A5b097` |
| Pons V2 factory it reads | `0x7eD598BcEf8bd9Edd8C97A195C6d13f40801EC7e` |
| Multicall3 | `0xcA11bde05977b3631167028862bE2a173976CA11` |

A v2 contract (a fee discount and a witness bounty for a bonded ZOLT token) is written and tested but not deployed;
`/api/markets` and this page will switch to it when it is, and `config.json` next to the API will say so.
