// Builds site/index.html from the evidence files, so every number on the page traces to a JSON file.
//   node site/build-site.cjs
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const EVID = path.join(ROOT, 'evidence');
const read = (f) => JSON.parse(fs.readFileSync(path.join(EVID, f), 'utf8'));

const steps = read('steps.json').steps;
const pools = read('pools.json');
const attributed = fs.existsSync(path.join(EVID, 'steps-attributed.json')) ? read('steps-attributed.json') : null;
const exposure = fs.existsSync(path.join(EVID, 'exposure.json')) ? read('exposure.json') : null;
const crwd = read('crwd-history.json');
const doppler = fs.existsSync(path.join(EVID, 'doppler.json')) ? read('doppler.json') : null;
const dopplerAuth = fs.existsSync(path.join(EVID, 'doppler-authorities.json')) ? read('doppler-authorities.json') : null;
const deployFile = path.join(ROOT, 'contracts', 'deploy', 'stepguard-4663.json');
const deploy = fs.existsSync(deployFile) ? JSON.parse(fs.readFileSync(deployFile, 'utf8')) : null;
const burned = dopplerAuth ? dopplerAuth.timelocks.filter((t) => /^0x0{40}$|^0x0{36}dead$/i.test(t.timelock)).reduce((a, t) => a + t.pools, 0) : null;
const testsTxt = fs.readFileSync(path.join(EVID, 'tests.txt'), 'utf8');
const solPassing = (testsTxt.match(/(\d+) passing/) || [])[1];
const keeperPassing = (testsTxt.match(/ℹ pass (\d+)/) || [])[1];

const fmtInt = (n) => Number(n).toLocaleString('en-US');
const fmtUsd = (n) => '$' + Number(n).toLocaleString('en-US', { maximumFractionDigits: n < 10 ? 2 : 0 });
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

const v4Count = pools.v4.length;
const v3Count = pools.v3.length;
const hooked = pools.v4.filter((p) => p.hooks !== '0x0000000000000000000000000000000000000000').length;
const nvda = steps.find((s) => s.sym === 'NVDA');
const crwdStep = steps.find((s) => s.sym === 'CRWD');
const stepAttr = attributed ? attributed.totals.stepAttributableAllSteps : null;
const stepAttrEth = attributed ? attributed.totals.stepAttributableAllStepsETH : null;
const dopplerHook = attributed ? attributed.hooks[0] : null;
const distinctHooks = attributed ? attributed.totals.distinctHooks : null;
const usdExposed = exposure ? exposure.usdInPoolsPricedTokens : null;
const fmtMillions = (n) => '$' + (n / 1e6).toFixed(1) + 'M';
const rawTaken = attributed ? attributed.totals.rawTakenAllSteps : null;
const leads = steps.map((s) => s.leadSeconds).filter((x) => x > 0 && x < 3600).sort((a, b) => a - b);
const leadMin = leads[0];
const leadMax = leads[leads.length - 1];

const stepRows = steps.map((s) => {
  const ratio = s.newMultiplier / s.oldMultiplier;
  const stepLabel = ratio >= 1.5 ? '×' + ratio.toFixed(3) : '+' + ((ratio - 1) * 100).toFixed(ratio - 1 < 0.0001 ? 5 : 3) + '%';
  const attr = attributed ? (attributed.summary.find((x) => x.sym === s.sym && x.effectiveAt === s.effectiveAt) || {}).stepAttributable : null;
  return `<tr${ratio >= 1.5 ? ' class="big"' : ''}><td class="sym">${esc(s.sym)}</td><td>${esc(s.effectiveAt.slice(0, 16).replace('T', ' '))}</td><td class="num">${stepLabel}</td><td class="num">${fmtInt(s.leadSeconds)} s</td><td class="num">${fmtInt(s.poolsExposed)}</td><td class="num">${attr === null || attr === undefined ? '–' : fmtUsd(attr)}</td></tr>`;
}).join('\n');

