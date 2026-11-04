// @vitest-environment node
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadConfig } from "../../app/server/config";
import { createServices } from "../../app/server/services";
import { createApp } from "../../app/server/http";
import { PROGRESS_KEY } from "../../app/server/books";
import type { BookDetail, PageProbe, SiteFailure } from "../../app/shared/api";
import { ContentUnavailableError, type Catalog, type PageContent } from "../../src/adapters/types";

/**
 * Book 5370 as seen on 2026-11-03: 了解对方 (here 100) is cached and has audio,
 * its last page links "next chapter" to 探求知识 (321), whose catalog entry is
 * only `javascript:cid(1)`, and the site answers 321 with HTTP 200 and its
 * "內容加載失敗" page. 山村的勇气 (999) follows.
 */
const origin = "https://www.bilinovel.com";
const u = (id: string) => `${origin}/novel/10/${id}.html`;
const catalogHtml = (middle = `<li class="jsChapter"><a href="javascript:cid(1)">探求知识</a></li>`) => `<div id="volumes"><h2>卷</h2><ul>
  <li><a href="/novel/10/100.html">了解对方</a></li>
  ${middle}
  <li><a href="/novel/10/999.html">山村的勇气</a></li></ul></div>`;
const errorHtml = (title = "探求知识", prev = "/novel/10/100_2.html") => `<script>var ReadParams={url_previous:'${prev}',
  url_next:'/novel/10/999.html',articleid:'10',chapterid:'321',articlename:'书',chaptername:'${title}'};</script>
  <h1 id="atitle">${title}</h1><div id="acontent"><p>內容加載失敗！請刷新或更換瀏覽器</p></div>
  <div id="footlink"><a class="prevlink" href="${prev}">上一章</a><a class="nextlink" href="/novel/10/999.html">下一章</a></div>`;
const cached: PageContent[] = [
  { bookId: "10", bookTitle: "书", chapterId: "100", chapterTitle: "了解对方", pageIndex: 0, url: u("100"), chapterUrl: u("100"),
    paragraphs: [{ id: "100:0:0", text: "第一页" }], nextType: "same-chapter-page", nextUrl: `${origin}/novel/10/100_2.html` },
  { bookId: "10", bookTitle: "书", chapterId: "100", chapterTitle: "了解对方", pageIndex: 1, url: `${origin}/novel/10/100_2.html`,
    chapterUrl: u("100"), paragraphs: [{ id: "100:1:0", text: "最后一页" }], nextType: "next-chapter", nextUrl: u("321"),
    prev: { url: u("100"), chapterId: "100", pageIndex: 0 } },
];

const dirs: string[] = [];
const opened: ReturnType<typeof createServices>[] = [];
function setup(site: { catalog?: string; page?: string } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "bili-unavailable-"));
  dirs.push(dir);
  const config = loadConfig({ DATA_DIR: join(dir, "data"), LIBRARY_DIR: join(dir, "library"), FISH_API_KEY: "fake-key", SITE_REQUEST_INTERVAL_MS: "0" }, dir);
  const requests: string[] = [];
  const open = () => {
    const s = createServices(config, "test", {
      fetch: async (url) => {
        requests.push(url);
        if (url.endsWith("/catalog")) return new Response(site.catalog ?? catalogHtml());
        if (url.includes("/321")) return new Response(site.page ?? errorHtml());
        return new Response("<html></html>");
      },
    });
    s.jobs.setPaused(true);
    opened.push(s);
    return s;
  };
  const s = open();
  const initial: Catalog = { bookId: "10", volumes: [{ title: "卷", chapters: [
    { title: "了解对方", chapterId: "100", url: u("100") }, { title: "探求知识" }, { title: "山村的勇气", chapterId: "999", url: u("999") },
  ] }] };
  s.db.run("insert into books(id,title,catalog,catalog_at,added_at,follow) values(?,?,?,?,?,0)", "10", "书", JSON.stringify(initial), 123, 1);
  for (const p of cached) s.db.run("insert into pages values(?,?,?,?,?)", "10", p.chapterId, p.pageIndex, JSON.stringify(p), 1);
  s.library.markSilent("10", "100", s.tts.profileId(s.tts.profile()!));
  s.db.setKv(PROGRESS_KEY, JSON.stringify({ "10": { chapterId: "100", pageIndex: 1, paragraphId: "100:1:0", updatedAt: 5 } }));
  s.books.reconcile("10");
  const snapshot = () => ({
    pages: s.db.all("select chapter_id, page_index, data, fetched_at from pages order by chapter_id, page_index"),
    audio: s.library.chapterAudio("10"),
    progress: s.db.getKv(PROGRESS_KEY),
  });
  return { s, open, requests, snapshot, app: createApp(s) };
}

