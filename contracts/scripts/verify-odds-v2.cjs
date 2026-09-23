// Check a ZoltOddsV2 that a wallet deployed (site/deploy-v2.html) and write the deployment record.
//
//   node scripts/verify-odds-v2.cjs --chain 4663 --address 0x… [--tx 0x…]
//
// Reads the chain only. Refuses to write the record if the code on chain is not this build, or if the contract
// reads a different factory or charges different fees than the source says.
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { getAddress, encodeFunctionData, decodeFunctionResult, parseAbi } = require('viem');

const arg = (name, dflt) => { const i = process.argv.indexOf('--' + name); return i > 0 ? process.argv[i + 1] : dflt; };
const CHAIN = Number(arg('chain', '4663'));
const RPC = arg('rpc', CHAIN === 4663 ? 'https://rpc.mainnet.chain.robinhood.com' : CHAIN === 46630 ? 'https://rpc.testnet.chain.robinhood.com' : null);
const FACTORY = getAddress(arg('factory', CHAIN === 4663 ? '0x7ed598bcef8bd9edd8c97a195c6d13f40801ec7e' : '0x0000000000000000000000000000000000000000'));
const ROOT = path.join(__dirname, '..');
const OUT_FILE = path.join(ROOT, 'deploy', `odds-v2-${CHAIN}.deployed.json`);

function die(msg) { console.error('STOP: ' + msg); process.exit(1); }
if (!RPC) die('no default RPC for chain ' + CHAIN + '; pass --rpc');
const address = arg('address', null);
if (!address) die('pass --address 0x…');

function rpc(method, params) {
  const out = execFileSync('curl', ['-s', '--max-time', '60', '--doh-url', 'https://cloudflare-dns.com/dns-query',
    RPC, '-H', 'content-type: application/json', '--data-binary', '@-'],
  { input: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }), encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  const j = JSON.parse(out);
  if (j.error) throw new Error(method + ' ' + JSON.stringify(j.error));
  return j.result;
}

const abi = parseAbi([
  'function factory() view returns (address)',
  'function treasury() view returns (address)',
  'function zolt() view returns (address)',
  'function discountBond() view returns (uint256)',
  'function keeperBond() view returns (uint256)',
  'function FEE_BPS() view returns (uint256)',
  'function DISCOUNT_FEE_BPS() view returns (uint256)',
  'function BOUNTY_BPS() view returns (uint256)',
  'function BOND_LOCK() view returns (uint256)',
  'function marketCount() view returns (uint256)',
]);
const erc20 = parseAbi(['function symbol() view returns (string)', 'function totalSupply() view returns (uint256)']);
const view = (a, to, fn, args = []) => decodeFunctionResult({ abi: a, functionName: fn, data: rpc('eth_call', [{ to, data: encodeFunctionData({ abi: a, functionName: fn, args }) }, 'latest']) });

const at = getAddress(address);
const artifact = JSON.parse(fs.readFileSync(path.join(ROOT, 'artifacts', 'src', 'ZoltOddsV2.sol', 'ZoltOddsV2.json'), 'utf8'));
const chainId = parseInt(rpc('eth_chainId', []), 16);
if (chainId !== CHAIN) die(`chain mismatch: RPC ${chainId}, asked ${CHAIN}`);
const code = rpc('eth_getCode', [at, 'latest']);
if (code === '0x') die('no code at ' + at);
if (code.length !== artifact.deployedBytecode.length) die('the code at ' + at + ' is not this build of ZoltOddsV2 (' + (code.length - 2) / 2 + ' bytes on chain, ' + (artifact.deployedBytecode.length - 2) / 2 + ' in the build)');

const checks = {
  codePresent: true,
  runtimeLengthMatchesBuild: true,
  factory: getAddress(view(abi, at, 'factory')),
  treasury: getAddress(view(abi, at, 'treasury')),
  zolt: getAddress(view(abi, at, 'zolt')),
  discountBond: view(abi, at, 'discountBond').toString(),
  keeperBond: view(abi, at, 'keeperBond').toString(),
  feeBps: Number(view(abi, at, 'FEE_BPS')),
  discountFeeBps: Number(view(abi, at, 'DISCOUNT_FEE_BPS')),
  bountyBps: Number(view(abi, at, 'BOUNTY_BPS')),
  bondLockSeconds: Number(view(abi, at, 'BOND_LOCK')),
  marketCount: Number(view(abi, at, 'marketCount')),
};
checks.zoltSymbol = view(erc20, checks.zolt, 'symbol');
checks.zoltTotalSupply = view(erc20, checks.zolt, 'totalSupply').toString();
checks.paramsOk = checks.factory === FACTORY && checks.feeBps === 100 && checks.discountFeeBps === 50 && checks.bountyBps === 20 && checks.bondLockSeconds === 7 * 86400;
console.log('verify', JSON.stringify(checks, null, 1));
if (!checks.paramsOk) die('the contract reads a different factory or charges different fees than the source');

const tx = arg('tx', null);
const record = {
  chainId: CHAIN, contract: 'ZoltOddsV2', address: at, factory: checks.factory, treasury: checks.treasury, zolt: checks.zolt,
  discountBond: checks.discountBond, keeperBond: checks.keeperBond,
  runtimeBytes: (artifact.deployedBytecode.length - 2) / 2, status: 'DEPLOYED', deployedVia: 'wallet',
  creationTransactionHash: tx || null,
  verifiedAt: new Date().toISOString(), verification: checks,
};
if (tx) {
  const r = rpc('eth_getTransactionReceipt', [tx]);
  if (!r || (r.contractAddress || '').toLowerCase() !== at.toLowerCase()) die('that transaction did not create ' + at);
  record.deployedBlock = parseInt(r.blockNumber, 16);
}
fs.mkdirSync(path.dirname(OUT_FILE), { recursive: true });
fs.writeFileSync(OUT_FILE, JSON.stringify(record, null, 1));
console.log('ok  wrote', path.relative(process.cwd(), OUT_FILE));
console.log('\nRecorded. The page still reads v1 until the builder is pointed at this record.');
