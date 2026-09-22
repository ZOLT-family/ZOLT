// Step 0 of the evidence: every UIMultiplierUpdated(uint256,uint256,uint256) log on chain 4663.
//
//   node research/fetch-mult-logs.cjs            # from the last log already on disk to the head
//   node research/fetch-mult-logs.cjs --full     # from genesis
//
// The file it writes, evidence/mult_logs.json, is what measure-steps.cjs, discover-pools.cjs and the
// keeper's replay all read. Until now it was fetched by hand, so the chain of evidence started with a
// file nobody could rebuild. Read-only: eth_getLogs and eth_blockNumber, nothing else.
const fs = require('fs');
const path = require('path');
const { createRequire } = require('module');
const { rpc, hex, getLogsChunked } = require('./rpc.cjs');

const req = createRequire(path.join(__dirname, '..', 'contracts', 'package.json'));
const { keccak256, toHex } = req('viem');

const EVID = path.join(__dirname, '..', 'evidence');
const FILE = path.join(EVID, 'mult_logs.json');
const TOPIC = keccak256(toHex('UIMultiplierUpdated(uint256,uint256,uint256)'));

const full = process.argv.includes('--full');
const head = parseInt(rpc('eth_blockNumber', []), 16);

let kept = [];
let from = 0;
if (!full && fs.existsSync(FILE)) {
  kept = JSON.parse(fs.readFileSync(FILE, 'utf8')).result;
  const last = kept.reduce((a, l) => Math.max(a, parseInt(l.blockNumber, 16)), 0);
  from = last + 1;
  console.log('on disk:', kept.length, 'logs, latest block', last.toLocaleString('en-US'));
}
console.log('topic', TOPIC);
console.log('scanning', from.toLocaleString('en-US'), '->', head.toLocaleString('en-US'));

const fresh = getLogsChunked({ topics: [TOPIC] }, from, head);
console.log('new logs:', fresh.length);

// keep the file in block order and drop anything the node sent twice
const seen = new Set();
const result = [...kept, ...fresh]
  .filter((l) => {
    const k = l.blockHash + ':' + l.logIndex;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  })
  .sort((a, b) => parseInt(a.blockNumber, 16) - parseInt(b.blockNumber, 16) || parseInt(a.logIndex, 16) - parseInt(b.logIndex, 16));

fs.writeFileSync(FILE, JSON.stringify({ jsonrpc: '2.0', id: 1, scannedToBlock: head, result }, null, 1));
console.log('wrote evidence/mult_logs.json:', result.length, 'logs, scanned to block', head.toLocaleString('en-US'));

if (fresh.length) {
  for (const l of fresh) {
    console.log('  block', parseInt(l.blockNumber, 16).toLocaleString('en-US'), 'token', l.address);
  }
  console.log('\nnew steps are on chain: rerun measure-steps, analyze-steps and exposure-census, then rebuild the site.');
}
