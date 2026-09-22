//   node --test keeper/odds-logic.test.cjs
const test = require('node:test');
const assert = require('node:assert');
const { planActions, planOpens, decodeMarketOpened, decodeTokenLaunched, VOID_AFTER } = require('./odds-logic.cjs');

const T = 1_800_000_000;
const mk = (id, token, deadline, outcome = 0) => ({ id, token, window: 0, closesAt: deadline - 300, deadline, outcome });

test('a launch that left its curve before the deadline is witnessed YES', () => {
  const a = planActions([mk(1, '0xAAA', T + 100)], { '0xaaa': 1 }, T);
  assert.deepEqual(a.map((x) => [x.id, x.fn]), [[1, 'witnessYes']]);
});

test('a launch still on its curve after the deadline is witnessed NO', () => {
  const a = planActions([mk(2, '0xBBB', T - 1)], { '0xbbb': 0 }, T);
  assert.deepEqual(a.map((x) => [x.id, x.fn]), [[2, 'witnessNo']]);
});

test('nothing is done while the deadline has not passed and the launch is still on its curve', () => {
  assert.deepEqual(planActions([mk(3, '0xCCC', T + 100)], { '0xccc': 0 }, T), []);
});

test('a graduation after the deadline is not YES and is not NO; a day later it is voided', () => {
  const m = mk(4, '0xDDD', T - 10);
  assert.deepEqual(planActions([m], { '0xddd': 2 }, T), []);
  assert.deepEqual(planActions([m], { '0xddd': 2 }, T + VOID_AFTER + 1).map((x) => x.fn), ['voidUnobserved']);
});

test('resolved markets and unread tokens are skipped', () => {
  assert.deepEqual(planActions([mk(5, '0xEEE', T - 1, 2), mk(6, '0xFFF', T - 1)], { '0xeee': 0 }, T), []);
});

test('MarketOpened decodes to what the planner reads', () => {
  const log = {
    topics: ['0x13d3', '0x' + '7'.padStart(64, '0'), '0x' + 'abc'.padStart(64, '0')],
    data: '0x' + '1'.padStart(64, '0') + (T + 1800).toString(16).padStart(64, '0') + (T + 3600).toString(16).padStart(64, '0'),
    blockNumber: '0x10',
  };
  const m = decodeMarketOpened(log);
  assert.equal(m.id, 7);
  assert.equal(m.token, '0x0000000000000000000000000000000000000abc');
  assert.equal(m.window, 1);
  assert.equal(m.closesAt, T + 1800);
  assert.equal(m.deadline, T + 3600);
});

test('TokenLaunched decodes token, curve, pair token and threshold', () => {
  const log = {
    topics: ['0x8d4a', '0x' + 'a1'.padStart(64, '0'), '0x' + 'c2'.padStart(64, '0'), '0x' + 'd3'.padStart(64, '0')],
    data: '0x' + ''.padStart(64, '0') + ''.padStart(64, '0') + (4_200_000_000_000_000_000n).toString(16).padStart(64, '0'),
    blockNumber: '0x20',
  };
  const l = decodeTokenLaunched(log);
  assert.equal(l.token, '0x00000000000000000000000000000000000000a1');
  assert.equal(l.curve, '0x00000000000000000000000000000000000000c2');
  assert.equal(l.pairToken, '0x0000000000000000000000000000000000000000');
  assert.equal(l.threshold, 4_200_000_000_000_000_000n);
  assert.equal(l.block, 32);
});

const cand = (token, ageSeconds, fill, extra = {}) => Object.assign({ token, launchedAt: T - ageSeconds, phase: 0, fill, hasOpen: false }, extra);

test('auto-open picks lively, young launches still on their curve, liveliest first, and caps the count', () => {
  const opens = planOpens([
    cand('0x1', 120, 0.45),
    cand('0x2', 120, 0.05), // too quiet
    cand('0x3', 1200, 0.9), // too old for a 10-minute window to mean much
    cand('0x4', 10, 0.5), // too young: a launch-block buy, not a market yet
    cand('0x5', 200, 0.8, { phase: 2 }), // already graduated
    cand('0x6', 200, 0.6, { hasOpen: true }), // already has a market
    cand('0x7', 300, 1.0), // full: the answer is seconds away
    cand('0x8', 240, 0.3),
    cand('0x9', 240, 0.7),
  ], T, { maxPerPass: 2 });
  assert.deepEqual(opens.map((o) => o.token), ['0x9', '0x1']);
  assert.equal(opens[0].window, 0);
});

test('auto-open thresholds are configurable', () => {
  const c = [cand('0x1', 120, 0.1)];
  assert.equal(planOpens(c, T).length, 0);
  assert.equal(planOpens(c, T, { minFill: 0.05, window: 1 }).length, 1);
  assert.equal(planOpens(c, T, { minFill: 0.05, window: 1 })[0].window, 1);
});
