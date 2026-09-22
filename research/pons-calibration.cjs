// Calibration: how much ETH a curve had raised two and ten minutes after launch, against whether it swept within
// the hour. The public node keeps no historical state, so the balance is rebuilt from the curve's own trade
// events: sum of CurveBuy quoteIn minus fee and tax, minus CurveSell quoteOut. ETH-paired launches only.
//
// The sample is every launch that swept, plus one in N of the rest; the page re-weights it back to the population
// using the counts recorded here. Read-only. Output: evidence/pons-calibration.json
//
//   node research/pons-calibration.cjs
const fs = require('fs');
const path = require('path');
const { createRequire } = require('module');
const { rpc, getLogsChunked } = require('./rpc.cjs');
const { keccak256, toHex } = createRequire(path.join(__dirname, '..', 'contracts', 'package.json'))('viem');

const FACTORY = '0x7ed598bcef8bd9edd8c97a195c6d13f40801ec7e';
const T_LAUNCH = '0x8d4aad4953d0ca700d468f3753aa14432d1b35b43ec6409f051fb6aa43a89607';
const T_SWEPT = '0xcdb72f157fd3666758a6ce201387ffb52038c7562e4fff352828da1096c4b6b4'; // LaunchSwept
const T_BUY = keccak256(toHex('CurveBuy(address,address,uint256,uint256,uint256,uint256)'));
const T_SELL = keccak256(toHex('CurveSell(address,address,uint256,uint256,uint256,uint256)'));
const ETH = '0x0000000000000000000000000000000000000000';
const SAMPLE = 300;

const head = parseInt(rpc('eth_blockNumber', []), 16);
const from = head - 864000 - 40000, to = head - 40000; // ends about 67 minutes ago, so every launch has had its hour
const launches = getLogsChunked({ address: FACTORY, topics: [T_LAUNCH] }, from, to).filter((l) => ('0x' + l.data.slice(26, 66)) === ETH);
const swept = getLogsChunked({ address: FACTORY, topics: [T_SWEPT] }, from, head);
const sweptBlock = {};
for (const l of swept) sweptBlock['0x' + l.topics[1].slice(26)] = parseInt(l.blockNumber, 16);
const isSwept = (l) => sweptBlock['0x' + l.topics[1].slice(26)] !== undefined;

const pick = launches.filter(isSwept);
const rest = launches.filter((l) => !isSwept(l));
const every = Math.ceil(rest.length / SAMPLE);
for (let i = 0; i < rest.length; i += every) pick.push(rest[i]);
console.log('ETH launches', launches.length, 'sweeps', swept.length, 'sampling', pick.length, '(one in', every, 'of the unswept)');

const rows = [];
for (const l of pick) {
  const t = '0x' + l.topics[1].slice(26), curve = '0x' + l.topics[2].slice(26), lb = parseInt(l.blockNumber, 16), sb = sweptBlock[t];
  let logs = [];
  try { logs = getLogsChunked({ address: curve, topics: [[T_BUY, T_SELL]] }, lb, lb + 6000); } catch (e) { continue; }
  const raisedAt = (sec) => {
    let q = 0n;
    for (const g of logs) {
      if (parseInt(g.blockNumber, 16) > lb + sec * 10) break;
      const w = g.data.slice(2);
      const a = BigInt('0x' + w.slice(0, 64)), b = BigInt('0x' + w.slice(64, 128)), fee = BigInt('0x' + w.slice(128, 192)), tax = BigInt('0x' + w.slice(192, 256));
      if (g.topics[0] === T_BUY) q += a - fee - tax; else q -= b;
    }
    return Number(q) / 1e18;
  };
  rows.push({ token: t, launchBlock: lb, sweptBlock: sb === undefined ? null : sb, secondsToSweep: sb === undefined ? null : (sb - lb) / 10, trades600: logs.length, eth120: raisedAt(120), eth600: raisedAt(600) });
}

fs.writeFileSync(path.join(__dirname, '..', 'evidence', 'pons-calibration.json'), JSON.stringify({
  head, from, to, ethLaunches: launches.length, sweptTotal: swept.length, sampleEvery: every,
  method: 'sum of CurveBuy quoteIn minus fee and tax, minus CurveSell quoteOut, per curve, at 120 s and 600 s after launch; ETH-paired launches; every swept launch in the window plus one in N of the rest',
  rows, measuredAt: new Date().toISOString(),
}, null, 1));

const bucket = (v) => (v < 0.05 ? '<0.05' : v < 0.2 ? '<0.2' : v < 0.5 ? '<0.5' : v < 1 ? '<1' : v < 2 ? '<2' : v < 3 ? '<3' : '>=3');
const tab = {};
for (const r of rows) { const k = bucket(r.eth120); tab[k] = tab[k] || { n: 0, s: 0 }; tab[k].n++; if (r.secondsToSweep !== null && r.secondsToSweep <= 3600) tab[k].s++; }
console.log('raised at 120 s -> swept within 1 h (sample, enriched with every sweep):');
for (const k of ['<0.05', '<0.2', '<0.5', '<1', '<2', '<3', '>=3']) if (tab[k]) console.log('  ', k.padEnd(6), 'n', String(tab[k].n).padStart(4), 'swept', String(tab[k].s).padStart(4));
console.log('wrote evidence/pons-calibration.json');
