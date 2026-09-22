// Zolt Odds keeper: be the first to record every outcome, so no market waits on a holder to press the button.
//
// Dry run by default: it reads the chain and prints what it would send. Nothing is signed or sent unless
// --send is given together with KEEPER_PRIVATE_KEY. Anyone may run one; the contract does not care who calls.
//
//   node keeper/odds-keeper.cjs --odds 0x... --once          # one pass over new blocks, print the plan
//   node keeper/odds-keeper.cjs --odds 0x... --send          # loop, sign and send (needs KEEPER_PRIVATE_KEY)
//   options: --from-block N  --interval 5
//   another endpoint: RH_RPC=<url> (default: the public chain 4663 RPC, reached through DNS-over-HTTPS)
const fs = require('fs');
const path = require('path');
const viemRequire = require('module').createRequire(path.join(__dirname, '..', 'contracts', 'package.json'));
const { encodeFunctionData, decodeFunctionResult, parseAbi, getAddress } = viemRequire('viem');
const { rpc, hex, getLogsChunked, sleep } = require('../research/rpc.cjs');
const { planActions, decodeMarketOpened } = require('./odds-logic.cjs');

const arg = (name, dflt) => { const i = process.argv.indexOf('--' + name); return i > 0 ? process.argv[i + 1] : dflt; };
const flag = (name) => process.argv.includes('--' + name);

const ODDS = arg('odds', null);
const SEND = flag('send');
const INTERVAL = Number(arg('interval', '5'));
const STATE_FILE = path.join(__dirname, 'odds-state.json');
const T_OPENED = '0x13d3642a6d52374b58ee776c95940fcf6486c6f740891e6d11070c1411e1d3a8';

if (!ODDS) { console.error('pass --odds <ZoltOdds address>'); process.exit(1); }
if (SEND && !process.env.KEEPER_PRIVATE_KEY) { console.error('--send needs KEEPER_PRIVATE_KEY'); process.exit(1); }

const oddsAbi = parseAbi([
  'function factory() view returns (address)',
  'function market(uint256 id) view returns ((address token,uint40 openedAt,uint40 closesAt,uint40 deadline,uint8 window,uint8 outcome,uint128 yesPool,uint128 noPool,uint256 yesWeight,uint256 noWeight))',
  'function witnessYes(uint256 id)',
  'function witnessNo(uint256 id)',
  'function voidUnobserved(uint256 id)',
]);
const factoryAbi = parseAbi([
  'function getLaunchedToken(address token) view returns ((address token,address curve,address deployer,address creatorFeeRecipient,address pairToken,uint256 graduationThreshold,uint24 poolFee,int24 tickSpacing,uint16 creatorTaxBps,bool buybackEnabled,uint8 phase,uint256 sweptQuote,uint256 sweptTokens,uint256 sweptAt,bool exists))',
]);
const view = (abi, to, fn, args = []) => decodeFunctionResult({ abi, functionName: fn, data: rpc('eth_call', [{ to, data: encodeFunctionData({ abi, functionName: fn, args }) }, 'latest']) });

function log(...m) { console.log(new Date().toISOString(), ...m); }

const FACTORY = getAddress(view(oddsAbi, ODDS, 'factory'));
const state = fs.existsSync(STATE_FILE) ? JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')) : { cursor: 0, open: {} };
let cursor = Number(arg('from-block', state.cursor || 0)) || parseInt(rpc('eth_blockNumber', []), 16) - 50000;
const open = state.open || {};
log(`odds keeper ${SEND ? 'SEND' : 'dry run'} | contract ${ODDS} | factory ${FACTORY} | from block ${cursor} | ${Object.keys(open).length} open markets on file`);

async function send(fn, id) {
  const { privateKeyToAccount } = viemRequire('viem/accounts');
  const account = privateKeyToAccount(process.env.KEEPER_PRIVATE_KEY);
  const data = encodeFunctionData({ abi: oddsAbi, functionName: fn, args: [BigInt(id)] });
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
  // refresh outcome and phase for every market still on file
  const phaseOf = {};
  for (const id of Object.keys(open)) {
    const m = open[id];
    const onChain = view(oddsAbi, ODDS, 'market', [BigInt(id)]);
    m.outcome = Number(onChain.outcome);
    if (m.outcome !== 0) { log(`market ${id} resolved: ${['open', 'YES', 'NO', 'void'][m.outcome]}`); delete open[id]; continue; }
    if (phaseOf[m.token.toLowerCase()] === undefined) phaseOf[m.token.toLowerCase()] = Number(view(factoryAbi, FACTORY, 'getLaunchedToken', [m.token]).phase);
  }
  const now = parseInt(rpc('eth_getBlockByNumber', ['latest', false]).timestamp, 16);
  const actions = planActions(Object.values(open), phaseOf, now);
  for (const a of actions) {
    if (SEND) {
      try { log(`${a.fn}(${a.id}): ${a.why} -> sent ${await send(a.fn, a.id)}`); } catch (e) { log(`${a.fn}(${a.id}) failed: ${e.message.slice(0, 160)}`); }
    } else {
      log(`would ${a.fn}(${a.id}): ${a.why}`);
    }
  }
  fs.writeFileSync(STATE_FILE, JSON.stringify({ cursor, open }, null, 1));
  return { head, open: Object.keys(open).length, actions: actions.length };
}

(async () => {
  if (flag('once')) { const r = await pass(); log(`head ${r.head}: ${r.open} open market(s), ${r.actions} action(s)`); return; }
  for (;;) {
    try { await pass(); } catch (e) { log('pass failed:', e.message.slice(0, 200)); }
    sleep(INTERVAL * 1000);
  }
})();
