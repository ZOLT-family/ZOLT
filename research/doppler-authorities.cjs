// Who can say yes to the Doppler module? Read-only.
//   - Airlock owner: is it a Safe? owners and threshold.
//   - Every locked Doppler pool: Airlock.getAssetData(asset).timelock, and getAuthority(timelock) delegation.
//   - The verified module in the slots (RehypeDopplerHookInitializer): does it already set the dynamic fee?
// Output: evidence/doppler-authorities.json
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { createRequire } = require('module');
const { rpc } = require('./rpc.cjs');

const req = createRequire(path.join(__dirname, '..', 'contracts', 'package.json'));
const { encodeFunctionData, decodeFunctionResult, parseAbi } = req('viem');

const EVID = path.join(__dirname, '..', 'evidence');
const MULTICALL3 = '0xcA11bde05977b3631167028862bE2a173976CA11';
const d = JSON.parse(fs.readFileSync(path.join(EVID, 'doppler.json'), 'utf8'));
const pools = JSON.parse(fs.readFileSync(path.join(EVID, 'pools.json'), 'utf8'));

const mcAbi = parseAbi(['function aggregate3((address target, bool allowFailure, bytes callData)[] calls) payable returns ((bool success, bytes returnData)[])']);
const safeAbi = parseAbi(['function getOwners() view returns (address[])', 'function getThreshold() view returns (uint256)', 'function VERSION() view returns (string)']);
const airlockAbi = parseAbi(['function getAssetData(address asset) view returns (address numeraire, address timelock, address governance, address liquidityMigrator, address poolInitializer, address pool, address migrationPool, uint256 numTokensToSell, uint256 totalSupply, address integrator)']);
const initAbi = parseAbi(['function getAuthority(address) view returns (address)']);

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
  }
  return out;
}

// 1. the airlock owner
const safe = {};
try { safe.owners = call(d.airlockOwner, safeAbi, 'getOwners'); } catch (e) { safe.owners = null; }
try { safe.threshold = Number(call(d.airlockOwner, safeAbi, 'getThreshold')); } catch (e) { safe.threshold = null; }
try { safe.version = call(d.airlockOwner, safeAbi, 'VERSION'); } catch (e) { safe.version = null; }
console.log('airlock owner', d.airlockOwner, 'Safe?', safe.threshold !== null, JSON.stringify(safe));

// 2. timelocks of every Doppler pool (asset = the non-stock side)
const INITIALIZER = d.initializer;
const dp = pools.v4.filter((p) => p.hooks.toLowerCase() === INITIALIZER);
const res = multicall(dp.map((p) => ({ to: d.airlock, data: encodeFunctionData({ abi: airlockAbi, functionName: 'getAssetData', args: [p.other] }) })));
const byTimelock = {};
res.forEach((r) => {
  if (!r.success) return;
  const t = decodeFunctionResult({ abi: airlockAbi, functionName: 'getAssetData', data: r.returnData })[1].toLowerCase();
  byTimelock[t] = (byTimelock[t] || 0) + 1;
});
const timelocks = Object.entries(byTimelock).sort((a, b) => b[1] - a[1]).map(([timelock, n]) => ({ timelock, pools: n }));
for (const t of timelocks.slice(0, 10)) {
  t.codeBytes = (rpc('eth_getCode', [t.timelock, 'latest']).length - 2) / 2;
  try { t.delegatedAuthority = call(INITIALIZER, initAbi, 'getAuthority', [t.timelock]); } catch (e) { t.delegatedAuthority = null; }
}
console.log('distinct timelocks', timelocks.length, 'top:', JSON.stringify(timelocks.slice(0, 5)));

// 3. what the Rehype module does on a swap (verified source)
let rehype = null;
const rehypeModule = (d.modules.find((m) => m.sourcifyName === 'RehypeDopplerHookInitializer') || {}).module;
if (rehypeModule) {
  const raw = execFileSync('curl', ['-s', '--max-time', '60', `https://sourcify.dev/server/v2/contract/4663/${rehypeModule}?fields=sources`], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  const src = JSON.parse(raw).sources || {};
  const mainFile = Object.keys(src).find((f) => /RehypeDopplerHookInitializer\.sol$/.test(f));
  const text = mainFile ? src[mainFile].content : '';
  rehype = {
    module: rehypeModule, file: mainFile,
    callsUpdateDynamicLPFee: /updateDynamicLPFee/.test(text),
    notice: (text.match(/@notice[^\n]*/g) || []).slice(0, 6),
    onSwapDefined: /function _onSwap/.test(text),
    lines: text.split('\n').length,
  };
  console.log('rehype', JSON.stringify(rehype));
}

fs.writeFileSync(path.join(EVID, 'doppler-authorities.json'), JSON.stringify({
  measuredAt: new Date().toISOString(), airlockOwner: d.airlockOwner, safe, distinctTimelocks: timelocks.length, timelocks: timelocks.slice(0, 20), rehype,
}, null, 1));
console.log('wrote evidence/doppler-authorities.json');
