// cartalk service worker — network-first, so the app is always up to date when online
// (no hard-refresh needed) and still works offline (cached fallback).
//
// Strategy: every GET tries the network first and refreshes the cache; if the network
// fails (offline), it serves the cached copy. skipWaiting + clients.claim mean a freshly
// deployed version activates immediately; the page then auto-reloads (see app.js).

const CACHE = "cartalk-v4";
const ASSETS = [
  "./", "./index.html", "./style.css", "./app.js",
  "./manifest.webmanifest", "./icon.svg",
  "./lib/dtc.js", "./lib/isotp.js", "./lib/obd2.js", "./lib/sweep.js",
  "./lib/ftdi-webusb.js", "./lib/elm327.js",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE).then((c) => c.addAll(ASSETS)).then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)));
    await self.clients.claim();
  })());
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET" || new URL(req.url).origin !== self.location.origin) return;
  // cache: "reload" bypasses the HTTP cache so a deploy actually reaches the user
  // (plain network-first still served stale browser-cached copies).
  event.respondWith(
    fetch(req, { cache: "reload" })
      .then((res) => {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(req, copy)).catch(() => {});
        return res;
      })
      .catch(() => caches.match(req).then((hit) => hit || caches.match("./index.html")))
  );
});
