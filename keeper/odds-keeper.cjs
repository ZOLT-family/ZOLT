// Zolt Odds keeper: a backstop that records every outcome nobody else recorded, so no market waits on a holder.
//
// Dry run by default: it reads the chain and prints what it would send. Nothing is signed or sent unless
// --send is given together with KEEPER_PRIVATE_KEY. Anyone may run one; the contract does not care who calls.
//
//   node keeper/odds-keeper.cjs --odds 0x... --once          # one pass over new blocks, print the plan
//   node keeper/odds-keeper.cjs --odds 0x... --send          # loop, sign and send (needs KEEPER_PRIVATE_KEY)
//   options: --from-block N  --interval 5
//   --grace 120            seconds after a deadline before the keeper records NO (a winner may do it first, on their gas)
//   --all-markets          also witness empty and one-sided markets (default: only markets with money on both sides)
//   --tidy-gwei 0.3        below this gas price, close out empty and one-sided markets too (they are nearly free then)
//   --max-gwei 10          do not send while gas is above this (YES may go to 3x, it has a deadline)
//   --reserve 0.0005       stop sending when the keeper's balance falls to this many ETH; log loudly instead
//   --auto-open            also open a market on every young launch whose curve is showing life (default off)
//   --min-fill 0.2         curve fill that counts as life      --window 0     which window to open (0/1/2)
//   --max-fill 0.85        above this the curve crosses before anyone can stake; opening would only spend gas
//   --max-age 900          seconds since launch, at most        --max-opens 1  per pass
//   --max-open 3           keep at most this many markets open at once; the keeper refills, it does not flood
//   --open-max-gwei 0.3    auto-open only while gas is at or below this (an open is ~134k gas: 0.000007 ETH at 0.05 gwei)
//   another endpoint: RH_RPC=<url> (default: the public chain 4663 RPC, reached through DNS-over-HTTPS)
//
// Every pass writes keeper/health.json (block, balance, open markets, last actions, last error, spend); read it
// with keeper/status.cjs. A transaction that is not mined within 25 s is re-sent once with a 50% higher fee at
// the same nonce, so nothing queues up behind a stuck one.
const fs = require('fs');
const path = require('path');
// viem comes from keeper/node_modules when the keeper runs on its own (the Docker image), else from contracts/
const viemRequire = (function () {
  try { require.resolve('viem'); return require; } catch (e) { return require('module').createRequire(path.join(__dirname, '..', 'contracts', 'package.json')); }
})();
const { encodeFunctionData, decodeFunctionResult, parseAbi, getAddress } = viemRequire('viem');
const { rpc, hex, getLogsChunked, sleep } = require('../research/rpc.cjs');
const { planActions, planOpens, decodeMarketOpened, decodeTokenLaunched } = require('./odds-logic.cjs');

const arg = (name, dflt) => { const i = process.argv.indexOf('--' + name); return i > 0 ? process.argv[i + 1] : dflt; };
const flag = (name) => process.argv.includes('--' + name);

const ODDS = arg('odds', null);
const SEND = flag('send');
const INTERVAL = Number(arg('interval', '5'));
const AUTO_OPEN = flag('auto-open');
const MAX_GWEI = Number(arg('max-gwei', '10'));
const RESERVE_WEI = BigInt(Math.round(Number(arg('reserve', '0.0005')) * 1e6)) * 10n ** 12n;
const OPEN_CFG = { minFill: Number(arg('min-fill', '0.2')), maxFill: Number(arg('max-fill', '0.85')), window: Number(arg('window', '0')), maxAgeSeconds: Number(arg('max-age', '900')), maxPerPass: Number(arg('max-opens', '1')), maxOpen: Number(arg('max-open', '3')) };
const WITNESS_CFG = { graceSeconds: Number(arg('grace', '120')), onlyTwoSided: !flag('all-markets') };
const TIDY_GWEI = Number(arg('tidy-gwei', '0.3'));
const OPEN_MAX_GWEI = Number(arg('open-max-gwei', '0.3'));
const STATE_FILE = path.join(__dirname, 'odds-state.json');
const HEALTH_FILE = path.join(__dirname, 'health.json');
const T_OPENED = '0x13d3642a6d52374b58ee776c95940fcf6486c6f740891e6d11070c1411e1d3a8';
const T_LAUNCHED = '0x8d4aad4953d0ca700d468f3753aa14432d1b35b43ec6409f051fb6aa43a89607';

if (!ODDS) { console.error('pass --odds <ZoltOdds address>'); process.exit(1); }
if (SEND && !process.env.KEEPER_PRIVATE_KEY) { console.error('--send needs KEEPER_PRIVATE_KEY'); process.exit(1); }

