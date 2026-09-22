// Stepguard keeper: watch UIMultiplierUpdated on the stock tokens and poke the Doppler module for every
// registered asset, so the step fee is set before the first trade instead of after it.
//
// Dry run by default: it reads the chain and prints what it would send. Nothing is signed or sent unless
// --send is given together with KEEPER_PRIVATE_KEY and --module.
//
//   node keeper/keeper.cjs --replay                      # walk the recorded 31 steps (evidence/mult_logs.json)
//   node keeper/keeper.cjs --module 0x... --once         # one pass over new blocks, print the plan
//   node keeper/keeper.cjs --module 0x... --send         # loop, sign and send pokes (needs KEEPER_PRIVATE_KEY)
//   options: --from-block N  --interval 15  --lookahead 7200  --window 86400
//   another endpoint: RH_RPC=<url> (default: the public chain 4663 RPC, reached through DNS-over-HTTPS)
//
// viem is loaded from contracts/node_modules (npm install there first).
const fs = require('fs');
const path = require('path');
const viemRequire = require('module').createRequire(require('path').join(__dirname, '..', 'contracts', 'package.json'));
const { encodeFunctionData, parseAbi } = viemRequire('viem');
const { rpc, hex, getLogsChunked, sleep } = require('../research/rpc.cjs');
const { T_STEP, T_REGISTERED, decodeStep, indexRegistrations, planPokes } = require('./logic.cjs');

const arg = (name, dflt) => { const i = process.argv.indexOf('--' + name); return i > 0 ? process.argv[i + 1] : dflt; };
const flag = (name) => process.argv.includes('--' + name);

const ROOT = path.join(__dirname, '..');
const STATE_FILE = path.join(__dirname, 'state.json');
const MODULE = arg('module', null);
const SEND = flag('send');
const CFG = { lookahead: Number(arg('lookahead', '7200')), guardWindow: Number(arg('window', '86400')) };
const INTERVAL = Number(arg('interval', '15'));
const moduleAbi = parseAbi(['function poke(address asset)']);

const tokens = JSON.parse(fs.readFileSync(path.join(ROOT, 'evidence', 'assets.json'), 'utf8')).assets
  .map((a) => a.deployments[0].contractAddress);
const symOf = {};
for (const a of JSON.parse(fs.readFileSync(path.join(ROOT, 'evidence', 'assets.json'), 'utf8')).assets) {
  symOf[a.deployments[0].contractAddress.toLowerCase()] = a.tokenSymbol;
}

function log(...m) { console.log(new Date().toISOString(), ...m); }

// ---------------------------------------------------------------- replay: what would it have done?
if (flag('replay')) {
  const logs = JSON.parse(fs.readFileSync(path.join(ROOT, 'evidence', 'mult_logs.json'), 'utf8')).result
    .filter((l) => symOf[l.address.toLowerCase()]);
  let n = 0;
  for (const l of logs) {
    const s = decodeStep(l);
    const emitTs = parseInt(rpc('eth_getBlockByNumber', [l.blockNumber, false]).timestamp, 16);
    const lead = s.effectiveAt - emitTs;
    const inWindow = lead <= CFG.lookahead;
    n++;
    log(`${String(n).padStart(2)} ${symOf[s.token].padEnd(5)} posted block ${s.block}, effective in ${lead}s -> ${inWindow ? 'poke at once' : `poke from ${new Date((s.effectiveAt - CFG.lookahead) * 1000).toISOString()}`}`);
  }
  log(`replayed ${n} schedule events. With no module deployed there are no registered assets, so nothing would be sent.`);
  process.exit(0);
}

