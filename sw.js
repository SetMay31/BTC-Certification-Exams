// Service worker for the BTC Certification Exams PWA.
// Caches the app shell + exam data + images so it works fully offline.
// Bump CACHE_VERSION whenever app files change so clients pick up updates.

const CACHE_VERSION = "btc-exams-v9";
const SHELL = [
  "./",
  "./index.html",
  "./styles.css",
  "./app.js",
  "./manifest.json",
  "./data/conservation-specialist.enc",
  "./assets/logo.png",
  "./assets/icon.svg",
  "./assets/app-icon.png",
  "./assets/corals/a.jpg",
  "./assets/corals/b.jpg",
  "./assets/corals/c.jpg",
  "./assets/corals/d.jpg",
  "./assets/corals/e.jpg",
  "./assets/corals/f.jpg",
  "./assets/corals/g.jpg",
  "./assets/corals/h.jpg",
  "./assets/corals/i.jpg",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_VERSION).then((cache) =>
      // Cache what we can; a single missing file must not fail the whole install.
      Promise.allSettled(SHELL.map((url) => cache.add(url)))
    )
  );
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((names) =>
      Promise.all(names.filter((n) => n !== CACHE_VERSION).map((n) => caches.delete(n)))
    )
  );
  self.clients.claim();
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;

  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  event.respondWith(
    caches.match(req).then((cached) => {
      const networkFetch = fetch(req)
        .then((res) => {
          if (res && res.status === 200) {
            const copy = res.clone();
            caches.open(CACHE_VERSION).then((c) => c.put(req, copy));
          }
          return res;
        })
        .catch(() => cached);
      return cached || networkFetch;
    })
  );
});
