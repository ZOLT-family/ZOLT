// How much stock-token value sits in pools that price by raw token count and do not read the multiplier?
//   v4: every v4 pool's tokens are held by the one PoolManager, so balanceOf(PoolManager) is the v4 total.
//   v3: sum balanceOf(pool) over the v3 pools found for the 28 stepped tokens (other tokens' v3 pools not counted).
// Priced with the Chainlink feed where one exists (price = underlying x multiplier, per raw token).
// One Multicall3 call per batch. Output: evidence/exposure.json
const fs = require('fs');
const path = require('path');
const { createRequire } = require('module');
const { rpc } = require('./rpc.cjs');

const req = createRequire(path.join(__dirname, '..', 'contracts', 'package.json'));
const { encodeFunctionData, decodeFunctionResult, parseAbi } = req('viem');

const EVID = path.join(__dirname, '..', 'evidence');
const MULTICALL3 = '0xcA11bde05977b3631167028862bE2a173976CA11';
const POOL_MANAGER = '0x8366a39cc670b4001a1121b8f6a443a643e40951';

const mcAbi = parseAbi(['function aggregate3((address target, bool allowFailure, bytes callData)[] calls) payable returns ((bool success, bytes returnData)[])']);
const erc20 = parseAbi(['function balanceOf(address) view returns (uint256)', 'function totalSupply() view returns (uint256)']);
const feedAbi = parseAbi(['function latestRoundData() view returns (uint80, int256, uint256, uint256, uint80)', 'function decimals() view returns (uint8)']);

function multicall(calls) {
  const out = [];
  for (let i = 0; i < calls.length; i += 400) {
    const chunk = calls.slice(i, i + 400);
    const data = encodeFunctionData({ abi: mcAbi, functionName: 'aggregate3', args: [chunk.map((c) => ({ target: c.to, allowFailure: true, callData: c.data }))] });
    const raw = rpc('eth_call', [{ to: MULTICALL3, data }, 'latest']);
    out.push(...decodeFunctionResult({ abi: mcAbi, functionName: 'aggregate3', data: raw }));
  }
  return out;
}

const assets = JSON.parse(fs.readFileSync(path.join(EVID, 'assets.json'), 'utf8')).assets;
const pools = JSON.parse(fs.readFileSync(path.join(EVID, 'pools.json'), 'utf8'));
const feedsRaw = JSON.parse(require('child_process').execFileSync('curl', ['-s', '--max-time', '60', '--doh-url', 'https://cloudflare-dns.com/dns-query',
  'https://reference-data-directory.vercel.app/feeds-robinhood-mainnet.json'], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }));
const feeds = Array.isArray(feedsRaw) ? feedsRaw : (feedsRaw.feeds || []);
const feedFor = {};
for (const f of feeds) {
  const name = String(f.name || '');
  const m = name.match(/^Robinhood ([A-Z.]+) \/ USD$/);
  if (m && f.proxyAddress) feedFor[m[1]] = f.proxyAddress;
}

const head = parseInt(rpc('eth_blockNumber', []), 16);
const tokens = assets.map((a) => ({ sym: a.tokenSymbol, addr: a.deployments[0].contractAddress, mult: Number(a.currentMultiplier) }));

// v4 totals + supply
const calls = [];
for (const t of tokens) {
  calls.push({ to: t.addr, data: encodeFunctionData({ abi: erc20, functionName: 'balanceOf', args: [POOL_MANAGER] }) });
  calls.push({ to: t.addr, data: encodeFunctionData({ abi: erc20, functionName: 'totalSupply' }) });
}
const res = multicall(calls);

// v3 pool balances for stepped tokens
const v3calls = pools.v3.map((p) => ({ to: p.stockToken, data: encodeFunctionData({ abi: erc20, functionName: 'balanceOf', args: [p.pool] }), sym: p.sym }));
const v3res = multicall(v3calls);
const v3By = {};
v3res.forEach((r, i) => {
  if (!r.success) return;
  const v = decodeFunctionResult({ abi: erc20, functionName: 'balanceOf', data: r.returnData });
  v3By[v3calls[i].sym] = (v3By[v3calls[i].sym] || 0n) + v;
});

