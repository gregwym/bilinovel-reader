// @vitest-environment node
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadConfig } from "../../app/server/config";
import { createServices } from "../../app/server/services";
import { createApp } from "../../app/server/http";
import type { PageProbe, SiteFailure } from "../../app/shared/api";
import { ContentUnavailableError, type PageContent } from "../../src/adapters/types";
import { fixture } from "../helpers";

/**
 * The site as seen on 2026-11-04 (fixtures from book 5370, chapter 288458):
 * www.bilinovel.com redirects to www.bilinovel.net; a chapter page is complete
 * only when the request carries `jieqiSearchTicket`, which `/search.html?
 * search_guard=redeem` sets after `…=css` and `…=js` (each cookie an hour).
 * Like Node's fetch, a cookie does not follow the redirect to the other origin.
 */
const COM = "https://www.bilinovel.com";
const NET = "https://www.bilinovel.net";
const CHAPTER = "/novel/5370/288458.html";
const COMPLETE = fixture("complete-2026-11.html");
const PARTIAL = fixture("incomplete-2026-11.html");
const GUARD_JS = fixture("search-guard-2026-11.js");
const CHAPTER2 = "/novel/5370/288458_2.html";
/** The same page as the chapter's second and last one. */
const lastPage = (html: string) =>
  html.replace("url_next:'/novel/5370/288458_2.html'", "url_next:'/novel/5370/288459.html'").replace("page:'1'", "page:'2'").replace(">下一頁<", ">下一章<");

interface Site {
  /** What redeem does: hand out the ticket (default), nothing, or fail. */
  redeem?: "ticket" | "none" | "error";
  /** Pages stay cut off even with the ticket. */
  alwaysPartial?: boolean;
  /** Pages are complete without the ticket (the site before November 2026). */
  noTicketNeeded?: boolean;
}

function cookiesOf(init?: RequestInit): Record<string, string> {
  const header = (init?.headers as Record<string, string> | undefined)?.Cookie ?? "";
  return Object.fromEntries(header.split("; ").filter(Boolean).map((c) => c.split("=") as [string, string]));
}

function answer(body: string, url: string, headers: [string, string][] = []): Response {
  const res = new Response(body, { headers });
  Object.defineProperty(res, "url", { value: url });
  return res;
}

const addBook = (s: ReturnType<typeof createServices>) => {
  const catalog = { bookId: "5370", volumes: [{ title: "卷", chapters: [{ title: "探求知识", chapterId: "288458", url: `${COM}${CHAPTER}` }] }] };
  s.db.run("insert into books(id,title,catalog,catalog_at,added_at,follow) values(?,?,?,?,?,0)", "5370", "书", JSON.stringify(catalog), 1, 1);
};

const dirs: string[] = [];
const opened: ReturnType<typeof createServices>[] = [];
function setup(site: Site = {}, env: Record<string, string> = {}) {
  const dir = mkdtempSync(join(tmpdir(), "bili-ticket-"));
  dirs.push(dir);
  const config = loadConfig({ DATA_DIR: join(dir, "data"), LIBRARY_DIR: join(dir, "library"), FISH_API_KEY: "fake-key", ...env }, dir);
  const requests: { url: string; cookies: Record<string, string> }[] = [];
  const s = createServices(config, "test", {
    sleep: async (ms) => void vi.advanceTimersByTime(ms),
    fetch: async (url, init) => {
      const cookies = cookiesOf(init);
      requests.push({ url, cookies });
      const u = new URL(url);
      // The cookie went to .com; the redirect to .net drops it.
      const sent = u.origin === NET ? cookies : {};
      if (u.pathname === "/search.html") {
        const step = u.searchParams.get("search_guard");
        if (step === "css") return answer(".search-browser-guard{display:block}", url, [["set-cookie", "jieqiSearchCss=css1; Path=/; Max-Age=3600; HttpOnly"]]);
        if (step === "js") return answer(GUARD_JS, url);
        if (step === "redeem") {
          if (site.redeem === "error") return new Response("", { status: 500 });
          const ok = site.redeem !== "none" && sent.jieqiSearchCss === "css1" && sent.jieqiSearchJs === "100000.test-js-value";
          return answer("", url, ok ? [["set-cookie", "jieqiSearchTicket=t1; Path=/; Max-Age=3600; Secure; HttpOnly"]] : []);
        }
      }
      if (u.pathname.endsWith("chapterlog.js")) return answer(fixture("chapterlog-2026-11.js"), url);
      if (u.pathname === CHAPTER || u.pathname === CHAPTER2) {
        const complete = site.noTicketNeeded || (!site.alwaysPartial && sent.jieqiSearchTicket === "t1");
        const html = complete ? COMPLETE : PARTIAL;
        return answer(u.pathname === CHAPTER ? html : lastPage(html), `${NET}${u.pathname}`);
      }
      return new Response("not found", { status: 404 });
    },
  });
  s.jobs.setPaused(true);
  opened.push(s);
  const pageRequests = () => requests.filter((r) => r.url.endsWith(CHAPTER) || r.url.endsWith(CHAPTER2));
  const guardRequests = () => requests.filter((r) => r.url.includes("search_guard"));
  return { s, app: createApp(s), requests, pageRequests, guardRequests, tick: (ms: number) => void vi.advanceTimersByTime(ms) };
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-11-04T08:00:00Z"));
});