const oddsAbi = parseAbi([
  'function factory() view returns (address)',
  'function market(uint256 id) view returns ((address token,uint40 openedAt,uint40 closesAt,uint40 deadline,uint8 window,uint8 outcome,uint128 yesPool,uint128 noPool,uint256 yesWeight,uint256 noWeight))',
  'function openMarket(address token, uint8 window) view returns (uint256)',
  'function open(address token, uint8 window)',
  'function witnessYes(uint256 id)',
  'function witnessNo(uint256 id)',
  'function voidUnobserved(uint256 id)',
]);
const curveAbi = parseAbi(['function realQuoteReserve() view returns (uint256)']);
const factoryAbi = parseAbi([
  'function getLaunchedToken(address token) view returns ((address token,address curve,address deployer,address creatorFeeRecipient,address pairToken,uint256 graduationThreshold,uint24 poolFee,int24 tickSpacing,uint16 creatorTaxBps,bool buybackEnabled,uint8 phase,uint256 sweptQuote,uint256 sweptTokens,uint256 sweptAt,bool exists))',
]);
const view = (abi, to, fn, args = []) => decodeFunctionResult({ abi, functionName: fn, data: rpc('eth_call', [{ to, data: encodeFunctionData({ abi, functionName: fn, args }) }, 'latest']) });

// Many reads in one eth_call through Multicall3, so a pass over a few hundred launches takes seconds, not minutes.
// A sub-call that reverts comes back as null.
const MULTICALL3 = '0xcA11bde05977b3631167028862bE2a173976CA11';
const mcAbi = parseAbi(['function aggregate3((address target,bool allowFailure,bytes callData)[] calls) view returns ((bool success,bytes returnData)[] returnData)']);
function multicall(reads) {
  const out = [];
  for (let i = 0; i < reads.length; i += 200) {
    const group = reads.slice(i, i + 200);
    const data = encodeFunctionData({ abi: mcAbi, functionName: 'aggregate3', args: [group.map((r) => ({ target: r.to, allowFailure: true, callData: encodeFunctionData({ abi: r.abi, functionName: r.fn, args: r.args || [] }) }))] });
    const res = decodeFunctionResult({ abi: mcAbi, functionName: 'aggregate3', data: rpc('eth_call', [{ to: MULTICALL3, data }, 'latest']) });
    res.forEach((r, k) => {
      const read = group[k];
      out.push(r.success && r.returnData !== '0x' ? decodeFunctionResult({ abi: read.abi, functionName: read.fn, data: r.returnData }) : null);
    });
  }
  return out;
}

function log(...m) { console.log(new Date().toISOString(), ...m); }

const FACTORY = getAddress(view(oddsAbi, ODDS, 'factory'));
const state = fs.existsSync(STATE_FILE) ? JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')) : { cursor: 0, open: {} };
let cursor = Number(arg('from-block', state.cursor || 0)) || parseInt(rpc('eth_blockNumber', []), 16) - 50000;
const open = state.open || {};
for (const m of Object.values(open)) { m.yesPool = BigInt(m.yesPool || 0); m.noPool = BigInt(m.noPool || 0); }

const account = SEND ? viemRequire('viem/accounts').privateKeyToAccount(process.env.KEEPER_PRIVATE_KEY) : null;
const health = { startedAt: new Date().toISOString(), keeper: account ? account.address : null, contract: ODDS, passes: 0, sends: 0, mined: 0, failed: 0, spentWei: 0n, lastActions: [], lastError: null };
log(`odds keeper ${SEND ? 'SEND as ' + account.address : 'dry run'} | contract ${ODDS} | factory ${FACTORY} | from block ${cursor} | ${Object.keys(open).length} open markets on file | gas cap ${MAX_GWEI} gwei | reserve ${Number(RESERVE_WEI) / 1e18} ETH`);

// ---------------------------------------------------------------- sending, with a fee bump for a stuck transaction
function gasPriceWei() { return BigInt(rpc('eth_gasPrice', [])); }

