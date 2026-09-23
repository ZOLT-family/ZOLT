// Every recent market on the contract, read from chain 4663 on request, as JSON for bots, agents and other pages.
//
//   GET /api/markets          the last 24 markets (open ones first) with pools, implied odds, deadlines and the exact
//                             calldata a wallet sends to stake either side
//   GET /api/markets?id=12    one market
//
// Read-only: eth_call and two block reads, nothing else. Cached at the edge for a few seconds. The contract address
// comes from config.json, which the site builder writes from the deployment record.
const UPSTREAM = 'https://rpc.mainnet.chain.robinhood.com';
const CONFIG = require('./config.json');
const SEL = { marketCount: '0xec979082', market: '0x28861d22', symbol: '0x95d89b41', launched: '0x3cf28b5a', openAndStake: '0x34feb02b' };
const WINDOWS = [['10 min', 600], ['1 h', 3600], ['6 h', 21600]];
const LAST = 24;
const MIN_STAKE_WEI = '100000000000000'; // 0.0001 ETH

const pad = (v) => String(v).replace(/^0x/, '').toLowerCase().padStart(64, '0');
const word = (data, i) => '0x' + data.slice(2 + i * 64, 66 + i * 64);
const big = (hex) => { try { return BigInt(hex || '0x0'); } catch (e) { return 0n; } };
const eth = (wei) => (Number(wei / 1_000_000_000_000n) / 1e6).toFixed(6);

async function rpc(calls) {
  const body = calls.map((c, i) => ({ jsonrpc: '2.0', id: i + 1, method: c.method || 'eth_call', params: c.params || [{ to: c.to, data: c.data }, 'latest'] }));
  const r = await fetch(UPSTREAM, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(15000) });
  const j = await r.json();
  if (!Array.isArray(j)) throw new Error('rpc: ' + JSON.stringify(j).slice(0, 120));
  const byId = new Map(j.map((x) => [x.id, x]));
  return body.map((c) => { const x = byId.get(c.id); if (!x || x.error) throw new Error('rpc: ' + JSON.stringify(x && x.error).slice(0, 120)); return x.result; });
}
// the public RPC refuses big batches; ten at a time is known to pass
async function batched(calls) {
  const out = [];
  for (let i = 0; i < calls.length; i += 10) out.push(...await rpc(calls.slice(i, i + 10)));
  return out;
}
function decodeString(hex) {
  if (!hex || hex.length < 130) return '';
  const len = Number(big(word(hex, 1)));
  return Buffer.from(hex.slice(130, 130 + len * 2), 'hex').toString('utf8').replace(/[\x00-\x1f\x7f]/g, '');
}

module.exports = async function handler(req, res) {
  res.setHeader('access-control-allow-origin', '*');
  res.setHeader('cache-control', 'public, s-maxage=5, stale-while-revalidate=30');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'GET only' });
  const ODDS = CONFIG.odds;
  if (!ODDS) return res.status(503).json({ error: 'no market contract deployed' });

  try {
    const one = req.query && req.query.id !== undefined ? Number(req.query.id) : null;
    if (one !== null && !(Number.isInteger(one) && one >= 0)) return res.status(400).json({ error: 'id must be a non-negative integer' });

    const [blockHex, block, countHex] = await rpc([
      { method: 'eth_blockNumber', params: [] },
      { method: 'eth_getBlockByNumber', params: ['latest', false] },
      { to: ODDS, data: SEL.marketCount },
    ]);
    const now = parseInt(block.timestamp, 16), count = Number(big(countHex));
    if (one !== null && one >= count) return res.status(404).json({ error: 'no market ' + one + '; the contract has ' + count });
    const ids = one !== null ? [one] : Array.from({ length: Math.min(LAST, count) }, (_, i) => count - 1 - i);

    const raw = await batched(ids.map((id) => ({ to: ODDS, data: SEL.market + pad(id.toString(16)) })));
    const markets = ids.map((id, i) => {
      const d = raw[i];
      return {
        id, token: '0x' + word(d, 0).slice(-40), window: Number(big(word(d, 4))),
        openedAt: Number(big(word(d, 1))), closesAt: Number(big(word(d, 2))), deadline: Number(big(word(d, 3))),
        outcome: ['open', 'yes', 'no', 'void'][Number(big(word(d, 5)))] || 'open',
        yesPoolWei: big(word(d, 6)), noPoolWei: big(word(d, 7)),
      };
    });
    const tokens = [...new Set(markets.map((m) => m.token))];
    const extra = await batched(tokens.flatMap((t) => [{ to: t, data: SEL.symbol }, { to: CONFIG.factory, data: SEL.launched + pad(t) }]));
    const info = {};
    tokens.forEach((t, i) => {
      const lt = extra[i * 2 + 1];
      info[t] = { symbol: decodeString(extra[i * 2]), phase: lt && lt.length >= 2 + 64 * 15 ? Number(big(word(lt, 10))) : null };
    });

    const shaped = markets.map((m) => {
      const total = m.yesPoolWei + m.noPoolWei;
      const w = WINDOWS[m.window] || ['?', 0];
      return {
        id: m.id, token: m.token, symbol: info[m.token].symbol, launchPhase: info[m.token].phase, // 0 still on its curve, 1-3 graduated
        window: m.window, windowLabel: w[0], windowSeconds: w[1],
        openedAt: m.openedAt, closesAt: m.closesAt, deadline: m.deadline,
        outcome: m.outcome, stakingOpen: m.outcome === 'open' && now < m.closesAt && info[m.token].phase === 0,
        secondsToClose: Math.max(0, m.closesAt - now), secondsToDeadline: Math.max(0, m.deadline - now),
        yesPool: eth(m.yesPoolWei), noPool: eth(m.noPoolWei), impliedYesBps: total === 0n ? null : Number(m.yesPoolWei * 10000n / total),
        stake: {
          to: ODDS, function: 'openAndStake(address token, uint8 window, bool yes) payable', minValueWei: MIN_STAKE_WEI,
          yes: SEL.openAndStake + pad(m.token) + pad(m.window.toString(16)) + pad('1'),
          no: SEL.openAndStake + pad(m.token) + pad(m.window.toString(16)) + pad('0'),
        },
      };
    });
    shaped.sort((a, b) => (a.outcome === 'open' ? 0 : 1) - (b.outcome === 'open' ? 0 : 1) || b.id - a.id);
    const out = { chainId: CONFIG.chainId, contract: ODDS, block: parseInt(blockHex, 16), now, marketCount: count, markets: one !== null ? shaped : shaped, open: shaped.filter((m) => m.outcome === 'open').length };
    if (one !== null) out.market = shaped[0];
    return res.status(200).json(out);
  } catch (e) {
    return res.status(502).json({ error: 'could not read the chain', detail: String(e.message || e).slice(0, 160) });
  }
};
