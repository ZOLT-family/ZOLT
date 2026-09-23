// GET /m/<id> (rewritten here as /api/m?id=<id>): the page, with its link-preview tags describing that one market,
// so a shared market link shows its own card. Humans get the same page; a small script turns the address back into
// /?m=<id>, which the page reads to pick that market. If the market cannot be read, the page is served unchanged.
const CONFIG = require('./config.json');

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

module.exports = async function handler(req, res) {
  res.setHeader('cache-control', 'public, s-maxage=10, stale-while-revalidate=60');
  if (req.method !== 'GET') return res.status(405).send('GET only');
  const id = req.query && /^\d+$/.test(String(req.query.id)) ? Number(req.query.id) : null;
  if (id === null) return res.status(400).send('id must be a non-negative integer');
  const site = CONFIG.site;

  let page;
  try {
    const r = await fetch(site, { signal: AbortSignal.timeout(8000) });
    page = await r.text();
  } catch (e) {
    return res.status(502).send('could not read the page');
  }

  let m = null;
  try {
    const r = await fetch(site + 'api/markets?id=' + id, { signal: AbortSignal.timeout(12000) });
    if (r.ok) m = (await r.json()).market || null;
  } catch (e) { m = null; }

  if (m) {
    const name = m.symbol && m.symbol !== '?' ? '$' + m.symbol : m.token.slice(0, 6) + '…' + m.token.slice(-4);
    const title = 'Will ' + name + ' graduate in ' + m.windowLabel + '? · Zolt Odds';
    const desc = (m.outcome === 'open'
      ? 'YES ' + Number(m.yesPool).toFixed(3) + ' / NO ' + Number(m.noPool).toFixed(3) + ' ETH' + (m.impliedYesBps === null ? '' : ' · ' + (m.impliedYesBps / 100).toFixed(1) + '% yes') + (m.stakingOpen ? ' · staking open' : ' · staking closed, waiting on the deadline')
      : 'Resolved ' + m.outcome.toUpperCase() + ' · YES ' + Number(m.yesPool).toFixed(3) + ' / NO ' + Number(m.noPool).toFixed(3) + ' ETH')
      + '. Market #' + m.id + ' on a Pons launch, settled by the chain.';
    const img = site + 'api/card?id=' + m.id;
    page = page
      .replace(/<title>[^<]*<\/title>/, '<title>' + esc(title) + '</title>')
      .replace(/(<meta property="og:title" content=")[^"]*(")/, '$1' + esc(title) + '$2')
      .replace(/(<meta name="twitter:title" content=")[^"]*(")/, '$1' + esc(title) + '$2')
      .replace(/(<meta property="og:description" content=")[^"]*(")/, '$1' + esc(desc) + '$2')
      .replace(/(<meta name="twitter:description" content=")[^"]*(")/, '$1' + esc(desc) + '$2')
      .replace(/(<meta name="description" content=")[^"]*(")/, '$1' + esc(desc) + '$2')
      .replace(/(<meta property="og:image" content=")[^"]*(")/, '$1' + img + '$2')
      .replace(/(<meta name="twitter:image" content=")[^"]*(")/, '$1' + img + '$2')
      .replace(/(<meta property="og:image:alt" content=")[^"]*(")/, '$1' + esc(title) + '$2')
      .replace(/(<meta property="og:url" content=")[^"]*(")/, '$1' + site + 'm/' + m.id + '$2')
      .replace(/(<link rel="canonical" href=")[^"]*(")/, '$1' + site + 'm/' + m.id + '$2');
  }
  // the page reads ?m=<id> at start; put it back in the address before its script runs
  page = page.replace(/<body([^>]*)>/, '<body$1><script>try{history.replaceState(null,"","/?m=' + id + '")}catch(e){}</script>');
  res.setHeader('content-type', 'text/html; charset=utf-8');
  return res.status(200).send(page);
};
