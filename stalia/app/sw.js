/*
 * Stalia — service worker: makes the calculator open instantly and work without the internet.
 * Strategy: answer from the cache at once, refresh the cached copy in the background
 * (so an updated site reaches the user on the next visit). Other sites (the licence server)
 * are never touched.
 */
'use strict';
const VERSION = 'stalia-v1';
const FONTS = [
  'ibm-plex-sans-latin-wght-normal', 'ibm-plex-sans-latin-ext-wght-normal', 'ibm-plex-sans-cyrillic-wght-normal', 'ibm-plex-sans-cyrillic-ext-wght-normal',
  'ibm-plex-mono-latin-400-normal', 'ibm-plex-mono-latin-600-normal', 'ibm-plex-mono-cyrillic-400-normal', 'ibm-plex-mono-cyrillic-600-normal',
  'ibm-plex-mono-cyrillic-ext-400-normal', 'ibm-plex-mono-cyrillic-ext-600-normal',
  'fira-sans-extra-condensed-latin-700-normal', 'fira-sans-extra-condensed-cyrillic-700-normal', 'fira-sans-extra-condensed-cyrillic-ext-700-normal',
].map((f) => '../assets/fonts/' + f + '.woff2');
const SHELL = [
  'index.html', 'app.css', 'config.js', 'engine.js', 'license.js', 'i18n.js', 'model.js', 'view.js', 'app.js', 'manifest.webmanifest',
  '../assets/base.css', '../assets/favicon.svg', '../assets/icons/icon-192.png', '../assets/icons/icon-512.png',
].concat(FONTS);

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(VERSION).then((cache) => cache.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith('stalia-') && k !== VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  if (req.mode === 'navigate') {
    // Any address of the calculator ("?lang=ru", a licence link…) is the same page; the query never enters the cache.
    event.respondWith((async () => {
      const cache = await caches.open(VERSION);
      const cached = await cache.match('index.html');
      const fresh = fetch('index.html', { cache: 'no-cache' })
        .then((res) => { if (res.ok) cache.put('index.html', res.clone()); return res; })
        .catch(() => null);
      if (cached) { event.waitUntil(fresh); return cached; }
      return (await fresh) || Response.error();
    })());
    return;
  }

  event.respondWith((async () => {
    const cache = await caches.open(VERSION);
    const cached = await cache.match(req);
    const fresh = fetch(req)
      .then((res) => { if (res.ok && res.type === 'basic') cache.put(req, res.clone()); return res; })
      .catch(() => null);
    if (cached) { event.waitUntil(fresh); return cached; }
    return (await fresh) || Response.error();
  })());
});
