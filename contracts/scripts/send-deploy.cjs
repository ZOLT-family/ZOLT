// Send the prepared Stepguard deployment, then verify it on chain. Run it yourself; the key never leaves your
// machine and is never printed.
//
//   node scripts/send-deploy.cjs --chain 4663                 # dry run: checks everything, sends nothing
//   node scripts/send-deploy.cjs --chain 4663 --yes           # sign and send
//
// Key: env DEPLOYER_PRIVATE_KEY, or --key-file <path to a file holding the 0x… key>.
// Other RPC: --rpc <url>. Defaults: 4663 mainnet public RPC, 46630 testnet public RPC (both via DNS-over-HTTPS).
//
// Refuses to send if: the build no longer matches the mined initcode, the chain id is wrong, the address already
// has code, the live simulation does not return the predicted address, or the balance is short.
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { keccak256, encodeAbiParameters, concatHex, getAddress, encodeFunctionData, decodeFunctionResult, parseAbi } = require('viem');
const { privateKeyToAccount } = require('viem/accounts');

const arg = (name, dflt) => { const i = process.argv.indexOf('--' + name); return i > 0 ? process.argv[i + 1] : dflt; };
const YES = process.argv.includes('--yes');
const CHAIN = Number(arg('chain', '4663'));
const RPC = arg('rpc', CHAIN === 4663 ? 'https://rpc.mainnet.chain.robinhood.com' : CHAIN === 46630 ? 'https://rpc.testnet.chain.robinhood.com' : null);
const ROOT = path.join(__dirname, '..');
const PLAN_FILE = path.join(ROOT, 'deploy', `stepguard-${CHAIN}.json`);
const OUT_FILE = path.join(ROOT, 'deploy', `stepguard-${CHAIN}.deployed.json`);

function die(msg) { console.error('STOP: ' + msg); process.exit(1); }
if (!RPC) die('no default RPC for chain ' + CHAIN + '; pass --rpc');
if (!fs.existsSync(PLAN_FILE)) die('no prepared deployment at ' + PLAN_FILE + ' (run scripts/mine-salt.cjs first)');

function rpc(method, params) {
  const out = execFileSync('curl', ['-s', '--max-time', '60', '--doh-url', 'https://cloudflare-dns.com/dns-query',
    RPC, '-H', 'content-type: application/json', '--data-binary', '@-'],
  { input: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }), encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  const j = JSON.parse(out);
  if (j.error) throw new Error(method + ' ' + JSON.stringify(j.error));
  return j.result;
}
function sleep(ms) { const t = Date.now() + ms; while (Date.now() < t) { /* wait */ } }

const plan = JSON.parse(fs.readFileSync(PLAN_FILE, 'utf8'));
const hookAbi = parseAbi([
  'function poolManager() view returns (address)',
  'function baseFee() view returns (uint24)',
  'function lookahead() view returns (uint256)',
  'function guardWindow() view returns (uint256)',
]);
const view = (to, fn) => decodeFunctionResult({ abi: hookAbi, functionName: fn, data: rpc('eth_call', [{ to, data: encodeFunctionData({ abi: hookAbi, functionName: fn }) }, 'latest']) });

