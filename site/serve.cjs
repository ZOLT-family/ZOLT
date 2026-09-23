// Local preview of the built site and the local deploy page: node site/serve.cjs -> http://localhost:4521
//   /             the page, as the artifact platform would wrap it
//   /deploy.html  the wallet-signed deploy page (never published)
//   /deploy-v2.html  the same for ZoltOddsV2 (needs the ZOLT token address)
//   /guard.html   the archived split-guard page
//   /og-card.html the social card; opening it draws the card and POSTs the PNG to /save-og, which writes public/og.png
// Serves only files inside site/. Nothing here talks to the chain; the pages do, from the browser.
const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = Number(process.env.PORT || 4521);
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.json': 'application/json', '.txt': 'text/plain', '.xml': 'application/xml' };

http.createServer((req, res) => {
  const name = decodeURIComponent(req.url.split('?')[0]);
  if (name === '/save-og' && req.method === 'POST') {
    // the one write this server does: the card page posts a PNG data URL, it lands at public/og.png and nowhere else
    let body = '';
    req.on('data', (d) => { body += d; if (body.length > 4 * 1024 * 1024) req.destroy(); });
    req.on('end', () => {
      const m = /^data:image\/png;base64,([A-Za-z0-9+/=]+)$/.exec(body);
      if (!m) { res.writeHead(400); res.end('expected a png data url'); return; }
      const png = Buffer.from(m[1], 'base64');
      const out = path.join(__dirname, 'public', 'og.png');
      fs.writeFileSync(out, png);
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('wrote ' + out + ' (' + png.length + ' bytes)');
    });
    return;
  }
  if (name === '/') {
    fs.readFile(path.join(__dirname, 'index.html'), 'utf8', (err, body) => {
      if (err) { res.writeHead(500); res.end('build first: node site/build-site.cjs'); return; }
      // the published artifact wraps the page in a doctype and a head; the preview does the same
      const page = '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"></head><body>' + body + '</body></html>';
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      res.end(page);
    });
    return;
  }
  const file = path.join(__dirname, path.normalize(name).replace(/^[\\/]+/, ''));
  if (!file.startsWith(__dirname)) { res.writeHead(403); res.end(); return; }
  fs.readFile(file, (err, body) => {
    if (err) { res.writeHead(404); res.end('not found'); return; }
    res.writeHead(200, { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream', 'cache-control': 'no-store' });
    res.end(body);
  });
}).listen(PORT, () => console.log('zolt site on http://localhost:' + PORT + '  (deploy page: /deploy.html)'));
