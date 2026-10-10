/* Cloudline service worker: keeps the page's own files available offline.

   Network first, cache as the fallback, so an edited script is picked up on
   the next load rather than after a cache expiry. /api/ is never touched:
   stale data served as current would be worse than an honest "offline",
   and unsaved edits already wait in localStorage until the server is back. */

const CACHE = "cloudline-shell-v9";
const SHELL = ["./", "index.html", "styles.css", "core.js",
  "js/01-setup.js", "js/02-boot.js", "js/03-helpers.js", "js/04-views.js", "js/05-collection.js", "js/06-filters.js", "js/07-mutations.js", "js/08-details.js", "js/09-journal.js", "js/10-form.js", "js/11-ocs.js", "js/12-terpenes.js", "js/13-shopping.js", "js/14-insights.js", "js/15-compare.js", "js/15-duel.js", "js/16-import.js", "js/17-backups.js", "js/18-menu.js", "js/19-sync.js", "js/20-start.js", "js/30-research-setup.js", "js/31-research-home.js", "js/32-research-guide.js", "js/33-research-products.js", "js/34-research-deck.js", "js/34-research-terpenes.js", "js/35-research-answer.js", "js/36-research-events.js",
  "manifest.webmanifest", "icon.svg", "fonts/bricolage-grotesque-latin.woff2"];

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

  /* "no-cache" asks the server whether a file changed instead of trusting the
     browser's copy: GitHub Pages lets browsers keep files for 10 minutes. */
  event.respondWith(
    fetch(event.request, { cache: "no-cache" })
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