afterEach(() => {
  for (const s of opened.splice(0)) {
    s.jobs.stop();
    s.db.close();
  }
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("a chapter the site serves as 'content failed to load'", () => {
  it("is reported as upstream-unavailable (not a Reader failure) and never cached as content", async () => {
    const { s, app } = setup();
    const res = await app.request("/api/page?book=10&chapter=321&page=0");
    expect(res.status).toBe(503);
    const body = (await res.json()) as { code: string; error: string; nav: unknown; excerpt: string };
    expect(body.code).toBe("unavailable");
    expect(body.error).toContain("不是书库服务故障");
    expect(body.excerpt).toContain("內容加載失敗");
    expect(s.source.cachedPage("10", "321", 0)).toBeUndefined();
    // Asking again goes to the site again rather than serving the error page from the cache.
    expect((await app.request("/api/page?book=10&chapter=321&page=0")).status).toBe(503);
    expect(s.db.all("select * from pages where chapter_id = '321'")).toEqual([]);

    const { failures } = (await (await app.request("/api/site/diagnostics")).json()) as { failures: SiteFailure[] };
    expect(failures[0]).toMatchObject({ kind: "unavailable", url: u("321"), nav: { title: "探求知识", prevChapterId: "100" } });
  });

  it("shows a page the site sent only the start of, marked incomplete, asks again when opened, and never voices it", async () => {
    const page = errorHtml().replace("<p>內容加載失敗", "<p>在老师告知会举行考试的隔天早上。从这一天起，即将展开考试期间。</p><p>內容加載失敗");
    const { s, app, requests } = setup({ page });
    const res = await app.request("/api/page?book=10&chapter=321&page=0");
    expect(res.status).toBe(200);
    const got = (await res.json()) as PageContent;
    expect(got.incomplete).toBe(true);
    expect(got.paragraphs.map((p) => p.text)).toEqual(["在老师告知会举行考试的隔天早上。从这一天起，即将展开考试期间。"]);
    // Kept, and asked for again when opened (what was kept stays if that fails).
    expect(s.source.cachedPage("10", "321", 0)?.incomplete).toBe(true);
    const before = requests.filter((r) => r.includes("/321")).length;
    await app.request("/api/page?book=10&chapter=321&page=0");
    expect(requests.filter((r) => r.includes("/321")).length).toBe(before + 1);
    // The book page says so; diagnostics too.
    const row = ((await (await app.request("/api/books/10")).json()) as BookDetail).volumes[0].chapters[1];
    expect(row).toMatchObject({ chapterId: "321", pages: 1, incomplete: true });
    const { failures } = (await (await app.request("/api/site/diagnostics")).json()) as { failures: SiteFailure[] };
    expect(failures[0]).toMatchObject({ kind: "unavailable", url: u("321") });
    expect(failures[0].partial).toBeGreaterThan(20);
    const probe = (await (await app.request("/api/site/test-page", { method: "POST", body: JSON.stringify({ url: "/novel/10/321.html" }) })).json()) as PageProbe;
    expect(probe).toMatchObject({ ok: true, paragraphs: 1 });
    expect(probe.partial).toBeGreaterThan(20);
    // Background audio waits for the whole chapter instead of voicing the start.
    const jobId = s.jobs.enqueueChapter("10", "321", "探求知识", "manual");
    s.db.run("update jobs set status = 'running' where id = ?", jobId);
    const job = s.db.get("select * from jobs where id = ?", jobId);
    const jobs = s.jobs as unknown as { runChapter(job: unknown): Promise<void> };
    const err = await jobs.runChapter(job).then(() => undefined, (e: unknown) => e);
    expect(err).toBeInstanceOf(ContentUnavailableError);
    expect(s.library.chapterAudio("10").map((r) => r.chapter_id)).toEqual(["100"]);
  });

  it("deletes one chapter's cached text or its audio on request, and nothing else", async () => {
    const { s, app } = setup();
    const progress = s.db.getKv(PROGRESS_KEY);
    expect((await (await app.request("/api/books/10/chapters/100/pages", { method: "DELETE" })).json())).toMatchObject({ pages: 2 });
    expect(s.db.all("select * from pages where chapter_id = '100'")).toEqual([]);
    // Its audio and the reading position stay.
    expect(s.library.chapterAudio("10").map((r) => r.chapter_id)).toEqual(["100"]);
    expect(s.db.getKv(PROGRESS_KEY)).toBe(progress);
    await app.request("/api/books/10/audio?chapter=100", { method: "DELETE" });
    expect(s.library.chapterAudio("10")).toEqual([]);
  });

  it("tests a chapter page without storing it", async () => {
    const { s, app } = setup();
    const res = await app.request("/api/site/test-page", { method: "POST", body: JSON.stringify({ url: "/novel/10/321.html" }) });
    const probe = (await res.json()) as PageProbe;
    expect(probe).toMatchObject({ ok: false, kind: "unavailable", nav: { title: "探求知识" } });
    expect(probe.excerpt).toContain("內容加載失敗");
    expect(s.source.cachedPage("10", "321", 0)).toBeUndefined();
    expect((await app.request("/api/site/test-page", { method: "POST", body: "{}" })).status).toBe(400);
  });
});
