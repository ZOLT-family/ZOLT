// Can the Zolt Doppler module actually reach the Doppler pools? Read-only.
//   1. Who governs module enablement: DopplerHookInitializer.airlock() -> Airlock.owner(); EOA or contract?
//   2. For every Doppler pool holding a stepped stock token: getState(asset) -> status, dopplerHook slot.
//      A module can only be attached to a pool in status Locked, and the slot holds one module.
//   3. Which modules already sit in those slots, and whether they are enabled with ON_SWAP.
//   4. For a sample of assets: who may attach a module (Airlock.getAssetData(asset).timelock), EOA or contract.
// Output: evidence/doppler.json
const fs = require('fs');
const path = require('path');
const { createRequire } = require('module');
const { rpc } = require('./rpc.cjs');

const req = createRequire(path.join(__dirname, '..', 'contracts', 'package.json'));
const { encodeFunctionData, decodeFunctionResult, parseAbi } = req('viem');

const EVID = path.join(__dirname, '..', 'evidence');
const MULTICALL3 = '0xcA11bde05977b3631167028862bE2a173976CA11';
const INITIALIZER = '0x4e3468951d49f2eea976ed0d6e75ffcb44a9a544';
const STATUS = ['Uninitialized', 'Initialized', 'Locked', 'Graduated', 'Exited'];

const mcAbi = parseAbi(['function aggregate3((address target, bool allowFailure, bytes callData)[] calls) payable returns ((bool success, bytes returnData)[])']);
const initAbi = parseAbi([
  'function airlock() view returns (address)',
  'function isDopplerHookEnabled(address) view returns (uint256)',
  'function getState(address asset) view returns (address numeraire, uint256 totalTokensOnBondingCurve, address dopplerHook, bytes graduationDopplerHookCalldata, uint8 status, (address currency0, address currency1, uint24 fee, int24 tickSpacing, address hooks) poolKey, int24 farTick)',
]);
const airlockAbi = parseAbi([
  'function owner() view returns (address)',
  'function getAssetData(address asset) view returns (address numeraire, address timelock, address governance, address liquidityMigrator, address poolInitializer, address pool, address migrationPool, uint256 numTokensToSell, uint256 totalSupply, address integrator)',
]);

function call(to, abi, functionName, args = []) {
  const data = encodeFunctionData({ abi, functionName, args });
  return decodeFunctionResult({ abi, functionName, data: rpc('eth_call', [{ to, data }, 'latest']) });
}
function multicall(calls) {
  const out = [];
  for (let i = 0; i < calls.length; i += 300) {
    const chunk = calls.slice(i, i + 300);
    const data = encodeFunctionData({ abi: mcAbi, functionName: 'aggregate3', args: [chunk.map((c) => ({ target: c.to, allowFailure: true, callData: c.data }))] });
    out.push(...decodeFunctionResult({ abi: mcAbi, functionName: 'aggregate3', data: rpc('eth_call', [{ to: MULTICALL3, data }, 'latest']) }));
    if (i % 3000 === 0) process.stdout.write('.');
  }
  return out;
}
const codeSize = (a) => (rpc('eth_getCode', [a, 'latest']).length - 2) / 2;

const head = parseInt(rpc('eth_blockNumber', []), 16);
const airlock = call(INITIALIZER, initAbi, 'airlock');
const owner = call(airlock, airlockAbi, 'owner');
const ownerCode = codeSize(owner);
console.log('airlock', airlock, '| owner', owner, '| owner code bytes', ownerCode);

const pools = JSON.parse(fs.readFileSync(path.join(EVID, 'pools.json'), 'utf8'));
const dp = pools.v4.filter((p) => p.hooks.toLowerCase() === INITIALIZER);
console.log('Doppler pools holding a stepped token:', dp.length);

