// Builds site/index.html from site/template.html and the evidence files, so every number on the page traces to
// a JSON file in evidence/ or contracts/deploy/.
//   node site/build-site.cjs
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const EVID = path.join(ROOT, 'evidence');
const read = (f) => JSON.parse(fs.readFileSync(path.join(EVID, f), 'utf8'));
const maybe = (f) => (fs.existsSync(path.join(EVID, f)) ? read(f) : null);

const steps = read('steps.json').steps;
const pools = read('pools.json');
const attributed = read('steps-attributed.json');
const exposure = read('exposure.json');
const crwd = read('crwd-history.json');
const doppler = maybe('doppler.json');
const dopplerAuth = maybe('doppler-authorities.json');
const deploy = JSON.parse(fs.readFileSync(path.join(ROOT, 'contracts', 'deploy', 'zolt-4663.json'), 'utf8'));
const testsTxt = fs.readFileSync(path.join(EVID, 'tests.txt'), 'utf8');

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const int = (n) => Math.round(Number(n)).toLocaleString('en-US');
const usd = (n) => '$' + Number(n).toLocaleString('en-US', { maximumFractionDigits: n < 100 ? 0 : 0 });
const millions = (n) => '$' + (n / 1e6).toFixed(1) + 'M';
const iso = (s) => s.replace('.000Z', 'Z').replace('T', ' ').slice(0, 16) + ' UTC';

// the newest entry in the ledger: the card in the masthead always shows the most recent step, not a fixed ticker
const last = steps[steps.length - 1];
const leads = steps.map((s) => s.leadSeconds).filter((x) => x > 0 && x < 3600).sort((a, b) => a - b);
const burned = dopplerAuth ? dopplerAuth.timelocks.filter((t) => /^0x0{40}$|^0x0{36}dead$/i.test(t.timelock)).reduce((a, t) => a + t.pools, 0) : 0;

// the marquee: all steps, oldest first
const marquee = '<ul>' + steps.map((s) => {
  const r = s.newMultiplier / s.oldMultiplier;
  const label = r >= 1.5 ? '×' + r.toFixed(3) : '+' + ((r - 1) * 100).toFixed(r - 1 < 0.0001 ? 5 : 3) + '%';
  return `<li${r >= 1.5 ? ' class="big"' : ''}><b>${esc(s.sym)}</b><span class="s">${label}</span>${esc(s.effectiveAt.slice(0, 10))} · ${int(s.leadSeconds)} s notice · ${int(s.poolsExposed)} pool${s.poolsExposed === 1 ? '' : 's'}</li>`;
}).join('') + '</ul>';

// the ledger: one ruled row per step, oldest first, numbered the way a book of entries would be
const stepRows = steps.map((s, i) => {
  const r = s.newMultiplier / s.oldMultiplier;
  const big = r >= 1.5;
  const label = big ? '×' + r.toFixed(3) : '+' + ((r - 1) * 100).toFixed(r - 1 < 0.0001 ? 5 : 3) + '%';
  const att = (attributed.summary.find((x) => x.sym === s.sym && x.effectiveAt === s.effectiveAt) || {}).stepAttributable;
  const taken = att === undefined ? '–' : '$' + (att < 1 ? att.toFixed(2) : int(att));
  return `          <tr${big ? ' class="big"' : ''}><td class="ix">${String(i + 1).padStart(2, '0')}</td><td class="sym">${esc(s.sym)}</td><td class="dt">${esc(s.effectiveAt.slice(0, 10))}</td><td class="n mult">${label}</td><td class="n">${int(s.leadSeconds)} s</td><td class="n">${int(s.poolsExposed)}</td><td class="n">${taken}</td></tr>`;
}).join('\n');

// exposure rows: top 8 by value, one scale
const top = exposure.rows.filter((r) => r.usdInPools).slice(0, 8);
const max = top[0].usdInPools;
const exposureBars = top.map((r) => `        <div class="xrow" role="listitem"><span class="t">${esc(r.sym)}</span><span class="track"><span class="fill" style="width:${(100 * r.usdInPools / max).toFixed(1)}%"></span></span><span class="v">${millions(r.usdInPools)}</span><span class="v dim">${r.shareOfSupplyInPoolsPct}% of supply</span></div>`).join('\n');

