// Make a burner key for the keeper, on this machine, in a file git ignores. Only the address is printed.
// The keeper needs gas money and nothing else: send a little ETH on chain 4663 to the address it prints.
//
//   node keeper/new-keeper-key.cjs            # writes keeper/keeper.key (refuses to overwrite)
//   KEEPER_PRIVATE_KEY=$(cat keeper/keeper.key) node keeper/odds-keeper.cjs --odds 0x... --send
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const viemRequire = require('module').createRequire(path.join(__dirname, '..', 'contracts', 'package.json'));
const { privateKeyToAccount } = viemRequire('viem/accounts');

const FILE = path.join(__dirname, 'keeper.key');
if (fs.existsSync(FILE)) {
  const key = fs.readFileSync(FILE, 'utf8').trim();
  console.log('keeper/keeper.key already exists; its address is', privateKeyToAccount(key).address);
  process.exit(0);
}
const key = '0x' + crypto.randomBytes(32).toString('hex');
fs.writeFileSync(FILE, key + '\n', { mode: 0o600 });
console.log('wrote keeper/keeper.key (git-ignored, never print it)');
console.log('keeper address:', privateKeyToAccount(key).address);
console.log('send it a little ETH on chain 4663 for gas, then run the keeper with --send.');
