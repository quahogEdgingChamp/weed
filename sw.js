/* Cloudline service worker: keeps the page's own files available offline.

   Network first, cache as the fallback, so an edited app.js is picked up on
   the next load rather than after a cache expiry. /api/ is never touched:
   stale data served as current would be worse than an honest "offline",
   and unsaved edits already wait in localStorage until the server is back. */

const CACHE = "cloudline-shell-v3";
const SHELL = ["./", "index.html", "styles.css", "core.js", "app.js", "research.js", "manifest.webmanifest", "icon.svg", "fonts/bricolage-grotesque-latin.woff2"];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== CACHE).map((key) => caches.delete(key))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  if (event.request.method !== "GET" || url.origin !== self.location.origin || url.pathname.startsWith("/api/")) {
    return;
  }

  event.respondWith(
    fetch(event.request)
      .then((response) => {
        if (response.ok) {
          const copy = response.clone();
          caches.open(CACHE).then((cache) => cache.put(event.request, copy));
        }
        return response;
      })
      .catch(() =>
        caches.match(event.request, { ignoreSearch: true }).then((cached) => cached || caches.match("index.html"))
      )
  );
});
