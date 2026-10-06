import { BilinovelAdapter } from "./adapters/bilinovel";
import type { SiteAdapter } from "./adapters/types";
import { EXITED_URL_KEY, Reader } from "./reader/Reader";
import { log } from "./utils/log";

declare global {
  interface Window {
    __biliReader?: Reader | true;
  }
}

const adapters: SiteAdapter[] = [new BilinovelAdapter()];

function readExitedUrl(): string | null {
  try {
    return sessionStorage.getItem(EXITED_URL_KEY);
  } catch {
    return null;
  }
}

/** Shown instead of the reader when the user previously left reader mode on this page. */
function showLauncher(start: () => void): void {
  const host = document.createElement("div");
  host.style.cssText = "all:initial;position:fixed;z-index:2147483647;";
  const shadow = host.attachShadow({ mode: "open" });
  const btn = document.createElement("button");
  btn.textContent = "📖 阅读模式";
  btn.style.cssText =
    "position:fixed;right:calc(14px + env(safe-area-inset-right,0px));bottom:calc(18px + env(safe-area-inset-bottom,0px));" +
    "padding:10px 16px;border:0;border-radius:22px;background:#c2410c;color:#fff;" +
    "font:600 14px -apple-system,'PingFang SC',system-ui,sans-serif;box-shadow:0 4px 16px rgba(0,0,0,.25);";
  btn.addEventListener("click", () => {
    host.remove();
    try {
      sessionStorage.removeItem(EXITED_URL_KEY);
    } catch {
      /* ignore */
    }
    start();
  });
  shadow.append(btn);
  document.documentElement.append(host);
}

function main(): void {
  if (window.top !== window.self || window.__biliReader) return;
  const url = new URL(location.href);
  const adapter = adapters.find((a) => a.canHandle(url));
  if (!adapter) {
    log.debug("not a supported chapter page", url.href);
    return;
  }
  window.__biliReader = true;

  const start = () => {
    const reader = new Reader(adapter, undefined, undefined, __VERSION__);
    window.__biliReader = reader;
    reader.start().catch((err) => log.error("failed to start", err));
  };

  if (readExitedUrl() === location.href) showLauncher(start);
  else start();
}

main();
