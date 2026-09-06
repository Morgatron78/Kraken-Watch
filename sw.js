// SHELL is injected by vite-plugin-pwa (injectManifest mode) at build time —
// each entry is { url, revision }. Vite's own JS/CSS output is already
// content-hashed (revision: null on those); everything else Vite doesn't
// hash (index.html, manifest.json, icons) gets an explicit content revision
// instead, so a change to any of them is still detected here.
const SHELL = self.__WB_MANIFEST;

// CACHE is derived from the shell manifest itself rather than a version
// string threaded in from the app build — see docs/improvement-plan.md
// ("Service worker" under Phase 1 §1A) for why: it changes exactly when a
// precached file's content/URL actually changes, with no cross-build
// coordination needed, and correctly stays put on a deploy that doesn't
// touch any shell file.
function hashManifest(manifest) {
  const str = manifest.map(e => `${e.url}:${e.revision || ''}`).sort().join('|');
  let h = 0;
  for (let i = 0; i < str.length; i++) h = (h * 31 + str.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}
const CACHE = 'kraken-watch-' + hashManifest(SHELL);

self.addEventListener('install', (event) => {
  // Individual adds via allSettled, NOT addAll: addAll is atomic, so one
  // asset 404ing during a deploy-propagation race would reject the whole
  // precache and leave this SW stuck installing. Any entry that missed here
  // self-heals on its first successful fetch (see the fetch handler).
  event.waitUntil(
    caches.open(CACHE).then(cache => Promise.allSettled(SHELL.map(e => cache.add(e.url))))
  );
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
  if (url.hostname.includes('octopus.energy') || url.hostname.includes('googleapis.com')) return;
  if (event.request.mode === 'navigate') {
    event.respondWith(
      fetch(event.request)
        .then(res => { caches.open(CACHE).then(cache => cache.put(event.request, res.clone())); return res; })
        .catch(() => caches.match(event.request))
    );
    return;
  }
  event.respondWith(
    caches.match(event.request).then(cached => {
      if (cached) return cached;
      return fetch(event.request).then(res => {
        // Cache a good same-origin response so an incomplete precache (an
        // asset that 404'd mid-deploy) heals on the first real load rather
        // than staying network-dependent until the next SW update. Hashed
        // asset URLs are immutable, so this can't serve stale content.
        if (res && res.ok && url.origin === self.location.origin) {
          const copy = res.clone();
          caches.open(CACHE).then(cache => cache.put(event.request, copy));
        }
        return res;
      });
    })
  );
});
