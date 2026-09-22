# Zolt

A stock token on Robinhood Chain (4663) can change what one token stands for. The issuer posts a new
multiplier and the second it takes effect; at that second every balance means more shares. Nothing moves in
a pool that holds it — no transfer, no event, no new price — so the pool keeps quoting the old share count
and the first trader takes the difference from the LPs.

Zolt is a Uniswap v4 hook that reads the same notice the pool ignores and charges the gap to whoever trades
into it.

**Status: unaudited, unsigned, not deployed.** No liquidity should sit behind this contract until an
independent audit. Nothing here is investment advice.

## What is in here

| path | what it is |
| --- | --- |
| `contracts/src/Zolt.sol` | the v4 hook: registers a pool's stock side, arms on a scheduled multiplier, charges `1 − P/T` to the one direction that would take value, clears when the pool catches up |
| `contracts/src/ZoltDopplerModule.sol` | the same maths as a Doppler plug-in, for new Doppler launches. Runs *after* a swap, woken by a keeper, and Doppler caps a module's fee at 10% — it softens a split, it does not stop one |
| `contracts/src/StepMath.sol` | the formula on its own, small enough for the authors of existing modules to adopt |
| `contracts/scripts/mine-salt.cjs` | mines the CREATE2 salt that puts the hook's permission bits in its address, simulates the deploy, writes `contracts/deploy/zolt-<chainId>.json` (unsigned) |
| `contracts/scripts/send-deploy.cjs` | the only script that can send a transaction. Dry-run unless `--yes`; re-checks the build, the chain id, the empty address and a live simulation first |
| `keeper/` | watches for `UIMultiplierUpdated`, pokes the Doppler module before the step lands. Dry-run by default |
| `research/` | the read-only scripts that produced everything in `evidence/` |
| `evidence/` | what the chain actually said, as JSON. Every number on the site traces to a file here |
| `site/` | the page: `template.html` + `build-site.cjs` → `index.html`, `zolt.html`, `public/` |

## Reproducing the evidence

All of it is read-only. The RPC goes through `curl --doh-url` because the local ISP hijacks DNS for the
RPC host; override the endpoint with `RH_RPC` and the pacing with `RH_GAP_MS`.

```bash
node research/fetch-mult-logs.cjs     # every UIMultiplierUpdated log -> evidence/mult_logs.json
node research/discover-pools.cjs      # every v4 and v3 pool holding a stock token -> evidence/pools.json
node research/measure-steps.cjs       # what happened around each step -> evidence/steps.json
node research/analyze-steps.cjs       # what is attributable to the step itself -> evidence/steps-attributed.json
node research/exposure-census.cjs     # what is sitting in pools today -> evidence/exposure.json
node research/crwd-history.cjs        # the one pool that held CRWD at its x4
node research/doppler-probe.cjs       # Doppler pools and module slots -> evidence/doppler.json
node research/doppler-authorities.cjs # who may change a module -> evidence/doppler-authorities.json
```

`fetch-mult-logs.cjs` is incremental: it starts from the last log on disk unless you pass `--full`. When it
prints new logs, the four scripts after it need rerunning and the site needs rebuilding.

## Tests

```bash
cd contracts && npx hardhat test    # 26 Solidity tests against Uniswap's own v4-core PoolManager
node --test keeper/logic.test.cjs   # 5 keeper tests
```

`contracts/test/Deployment.t.sol` mines a salt inside the EVM and deploys the real bytecode — no `vm.etch`,
so the address the tests use is the address the deploy script would produce.

## The site

```bash
node site/build-site.cjs            # evidence + template -> site/index.html, zolt.html, public/
node site/serve.cjs                 # http://localhost:4521
```

The builder throws if the template asks for a value it cannot source from `evidence/`, which is the point:
the page cannot claim a number that no file backs.

## Deploying

Not done, and not something this repo will do for you.

```bash
cd contracts
node scripts/mine-salt.cjs --chain 4663      # writes the unsigned plan
node scripts/send-deploy.cjs --chain 4663    # dry run, prints what it would send
node scripts/send-deploy.cjs --chain 4663 --yes   # signs, with DEPLOYER_PRIVATE_KEY or --key-file
```

The key never appears in the output. After an audit, and only after one.

## What this cannot do

- **No pool that exists today.** A pool's hook is fixed when the pool is created, and almost every Doppler
  module slot is frozen behind a burned timelock. The value already in pools stays exposed.
- **The Doppler module only softens.** 10% cap, and it hears about a swap after it happens.
- **It cannot move a pool's price.** It charges the gap; the pool catches up as trades arrive.
- **It fails open.** If a token stops answering the ERC-8056 reads, the pool trades at the normal fee.

Stock tokens on Robinhood Chain are tokenised debt securities issued by Robinhood Assets (Jersey) Ltd. This
project is not affiliated with Robinhood Markets, Uniswap Labs or Whetstone Research.
