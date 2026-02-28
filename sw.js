/**
 * sw.js — Service worker for QRAM PWA.
 * Cache-first strategy; bumped version triggers cache refresh.
 */

const CACHE   = 'qram-v1';
const ASSETS  = [
  './',
  './index.html',
  './app.js',
  './manifest.json',
  './libs/pako.min.js',
  './libs/compress.js',
  './libs/jsQR.js',
  './libs/pkg/qram_core.js',
  './libs/pkg/qram_core_bg.wasm',
];

self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE).then(c => c.addAll(ASSETS))
  );
  self.skipWaiting();
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', e => {
  e.respondWith(
    caches.match(e.request).then(cached => cached || fetch(e.request))
  );
});
