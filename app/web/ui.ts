import { h, svg } from "../../src/utils/dom";
import type { BookSummary, ReadingPosition } from "../shared/api";

/** Shared pieces of the library pages. */

export const ICONS = {
  shelf: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 19.5V5a2 2 0 0 1 2-2h3v18H6a2 2 0 0 1-2-1.5Z"/><path d="M9 3h4v18H9"/><path d="m14.5 4.2 3.8-1 3.2 16.5-3.8 1Z"/></svg>`,
  jobs: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12h3l3-8 4 16 3-8h5"/></svg>`,
  settings: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1Z"/></svg>`,
  back: `<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m15 18-6-6 6-6"/></svg>`,
  chevron: `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m9 18 6-6-6-6"/></svg>`,
  plus: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg>`,
  play: `<svg viewBox="0 0 24 24" fill="currentColor"><path d="M8 5.5v13a1 1 0 0 0 1.5.9l10.2-6.5a1 1 0 0 0 0-1.8L9.5 4.6A1 1 0 0 0 8 5.5Z"/></svg>`,
  wave: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M12 4v16M8 8v8M16 8v8M4 11v2M20 11v2"/></svg>`,
  check: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="m8 12 3 3 5-6"/></svg>`,
  stale: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 1 1-3-6.7L21 8"/><path d="M21 3v5h-5"/></svg>`,
  clock: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>`,
  alert: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="9"/><path d="M12 7v6M12 16.5v.5"/></svg>`,
  gen: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M12 8v8M8 12h8"/></svg>`,
  image: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="9" cy="10" r="2"/><path d="m21 16-5-5-9 9"/></svg>`,
  list: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M9 6h11M9 12h11M9 18h11"/><circle cx="4.5" cy="6" r="1" fill="currentColor"/><circle cx="4.5" cy="12" r="1" fill="currentColor"/><circle cx="4.5" cy="18" r="1" fill="currentColor"/></svg>`,
  download: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 4v11M7 10l5 5 5-5M5 20h14"/></svg>`,
  device: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="6" y="2.5" width="12" height="19" rx="2.5"/><path d="M11 18h2"/></svg>`,
  tick: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3.5" stroke-linecap="round" stroke-linejoin="round"><path d="m6 12.5 4 4 8-9"/></svg>`,
  close: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M6 6l12 12M18 6 6 18"/></svg>`,
} as const;

export const icon = (name: keyof typeof ICONS): SVGElement => svg(ICONS[name]);

/** Path of the reader page for a position (`_2` is the second page of a chapter). */
export function readerPath(bookId: string, pos?: Pick<ReadingPosition, "chapterId" | "pageIndex">): string {
  if (!pos) return `/novel/${bookId}.html`;
  const page = pos.pageIndex > 0 ? `_${pos.pageIndex + 1}` : "";
  return `/novel/${bookId}/${pos.chapterId}${page}.html`;
}

/** Opens the reader with a full page load (it is a separate app). */
export function openReader(bookId: string, pos?: Pick<ReadingPosition, "chapterId" | "pageIndex">): void {
  location.href = readerPath(bookId, pos);
}

export function cover(book: Pick<BookSummary, "id" | "title" | "hasCover">, extra?: Node | null): HTMLElement {
  const box = h("div", { class: "cover" });
  if (book.hasCover) {
    const img = h("img", { src: `/api/books/${book.id}/cover`, alt: "", loading: "lazy" });
    img.addEventListener("error", () => img.replaceWith(h("div", { class: "placeholder" }, book.title)));
    box.append(img);
  } else {
    box.append(h("div", { class: "placeholder" }, book.title));
  }
  if (extra) box.append(extra);
  return box;
}

export function progressBar(fraction: number): HTMLElement {
  const bar = h("i");
  bar.style.width = `${Math.max(0, Math.min(1, fraction)) * 100}%`;
  return h("div", { class: "progress" }, bar);
}

let toastTimer: ReturnType<typeof setTimeout> | undefined;
export function toast(message: string): void {
  document.querySelector(".toast")?.remove();
  const el = h("div", { class: "toast", role: "status" }, message);
  document.body.append(el);
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.remove(), 2800);
}

/** Runs an action, showing its error as a toast; disables `button` meanwhile. */
export async function act<T>(button: HTMLButtonElement | null, fn: () => Promise<T>): Promise<T | undefined> {
  if (button) button.disabled = true;
  try {
    return await fn();
  } catch (err) {
    toast(err instanceof Error ? err.message : String(err));
    return undefined;
  } finally {
    if (button) button.disabled = false;
  }
}

export interface MenuItem {
  label: string;
  hint?: string;
  /** A link (a download the browser handles itself). */
  href?: string;
  run?: () => unknown;
  disabled?: boolean;
}

