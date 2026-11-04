// @vitest-environment node
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadConfig } from "../../app/server/config";
import { createServices } from "../../app/server/services";
import { createApp } from "../../app/server/http";
import { PROGRESS_KEY } from "../../app/server/books";
import type { GenerateResult, PageProbe, SiteFailure } from "../../app/shared/api";
import { ContentUnavailableError, type PageContent } from "../../src/adapters/types";
import { fixture } from "../helpers";

/**
 * The site as seen on 2026-11-04 (fixtures from book 5370, chapter 288458):
 * www.bilinovel.com redirects to www.bilinovel.net, which sends the whole page
 * only with the cookie `night` (set by its darkmode.js in a browser), and
 * otherwise the first 11 paragraphs and 「內容加載失敗！請刷新或更換瀏覽器」.
 */
const COM = "https://www.bilinovel.com";
const NET = "https://www.bilinovel.net";
const CHAPTER = "/novel/5370/288458.html";
const CHAPTER2 = "/novel/5370/288458_2.html";
const COMPLETE = fixture("complete-2026-11.html");
const PARTIAL = fixture("incomplete-2026-11.html");
/** The same page as the chapter's second and last one. */
const lastPage = (html: string) =>
  html.replace("url_next:'/novel/5370/288458_2.html'", "url_next:'/novel/5370/288459.html'").replace("page:'1'", "page:'2'").replace(">下一頁<", ">下一章<");

interface Request {
  url: string;
  cookie?: string;
  redirect?: RequestRedirect;
  body?: string;
}

const dirs: string[] = [];
const opened: ReturnType<typeof createServices>[] = [];
function setup(env: Record<string, string> = {}, site: { elsewhere?: boolean; challenge?: boolean; partial?: boolean } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "bili-night-"));
  dirs.push(dir);
  const config = loadConfig({ DATA_DIR: join(dir, "data"), LIBRARY_DIR: join(dir, "library"), FISH_API_KEY: "fake-key", ...env }, dir);
  const requests: Request[] = [];
  const fetch = async (url: string, init?: RequestInit): Promise<Response> => {
    const res = await answer(url, init);
    const location = res.headers.get("location");
    if (!location || init?.redirect === "manual") return res;
    // Like Node's fetch: follows, and drops the Cookie header when the origin changes.
    const next = new URL(location, url).href;
    const headers = { ...(init?.headers as Record<string, string> | undefined) };
    if (new URL(next).origin !== new URL(url).origin) delete headers.Cookie;
    return fetch(next, { ...init, headers });
  };
  const answer = async (url: string, init?: RequestInit): Promise<Response> => {
      const cookie = (init?.headers as Record<string, string> | undefined)?.Cookie;
      requests.push({ url, cookie, redirect: init?.redirect, body: init?.body as string | undefined });
      const u = new URL(url);
      if (u.pathname === "/v1") {
        const sol = { status: 200, response: COMPLETE, userAgent: "UA", cookies: [{ name: "cf_clearance", value: "solved" }] };
        return new Response(JSON.stringify({ status: "ok", solution: sol }));
      }
      if (u.origin === COM) {
        return new Response(null, { status: 301, headers: { location: site.elsewhere ? `https://elsewhere.example${u.pathname}` : `${NET}${u.pathname}` } });
      }
      if (u.pathname.endsWith("chapterlog.js")) return new Response(fixture("chapterlog-2026-11.js"));
      if (u.pathname === CHAPTER || u.pathname === CHAPTER2) {
        if (site.challenge) return new Response("<title>Just a moment...</title><div id='challenge-form'></div>", { status: 403, headers: { server: "cloudflare" } });
        const html = /(^|; )night=/.test(cookie ?? "") && !site.partial ? COMPLETE : PARTIAL;
        return new Response(u.pathname === CHAPTER ? html : lastPage(html));
      }
      return new Response("not found", { status: 404 });
  };
  const s = createServices(config, "test", { sleep: async () => undefined, fetch });
  s.jobs.setPaused(true);
  opened.push(s);
  const pages = () => requests.filter((r) => r.url.endsWith(CHAPTER) || r.url.endsWith(CHAPTER2));
  return { s, app: createApp(s), requests, pages };
}

