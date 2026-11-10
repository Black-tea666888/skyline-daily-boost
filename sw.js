// Offline support: serve cached files, refresh them in the background.
const CACHE = "sdb-v36";
const FILES = ["./", "index.html", "firebase-config.js", "sync.js", "manifest.webmanifest", "icon-192.png", "icon.svg", "apple-touch-icon.png", "icon-512.png"];
self.addEventListener("install", e => { e.waitUntil(caches.open(CACHE).then(c => c.addAll(FILES))); self.skipWaiting(); });
self.addEventListener("activate", e => {
  e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k)))));
  self.clients.claim();
});
self.addEventListener("fetch", e => {
  if (e.request.method !== "GET") return;
  if (new URL(e.request.url).origin !== location.origin) return; // weather API etc. go straight to the network
  // pages and scripts: network first so updates show right away; cache only when offline
  const url = new URL(e.request.url);
  if (e.request.mode === "navigate" || /\.(html|js|webmanifest)$/.test(url.pathname) || url.pathname.endsWith("/")) {
    e.respondWith(fetch(e.request, { cache: "no-cache" }).then(res => {
      if (res.ok) { const copy = res.clone(); caches.open(CACHE).then(c => c.put(e.request, copy)); }
      return res;
    }).catch(() => caches.match(e.request).then(hit => hit || caches.match("index.html"))));
    return;
  }
  e.respondWith(caches.match(e.request).then(hit => {
    const net = fetch(e.request).then(res => {
      if (res.ok && new URL(e.request.url).origin === location.origin) {
        const copy = res.clone();
        caches.open(CACHE).then(c => c.put(e.request, copy));
      }
      return res;
    }).catch(() => hit);
    return hit || net;
  }));
});

// tapping a reminder notification opens (or focuses) the site
self.addEventListener("notificationclick", e => {
  e.notification.close();
  e.waitUntil(self.clients.matchAll({ type: "window", includeUncontrolled: true }).then(list => {
    for (const c of list) if ("focus" in c) return c.focus();
    return self.clients.openWindow("./");
  }));
});