async function send(fn, args, urgent) {
  const gwei = Number(gasPriceWei()) / 1e9;
  const cap = urgent ? MAX_GWEI * 3 : MAX_GWEI;
  if (gwei > cap) throw new Error(`gas ${gwei.toFixed(2)} gwei is above the ${cap} gwei cap; deferred`);
  const balance = BigInt(rpc('eth_getBalance', [account.address, 'latest']));
  if (balance <= RESERVE_WEI) throw new Error(`balance ${Number(balance) / 1e18} ETH is at the reserve; fund ${account.address}`);

  const data = encodeFunctionData({ abi: oddsAbi, functionName: fn, args });
  const chainId = parseInt(rpc('eth_chainId', []), 16);
  const nonce = parseInt(rpc('eth_getTransactionCount', [account.address, 'latest']), 16);
  const gas = BigInt(rpc('eth_estimateGas', [{ from: account.address, to: ODDS, data }])) * 12n / 10n;
  let maxFeePerGas = gasPriceWei() * 2n;
  let hash = rpc('eth_sendRawTransaction', [await account.signTransaction({ chainId, nonce, to: ODDS, data, gas, maxFeePerGas, maxPriorityFeePerGas: 0n, type: 'eip1559' })]);
  health.sends++;
  let bumped = false;
  for (let waited = 0; waited < 45; waited += 3) {
    sleep(3000);
    const r = rpc('eth_getTransactionReceipt', [hash]);
    if (r) {
      const cost = BigInt(r.gasUsed) * BigInt(r.effectiveGasPrice);
      health.spentWei += cost;
      if (r.status !== '0x1') { health.failed++; throw new Error(`reverted ${hash}`); }
      health.mined++;
      return `${hash} mined in block ${parseInt(r.blockNumber, 16)} for ${(Number(cost) / 1e18).toFixed(6)} ETH${bumped ? ' (after a fee bump)' : ''}`;
    }
    if (waited >= 24 && !bumped) {
      maxFeePerGas = maxFeePerGas * 3n / 2n;
      hash = rpc('eth_sendRawTransaction', [await account.signTransaction({ chainId, nonce, to: ODDS, data, gas, maxFeePerGas, maxPriorityFeePerGas: 0n, type: 'eip1559' })]);
      bumped = true;
      log(`  ${fn} not mined after 24 s; re-sent at nonce ${nonce} with a 50% higher fee: ${hash}`);
    }
  }
  throw new Error(`still pending after 45 s: ${hash}`);
}

function writeHealth(extra) {
  const h = Object.assign({}, health, extra, { at: new Date().toISOString(), spentEth: Number(health.spentWei) / 1e18, open: Object.keys(open).length, lastActions: health.lastActions.slice(-10) });
  fs.writeFileSync(HEALTH_FILE, JSON.stringify(h, (k, v) => (typeof v === 'bigint' ? v.toString() : v), 1));
}

