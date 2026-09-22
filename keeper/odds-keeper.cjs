// Zolt Odds keeper: be the first to record every outcome, so no market waits on a holder to press the button.
//
// Dry run by default: it reads the chain and prints what it would send. Nothing is signed or sent unless
// --send is given together with KEEPER_PRIVATE_KEY. Anyone may run one; the contract does not care who calls.
//
//   node keeper/odds-keeper.cjs --odds 0x... --once          # one pass over new blocks, print the plan
//   node keeper/odds-keeper.cjs --odds 0x... --send          # loop, sign and send (needs KEEPER_PRIVATE_KEY)
//   options: --from-block N  --interval 5
//   --auto-open            also open a market on every young launch whose curve is showing life (default off)
//   --min-fill 0.2         curve fill that counts as life      --window 0     which window to open (0/1/2)
//   --max-age 900          seconds since launch, at most        --max-opens 5  per pass
//   another endpoint: RH_RPC=<url> (default: the public chain 4663 RPC, reached through DNS-over-HTTPS)
const fs = require('fs');
const path = require('path');
const viemRequire = require('module').createRequire(path.join(__dirname, '..', 'contracts', 'package.json'));
const { encodeFunctionData, decodeFunctionResult, parseAbi, getAddress } = viemRequire('viem');
const { rpc, hex, getLogsChunked, sleep } = require('../research/rpc.cjs');
const { planActions, planOpens, decodeMarketOpened, decodeTokenLaunched } = require('./odds-logic.cjs');

const arg = (name, dflt) => { const i = process.argv.indexOf('--' + name); return i > 0 ? process.argv[i + 1] : dflt; };
const flag = (name) => process.argv.includes('--' + name);

const ODDS = arg('odds', null);
const SEND = flag('send');
const INTERVAL = Number(arg('interval', '5'));
const AUTO_OPEN = flag('auto-open');
const OPEN_CFG = { minFill: Number(arg('min-fill', '0.2')), window: Number(arg('window', '0')), maxAgeSeconds: Number(arg('max-age', '900')), maxPerPass: Number(arg('max-opens', '5')) };
const STATE_FILE = path.join(__dirname, 'odds-state.json');
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
log(`odds keeper ${SEND ? 'SEND' : 'dry run'} | contract ${ODDS} | factory ${FACTORY} | from block ${cursor} | ${Object.keys(open).length} open markets on file`);

async function send(fn, args) {
  const { privateKeyToAccount } = viemRequire('viem/accounts');
  const account = privateKeyToAccount(process.env.KEEPER_PRIVATE_KEY);
  const data = encodeFunctionData({ abi: oddsAbi, functionName: fn, args });
  const chainId = parseInt(rpc('eth_chainId', []), 16);
  const nonce = parseInt(rpc('eth_getTransactionCount', [account.address, 'pending']), 16);
  const gas = BigInt(rpc('eth_estimateGas', [{ from: account.address, to: ODDS, data }])) * 12n / 10n;
  const base = BigInt(rpc('eth_gasPrice', []));
  const signed = await account.signTransaction({ chainId, nonce, to: ODDS, data, gas, maxFeePerGas: base * 2n, maxPriorityFeePerGas: 0n, type: 'eip1559' });
  return rpc('eth_sendRawTransaction', [signed]);
}

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
  // refresh outcome and phase for every market still on file: two multicalls, however many markets there are
  const phaseOf = {};
  const ids = Object.keys(open);
  if (ids.length) {
    const outcomes = multicall(ids.map((id) => ({ to: ODDS, abi: oddsAbi, fn: 'market', args: [BigInt(id)] })));
    ids.forEach((id, k) => {
      if (!outcomes[k]) return;
      open[id].outcome = Number(outcomes[k].outcome);
      if (open[id].outcome !== 0) { log(`market ${id} resolved: ${['open', 'YES', 'NO', 'void'][open[id].outcome]}`); delete open[id]; }
    });
    const tokens = [...new Set(Object.values(open).map((m) => m.token.toLowerCase()))];
    const phases = multicall(tokens.map((t) => ({ to: FACTORY, abi: factoryAbi, fn: 'getLaunchedToken', args: [t] })));
    tokens.forEach((t, k) => { if (phases[k]) phaseOf[t] = Number(phases[k].phase); });
  }
  const now = parseInt(rpc('eth_getBlockByNumber', ['latest', false]).timestamp, 16);
  const actions = planActions(Object.values(open), phaseOf, now);
  for (const a of actions) {
    if (SEND) {
      try { log(`${a.fn}(${a.id}): ${a.why} -> sent ${await send(a.fn, [BigInt(a.id)])}`); } catch (e) { log(`${a.fn}(${a.id}) failed: ${e.message.slice(0, 160)}`); }
    } else {
      log(`would ${a.fn}(${a.id}): ${a.why}`);
    }
  }

  // optionally seed the board: launches of the last --max-age seconds whose curve shows life and has no market yet
  let opens = [];
  if (AUTO_OPEN) {
    const span = Math.ceil(OPEN_CFG.maxAgeSeconds * 10) + 100;
    const launched = getLogsChunked({ address: FACTORY, topics: [T_LAUNCHED] }, head - span, head).map(decodeTokenLaunched);
    // three reads per launch, all in a few multicalls
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
    opens = planOpens(candidates, now, OPEN_CFG);
    for (const o of opens) {
      if (SEND) {
        try { log(`open(${o.token}, ${o.window}): ${o.why} -> sent ${await send('open', [o.token, o.window])}`); } catch (e) { log(`open(${o.token}) failed: ${e.message.slice(0, 160)}`); }
      } else {
        log(`would open(${o.token}, window ${o.window}): ${o.why}`);
      }
    }
  }
  fs.writeFileSync(STATE_FILE, JSON.stringify({ cursor, open }, null, 1));
  return { head, open: Object.keys(open).length, actions: actions.length + opens.length };
}

(async () => {
  if (flag('once')) { const r = await pass(); log(`head ${r.head}: ${r.open} open market(s), ${r.actions} action(s)`); return; }
  for (;;) {
    try { await pass(); } catch (e) { log('pass failed:', e.message.slice(0, 200)); }
    sleep(INTERVAL * 1000);
  }
})();
