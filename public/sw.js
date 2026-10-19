/* AI Agent Studio service worker — offline shell for the PWA. */
const CACHE = "aas-v3";
const SHELL = ["/", "/index.html", "/styles.css", "/app.js", "/manifest.json"];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  // API calls always go to the network.
  if (url.pathname.startsWith("/api/")) return;
  if (e.request.method !== "GET") return;
  const isShell = SHELL.includes(url.pathname);
  e.respondWith(
    (async () => {
      const cache = await caches.open(CACHE);
      if (isShell) {
        // App shell: network-first — always fresh when online, offline fallback.
        try {
          const res = await fetch(e.request);
          if (res && res.ok) cache.put(e.request, res.clone());
          return res;
        } catch {
          return (await cache.match(e.request)) || (await cache.match("/index.html"));
        }
      }
      // Everything else: cache-first.
      const hit = await cache.match(e.request);
      if (hit) return hit;
      try {
        const res = await fetch(e.request);
        if (res && res.ok) cache.put(e.request, res.clone());
        return res;
      } catch {
        return cache.match("/index.html");
      }
    })()
  );
});
