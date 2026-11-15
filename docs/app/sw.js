/* Minimal service worker so Chrome can treat PianoSmith as an installable PWA
   with Web Share Target. Network-first: always prefer live assets. */

self.addEventListener('install', (event) => {
  event.waitUntil(self.skipWaiting())
})

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim())
})

self.addEventListener('fetch', (event) => {
  event.respondWith(
    fetch(event.request).catch(() => caches.match(event.request).then((cached) => cached || Response.error())),
  )
})
