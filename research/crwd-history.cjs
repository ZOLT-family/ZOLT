// The only large step so far: CRWD 1x -> 4x, effective 2026-07-02 13:30:00Z.
// One pool held CRWD at the time (Uniswap v3 CRWD/USDG, 1%). Read its whole swap history and answer:
// when did the pool price catch up with the 4x, and who bought CRWD below the post-step fair price?
const fs = require('fs');
const path = require('path');
const { createRequire } = require('module');
const { rpc, getLogsChunked, blockTs } = require('./rpc.cjs');

const req = createRequire(path.join(__dirname, '..', 'contracts', 'package.json'));
const { keccak256, toHex, decodeAbiParameters } = req('viem');

const EVID = path.join(__dirname, '..', 'evidence');
const pools = JSON.parse(fs.readFileSync(path.join(EVID, 'pools.json'), 'utf8'));
const crwd = pools.v3.filter((p) => p.sym === 'CRWD').sort((a, b) => a.createdBlock - b.createdBlock)[0];
const T_SWAP_V3 = keccak256(toHex('Swap(address,address,int256,int256,uint160,uint128,int24)'));
const EFFECTIVE = Date.parse('2026-07-02T13:30:00Z') / 1000;
const Q96 = 2 ** 96;

const head = parseInt(rpc('eth_blockNumber', []), 16);
const logs = getLogsChunked({ address: crwd.pool, topics: [T_SWAP_V3] }, crwd.createdBlock, head);
console.log('CRWD/USDG v3 pool', crwd.pool, 'fee', crwd.fee, 'stockSide', crwd.stockSide, 'swaps ever:', logs.length);

const rows = logs.map((l) => {
  const [a0, a1, sqrtP] = decodeAbiParameters(
    [{ type: 'int256' }, { type: 'int256' }, { type: 'uint160' }, { type: 'uint128' }, { type: 'int24' }], l.data);
  const stockToPool = crwd.stockSide === 0 ? a0 : a1;
  const quoteToPool = crwd.stockSide === 0 ? a1 : a0;
  const s = Number(sqrtP) / Q96;
  const p1per0 = s * s;
  const price = crwd.stockSide === 0 ? p1per0 * 1e12 : (1 / p1per0) * 1e12; // USDG (6 dec) per CRWD (18 dec)
  return {
    block: parseInt(l.blockNumber, 16), tx: l.transactionHash,
    stockOut: -Number(stockToPool) / 1e18, usdgIn: Number(quoteToPool) / 1e6, priceAfter: price,
  };
});

for (const r of rows) r.ts = blockTs(r.block);
const pre = rows.filter((r) => r.ts < EFFECTIVE);
const post = rows.filter((r) => r.ts >= EFFECTIVE);
const pPre = pre.length ? pre[pre.length - 1].priceAfter : null;
console.log('swaps before the step:', pre.length, '| last pre-step pool price:', pPre && pPre.toFixed(4), 'USDG per CRWD');
console.log('swaps after the step:', post.length);

let taken = 0;
const takers = [];
if (pPre) {
  const fair = pPre * 4;
  for (const r of post) {
    if (r.stockOut > 0) {
      const execPrice = r.usdgIn / r.stockOut;
      const gain = r.stockOut * fair - r.usdgIn;
      if (gain > 0) { taken += gain; takers.push({ ...r, execPrice, gain }); }
    }
  }
  console.log('post-step fair (4x the last pre-step pool price):', fair.toFixed(4));
}
for (const r of post.slice(0, 15)) {
  console.log(new Date(r.ts * 1000).toISOString(), 'blk', r.block, 'CRWD out', r.stockOut.toFixed(6), 'USDG in', r.usdgIn.toFixed(4), 'price after', r.priceAfter.toFixed(4), r.tx.slice(0, 14));
}
console.log('USDG taken below the 4x fair price, all time after the step:', taken.toFixed(4), 'across', takers.length, 'buys');

fs.writeFileSync(path.join(EVID, 'crwd-history.json'), JSON.stringify({
  pool: crwd, effectiveAt: '2026-07-02T13:30:00Z', swapsEver: rows.length, preStepPrice: pPre,
  postStepFair: pPre ? pPre * 4 : null, takenUSDG: taken, takers, rows,
}, null, 1));
console.log('wrote evidence/crwd-history.json');
