import "./styles.css";
import { h } from "../../src/utils/dom";
import { route, startRouter } from "./router";
import { icon, type Page } from "./ui";
import { libraryPage } from "./pages/library";
import { bookPage } from "./pages/book";
import { jobsPage } from "./pages/jobs";
import { settingsPage } from "./pages/settings";
import { loginPage } from "./pages/login";
import { api } from "./api";
import type { JobsOverview } from "../shared/api";

const TABS = [
  { path: "/", label: "书架", icon: "shelf" },
  { path: "/jobs", label: "任务", icon: "jobs" },
  { path: "/settings", label: "设置", icon: "settings" },
] as const;

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
    h("a", { href: t.path, "data-link": true }, icon(t.icon), h("span", {}, t.label), t.path === "/jobs" ? dot : null),
  );
  const tabbar = h("nav", { class: "tabbar" }, ...tabs);
  document.body.append(main, tabbar);

  let current: Page | undefined;
  startRouter((page, path) => {
    current?.dispose?.();
    current = page;
    main.replaceChildren(page.el);
    window.scrollTo(0, 0);
    const login = path.startsWith("/login");
    tabbar.hidden = login;
    tabs.forEach((a, i) => {
      const p = TABS[i].path;
      a.classList.toggle("active", p === "/" ? path === "/" || path.startsWith("/book/") || path.startsWith("/novel/") : path.startsWith(p));
    });
    if (!path.startsWith("/book/")) document.title = "Bili Reader";
  });

  // Active job count on the tab.
  const tick = async () => {
    if (document.hidden || location.pathname.startsWith("/login")) return;
    const jobs = await api.get<JobsOverview>("/api/jobs").catch(() => undefined);
    if (!jobs) return;
    const n = jobs.counts.running + jobs.counts.queued;
    dot.hidden = !n && !Object.keys(jobs.blocked).length;
    dot.textContent = Object.keys(jobs.blocked).length ? "!" : n > 99 ? "99+" : String(n);
  };
  void tick();
  setInterval(() => void tick(), 5000);
}
