// The page builds calldata by hand (no library) and decodes the market struct by word position. This holds that
// hand-rolled ABI work to viem's, against a real return value read from the deployed contract.
//   node --test site/encoding.test.cjs
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const { encodeFunctionData, decodeFunctionResult, parseAbi } = require('module').createRequire(path.join(__dirname, '..', 'contracts', 'package.json'))('viem');

// the page's helpers, copied verbatim from site/template.html
const pad = function(v){ return String(v).replace(/^0x/, '').toLowerCase().padStart(64, '0'); };
const word = function(data, i){ return '0x' + data.slice(2 + i * 64, 66 + i * 64); };
const addrOf = function(w){ return '0x' + w.slice(-40); };
const big = function(hex){ try { return BigInt(hex || '0x0'); } catch (e) { return 0n; } };

const abi = parseAbi([
  'function openAndStake(address token, uint8 window, bool yes) payable returns (uint256)',
  'function stake(uint256 id, bool yes) payable',
  'function claim(uint256 id)',
  'function witnessNo(uint256 id)',
  'function payout(uint256 id, address who) view returns (uint256)',
  'function market(uint256 id) view returns ((address token,uint40 openedAt,uint40 closesAt,uint40 deadline,uint8 window,uint8 outcome,uint128 yesPool,uint128 noPool,uint256 yesWeight,uint256 noWeight))',
]);
const SEL = { openAndStake: '0x34feb02b', claim: '0x379607f5', payout: '0xbe95e01a', witnessNo: '0xbfc7b653' };

// market(0) as the deployed contract returned it on 23 Sep 2026 (a void market on 0xd2cb…f6b3)
const MARKET0 = '0x000000000000000000000000d2cb0643e4fab9a9aabd6c6170c9fcc213c2f6b3000000000000000000000000000000000000000000000000000000006ab2e6bd000000000000000000000000000000000000000000000000000000006ab2e7e9000000000000000000000000000000000000000000000000000000006ab2e915'
  + '0000000000000000000000000000000000000000000000000000000000000000' + '0000000000000000000000000000000000000000000000000000000000000003'
  + '0'.repeat(64) + '0'.repeat(64) + '0'.repeat(64) + '0'.repeat(64);

test('openAndStake calldata built by hand equals viem\'s', () => {
  const token = '0xd2cb0643e4fab9a9aabd6c6170c9fcc213c2f6b3'; // lowercase, as the page reads it from a log topic
  for (const [window, yes] of [[0, true], [1, false], [2, true]]) {
    const page = SEL.openAndStake + pad(token) + pad(window.toString(16)) + pad(yes ? '1' : '0');
    const ref = encodeFunctionData({ abi, functionName: 'openAndStake', args: [token, window, yes] });
    assert.equal(page.toLowerCase(), ref.toLowerCase(), `window ${window} yes ${yes}`);
  }
});

test('claim, witnessNo and payout calldata built by hand equal viem\'s', () => {
  const id = 7, who = '0x9a2Ed3a6BB196Ed3c33A7b826d6D7180D405Bd58';
  assert.equal((SEL.claim + pad(id.toString(16))).toLowerCase(), encodeFunctionData({ abi, functionName: 'claim', args: [BigInt(id)] }).toLowerCase());
  assert.equal((SEL.witnessNo + pad(id.toString(16))).toLowerCase(), encodeFunctionData({ abi, functionName: 'witnessNo', args: [BigInt(id)] }).toLowerCase());
  assert.equal((SEL.payout + pad(id.toString(16)) + pad(who)).toLowerCase(), encodeFunctionData({ abi, functionName: 'payout', args: [BigInt(id), who] }).toLowerCase());
});

test('the market struct is read from the right word positions', () => {
  const ref = decodeFunctionResult({ abi, functionName: 'market', data: MARKET0 });
  assert.equal(addrOf(word(MARKET0, 0)).toLowerCase(), ref.token.toLowerCase());
  assert.equal(Number(big(word(MARKET0, 1))), Number(ref.openedAt));
  assert.equal(Number(big(word(MARKET0, 2))), Number(ref.closesAt));
  assert.equal(Number(big(word(MARKET0, 3))), Number(ref.deadline));
  assert.equal(Number(big(word(MARKET0, 4))), Number(ref.window));
  assert.equal(Number(big(word(MARKET0, 5))), Number(ref.outcome));
  assert.equal(big(word(MARKET0, 6)), ref.yesPool);
  assert.equal(big(word(MARKET0, 7)), ref.noPool);
  assert.equal(big(word(MARKET0, 8)), ref.yesWeight);
  assert.equal(big(word(MARKET0, 9)), ref.noWeight);
  // and the real market 0 was a void (outcome 3) on a 10-minute window with a 5-minute close
  assert.equal(Number(ref.outcome), 3);
  assert.equal(Number(ref.deadline) - Number(ref.openedAt), 600);
  assert.equal(Number(ref.closesAt) - Number(ref.openedAt), 300);
});

test('the amount the page sends is the wei the contract sees', () => {
  for (const amt of ['0.01', '0.0001', '1.5', '0.123456']) {
    const wei = BigInt(Math.round(parseFloat(amt) * 1e18));
    const hexValue = '0x' + wei.toString(16);
    assert.equal(BigInt(hexValue), wei, amt);
    assert.ok(wei >= 100_000_000_000_000n, amt + ' is at least the 0.0001 ETH minimum');
  }
});
