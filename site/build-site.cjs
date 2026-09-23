// Builds the Zolt Odds page from site/template.html and the evidence files, so every number on the page traces
// to a JSON file in evidence/, a test file, or a deployment record in contracts/deploy/.
//   node site/build-site.cjs
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const EVID = path.join(ROOT, 'evidence');
const read = (f) => JSON.parse(fs.readFileSync(path.join(EVID, f), 'utf8'));
const maybe = (f) => (fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : null);

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const int = (n) => Math.round(Number(n)).toLocaleString('en-US');
const pct = (a, b, d = 1) => (b ? (100 * a / b).toFixed(d) + '%' : '–');
const dur = (s) => (s === null || s === undefined ? '–' : s < 90 ? Math.round(s) + ' s' : s < 5400 ? (s / 60).toFixed(s < 600 ? 1 : 0) + ' min' : (s / 3600).toFixed(1) + ' h');

// ------------------------------------------------------------------ the base rate: 24 hours of Pons V2
const pons = read('pons-24h.json');
const durs = pons.timeToGraduationSeconds.slice().sort((a, b) => a - b);
const q = (p) => (durs.length ? durs[Math.min(durs.length - 1, Math.floor(p * durs.length))] : null);
const within = (s) => durs.filter((d) => d <= s).length;
const ETH = '0x0000000000000000000000000000000000000000';
const pairTotal = Object.values(pons.pairTokens).reduce((a, b) => a + b, 0);

// pair tokens: symbols come from the stock-token list when the address is one, otherwise the address is shown
const assets = read('assets.json').assets;
const symOf = { [ETH]: 'ETH', '0x5fc5360d0400a0fd4f2af552add042d716f1d168': 'USDG' };
for (const a of assets) symOf[a.deployments[0].contractAddress.toLowerCase()] = a.tokenSymbol;
const pairs = Object.entries(pons.pairTokens).sort((a, b) => b[1] - a[1]);
const top = pairs.slice(0, 7);
const other = pairs.slice(7).reduce((a, [, n]) => a + n, 0);
const barMax = top[0][1];
const bar = (label, n) => `              <div class="bar"><span class="mono">${esc(label)}</span><span class="track"><span class="fill" style="width:${(100 * n / barMax).toFixed(1)}%"></span></span><span class="v">${int(n)}</span></div>`;
const pairBars = top.map(([addr, n]) => bar(symOf[addr.toLowerCase()] || addr.slice(0, 8) + '…', n)).concat(other ? [bar(`${pairs.length - 7} others`, other)] : []).join('\n');

// ------------------------------------------------------------------ calibration: how full at two minutes, and did it sweep
const cal = maybe(path.join(EVID, 'pons-calibration.json'));
let calibration = '';
if (cal && cal.rows && cal.rows.length && cal.ethLaunches) {
  const rows = cal.rows;
  const sweptRows = rows.filter((r) => r.sweptBlock !== null).length;
  const nonSweptRows = rows.length - sweptRows;
  // every swept launch in the window is in the sample; the rest were sampled one in N, so each stands for N launches
  const weightNon = nonSweptRows ? (cal.ethLaunches - sweptRows) / nonSweptRows : 1;
  const buckets = [['under 0.05 ETH', 0, 0.05], ['0.05 – 0.2', 0.05, 0.2], ['0.2 – 0.5', 0.2, 0.5], ['0.5 – 1', 0.5, 1], ['1 – 2', 1, 2], ['2 – 3', 2, 3], ['3 ETH and up', 3, Infinity]];
  const line = ([label, lo, hi]) => {
    const inB = rows.filter((r) => r.eth120 >= lo && r.eth120 < hi);
    const s1h = inB.filter((r) => r.secondsToSweep !== null && r.secondsToSweep <= 3600);
    const w = inB.reduce((a, r) => a + (r.sweptBlock !== null ? 1 : weightNon), 0);
    const est = w ? (100 * s1h.length / w) : 0;
    return `                  <tr><td>${esc(label)}</td><td class="n">${int(inB.length)}</td><td class="n">${int(s1h.length)}</td><td class="n${est >= 50 ? ' bad' : ''}">${inB.length ? est.toFixed(est < 10 ? 1 : 0) + '%' : '–'}</td></tr>`;
  };
  calibration = `            <div class="ledger" style="margin-top:18px">
              <table>
                <thead><tr><th>ETH on the curve at 2 min</th><th class="n">Sampled</th><th class="n">Swept &lt; 1 h</th><th class="n">Est. rate</th></tr></thead>
                <tbody>
${buckets.map(line).join('\n')}
                </tbody>
                <tfoot><tr><td colspan="4">${int(rows.length)} ETH-paired launches sampled out of ${int(cal.ethLaunches)}: every one that swept, plus one in ${Math.round(weightNon)} of the rest, so the estimate re-weights the sample back to the population. Blocks ${int(cal.from)}–${int(cal.to)}. Read from <code>CurveBuy</code> and <code>CurveSell</code> on each curve.</td></tr></tfoot>
              </table>
            </div>
            <p class="foot">Two minutes in, the curve has usually already decided. That is why the 10-minute window exists, and why weight falls with time: the information arrives fast.</p>`;
}

