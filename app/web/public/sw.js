// Service worker of the library web app: makes it installable, opens the app
// shell without a network round trip, and serves chapters saved for offline
// reading (app/web/offline.ts) when the server can't be reached. The API
// otherwise always goes to the server.
const CACHE = "shell-v1";
/** Saved chapters; the name is shared with offline.ts. */
const OFFLINE = "offline-v1";
const SHELL = ["/", "/manifest.webmanifest", "/icon.svg", "/icon-192.png"];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      .then((cache) => cache.addAll(SHELL))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE && k !== OFFLINE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

/** Keeps every file of the current build (lazy chunks too, e.g. the reader's) and drops older builds'. */
async function precache() {
  const res = await fetch("/assets.json", { cache: "no-cache" });
  if (!res.ok) return;
  const files = new Set(await res.json());
  const cache = await caches.open(CACHE);
  const have = new Set();
  for (const req of await cache.keys()) {
    const path = new URL(req.url).pathname;
    if (!path.startsWith("/assets/")) continue;
    if (files.has(path)) have.add(path);
    else await cache.delete(req);
  }
  await cache.addAll([...files].filter((f) => !have.has(f)));
}

/** The server's answer; the saved copy when it can't be reached. */
async function api(req, url) {
  try {
    const res = await fetch(req);
    // A reverse proxy in front of a stopped server.
    if (res.status < 502 || res.status > 504) {
      if (req.method === "GET" && res.ok && (res.headers.get("content-type") ?? "").includes("json")) void refresh(url, res.clone());
      return res;
    }
    return (await saved(url)) ?? res;
  } catch {
    return (await saved(url)) ?? Response.error();
  }
}

/** A saved copy, by URL (a segment asked for with POST is the same file). */
async function saved(url) {
  const cache = await caches.open(OFFLINE);
  return cache.match(url.pathname + url.search);
}

/** Keeps a saved copy (book details, the shelf) up to date while online. */
async function refresh(url, res) {
  const cache = await caches.open(OFFLINE);
  const key = url.pathname + url.search;
  if (await cache.match(key)) await cache.put(key, res);
}

self.addEventListener("fetch", (event) => {
  const req = event.request;
  const url = new URL(req.url);
  if (url.origin !== location.origin) return;
  if (url.pathname.startsWith("/api/")) {
    if (req.method === "GET" || (req.method === "POST" && /^\/api\/segments\/[^/]+\/[^/]+$/.test(url.pathname))) {
      event.respondWith(api(req, url));
    }
    return;
  }
  if (req.method !== "GET") return;
  if (req.mode === "navigate") {
    // Every page is the same index.html: the newest one, or the cached one offline.
    event.respondWith(
      fetch(req)
        .then((res) => {
          if (res.ok) {
            const copy = res.clone();
            event.waitUntil(
              caches
                .open(CACHE)
                .then((cache) => cache.put("/", copy))
                .then(precache)
                .catch(() => undefined),
            );
          }
          return res;
        })
        .catch(() => caches.match("/").then((hit) => hit ?? Response.error())),
    );
    return;
  }
  if (url.pathname.startsWith("/assets/")) {
    // Hashed file names: a cached copy never changes.
    event.respondWith(
      caches.match(req).then(
        (hit) =>
          hit ??
          fetch(req).then((res) => {
            if (res.ok) {
              const copy = res.clone();
              void caches.open(CACHE).then((cache) => cache.put(req, copy));
            }
            return res;
          }),
      ),
    );
  }
});
