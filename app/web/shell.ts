import "./styles.css";
import { h } from "../../src/utils/dom";
import { navigate, route, startRouter } from "./router";
import { icon, type Page } from "./ui";
import { libraryPage } from "./pages/library";
import { bookPage } from "./pages/book";
import { jobsPage } from "./pages/jobs";
import { onSaveChange, saveTasks } from "./offline";
import { settingsPage } from "./pages/settings";
import { loginPage } from "./pages/login";
import { api } from "./api";
import type { JobsOverview } from "../shared/api";

const TABS = [
  { path: "/", label: "书架", icon: "shelf" },
  { path: "/jobs", label: "任务", icon: "jobs" },
  { path: "/settings", label: "设置", icon: "settings" },
] as const;

/** Pages kept per tab (the shelf, a book, …). */
const MAX_STACK = 4;
const TAB_PATHS = "app.tabPaths";
const topPaths: (string | undefined)[] = [];

interface Entry {
  path: string;
  page: Page;
  /** Scroll position when last left. */
  y: number;
  /** Disposed. */
  gone?: boolean;
}

/** The tab a path belongs to: a book is on the shelf's. */
function tabOf(path: string): number {
  const i = TABS.findIndex((t) => t.path !== "/" && path.startsWith(t.path));
  return i >= 0 ? i : 0;
}

/** The library pages: bookshelf, book, jobs and settings under a tab bar. */
export function startShell(): void {
  route("/", libraryPage);
  route("/book/:id", bookPage);
  route("/jobs", jobsPage);
  route("/settings", settingsPage);
  route("/login", loginPage);
  // A book page of the site (`/novel/123.html`) opens the book.
  route("/novel/:file", ({ file }) => bookPage({ id: file.replace(/\.html$/, "") }));

  const main = h("main", { class: "app" });
  const dot = h("span", { class: "dot", hidden: true });
  const tabs = TABS.map((t) =>
    h("a", { href: t.path }, icon(t.icon), h("span", {}, t.label), t.path === "/jobs" ? dot : null),
  );
  const tabbar = h("nav", { class: "tabbar" }, ...tabs);
  document.body.append(main, tabbar);

  /**
   * Each tab keeps its pages, like a native app's tab bar: switching tabs and
   * back returns to the page (and scroll position) left there, and going back
   * within a tab shows the page below as it was. Kept pages that aren't shown
   * don't poll (see `poll`) and catch up when shown again (`resume`).
   */
  const stacks: Entry[][] = TABS.map(() => []);
  let current: Entry | undefined;
  const drop = (e: Entry) => {
    if (e.gone) return;
    e.gone = true;
    e.page.dispose?.();
  };
  /** Paths of the tabs' top pages, kept across reloads (the reader is a separate page load). */
  try {
    const saved = JSON.parse(sessionStorage.getItem(TAB_PATHS) ?? "[]") as unknown;
    if (Array.isArray(saved)) saved.forEach((p, i) => typeof p === "string" && i < TABS.length && (topPaths[i] = p));
  } catch {
    // Storage blocked: tabs open on their first page.
  }
  const saveTops = () => {
    try {
      sessionStorage.setItem(TAB_PATHS, JSON.stringify(topPaths));
    } catch {
      // Private mode.
    }
  };

  startRouter((path, make) => {
    if (current) current.y = window.scrollY;
    const login = path.startsWith("/login");
    const tab = login ? -1 : tabOf(path);
    let entry: Entry | undefined;
    if (login) {
      for (const stack of stacks) stack.splice(0).forEach(drop);
      if (current) drop(current);
      entry = { path, page: make(), y: 0 };
    } else {
      const stack = stacks[tab];
      const at = stack.findIndex((e) => e.path === path);
      // Back to a page of the tab: the ones above it are left. The tab's first page starts it anew.
      stack.splice(at >= 0 ? at + 1 : path === TABS[tab].path ? 0 : stack.length).forEach(drop);
      entry = stack[at];
      if (!entry) {
        entry = { path, page: make(), y: 0 };
        stack.push(entry);
        stack.splice(0, Math.max(0, stack.length - MAX_STACK)).forEach(drop);
      } else if (entry !== current) {
        entry.page.resume?.();
      }
      topPaths[tab] = path;
      saveTops();
    }
    if (current && current !== entry && !stacks.some((s) => s.includes(current!))) drop(current);
    current = entry;
    main.replaceChildren(entry.page.el);
    window.scrollTo(0, entry.y);
    tabbar.hidden = login;
    tabs.forEach((a, i) => a.classList.toggle("active", i === tab));
    document.title = entry.page.title?.() ?? "Bili Reader";
  });

  tabs.forEach((a, i) =>
    a.addEventListener("click", (ev) => {
      if (ev.button !== 0 || ev.metaKey || ev.ctrlKey || ev.shiftKey) return;
      ev.preventDefault();
      const here = current && tabOf(current.path) === i && !location.pathname.startsWith("/login");
      // The tab shown: back to its first page; another tab: where it was left.
      const to = here ? TABS[i].path : (topPaths[i] ?? TABS[i].path);
      if (to === location.pathname) {
        window.scrollTo({ top: 0, behavior: "smooth" });
        return;
      }
      navigate(to);
    }),
  );

  // Active job count on the tab: the server's, and saving on this device.
  let server = api.cached<JobsOverview>("/api/jobs");
  /** One request at a time: a busy server isn't sent more while it is slow to answer. */
  let busy = false;
  const show = () => {
    const blocked = !!server && Object.keys(server.blocked).length > 0;
    const saving = saveTasks().filter((t) => t.status === "queued" || t.status === "running").length;
    const n = (server ? server.counts.running + server.counts.queued : 0) + saving;
    dot.hidden = !n && !blocked;
    dot.textContent = blocked ? "!" : n > 99 ? "99+" : String(n);
  };
  const tick = async () => {
    if (busy || document.hidden || location.pathname.startsWith("/login")) return;
    busy = true;
    server = await api.keep<JobsOverview>("/api/jobs").catch(() => server);
    busy = false;
    show();
  };
  onSaveChange(show);
  void tick();
  setInterval(() => void tick(), 5000);
}
