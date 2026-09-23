// GET /api/card          the site's link-preview card (the base rate), 1200x630 PNG
// GET /api/card?id=14    the card for one market: its pools and clock, read from /api/markets
//
// Drawn on the server with satori (the element tree in _card.cjs -> SVG) and resvg (SVG -> PNG), in the page's own
// fonts fetched once per warm instance from Google Fonts. A script the page cannot draw (say, 牛) is covered by a
// Noto Sans fetched for that text alone. If anything fails the request is sent to the static og.png instead, so a
// shared link always has a picture. ?debug=1 shows the failure instead.
const fs = require('fs');
const path = require('path');
const CONFIG = require('./config.json');
const { siteCard, marketCard, W, H } = require('./_card.cjs');

const UA = 'Mozilla/5.0 (Windows NT 6.1; WOW64; rv:5.0)'; // an old UA makes Google Fonts answer with TTF, which satori reads
const fontCss = (family, text) => fetch('https://fonts.googleapis.com/css2?family=' + family + '&display=swap' + (text ? '&text=' + encodeURIComponent(text) : ''), { headers: { 'user-agent': UA }, signal: AbortSignal.timeout(10000) }).then((r) => r.text());
async function ttf(family, text) {
  const css = await fontCss(family, text);
  // a whole family comes as …/name.ttf; a text subset as …/l/font?kit=…, both declared format('truetype')
  const m = css.match(/src: url\(([^)]+)\) format\('truetype'\)/);
  if (!m) throw new Error('no ttf for ' + family);
  return fetch(m[1], { signal: AbortSignal.timeout(10000) }).then((r) => r.arrayBuffer());
}
let fontsPromise = null;
function fonts() {
  if (!fontsPromise) {
    fontsPromise = Promise.all([ttf('Gloock'), ttf('Fragment+Mono'), ttf('Anybody:wght@800')]).then(([g, f, a]) => [
      { name: 'Gloock', data: g, weight: 400, style: 'normal' },
      { name: 'Fragment Mono', data: f, weight: 400, style: 'normal' },
      { name: 'Anybody', data: a, weight: 800, style: 'normal' },
      { name: 'Anybody', data: a, weight: 400, style: 'normal' },
    ]).catch((e) => { fontsPromise = null; throw e; });
  }
  return fontsPromise;
}
// a glyph none of the three fonts has: fetch Noto Sans for exactly that text (CJK symbols are common on Pons)
const extra = new Map();
async function loadAdditionalAsset(code, segment) {
  if (code === 'emoji') return '';
  const key = code + ':' + segment;
  if (!extra.has(key)) {
    extra.set(key, ttf('Noto+Sans+SC', segment).then((data) => ({ name: 'Noto Sans SC', data, weight: 400, style: 'normal' })).catch(() => ''));
  }
  return extra.get(key);
}

let toolsPromise = null;
function tools() {
  if (!toolsPromise) {
    toolsPromise = (async () => {
      const satori = (await import('satori')).default;
      const resvg = require('@resvg/resvg-wasm');
      // the wasm sits next to this file (a copy of @resvg/resvg-wasm/index_bg.wasm): a require.resolve into
      // node_modules is not traced into the function bundle, a file beside it is
      await resvg.initWasm(fs.readFileSync(path.join(__dirname, 'resvg.wasm')));
      return { satori, Resvg: resvg.Resvg };
    })().catch((e) => { toolsPromise = null; throw e; });
  }
  return toolsPromise;
}

async function draw(tree) {
  const { satori, Resvg } = await tools();
  const svg = await satori(tree, { width: W, height: H, fonts: await fonts(), loadAdditionalAsset });
  return Buffer.from(new Resvg(svg, { fitTo: { mode: 'width', value: W } }).render().asPng());
}

module.exports = async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).send('GET only');
  const site = CONFIG.site;
  const idRaw = req.query && req.query.id !== undefined ? String(req.query.id) : null;
  const fallback = () => { res.setHeader('cache-control', 'no-store'); return res.redirect(302, site + 'og.png'); };
  try {
    let tree, maxAge;
    if (idRaw !== null) {
      if (!/^\d+$/.test(idRaw)) return res.status(400).send('id must be a non-negative integer');
      const r = await fetch(site + 'api/markets?id=' + idRaw, { signal: AbortSignal.timeout(15000) });
      if (!r.ok) return fallback();
      const m = (await r.json()).market;
      if (!m) return fallback();
      tree = marketCard(m, site);
      maxAge = 30;
    } else {
      tree = siteCard(CONFIG.figures || { launches24h: '—', gradRate24h: '—', gradMedian: '—' }, site);
      maxAge = 3600;
    }
    const png = await draw(tree);
    res.setHeader('content-type', 'image/png');
    res.setHeader('cache-control', 'public, s-maxage=' + maxAge + ', stale-while-revalidate=' + maxAge * 10);
    return res.status(200).send(png);
  } catch (e) {
    if (req.query && req.query.debug !== undefined) return res.status(500).send(String((e && e.stack) || e));
    return fallback();
  }
};
