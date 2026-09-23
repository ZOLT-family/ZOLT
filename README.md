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
| `contracts/src/ZoltOddsV2.sol` | the same market with two jobs for the ZOLT token: a 0.5% fee for winners bonded with `discountBond`, a 0.2% witness bounty for a witness bonded with `keeperBond`; bonds lock seven days. Written and tested, not deployed (needs the token) |
| `contracts/test/ZoltOddsV2.t.sol` | 15 tests: bond lock, fee at claim, bounty only to a bonded witness, void pays neither, v1 word layout kept, conservation over 256 random markets |
| `contracts/scripts/deploy-odds.cjs` | the only script that can send a transaction. Dry-run unless `--yes`; checks the chain id, probes the factory, simulates, writes a plan |
| `keeper/odds-keeper.cjs` | records outcomes the moment they are knowable so no market waits on a holder. Dry-run unless `--send` |
| `site/` | the page: `template.html` + `build-site.cjs` → `index.html`, `zolt.html`, `public/`. The board reads the chain from the browser; staking signs through the reader's own wallet. §06 is the ZOLT panel (approve, bond, unbond), wired to the v2 build and off until `contracts/deploy/odds-v2-4663.deployed.json` exists; `ZOLT_V2_RECORD=… ZOLT_PREVIEW_OUT=… ZOLT_PREVIEW_RPC=… node site/build-site.cjs` builds one preview page against a local fork without touching `public/`. `og-template.html` → `og-card.html` → `public/og.png`: open the card page through `node site/serve.cjs` and it saves itself |
| `site/public/api/rpc.js` | a read-only JSON-RPC relay for readers whose network cannot reach the public RPC host |
| `site/public/api/markets.js` | `GET /api/markets`: the last 24 markets as JSON with pools, implied odds, deadlines and the exact stake calldata, for bots and agents. Read-only; `AGENTS.md` is the guide |
| `site/public/api/card.js`, `_card.cjs`, `m.js` | link-preview cards drawn on the server (satori + resvg, the page's fonts): `/api/card` for the site, `/api/card?id=N` for one market, and `/m/N`, the page with that market's preview tags. Falls back to `og.png` |
| `keeper/Dockerfile`, `railway.toml` | the keeper on its own for a host that stays up; the key comes from the environment only |
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
cd contracts && npx hardhat test solidity   # 60 Solidity tests (17 market, 15 market v2, 26 split guard, 2 fork)
node --test keeper/odds-logic.test.cjs      # 12 keeper tests
node --test site/site.test.cjs              # 13 page tests: figures match files, one transaction target, relay and API read-only, token section state
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

Done once, from a wallet (v1, 23 Sep 2026). Two ways; both leave the signing to you, and v2 will go the same way once the token exists (`site/deploy-v2.html`, `scripts/verify-odds-v2.cjs`).

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

## The keeper off this machine

`keeper/Dockerfile` runs the keeper alone (node 22, curl for the DNS-over-HTTPS reads, `viem` from `keeper/package.json`),
and `railway.toml` points Railway at it. Set `KEEPER_PRIVATE_KEY` and `ODDS_ADDRESS` in the service's variables and fund
the address with a little ETH; nothing in the image holds a key. A second key pair is made with
`node keeper/new-keeper-key.cjs --name cloud`. Since 23 Sep 2026 this runs as the Railway service `zolt-keeper`
(project of the same name), keeper address `0xe925c7c5FD5CaB9D665Cbb38654ABB855275Fa6E`; it reads the chain and
logs `LOW BALANCE` until that address holds ETH. Run one keeper per contract: two racing for the same outcome only
waste the loser's gas. `railway up --detach -y --service zolt-keeper` redeploys from a checkout; `.railwayignore`
keeps keys and dependencies out of the upload.

## For bots and agents

`GET https://zolt-smoky.vercel.app/api/markets` (or `?id=12`) returns every recent market with pools, implied odds,
deadlines and the calldata for a YES or NO stake. `AGENTS.md` explains the rest: how to stake, witness and claim from a
program, and what to know before automating it.

## Limits

- It reads the Pons V2 factory at `0x7ed598bcef8bd9edd8c97a195c6d13f40801ec7e`. A new factory means a new market.
- A creator can buy the curve to 4.2 ETH. That is the thing the market is about; price it.
- A graduation after the deadline that nobody witnessed voids the market. The keeper exists to keep that rare.
- A parimutuel pays what the other side staked. Thin pools pay thin.

Not affiliated with Pons, Robinhood Markets, Uniswap Labs or Whetstone Research.
