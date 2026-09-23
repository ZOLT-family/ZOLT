// What a Pons V2 launch on chain 4663 costs and mints today, read from the factory and its hook. Feeds TOKEN_ID.md.
//   node research/pons-config.cjs            -> prints, and writes evidence/pons-config.json
const fs = require('fs');
const path = require('path');
const viemRequire = require('module').createRequire(path.join(__dirname, '..', 'contracts', 'package.json'));
const { encodeFunctionData, decodeFunctionResult, parseAbi } = viemRequire('viem');
const { rpc } = require('./rpc.cjs');

const FACTORY = '0x7ed598bcef8bd9edd8c97a195c6d13f40801ec7e';
const factoryAbi = parseAbi([
  'function launchConfigCount() view returns (uint256)',
  'function getLaunchConfig(uint256 id) view returns ((uint256 supply,uint256 curveFeeBps,uint256 phantomQuote,uint256 graduationThreshold,uint24 poolFee,int24 tickSpacing,bool enabled))',
  'function maxCreatorTaxBps() view returns (uint256)',
  'function launchFee() view returns (uint256)',
  'function memeHook() view returns (address)',
  'function feeEscrow() view returns (address)',
]);
const hookAbi = parseAbi([
  'function hookFeeBps() view returns (uint256)',
]);

function view(abi, to, fn, args = []) {
  const data = rpc('eth_call', [{ to, data: encodeFunctionData({ abi, functionName: fn, args }) }, 'latest']);
  return decodeFunctionResult({ abi, functionName: fn, data });
}

const head = parseInt(rpc('eth_blockNumber', []), 16);
const count = Number(view(factoryAbi, FACTORY, 'launchConfigCount'));
const configs = [];
for (let i = 0; i < count; i++) {
  const c = view(factoryAbi, FACTORY, 'getLaunchConfig', [BigInt(i)]);
  configs.push({
    id: i,
    supply: c.supply.toString(),
    supplyTokens: Number(c.supply / 10n ** 18n),
    curveFeeBps: Number(c.curveFeeBps),
    phantomQuoteEth: Number(c.phantomQuote) / 1e18,
    graduationThresholdEth: Number(c.graduationThreshold) / 1e18,
    poolFee: Number(c.poolFee),
    tickSpacing: Number(c.tickSpacing),
    enabled: c.enabled,
  });
}
const memeHook = view(factoryAbi, FACTORY, 'memeHook');
const out = {
  readAt: new Date().toISOString(),
  block: head,
  factory: FACTORY,
  launchFeeEth: Number(view(factoryAbi, FACTORY, 'launchFee')) / 1e18,
  maxCreatorTaxBps: Number(view(factoryAbi, FACTORY, 'maxCreatorTaxBps')),
  memeHook,
  feeEscrow: view(factoryAbi, FACTORY, 'feeEscrow'),
  hookFeeBps: Number(view(hookAbi, memeHook, 'hookFeeBps')),
  configs,
};
fs.writeFileSync(path.join(__dirname, '..', 'evidence', 'pons-config.json'), JSON.stringify(out, null, 1) + '\n');
console.log(JSON.stringify(out, null, 1));
