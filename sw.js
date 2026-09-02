// Kalender Service Worker
const CACHE_NAME = 'kalender-v1';
const ASSETS = ['./', './index.html', './styles.css', './app.js', './firebase-config.js', './manifest.json', './logo.png'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE_NAME).then(cache => cache.addAll(ASSETS).catch(() => {})));
  self.skipWaiting();
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys => Promise.all(
      keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k))
    ))
  );
  self.clients.claim();
});

self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET') return;
  const url = new URL(e.request.url);
  // Firebase-Requests nie cachen
  if (url.hostname.includes('firebase') || url.hostname.includes('googleapis') || url.hostname.includes('gstatic')) return;

  if (e.request.mode === 'navigate') {
    e.respondWith(
      fetch(e.request).catch(() => caches.match('./').then(r => r || caches.match('./index.html')))
    );
    return;
  }

  e.respondWith(caches.match(e.request).then(r => r || fetch(e.request)));
});
