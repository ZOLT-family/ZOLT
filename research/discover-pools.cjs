// Step 1 of the evidence: which DEX pools hold a stock token whose multiplier has stepped?
// Reads Uniswap v4 Initialize events on the PoolManager and Uniswap v3 PoolCreated events on the factory.
const fs = require('fs');
const path = require('path');
const { createRequire } = require('module');
const { rpc, pad32, getLogsChunked } = require('./rpc.cjs');

const req = createRequire(path.join(__dirname, '..', 'contracts', 'package.json'));
const { keccak256, toHex, decodeAbiParameters } = req('viem');

const EVID = path.join(__dirname, '..', 'evidence');
const POOL_MANAGER = '0x8366a39cc670b4001a1121b8f6a443a643e40951'; // Uniswap docs, Robinhood Chain 4663
const QUOTER_V2 = '0x33e885ed0ec9bf04ecfb19341582aadcb4c8a9e7';

const T_INIT = keccak256(toHex('Initialize(bytes32,address,address,uint24,int24,address,uint160,int24)'));
const T_POOLCREATED = keccak256(toHex('PoolCreated(address,address,uint24,int24,address)'));

const assets = JSON.parse(fs.readFileSync(path.join(EVID, 'assets.json'), 'utf8')).assets;
const symOf = {};
for (const a of assets) symOf[a.deployments[0].contractAddress.toLowerCase()] = a.tokenSymbol;

const multLogs = JSON.parse(fs.readFileSync(path.join(EVID, 'mult_logs.json'), 'utf8')).result;
const stepped = [...new Set(multLogs.map((l) => l.address.toLowerCase()).filter((a) => symOf[a]))];
console.log('stepped tokens:', stepped.length);

const head = parseInt(rpc('eth_blockNumber', []), 16);
console.log('head', head);

// --- v4
const v4 = [];
for (const tok of stepped) {
  for (const slot of [2, 3]) {
    const topics = [T_INIT, null, null];
    topics[slot] = pad32(tok);
    const logs = getLogsChunked({ address: POOL_MANAGER, topics }, 0, head);
    for (const l of logs) {
      const [fee, tickSpacing, hooks, sqrtPriceX96, tick] = decodeAbiParameters(
        [{ type: 'uint24' }, { type: 'int24' }, { type: 'address' }, { type: 'uint160' }, { type: 'int24' }], l.data);
      const c0 = '0x' + l.topics[2].slice(26);
      const c1 = '0x' + l.topics[3].slice(26);
      v4.push({
        venue: 'v4', poolId: l.topics[1], stockToken: tok, sym: symOf[tok], stockSide: slot === 2 ? 0 : 1,
        currency0: c0, currency1: c1, other: slot === 2 ? c1 : c0,
        otherSym: symOf[(slot === 2 ? c1 : c0).toLowerCase()] || null,
        fee: Number(fee), tickSpacing: Number(tickSpacing), hooks, initBlock: parseInt(l.blockNumber, 16),
        initSqrtPriceX96: sqrtPriceX96.toString(), initTick: Number(tick),
      });
    }
  }
  process.stdout.write('.');
}
console.log('\nv4 pools with a stepped stock token:', v4.length);

// --- v3
let factory = null;
try {
  const r = rpc('eth_call', [{ to: QUOTER_V2, data: '0xc45a0155' }, 'latest']);
  factory = '0x' + r.slice(26);
} catch (e) { console.log('QuoterV2.factory() failed:', e.message.slice(0, 120)); }
console.log('v3 factory (from QuoterV2.factory()):', factory);

const v3 = [];
if (factory) {
  for (const tok of stepped) {
    for (const slot of [1, 2]) {
      const topics = [T_POOLCREATED, null, null];
      topics[slot] = pad32(tok);
      const logs = getLogsChunked({ address: factory, topics }, 0, head);
      for (const l of logs) {
        const [tickSpacing, pool] = decodeAbiParameters([{ type: 'int24' }, { type: 'address' }], l.data);
        const t0 = '0x' + l.topics[1].slice(26);
        const t1 = '0x' + l.topics[2].slice(26);
        v3.push({
          venue: 'v3', pool, stockToken: tok, sym: symOf[tok], stockSide: slot === 1 ? 0 : 1,
          token0: t0, token1: t1, other: slot === 1 ? t1 : t0,
          otherSym: symOf[(slot === 1 ? t1 : t0).toLowerCase()] || null,
          fee: parseInt(l.topics[3], 16), tickSpacing: Number(tickSpacing), createdBlock: parseInt(l.blockNumber, 16),
        });
      }
    }
    process.stdout.write('.');
  }
}
console.log('\nv3 pools with a stepped stock token:', v3.length);

const out = { head, poolManager: POOL_MANAGER, v3Factory: factory, topics: { T_INIT, T_POOLCREATED }, v4, v3 };
fs.writeFileSync(path.join(EVID, 'pools.json'), JSON.stringify(out, null, 1));

const bySym = {};
for (const p of [...v4, ...v3]) {
  bySym[p.sym] = bySym[p.sym] || { v4: 0, v3: 0, hooked: 0 };
  bySym[p.sym][p.venue]++;
  if (p.venue === 'v4' && p.hooks !== '0x0000000000000000000000000000000000000000') bySym[p.sym].hooked++;
}
console.log(JSON.stringify(bySym));
console.log('wrote evidence/pools.json');
