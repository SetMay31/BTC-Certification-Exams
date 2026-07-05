// Service worker for the BTC Certification Exams PWA.
// Caches the app shell + exam data + images so it works fully offline.
// Bump CACHE_VERSION whenever app files change so clients pick up updates.

const CACHE_VERSION = "btc-exams-v18";
const SHELL = [
  "./",
  "./index.html",
  "./styles.css",
  "./app.js",
  "./manifest.json",
  "./data/conservation-specialist.enc",
  "./data/master-conservationist.enc",
  "./data/scientific-diver.enc",
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
  "./assets/sd/lesions.jpg?v=13",
  "./assets/sd/disease-i.jpg?v=13",
  "./assets/sd/disease-ii.jpg?v=13",
  "./assets/sd/disease-iii.jpg?v=13",
  "./assets/sd/disease-iv.jpg?v=13",
  "./assets/sd/emp-1.jpg?v=13",
  "./assets/sd/emp-2.jpg?v=13",
  "./assets/sd/emp-3.jpg?v=13",
  "./assets/sd/emp-4.jpg?v=13",
  "./assets/sd/emp-5.jpg?v=13",
  "./assets/sd/emp-6.jpg?v=13",
  "./assets/sd/hc-a.jpg?v=13",
  "./assets/sd/hc-b.jpg?v=13",
  "./assets/sd/hc-c.jpg?v=13",
  "./assets/sd/hc-d.jpg?v=13",
  "./assets/sd/hc-e.jpg?v=13",
  "./assets/sd/hc-f.jpg?v=13",
  "./assets/sd/hc-g.jpg?v=13",
  "./assets/sd/hc-h.jpg?v=13",
  "./assets/sd/hc-i.jpg?v=13",
  "./assets/sd/hc-j.jpg?v=13",
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