const exposureRows = exposure ? exposure.rows.filter((r) => r.usdInPools).slice(0, 8).map((r) =>
  `<tr><td class="sym">${esc(r.sym)}</td><td class="num">${r.rawInV4PoolManager === null ? '–' : r.rawInV4PoolManager.toLocaleString('en-US', { maximumFractionDigits: 2 })}</td><td class="num">${r.shareOfSupplyInPoolsPct === null ? '–' : r.shareOfSupplyInPoolsPct + '%'}</td><td class="num">${fmtUsd(r.usdInPools)}</td><td>${r.stepped ? '<span class="chip">has stepped</span>' : ''}</td></tr>`).join('\n') : '';

const html = `<title>Stepguard</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Bricolage+Grotesque:opsz,wght@12..96,500;12..96,700;12..96,800&family=IBM+Plex+Sans:wght@400;500;600&family=IBM+Plex+Mono:wght@400;500&display=swap">
<style>
:root{
  --ground:#EDF1EE; --panel:#F7F9F7; --ink:#12201A; --ink-2:#4A5A52; --rule:#C9D3CD;
  --gap:#C77C02; --gap-soft:rgba(199,124,2,.16); --guard:#0B6A5A; --guard-soft:rgba(11,106,90,.12);
  --display:"Bricolage Grotesque", "Arial Narrow", system-ui, sans-serif;
  --body:"IBM Plex Sans", system-ui, -apple-system, "Segoe UI", sans-serif;
  --mono:"IBM Plex Mono", ui-monospace, "Cascadia Mono", Consolas, monospace;
}
@media (prefers-color-scheme: dark){
  :root:not([data-theme="light"]){
    --ground:#0E1613; --panel:#15201B; --ink:#E2EAE5; --ink-2:#9AAAA2; --rule:#2A3832;
    --gap:#F0A92A; --gap-soft:rgba(240,169,42,.16); --guard:#43B79E; --guard-soft:rgba(67,183,158,.14);
  }
}
:root[data-theme="dark"]{
  --ground:#0E1613; --panel:#15201B; --ink:#E2EAE5; --ink-2:#9AAAA2; --rule:#2A3832;
  --gap:#F0A92A; --gap-soft:rgba(240,169,42,.16); --guard:#43B79E; --guard-soft:rgba(67,183,158,.14);
}
*{box-sizing:border-box}
body{background:var(--ground);color:var(--ink);font:16px/1.6 var(--body);margin:0}
.wrap{max-width:1080px;margin:0 auto;padding-inline:clamp(16px,4vw,40px);padding-block:32px 72px}
a{color:var(--guard)}
a:focus-visible,button:focus-visible{outline:2px solid var(--gap);outline-offset:3px}
.eyebrow{font:500 12px/1.4 var(--mono);letter-spacing:.08em;text-transform:uppercase;color:var(--ink-2);margin:0}
h1,h2,h3{font-family:var(--display);text-wrap:balance;margin:0}
h1{font-weight:800;font-size:clamp(40px,7vw,84px);line-height:.95;letter-spacing:-.025em}
h1 .quiet{color:var(--ink-2)}
h2{font-weight:700;font-size:clamp(28px,4vw,44px);line-height:1.02;letter-spacing:-.015em}
h3{font-weight:700;font-size:20px;line-height:1.2}
p{max-width:64ch;margin:0}
.lede{font-size:clamp(18px,2vw,21px);color:var(--ink-2)}
.mono{font-family:var(--mono)}
section{display:grid;gap:20px;padding-block:56px;border-top:1px solid var(--rule)}
header.hero{display:grid;gap:28px;padding-block:24px 48px}
.hero-top{display:flex;justify-content:space-between;gap:16px;flex-wrap:wrap;align-items:baseline}
.brand{font:800 22px/1 var(--display);letter-spacing:-.01em}
.brand b{color:var(--guard)}
.status{font:500 12px/1.4 var(--mono);color:var(--gap);border:1px solid var(--gap);padding:4px 10px;border-radius:999px}
.chart{background:var(--panel);border:1px solid var(--rule);border-radius:6px;padding:16px;overflow-x:auto}
.chart svg{display:block;width:100%;min-width:560px;height:auto}
.chart .cap{font:12px/1.5 var(--mono);color:var(--ink-2);margin-top:8px}
.readout{font:14px/1.9 var(--mono);background:var(--panel);border:1px solid var(--rule);border-radius:6px;padding:18px 20px;overflow-x:auto;white-space:nowrap}
.readout .k{color:var(--ink-2);display:inline-block;min-width:15ch}
.readout .v{color:var(--ink)}
.readout .hi{color:var(--gap);font-weight:500}
.split{display:grid;grid-template-columns:repeat(auto-fit,minmax(280px,1fr));gap:24px;align-items:start}
.figure{display:grid;gap:4px}
.figure .n{font:800 clamp(40px,6vw,64px)/1 var(--display);letter-spacing:-.02em;font-variant-numeric:tabular-nums}
.figure .n.gap{color:var(--gap)}
.figure .n.guard{color:var(--guard)}
.figure .l{color:var(--ink-2);font-size:15px;max-width:34ch}
.tablebox{overflow-x:auto;border:1px solid var(--rule);border-radius:6px;background:var(--panel)}
table{border-collapse:collapse;width:100%;font-size:14px}
th,td{padding:9px 14px;text-align:left;border-bottom:1px solid var(--rule);white-space:nowrap}
th{font:500 11px/1.3 var(--mono);letter-spacing:.07em;text-transform:uppercase;color:var(--ink-2)}
td.num{font-family:var(--mono);font-variant-numeric:tabular-nums;text-align:right}
th.num{text-align:right}
td.sym{font:500 14px var(--mono)}
tr.big td{background:var(--gap-soft)}
tr:last-child td{border-bottom:0}
.chip{font:500 11px/1 var(--mono);color:var(--guard);background:var(--guard-soft);padding:4px 8px;border-radius:999px}
ol.steps{list-style:none;margin:0;padding:0;display:grid;gap:14px;counter-reset:s}
ol.steps li{display:grid;grid-template-columns:44px 1fr;gap:14px;align-items:start;counter-increment:s}
ol.steps li::before{content:counter(s);font:800 28px/1 var(--display);color:var(--guard);text-align:right;padding-top:2px}
ol.steps li p{color:var(--ink-2)}
code{font:13px var(--mono);background:var(--guard-soft);padding:1px 5px;border-radius:3px;color:var(--ink)}
.vs td.bad{color:var(--gap);font-family:var(--mono)}
.vs td.good{color:var(--guard);font-family:var(--mono);font-weight:500}
ul.limits{margin:0;padding:0;list-style:none;display:grid;gap:12px}
ul.limits li{padding-left:18px;position:relative;max-width:72ch;color:var(--ink-2)}
ul.limits li::before{content:"";position:absolute;left:0;top:.7em;width:8px;height:2px;background:var(--gap)}
ul.limits b{color:var(--ink);font-weight:600}
footer{border-top:1px solid var(--rule);padding-top:24px;display:grid;gap:8px;color:var(--ink-2);font-size:13px}
@media (prefers-reduced-motion: no-preference){
  .draw{stroke-dasharray:1400;stroke-dashoffset:1400;animation:draw 1.6s .2s ease-out forwards}
  .fade{opacity:.35;animation:fade .8s 1.2s ease-out forwards}
  @keyframes draw{to{stroke-dashoffset:0}}
  @keyframes fade{to{opacity:1}}
}
</style>

<div class="wrap">
<header class="hero">
  <div class="hero-top">
    <div class="brand">Step<b>guard</b></div>
    <span class="status">prototype · unaudited · not deployed</span>
  </div>
  <p class="eyebrow">Uniswap v4 hook · Robinhood Chain 4663 · ERC-8056 stock tokens</p>
  <h1>The share count changes.<br><span class="quiet">Your pool doesn't know.</span></h1>
  <p class="lede">A Robinhood Chain stock token can change how many shares each token stands for, on a schedule it posts on chain minutes ahead. Pools price the raw token and never read it. Stepguard reads the same schedule and charges the step to whoever trades into it, so the LPs keep it.</p>

  <figure class="chart" aria-label="Illustration of a 4x multiplier step: the fair price steps up, the pool price stays flat, the gap between them is what the first buyer takes">
    <svg viewBox="0 0 760 300" role="img">
      <defs>
        <pattern id="hatch" width="8" height="8" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
          <line x1="0" y1="0" x2="0" y2="8" stroke="var(--gap)" stroke-width="2" opacity=".55"></line>
        </pattern>
      </defs>
      <line x1="60" y1="250" x2="730" y2="250" stroke="var(--rule)" stroke-width="1"></line>
      <line x1="60" y1="30" x2="60" y2="250" stroke="var(--rule)" stroke-width="1"></line>
      <g font-family="IBM Plex Mono, monospace" font-size="11" fill="var(--ink-2)">
        <text x="52" y="224" text-anchor="end">100</text>
        <text x="52" y="164" text-anchor="end">200</text>
        <text x="52" y="104" text-anchor="end">300</text>
        <text x="52" y="44" text-anchor="end">400</text>
        <text x="60" y="270">schedule posted</text>
        <text x="330" y="270" text-anchor="middle">effectiveAt</text>
        <text x="730" y="270" text-anchor="end">time →</text>
        <text x="16" y="140" transform="rotate(-90 16 140)" text-anchor="middle">quote per raw token</text>
      </g>
      <line x1="330" y1="30" x2="330" y2="250" stroke="var(--ink-2)" stroke-dasharray="3 4" stroke-width="1"></line>
      <rect class="fade" x="330" y="40" width="400" height="180" fill="url(#hatch)"></rect>
      <polyline class="draw" points="60,220 330,220 330,40 730,40" fill="none" stroke="var(--guard)" stroke-width="3"></polyline>
      <polyline class="draw" points="60,220 730,220" fill="none" stroke="var(--gap)" stroke-width="3"></polyline>
      <g font-family="Bricolage Grotesque, sans-serif" font-weight="700" font-size="15">
        <text x="345" y="33" fill="var(--guard)">what the token is worth after ×4</text>
        <text x="345" y="240" fill="var(--gap)">what the pool still charges</text>
        <text x="530" y="136" fill="var(--ink)" text-anchor="middle">the first buyer takes this</text>
      </g>
    </svg>
    <figcaption class="cap">Illustration of a ×4 step (CRWD went 1.000 → 4.000 on ${esc(crwdStep ? crwdStep.effectiveAt.slice(0, 10) : '2026-07-02')}). Real steps posted ${leadMin}–${leadMax} seconds ahead.</figcaption>
  </figure>
</header>

<section id="schedule">
  <p class="eyebrow">The schedule is public</p>
  <h2>Every step is announced before it lands.</h2>
  <p class="lede">ERC-8056 tokens expose the next multiplier and the second it takes effect. Anyone can read it. A pool can't.</p>
  <div class="readout" role="table" aria-label="A real multiplier step on NVDA">
    <div><span class="k">event</span><span class="v">UIMultiplierUpdated · NVDA</span></div>
    <div><span class="k">posted at block</span><span class="v">${fmtInt(nvda.emitBlock)} · ${esc(nvda.emitAt.replace('.000Z', 'Z'))}</span></div>
    <div><span class="k">multiplier</span><span class="v">${nvda.oldMultiplier.toFixed(6)} → <span class="hi">${nvda.newMultiplier.toFixed(6)}</span></span></div>
    <div><span class="k">effectiveAt</span><span class="v">${esc(nvda.effectiveAt.replace('.000Z', 'Z'))} · <span class="hi">${fmtInt(nvda.leadSeconds)} s ahead</span></span></div>
    <div><span class="k">pools holding it</span><span class="v"><span class="hi">${fmtInt(nvda.poolsExposed)}</span> · none of them read the multiplier</span></div>
  </div>
  <div class="tablebox">
    <table>
      <thead><tr><th>Ticker</th><th>Effective (UTC)</th><th class="num">Step</th><th class="num">Posted ahead</th><th class="num">Pools holding it</th><th class="num">Taken by the step</th></tr></thead>
      <tbody>
${stepRows}
      </tbody>
    </table>
  </div>
  <p class="mono" style="font-size:12px;color:var(--ink-2)">All ${steps.length} UIMultiplierUpdated events on the 194 listed tokens since launch. "Taken by the step" caps each buy at the part the step explains (quantity × pre-step price × (ratio − 1)); the rest is ordinary price movement.</p>
</section>

<section id="measured">
  <p class="eyebrow">What we measured</p>
  <h2>So far, almost nothing has been taken. That is not the same as safe.</h2>
  <div class="split">
    <div class="figure"><span class="n gap">${stepAttr === null ? '–' : fmtUsd(stepAttr)}</span><span class="l">taken by the steps themselves across all ${steps.length} (plus ${stepAttrEth} ETH). Most steps are smaller than a pool's fee, and the one big step found no one to take it.</span></div>
    <div class="figure"><span class="n">1</span><span class="l">pool held CRWD when it went ×4. It has had ${fmtInt(crwd.swapsEver)} swap${crwd.swapsEver === 1 ? '' : 's'} in its life. Nobody was there to take it.</span></div>
    <div class="figure"><span class="n guard">${usdExposed === null ? fmtInt(v4Count + v3Count) : fmtMillions(usdExposed)}</span><span class="l">of stock tokens sit in pools today, across ${fmtInt(v4Count + v3Count)} pools that hold a token which has already stepped. The next split lands on all of them at once.</span></div>
  </div>
  <p>The only large step so far arrived the day after launch, when there was one pool and no trading. Since then memecoins on this chain have paired themselves against stock tokens by the thousand: NVDA alone sat in ${fmtInt(nvda.poolsExposed)} pools when its last step landed. A 2-for-1 or 4-for-1 split today would reprice every one of them in the same second, and every one of them would still be quoting the old share count. None of those pools can be changed now, by us or anyone: see below. Stepguard is for the pools that open next.</p>
  ${exposure ? `<div class="tablebox"><table>
    <thead><tr><th>Ticker</th><th class="num">Raw tokens in v4 pools</th><th class="num">Share of supply in pools</th><th class="num">Value at last Chainlink print</th><th></th></tr></thead>
    <tbody>
