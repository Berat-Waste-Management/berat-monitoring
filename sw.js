// Keeps the portal pages on the phone so it opens without signal.
// Bump the version when pages change, so phones fetch the new copies.
const CACHE = "berat-portal-v1";
const FILES = [
  "./", "index.html", "resident.html", "employee.html", "bcg.html",
  "style.css", "app.js", "manifest.json", "icon-192.png", "icon-512.png",
];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(FILES)));
});

self.addEventListener("activate", (event) => {
  event.waitUntil(caches.keys().then((keys) =>
    Promise.all(keys.filter((key) => key !== CACHE).map((key) => caches.delete(key)))));
});

// Try the network first (fresh pages); fall back to the saved copy when offline
self.addEventListener("fetch", (event) => {
  if (event.request.method !== "GET" || !event.request.url.startsWith(self.location.origin)) return;
  event.respondWith(
    fetch(event.request)
      .then((response) => {
        const copy = response.clone();
        caches.open(CACHE).then((cache) => cache.put(event.request, copy));
        return response;
      })
      .catch(() => caches.match(event.request)),
  );
});