// ---------------------------------------------------------------- live
if (SEND && (!MODULE || !process.env.KEEPER_PRIVATE_KEY)) {
  console.error('--send needs --module and KEEPER_PRIVATE_KEY');
  process.exit(1);
}
const state = fs.existsSync(STATE_FILE) ? JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')) : {};
let cursor = Number(arg('from-block', state.cursor || 0)) || parseInt(rpc('eth_blockNumber', []), 16) - 20000;
const recent = (state.recent || []).map((s) => ({ ...s, oldMultiplier: BigInt(s.oldMultiplier), newMultiplier: BigInt(s.newMultiplier) }));
const lastPoke = state.lastPoke || {};

async function sendPoke(asset) {
  const { privateKeyToAccount } = viemRequire('viem/accounts');
  const account = privateKeyToAccount(process.env.KEEPER_PRIVATE_KEY);
  const data = encodeFunctionData({ abi: moduleAbi, functionName: 'poke', args: [asset] });
  const chainId = parseInt(rpc('eth_chainId', []), 16);
  const nonce = parseInt(rpc('eth_getTransactionCount', [account.address, 'pending']), 16);
  const gas = BigInt(rpc('eth_estimateGas', [{ from: account.address, to: MODULE, data }])) * 12n / 10n;
  const base = BigInt(rpc('eth_gasPrice', []));
  const signed = await account.signTransaction({ chainId, nonce, to: MODULE, data, gas, maxFeePerGas: base * 2n, maxPriorityFeePerGas: 0n, type: 'eip1559' });
  return rpc('eth_sendRawTransaction', [signed]);
}

async function pass() {
  const head = parseInt(rpc('eth_blockNumber', []), 16);
  const nowTs = parseInt(rpc('eth_getBlockByNumber', [hex(head), false]).timestamp, 16);
  if (head > cursor) {
    const fresh = getLogsChunked({ address: tokens, topics: [T_STEP] }, cursor + 1, head).map(decodeStep);
    for (const s of fresh) log(`schedule: ${symOf[s.token] || s.token} ${Number(s.oldMultiplier) / 1e18} -> ${Number(s.newMultiplier) / 1e18} effective ${new Date(s.effectiveAt * 1000).toISOString()} (block ${s.block})`);
    recent.push(...fresh);
    cursor = head;
  }
  // keep only steps whose guard window is still open
  for (let i = recent.length - 1; i >= 0; i--) if (nowTs > recent[i].effectiveAt + CFG.guardWindow) recent.splice(i, 1);

  let registrations = new Map();
  if (MODULE) registrations = indexRegistrations(getLogsChunked({ address: MODULE, topics: [T_REGISTERED] }, 0, head));
  const plan = planPokes(recent, registrations, nowTs, CFG)
    .filter((p) => !lastPoke[p.asset] || nowTs - lastPoke[p.asset] >= 60); // at most once a minute per asset
  for (const p of plan) {
    if (!SEND) { log(`would poke ${p.asset} (${symOf[p.token] || p.token}, ${p.reason})`); continue; }
    try {
      const txHash = await sendPoke(p.asset);
      lastPoke[p.asset] = nowTs;
      log(`poked ${p.asset} (${symOf[p.token] || p.token}, ${p.reason}) tx ${txHash}`);
    } catch (e) { log(`poke ${p.asset} failed: ${e.message.slice(0, 160)}`); }
  }
  if (!MODULE) log(`head ${head}: ${recent.length} step(s) inside a guard window; no --module given, so no assets to poke`);
  fs.writeFileSync(STATE_FILE, JSON.stringify({
    cursor, lastPoke,
    recent: recent.map((s) => ({ ...s, oldMultiplier: s.oldMultiplier.toString(), newMultiplier: s.newMultiplier.toString() })),
  }, null, 1));
}

(async () => {
  log(`keeper ${SEND ? 'SENDING' : 'dry run'} | module ${MODULE || 'none'} | from block ${cursor + 1} | lookahead ${CFG.lookahead}s window ${CFG.guardWindow}s`);
  do {
    try { await pass(); } catch (e) { log('pass failed:', e.message.slice(0, 200)); }
    if (flag('once')) break;
    sleep(INTERVAL * 1000);
  } while (true);
})();
