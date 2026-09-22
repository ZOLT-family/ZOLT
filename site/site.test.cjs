// The page is allowed to say only what a file in evidence/ backs, and only in words the measurements support.
//   node --test site/site.test.cjs
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const read = (f) => JSON.parse(fs.readFileSync(path.join(ROOT, 'evidence', f), 'utf8'));
const page = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');
const standalone = fs.readFileSync(path.join(__dirname, 'zolt.html'), 'utf8');
const steps = read('steps.json').steps;
const exposure = read('exposure.json');
const attributed = read('steps-attributed.json');
const int = (n) => Math.round(Number(n)).toLocaleString('en-US');

test('every placeholder was filled', () => {
  const left = page.match(/\{\{\w+\}\}/g);
  assert.equal(left, null, 'unresolved placeholders: ' + (left || []).join(', '));
});

test('the page is as current as the evidence', () => {
  assert.ok(page.includes(int(exposure.head)), 'page does not carry the block the census was read at');
  assert.equal((page.match(/<tr class="big"|<tr>/g) || []).length >= steps.length, true);
});

test('the ledger prints one row per measured step', () => {
  const rows = page.match(/<td class="ix">\d\d<\/td>/g) || [];
  assert.equal(rows.length, steps.length, 'ledger rows do not match evidence/steps.json');
  for (const s of steps) assert.ok(page.includes('>' + s.sym + '</td>'), 'missing ticker ' + s.sym);
});

test('the headline figures come from the files', () => {
  assert.ok(page.includes('>' + steps.length + '<'), 'step count missing');
  const usd = '$' + (exposure.usdInPoolsPricedTokens / 1e6).toFixed(1) + 'M';
  assert.ok(page.includes(usd), 'exposure figure ' + usd + ' missing');
  const taken = '$' + Math.round(attributed.totals.stepAttributableAllSteps).toLocaleString('en-US');
  assert.ok(page.includes(taken), 'attributable figure ' + taken + ' missing');
});

// The measurements never showed a pool being emptied, so the page never says one was. "Taken", "exposed"
// and "gives away" are what the numbers support; the louder words are not.
test('no claim the measurements do not support', () => {
  for (const word of ['drained', 'robbed', 'stolen', 'exploited', 'guaranteed', 'risk-free', 'audited']) {
    assert.equal(new RegExp('\\b' + word + '\\b', 'i').test(page), false, 'page says "' + word + '"');
  }
});

test('the page says what it is not', () => {
  assert.ok(/unaudited/i.test(page), 'the unaudited state is not on the page');
  assert.ok(/not sent|not deployed/i.test(page), 'the undeployed state is not on the page');
  assert.ok(/not.{0,12}investment advice/i.test(page), 'the advice disclaimer is missing');
});

test('the standalone copy carries a head a browser and a link preview can use', () => {
  for (const tag of ['<meta charset="utf-8">', 'name="viewport"', 'name="description"', 'rel="canonical"',
    'rel="icon"', 'property="og:title"', 'name="twitter:card"']) {
    assert.ok(standalone.includes(tag), 'standalone head is missing ' + tag);
  }
  assert.ok(standalone.startsWith('<!doctype html>'), 'standalone copy has no doctype');
});

test('the splash can never trap a reader', () => {
  assert.ok(/sessionStorage\.setItem\('zolt\.splash'/.test(page), 'splash does not remember it has played');
  assert.ok(/setTimeout\(close, 1500\)/.test(page), 'splash has no timeout');
  assert.ok(/if \(seen \|\| reduce\)/.test(page), 'splash ignores prefers-reduced-motion');
});
