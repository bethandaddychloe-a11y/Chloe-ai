// Chloe AI service worker (v2, black and gold): lets Chrome offer "Install app". Always uses the live network.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', e => e.waitUntil(self.clients.claim()));
self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET') return;
  e.respondWith(fetch(e.request).catch(() => new Response('Chloe is offline. Check your connection.', { status: 503, headers: { 'content-type': 'text/plain' } })));
});
