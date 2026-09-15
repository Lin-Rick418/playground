/* global self, URL, fetch */
import { PrecacheController } from "workbox-precaching";

// One private cache, with revisioned entries removed only when this worker activates.
const precache = new PrecacheController({ cacheName: "casino-pwa-offline" });
// Enforce the cache allowlist after injection so additional build entries
// can never cache normal pages or account data.
precache.addToCacheList(
  self.__WB_MANIFEST.filter((entry) =>
    /^pwa\/offline\.(html|css|js)$/.test(typeof entry === "string" ? entry : entry.url),
  ),
);
self.addEventListener("install", (event) => event.waitUntil(precache.install(event)));
self.addEventListener("activate", (event) => event.waitUntil(precache.activate(event)));

self.addEventListener("fetch", (event) => {
  const { request } = event;
  const url = new URL(request.url);
  if (
    request.method !== "GET" ||
    url.origin !== self.location.origin ||
    url.pathname === "/api" ||
    url.pathname.startsWith("/api/")
  )
    return;

  // Only the offline page and its assets may be served from Cache Storage.
  if (precache.getCacheKeyForURL(url.href)) {
    event.respondWith(precache.matchPrecache(url.href).then((cached) => cached || fetch(request)));
    return;
  }
  if (request.mode === "navigate") {
    event.respondWith(
      fetch(request).catch(async () => {
        const offline = await precache.matchPrecache("/pwa/offline.html");
        if (!offline) throw new Error("Offline page is unavailable");
        return offline;
      }),
    );
  }
});
