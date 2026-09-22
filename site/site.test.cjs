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
  assert.ok(/(not|nothing)[^.]{0,30}advice/i.test(page), 'the advice disclaimer is missing');
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

// The live panel talks to the chain from the reader's browser. It may only ever read: no path in the page,
// and no method the relay forwards, can produce a transaction or a signature.
test('nothing on the page can sign or send', () => {
  for (const m of ['eth_sendTransaction', 'eth_sendRawTransaction', 'eth_signTypedData', 'personal_sign',
    'eth_sign', 'wallet_addEthereumChain', 'wallet_switchEthereumChain']) {
    assert.equal(page.includes(m), false, 'the page mentions ' + m);
  }
  assert.ok(page.includes("eth_requestAccounts"), 'the wallet button should only ask who the wallet is');
});

test('the relay forwards read-only calls only', () => {
  const relay = fs.readFileSync(path.join(__dirname, 'public', 'api', 'rpc.js'), 'utf8');
  const allowed = relay.match(/ALLOWED = new Set\(\[([^\]]+)\]\)/);
  assert.ok(allowed, 'the relay has no allowlist');
  for (const m of allowed[1].split(',').map((s) => s.trim().replace(/'/g, ''))) {
    assert.ok(/^eth_(call|blockNumber|chainId|getBalance|getCode)$/.test(m), 'relay allows ' + m);
  }
  assert.ok(/MAX_CALLS = \d+/.test(relay), 'the relay does not bound a batch');
  assert.ok(relay.includes("req.method !== 'POST'"), 'the relay answers more than POST');
});

test('the live panel reads every token the builder shipped', () => {
  const data = JSON.parse(page.match(/<script id="data" type="application\/json">(.*?)<\/script>/s)[1]);
  assert.ok(Array.isArray(data.tokens) && data.tokens.length > 100, 'token table missing from the page');
  assert.ok(page.includes(String(data.tokens.length) + ' stock tokens'), 'the copy and the table disagree');
  for (const t of data.tokens) assert.ok(/^0x[0-9a-fA-F]{40}$/.test(t[1]), 'bad token address ' + t[1]);
});