const addBook = (s: ReturnType<typeof createServices>, follow = 0) => {
  const catalog = { bookId: "5370", volumes: [{ title: "卷", chapters: [{ title: "探求知识", chapterId: "288458", url: `${COM}${CHAPTER}` }] }] };
  s.db.run("insert into books(id,title,catalog,catalog_at,added_at,follow) values(?,?,?,?,?,?)", "5370", "书", JSON.stringify(catalog), 1, 1, follow);
};
const runJob = async (s: ReturnType<typeof createServices>, partial = false) => {
  const jobId = s.jobs.enqueueChapter("5370", "288458", "探求知识", "manual", partial);
  s.db.run("update jobs set status = 'running' where id = ?", jobId);
  const jobs = s.jobs as unknown as { runChapter(job: unknown): Promise<void> };
  return jobs.runChapter(s.db.get("select * from jobs where id = ?", jobId)).then(() => undefined, (e: unknown) => e);
};
const texts = (p: PageContent) => p.paragraphs.map((x) => x.text);

afterEach(() => {
  for (const s of opened.splice(0)) {
    s.jobs.stop();
    s.db.close();
  }
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("the site's night cookie on the server", () => {
  it("gets the whole page: night goes with the request, also after the redirect to the other origin", async () => {
    const { s, app, pages } = setup();
    const page = await s.source.page("5370", "288458", 0);
    expect(page.incomplete).toBeUndefined();
    expect(texts(page)).toHaveLength(123);
    // One request per hop, as before (fetch followed the redirect itself but dropped the cookie).
    expect(pages().map((r) => [r.url, r.cookie, r.redirect])).toEqual([
      [`${COM}${CHAPTER}`, "night=0", "manual"],
      [`${NET}${CHAPTER}`, "night=0", "manual"],
    ]);
    expect(s.source.cachedPage("5370", "288458", 0)?.incomplete).toBeUndefined();
    expect(((await (await app.request("/api/site/diagnostics")).json()) as { failures: SiteFailure[] }).failures).toEqual([]);
    // Cached: no more requests.
    await s.source.page("5370", "288458", 0);
    expect(pages()).toHaveLength(2);
  });

  it("asks the site directly when the address needs no redirect", async () => {
    const { s, pages } = setup({ SITE_ORIGIN: NET });
    expect((await s.source.page("5370", "288458", 0)).incomplete).toBeUndefined();
    expect(pages().map((r) => [r.url, r.cookie])).toEqual([[`${NET}${CHAPTER}`, "night=0"]]);
  });

  it("keeps the cookie the user set, night included", async () => {
    const { s, pages } = setup({ SITE_COOKIE: "cf_clearance=abc; night=1" });
    await s.source.page("5370", "288458", 0);
    expect(pages().map((r) => r.cookie)).toEqual(["cf_clearance=abc; night=1", "cf_clearance=abc; night=1"]);
  });

  it("sends no cookie to a host that is not the site", async () => {
    const { s, requests } = setup({}, { elsewhere: true });
    await s.source.page("5370", "288458", 0).catch(() => undefined);
    const away = requests.filter((r) => r.url.startsWith("https://elsewhere.example"));
    expect(away.map((r) => new URL(r.url).pathname)).toContain(CHAPTER);
    expect(away.every((r) => r.cookie === undefined)).toBe(true);
  });

  it("gives FlareSolverr's fresh browser the cookie too", async () => {
    const { s, requests } = setup({ FLARESOLVERR_URL: "http://flaresolverr:8191" }, { challenge: true });
    const page = await s.source.page("5370", "288458", 0);
    expect(page.incomplete).toBeUndefined();
    const solve = requests.find((r) => r.url === "http://flaresolverr:8191/v1")!;
    expect(JSON.parse(solve.body!)).toMatchObject({ cmd: "request.get", cookies: [{ name: "night", value: "0" }] });
  });

  it("replaces an incomplete page cached before when it is opened, and audio can use the chapter then", async () => {
    const { s, pages } = setup();
    const old = parseOld();
    s.db.run("insert into pages values(?,?,?,?,?)", "5370", "288458", 0, JSON.stringify(old), 1);
    addBook(s);
    const err = await runJob(s);
    // The text is whole now; whatever stops this fake run, it is not an incomplete page.
    expect(err).not.toBeInstanceOf(ContentUnavailableError);
    expect(s.source.cachedPage("5370", "288458", 0)?.paragraphs).toHaveLength(123);
    expect(s.source.cachedPage("5370", "288458", 1)?.incomplete).toBeUndefined();
    expect(pages().map((r) => r.url)).toEqual([`${COM}${CHAPTER}`, `${NET}${CHAPTER}`, `${COM}${CHAPTER2}`, `${NET}${CHAPTER2}`]);
  });

  it("tests a chapter page the way it is loaded", async () => {
    const { app } = setup();
    const probe = (await (await app.request("/api/site/test-page", { method: "POST", body: JSON.stringify({ url: CHAPTER }) })).json()) as PageProbe;
    expect(probe).toMatchObject({ ok: true, paragraphs: 123 });
    expect(probe.partial).toBeUndefined();
  });
});

describe("chapters known to be incomplete and their audio", () => {
  const cacheOld = (s: ReturnType<typeof createServices>) =>
    s.db.run("insert into pages values(?,?,?,?,?)", "5370", "288458", 0, JSON.stringify(parseOld()), 1);
  const post = (app: ReturnType<typeof createApp>, body: unknown) =>
    Promise.resolve(app.request("/api/books/5370/generate", { method: "POST", body: JSON.stringify(body) })).then((r) => r.json() as Promise<GenerateResult>);
  const jobs = (s: ReturnType<typeof createServices>) => s.db.all<{ target: string; partial: number }>("select target, partial from jobs where status = 'queued'");

  it("are not generated on their own when following the reading position", () => {
    const { s } = setup();
    addBook(s, 1);
    s.db.setKv(PROGRESS_KEY, JSON.stringify({ "5370": { chapterId: "288458", pageIndex: 0, paragraphIndex: 0, updatedAt: 1 } }));
    cacheOld(s);
    expect(s.planner.plan("5370")).toEqual([]);
    expect(jobs(s)).toEqual([]);
    // Once its text is whole (or not cached), it is.
    s.source.forgetChapter("5370", "288458");
    expect(s.planner.plan("5370")).toEqual(["288458"]);
  });

  it("are generated by hand only once the user confirms", async () => {
    const { s, app } = setup();
    addBook(s);
    cacheOld(s);
    expect(await post(app, { chapters: ["288458"] })).toEqual({ queued: 0, incomplete: [{ chapterId: "288458", title: "探求知识" }] });
    expect(jobs(s)).toEqual([]);
    expect(await post(app, { chapters: ["288458"], partial: true })).toEqual({ queued: 1, incomplete: [] });
    expect(jobs(s)).toEqual([{ target: "288458", partial: 1 }]);
  });

  it("are voiced from the text there is once confirmed, and not otherwise", async () => {
    const { s } = setup({}, { partial: true });
    addBook(s);
    expect(await runJob(s)).toBeInstanceOf(ContentUnavailableError);
    s.db.run("update jobs set status = 'cancelled'");
    // Confirmed: past the text (whatever stops this fake run then, it is not the incomplete page).
    expect(await runJob(s, true)).not.toBeInstanceOf(ContentUnavailableError);
    expect(s.source.cachedPage("5370", "288458", 0)?.incomplete).toBe(true);
  });
});

/** What an earlier version kept: the start of the page, marked incomplete. */
function parseOld(): PageContent {
  return {
    bookId: "5370", bookTitle: "书", chapterId: "288458", chapterTitle: "探求知识", pageIndex: 0, url: `${COM}${CHAPTER}`,
    chapterUrl: `${COM}${CHAPTER}`, paragraphs: [{ id: "288458:0:0", text: "开头" }], nextType: "same-chapter-page",
    nextUrl: `${COM}${CHAPTER2}`, incomplete: true,
  };
}
