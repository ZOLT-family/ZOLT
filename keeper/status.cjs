// What the keeper is doing, in one screen: the health file it writes every pass, plus the chain's view of it.
//   node keeper/status.cjs
const fs = require('fs');
const path = require('path');
const { rpc } = require('../research/rpc.cjs');

const HEALTH = path.join(__dirname, 'health.json');
const ADDRESS = path.join(__dirname, 'keeper.address');
const LOG = path.join(__dirname, 'keeper.log');

const h = fs.existsSync(HEALTH) ? JSON.parse(fs.readFileSync(HEALTH, 'utf8')) : null;
const address = h && h.keeper ? h.keeper : fs.existsSync(ADDRESS) ? fs.readFileSync(ADDRESS, 'utf8').trim() : null;

console.log('keeper', address || '(no key on this machine)');
if (!h) {
  console.log('no health file yet: the keeper has not completed a pass on this machine');
} else {
  const age = Math.round((Date.now() - new Date(h.at).getTime()) / 1000);
  console.log('last pass', h.at, `(${age} s ago${age > 60 ? ' — STALE, is the loop running?' : ''})`);
  console.log('started', h.startedAt, '| passes', h.passes, '| sends', h.sends, '| mined', h.mined, '| failed', h.failed, '| spent', Number(h.spentEth).toFixed(6), 'ETH');
  console.log('head block', h.head, '| open markets on file', h.open, '| gas', Number(h.gasGwei).toFixed(3), 'gwei | balance at last pass', h.balanceEth === null ? '-' : Number(h.balanceEth).toFixed(6), 'ETH');
  if (h.lastError) console.log('last error', h.lastError.at, h.lastError.what, '-', h.lastError.why);
  for (const a of h.lastActions || []) console.log('  ', a.at, a.fn, a.id !== undefined ? '#' + a.id : a.token, a.result);
}
if (address) {
  try {
    const bal = Number(BigInt(rpc('eth_getBalance', [address, 'latest']))) / 1e18;
    const nonce = parseInt(rpc('eth_getTransactionCount', [address, 'latest']), 16);
    console.log('on chain now: balance', bal.toFixed(6), 'ETH | transactions sent', nonce);
  } catch (e) { console.log('chain not reachable:', e.message.slice(0, 120)); }
}
if (fs.existsSync(LOG)) {
  const lines = fs.readFileSync(LOG, 'utf8').trim().split('\n');
  console.log('\nlast log lines:');
  for (const l of lines.slice(-6)) console.log('  ' + l.slice(0, 160));
}