// The token table the page reads the chain with: every active stock token, its address, how many pools hold
// it, and whether it has stepped before. Compact on purpose — it ships inside the page.
const assets = read('assets.json').assets;
const poolCount = {};
for (const p of [...pools.v4, ...pools.v3]) {
  const t = (p.stockToken || '').toLowerCase();
  poolCount[t] = (poolCount[t] || 0) + 1;
}
const steppedTokens = new Set(steps.map((s) => s.token.toLowerCase()));
const tokenRows = assets
  .filter((a) => a.status === 'ASSET_STATUS_ACTIVE' && a.deployments && a.deployments[0])
  .map((a) => {
    const addr = a.deployments[0].contractAddress;
    const key = addr.toLowerCase();
    // pools were only ever counted for tokens that have already stepped, so -1 means "never looked", not "none"
    const stepped = steppedTokens.has(key);
    return [a.tokenSymbol, addr, stepped ? (poolCount[key] || 0) : -1, stepped ? 1 : 0];
  })
  .sort((a, b) => b[2] - a[2] || a[0].localeCompare(b[0]));

// the simulator's first frame: 4:1 split, 1,000 quote, same rule as the page script and the contract
const X = 1000; const Y = 100000; const P0 = Y / X; const BASE = 0.003; const R = 4; const Q = 1000;
const buy = (q, fee) => X - (X * Y) / (Y + q * (1 - fee));
const stepFee = Math.min(0.999999, Math.max(BASE, Math.ceil((1 - 1 / R) * 1e6) / 1e6));
const bareWorth = buy(Q, BASE) * P0 * R;
const guardWorth = buy(Q, stepFee) * P0 * R;

const values = {
  solTests: (testsTxt.match(/(\d+) passing/) || [])[1] || '–',
  keeperTests: (testsTxt.match(/ℹ pass (\d+)/) || [])[1] || '–',
  stepsCount: steps.length,
  stepAttr: usd(attributed.totals.stepAttributableAllSteps),
  stepAttrEth: attributed.totals.stepAttributableAllStepsETH,
  usdExposed: millions(exposure.usdInPoolsPricedTokens),
  poolsTotal: int(pools.v4.length + pools.v3.length),
  v4: int(pools.v4.length),
  hooked: int(attributed.totals.v4PoolsWithAHook),
  crwdSwaps: int(crwd.swapsEver),
  pricedTokens: exposure.pricedTokens,
  unpricedTokens: exposure.unpricedTokensWithPoolBalance,
  head: int(exposure.head),
  lastSym: esc(last.sym),
  lastBlock: int(last.emitBlock),
  lastEmitAt: iso(last.emitAt),
  lastOld: last.oldMultiplier.toFixed(6),
  lastNew: last.newMultiplier.toFixed(6),
  lastEff: iso(last.effectiveAt),
  lastLead: int(last.leadSeconds),
  lastPools: int(last.poolsExposed),
  leadMin: leads[0],
  leadMax: leads[leads.length - 1],
  dopplerPools: int(doppler ? doppler.dopplerPools : 0),
  burned: int(burned),
  openSlots: int((doppler ? doppler.dopplerPools : 0) - burned),
  slotTaken: int(doppler ? doppler.slotTaken : 0),
  slotEmpty: int(doppler ? doppler.slotEmpty : 0),
  safe: dopplerAuth && dopplerAuth.safe.threshold ? `Safe ${dopplerAuth.safe.version} · ${dopplerAuth.safe.threshold}-of-${dopplerAuth.safe.owners.length}` : '–',
  deployAddr: deploy.predictedAddress,
  deployFlags: deploy.flagsInAddress,
  saltsTried: int(deploy.saltsTried),
  deployGas: deploy.simulation ? int(deploy.simulation.estimatedGas) : '–',
  deployBytes: deploy.simulation ? int(deploy.simulation.runtimeBytes) : '–',
  simBareTaken: '+' + int(bareWorth - Q),
  simBareWorth: int(bareWorth),
  simGuardWorth: int(guardWorth),
  simKept: int(Q * stepFee),
  simFeePct: (stepFee * 100).toFixed(0) + '%',
  marquee,
  stepRows,
  exposureBars,
  tokenCount: tokenRows.length,
  json: JSON.stringify({
    lead: int(last.leadSeconds),
    doppler: { pools: doppler ? doppler.dopplerPools : 0, burned },
    rpc: 'https://rpc.mainnet.chain.robinhood.com',
    chainId: 4663,
    tokens: tokenRows,
  }).replace(/</g, '\\u003c'),
};

