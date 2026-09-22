// A read-only relay to chain 4663, for readers whose network cannot resolve or reach the public RPC host
// (some ISPs hijack DNS for it). The page calls the chain directly first and only falls back to here.
//
// Deliberately narrow: POST only, JSON only, read-only methods, a bounded batch, no URL taken from the caller,
// no credentials of any kind. It cannot be used to send a transaction.
const UPSTREAM = 'https://rpc.mainnet.chain.robinhood.com';
const ALLOWED = new Set(['eth_call', 'eth_blockNumber', 'eth_chainId', 'eth_getBalance', 'eth_getCode', 'eth_getBlockByNumber', 'eth_getLogs']);
const MAX_CALLS = 200;
const MAX_BYTES = 256 * 1024;
const MAX_LOG_RANGE = 216_000; // 6 hours of 0.1 s blocks; and a log query must name the contract it reads

// eth_getLogs is the one read that can be made expensive; keep it to one contract and a bounded range
function logsAreBounded(c) {
  const f = c.params && c.params[0];
  if (!f || typeof f !== 'object' || typeof f.address !== 'string') return false;
  const from = parseInt(f.fromBlock, 16), to = parseInt(f.toBlock, 16);
  return Number.isFinite(from) && Number.isFinite(to) && to >= from && to - from <= MAX_LOG_RANGE;
}

// Best-effort abuse brake, per warm instance: a caller gets 120 requests a minute, then 429s until the minute
// rolls over. Serverless instances do not share memory, so this bounds one instance, not the world; the upstream
// RPC's own limits stand behind it.
const RATE_LIMIT = 120;
const buckets = new Map();
function overLimit(ip) {
  const now = Date.now();
  const b = buckets.get(ip) || { start: now, n: 0 };
  if (now - b.start > 60_000) { b.start = now; b.n = 0; }
  b.n++;
  buckets.set(ip, b);
  if (buckets.size > 5000) buckets.clear();
  return b.n > RATE_LIMIT;
}

module.exports = async function handler(req, res) {
  res.setHeader('cache-control', 'no-store');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'post a json-rpc body' });
  const ip = String(req.headers['x-forwarded-for'] || req.socket?.remoteAddress || '').split(',')[0].trim();
  if (overLimit(ip)) return res.status(429).json({ error: 'too many requests from this address; try again in a minute' });

  let body = req.body;
  if (typeof body === 'string') {
    if (body.length > MAX_BYTES) return res.status(413).json({ error: 'body too large' });
    try { body = JSON.parse(body); } catch (e) { return res.status(400).json({ error: 'body is not json' }); }
  }
  if (!body || typeof body !== 'object') return res.status(400).json({ error: 'body is not json' });

  const calls = Array.isArray(body) ? body : [body];
  if (calls.length > MAX_CALLS) return res.status(413).json({ error: 'at most ' + MAX_CALLS + ' calls per request' });
  for (const c of calls) {
    if (!c || typeof c.method !== 'string' || !ALLOWED.has(c.method)) {
      return res.status(403).json({ error: 'this relay only forwards read-only calls: ' + [...ALLOWED].join(', ') });
    }
    if (c.method === 'eth_getLogs' && !logsAreBounded(c)) {
      return res.status(403).json({ error: 'eth_getLogs must name an address and span at most ' + MAX_LOG_RANGE + ' blocks' });
    }
  }

  try {
    const upstream = await fetch(UPSTREAM, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(calls.length === 1 && !Array.isArray(body) ? calls[0] : calls),
      signal: AbortSignal.timeout(20000),
    });
    const text = await upstream.text();
    res.status(upstream.status);
    res.setHeader('content-type', 'application/json');
    return res.send(text);
  } catch (e) {
    return res.status(502).json({ error: 'upstream did not answer' });
  }
};
