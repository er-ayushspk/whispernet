self.addEventListener('install', (event) => {
    event.waitUntil((async() => {
        const cache = await caches.open('whispernet-v1');
        await cache.addAll([
            '/',
            '/index.html',
            '/main.js',
            '/manifest.webmanifest'
        ]);
        self.skipWaiting();
    })());
});

self.addEventListener('activate', (event) => {
    event.waitUntil(self.clients.claim());
});

self.addEventListener('fetch', (event) => {
    event.respondWith((async() => {
        const cached = await caches.match(event.request);
        return cached || fetch(event.request);
    })());
});