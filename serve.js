// Yerel deneme sunucusu (bağımlılık yok): node pwa/serve.js  → http://localhost:5173
const http = require('http');
const fs = require('fs');
const path = require('path');

const KOK = __dirname;
const PORT = Number(process.env.PORT) || 5173;
const TUR = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.ico': 'image/x-icon'
};

http.createServer((req, res) => {
  let p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  if (p === '/') p = '/index.html';
  const dosya = path.normalize(path.join(KOK, p));
  if (!dosya.startsWith(KOK) || path.basename(dosya) === 'serve.js') { res.writeHead(403); return res.end(); }
  fs.readFile(dosya, (err, veri) => {
    if (err) { res.writeHead(404); return res.end('Bulunamadı'); }
    res.writeHead(200, { 'Content-Type': TUR[path.extname(dosya)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(veri);
  });
}).listen(PORT, () => console.log('Borsa Defteri: http://localhost:' + PORT));
