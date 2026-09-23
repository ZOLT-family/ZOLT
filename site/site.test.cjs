// The page is allowed to say only what a file backs, in words the measurements support, and it may never sign.
//   node --test site/site.test.cjs
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const page = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');
const standalone = fs.readFileSync(path.join(__dirname, 'zolt.html'), 'utf8');
const pons = JSON.parse(fs.readFileSync(path.join(ROOT, 'evidence', 'pons-24h.json'), 'utf8'));
const int = (n) => Math.round(Number(n)).toLocaleString('en-US');
const data = JSON.parse(page.match(/<script id="data" type="application\/json">(.*?)<\/script>/s)[1]);

test('every placeholder was filled', () => {
  const left = page.match(/\{\{\w+\}\}/g);
  assert.equal(left, null, 'unresolved placeholders: ' + (left || []).join(', '));
});

test('the base rate on the page is the base rate in the file', () => {
  assert.ok(page.includes('>' + int(pons.launches) + '<'), 'launch count missing');
  assert.ok(page.includes(int(pons.graduations) + ' &middot;'), 'graduation count missing');
  assert.ok(page.includes(int(pons.head)), 'the block the day was read to is missing');
  const rate = (100 * pons.graduations / pons.launches).toFixed(1) + '%';
  assert.ok(page.includes(rate), 'graduation rate ' + rate + ' missing');
});