(async () => {
  // 1. the build still matches what was mined
  const artifact = JSON.parse(fs.readFileSync(path.join(ROOT, 'artifacts', 'src', 'Stepguard.sol', 'Stepguard.json'), 'utf8'));
  const p = plan.params;
  const initcode = concatHex([artifact.bytecode, encodeAbiParameters(
    [{ type: 'address' }, { type: 'uint24' }, { type: 'uint256' }, { type: 'uint256' }],
    [getAddress(p.poolManager), p.baseFee, BigInt(p.lookahead), BigInt(p.guardWindow)],
  )]);
  if (keccak256(initcode) !== plan.initCodeHash) die('the current build differs from the mined initcode; rebuild and re-run mine-salt.cjs');
  if (concatHex([plan.salt, initcode]) !== plan.transaction.data) die('prepared calldata does not match salt + initcode');
  console.log('ok  build matches the mined initcode', plan.initCodeHash);

  // 2. right chain, address still free
  const chainId = parseInt(rpc('eth_chainId', []), 16);
  if (chainId !== CHAIN || plan.chainId !== CHAIN) die(`chain mismatch: RPC ${chainId}, plan ${plan.chainId}, asked ${CHAIN}`);
  console.log('ok  chain', chainId);
  const existing = rpc('eth_getCode', [plan.predictedAddress, 'latest']);
  if (existing !== '0x') {
    console.log('already deployed at', plan.predictedAddress, '- verifying only');
  } else {
    // 3. live simulation
    const sim = rpc('eth_call', [{ from: '0x000000000000000000000000000000000000bEEF', to: plan.create2Proxy, data: plan.transaction.data }, 'latest']);
    if (!sim.toLowerCase().endsWith(plan.predictedAddress.slice(2).toLowerCase())) die('live simulation returned ' + sim + ', expected ' + plan.predictedAddress);
    console.log('ok  live simulation returns', plan.predictedAddress);

    // 4. key and balance
    let key = process.env.DEPLOYER_PRIVATE_KEY;
    const keyFile = arg('key-file', null);
    if (!key && keyFile) key = fs.readFileSync(keyFile, 'utf8').trim();
    if (!key) {
      console.log('\nDry run complete. No key given (DEPLOYER_PRIVATE_KEY or --key-file), so nothing was signed.');
      process.exit(0);
    }
    if (!/^0x[0-9a-fA-F]{64}$/.test(key)) die('key is not a 0x-prefixed 32-byte hex string');
    const account = privateKeyToAccount(key);
    key = null;
    const gas = BigInt(rpc('eth_estimateGas', [{ from: account.address, to: plan.create2Proxy, data: plan.transaction.data }]));
    const gasLimit = (gas * 13n) / 10n;
    const gasPrice = BigInt(rpc('eth_gasPrice', []));
    const maxFeePerGas = gasPrice * 2n;
    const balance = BigInt(rpc('eth_getBalance', [account.address, 'latest']));
    const worst = gasLimit * maxFeePerGas;
    console.log(`ok  deployer ${account.address} balance ${Number(balance) / 1e18} ETH, worst-case cost ${Number(worst) / 1e18} ETH (expected about ${Number(gas * gasPrice) / 1e18})`);
    if (balance < worst) die('balance below the worst-case cost');

    if (!YES) {
      console.log('\nDry run complete. Everything checks out. Re-run with --yes to sign and send.');
      process.exit(0);
    }

    // 5. sign and send
    const nonce = parseInt(rpc('eth_getTransactionCount', [account.address, 'pending']), 16);
    const signed = await account.signTransaction({
      chainId: CHAIN, nonce, to: plan.create2Proxy, data: plan.transaction.data, value: 0n,
      gas: gasLimit, maxFeePerGas, maxPriorityFeePerGas: 0n, type: 'eip1559',
    });
    const txHash = rpc('eth_sendRawTransaction', [signed]);
    console.log('sent', txHash);
    let receipt = null;
    for (let i = 0; i < 120 && !receipt; i++) { sleep(1000); receipt = rpc('eth_getTransactionReceipt', [txHash]); }
    if (!receipt) die('no receipt after 120 s; check ' + txHash + ' before retrying');
    if (receipt.status !== '0x1') die('transaction reverted: ' + txHash);
    console.log('ok  mined in block', parseInt(receipt.blockNumber, 16));
    plan.sent = { txHash, block: parseInt(receipt.blockNumber, 16), from: account.address, gasUsed: parseInt(receipt.gasUsed, 16) };
  }

  // 6. verify what is on chain
  const code = rpc('eth_getCode', [plan.predictedAddress, 'latest']);
  const runtime = artifact.deployedBytecode;
  const flags = BigInt(plan.predictedAddress) & ((1n << 14n) - 1n);
  const checks = {
    codePresent: code !== '0x',
    // immutables are written into the code at deploy, so compare length, not bytes
    runtimeLengthMatchesBuild: code.length === runtime.length,
    permissionBits: '0x' + flags.toString(16),
    permissionBitsOk: flags === ((1n << 13n) | (1n << 12n) | (1n << 7n)),
    poolManager: view(plan.predictedAddress, 'poolManager'),
    baseFee: Number(view(plan.predictedAddress, 'baseFee')),
    lookahead: Number(view(plan.predictedAddress, 'lookahead')),
    guardWindow: Number(view(plan.predictedAddress, 'guardWindow')),
  };
  checks.paramsOk = getAddress(checks.poolManager) === getAddress(p.poolManager) && checks.baseFee === p.baseFee
    && checks.lookahead === p.lookahead && checks.guardWindow === p.guardWindow;
  console.log('verify', JSON.stringify(checks));
  if (!checks.codePresent || !checks.permissionBitsOk || !checks.paramsOk) die('on-chain verification failed');

  const record = { ...plan, status: plan.sent ? 'DEPLOYED' : 'ALREADY DEPLOYED', verifiedAt: new Date().toISOString(), verification: checks };
  delete record.note;
  fs.writeFileSync(OUT_FILE, JSON.stringify(record, null, 1));
  console.log('ok  wrote', path.relative(process.cwd(), OUT_FILE));
  console.log('\nDeployed and verified. It is unaudited: do not create pools with it or announce it before an audit.');
})().catch((e) => die(e.message.slice(0, 300)));
