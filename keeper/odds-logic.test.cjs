//   node --test keeper/odds-logic.test.cjs
const test = require('node:test');
const assert = require('node:assert');
const { planActions, decodeMarketOpened, VOID_AFTER } = require('./odds-logic.cjs');

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
