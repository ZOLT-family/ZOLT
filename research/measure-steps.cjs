// Step 2 of the evidence: what happened inside priced pools when a stock token's multiplier stepped?
//
// For each UIMultiplierUpdated event:
//   - find the block where effectiveAt passed
//   - count every pool that already held the token (exposure)
//   - for pools quoted in USDG or native ETH (a quote with an outside price), read every swap from the
//     emit block to 60 minutes after the step and estimate what buyers took from LPs:
//       fair price after the step  = pool price just before the step x (new multiplier / old multiplier)
//       taken by a buy of q tokens = q x fairAfter - quote paid        (only while the pool is below fair)
//       positioned before the step = q x preStepPrice x (ratio - 1)    (buys between the emit and the step)
//
// Everything here is read-only. Output: evidence/steps.json
const fs = require('fs');
const path = require('path');
const { createRequire } = require('module');
const { rpc, hex, getLogsChunked, blockTs, blockAtOrAfter } = require('./rpc.cjs');

const req = createRequire(path.join(__dirname, '..', 'contracts', 'package.json'));
const { keccak256, toHex, decodeAbiParameters } = req('viem');

const EVID = path.join(__dirname, '..', 'evidence');
const POOL_MANAGER = '0x8366a39cc670b4001a1121b8f6a443a643e40951';
const USDG = '0x5fc5360d0400a0fd4f2af552add042d716f1d168';
const NATIVE = '0x0000000000000000000000000000000000000000';
const QUOTES = { [USDG]: { sym: 'USDG', dec: 6, usd: true }, [NATIVE]: { sym: 'ETH', dec: 18, usd: false } };

const T_SWAP_V4 = keccak256(toHex('Swap(bytes32,address,int128,int128,uint160,uint128,int24,uint24)'));
const T_SWAP_V3 = keccak256(toHex('Swap(address,address,int256,int256,uint160,uint128,int24)'));

const assets = JSON.parse(fs.readFileSync(path.join(EVID, 'assets.json'), 'utf8')).assets;
const symOf = {};
for (const a of assets) symOf[a.deployments[0].contractAddress.toLowerCase()] = a.tokenSymbol;
const pools = JSON.parse(fs.readFileSync(path.join(EVID, 'pools.json'), 'utf8'));
const allPools = [...pools.v4, ...pools.v3].map((p) => ({ ...p, born: p.initBlock || p.createdBlock }));

const multLogs = JSON.parse(fs.readFileSync(path.join(EVID, 'mult_logs.json'), 'utf8')).result
  .filter((l) => symOf[l.address.toLowerCase()])
  .map((l) => {
    const [oldM, newM, eff] = decodeAbiParameters([{ type: 'uint256' }, { type: 'uint256' }, { type: 'uint256' }], l.data);
    return { token: l.address.toLowerCase(), sym: symOf[l.address.toLowerCase()], emitBlock: parseInt(l.blockNumber, 16),
      tx: l.transactionHash, oldM, newM, effTs: Number(eff) };
  })
  .sort((a, b) => a.emitBlock - b.emitBlock);

const head = parseInt(rpc('eth_blockNumber', []), 16);
const Q96 = 2n ** 96n;

// stock price in quote units (human), from sqrtPriceX96
function stockPrice(sqrtPriceX96, stockSide, quoteDec) {
  const s = Number(sqrtPriceX96) / Number(Q96);
  const p1per0 = s * s; // raw token1 per raw token0
  // raw -> human: stock has 18 decimals
  if (stockSide === 0) return p1per0 * 10 ** (18 - quoteDec); // quote(token1) per stock(token0)
  return (1 / p1per0) * 10 ** (18 - quoteDec);                // quote(token0) per stock(token1)
}

function decodeSwap(pool, log) {
  if (pool.venue === 'v4') {
    const [a0, a1, sqrtP] = decodeAbiParameters(
      [{ type: 'int128' }, { type: 'int128' }, { type: 'uint160' }, { type: 'uint128' }, { type: 'int24' }, { type: 'uint24' }], log.data);
    // v4 BalanceDelta is from the caller's side: positive = caller received
    const stockToCaller = pool.stockSide === 0 ? a0 : a1;
    const quoteToCaller = pool.stockSide === 0 ? a1 : a0;
    return { stockOut: stockToCaller, quoteIn: -quoteToCaller, sqrtP };
  }
  const [a0, a1, sqrtP] = decodeAbiParameters(
    [{ type: 'int256' }, { type: 'int256' }, { type: 'uint160' }, { type: 'uint128' }, { type: 'int24' }], log.data);
  // v3 amounts are from the pool's side: positive = pool received
  const stockToPool = pool.stockSide === 0 ? a0 : a1;
  const quoteToPool = pool.stockSide === 0 ? a1 : a0;
  return { stockOut: -stockToPool, quoteIn: quoteToPool, sqrtP };
}

function swapsFor(pool, from, to) {
  if (pool.venue === 'v4') {
    return getLogsChunked({ address: POOL_MANAGER, topics: [T_SWAP_V4, pool.poolId] }, from, to);
  }
  return getLogsChunked({ address: pool.pool, topics: [T_SWAP_V3] }, from, to);
}

