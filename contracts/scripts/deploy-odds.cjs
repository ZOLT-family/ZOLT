// Deploy ZoltOdds, then verify it on chain. Run it yourself; the key never leaves your machine and is never
// printed. A plain CREATE: the market has no hook flags to mine.
//
//   node scripts/deploy-odds.cjs --chain 4663                 # dry run: checks everything, writes the plan, sends nothing
//   node scripts/deploy-odds.cjs --chain 4663 --yes           # sign and send
//   node scripts/deploy-odds.cjs --chain 4663 --verify 0x…    # a contract deployed some other way (site/deploy.html):
//                                                             # check it on chain and write deploy/odds-<chain>.deployed.json
//
// Key: env DEPLOYER_PRIVATE_KEY, or --key-file <path to a file holding the 0x… key>.
// Treasury (receives the 1% fee on losing pools): --treasury 0x…; defaults to the deployer.
// Factory: --factory 0x…; defaults to Pons V2's PonsV2LaunchFactory on chain 4663. Other RPC: --rpc <url>.
//
// Refuses to send if: the chain id is wrong, the factory has no code or does not answer getLaunchedToken,
// the simulation reverts, or the balance is short.
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { keccak256, encodeAbiParameters, concatHex, getAddress, encodeFunctionData, decodeFunctionResult, parseAbi, getContractAddress } = require('viem');
const { privateKeyToAccount } = require('viem/accounts');

const arg = (name, dflt) => { const i = process.argv.indexOf('--' + name); return i > 0 ? process.argv[i + 1] : dflt; };
const YES = process.argv.includes('--yes');
const CHAIN = Number(arg('chain', '4663'));
const RPC = arg('rpc', CHAIN === 4663 ? 'https://rpc.mainnet.chain.robinhood.com' : CHAIN === 46630 ? 'https://rpc.testnet.chain.robinhood.com' : null);
const FACTORY = getAddress(arg('factory', CHAIN === 4663 ? '0x7ed598bcef8bd9edd8c97a195c6d13f40801ec7e' : '0x0000000000000000000000000000000000000000'));
const ROOT = path.join(__dirname, '..');
const PLAN_FILE = path.join(ROOT, 'deploy', `odds-${CHAIN}.json`);
const OUT_FILE = path.join(ROOT, 'deploy', `odds-${CHAIN}.deployed.json`);

function die(msg) { console.error('STOP: ' + msg); process.exit(1); }
if (!RPC) die('no default RPC for chain ' + CHAIN + '; pass --rpc');
if (FACTORY === '0x0000000000000000000000000000000000000000') die('no default factory on chain ' + CHAIN + '; pass --factory');

function rpc(method, params) {
  const out = execFileSync('curl', ['-s', '--max-time', '60', '--doh-url', 'https://cloudflare-dns.com/dns-query',
    RPC, '-H', 'content-type: application/json', '--data-binary', '@-'],
  { input: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }), encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  const j = JSON.parse(out);
  if (j.error) throw new Error(method + ' ' + JSON.stringify(j.error));
  return j.result;
}
function sleep(ms) { const t = Date.now() + ms; while (Date.now() < t) { /* wait */ } }

const factoryAbi = parseAbi([
  'function getLaunchedToken(address token) view returns ((address token,address curve,address deployer,address creatorFeeRecipient,address pairToken,uint256 graduationThreshold,uint24 poolFee,int24 tickSpacing,uint16 creatorTaxBps,bool buybackEnabled,uint8 phase,uint256 sweptQuote,uint256 sweptTokens,uint256 sweptAt,bool exists))',
]);
const oddsAbi = parseAbi([
  'function factory() view returns (address)',
  'function treasury() view returns (address)',
  'function marketCount() view returns (uint256)',
  'function FEE_BPS() view returns (uint256)',
]);
const view = (abi, to, fn, args = []) => decodeFunctionResult({ abi, functionName: fn, data: rpc('eth_call', [{ to, data: encodeFunctionData({ abi, functionName: fn, args }) }, 'latest']) });