// ---------------------------------------------------------------- one pass
async function pass() {
  const head = parseInt(rpc('eth_blockNumber', []), 16);
  if (head > cursor) {
    for (const l of getLogsChunked({ address: ODDS, topics: [T_OPENED] }, cursor + 1, head)) {
      const m = decodeMarketOpened(l);
      open[m.id] = m;
      log(`market ${m.id} opened on ${m.token} window ${m.window}, deadline ${new Date(m.deadline * 1000).toISOString()}`);
    }
    cursor = head;
  }
  // refresh outcome, pools and phase for every market still on file: two multicalls, however many markets there are
  const phaseOf = {};
  const ids = Object.keys(open);
  if (ids.length) {
    const outcomes = multicall(ids.map((id) => ({ to: ODDS, abi: oddsAbi, fn: 'market', args: [BigInt(id)] })));
    ids.forEach((id, k) => {
      if (!outcomes[k]) return;
      open[id].outcome = Number(outcomes[k].outcome);
      open[id].yesPool = BigInt(outcomes[k].yesPool);
      open[id].noPool = BigInt(outcomes[k].noPool);
      if (open[id].outcome !== 0) { log(`market ${id} resolved: ${['open', 'YES', 'NO', 'void'][open[id].outcome]}`); delete open[id]; }
    });
    const tokens = [...new Set(Object.values(open).map((m) => m.token.toLowerCase()))];
    const phases = multicall(tokens.map((t) => ({ to: FACTORY, abi: factoryAbi, fn: 'getLaunchedToken', args: [t] })));
    tokens.forEach((t, k) => { if (phases[k]) phaseOf[t] = Number(phases[k].phase); });
  }
  const now = parseInt(rpc('eth_getBlockByNumber', ['latest', false]).timestamp, 16);
  // tidy mode: when gas is nearly free, also close out empty and one-sided markets so the ledger does not fill
  // with stale "open" rows; each costs a few hundred-thousandths of an ETH at that price
  const gasNow = Number(gasPriceWei()) / 1e9;
  const tidy = SEND && gasNow < TIDY_GWEI;
  const actions = planActions(Object.values(open), phaseOf, now, Object.assign({}, WITNESS_CFG, tidy ? { onlyTwoSided: false } : {}));
  for (const a of actions) {
    if (SEND) {
      try {
        const r = await send(a.fn, [BigInt(a.id)], a.fn === 'witnessYes');
        log(`${a.fn}(${a.id}): ${a.why} -> ${r}`);
        health.lastActions.push({ at: new Date().toISOString(), fn: a.fn, id: a.id, result: r.slice(0, 66) });
      } catch (e) {
        log(`${a.fn}(${a.id}) not sent: ${e.message.slice(0, 160)}`);
        health.lastError = { at: new Date().toISOString(), what: `${a.fn}(${a.id})`, why: e.message.slice(0, 200) };
      }
    } else {
      log(`would ${a.fn}(${a.id}): ${a.why}`);
    }
  }

  // optionally seed the board: launches of the last --max-age seconds whose curve shows life and has no market yet;
  // only while gas is cheap, so a quiet chain keeps the board alive and a memecoin rush does not drain the keeper
  let opens = [];
  // an unfunded keeper plans nothing: one line every 120 passes instead of a refusal per candidate
  const funded = !SEND || BigInt(rpc('eth_getBalance', [account.address, 'latest'])) > RESERVE_WEI;
  const openNow = AUTO_OPEN && gasNow <= OPEN_MAX_GWEI && funded;
  if (AUTO_OPEN && !openNow && health.passes % 120 === 0) {
    log(!funded ? `auto-open paused: balance is at the reserve; fund ${account.address}` : `auto-open paused: gas ${gasNow.toFixed(3)} gwei is above --open-max-gwei ${OPEN_MAX_GWEI}`);
  }
  if (openNow) {
    const span = Math.ceil(OPEN_CFG.maxAgeSeconds * 10) + 100;
    const launched = getLogsChunked({ address: FACTORY, topics: [T_LAUNCHED] }, head - span, head).map(decodeTokenLaunched);
    const reads = [];
    for (const l of launched) {
      reads.push({ to: FACTORY, abi: factoryAbi, fn: 'getLaunchedToken', args: [l.token] });
      reads.push({ to: l.curve, abi: curveAbi, fn: 'realQuoteReserve' });
      reads.push({ to: ODDS, abi: oddsAbi, fn: 'openMarket', args: [l.token, OPEN_CFG.window] });
    }
    const res = multicall(reads);
    const candidates = [];
    launched.forEach((l, k) => {
      const lt = res[k * 3], reserve = res[k * 3 + 1], slot = res[k * 3 + 2];
      if (!lt || !lt.exists || reserve === null || slot === null) return;
      const launchedAt = now - (head - l.block) / 10;
      candidates.push({ token: l.token, launchedAt, phase: Number(lt.phase), fill: l.threshold > 0n ? Number(reserve * 10000n / l.threshold) / 10000 : 0, hasOpen: Number(slot) !== 0 });
    });
    opens = planOpens(candidates, now, OPEN_CFG, Object.keys(open).length);
    for (const o of opens) {
      if (SEND) {
        try {
          const r = await send('open', [o.token, o.window], false);
          log(`open(${o.token}, ${o.window}): ${o.why} -> ${r}`);
          health.lastActions.push({ at: new Date().toISOString(), fn: 'open', token: o.token, result: r.slice(0, 66) });
        } catch (e) {
          log(`open(${o.token}) not sent: ${e.message.slice(0, 160)}`);
          health.lastError = { at: new Date().toISOString(), what: `open(${o.token})`, why: e.message.slice(0, 200) };
        }
      } else {
        log(`would open(${o.token}, window ${o.window}): ${o.why}`);
      }
    }
  }
  // pools are BigInts; the state file keeps them as strings and they are restored on load
  fs.writeFileSync(STATE_FILE, JSON.stringify({ cursor, open }, (k, v) => (typeof v === 'bigint' ? v.toString() : v), 1));
  health.passes++;
  const balance = account ? BigInt(rpc('eth_getBalance', [account.address, 'latest'])) : null;
  writeHealth({ head, balanceEth: balance === null ? null : Number(balance) / 1e18, gasGwei: Number(gasPriceWei()) / 1e9 });
  if (balance !== null && balance <= RESERVE_WEI && health.passes % 60 === 1) log(`LOW BALANCE: ${Number(balance) / 1e18} ETH at ${account.address}; the keeper will not send until it is funded`);
  return { head, open: Object.keys(open).length, actions: actions.length + opens.length };
}

(async () => {
  if (flag('once')) { const r = await pass(); log(`head ${r.head}: ${r.open} open market(s), ${r.actions} action(s)`); return; }
  for (;;) {
    try { await pass(); } catch (e) { log('pass failed:', e.message.slice(0, 200)); health.lastError = { at: new Date().toISOString(), what: 'pass', why: e.message.slice(0, 200) }; try { writeHealth({}); } catch (e2) { /* the log line is enough */ } }
    sleep(INTERVAL * 1000);
  }
})();
