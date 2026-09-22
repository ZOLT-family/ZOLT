// Pure keeper logic, no network: decode schedule events, index module registrations, decide what to poke.
// The Stepguard hook needs no keeper (it reads the schedule before every swap). The Doppler module does: it
// only runs after a swap, so without a poke the first trade after a step goes through at the old fee.
const viemRequire = require('module').createRequire(require('path').join(__dirname, '..', 'contracts', 'package.json'));
const { keccak256, toHex, decodeAbiParameters } = viemRequire('viem');

const T_STEP = keccak256(toHex('UIMultiplierUpdated(uint256,uint256,uint256)'));
const T_REGISTERED = keccak256(toHex('PoolRegistered(address,address,address,bool,bool,uint24)'));

const topicAddr = (t) => ('0x' + t.slice(26)).toLowerCase();

/** A UIMultiplierUpdated log -> { token, oldMultiplier, newMultiplier, effectiveAt, block, tx } */
function decodeStep(log) {
  if (log.topics[0] !== T_STEP) throw new Error('not a UIMultiplierUpdated log');
  const [oldM, newM, eff] = decodeAbiParameters([{ type: 'uint256' }, { type: 'uint256' }, { type: 'uint256' }], log.data);
  return {
    token: log.address.toLowerCase(), oldMultiplier: oldM, newMultiplier: newM, effectiveAt: Number(eff),
    block: parseInt(log.blockNumber, 16), tx: log.transactionHash,
  };
}

/** Module PoolRegistered logs -> Map(stockToken -> Set(asset)) */
function indexRegistrations(logs) {
  const byToken = new Map();
  for (const l of logs) {
    if (l.topics[0] !== T_REGISTERED) continue;
    const asset = topicAddr(l.topics[1]);
    const c0 = topicAddr(l.topics[2]);
    const c1 = topicAddr(l.topics[3]);
    const [stock0, stock1] = decodeAbiParameters([{ type: 'bool' }, { type: 'bool' }, { type: 'uint24' }], l.data);
    for (const [isStock, token] of [[stock0, c0], [stock1, c1]]) {
      if (!isStock) continue;
      if (!byToken.has(token)) byToken.set(token, new Set());
      byToken.get(token).add(asset);
    }
  }
  return byToken;
}

/**
 * Which assets to poke now. A step is worth poking from the moment it is inside the module's lookahead until
 * the guard window after it has passed; outside that the module would ignore it anyway.
 * Returns [{ asset, token, effectiveAt, reason }] with each asset at most once.
 */
function planPokes(steps, registrations, nowTs, { lookahead, guardWindow }) {
  const out = new Map();
  for (const s of steps) {
    const opens = s.effectiveAt - lookahead;
    const closes = s.effectiveAt + guardWindow;
    if (nowTs < opens || nowTs > closes) continue;
    const assets = registrations.get(s.token);
    if (!assets) continue;
    const reason = nowTs < s.effectiveAt ? `scheduled, effective in ${s.effectiveAt - nowTs}s` : `effective ${nowTs - s.effectiveAt}s ago`;
    for (const asset of assets) if (!out.has(asset)) out.set(asset, { asset, token: s.token, effectiveAt: s.effectiveAt, reason });
  }
  return [...out.values()];
}

module.exports = { T_STEP, T_REGISTERED, decodeStep, indexRegistrations, planPokes };
