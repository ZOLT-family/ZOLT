// Every figure the docs and the site are allowed to quote, printed from evidence/ in one place.
//   node research/figures.cjs
// Reads files only — no chain calls. If a number in BRIEF_ID.md, README.md or the page disagrees with
// this output, the number is stale.
const fs = require('fs');
const path = require('path');

const EVID = path.join(__dirname, '..', 'evidence');
const read = (f) => JSON.parse(fs.readFileSync(path.join(EVID, f), 'utf8'));
const maybe = (f) => (fs.existsSync(path.join(EVID, f)) ? read(f) : null);
const n = (x) => Math.round(Number(x)).toLocaleString('en-US');

const steps = read('steps.json');
const pools = read('pools.json');
const exposure = read('exposure.json');
const att = maybe('steps-attributed.json');
const crwd = maybe('crwd-history.json');
const doppler = maybe('doppler.json');
const auth = maybe('doppler-authorities.json');

const leads = steps.steps.map((s) => s.leadSeconds).filter((x) => x > 0 && x < 3600).sort((a, b) => a - b);
const tickers = new Set(steps.steps.map((s) => s.sym));
const burned = auth ? auth.timelocks.filter((t) => /^0x0{40}$|^0x0{36}dead$/i.test(t.timelock)).reduce((a, t) => a + t.pools, 0) : null;

const rows = [
  ['steps measured', n(steps.steps.length) + ' across ' + tickers.size + ' tickers'],
  ['notice, short steps', leads[0] + '-' + leads[leads.length - 1] + ' s'],
  ['notice, the two CRWD steps', steps.steps.filter((s) => s.leadSeconds >= 3600).map((s) => n(s.leadSeconds) + ' s').join(', ') || '-'],
  ['measured to block', n(steps.head)],
  ['measured at', steps.measuredAt],
  ['v4 pools holding a stepped token', n(pools.v4.length)],
  ['v3 pools holding a stepped token', n(pools.v3.length)],
  ['pools, both venues', n(pools.v4.length + pools.v3.length)],
  ['value sitting in pools', '$' + (exposure.usdInPoolsPricedTokens / 1e6).toFixed(1) + 'M'],
  ['tokens priced by a feed', exposure.pricedTokens],
  ['tokens with balances and no feed', exposure.unpricedTokensWithPoolBalance],
  ['census head block', n(exposure.head)],
];
if (att) {
  rows.push(['attributable to the steps themselves', '$' + Number(att.totals.stepAttributableAllSteps).toFixed(2) + ' + ' + att.totals.stepAttributableAllStepsETH + ' ETH']);
  rows.push(['raw taken across the same windows', '$' + Number(att.totals.rawTakenAllSteps || 0).toFixed(2)]);
  rows.push(['v4 pools that already carry a hook', n(att.totals.v4PoolsWithAHook)]);
}
if (crwd) rows.push(['swaps ever in the pool that held CRWD', n(crwd.swapsEver)]);
if (doppler) {
  rows.push(['Doppler pools', n(doppler.dopplerPools)]);
  rows.push(['module slots filled / empty', n(doppler.slotTaken) + ' / ' + n(doppler.slotEmpty)]);
  rows.push(['fee cap a module may set', (doppler.dopplerMaxLpFee / 10000).toFixed(0) + '%']);
}
if (auth) {
  rows.push(['Doppler pools with a burned timelock', n(burned) + ' of ' + n(doppler ? doppler.dopplerPools : 0)]);
  rows.push(['Doppler pools still changeable', n((doppler ? doppler.dopplerPools : 0) - burned)]);
  if (auth.safe && auth.safe.threshold) rows.push(['Airlock owner', 'Safe ' + auth.safe.version + ' ' + auth.safe.threshold + '-of-' + auth.safe.owners.length]);
}

const w = rows.reduce((a, r) => Math.max(a, r[0].length), 0);
console.log('figures from evidence/ — everything read-only, nothing claimed that a file here does not hold\n');
for (const [k, v] of rows) console.log('  ' + k.padEnd(w) + '  ' + v);
console.log('\nbiggest steps by ratio:');
for (const s of steps.steps.slice().sort((a, b) => b.newMultiplier / b.oldMultiplier - a.newMultiplier / a.oldMultiplier).slice(0, 5)) {
  const r = s.newMultiplier / s.oldMultiplier;
  console.log('  ' + s.sym.padEnd(6) + s.effectiveAt.slice(0, 10) + '  ' + (r >= 1.5 ? 'x' + r.toFixed(3) : '+' + ((r - 1) * 100).toFixed(3) + '%').padStart(10)
    + '  ' + n(s.poolsExposed).padStart(7) + ' pools');
}