const results = [];
for (const s of multLogs) {
  const ratio = Number(s.newM) / Number(s.oldM);
  const effBlock = blockAtOrAfter(s.effTs, s.emitBlock, head);
  const endBlock = blockAtOrAfter(s.effTs + 3600, effBlock || s.emitBlock, head) || head;
  const emitTs = blockTs(s.emitBlock);
  const exposed = allPools.filter((p) => p.stockToken === s.token && p.born < (effBlock || head));
  const priced = exposed.filter((p) => QUOTES[p.other.toLowerCase()]);

  const pooled = [];
  for (const p of priced) {
    const q = QUOTES[p.other.toLowerCase()];
    let logs;
    try { logs = swapsFor(p, Math.max(p.born, s.emitBlock - 20000), endBlock); } catch (e) {
      pooled.push({ pool: p.poolId || p.pool, venue: p.venue, error: e.message.slice(0, 160) });
      continue;
    }
    if (!logs.length) continue;
    const rows = logs.map((l) => ({ block: parseInt(l.blockNumber, 16), tx: l.transactionHash, idx: parseInt(l.logIndex, 16), ...decodeSwap(p, l) }))
      .sort((a, b) => a.block - b.block || a.idx - b.idx);
    const pre = rows.filter((r) => r.block < effBlock);
    const post = rows.filter((r) => r.block >= effBlock);
    if (!pre.length) continue; // no pre-step price to anchor on
    const pPre = stockPrice(pre[pre.length - 1].sqrtP, p.stockSide, q.dec);
    const fairAfter = pPre * ratio;
    const feeFrac = p.venue === 'v3' ? p.fee / 1e6 : Math.min(p.fee, 1_000_000) / 1e6;

    let positioned = 0; const positionedTx = [];
    for (const r of pre.filter((x) => x.block >= s.emitBlock)) {
      if (r.stockOut > 0n) {
        const qty = Number(r.stockOut) / 1e18;
        positioned += qty * pPre * (ratio - 1);
        positionedTx.push(r.tx);
      }
    }
    let taken = 0; const takenTx = []; let firstBuyDelayBlocks = null; let reachedFairBlock = null;
    for (const r of post) {
      const pAfterThis = stockPrice(r.sqrtP, p.stockSide, q.dec);
      if (r.stockOut > 0n) {
        const qty = Number(r.stockOut) / 1e18;
        const paid = Number(r.quoteIn) / 10 ** q.dec;
        const gain = qty * fairAfter - paid;
        if (gain > 0) {
          taken += gain; takenTx.push(r.tx);
          if (firstBuyDelayBlocks === null) firstBuyDelayBlocks = r.block - effBlock;
        }
      }
      if (reachedFairBlock === null && pAfterThis >= fairAfter * (1 - feeFrac)) reachedFairBlock = r.block;
    }
    const pEnd = stockPrice(rows[rows.length - 1].sqrtP, p.stockSide, q.dec);
    pooled.push({
      venue: p.venue, pool: p.poolId || p.pool, quote: q.sym, fee: p.fee, hooks: p.hooks || null,
      swapsInWindow: rows.length, preStepPrice: pPre, fairAfter, priceAt60min: pEnd,
      repricedPct: pPre > 0 ? +(((pEnd / pPre) - 1) * 100).toFixed(4) : null,
      takenFromLPs: +taken.toFixed(6), takenTxs: takenTx.slice(0, 10), takenTxCount: takenTx.length,
      positionedBeforeStep: +positioned.toFixed(6), positionedTxs: positionedTx.slice(0, 10),
      firstProfitableBuyBlocksAfterStep: firstBuyDelayBlocks, reachedFairBlock,
      reachedFairAfterBlocks: reachedFairBlock === null ? null : reachedFairBlock - effBlock,
    });
  }

  const usd = pooled.filter((x) => x.quote === 'USDG');
  const eth = pooled.filter((x) => x.quote === 'ETH');
  const row = {
    sym: s.sym, token: s.token, emitBlock: s.emitBlock, emitTx: s.tx,
    emitAt: new Date(emitTs * 1000).toISOString(), effectiveAt: new Date(s.effTs * 1000).toISOString(),
    leadSeconds: s.effTs - emitTs, effBlock, oldMultiplier: Number(s.oldM) / 1e18, newMultiplier: Number(s.newM) / 1e18,
    stepPct: +((ratio - 1) * 100).toFixed(5),
    poolsExposed: exposed.length, poolsPriced: priced.length, poolsWithSwaps: pooled.filter((x) => !x.error).length,
    takenUSDG: +usd.reduce((a, x) => a + (x.takenFromLPs || 0), 0).toFixed(4),
    positionedUSDG: +usd.reduce((a, x) => a + (x.positionedBeforeStep || 0), 0).toFixed(4),
    takenETH: +eth.reduce((a, x) => a + (x.takenFromLPs || 0), 0).toFixed(8),
    positionedETH: +eth.reduce((a, x) => a + (x.positionedBeforeStep || 0), 0).toFixed(8),
    pools: pooled,
  };
  results.push(row);
  console.log(`${row.sym.padEnd(6)} step ${String(row.stepPct).padStart(9)}%  lead ${String(row.leadSeconds).padStart(6)}s  exposed ${String(row.poolsExposed).padStart(5)}  priced ${String(row.poolsPriced).padStart(4)}  traded ${String(row.poolsWithSwaps).padStart(3)}  taken $${row.takenUSDG} + ${row.takenETH} ETH  positioned $${row.positionedUSDG} + ${row.positionedETH} ETH`);
  fs.writeFileSync(path.join(EVID, 'steps.json'), JSON.stringify({ head, measuredAt: new Date().toISOString(), method: 'see header of research/measure-steps.cjs', steps: results }, null, 1));
}
console.log('wrote evidence/steps.json');
