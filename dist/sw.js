const VERSION = 'luma-atelier-shell-v1';
const APP = ['./','./index.html','./style.css','./creative.css','./app.js','./store.js','./imaging.js','./creative.js','./manifest.webmanifest','./assets/luma-192.png','./assets/luma-512.png','./assets/demo-1.jpg','./assets/demo-2.jpg','./assets/demo-3.jpg','./assets/demo-4.jpg','./assets/inter.woff2','./assets/bricolage.woff2'];
const RESOURCES = new Set(APP.map(path => new URL(path,self.location.href).href));

self.addEventListener('install',event => {
  event.waitUntil(caches.open(VERSION).then(cache => cache.addAll(APP)).then(() => self.skipWaiting()));
});

self.addEventListener('activate',event => {
  event.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(key => key.startsWith('luma-atelier-shell-') && key !== VERSION).map(key => caches.delete(key)))).then(() => self.clients.claim()));
});

self.addEventListener('fetch',event => {
  const request = event.request;
  if (request.method !== 'GET' || new URL(request.url).origin !== self.location.origin) return;
  if (request.mode === 'navigate') {
    event.respondWith(fetch(request).catch(() => caches.match('./index.html')));
  } else if (RESOURCES.has(request.url)) {
    event.respondWith(fetch(request).catch(() => caches.match(request)));
  }
});
