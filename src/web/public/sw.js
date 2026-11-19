const CACHE = 'nota-static-v9';
self.addEventListener('install', (event) =>
  event.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE);
      const response = await fetch('/');
      const html = await response.clone().text();
      await cache.put('/', response);
      const assets = [...html.matchAll(/(?:src|href)="(\/assets\/[^"#]+)"/g)].map((x) => x[1]);
      await cache.addAll([
        ...new Set(['/favicon.svg', '/fonts/Manrope.ttf', '/brand/gmi-clouder.svg', ...assets]),
      ]);
      self.skipWaiting();
    })(),
  ),
);
self.addEventListener('activate', (event) =>
  event.waitUntil(
    (async () => {
      for (const key of await caches.keys())
        if (key.startsWith('nota-static-') && key !== CACHE) await caches.delete(key);
      await self.clients.claim();
    })(),
  ),
);
self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (
    event.request.method !== 'GET' ||
    url.origin !== self.location.origin ||
    url.pathname.startsWith('/api/')
  )
    return;
  if (event.request.mode === 'navigate') {
    event.respondWith(
      fetch(event.request)
        .then((response) => {
          if (response.ok) caches.open(CACHE).then((c) => c.put('/', response.clone()));
          return response;
        })
        .catch(() => caches.match('/')),
    );
    return;
  }
  if (
    url.pathname.startsWith('/assets/') ||
    url.pathname.startsWith('/fonts/') ||
    url.pathname.startsWith('/brand/') ||
    url.pathname === '/favicon.svg'
  )
    event.respondWith(
      caches.match(event.request).then(
        (hit) =>
          hit ||
          fetch(event.request).then((response) => {
            if (response.ok) caches.open(CACHE).then((c) => c.put(event.request, response.clone()));
            return response;
          }),
      ),
    );
});