// Verify a contract that was deployed from a wallet (site/deploy.html): same checks as after a scripted send.
function verifyOnly(address) {
  const artifact = JSON.parse(fs.readFileSync(path.join(ROOT, 'artifacts', 'src', 'ZoltOdds.sol', 'ZoltOdds.json'), 'utf8'));
  const chainId = parseInt(rpc('eth_chainId', []), 16);
  if (chainId !== CHAIN) die(`chain mismatch: RPC ${chainId}, asked ${CHAIN}`);
  const code = rpc('eth_getCode', [address, 'latest']);
  if (code === '0x') die('no code at ' + address);
  // the length check comes first: a contract that is not ZoltOdds would revert on the views below
  if (code.length !== artifact.deployedBytecode.length) die('the code at ' + address + ' is not this build of ZoltOdds (' + (code.length - 2) / 2 + ' bytes on chain, ' + (artifact.deployedBytecode.length - 2) / 2 + ' in the build)');
  const checks = {
    codePresent: true,
    runtimeLengthMatchesBuild: true,
    factory: getAddress(view(oddsAbi, address, 'factory')),
    treasury: getAddress(view(oddsAbi, address, 'treasury')),
    feeBps: Number(view(oddsAbi, address, 'FEE_BPS')),
    marketCount: Number(view(oddsAbi, address, 'marketCount')),
  };
  checks.paramsOk = checks.factory === FACTORY && checks.feeBps === 100;
  console.log('verify', JSON.stringify(checks));
  if (!checks.runtimeLengthMatchesBuild) die('the code on chain is not this build of ZoltOdds');
  if (!checks.paramsOk) die('the contract reads a different factory or charges a different fee');
  const record = {
    chainId: CHAIN, contract: 'ZoltOdds', address, factory: checks.factory, treasury: checks.treasury,
    runtimeBytes: (artifact.deployedBytecode.length - 2) / 2, status: 'DEPLOYED', deployedVia: 'wallet',
    verifiedAt: new Date().toISOString(), verification: checks,
  };
  fs.mkdirSync(path.dirname(OUT_FILE), { recursive: true });
  fs.writeFileSync(OUT_FILE, JSON.stringify(record, null, 1));
  console.log('ok  wrote', path.relative(process.cwd(), OUT_FILE));
  console.log('\nVerified. Rebuild the site to switch the board on.');
}