// feeds
const feedSyms = tokens.filter((t) => feedFor[t.sym]).map((t) => t.sym);
const fcalls = feedSyms.map((s) => ({ to: feedFor[s], data: encodeFunctionData({ abi: feedAbi, functionName: 'latestRoundData' }) }));
const fres = multicall(fcalls);
const priceOf = {};
fres.forEach((r, i) => {
  if (!r.success) return;
  const [, answer, , updatedAt] = decodeFunctionResult({ abi: feedAbi, functionName: 'latestRoundData', data: r.returnData });
  priceOf[feedSyms[i]] = { usd: Number(answer) / 1e8, updatedAt: new Date(Number(updatedAt) * 1000).toISOString() };
});

const pmCountBySym = {};
for (const p of pools.v4) pmCountBySym[p.sym] = (pmCountBySym[p.sym] || 0) + 1;

const rows = tokens.map((t, i) => {
  const b = res[2 * i];
  const s = res[2 * i + 1];
  const inV4 = b.success ? Number(decodeFunctionResult({ abi: erc20, functionName: 'balanceOf', data: b.returnData })) / 1e18 : null;
  const supply = s.success ? Number(decodeFunctionResult({ abi: erc20, functionName: 'totalSupply', data: s.returnData })) / 1e18 : null;
  const inV3 = v3By[t.sym] !== undefined ? Number(v3By[t.sym]) / 1e18 : null;
  const px = priceOf[t.sym] || null;
  const inPools = (inV4 || 0) + (inV3 || 0);
  return {
    sym: t.sym, token: t.addr, multiplier: t.mult, stepped: t.mult !== 1,
    rawInV4PoolManager: inV4, rawInSteppedV3Pools: inV3, rawSupply: supply,
    shareOfSupplyInPoolsPct: supply ? +(100 * inPools / supply).toFixed(2) : null,
    usdPerRawToken: px ? px.usd : null, priceUpdatedAt: px ? px.updatedAt : null,
    usdInPools: px ? +(inPools * px.usd).toFixed(2) : null,
    v4PoolsFoundForSteppedTokens: pmCountBySym[t.sym] || null,
  };
}).sort((a, b) => (b.usdInPools || 0) - (a.usdInPools || 0));

const priced = rows.filter((r) => r.usdInPools !== null);
const total = priced.reduce((a, r) => a + r.usdInPools, 0);
const unpricedWithBalance = rows.filter((r) => r.usdInPools === null && (r.rawInV4PoolManager || 0) > 0).length;
fs.writeFileSync(path.join(EVID, 'exposure.json'), JSON.stringify({
  head, measuredAt: new Date().toISOString(), poolManager: POOL_MANAGER,
  note: 'v4 = balanceOf(PoolManager) covers every v4 pool; v3 counted only for the 28 stepped tokens; USD only where a Chainlink feed exists',
  usdInPoolsPricedTokens: +total.toFixed(2), pricedTokens: priced.length, unpricedTokensWithPoolBalance: unpricedWithBalance, rows,
}, null, 1));
console.log('head', head, '| USD in pools (tokens with a feed):', total.toFixed(0), '| priced tokens', priced.length, '| unpriced tokens holding pool balance', unpricedWithBalance);
for (const r of rows.slice(0, 15)) {
  console.log(r.sym.padEnd(6), 'v4', (r.rawInV4PoolManager || 0).toFixed(2).padStart(12), 'v3', String(r.rawInSteppedV3Pools === null ? '-' : r.rawInSteppedV3Pools.toFixed(2)).padStart(10), 'supply', (r.rawSupply || 0).toFixed(0).padStart(10), 'inPools', String(r.shareOfSupplyInPoolsPct).padStart(6) + '%', '$' + r.usdInPools);
}
console.log('wrote evidence/exposure.json');