let html = fs.readFileSync(path.join(__dirname, 'template.html'), 'utf8');
html = html.replace(/\{\{(\w+)\}\}/g, (m, k) => {
  if (!(k in values)) throw new Error('template asks for {{' + k + '}} and the builder has no value for it');
  return String(values[k]);
});
fs.writeFileSync(path.join(__dirname, 'index.html'), html);
console.log('wrote site/index.html', html.length, 'chars');

// A standalone copy for opening straight from disk or hosting anywhere: the artifact platform adds the doctype,
// charset and viewport itself; a plain browser needs them in the file, and a shared link needs the cards.
const SITE = 'https://zolt-smoky.vercel.app/';
const DESC = 'A stock token can change what one token stands for. Pools keep quoting the old share count. '
  + 'Zolt is a Uniswap v4 hook that reads the notice first and charges the gap to whoever trades into it. '
  + 'Unaudited and not deployed.';
// the staircase mark, inline so the tab icon costs no request
const ICON = '<svg xmlns=\'http://www.w3.org/2000/svg\' viewBox=\'0 0 26 26\'>'
  + '<rect width=\'26\' height=\'26\' fill=\'%23E6EBE2\'/>'
  + '<path d=\'M2 22h6v-6h6v-6h6V4h4\' fill=\'none\' stroke=\'%23B9861F\' stroke-width=\'3\'/>'
  + '<rect x=\'18\' y=\'1\' width=\'6\' height=\'6\' fill=\'%23D2401F\'/></svg>';
const head = [
  '<meta charset="utf-8">',
  '<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">',
  '<meta name="description" content="' + DESC + '">',
  '<meta name="theme-color" content="#E6EBE2">',
  '<link rel="canonical" href="' + SITE + '">',
  '<link rel="icon" href="data:image/svg+xml,' + ICON + '">',
  '<meta property="og:type" content="website">',
  '<meta property="og:site_name" content="Zolt">',
  '<meta property="og:title" content="Zolt — the share count changes, your pool doesn’t know">',
  '<meta property="og:description" content="' + DESC + '">',
  '<meta property="og:url" content="' + SITE + '">',
  '<meta name="twitter:card" content="summary">',
  '<meta name="twitter:title" content="Zolt — the share count changes, your pool doesn’t know">',
  '<meta name="twitter:description" content="' + DESC + '">',
].join('\n');
const standalone = '<!doctype html>\n<html lang="en">\n<head>\n' + head + '\n</head>\n<body>\n' + html + '\n</body>\n</html>\n';
fs.writeFileSync(path.join(__dirname, 'zolt.html'), standalone);
console.log('wrote site/zolt.html (standalone)', standalone.length, 'chars');

// The folder Vercel serves: the page, and the two files a crawler asks for.
const PUB = path.join(__dirname, 'public');
fs.mkdirSync(PUB, { recursive: true });
fs.writeFileSync(path.join(PUB, 'index.html'), standalone);
fs.writeFileSync(path.join(PUB, 'robots.txt'), 'User-agent: *\nAllow: /\nSitemap: ' + SITE + 'sitemap.xml\n');
fs.writeFileSync(path.join(PUB, 'sitemap.xml'),
  '<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n'
  + '  <url><loc>' + SITE + '</loc><lastmod>' + new Date().toISOString().slice(0, 10) + '</lastmod></url>\n</urlset>\n');
console.log('wrote site/public/{index.html,robots.txt,sitemap.xml} (deploy folder)');
