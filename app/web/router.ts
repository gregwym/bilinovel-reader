import type { Page } from "./ui";

/** Client-side routes of the library pages (the reader is loaded separately). */

type Handler = (params: Record<string, string>) => Page;
const routes: { pattern: RegExp; keys: string[]; handler: Handler }[] = [];
let render: (page: Page, path: string) => void = () => undefined;

export function route(path: string, handler: Handler): void {
  const keys: string[] = [];
  const pattern = new RegExp(
    `^${path.replace(/:(\w+)/g, (_, k: string) => {
      keys.push(k);
      return "([^/]+)";
    })}/?$`,
  );
  routes.push({ pattern, keys, handler });
}

export function resolve(path: string): Page | undefined {
  for (const r of routes) {
    const m = r.pattern.exec(path);
    if (m) return r.handler(Object.fromEntries(r.keys.map((k, i) => [k, decodeURIComponent(m[i + 1])])));
  }
  return undefined;
}

export function navigate(path: string, replace = false): void {
  if (/^\/novel\//.test(path)) {
    location.href = path;
    return;
  }
  if (replace) history.replaceState(null, "", path);
  else history.pushState(null, "", path);
  show();
}

export function show(): void {
  const path = location.pathname;
  const page = resolve(path) ?? resolve("/")!;
  render(page, path);
}

export function startRouter(onRender: (page: Page, path: string) => void): void {
  render = onRender;
  window.addEventListener("popstate", show);
  document.addEventListener("click", (ev) => {
    const a = (ev.target as Element | null)?.closest?.("a[data-link]");
    if (!a || ev.defaultPrevented || ev.button !== 0 || ev.metaKey || ev.ctrlKey || ev.shiftKey) return;
    ev.preventDefault();
    navigate(a.getAttribute("href")!);
  });
  show();
}
