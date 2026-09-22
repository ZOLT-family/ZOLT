// node --test keeper/logic.test.cjs   (viem is loaded from contracts/node_modules)
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const viemRequire = require('module').createRequire(require('path').join(__dirname, '..', 'contracts', 'package.json'));
const { encodeAbiParameters } = viemRequire('viem');
const { T_REGISTERED, decodeStep, indexRegistrations, planPokes } = require('./logic.cjs');

// A real log: NVDA's step, read from chain 4663 into evidence/mult_logs.json
const logs = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'evidence', 'mult_logs.json'), 'utf8')).result;
const nvdaLog = logs.find((l) => l.address.toLowerCase() === '0xd0601ce157db5bdc3162bbac2a2c8af5320d9eec');
const NVDA = '0xd0601ce157db5bdc3162bbac2a2c8af5320d9eec';
const pad = (a) => '0x' + a.replace(/^0x/, '').toLowerCase().padStart(64, '0');

function registered(asset, c0, c1, stock0, stock1) {
  return {
    topics: [T_REGISTERED, pad(asset), pad(c0), pad(c1)],
    data: encodeAbiParameters([{ type: 'bool' }, { type: 'bool' }, { type: 'uint24' }], [stock0, stock1, 3000]),
  };
}

test('decodes the real NVDA step from chain 4663', () => {
  const s = decodeStep(nvdaLog);
  assert.equal(s.token, NVDA);
  assert.equal(s.oldMultiplier, 10n ** 18n);
  assert.equal(s.newMultiplier, 1000775159164630595n);
  assert.equal(new Date(s.effectiveAt * 1000).toISOString(), '2026-09-10T00:00:30.000Z');
  assert.equal(s.block, 58952659);
});

test('indexes registrations by the stock side only', () => {
  const meme = '0x1111111111111111111111111111111111111111';
  const reg = indexRegistrations([registered('0xaaaa000000000000000000000000000000000001', meme, NVDA, false, true)]);
  assert.deepEqual([...reg.get(NVDA)], ['0xaaaa000000000000000000000000000000000001']);
  assert.equal(reg.has(meme), false);
});

test('pokes inside the lookahead, not before it, not after the guard window', () => {
  const s = decodeStep(nvdaLog);
  const asset = '0xaaaa000000000000000000000000000000000001';
  const reg = indexRegistrations([registered(asset, '0x1111111111111111111111111111111111111111', NVDA, false, true)]);
  const cfg = { lookahead: 7200, guardWindow: 86400 };
  assert.equal(planPokes([s], reg, s.effectiveAt - 7201, cfg).length, 0, 'too early');
  const before = planPokes([s], reg, s.effectiveAt - 588, cfg);
  assert.equal(before.length, 1);
  assert.match(before[0].reason, /scheduled, effective in 588s/);
  assert.equal(planPokes([s], reg, s.effectiveAt + 60, cfg).length, 1, 'still inside the guard window');
  assert.equal(planPokes([s], reg, s.effectiveAt + 86401, cfg).length, 0, 'window over');
});

test('an asset registered on two stepping tokens is poked once', () => {
  const s1 = decodeStep(nvdaLog);
  const other = logs.find((l) => l.address.toLowerCase() !== NVDA && l.address.toLowerCase() !== '0xc93a8c44'.padEnd(42, '0'));
  const s2 = { ...decodeStep(other), effectiveAt: s1.effectiveAt };
  const asset = '0xaaaa000000000000000000000000000000000002';
  const reg = indexRegistrations([registered(asset, s2.token, NVDA, true, true)]);
  const plan = planPokes([s1, s2], reg, s1.effectiveAt - 10, { lookahead: 7200, guardWindow: 86400 });
  assert.equal(plan.length, 1);
});

test('steps on tokens nobody registered produce nothing', () => {
  const s = decodeStep(nvdaLog);
  assert.deepEqual(planPokes([s], new Map(), s.effectiveAt - 10, { lookahead: 7200, guardWindow: 86400 }), []);
});
