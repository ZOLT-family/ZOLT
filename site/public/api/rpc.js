// A read-only relay to chain 4663, for readers whose network cannot resolve or reach the public RPC host
// (some ISPs hijack DNS for it). The page calls the chain directly first and only falls back to here.
//
// Deliberately narrow: POST only, JSON only, read-only methods, a bounded batch, no URL taken from the caller,
// no credentials of any kind. It cannot be used to send a transaction.
const UPSTREAM = 'https://rpc.mainnet.chain.robinhood.com';
const ALLOWED = new Set(['eth_call', 'eth_blockNumber', 'eth_chainId', 'eth_getBalance', 'eth_getCode']);
const MAX_CALLS = 200;
const MAX_BYTES = 256 * 1024;

module.exports = async function handler(req, res) {
  res.setHeader('cache-control', 'no-store');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'post a json-rpc body' });

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
