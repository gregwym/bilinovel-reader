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
