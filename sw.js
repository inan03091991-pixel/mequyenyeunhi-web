const CACHE_NAME = "hy-nhi-care-v25";
const APP_SHELL = [
  "./",
  "./index.html",
  "./config.js",
  "./styles.css",
  "./app.js",
  "./db.js",
  "./manifest.webmanifest",
  "./public/og-v2.png",
  "./public/favicon-32-v2.png",
  "./public/apple-touch-icon-180-v2.png",
  "./public/icon-192-v2.png",
  "./public/icon-512-v2.png",
  "./public/icon-maskable-512-v2.png"
];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.addAll(APP_SHELL)));
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key))))
  );
  self.clients.claim();
});

self.addEventListener("fetch", (event) => {
  if (event.request.method !== "GET") return;
  const url = new URL(event.request.url);
  if (url.pathname.includes("/api/")) return;

  event.respondWith(
    caches.match(event.request).then((cached) => {
      const network = fetch(event.request).then((response) => {
        if (response.ok && response.type === "basic") {
          const copy = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(event.request, copy));
        }
        return response;
      }).catch(() => cached || caches.match("./index.html"));
      return cached || network;
    })
  );
});