// The Doppler asset is the launched token; the stock token is its numeraire. Try the non-stock side first.
const res = multicall(dp.map((p) => ({ to: INITIALIZER, data: encodeFunctionData({ abi: initAbi, functionName: 'getState', args: [p.other] }) })));
console.log('');
const rows = [];
let keyMismatch = 0;
dp.forEach((p, i) => {
  const r = res[i];
  if (!r.success) { rows.push({ poolId: p.poolId, asset: p.other, ok: false }); return; }
  const [numeraire, , dopplerHook, , status, poolKey] = decodeFunctionResult({ abi: initAbi, functionName: 'getState', data: r.returnData });
  const matches = poolKey.hooks.toLowerCase() === INITIALIZER
    && [poolKey.currency0.toLowerCase(), poolKey.currency1.toLowerCase()].includes(p.stockToken.toLowerCase());
  if (!matches) keyMismatch++;
  rows.push({ poolId: p.poolId, asset: p.other, sym: p.sym, ok: true, matches, numeraire, dopplerHook: dopplerHook.toLowerCase(), status: STATUS[Number(status)] || String(status), dynamicFee: p.fee === 8388608 });
});

const good = rows.filter((r) => r.ok && r.matches);
const byStatus = {};
const byModule = {};
for (const r of good) {
  byStatus[r.status] = (byStatus[r.status] || 0) + 1;
  byModule[r.dopplerHook] = (byModule[r.dopplerHook] || 0) + 1;
}
const modules = Object.entries(byModule).sort((a, b) => b[1] - a[1]).map(([m, n]) => ({ module: m, pools: n }));
for (const m of modules.slice(0, 12)) {
  if (m.module === '0x0000000000000000000000000000000000000000') { m.flags = null; continue; }
  m.flags = Number(call(INITIALIZER, initAbi, 'isDopplerHookEnabled', [m.module]));
  m.onSwap = (m.flags & 2) !== 0;
  m.codeBytes = codeSize(m.module);
}
// Sourcify names for the module slots in use
for (const m of modules.slice(0, 8)) {
  if (!m.codeBytes) continue;
  try {
    const out = require('child_process').execFileSync('curl', ['-s', '--max-time', '30', `https://sourcify.dev/server/v2/contract/4663/${m.module}?fields=compilation`], { encoding: 'utf8' });
    const name = (out.match(/"name":"([^"]+)"/) || [])[1];
    m.sourcifyName = name || 'not verified on Sourcify';
  } catch (e) { m.sourcifyName = 'lookup failed'; }
}

// who may attach a module: timelock of a sample of locked assets
const locked = good.filter((r) => r.status === 'Locked');
const sample = locked.filter((_, i) => i % Math.max(1, Math.floor(locked.length / 25)) === 0).slice(0, 25);
const authorities = [];
for (const r of sample) {
  try {
    const d = call(airlock, airlockAbi, 'getAssetData', [r.asset]);
    const timelock = d[1];
    authorities.push({ asset: r.asset, sym: r.sym, timelock, timelockCodeBytes: codeSize(timelock) });
  } catch (e) { authorities.push({ asset: r.asset, error: e.message.slice(0, 120) }); }
}

const summary = {
  head, measuredAt: new Date().toISOString(), initializer: INITIALIZER, airlock, airlockOwner: owner, airlockOwnerCodeBytes: ownerCode,
  dopplerPools: dp.length, stateRead: good.length, keyMismatch, failed: rows.filter((r) => !r.ok).length,
  byStatus, lockedAndAttachable: byStatus.Locked || 0,
  slotEmpty: byModule['0x0000000000000000000000000000000000000000'] || 0,
  slotTaken: good.length - (byModule['0x0000000000000000000000000000000000000000'] || 0),
  modules: modules.slice(0, 20),
  timelockSample: authorities,
  timelocksThatAreContracts: authorities.filter((a) => a.timelockCodeBytes > 0).length,
  distinctTimelocksInSample: new Set(authorities.map((a) => a.timelock)).size,
  dopplerMaxLpFee: 100000,
};
fs.writeFileSync(path.join(EVID, 'doppler.json'), JSON.stringify(summary, null, 1));
console.log(JSON.stringify({ ...summary, modules: summary.modules.slice(0, 6), timelockSample: undefined }, null, 1));
console.log('wrote evidence/doppler.json');
