// Uygulama kabuğunu önbelleğe alır (çevrimdışı açılış). Finnhub istekleri her zaman ağdan gider.
const SURUM = 'defter-v12'; // app.js UYGULAMA_SURUM.no ile aynı tutun
const KABUK = ['./', 'index.html', 'styles.css', 'app.js', 'manifest.webmanifest', 'icon.svg', 'icon-maskable.svg'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(SURUM).then(c => c.addAll(KABUK)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(k => Promise.all(k.filter(x => x !== SURUM).map(x => caches.delete(x)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin) return; // Finnhub: dokunma
  if (url.pathname.endsWith('/sw.js')) return; // sürüm kontrolü her zaman doğrudan ağdan
  // Önce ağ (güncel sürüm), ağ yoksa önbellek.
  e.respondWith(fetch(e.request).then(r => {
    const kopya = r.clone(); caches.open(SURUM).then(c => c.put(e.request, kopya)); return r;
  }).catch(() => caches.match(e.request).then(r => r || caches.match('index.html'))));
});