(async () => {
  const verifyAddr = arg('verify', null);
  if (verifyAddr) { verifyOnly(getAddress(verifyAddr)); return; }

  // 1. chain and factory
  const chainId = parseInt(rpc('eth_chainId', []), 16);
  if (chainId !== CHAIN) die(`chain mismatch: RPC ${chainId}, asked ${CHAIN}`);
  console.log('ok  chain', chainId);
  if (rpc('eth_getCode', [FACTORY, 'latest']) === '0x') die('factory has no code at ' + FACTORY);
  const probe = view(factoryAbi, FACTORY, 'getLaunchedToken', ['0x0000000000000000000000000000000000000001']);
  if (probe.exists !== false) die('factory did not answer getLaunchedToken the way PonsV2LaunchFactory does');
  console.log('ok  factory answers getLaunchedToken', FACTORY);

  // 2. key (optional for a dry run)
  let key = process.env.DEPLOYER_PRIVATE_KEY;
  const keyFile = arg('key-file', null);
  if (!key && keyFile) key = fs.readFileSync(keyFile, 'utf8').trim();
  let account = null;
  if (key) {
    if (!/^0x[0-9a-fA-F]{64}$/.test(key)) die('key is not a 0x-prefixed 32-byte hex string');
    account = privateKeyToAccount(key);
    key = null;
  }
  const from = account ? account.address : '0x000000000000000000000000000000000000bEEF';
  // without a key or --treasury this is a plan, not a deployment: the simulation borrows the factory address as a
  // stand-in treasury (the constructor refuses zero) and the plan records that no treasury has been chosen yet
  const treasuryArg = arg('treasury', null);
  const treasury = treasuryArg ? getAddress(treasuryArg) : account ? from : null;
  if (!treasury && YES) die('pass --treasury or a key');

  // 3. initcode and a live simulation
  const artifact = JSON.parse(fs.readFileSync(path.join(ROOT, 'artifacts', 'src', 'ZoltOdds.sol', 'ZoltOdds.json'), 'utf8'));
  const initcode = concatHex([artifact.bytecode, encodeAbiParameters([{ type: 'address' }, { type: 'address' }], [FACTORY, treasury || FACTORY])]);
  const nonce = parseInt(rpc('eth_getTransactionCount', [from, 'pending']), 16);
  const predicted = getContractAddress({ from, nonce: BigInt(nonce) });
  let gas;
  try { gas = BigInt(rpc('eth_estimateGas', [{ from, data: initcode }])); } catch (e) { die('deployment simulation reverted: ' + e.message.slice(0, 200)); }
  const gasPrice = BigInt(rpc('eth_gasPrice', []));
  console.log(`ok  simulation: ${gas} gas, about ${Number(gas * gasPrice) / 1e18} ETH at the current gas price`);

  const plan = {
    chainId: CHAIN, contract: 'ZoltOdds', factory: FACTORY, treasury, deployer: account ? from : null,
    initCodeHash: keccak256(initcode), runtimeBytes: (artifact.deployedBytecode.length - 2) / 2,
    predictedAddress: account ? predicted : null, estimatedGas: Number(gas), preparedAt: new Date().toISOString(),
    status: 'UNSIGNED',
    note: 'A plan, not a deployment. The address is only predictable once the deployer is known.',
  };
  fs.mkdirSync(path.dirname(PLAN_FILE), { recursive: true });
  fs.writeFileSync(PLAN_FILE, JSON.stringify(plan, null, 1));
  console.log('ok  wrote', path.relative(process.cwd(), PLAN_FILE));

  if (!account) { console.log('\nDry run complete. No key given, so nothing was signed.'); process.exit(0); }

  // 4. balance
  const gasLimit = (gas * 13n) / 10n;
  const maxFeePerGas = gasPrice * 2n;
  const balance = BigInt(rpc('eth_getBalance', [from, 'latest']));
  const worst = gasLimit * maxFeePerGas;
  console.log(`ok  deployer ${from} balance ${Number(balance) / 1e18} ETH, worst-case cost ${Number(worst) / 1e18} ETH; treasury ${treasury}; predicted ${predicted}`);
  if (balance < worst) die('balance below the worst-case cost');
  if (!YES) { console.log('\nDry run complete. Everything checks out. Re-run with --yes to sign and send.'); process.exit(0); }

  // 5. sign and send
  const signed = await account.signTransaction({ chainId: CHAIN, nonce, data: initcode, value: 0n, gas: gasLimit, maxFeePerGas, maxPriorityFeePerGas: 0n, type: 'eip1559' });
  const txHash = rpc('eth_sendRawTransaction', [signed]);
  console.log('sent', txHash);
  let receipt = null;
  for (let i = 0; i < 120 && !receipt; i++) { sleep(1000); receipt = rpc('eth_getTransactionReceipt', [txHash]); }
  if (!receipt) die('no receipt after 120 s; check ' + txHash + ' before retrying');
  if (receipt.status !== '0x1') die('transaction reverted: ' + txHash);
  const address = getAddress(receipt.contractAddress);
  console.log('ok  mined in block', parseInt(receipt.blockNumber, 16), 'at', address);

  // 6. verify what is on chain
  const code = rpc('eth_getCode', [address, 'latest']);
  const checks = {
    codePresent: code !== '0x',
    runtimeLengthMatchesBuild: code.length === artifact.deployedBytecode.length,
    factory: getAddress(view(oddsAbi, address, 'factory')),
    treasury: getAddress(view(oddsAbi, address, 'treasury')),
    feeBps: Number(view(oddsAbi, address, 'FEE_BPS')),
    marketCount: Number(view(oddsAbi, address, 'marketCount')),
  };
  checks.paramsOk = checks.factory === FACTORY && checks.treasury === treasury && checks.feeBps === 100 && checks.marketCount === 0;
  console.log('verify', JSON.stringify(checks));
  if (!checks.codePresent || !checks.paramsOk) die('on-chain verification failed');

  const record = { ...plan, status: 'DEPLOYED', address, sent: { txHash, block: parseInt(receipt.blockNumber, 16), from, gasUsed: parseInt(receipt.gasUsed, 16) }, verifiedAt: new Date().toISOString(), verification: checks };
  delete record.note;
  fs.writeFileSync(OUT_FILE, JSON.stringify(record, null, 1));
  console.log('ok  wrote', path.relative(process.cwd(), OUT_FILE));
  console.log('\nDeployed and verified.');
})().catch((e) => die(e.message.slice(0, 300)));