test('the tests it cites are the tests that exist', () => {
  const sol = (fs.readFileSync(path.join(ROOT, 'contracts', 'test', 'ZoltOdds.t.sol'), 'utf8').match(/function test/g) || []).length;
  const v2 = (fs.readFileSync(path.join(ROOT, 'contracts', 'test', 'ZoltOddsV2.t.sol'), 'utf8').match(/function test/g) || []).length;
  const keeper = (fs.readFileSync(path.join(ROOT, 'keeper', 'odds-logic.test.cjs'), 'utf8').match(/^test\(/gm) || []).length;
  assert.ok(page.includes('>' + sol + ' + ' + v2 + ' + ' + keeper + '<'), 'test counts on the page do not match the test files');
});

// The words the evidence does not support.
test('no claim the evidence does not support', () => {
  for (const word of ['audited', 'guaranteed', 'risk-free', 'drained', 'robbed', 'insured', 'licensed']) {
    assert.equal(new RegExp('\\b' + word + '\\b', 'i').test(page), false, 'page says "' + word + '"');
  }
});

test('the page says what it is not', () => {
  assert.ok(/not deployed|deployed/i.test(page), 'the deployment state is not on the page');
  assert.ok(/(not|nothing)[^.]{0,30}investment advice/i.test(page), 'the advice disclaimer is missing');
  assert.ok(/not offered to persons in the United States/i.test(page), 'the jurisdiction line is missing');
});

test('the standalone copy carries a head a browser and a link preview can use', () => {
  for (const tag of ['<meta charset="utf-8">', 'name="viewport"', 'name="description"', 'rel="canonical"', 'rel="icon"', 'property="og:title"', 'name="twitter:card"']) {
    assert.ok(standalone.includes(tag), 'standalone head is missing ' + tag);
  }
  assert.ok(standalone.startsWith('<!doctype html>'), 'standalone copy has no doctype');
});

test('the splash can never trap a reader', () => {
  assert.ok(/sessionStorage\.setItem\('zolt\.splash'/.test(page), 'splash does not remember it has played');
  assert.ok(/setTimeout\(close, 1500\)/.test(page), 'splash has no timeout');
  assert.ok(/if \(seen \|\| reduce\)/.test(page), 'splash ignores prefers-reduced-motion');
});

// The page builds transactions for the reader's wallet. Exactly one place does, and it can only ever address the
// market contract or, for the token approval, the ZOLT token. Nothing on the page can produce a signature or a raw
// transaction on its own.
test('the only transaction the page builds goes to the market contract or the token', () => {
  const sends = page.match(/eth_sendTransaction/g) || [];
  assert.equal(sends.length, 1, 'expected one eth_sendTransaction, found ' + sends.length);
  assert.ok(/eth_sendTransaction', params: \[\{ from: state\.wallet, to: to,/.test(page), 'the transaction is not built by sendTo');
  assert.ok(/if \(to !== ODDS && to !== ZOLT\) return Promise\.reject/.test(page), 'sendTo does not pin its target to the market contract or the token');
  // approve is the only call that goes to the token, and it can only ever approve the market contract
  const approves = page.match(/SEL\.approve \+ pad\(([^)]*)\)/g) || [];
  assert.equal(approves.length, 1, 'expected one approve builder, found ' + approves.length);
  assert.ok(approves[0].includes('pad(ODDS)'), 'approve is not pinned to the market contract as spender');
  for (const m of ['eth_sendRawTransaction', 'eth_signTypedData', 'personal_sign', "'eth_sign'", 'wallet_addEthereumChain', 'eth_signTransaction']) {
    assert.equal(page.includes(m), false, 'the page mentions ' + m);
  }
  assert.ok(page.includes('eth_requestAccounts') && page.includes('wallet_switchEthereumChain'), 'the wallet may only be asked who it is and to switch chain');
});

test('the page and the contract agree on selectors', () => {
  assert.equal(data.chainId, 4663);
  assert.equal(data.factory.toLowerCase(), '0x7ed598bcef8bd9edd8c97a195c6d13f40801ec7e');
  const expect = { openAndStake: '0x34feb02b', claim: '0x379607f5', payout: '0xbe95e01a', witnessYes: '0x9d73a63c', witnessNo: '0xbfc7b653', voidUnobserved: '0x9fcb4976', market: '0x28861d22', launched: '0x3cf28b5a', reserve: '0x4f1f58fd', symbol: '0x95d89b41' };
  for (const [k, v] of Object.entries(expect)) assert.equal(data.sel[k], v, 'selector ' + k);
  const expectV2 = { bond: '0x9940686e', unbond: '0x27de9e32', bonds: '0xfe10d774', feeBpsOf: '0xe868ce52', isKeeper: '0x6ba42aaa', balanceOf: '0x70a08231', allowance: '0xdd62ed3e', approve: '0x095ea7b3' };
  for (const [k, v] of Object.entries(expectV2)) assert.equal(data.sel[k], v, 'selector ' + k);
  assert.equal(data.topics.launched, '0x8d4aad4953d0ca700d468f3753aa14432d1b35b43ec6409f051fb6aa43a89607');
  assert.equal(data.topics.opened, '0x13d3642a6d52374b58ee776c95940fcf6486c6f740891e6d11070c1411e1d3a8');
  assert.equal(data.topics.bountyPaid, '0x07e339a02227d9329089b11d9cdeea1af6caea87244864b70935aca91d7dc7fd');
  if (data.odds) assert.ok(/^0x[0-9a-fA-F]{40}$/.test(data.odds), 'bad market address');
});

// The token section is built either way; it says plainly whether the token and v2 are on mainnet.
test('the token section states whether ZOLT is on mainnet', () => {
  assert.ok(page.includes('id="token"') && page.includes('id="bond-panel"'), 'the token section is missing');
  if (data.v2) {
    assert.ok(/^0x[0-9a-fA-F]{40}$/.test(data.zolt), 'v2 is live but the token address is not on the page');
    assert.ok(data.bonds && /^\d+$/.test(data.bonds.discount) && /^\d+$/.test(data.bonds.keeper), 'v2 is live but the bond thresholds are not on the page');
    assert.ok(page.includes(data.zolt), 'the token address is not shown');
  } else {
    assert.equal(data.zolt, null);
    assert.ok(page.includes('not on mainnet yet'), 'the page does not say the token is not on mainnet');
    assert.ok(page.includes('not launched yet') && page.includes('not deployed yet'), 'the receipts do not say the token and v2 are not deployed');
  }
});

test('the relay forwards bounded read-only calls only', () => {
  const relay = fs.readFileSync(path.join(__dirname, 'public', 'api', 'rpc.js'), 'utf8');
  const allowed = relay.match(/ALLOWED = new Set\(\[([^\]]+)\]\)/);
  assert.ok(allowed, 'the relay has no allowlist');
  for (const m of allowed[1].split(',').map((s) => s.trim().replace(/'/g, ''))) {
    assert.ok(/^eth_(call|blockNumber|chainId|getBalance|getCode|getBlockByNumber|getLogs)$/.test(m), 'relay allows ' + m);
  }
  assert.ok(/MAX_CALLS = \d+/.test(relay), 'the relay does not bound a batch');
  assert.ok(/logsAreBounded/.test(relay) && /typeof f\.address !== 'string'/.test(relay), 'eth_getLogs is not bounded to one address and a range');
  assert.ok(relay.includes("req.method !== 'POST'"), 'the relay answers more than POST');
});

test('the archived split-guard page is still served', () => {
  assert.ok(fs.existsSync(path.join(__dirname, 'public', 'guard.html')), 'guard.html missing from the deploy folder');
  assert.ok(page.includes('href="guard.html"'), 'the page does not link to the archive');
});
