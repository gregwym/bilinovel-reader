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
    const res = await fetch("/api/info", { credentials: "same-origin" });
    const info = (await res.json()) as AppInfo;
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

// Installable as an app (home screen / desktop); see public/sw.js.
if ("serviceWorker" in navigator && import.meta.env.PROD) {
  window.addEventListener("load", () => void navigator.serviceWorker.register("/sw.js").catch(() => undefined));
}
