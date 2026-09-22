// The base rate: one day of Pons V2 on chain 4663. How many launches, how many reached the threshold, how long
// the ones that did took, and what they were paired with. Read-only. Output: evidence/pons-24h.json
//
//   node research/pons-24h.cjs            # the 864,000 blocks (about 24 h at 0.1 s) before the head
//   node research/pons-24h.cjs --blocks N # a different span
const fs = require('fs');
const path = require('path');
const { rpc, getLogsChunked } = require('./rpc.cjs');

const FACTORY = '0x7ed598bcef8bd9edd8c97a195c6d13f40801ec7e';
const T_LAUNCH = '0x8d4aad4953d0ca700d468f3753aa14432d1b35b43ec6409f051fb6aa43a89607'; // TokenLaunched
const T_GRAD = '0x0a44ef75df69c534f43cd6c1aa3ef8983065fe5fe79ef9e79f6494e6f258c259'; // PoolGraduated
const arg = (name, dflt) => { const i = process.argv.indexOf('--' + name); return i > 0 ? process.argv[i + 1] : dflt; };
const SPAN = Number(arg('blocks', '864000'));

const head = parseInt(rpc('eth_blockNumber', []), 16);
const from = head - SPAN;
const grads = getLogsChunked({ address: FACTORY, topics: [T_GRAD] }, from, head);
console.log('graduations:', grads.length);
const launches = getLogsChunked({ address: FACTORY, topics: [T_LAUNCH] }, from, head);
console.log('launches:', launches.length);

const launchBlock = {};
const pairTokens = {};
for (const l of launches) {
  launchBlock['0x' + l.topics[1].slice(26)] = parseInt(l.blockNumber, 16);
  const pair = '0x' + l.data.slice(26, 66);
  pairTokens[pair] = (pairTokens[pair] || 0) + 1;
}
const durs = [];
let earlier = 0;
for (const g of grads) {
  const lb = launchBlock['0x' + g.topics[1].slice(26)];
  if (lb === undefined) { earlier++; continue; }
  durs.push((parseInt(g.blockNumber, 16) - lb) * 0.1);
}
durs.sort((a, b) => a - b);
const q = (p) => (durs.length ? Math.round(durs[Math.min(durs.length - 1, Math.floor(p * durs.length))]) : null);
console.log('time to graduation (s): p10', q(0.1), 'p25', q(0.25), 'median', q(0.5), 'p75', q(0.75), 'p90', q(0.9));
console.log('within 10 min', durs.filter((d) => d <= 600).length, '1 h', durs.filter((d) => d <= 3600).length, 'of', durs.length);

fs.writeFileSync(path.join(__dirname, '..', 'evidence', 'pons-24h.json'), JSON.stringify({
  head, from, launches: launches.length, graduations: grads.length,
  gradLaunchedInWindow: durs.length, gradLaunchedEarlier: earlier,
  pairTokens, timeToGraduationSeconds: durs, measuredAt: new Date().toISOString(),
}, null, 1));
console.log('wrote evidence/pons-24h.json');
