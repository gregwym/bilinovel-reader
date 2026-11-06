// Service worker of the library web app: makes it installable, opens the app
// also offline or with the server down or slow, and serves chapters saved for
// offline reading (app/web/offline.ts) when the server can't be reached or is
// slow. The API otherwise always goes to the server.
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

/**
 * Keeps every file of the current build (lazy chunks too, e.g. the reader's).
 * The previous build's files stay too: a page opened from the cached
 * index.html while the newer one came (see "navigate" below) may still load
 * its lazy chunks.
 */
async function precache() {
  const res = await fetch("/assets.json", { cache: "no-cache" });
  if (!res.ok) return;
  const files = await res.json();
  const cache = await caches.open(CACHE);
  const list = async (key) => (await (await cache.match(key))?.json().catch(() => undefined)) ?? [];
  let previous = await list("/assets-prev.json");
  const stored = await list("/assets.json");
  if (stored.join() !== files.join()) {
    previous = stored;
    await cache.put("/assets-prev.json", new Response(JSON.stringify(previous)));
    await cache.put("/assets.json", new Response(JSON.stringify(files)));
  }
  const keep = new Set([...files, ...previous]);
  const have = new Set();
  for (const req of await cache.keys()) {
    const path = new URL(req.url).pathname;
    if (!path.startsWith("/assets/")) continue;
    if (keep.has(path)) have.add(path);
    else await cache.delete(req);
  }
  await cache.addAll(files.filter((f) => !have.has(f)));
}

/** How long a request waits for the server when a saved copy can answer instead. */
const PATIENCE = 4000;
/** The same for opening the app (its page is small: a server taking longer is busy or unreachable). */
const SHELL_PATIENCE = 1500;

/** The server's answer; the saved copy when it can't be reached, fails, or is slow to answer. */
async function api(req, url) {
  const copy = saved(url);
  const network = fetch(req).then((res) => {
    // A reverse proxy in front of a stopped server.
    if (res.status >= 502 && res.status <= 504) return copy.then((hit) => hit ?? res);
    if (req.method === "GET" && res.ok && (res.headers.get("content-type") ?? "").includes("json")) void refresh(url, res.clone());
    return res;
  });
  const fallback = network.catch(() => copy.then((hit) => hit ?? Response.error()));
  const hit = await copy;
  if (!hit) return fallback;
  return Promise.race([fallback, new Promise((resolve) => self.setTimeout(() => resolve(hit), PATIENCE))]);
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
    // Every page is the same index.html: the newest one, or the cached one
    // when the server can't be reached, fails (a reverse proxy in front of a
    // stopped server) or is slow to answer, so the app opens like an
    // installed one. The newest is still kept for next time when it comes late.
    const update = fetch(req).then((res) => {
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
    });
    event.waitUntil(update.catch(() => undefined));
    event.respondWith(
      (async () => {
        const hit = await caches.match("/");
        if (!hit) return update.catch(() => Response.error());
        const fresh = update.then((res) => (res.ok ? res : hit)).catch(() => hit);
        return Promise.race([fresh, new Promise((resolve) => self.setTimeout(() => resolve(hit), SHELL_PATIENCE))]);
      })(),
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