/** Opens a small menu under `button` on click. */
export function menu(button: HTMLButtonElement, items: () => MenuItem[]): void {
  button.setAttribute("aria-haspopup", "menu");
  button.addEventListener("click", (ev) => {
    ev.stopPropagation();
    document.querySelector(".menu")?.remove();
    const close = () => {
      pop.remove();
      document.removeEventListener("click", close);
      document.removeEventListener("keydown", onKey);
      window.removeEventListener("scroll", close, true);
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && close();
    const pop = h(
      "div",
      { class: "menu", role: "menu" },
      ...items().map((it) => {
        const content = [h("span", {}, it.label), it.hint ? h("span", { class: "hint" }, it.hint) : null];
        const el = it.href && !it.disabled
          ? h("a", { role: "menuitem", href: it.href, download: "" }, ...content)
          : h("button", { role: "menuitem", type: "button", disabled: !!it.disabled }, ...content);
        el.addEventListener("click", () => {
          close();
          void it.run?.();
        });
        return el;
      }),
    );
    document.body.append(pop);
    const r = button.getBoundingClientRect();
    const w = pop.offsetWidth;
    pop.style.left = `${Math.max(8, Math.min(r.right - w, window.innerWidth - w - 8))}px`;
    const below = r.bottom + 4;
    pop.style.top = `${below + pop.offsetHeight > window.innerHeight - 8 ? Math.max(8, r.top - pop.offsetHeight - 4) : below}px`;
    document.addEventListener("click", close);
    document.addEventListener("keydown", onKey);
    window.addEventListener("scroll", close, true);
  });
}

/** Downloads a file made on request (slow to make: fetched first, then saved under the server's name). */
export async function download(url: string): Promise<void> {
  let res: Response;
  try {
    res = await fetch(url, { credentials: "same-origin" });
  } catch {
    throw new Error("无法连接服务器");
  }
  if (!res.ok) {
    const data = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(data.error ?? `HTTP ${res.status}`);
  }
  const name = /filename\*=UTF-8''([^;]+)/.exec(res.headers.get("content-disposition") ?? "")?.[1];
  const href = URL.createObjectURL(await res.blob());
  const a = h("a", { href, download: name ? decodeURIComponent(name) : "" });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(href), 60_000);
}

export function switchInput(checked: boolean, onChange: (on: boolean) => void): HTMLElement {
  const input = h("input", { type: "checkbox", role: "switch" });
  input.checked = checked;
  input.addEventListener("change", () => onChange(input.checked));
  return h("label", { class: "switch" }, input, h("span"));
}

export function stepper(value: number, min: number, max: number, onChange: (v: number) => void): HTMLElement {
  let v = value;
  const out = h("output", {}, String(v));
  const set = (n: number) => {
    const next = Math.max(min, Math.min(max, n));
    if (next === v) return;
    v = next;
    out.textContent = String(v);
    onChange(v);
  };
  return h(
    "div",
    { class: "stepper" },
    h("button", { type: "button", "aria-label": "减少", onclick: () => set(v - 1) }, "−"),
    out,
    h("button", { type: "button", "aria-label": "增加", onclick: () => set(v + 1) }, "+"),
  );
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v < 10 ? v.toFixed(1) : Math.round(v)} ${units[i]}`;
}

export function formatDuration(seconds: number): string {
  const s = Math.round(seconds);
  const hh = Math.floor(s / 3600);
  const mm = Math.floor((s % 3600) / 60);
  const ss = s % 60;
  if (hh) return `${hh}:${String(mm).padStart(2, "0")}:${String(ss).padStart(2, "0")}`;
  return `${mm}:${String(ss).padStart(2, "0")}`;
}

export function formatTime(ms: number): string {
  const diff = Date.now() - ms;
  if (diff < 0) {
    const ahead = -diff;
    if (ahead < 3600_000) return `${Math.ceil(ahead / 60_000)} 分钟后`;
    return new Date(ms).toLocaleString("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });
  }
  if (diff < 60_000) return "刚刚";
  if (diff < 3600_000) return `${Math.floor(diff / 60_000)} 分钟前`;
  if (diff < 86400_000) return `${Math.floor(diff / 3600_000)} 小时前`;
  if (diff < 7 * 86400_000) return `${Math.floor(diff / 86400_000)} 天前`;
  return new Date(ms).toLocaleDateString("zh-CN");
}

/** A page re-rendered on an interval while it is shown. */
export interface Page {
  el: HTMLElement;
  /** Called when the page is left. */
  dispose?: () => void;
}

export function poll(fn: () => Promise<void> | void, ms: number): () => void {
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const tick = async () => {
    if (stopped) return;
    if (!document.hidden) await Promise.resolve(fn()).catch(() => undefined);
    if (!stopped) timer = setTimeout(() => void tick(), ms);
  };
  timer = setTimeout(() => void tick(), ms);
  return () => {
    stopped = true;
    clearTimeout(timer);
  };
}

export function topbar(title: string, back?: string, ...right: Node[]): HTMLElement {
  return h(
    "header",
    { class: "topbar" },
    back ? h("a", { class: "back", href: back, "data-link": true }, icon("back"), "返回") : null,
    h("h1", {}, title),
    ...right,
  );
}
