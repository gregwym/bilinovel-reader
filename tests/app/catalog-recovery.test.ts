// @vitest-environment node
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadConfig } from "../../app/server/config";
import { createServices } from "../../app/server/services";
import { createApp } from "../../app/server/http";
import { bookCatalog } from "../../app/server/library";
import type { Catalog, PageContent } from "../../src/adapters/types";

const origin = "https://www.bilinovel.com";
const catalogHtml = `<div id="volumes"><h2>卷</h2><ul>
  <li><a href="/novel/10/100.html">前</a></li>
  <li class="jsChapter"><a href="javascript:cid(1)">下次见</a></li>
  <li><a href="/novel/10/999.html">后</a></li></ul></div>`;
const pageHtml = `<script>var ReadParams={articleid:'10',chapterid:'321',articlename:'书',chaptername:'下次见',
  url_previous:'/novel/10/100.html',url_next:'/novel/10/999.html'};</script>
  <div id="acontent"><p>这是可以朗读的正文。</p></div>`;
const catalog = (): Catalog => ({ bookId: "10", volumes: [{ title: "卷", chapters: [
  { title: "前", chapterId: "100" }, { title: "下次见" }, { title: "后", chapterId: "999" },
] }] });
const page: PageContent = { bookId: "10", bookTitle: "书", chapterId: "321", chapterTitle: "下次见", pageIndex: 0,
  url: `${origin}/novel/10/321.html`, chapterUrl: `${origin}/novel/10/321.html`,
  paragraphs: [{ id: "321:0:0", text: "正文" }], nextType: "next-chapter", nextUrl: `${origin}/novel/10/999.html`,
  prev: { url: `${origin}/novel/10/100.html`, chapterId: "100", pageIndex: 0 } };
const dirs: string[] = [];
const opened: ReturnType<typeof createServices>[] = [];
let requests: string[] = [];
function setup() {
  const dir = mkdtempSync(join(tmpdir(), "bili-recovery-"));
  dirs.push(dir);
  const config = loadConfig({ DATA_DIR: join(dir, "data"), LIBRARY_DIR: join(dir, "library"), FISH_API_KEY: "fake-key" }, dir);
  const open = () => {
    const s = createServices(config, "test", { fetch: async (url) => {
      requests.push(url);
      return new Response(url.endsWith("/catalog") ? catalogHtml : pageHtml);
    } });
    opened.push(s);
    return s;
  };
  const s = open();
  s.jobs.setPaused(true);
  s.db.run("insert into books(id,title,catalog,catalog_at,added_at,follow) values(?,?,?,?,?,0)", "10", "书", JSON.stringify(catalog()), 123, 1);
  const cache = () => s.db.run("insert into pages values(?,?,?,?,?)", "10", "321", 0, JSON.stringify(page), 1);
  return { s, open, cache };
}
afterEach(() => {
  for (const s of opened.splice(0)) { s.jobs.stop(); s.db.close(); }
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  requests = [];
});
const recoveredId = (s: ReturnType<typeof createServices>) => bookCatalog(s.books.get("10")!)!.volumes[0].chapters[1].chapterId;

describe("existing library recovery", () => {
  it("repairs on upgrade, preserves fetch age, queues only the missing audio, and survives both refresh routes/restarts", async () => {
    const { s, open, cache } = setup();
    cache();
    const profile = s.tts.profileId(s.tts.profile()!);
    s.library.markSilent("10", "100", profile);
    s.library.markSilent("10", "999", profile);
    // Simulate an existing library reopened by the upgraded binary (no network).
    const upgraded = open();
    expect(recoveredId(upgraded)).toBe("321");
    expect(upgraded.books.get("10")!.catalog_at).toBe(123);
    expect(requests).toEqual([]);
    expect(upgraded.jobs.overview().jobs.map((j) => [j.target, j.status])).toEqual([["321", "queued"]]);
    await upgraded.books.refresh("10");
    expect(recoveredId(upgraded)).toBe("321");
    upgraded.db.run("update books set catalog_at=0 where id='10'");
    const response = await createApp(upgraded).request("/api/catalog/10");
    expect((await response.json() as Catalog).volumes[0].chapters[1].chapterId).toBe("321");
    expect(recoveredId(upgraded)).toBe("321");
    expect(open().jobs.overview().jobs).toHaveLength(1);
    expect(s.library.chapterAudio("10")).toHaveLength(2);
  });
  it("repairs new content automatically without generating an unread volume", async () => {
    const { s } = setup();
    expect(recoveredId(s)).toBeUndefined();
    await s.source.page("10", "321", 0);
    expect(recoveredId(s)).toBe("321");
    expect(s.jobs.overview().jobs).toEqual([]);
  });
  it("leaves unavailable placeholders alone and never guesses an ID", () => {
    const { s, open } = setup();
    expect(recoveredId(open())).toBeUndefined();
    expect(s.jobs.overview().jobs).toEqual([]);
  });
});
