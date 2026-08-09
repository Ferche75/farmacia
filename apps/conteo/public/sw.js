// Service worker mínimo: solo lo necesario para que la PWA sea instalable
// y sobreviva una pérdida de conexión momentánea. El caché real de
// catálogo + cola de escaneos offline (Dexie/IndexedDB) se implementa en
// la Fase 3 — esto NO reemplaza eso.
const CACHE = "conteo-shell-v1";

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.add("/")));
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))
      )
  );
  self.clients.claim();
});

// Network-first con fallback a caché: evita servir versiones viejas
// mientras la app está en desarrollo activo.
self.addEventListener("fetch", (event) => {
  if (event.request.method !== "GET") return;

  event.respondWith(
    fetch(event.request)
      .then((response) => {
        const copy = response.clone();
        caches.open(CACHE).then((cache) => cache.put(event.request, copy));
        return response;
      })
      .catch(() => caches.match(event.request))
  );
});
