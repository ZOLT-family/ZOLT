// Minimal JSON-RPC client for Robinhood Chain (4663).
// Goes through curl with DNS-over-HTTPS because the local ISP hijacks DNS for the RPC host.
const { execFileSync } = require('child_process');

const RPC = process.env.RH_RPC || 'https://rpc.mainnet.chain.robinhood.com';
const MIN_GAP_MS = Number(process.env.RH_GAP_MS || 450);
let last = 0;

function sleep(ms) {
  const until = Date.now() + ms;
  while (Date.now() < until) { /* spin: synchronous on purpose */ }
}

function rpc(method, params, attempt = 0) {
  const wait = last + MIN_GAP_MS - Date.now();
  if (wait > 0) sleep(wait);
  last = Date.now();
  const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method, params });
  let out;
  try {
    // body goes through stdin: Windows caps a command line at ~32 KB and Multicall payloads exceed it
    out = execFileSync('curl', [
      '-s', '--max-time', '90', '--doh-url', 'https://cloudflare-dns.com/dns-query',
      RPC, '-H', 'content-type: application/json', '--data-binary', '@-',
    ], { input: body, encoding: 'utf8', maxBuffer: 512 * 1024 * 1024 });
  } catch (e) {
    if (attempt < 5) { sleep(3000 * (attempt + 1)); return rpc(method, params, attempt + 1); }
    throw e;
  }
  let j;
  try { j = JSON.parse(out); } catch (e) {
    if (attempt < 5) { sleep(3000 * (attempt + 1)); return rpc(method, params, attempt + 1); }
    throw new Error(method + ' non-JSON response: ' + out.slice(0, 200));
  }
  if (j.error) {
    const msg = JSON.stringify(j.error);
    if (/429|Too Many|rate|SOURCE_UNREACHABLE|timeout/i.test(msg) && attempt < 6) {
      sleep(4000 * (attempt + 1));
      return rpc(method, params, attempt + 1);
    }
    const err = new Error(method + ' -> ' + msg);
    err.rpc = j.error;
    throw err;
  }
  return j.result;
}

const hex = (n) => '0x' + BigInt(n).toString(16);
const pad32 = (addr) => '0x' + addr.toLowerCase().replace(/^0x/, '').padStart(64, '0');

// eth_getLogs that splits the range in half whenever the node refuses (>10k matches).
function getLogsChunked(filter, from, to, depth = 0) {
  try {
    return rpc('eth_getLogs', [{ ...filter, fromBlock: hex(from), toBlock: hex(to) }]);
  } catch (e) {
    if (/exceeds limit|10000|too many|query returned more/i.test(e.message) && to > from && depth < 24) {
      const mid = from + Math.floor((to - from) / 2);
      return [
        ...getLogsChunked(filter, from, mid, depth + 1),
        ...getLogsChunked(filter, mid + 1, to, depth + 1),
      ];
    }
    throw e;
  }
}

const blockCache = new Map();
function blockTs(n) {
  if (blockCache.has(n)) return blockCache.get(n);
  const b = rpc('eth_getBlockByNumber', [hex(n), false]);
  const ts = parseInt(b.timestamp, 16);
  blockCache.set(n, ts);
  return ts;
}

// First block whose timestamp is >= target. Interpolation search, then a short linear walk.
function blockAtOrAfter(targetTs, lo, hi) {
  let loTs = blockTs(lo);
  let hiTs = blockTs(hi);
  if (targetTs <= loTs) return lo;
  if (targetTs > hiTs) return null;
  for (let i = 0; i < 40 && hi - lo > 1; i++) {
    let guess;
    if (i % 2 === 0 && hiTs > loTs) {
      guess = lo + Math.floor(((targetTs - loTs) / (hiTs - loTs)) * (hi - lo));
    } else {
      guess = lo + Math.floor((hi - lo) / 2);
    }
    guess = Math.min(hi - 1, Math.max(lo + 1, guess));
    const t = blockTs(guess);
    if (t < targetTs) { lo = guess; loTs = t; } else { hi = guess; hiTs = t; }
  }
  return hi;
}

module.exports = { rpc, hex, pad32, getLogsChunked, blockTs, blockAtOrAfter, sleep };
