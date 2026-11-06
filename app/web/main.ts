import type { AppInfo } from "../shared/api";

/**
 * Entry of the library web app. Chapter paths (`/novel/…`) open the reader,
 * the same one as the userscript; every other path is a library page.
 */

const LAST_ROUTE = "app.lastRoute";

/**
 * Opened from the home screen (a new launch, not a reload): continues on the
 * page the app was left on instead of the shelf.
 */
function resume(): void {
  try {
    const nav = navigator as Navigator & { standalone?: boolean };
    const standalone = matchMedia("(display-mode: standalone)").matches || nav.standalone === true;
    if (!standalone || sessionStorage.getItem("app.launched")) return;
    sessionStorage.setItem("app.launched", "1");
    const last = localStorage.getItem(LAST_ROUTE);
    if (location.pathname === "/" && !location.search && last && last !== "/") history.replaceState(null, "", last);
  } catch {
    // Storage blocked: start on the shelf.
  }
}

/** Keeps the current page (the reader changes the address as it moves on) for resume(). */
function remember(): void {
  if (location.pathname.startsWith("/login")) return;
  try {
    localStorage.setItem(LAST_ROUTE, location.pathname + location.search);
  } catch {
    // Private mode.
  }
}

document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "hidden") remember();
});
window.addEventListener("pagehide", remember);

async function main(): Promise<void> {
  resume();
  if (/^\/novel\/\d+\/\d+(_\d+)?\.html$/.test(location.pathname)) {
    const info = await appInfo();
    if (info.auth && !info.loggedIn) {
      location.href = `/login?next=${encodeURIComponent(location.pathname)}`;
      return;
    }
    const { startReader } = await import("./reader");
    startReader(info.version, info.siteOrigin);
    return;
  }
  const { startShell } = await import("./shell");
  startShell();
}

void main();

const INFO_KEY = "app.info";

/**
 * The server's info for the reader. Offline, or while the server is slow to
 * answer, the last one is used rather than leaving the page blank: the reader
 * opens and reads saved chapters (the service worker serves them).
 */
async function appInfo(): Promise<AppInfo> {
  let last: AppInfo | undefined;
  try {
    last = JSON.parse(localStorage.getItem(INFO_KEY) ?? "null") as AppInfo | undefined;
  } catch {
    // Private mode.
  }
  const fresh = fetch("/api/info", { credentials: "same-origin" }).then(async (res) => {
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const info = (await res.json()) as AppInfo;
    try {
      localStorage.setItem(INFO_KEY, JSON.stringify(info));
    } catch {
      // Private mode.
    }
    return info;
  });
  const fallback: AppInfo = last ?? { version: __VERSION__, auth: false, loggedIn: true, ffmpeg: false, siteOrigin: "https://www.bilinovel.com" };
  const wait = new Promise<AppInfo>((resolve) => setTimeout(() => resolve(fallback), last ? 2500 : 6000));
  return Promise.race([fresh.catch(() => fallback), wait]);
}

/**
 * After the server is updated, a page left open (an installed app on iOS
 * stays in memory for days) still runs the old build, which may not match
 * the server any more: it is reloaded once, when shown again. Not while
 * reading, which would stop the audio.
 */
async function checkVersion(): Promise<void> {
  if (!import.meta.env.PROD || /^\/novel\//.test(location.pathname)) return;
  try {
    const info = (await (await fetch("/api/info", { credentials: "same-origin", cache: "no-store" })).json()) as AppInfo;
    if (!info.version || info.version === __VERSION__ || sessionStorage.getItem(RELOADED) === info.version) return;
    sessionStorage.setItem(RELOADED, info.version);
    // The service worker opens the app from its copy of the page (sw.js): the new one first.
    await refreshShell();
    location.reload();
  } catch {
    // Offline, or private mode: keep the page.
  }
}
const RELOADED = "biliReader.reloadedFor";

/** Puts the server's current index.html in the service worker's cache ("shell-v1" in sw.js). */
async function refreshShell(): Promise<void> {
  try {
    const res = await fetch("/", { cache: "no-store", credentials: "same-origin" });
    if (res.ok && typeof caches !== "undefined") await (await caches.open("shell-v1")).put("/", res);
  } catch {
    // The reload then fetches it.
  }
}
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") void checkVersion();
});
void checkVersion();

// Installable as an app (home screen / desktop); see public/sw.js.
if ("serviceWorker" in navigator && import.meta.env.PROD) {
  window.addEventListener("load", () => void navigator.serviceWorker.register("/sw.js").catch(() => undefined));
}
