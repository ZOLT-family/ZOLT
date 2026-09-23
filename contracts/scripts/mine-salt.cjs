// Prepare (never send) the deployment of the Zolt hook through the deterministic CREATE2 proxy.
//
// A v4 hook's address must carry exactly its permission bits in the low 14 bits. This mines a salt so that
// CREATE2(proxy, salt, initcode) lands on such an address, checks the proxy exists on the target chain and
// that the address is still empty, and writes the unsigned transaction to deploy/zolt-<chainId>.json.
// Anyone with a funded key then sends { to: proxy, data } once. test/Deployment.t.sol runs the same search
// in the EVM and deploys and trades through the result.
//
//   node scripts/mine-salt.cjs                                   # chain 4663, Uniswap's PoolManager
//   node scripts/mine-salt.cjs --rpc <url> --chain 46630 --pool-manager 0x...   # testnet (pool manager required)
//   options: --base-fee 3000 --lookahead 7200 --window 86400
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { keccak256, encodeAbiParameters, concatHex, getAddress } = require('viem');

const arg = (name, dflt) => {
  const i = process.argv.indexOf('--' + name);
  return i > 0 ? process.argv[i + 1] : dflt;
};
const CHAIN = Number(arg('chain', '4663'));
const RPC = arg('rpc', CHAIN === 4663 ? 'https://rpc.mainnet.chain.robinhood.com' : null);
const POOL_MANAGER = arg('pool-manager', CHAIN === 4663 ? '0x8366a39cc670b4001a1121b8f6a443a643e40951' : null);
const BASE_FEE = Number(arg('base-fee', '3000'));
const LOOKAHEAD = BigInt(arg('lookahead', '7200'));
const WINDOW = BigInt(arg('window', '86400'));
const PROXY = '0x4e59b44847b379578588920cA78FbF26c0B4956C'; // Arachnid deterministic-deployment-proxy
const FLAGS = (1n << 13n) | (1n << 12n) | (1n << 7n); // BEFORE_INITIALIZE | AFTER_INITIALIZE | BEFORE_SWAP
const MASK = (1n << 14n) - 1n;

if (!RPC || !POOL_MANAGER) {
  console.error('need --rpc and --pool-manager for chains other than 4663');
  process.exit(1);
}

function rpc(method, params) {
  const out = execFileSync('curl', ['-s', '--max-time', '60', '--doh-url', 'https://cloudflare-dns.com/dns-query',
    RPC, '-H', 'content-type: application/json', '--data-binary', '@-'],
  { input: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }), encoding: 'utf8' });
  const j = JSON.parse(out);
  if (j.error) throw new Error(method + ' ' + JSON.stringify(j.error));
  return j.result;
}

const artifact = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'artifacts', 'src', 'Zolt.sol', 'Zolt.json'), 'utf8'));
const args = encodeAbiParameters(
  [{ type: 'address' }, { type: 'uint24' }, { type: 'uint256' }, { type: 'uint256' }],
  [getAddress(POOL_MANAGER), BASE_FEE, LOOKAHEAD, WINDOW],
);
const initcode = concatHex([artifact.bytecode, args]);
const initHash = keccak256(initcode);

const chainId = parseInt(rpc('eth_chainId', []), 16);
if (chainId !== CHAIN) throw new Error(`RPC is chain ${chainId}, expected ${CHAIN}`);
const proxyCode = rpc('eth_getCode', [PROXY, 'latest']);
if (proxyCode === '0x') throw new Error('CREATE2 proxy not deployed on this chain');
const pmCode = rpc('eth_getCode', [POOL_MANAGER, 'latest']);
if (pmCode === '0x') throw new Error('no PoolManager at ' + POOL_MANAGER);

const prefix = '0xff' + PROXY.slice(2).toLowerCase();
let salt; let predicted; let tries = 0;
for (let i = 0n; ; i++) {
  tries++;
  const s = '0x' + i.toString(16).padStart(64, '0');
  const a = '0x' + keccak256(concatHex([prefix, s, initHash])).slice(26);
  if ((BigInt(a) & MASK) === FLAGS) { salt = s; predicted = getAddress(a); break; }
}
const existing = rpc('eth_getCode', [predicted, 'latest']);

// Simulate the transaction against the live chain (eth_call + eth_estimateGas): proves the CREATE2 lands on
// the predicted address and fits, without sending anything.
const txData = concatHex([salt, initcode]);
const simTx = { from: '0x000000000000000000000000000000000000bEEF', to: PROXY, data: txData };
let simulation;
try {
  const returned = rpc('eth_call', [simTx, 'latest']);
  const gas = parseInt(rpc('eth_estimateGas', [simTx]), 16);
  const gasPrice = parseInt(rpc('eth_gasPrice', []), 16);
  const runtimeBytes = (artifact.deployedBytecode.length - 2) / 2;
  simulation = {
    returned, returnedMatchesPrediction: returned.toLowerCase().endsWith(predicted.slice(2).toLowerCase()),
    estimatedGas: gas, gasPriceWei: gasPrice, estimatedCostETH: (gas * gasPrice) / 1e18, runtimeBytes, underEip170: runtimeBytes <= 24576,
  };
} catch (e) {
  simulation = { error: e.message.slice(0, 200) };
}

const out = {
  chainId, preparedAt: new Date().toISOString(), status: 'UNSIGNED — nothing has been sent',
  contract: 'Zolt', params: { poolManager: getAddress(POOL_MANAGER), baseFee: BASE_FEE, lookahead: Number(LOOKAHEAD), guardWindow: Number(WINDOW) },
  create2Proxy: PROXY, salt, saltsTried: tries, predictedAddress: predicted, alreadyDeployed: existing !== '0x',
  initCodeHash: initHash, flagsInAddress: '0x' + (BigInt(predicted) & MASK).toString(16),
  transaction: { to: PROXY, data: txData, value: '0x0' },
  simulation,
  note: 'Not sent. The address depends on the exact bytecode: rebuild and re-mine after any change.',
};
fs.mkdirSync(path.join(__dirname, '..', 'deploy'), { recursive: true });
const file = path.join(__dirname, '..', 'deploy', `zolt-${chainId}.json`);
fs.writeFileSync(file, JSON.stringify(out, null, 1));
console.log(`chain ${chainId} | proxy ok | PoolManager ok | salt ${salt} after ${tries} tries | hook address ${predicted} | already deployed: ${out.alreadyDeployed}`);
console.log('simulation:', JSON.stringify(simulation));
console.log('wrote', path.relative(process.cwd(), file), '(unsigned)');
