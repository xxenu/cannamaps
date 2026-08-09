#!/usr/bin/env node
/* Minimal static file server for local development — no dependencies.
 * Usage: node tools/serve.js [port]      (default 8000)
 *
 * `python3 -m http.server 8000` from inside public/ works just as well; this
 * exists so the port and root are pinned in one place. */

const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', 'public');
const PORT = Number(process.argv[2]) || 8000;

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.webmanifest': 'application/manifest+json'
};

http.createServer((req, res) => {
  let pathname = decodeURIComponent(req.url.split('?')[0]);
  if (pathname.endsWith('/')) pathname += 'index.html';

  const file = path.join(ROOT, path.normalize(pathname));
  if (!file.startsWith(ROOT)) {
    res.writeHead(403, { 'Content-Type': 'text/plain' }).end('Forbidden');
    return;
  }

  fs.readFile(file, (err, body) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain' }).end('Not found');
      return;
    }
    res.writeHead(200, {
      'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream',
      // Never let the browser cache during development; the service worker
      // still exercises its own caching on top of this.
      'Cache-Control': 'no-store'
    });
    res.end(body);
  });
}).listen(PORT, () => {
  console.log('CannaMap dev server: http://localhost:' + PORT);
});
