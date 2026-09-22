// The part of the odds keeper that decides, kept free of I/O so it can be tested on its own.
//
// A market is resolved by whoever gets there first; the keeper's job is to be that someone every time:
//   - YES the moment a launch leaves its curve, as long as the deadline has not passed
//   - NO the moment the deadline passes with the launch still on its curve
//   - void a market nobody could witness (graduated after the deadline, before anyone recorded NO), a day later
'use strict';

const VOID_AFTER = 86_400;
const WINDOWS = [600, 3600, 21_600];

/// Given the open markets and each token's current phase, return the calls to make now.
function planActions(markets, phaseOf, now) {
  const actions = [];
  for (const m of markets) {
    if (m.outcome !== 0) continue;
    const phase = phaseOf[m.token.toLowerCase()];
    if (phase === undefined) continue; // not read this pass; try again next time
    if (phase !== 0 && now <= m.deadline) actions.push({ id: m.id, fn: 'witnessYes', why: `phase ${phase} with ${m.deadline - now}s left` });
    else if (phase === 0 && now > m.deadline) actions.push({ id: m.id, fn: 'witnessNo', why: `still on curve ${now - m.deadline}s past the deadline` });
    else if (phase !== 0 && now > m.deadline + VOID_AFTER) actions.push({ id: m.id, fn: 'voidUnobserved', why: 'graduated after the deadline and nobody recorded NO in time' });
  }
  return actions;
}

/// Decode a MarketOpened log into the shape planActions reads.
function decodeMarketOpened(log) {
  const w = log.data.slice(2);
  return {
    id: Number(BigInt(log.topics[1])),
    token: '0x' + log.topics[2].slice(26),
    window: Number(BigInt('0x' + w.slice(0, 64))),
    closesAt: Number(BigInt('0x' + w.slice(64, 128))),
    deadline: Number(BigInt('0x' + w.slice(128, 192))),
    outcome: 0,
    block: parseInt(log.blockNumber, 16),
  };
}

module.exports = { VOID_AFTER, WINDOWS, planActions, decodeMarketOpened };
