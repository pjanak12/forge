/* Offline cache for the app files. Bump VERSION whenever you change any file.
   Updating only replaces cached app files — user data lives in IndexedDB and is never touched here. */
const VERSION = 'forge-v2.1.0';
const IMG_CACHE = 'forge-img-v1'; // kept across updates so photos aren't re-downloaded
const ASSETS = [
  './',
  './index.html',
  './app.css',
  './app.js',
  './data.js',
  './guide.js',
  './manifest.webmanifest',
  './icons/apple-touch-icon.png',
  './icons/icon-192.png',
  './icons/icon-512.png'
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(VERSION).then((c) => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== VERSION && k !== IMG_CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== location.origin) return;
  const isImg = /\/img\/|\/icons\//.test(new URL(req.url).pathname);
  const put = (res) => { if (res && res.ok) { const copy = res.clone(); caches.open(VERSION).then((c) => c.put(req, copy)); } return res; };
  if (isImg) {
    // Photos never change: cache first.
    e.respondWith(caches.match(req).then((hit) => hit || fetch(req).then((res) => { if (res && res.ok) { const copy = res.clone(); caches.open(IMG_CACHE).then((c) => c.put(req, copy)); } return res; })));
    return;
  }
  // App files: try the network first (so updates arrive at once), fall back to cache when offline.
  e.respondWith(
    Promise.race([
      fetch(req).then(put),
      new Promise((_, rej) => setTimeout(() => rej(new Error('slow')), 3500))
    ]).catch(() => caches.match(req, { ignoreSearch: true }).then((hit) => hit || caches.match('./index.html')))
  );
});
