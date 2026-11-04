// @vitest-environment node
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadConfig } from "../../app/server/config";
import { createServices } from "../../app/server/services";
import { createApp } from "../../app/server/http";
import { bookCatalog } from "../../app/server/library";
import { PROGRESS_KEY } from "../../app/server/books";
import type { BookDetail, PageProbe, SiteFailure } from "../../app/shared/api";
import type { Catalog, PageContent } from "../../src/adapters/types";

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
const middle = (s: ReturnType<typeof createServices>) => bookCatalog(s.books.get("10")!)!.volumes[0].chapters[1];
const detailRow = async (app: ReturnType<typeof createApp>) =>
  ((await (await app.request("/api/books/10")).json()) as BookDetail).volumes[0].chapters[1];

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

  it("explains the missing link before, then links it from the previous chapter's last page and the error page's title", async () => {
    const { s, app, snapshot } = setup();
    expect(middle(s).chapterId).toBeUndefined();
    const row = await detailRow(app);
    expect(row.unlinked?.status).toBe("no-evidence");
    expect(row.unlinked?.notes.join()).toContain("前一章 100 的「下一章」→ 321");

    const before = snapshot();
    await app.request("/api/page?book=10&chapter=321&page=0");
    expect(middle(s)).toEqual({ title: "探求知识", chapterId: "321", url: u("321") });
    expect((await detailRow(app)).unlinked).toBeUndefined();
    // Cached pages, audio and the reading position are untouched.
    expect(snapshot()).toEqual(before);
  });

  it("keeps the recovered link through catalog refreshes and restarts, and lets a real upstream link win", async () => {
    const { s, open, app, snapshot } = setup();
    await app.request("/api/page?book=10&chapter=321&page=0");
    const before = snapshot();
    await s.books.refresh("10");
    expect(middle(s).chapterId).toBe("321");
    s.db.run("update books set catalog_at = 0 where id = '10'");
    const fresh = (await (await app.request("/api/catalog/10")).json()) as Catalog;
    expect(fresh.volumes[0].chapters[1].chapterId).toBe("321");
    expect(middle(open()).chapterId).toBe("321");
    expect(snapshot()).toEqual(before);
  });

  it("uses the site's own link once the catalog has one", async () => {
    const { s, app } = setup({ catalog: catalogHtml(`<li><a href="/novel/10/777.html">探求知识</a></li>`) });
    await app.request("/api/page?book=10&chapter=321&page=0");
    await s.books.refresh("10");
    expect(bookCatalog(s.books.get("10")!)!.volumes[0].chapters.map((c) => c.chapterId)).toEqual(["100", "777", "999"]);
  });

  it.each([
    ["the error page shows another title", errorHtml("别的章节")],
    ["the error page's previous chapter is another one", errorHtml("探求知识", "/novel/10/555.html")],
  ])("stays unlinked when %s", async (_, page) => {
    const { s, app, snapshot } = setup({ page });
    const before = snapshot();
    await app.request("/api/page?book=10&chapter=321&page=0");
    expect(middle(s).chapterId).toBeUndefined();
    expect((await detailRow(app)).unlinked?.status).toBe("conflict");
    expect(snapshot()).toEqual(before);
  });

  it("does not store a page the site sent only the start of", async () => {
    const page = errorHtml().replace("<p>內容加載失敗", "<p>在老师告知会举行考试的隔天早上。从这一天起，即将展开考试期间。</p><p>內容加載失敗");
    const { s, app } = setup({ page });
    const res = await app.request("/api/page?book=10&chapter=321&page=0");
    expect(res.status).toBe(503);
    const body = (await res.json()) as { code: string; error: string; partial: number };
    expect(body).toMatchObject({ code: "unavailable" });
    expect(body.error).toContain("只返回了这一章的开头部分");
    expect(body.partial).toBeGreaterThan(20);
    expect(s.db.all("select * from pages where chapter_id = '321'")).toEqual([]);
    const probe = (await (await app.request("/api/site/test-page", { method: "POST", body: JSON.stringify({ url: "/novel/10/321.html" }) })).json()) as PageProbe;
    expect(probe).toMatchObject({ ok: false, kind: "unavailable" });
    expect(probe.partial).toBe(body.partial);
  });

  it("remakes chapter audio made since 0.10.20 unless its complete pages were cached before it", async () => {
    const { s } = setup();
    const profile = s.tts.profileId(s.tts.profile()!);
    const audio = (chapter: string, at: number) =>
      s.db.run("insert or replace into chapter_audio values ('10', ?, ?, ?, 1, 1, ?)", chapter, profile, `书/${chapter}.mp3`, at);
    const now = Date.parse("2026-11-04T05:00:00Z");
    audio("100", now); // pages 0 and 1 cached at t=1, the last one ends the chapter: complete
    audio("999", now); // only the start of the chapter is cached
    s.db.run("insert into pages values ('10', '999', 0, ?, 1)", JSON.stringify({ ...cached[0], chapterId: "999", url: u("999") }));
    audio("321", 5); // made before 0.10.20
    const queued = await s.jobs.repairPartialAudio();
    expect(queued).toEqual(["10/999"]);
    expect(s.library.chapterAudio("10").map((r) => r.chapter_id).sort()).toEqual(["100", "321"]);
    expect(s.db.all("select target from jobs where kind = 'chapter'")).toEqual([{ target: "999" }]);
    // Once only.
    audio("999", now);
    expect(await s.jobs.repairPartialAudio()).toEqual([]);
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
