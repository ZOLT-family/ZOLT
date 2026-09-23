# Zolt Odds

Every few seconds someone launches a token on Pons, the largest launchpad on Robinhood Chain (4663). About one
in a hundred reaches the 4.2 ETH that moves it from its bonding curve into a real pool. That crossing is a single,
objective moment written into Pons's own factory contract.

Zolt Odds is a Yes/No market on that moment: will this launch graduate before the deadline? Parimutuel, settled
by reading the factory's state, with no oracle, no committee and no owner.

**Status: deployed on chain 4663 at `0xaC86B04D48033b2454b132EDED596E0c61A5b097` (23 Sep 2026), source verified on
[Sourcify](https://repo.sourcify.dev/4663/0xaC86B04D48033b2454b132EDED596E0c61A5b097) (runtime and creation match).**
Event contracts on outcomes; not offered to persons in the United States or anywhere else they are not lawful.
Nothing here is investment advice. Stake what you can lose in a bug.

## What is in here

| path | what it is |
| --- | --- |
| `contracts/src/ZoltOdds.sol` | the market: open, stake (time-weighted), witnessYes / witnessNo / voidUnobserved, claim. 1% of the losing pool to a fixed treasury |
| `contracts/test/ZoltOdds.t.sol` | 17 tests, including every-wei conservation over 256 random markets and a re-entrancy attempt |
| `contracts/scripts/deploy-odds.cjs` | the only script that can send a transaction. Dry-run unless `--yes`; checks the chain id, probes the factory, simulates, writes a plan |
| `keeper/odds-keeper.cjs` | records outcomes the moment they are knowable so no market waits on a holder. Dry-run unless `--send` |
| `site/` | the page: `template.html` + `build-site.cjs` → `index.html`, `zolt.html`, `public/`. The board reads the chain from the browser; staking signs through the reader's own wallet. `og-template.html` → `og-card.html` → `public/og.png`: open the card page through `node site/serve.cjs` and it saves itself |
| `site/public/api/rpc.js` | a read-only JSON-RPC relay for readers whose network cannot reach the public RPC host |
| `research/` | read-only scripts; `evidence/pons-24h.json` and `evidence/pons-calibration.json` are the base rate the page quotes |
| `contracts/src/Zolt.sol`, `ZoltDopplerModule.sol`, `StepMath.sol` | the earlier work: a Uniswap v4 hook that prices ERC-8056 stock-token splits into swaps. Tested (26), not deployed, kept as an appendix; its page is archived at `/guard` |

## How a market resolves

Pons's factory keeps a `phase` per launch: `NotGraduated`, then `Swept` the instant a buy crosses the threshold,
then `PoolCreated` (or `Rescued`). Leaving `NotGraduated` is the event.

- `witnessYes(id)`: allowed while `block.timestamp <= deadline` and phase is not `NotGraduated`.
- `witnessNo(id)`: allowed once `block.timestamp > deadline` and phase is still `NotGraduated`.
- `voidUnobserved(id)`: a day after the deadline, if neither was recorded (the launch graduated after the deadline
  before anyone recorded NO). Every stake is refunded.

Stakes carry weight equal to size × seconds until staking closes (the first half of the window), so a stake
placed when the answer is nearly known earns almost nothing from the pot. Once a launch graduates, stakes stop.

## Tests

```bash
cd contracts && npx hardhat test solidity   # 43 Solidity tests (17 market, 26 split guard)
node --test keeper/odds-logic.test.cjs      # 9 keeper tests
node --test site/site.test.cjs              # 11 page tests: figures match files, one transaction target, relay is read-only
node --test site/encoding.test.cjs          # the page's hand-rolled calldata and struct decoding held to viem's, on a real return value
```

Against Pons's real contracts, on a fork of mainnet (opt-in; needs an RPC the test runner can reach and a launch
that is still on its curve at the fork block — pick one from the board):

```bash
cd contracts && RH_FORK=1 RH_FORK_RPC=https://rpc.mainnet.chain.robinhood.com RH_FORK_TOKEN=0x… npx hardhat test solidity --grep fork
```

The YES test buys the launch's curve from many wallets until Pons's factory itself moves the phase to `Swept`, then
resolves and claims; the NO test warps past the deadline. The last recorded run is in `evidence/fork-run.txt`.

## Reproducing the base rate

```bash
node research/pons-24h.cjs           # launches, graduations, time to graduation, pair tokens -> evidence/pons-24h.json
node research/pons-calibration.cjs   # curve fill at 2 and 10 minutes vs sweeping within the hour -> evidence/pons-calibration.json
```

The 24-hour measurement reads `TokenLaunched` and `PoolGraduated` from the factory; the calibration reads `CurveBuy`
and `CurveSell` on every sampled curve, because the public node is not an archive node and historical balances
are not available. Both go through `research/rpc.cjs` (curl with DNS-over-HTTPS; override with `RH_RPC`).

## Deploying

Not done, and not something this repo will do for you. Two ways; both leave the signing to you.

From a wallet, no key on disk:

```bash
node site/build-site.cjs && node site/serve.cjs      # then open http://localhost:4521/deploy.html
cd contracts && node scripts/deploy-odds.cjs --chain 4663 --verify 0x…   # record and check what the wallet created
```

From a key file:

```bash
cd contracts
node scripts/deploy-odds.cjs --chain 4663                          # dry run, writes deploy/odds-4663.json
node scripts/deploy-odds.cjs --chain 4663 --treasury 0x… --yes     # signs with DEPLOYER_PRIVATE_KEY or --key-file
```

Then, either way:

```bash
node keeper/new-keeper-key.cjs                                     # a burner for the keeper; fund its address with a little ETH
KEEPER_PRIVATE_KEY=$(cat keeper/keeper.key) node keeper/odds-keeper.cjs --odds 0x… --send [--auto-open --max-open 1 --window 1 --open-max-gwei 0.3]   # auto-open only while gas is cheap
node site/build-site.cjs                                           # the page picks up deploy/odds-4663.deployed.json and switches the board on
```

The deployment record is `contracts/deploy/odds-4663.deployed.json`; the page and the keeper read it.

## Limits

- It reads the Pons V2 factory at `0x7ed598bcef8bd9edd8c97a195c6d13f40801ec7e`. A new factory means a new market.
- A creator can buy the curve to 4.2 ETH. That is the thing the market is about; price it.
- A graduation after the deadline that nobody witnessed voids the market. The keeper exists to keep that rare.
- A parimutuel pays what the other side staked. Thin pools pay thin.

Not affiliated with Pons, Robinhood Markets, Uniswap Labs or Whetstone Research.
