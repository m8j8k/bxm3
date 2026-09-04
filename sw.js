// Emily's Bus - offline shell.
//
//   app shell  : cache-first, revalidated in the background
//   worker API : network-first, cached copy only as a fallback
//
// A cached API response is always older than live. The page never presents
// one as current: it reads `updated` out of the payload and prints the age.

const CACHE = "bxm3-v1";
const SHELL = ["./", "./index.html", "./manifest.json", "./icon.png"];
const API_HOST = "bxm3.max-c2d.workers.dev";

self.addEventListener("install", (e) => {
  e.waitUntil(
    caches.open(CACHE).then((c) =>
      // Individually, so a missing icon.png cannot fail the whole install.
      Promise.allSettled(SHELL.map((u) => c.add(new Request(u, { cache: "reload" }))))
    ).then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return;

  const url = new URL(req.url);

  // Live bus data: always try the network, fall back to the last good copy.
  if (url.hostname === API_HOST) {
    e.respondWith(
      fetch(req)
        .then((res) => {
          if (res && res.ok) {
            const copy = res.clone();
            caches.open(CACHE).then((c) => c.put(req, copy)).catch(() => {});
          }
          return res;
        })
        .catch(() => caches.match(req).then((hit) => hit || Response.error()))
    );
    return;
  }

  // App shell: serve from cache immediately, refresh the copy behind it.
  if (url.origin === self.location.origin) {
    e.respondWith(
      caches.match(req).then((hit) => {
        const net = fetch(req)
          .then((res) => {
            if (res && res.ok) {
              const copy = res.clone();
              caches.open(CACHE).then((c) => c.put(req, copy)).catch(() => {});
            }
            return res;
          })
          .catch(() => hit);
        return hit || net;
      })
    );
  }
});