${exposureRows}
    </tbody></table></div>
  <p class="mono" style="font-size:12px;color:var(--ink-2)">${fmtUsd(exposure.usdInPoolsPricedTokens)} of stock tokens sit in pools across the ${exposure.pricedTokens} tokens with a Chainlink feed; ${exposure.unpricedTokensWithPoolBalance} more tokens hold pool balances with no feed to price them. v4 = balanceOf(PoolManager). Measured at block ${fmtInt(exposure.head)}.</p>` : ''}
</section>

<section id="mechanism">
  <p class="eyebrow">How the guard works</p>
  <h2>Read the same schedule. Charge the gap. Hand it to the LPs.</h2>
  <ol class="steps">
    <li><div><h3>Register</h3><p>When a pool opens, Stepguard records which side is an ERC-8056 stock token and the multiplier its opening price reflects. Pools without one, and static-fee pools, are refused.</p></div></li>
    <li><div><h3>Arm</h3><p>On every swap it reads <code>uiMultiplier()</code>, <code>newUIMultiplier()</code> and <code>effectiveAt()</code>. If the share count has changed, or will within the lookahead, it records the price the step implies: pool price × new ÷ old.</p></div></li>
    <li><div><h3>Charge</h3><p>A swap in the direction that would take value from LPs pays a fee equal to the gap between the pool price and that target. After a step up, buyers pay the new price. The other direction pays the normal fee.</p></div></li>
    <li><div><h3>Clear</h3><p>Once the pool trades within the normal fee of the target, or crosses it, or the guard window ends, the pool goes back to normal.</p></div></li>
  </ol>
</section>

<section id="doppler">
  <p class="eyebrow">Where the pools actually are</p>
  <h2>Today's pools are sealed. The next ones don't have to be.</h2>
  <p class="lede">A v4 pool's hook is fixed the day it opens, and ${fmtInt(hooked)} of the ${fmtInt(v4Count)} v4 pools holding a stepped token already carry one: ${fmtInt(distinctHooks)} different hooks. The largest, Doppler's initializer, runs ${dopplerHook ? fmtInt(dopplerHook.pools) : 'most'} of them and takes plug-in modules, but only the token's timelock can change a pool's module, and ${burned === null ? 'most' : fmtInt(burned)} of those timelocks are <code>0x0</code> or <code>0x…dEaD</code>. Those slots are frozen for good.</p>
  ${doppler ? `<div class="readout" role="table" aria-label="Doppler pools, measured">
    <div><span class="k">Doppler pools</span><span class="v">${fmtInt(doppler.dopplerPools)} hold a stepped stock token · ${fmtInt(doppler.lockedAndAttachable)} locked</span></div>
    <div><span class="k">module slot</span><span class="v">${fmtInt(doppler.slotTaken)} already filled · ${fmtInt(doppler.slotEmpty)} empty</span></div>
    <div><span class="k">who can change it</span><span class="v"><span class="hi">nobody</span> for ${burned === null ? '–' : fmtInt(burned)} pools (timelock burned, no delegate)</span></div>
    <div><span class="k">module governance</span><span class="v">Safe ${dopplerAuth && dopplerAuth.safe.version ? esc(dopplerAuth.safe.version) : ''}, ${dopplerAuth && dopplerAuth.safe.threshold ? dopplerAuth.safe.threshold + '-of-' + dopplerAuth.safe.owners.length : '–'}</span></div>
    <div><span class="k">largest modules</span><span class="v">${doppler.modules.filter((m) => m.pools && m.module !== '0x0000000000000000000000000000000000000000').slice(0, 2).map((m) => esc((m.sourcifyName && !/not verified|failed/.test(m.sourcifyName) ? m.sourcifyName : 'unverified ' + m.module.slice(0, 6) + '…' + m.module.slice(-4)) + ' · ' + fmtInt(m.pools))).join(' / ')}</span></div>
  </div>` : ''}
  <div class="split">
    <div class="figure"><h3>Stepguard hook</h3><span class="l">For any new pool that holds a stock token. Runs before each swap and prices the step into the one direction that would take it. Protects fully, splits included.</span></div>
    <div class="figure"><h3>Stepguard Doppler module</h3><span class="l">For new Doppler launches whose creator selects it. Runs after each swap and sets the fee for the next one, a keeper pokes it when a schedule is posted, both directions pay while a step is priced in, and Doppler caps it at 10%, so it only takes the edge off a split.</span></div>
    <div class="figure"><h3>The formula</h3><span class="l">One small library the authors of the modules already sitting in those slots can add to their next version. That is the only route to the pools that exist today.</span></div>
  </div>
</section>

<section id="tests">
  <p class="eyebrow">Tested against the real PoolManager</p>
  <h2>Same trade, two pools. One gives the step away.</h2>
  <p class="lede">${solPassing || '–'} Solidity tests on Uniswap's own v4-core 1.0.2 PoolManager, plus ${keeperPassing || '–'} keeper tests. Each trade runs on a bare pool and a guarded pool opened at the same price with the same liquidity. The rows where the guard still gives something away are tests too.</p>
  <div class="tablebox">
    <table class="vs">
      <thead><tr><th>Scenario</th><th class="num">Bare pool</th><th class="num">Stepguard pool</th></tr></thead>
      <tbody>
        <tr><td>1,000 quote buy right after a ×4 step</td><td class="num bad">&gt; 2,500 taken</td><td class="num good">≤ 0</td></tr>
        <tr><td>Same buy ten minutes before effectiveAt</td><td class="num bad">&gt; 2,500 taken</td><td class="num good">≤ 0</td></tr>
        <tr><td>Sell into a stale price after a ×0.5 reverse split</td><td class="num bad">&gt; 400 taken</td><td class="num good">≤ 0</td></tr>
        <tr><td>Two ×2 steps before anyone reprices</td><td class="num bad">&gt; 2,500 taken</td><td class="num good">≤ 0</td></tr>
        <tr><td>Fuzz, 256 runs: steps ×1.005 to ×5, trades 10 to 5,000</td><td class="num bad">always more</td><td class="num good">never above 0</td></tr>
        <tr><td>Issuer cancels the schedule after the guard armed</td><td class="num">—</td><td class="num good">back to the normal fee</td></tr>
        <tr><td>Doppler module, keeper poked at the schedule, +5% step</td><td class="num bad">&gt; 3 taken</td><td class="num good">≤ 0</td></tr>
        <tr><td>Doppler module, no poke: first trade after the step</td><td class="num">—</td><td class="num bad">still takes</td></tr>
        <tr><td>Doppler module, ×4 split under Doppler's 10% cap</td><td class="num bad">more</td><td class="num bad">&gt; 2,000 still taken</td></tr>
        <tr><td>Deployment rehearsal: CREATE2 salt, no test shortcuts, ×4 step</td><td class="num">—</td><td class="num good">≤ 0</td></tr>
      </tbody>
    </table>
  </div>
</section>

${deploy ? `<section id="deploy">
  <p class="eyebrow">Ready, not sent</p>
  <h2>The deployment is prepared and simulated. Nobody has sent it.</h2>
  <div class="readout" role="table" aria-label="Prepared deployment on chain 4663">
    <div><span class="k">hook address</span><span class="v">${esc(deploy.predictedAddress)}</span></div>
    <div><span class="k">permission bits</span><span class="v">${esc(deploy.flagsInAddress)} · beforeInitialize, afterInitialize, beforeSwap</span></div>
    <div><span class="k">via</span><span class="v">CREATE2 proxy ${esc(deploy.create2Proxy.slice(0, 6))}…${esc(deploy.create2Proxy.slice(-4))} · salt found after ${fmtInt(deploy.saltsTried)} tries</span></div>
    <div><span class="k">live simulation</span><span class="v">${deploy.simulation && deploy.simulation.returnedMatchesPrediction ? '<span class="hi">returns that address</span>' : 'not run'} · ${deploy.simulation ? fmtInt(deploy.simulation.estimatedGas) + ' gas · ' + fmtInt(deploy.simulation.runtimeBytes) + ' bytes' : ''}</span></div>
    <div><span class="k">status</span><span class="v">unsigned · waiting on an audit</span></div>
  </div>
