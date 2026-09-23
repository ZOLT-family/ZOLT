// Make a burner key for the keeper, on this machine, in a file git ignores. Only the address is printed.
// The keeper needs gas money and nothing else: send a little ETH on chain 4663 to the address it prints.
//
//   node keeper/new-keeper-key.cjs               # writes keeper/keeper.key (refuses to overwrite)
//   node keeper/new-keeper-key.cjs --name cloud  # a second keeper (say, the one that runs off this machine):
//                                                # keeper/keeper-cloud.key + keeper/keeper-cloud.address
//   KEEPER_PRIVATE_KEY=$(cat keeper/keeper.key) node keeper/odds-keeper.cjs --odds 0x... --send
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const viemRequire = require('module').createRequire(path.join(__dirname, '..', 'contracts', 'package.json'));
const { privateKeyToAccount } = viemRequire('viem/accounts');

const i = process.argv.indexOf('--name');
const name = i > 0 && /^[a-z0-9-]+$/.test(process.argv[i + 1] || '') ? 'keeper-' + process.argv[i + 1] : 'keeper';
const FILE = path.join(__dirname, name + '.key');
const ADDR = path.join(__dirname, name + '.address');
if (fs.existsSync(FILE)) {
  const key = fs.readFileSync(FILE, 'utf8').trim();
  console.log('keeper/' + name + '.key already exists; its address is', privateKeyToAccount(key).address);
  process.exit(0);
}
const key = '0x' + crypto.randomBytes(32).toString('hex');
fs.writeFileSync(FILE, key + '\n', { mode: 0o600 });
// the address is public and useful (the page shows when this keeper last acted); the key is not
fs.writeFileSync(ADDR, privateKeyToAccount(key).address + '\n');
console.log('wrote keeper/' + name + '.key (git-ignored, never print it) and keeper/' + name + '.address (public)');
console.log('keeper address:', privateKeyToAccount(key).address);
console.log('send it a little ETH on chain 4663 for gas, then run the keeper with --send.');
