// Kalender Service Worker — "network-first" für App-Shell
// Sobald online, wird immer die aktuellste Version geliefert; Cache dient nur als Offline-Fallback.

const VERSION = 'v2';
const CACHE_NAME = `kalender-${VERSION}`;
const ASSETS = ['./', './index.html', './styles.css', './app.js', './firebase-config.js', './manifest.json', './logo.svg'];

self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE_NAME).then(cache => cache.addAll(ASSETS).catch(() => {}))
  );
  self.skipWaiting();
});

self.addEventListener('activate', e => {
  e.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)));
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET') return;
  const url = new URL(e.request.url);

  // Firebase / Google-Auth immer live
  if (url.hostname.includes('firebase') || url.hostname.includes('googleapis') || url.hostname.includes('gstatic')) return;

  // Eigene App-Assets: network-first, Cache nur als Fallback (offline)
  if (url.origin === self.location.origin) {
    e.respondWith((async () => {
      try {
        const resp = await fetch(e.request);
        // erfolgreiche Antworten in Cache aktualisieren
        if (resp && resp.status === 200 && resp.type === 'basic') {
          const clone = resp.clone();
          caches.open(CACHE_NAME).then(c => c.put(e.request, clone)).catch(() => {});
        }
        return resp;
      } catch {
        // Offline: aus Cache
        const cached = await caches.match(e.request);
        if (cached) return cached;
        if (e.request.mode === 'navigate') {
          return (await caches.match('./index.html')) || (await caches.match('./'));
        }
        throw new Error('offline');
      }
    })());
    return;
  }

  // Fremde Assets (CDN): cache-first
  e.respondWith(caches.match(e.request).then(r => r || fetch(e.request)));
});
