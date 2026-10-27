'use strict';
const VERSION = '4.3.1';
const SCOPE = self.registration.scope;
const PREFIX = `valutax:${SCOPE}:`;
const CACHE_NAME = PREFIX + VERSION;
const SHELL = ['./', './index.html', './website.html', `./website.css?v=${VERSION}`, `./style.css?v=${VERSION}`, `./app.js?v=${VERSION}`,
    './firebase-config.js', `./firebase-client.js?v=${VERSION}`, `./config-utils.js?v=${VERSION}`,
    './setup.html', `./setup.js?v=${VERSION}`, './PANDUAN.html'];
const shellURLs = new Set(SHELL.map(path => new URL(path, SCOPE).href));
self.addEventListener('install', event => {
    event.waitUntil(caches.open(CACHE_NAME).then(cache => cache.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', event => {
    event.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(key => key.startsWith(PREFIX) && key !== CACHE_NAME)
        .map(key => caches.delete(key)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', event => {
    const url = new URL(event.request.url);
    // Respons Firebase/Auth dan kurs tidak pernah disamarkan oleh cache service worker.
    if (event.request.method !== 'GET' || url.origin !== self.location.origin) return;
    const isConfig = url.href === new URL('./firebase-config.js', SCOPE).href;
    if (event.request.mode === 'navigate' || isConfig) {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 3500);
        event.respondWith((async () => {
            const cache = await caches.open(CACHE_NAME);
            try {
                const response = await fetch(event.request, { signal: controller.signal, cache: 'no-cache' });
                if (response.ok) {
                    if (shellURLs.has(url.href)) await cache.put(event.request, response.clone());
                    return response;
                }
                if (response.status < 500) return response;
            } catch (_) { /* jaringan gagal: baca cache milik aplikasi ini */ }
            finally { clearTimeout(timer); }
            const exact = await cache.match(event.request);
            if (exact) return exact;
            // Abaikan parameter navigasi untuk halaman yang memang dikenal.
            const cleanURL = new URL(url); cleanURL.search = ''; cleanURL.hash = '';
            if (shellURLs.has(cleanURL.href)) {
                const cached = await cache.match(cleanURL.href);
                if (cached) return cached;
            }
            return new Response('Halaman ini belum tersedia offline. Buka halaman utama setelah koneksi pulih.',
                { status: 503, headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
        })());
    } else if (shellURLs.has(url.href)) {
        event.respondWith(caches.open(CACHE_NAME).then(async cache => (await cache.match(event.request)) || fetch(event.request)));
    }
});
