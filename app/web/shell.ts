import "./styles.css";
import { h } from "../../src/utils/dom";
import { route, startRouter } from "./router";
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

  // Active job count on the tab: the server's, and saving on this device.
  let server: JobsOverview | undefined;
  const show = () => {
    const blocked = !!server && Object.keys(server.blocked).length > 0;
    const saving = saveTasks().filter((t) => t.status === "queued" || t.status === "running").length;
    const n = (server ? server.counts.running + server.counts.queued : 0) + saving;
    dot.hidden = !n && !blocked;
    dot.textContent = blocked ? "!" : n > 99 ? "99+" : String(n);
  };
  const tick = async () => {
    if (document.hidden || location.pathname.startsWith("/login")) return;
    server = await api.get<JobsOverview>("/api/jobs").catch(() => server);
    show();
  };
  onSaveChange(show);
  void tick();
  setInterval(() => void tick(), 5000);
}