afterEach(() => {
  vi.useRealTimers();
  for (const s of opened.splice(0)) {
    s.jobs.stop();
    s.db.close();
  }
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const textOf = (page: PageContent) => page.paragraphs.map((p) => p.text);
const failures = async (app: ReturnType<typeof createApp>) =>
  ((await (await app.request("/api/site/diagnostics")).json()) as { failures: SiteFailure[] }).failures;

describe("the site's reading ticket", () => {
  it("leaves a complete page alone: one request, no ticket, same result", async () => {
    const { s, pageRequests, guardRequests } = setup({ noTicketNeeded: true });
    const page = await s.source.page("5370", "288458", 0);
    expect(page.incomplete).toBeUndefined();
    expect(page.paragraphs).toHaveLength(123);
    expect(pageRequests().map((r) => r.url)).toEqual([`${COM}${CHAPTER}`]);
    expect(guardRequests()).toEqual([]);
  });

  it("gets the ticket for a cut-off page and keeps the complete page instead", async () => {
    const { s, app, pageRequests, guardRequests } = setup();
    const page = await s.source.page("5370", "288458", 0);
    expect(page.incomplete).toBeUndefined();
    expect(textOf(page)).toHaveLength(123);
    expect(textOf(page).at(-1)).toBe("第122段占位正文，按网站渲染后的顺序编号。");
    // The site's own steps, each with the cookies of the ones before, at the origin that answered.
    expect(guardRequests().map((r) => [new URL(r.url).search.replace(/&r=\d+/, "&r=…"), Object.keys(r.cookies)])).toEqual([
      ["?search_guard=css", []],
      ["?search_guard=js", ["jieqiSearchCss"]],
      ["?search_guard=redeem&r=…", ["jieqiSearchCss", "jieqiSearchJs"]],
    ]);
    expect(guardRequests().every((r) => r.url.startsWith(NET))).toBe(true);
    expect(pageRequests().map((r) => [r.url, r.cookies.jieqiSearchTicket])).toEqual([
      [`${COM}${CHAPTER}`, undefined],
      [`${NET}${CHAPTER}`, "t1"],
    ]);
    // Stored as complete; not a failure; served from the cache from now on.
    expect(s.source.cachedPage("5370", "288458", 0)?.incomplete).toBeUndefined();
    expect(await failures(app)).toEqual([]);
    await s.source.page("5370", "288458", 0);
    expect(pageRequests()).toHaveLength(2);
  });

  it("reuses the ticket it holds: no new guard requests within the hour, new ones after", async () => {
    const { s, pageRequests, guardRequests, tick } = setup();
    await s.source.page("5370", "288458", 0);
    const page = await s.source.page("5370", "288458", 0, true);
    expect(page.incomplete).toBeUndefined();
    expect(guardRequests()).toHaveLength(3);
    expect(pageRequests().slice(2).map((r) => r.url)).toEqual([`${COM}${CHAPTER}`, `${NET}${CHAPTER}`]);
    tick(3600_000);
    expect((await s.source.page("5370", "288458", 0, true)).incomplete).toBeUndefined();
    expect(guardRequests()).toHaveLength(6);
  });

  it("sends the ticket with the first request when the site address needs no redirect", async () => {
    const { s, pageRequests, guardRequests } = setup({}, { SITE_ORIGIN: NET });
    await s.source.page("5370", "288458", 0);
    expect((await s.source.page("5370", "288458", 0, true)).incomplete).toBeUndefined();
    expect(guardRequests()).toHaveLength(3);
    expect(pageRequests().map((r) => [r.url, r.cookies.jieqiSearchTicket])).toEqual([
      [`${NET}${CHAPTER}`, undefined],
      [`${NET}${CHAPTER}`, "t1"],
      [`${NET}${CHAPTER}`, "t1"],
    ]);
  });

  it.each([
    ["hands out no ticket", { redeem: "none" } as Site],
    ["fails", { redeem: "error" } as Site],
    ["still cuts the page off with it", { alwaysPartial: true } as Site],
  ])("keeps what came, marked incomplete, when the site %s", async (_, site) => {
    const { s, app, guardRequests, tick } = setup(site);
    const page = await s.source.page("5370", "288458", 0);
    expect(page.incomplete).toBe(true);
    expect(textOf(page)).toHaveLength(11);
    expect(textOf(page)[10]).toBe("第11段占位正文的开头，网站只发来这一段的前半部分……");
    expect(s.source.cachedPage("5370", "288458", 0)?.incomplete).toBe(true);
    expect((await failures(app))[0]).toMatchObject({ kind: "unavailable", url: `${COM}${CHAPTER}` });
    // Background audio still waits for the whole chapter.
    addBook(s);
    const jobId = s.jobs.enqueueChapter("5370", "288458", "探求知识", "manual");
    s.db.run("update jobs set status = 'running' where id = ?", jobId);
    const jobs = s.jobs as unknown as { runChapter(job: unknown): Promise<void> };
    const err = await jobs.runChapter(s.db.get("select * from jobs where id = ?", jobId)).then(() => undefined, (e: unknown) => e);
    expect(err).toBeInstanceOf(ContentUnavailableError);
    // A failed attempt is not repeated on every page for a while.
    const guards = guardRequests().length;
    expect(guards).toBeGreaterThan(0);
    await s.source.page("5370", "288458", 0);
    expect(guardRequests().length).toBe(guards);
    if (!site.alwaysPartial) {
      tick(10 * 60_000);
      await s.source.page("5370", "288458", 0);
      expect(guardRequests().length).toBeGreaterThan(guards);
    }
  });

  it("replaces an incomplete page cached before, when opened, and then lets audio use it", async () => {
    const { s, pageRequests } = setup();
    const old = { ...(await setup({ redeem: "none" }).s.source.page("5370", "288458", 0)) };
    expect(old.incomplete).toBe(true);
    s.db.run("insert into pages values(?,?,?,?,?)", "5370", "288458", 0, JSON.stringify(old), 1);
    addBook(s);
    const jobId = s.jobs.enqueueChapter("5370", "288458", "探求知识", "manual");
    s.db.run("update jobs set status = 'running' where id = ?", jobId);
    const jobs = s.jobs as unknown as { runChapter(job: unknown): Promise<void> };
    const err = await jobs.runChapter(s.db.get("select * from jobs where id = ?", jobId)).then(() => undefined, (e: unknown) => e);
    // The chapter text is complete now; whatever stops this fake run, it is not the incomplete page.
    expect(err).not.toBeInstanceOf(ContentUnavailableError);
    expect(s.source.cachedPage("5370", "288458", 0)?.incomplete).toBeUndefined();
    expect(s.source.cachedPage("5370", "288458", 0)?.paragraphs).toHaveLength(123);
    expect(s.source.cachedPage("5370", "288458", 1)?.incomplete).toBeUndefined();
    // Page 1 again, with the ticket; page 2 needs no new ticket.
    expect(pageRequests().map((r) => r.url)).toEqual([`${COM}${CHAPTER}`, `${NET}${CHAPTER}`, `${COM}${CHAPTER2}`, `${NET}${CHAPTER2}`]);
  });

  it("tests a chapter page the way it is loaded", async () => {
    const { app } = setup();
    const probe = (await (await app.request("/api/site/test-page", { method: "POST", body: JSON.stringify({ url: CHAPTER }) })).json()) as PageProbe;
    expect(probe).toMatchObject({ ok: true, paragraphs: 123 });
    expect(probe.partial).toBeUndefined();
  });
});
