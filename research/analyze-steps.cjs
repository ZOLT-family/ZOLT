// Separate what a multiplier step handed to traders from ordinary price movement.
//
// measure-steps.cjs counts a buy as "taken" when it paid less than (pre-step pool price x ratio). That also
// counts any buy that simply caught a price dip in the hour after the step. Here each buy's gain is capped
// at the part the step itself explains:  min(actual gain, qty x preStepPrice x (ratio - 1)),
// where actual gain = qty x (preStepPrice x ratio) - quote paid. Kept per quote currency (USDG, ETH).
// Anything above that cap is market movement, not the step.
//
// Also: which hooks the exposed v4 pools carry (who would have to adopt the logic).
const fs = require('fs');
const path = require('path');
const { createRequire } = require('module');
const { rpc } = require('./rpc.cjs');

const req = createRequire(path.join(__dirname, '..', 'contracts', 'package.json'));
const { decodeAbiParameters, keccak256, toHex } = req('viem');

const EVID = path.join(__dirname, '..', 'evidence');
const steps = JSON.parse(fs.readFileSync(path.join(EVID, 'steps.json'), 'utf8')).steps;
const pools = JSON.parse(fs.readFileSync(path.join(EVID, 'pools.json'), 'utf8'));

// Re-read the individual buys for pools that registered any "taken" value, and cap each at the step share.
// measure-steps.cjs kept up to 10 taker tx hashes per pool; re-decode those receipts' Swap logs.
const T_SWAP_V4 = keccak256(toHex('Swap(bytes32,address,int128,int128,uint160,uint128,int24,uint24)'));
const summary = [];
for (const s of steps) {
  const ratio = s.newMultiplier / s.oldMultiplier;
  let stepAttributable = 0; let stepAttributableETH = 0;
  let rawTaken = 0;
  const detail = [];
  for (const p of s.pools || []) {
    if (!p.takenFromLPs && !p.positionedBeforeStep) continue;
    rawTaken += (p.takenFromLPs || 0) + (p.positionedBeforeStep || 0);
    const dec = p.quote === 'USDG' ? 6 : 18;
    const attr = (qtyStock, paidRaw) => {
      const paid = Number(paidRaw) / 10 ** dec;
      const gain = qtyStock * p.preStepPrice * ratio - paid;
      return Math.max(0, Math.min(gain, qtyStock * p.preStepPrice * (ratio - 1)));
    };
    let poolAttr = 0;
    for (const tx of [...(p.takenTxs || []), ...(p.positionedTxs || [])]) {
      const rc = rpc('eth_getTransactionReceipt', [tx]);
      for (const l of rc.logs) {
        const isV4 = l.topics[0] === T_SWAP_V4 && p.venue === 'v4' && l.topics[1] === p.pool;
        const isV3 = p.venue === 'v3' && l.address.toLowerCase() === String(p.pool).toLowerCase() && l.topics.length === 3;
        if (!isV4 && !isV3) continue;
        let a0; let a1;
        if (isV4) {
          [a0, a1] = decodeAbiParameters([{ type: 'int128' }, { type: 'int128' }], l.data.slice(0, 2 + 128));
          const poolRow = pools.v4.find((x) => x.poolId === p.pool);
          const stockToCaller = poolRow.stockSide === 0 ? a0 : a1;
          const quoteToCaller = poolRow.stockSide === 0 ? a1 : a0;
          if (stockToCaller > 0n) poolAttr += attr(Number(stockToCaller) / 1e18, -quoteToCaller);
        } else {
          [a0, a1] = decodeAbiParameters([{ type: 'int256' }, { type: 'int256' }], l.data.slice(0, 2 + 128));
          const poolRow = pools.v3.find((x) => x.pool.toLowerCase() === String(p.pool).toLowerCase());
          const stockToPool = poolRow.stockSide === 0 ? a0 : a1;
          const quoteToPool = poolRow.stockSide === 0 ? a1 : a0;
          if (stockToPool < 0n) poolAttr += attr(Number(-stockToPool) / 1e18, quoteToPool);
        }
      }
    }
    if (p.quote === 'USDG') stepAttributable += poolAttr; else stepAttributableETH += poolAttr;
    detail.push({ pool: p.pool, venue: p.venue, quote: p.quote, rawTakenPlusPositioned: (p.takenFromLPs || 0) + (p.positionedBeforeStep || 0), stepAttributable: +poolAttr.toFixed(6) });
  }
  summary.push({ sym: s.sym, effectiveAt: s.effectiveAt, stepPct: s.stepPct, poolsExposed: s.poolsExposed, poolsPriced: s.poolsPriced,
    rawTaken: +rawTaken.toFixed(4), stepAttributable: +stepAttributable.toFixed(4), stepAttributableETH: +stepAttributableETH.toFixed(8), detail });
}

// hooks carried by v4 pools that hold a stepped token
const byHook = {};
for (const p of pools.v4) byHook[p.hooks.toLowerCase()] = (byHook[p.hooks.toLowerCase()] || 0) + 1;
const hooks = Object.entries(byHook).sort((a, b) => b[1] - a[1]).map(([hook, pools_]) => ({ hook, pools: pools_ }));

const totals = {
  steps: summary.length,
  poolExposuresSummed: summary.reduce((a, s) => a + s.poolsExposed, 0),
  rawTakenAllSteps: +summary.reduce((a, s) => a + s.rawTaken, 0).toFixed(4),
  stepAttributableAllSteps: +summary.reduce((a, s) => a + s.stepAttributable, 0).toFixed(4),
  stepAttributableAllStepsETH: +summary.reduce((a, s) => a + s.stepAttributableETH, 0).toFixed(8),
  v4PoolsHoldingSteppedTokens: pools.v4.length,
  v4PoolsWithAHook: pools.v4.filter((p) => p.hooks !== '0x0000000000000000000000000000000000000000').length,
  distinctHooks: hooks.length,
};
fs.writeFileSync(path.join(EVID, 'steps-attributed.json'), JSON.stringify({ totals, hooks: hooks.slice(0, 40), summary }, null, 1));
console.log(JSON.stringify(totals));
for (const s of summary) console.log(s.sym.padEnd(6), String(s.stepPct).padStart(9) + '%', 'exposed', String(s.poolsExposed).padStart(6), 'raw', String(s.rawTaken).padStart(10), 'step-attributable $' + s.stepAttributable, '+', s.stepAttributableETH, 'ETH');
console.log('top hooks:'); for (const h of hooks.slice(0, 10)) console.log(' ', h.hook, h.pools);
