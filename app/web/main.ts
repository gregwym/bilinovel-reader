import type { AppInfo } from "../shared/api";

/**
 * Entry of the library web app. Chapter paths (`/novel/…`) open the reader,
 * the same one as the userscript; every other path is a library page.
 */

async function main(): Promise<void> {
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