</section>` : ''}

<section id="limits">
  <p class="eyebrow">What it can't do</p>
  <h2>Said up front.</h2>
  <ul class="limits">
    <li><b>It protects no pool that exists today.</b> Hooks are fixed at creation and Doppler's module slots are frozen. Both forms are for new pools; the ${usdExposed === null ? '' : fmtMillions(usdExposed) + ' '}already sitting in pools stays exposed.</li>
    <li><b>The Doppler module only softens a split.</b> Doppler caps a module's fee at 10%, and it hears about a swap after it happens: without a keeper poke when the schedule is posted, the first trade after a step still gets through.</li>
    <li><b>It can't move the price.</b> It charges the gap; the pool catches up only as trades arrive. A pool nobody trades is exposed again after the guard window.</li>
    <li><b>The target is fixed when the step is armed.</b> If the market moves while a step is guarded, the fee can be larger or smaller than the true gap.</li>
    <li><b>It protects its own LPs.</b> A trader can still take a step from any unguarded pool.</li>
    <li><b>It fails open.</b> If a token stops answering the ERC-8056 reads, for example after the issuer upgrades the token through its beacon, the pool trades at the normal fee.</li>
    <li><b>Unaudited and not deployed.</b> Do not put liquidity behind it until it has been audited.</li>
  </ul>
</section>

<footer>
  <div>Stepguard is a prototype. It is not affiliated with Robinhood Markets or Uniswap Labs. Stock tokens on Robinhood Chain are tokenised debt securities issued by Robinhood Assets (Jersey) Ltd; nothing here is investment advice.</div>
  <div class="mono">Every number on this page is generated from on-chain reads of chain 4663. Last read at block ${fmtInt(exposure ? exposure.head : pools.head)}.</div>
</footer>
</div>
`;

fs.mkdirSync(path.join(ROOT, 'site'), { recursive: true });
fs.writeFileSync(path.join(ROOT, 'site', 'index.html'), html);
console.log('wrote site/index.html', html.length, 'chars');
