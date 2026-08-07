const CACHE = 'kraken-watch-v57';
const SHELL = [
  './',
  './index.html',
  './styles.css?v=57',
  './app.js?v=57',
  './manifest.json',
  './icon-192.png',
  './icon-512.png'
];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(SHELL)));
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);

  // Never cache API calls, or the EV status file (now fetched cross-origin
  // from raw.githubusercontent.com/.../state branch) — always go to the
  // network so data stays live rather than serving a stale cached copy.
  if (url.hostname.includes('octopus.energy') || url.hostname.includes('googleapis.com') || url.hostname.includes('raw.githubusercontent.com')) {
    return;
  }

  // App shell: cache-first, falling back to network.
  event.respondWith(
    caches.match(event.request).then(cached => cached || fetch(event.request))
  );
});

// Push notifications from the EV dispatch checker (see .github/workflows/ev-notify.yml).
// Always shown silently — no sound/vibration — per how this was designed to be used.
self.addEventListener('push', (event) => {
  let data = { title: 'Kraken Watch', body: 'EV status update' };
  try { if (event.data) data = { ...data, ...event.data.json() }; } catch { /* keep default */ }

  event.waitUntil(
    self.registration.showNotification(data.title, {
      body: data.body,
      silent: true,
      icon: './icon-192.png',
      badge: './icon-192.png',
      tag: 'ev-status' // replaces any previous EV notification rather than stacking
    })
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clientList) => {
      for (const client of clientList) {
        if ('focus' in client) return client.focus();
      }
      if (self.clients.openWindow) return self.clients.openWindow('./index.html');
    })
  );
});
