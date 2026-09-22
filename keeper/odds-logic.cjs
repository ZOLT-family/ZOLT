// The part of the odds keeper that decides, kept free of I/O so it can be tested on its own.
//
// A market is resolved by whoever gets there first; the keeper's job is to be that someone every time:
//   - YES the moment a launch leaves its curve, as long as the deadline has not passed
//   - NO the moment the deadline passes with the launch still on its curve
//   - void a market nobody could witness (graduated after the deadline, before anyone recorded NO), a day later
//
// Optionally it also opens markets, so the board is never empty: only on launches that are still on their curve,
// young enough for the window to mean something, and already showing life on the curve (the calibration in
// evidence/pons-calibration.json is why: at two minutes the curve has usually decided).
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

/// Which launches deserve a market right now. `candidates` carry token, launchedAt, phase, fill (0..1) and
/// whether a market is already open for the window. Returns the opens to make, liveliest first, and never more
/// than would bring the number of open markets to `cfg.maxOpen`: the keeper keeps a few markets alive, it does not
/// open one for every launch (new launches arrive every few seconds and each open costs gas).
function planOpens(candidates, now, cfg, openCount = 0) {
  // maxFill: a curve already past 85% usually crosses within seconds, before anyone could stake; opening a market
  // there only spends the keeper's gas on a void
  const c = Object.assign({ window: 0, minFill: 0.2, maxFill: 0.85, maxAgeSeconds: 900, minAgeSeconds: 30, maxPerPass: 1, maxOpen: 3 }, cfg || {});
  const room = Math.max(0, c.maxOpen - openCount);
  return candidates
    .filter((x) => x.phase === 0 && !x.hasOpen)
    .filter((x) => now - x.launchedAt >= c.minAgeSeconds && now - x.launchedAt <= c.maxAgeSeconds)
    .filter((x) => x.fill >= c.minFill && x.fill <= c.maxFill)
    .sort((a, b) => b.fill - a.fill)
    .slice(0, Math.min(c.maxPerPass, room))
    .map((x) => ({ token: x.token, window: c.window, why: `${(x.fill * 100).toFixed(0)}% full ${now - x.launchedAt}s after launch` }));
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

/// Decode a Pons TokenLaunched log.
function decodeTokenLaunched(log) {
  const w = log.data.slice(2);
  return {
    token: '0x' + log.topics[1].slice(26),
    curve: '0x' + log.topics[2].slice(26),
    pairToken: '0x' + w.slice(24, 64),
    threshold: BigInt('0x' + w.slice(128, 192)),
    block: parseInt(log.blockNumber, 16),
  };
}

module.exports = { VOID_AFTER, WINDOWS, planActions, planOpens, decodeMarketOpened, decodeTokenLaunched };