// ------------------------------------------------------------------ tests and deployment
const countTests = (file, re) => (fs.readFileSync(path.join(ROOT, file), 'utf8').match(re) || []).length;
const oddsTests = countTests('contracts/test/ZoltOdds.t.sol', /function test/g);
const oddsKeeperTests = countTests('keeper/odds-logic.test.cjs', /^test\(/gm);

const FACTORY = '0x7eD598BcEf8bd9Edd8C97A195C6d13f40801EC7e';
const deployed = maybe(path.join(ROOT, 'contracts', 'deploy', 'odds-4663.deployed.json'));
const plan = maybe(path.join(ROOT, 'contracts', 'deploy', 'odds-4663.json'));
const live = deployed && deployed.status === 'DEPLOYED' ? deployed : null;
const gasPlan = live || plan;
// priced at 2 gwei: the chain sat near 0.05 gwei when quiet and 1.7-3.5 gwei during the memecoin rush of 23 Sep
const gasEth = gasPlan && gasPlan.estimatedGas ? (gasPlan.estimatedGas * 2e-9).toFixed(4) + ' at 2 gwei' : '–';

const values = {
  launches24h: int(pons.launches),
  grads24h: int(pons.graduations),
  gradRate24h: pct(pons.graduations, pons.launches),
  gradInWindow: int(pons.gradLaunchedInWindow),
  gradEarlier: int(pons.gradLaunchedEarlier),
  gradP10: dur(q(0.1)), gradP25: dur(q(0.25)), gradMedian: dur(q(0.5)), gradP75: dur(q(0.75)), gradP90: dur(q(0.9)), gradMax: dur(durs[durs.length - 1]),
  gradWithin10m: int(within(600)), gradWithin10mPct: pct(within(600), durs.length),
  gradWithin1h: int(within(3600)), gradWithin1hPct: pct(within(3600), durs.length),
  gradWithin6h: int(within(21600)), gradWithin6hPct: pct(within(21600), durs.length),
  gradWithin24h: int(within(86400)), gradWithin24hPct: pct(within(86400), durs.length),
  ethPairPct: pct(pons.pairTokens[ETH] || 0, pairTotal),
  ponsFrom: int(pons.from),
  ponsHead: int(pons.head),
  pairBars,
  calibration,
  oddsTests,
  oddsKeeperTests,
  stateLine: live ? 'live<br>on chain' : 'not<br>deployed',
  stampLine: live ? 'Deployed · verified · use with care' : 'Unsigned · simulated · not sent',
  deployState: live ? 'deployed' : 'unsigned',
  sourceLine: live && live.sourcify ? '<a href="' + esc(live.sourcify.url) + '">verified on Sourcify</a> &middot; ' + esc(live.sourcify.match) : 'not yet verified',
  oddsShort: live ? live.address.slice(0, 6) + '…' + live.address.slice(-4) : 'not deployed',
  oddsAddr: live ? live.address : 'not deployed — the page runs in read-only preview until it is',
  factoryAddr: FACTORY,
  treasuryAddr: live ? live.treasury : (plan && plan.treasury) || 'set at deployment',
  deployGasOdds: gasPlan && gasPlan.estimatedGas ? int(gasPlan.estimatedGas) : '–',
  deployEthOdds: gasEth,
  json: JSON.stringify({
    rpc: 'https://rpc.mainnet.chain.robinhood.com',
    chainId: 4663,
    factory: FACTORY,
    odds: live ? live.address : null,
    deployedBlock: live && live.deployedBlock ? live.deployedBlock : null,
    // the public address of the keeper this repo runs, if one was made here: the board shows when it last acted
    keeper: fs.existsSync(path.join(ROOT, 'keeper', 'keeper.address')) ? fs.readFileSync(path.join(ROOT, 'keeper', 'keeper.address'), 'utf8').trim() : null,
    sel: {
      symbol: '0x95d89b41', launched: '0x3cf28b5a', reserve: '0x4f1f58fd', market: '0x28861d22',
      openAndStake: '0x34feb02b', claim: '0x379607f5', payout: '0xbe95e01a',
      witnessYes: '0x9d73a63c', witnessNo: '0xbfc7b653', voidUnobserved: '0x9fcb4976',
    },
    topics: {
      launched: '0x8d4aad4953d0ca700d468f3753aa14432d1b35b43ec6409f051fb6aa43a89607',
      graduated: '0x0a44ef75df69c534f43cd6c1aa3ef8983065fe5fe79ef9e79f6494e6f258c259',
      opened: '0x13d3642a6d52374b58ee776c95940fcf6486c6f740891e6d11070c1411e1d3a8',
      resolved: '0xb759306cc71252cdc2f6244717195a7cc712a5551de7fa6dd2bf1819cd7dfadd',
      staked: '0xb1ab008fce4278d96ec4e7b40dd25e28c701cfa4fcd426922c25ad278b0d41ea',
      feeTaken: '0xb4d6a97bdd3b0279677829534375db2695a0fb46143b58f29faeead6ccf6f9cd',
      claimed: '0x4ec90e965519d92681267467f775ada5bd214aa92c0dc93d90a5e880ce9ed026',
    },
    // what a launch can be paired with, and how to print that unit: ETH and the stock tokens use 18 decimals, USDG 6
    pairs: Object.assign({ [ETH]: ['ETH', 18], '0x5fc5360d0400a0fd4f2af552add042d716f1d168': ['USDG', 6] },
      ...assets.map((a) => ({ [a.deployments[0].contractAddress.toLowerCase()]: [a.tokenSymbol, 18] }))),
  }).replace(/</g, '\\u003c'),
};

let html = fs.readFileSync(path.join(__dirname, 'template.html'), 'utf8');
html = html.replace(/\{\{(\w+)\}\}/g, (m, k) => {
  if (!(k in values)) throw new Error('template asks for {{' + k + '}} and the builder has no value for it');
  return String(values[k]);
});
fs.writeFileSync(path.join(__dirname, 'index.html'), html);
console.log('wrote site/index.html', html.length, 'chars');

// The social card is drawn from the same figures: site/og-card.html renders them on a canvas and, opened through
// the local helper, saves site/public/og.png. The PNG is committed; this only refreshes the page that draws it.
const ogCard = fs.readFileSync(path.join(__dirname, 'og-template.html'), 'utf8').replace(/\{\{(\w+)\}\}/g, (m, k) => {
  if (!(k in values)) throw new Error('og-template asks for {{' + k + '}} and the builder has no value for it');
  return String(values[k]);
});
fs.writeFileSync(path.join(__dirname, 'og-card.html'), ogCard);

// A standalone copy for opening straight from disk or hosting anywhere: the artifact platform adds the doctype,
// charset and viewport itself; a plain browser needs them in the file, and a shared link needs the cards.
const SITE = 'https://zolt-smoky.vercel.app/';
const DESC = 'Yes/No markets on whether a freshly launched Pons token graduates in time, settled from the chain’s own state. '
  + 'The first launch odds market on Robinhood Chain.';
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
  '<meta property="og:title" content="Zolt Odds — will it graduate?">',
  '<meta property="og:description" content="' + DESC + '">',
  '<meta property="og:url" content="' + SITE + '">',
  '<meta property="og:image" content="' + SITE + 'og.png">',
  '<meta property="og:image:width" content="1200">',
  '<meta property="og:image:height" content="630">',
  '<meta property="og:image:alt" content="Will it graduate? The first launch odds market on Robinhood Chain.">',
  '<meta name="twitter:card" content="summary_large_image">',
  '<meta name="twitter:title" content="Zolt Odds — will it graduate?">',
  '<meta name="twitter:description" content="' + DESC + '">',
  '<meta name="twitter:image" content="' + SITE + 'og.png">',
].join('\n');
const standalone = '<!doctype html>\n<html lang="en">\n<head>\n' + head + '\n</head>\n<body>\n' + html + '\n</body>\n</html>\n';
fs.writeFileSync(path.join(__dirname, 'zolt.html'), standalone);
console.log('wrote site/zolt.html (standalone)', standalone.length, 'chars');

