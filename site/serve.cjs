// Local preview of the built site: node site/serve.cjs  ->  http://localhost:4521
const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = Number(process.env.PORT || 4521);
http.createServer((req, res) => {
  const file = path.join(__dirname, 'index.html');
  fs.readFile(file, 'utf8', (err, body) => {
    if (err) { res.writeHead(500); res.end('build first: node site/build-site.cjs'); return; }
    // the published artifact wraps the page in a doctype and a head; the preview does the same
    const page = '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"></head><body>' + body + '</body></html>';
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
    res.end(page);
  });
}).listen(PORT, () => console.log('stepguard site on http://localhost:' + PORT));