// The deploy page: a wallet signs the contract creation, nothing on disk holds a key. Built with this build's
// bytecode so what gets deployed is what was tested. Served locally by site/serve.cjs; never copied to public/.
const artifactFile = path.join(ROOT, 'contracts', 'artifacts', 'src', 'ZoltOdds.sol', 'ZoltOdds.json');
if (fs.existsSync(artifactFile)) {
  const artifact = JSON.parse(fs.readFileSync(artifactFile, 'utf8'));
  const deployPage = fs.readFileSync(path.join(__dirname, 'deploy-template.html'), 'utf8')
    .replace(/\{\{factoryAddr\}\}/g, FACTORY)
    .replace(/\{\{bytecode\}\}/g, artifact.bytecode)
    .replace(/\{\{deployGas\}\}/g, gasPlan && gasPlan.estimatedGas ? int(gasPlan.estimatedGas) : '1.4 million');
  fs.writeFileSync(path.join(__dirname, 'deploy.html'), deployPage);
  console.log('wrote site/deploy.html (local deploy page, bytecode of this build)');
}

// The folder Vercel serves: the page, the archived split-guard page, and the two files a crawler asks for.
const PUB = path.join(__dirname, 'public');
fs.mkdirSync(PUB, { recursive: true });
fs.writeFileSync(path.join(PUB, 'index.html'), standalone);
fs.copyFileSync(path.join(__dirname, 'guard.html'), path.join(PUB, 'guard.html'));
fs.writeFileSync(path.join(PUB, 'robots.txt'), 'User-agent: *\nAllow: /\nSitemap: ' + SITE + 'sitemap.xml\n');
fs.writeFileSync(path.join(PUB, 'sitemap.xml'),
  '<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n'
  + '  <url><loc>' + SITE + '</loc><lastmod>' + new Date().toISOString().slice(0, 10) + '</lastmod></url>\n'
  + '  <url><loc>' + SITE + 'guard</loc><lastmod>' + new Date().toISOString().slice(0, 10) + '</lastmod></url>\n</urlset>\n');
console.log('wrote site/public/{index.html,guard.html,robots.txt,sitemap.xml} (deploy folder)');
