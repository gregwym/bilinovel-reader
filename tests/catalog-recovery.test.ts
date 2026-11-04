import { describe, expect, it } from "vitest";
import { reconcileCatalog, reconcileCatalogReport } from "../src/adapters/bilinovel/reconcileCatalog";
import type { Catalog, ChapterNav, PageContent } from "../src/adapters/types";

const url = (id: string, book = "10") => `https://www.bilinovel.com/novel/${book}/${id}.html`;
function catalog(): Catalog {
  return { bookId: "10", volumes: [{ title: "一", chapters: [
    { title: "前", chapterId: "100", url: url("100") }, { title: "下次见" },
    { title: "后", chapterId: "999", url: url("999") },
  ] }] };
}
function page(overrides: Partial<PageContent> = {}): PageContent {
  return { bookId: "10", bookTitle: "书", chapterId: "321", chapterTitle: "下次见", pageIndex: 0,
    url: url("321"), chapterUrl: url("321"), paragraphs: [{ id: "p", text: "正文" }],
    prev: { url: url("100"), chapterId: "100", pageIndex: 0 }, nextType: "next-chapter", nextUrl: url("999"), ...overrides };
}

describe("catalog placeholder recovery", () => {
  it("uses content and navigation, not numeric gaps; is idempotent", () => {
    const c = catalog();
    expect(reconcileCatalog(c, [page()])).toEqual([{ title: "下次见", chapterId: "321", url: url("321") }]);
    expect(reconcileCatalog(c, [page()])).toEqual([]);
    expect(c.volumes[0].chapters.map((ch) => ch.chapterId)).toEqual(["100", "321", "999"]);
  });
  it("can use the following chapter's previous link when the candidate has no previous link", () => {
    const c = catalog();
    expect(reconcileCatalog(c, [page({ prev: undefined }), page({ chapterId: "999", url: url("999"), chapterTitle: "后",
      prev: { url: url("321"), chapterId: "321", pageIndex: 0 } })])).toHaveLength(1);
  });
  it.each([
    { chapterTitle: "另一个标题" }, { bookId: "20" }, { url: url("321", "20") },
    { url: url("444") }, { pageIndex: 1 }, { paragraphs: [] }, { prev: undefined, nextType: "same-chapter-page" },
    { prev: { url: url("555"), chapterId: "555", pageIndex: 0 } },
    { nextUrl: url("555") },
  ] satisfies Partial<PageContent>[])("leaves unverified candidates unresolved: %j", (overrides) => {
    expect(reconcileCatalog(catalog(), [page(overrides)])).toEqual([]);
  });
  it("rejects contradictory neighboring evidence and ambiguous same-title pages", () => {
    expect(reconcileCatalog(catalog(), [page(), page({ chapterId: "999", url: url("999"), chapterTitle: "后",
      prev: { url: url("555"), chapterId: "555", pageIndex: 0 } })])).toEqual([]);
    expect(reconcileCatalog(catalog(), [page(), page({ chapterId: "444", url: url("444") })])).toEqual([]);
  });
  it("does not confuse repeated titles in different volumes", () => {
    const c = catalog();
    c.volumes.push({ title: "二", chapters: [{ title: "前", chapterId: "500" }, { title: "下次见" }] });
    expect(reconcileCatalog(c, [page()])).toHaveLength(1);
    expect(c.volumes[1].chapters[1].chapterId).toBeUndefined();
  });
});

describe("catalog placeholder recovery from neighbouring chapters", () => {
  // 了解对方 (100, 2 pages) → 探求知识 (placeholder) → 山村的勇气 (999), as in book 5370.
  const before = (next = "321"): PageContent => page({ chapterId: "100", chapterTitle: "前", pageIndex: 1,
    url: "https://www.bilinovel.com/novel/10/100_2.html", prev: { url: url("100"), chapterId: "100", pageIndex: 0 },
    nextType: "next-chapter", nextUrl: url(next) });
  const after = (prev = "321"): PageContent => page({ chapterId: "999", chapterTitle: "后", url: url("999"),
    prev: { url: url(prev), chapterId: prev, pageIndex: 0 }, nextType: "end", nextUrl: undefined });
  const errorNav = (o: Partial<ChapterNav> = {}): ChapterNav =>
    ({ bookId: "10", chapterId: "321", title: "下次见", prevChapterId: "100", nextChapterId: "999", ...o });
  const status = (c: Catalog, pages: PageContent[], navs: ChapterNav[] = []) => reconcileCatalogReport(c, pages, navs).report[0];

  it("links when both neighbours point at the same chapter, without that chapter's page", () => {
    const c = catalog();
    expect(status(c, [before(), after()])).toMatchObject({ status: "recovered", chapterId: "321" });
    expect(c.volumes[0].chapters[1]).toEqual({ title: "下次见", chapterId: "321", url: url("321") });
  });

  it("links from the previous chapter's last page plus the title the error page still showed", () => {
    const c = catalog();
    expect(status(c, [before()], [errorNav({ nextChapterId: undefined })])).toMatchObject({ status: "recovered", chapterId: "321" });
  });

  it("does not trust a single link: the catalog may skip a chapter", () => {
    for (const pages of [[before()], [after()]]) {
      const c = catalog();
      const r = status(c, pages);
      expect(r.status).toBe("no-evidence");
      expect(r.notes.join()).toContain("单向导航");
      expect(c.volumes[0].chapters[1].chapterId).toBeUndefined();
    }
  });

  it.each([
    ["neighbours disagree", [before("321"), after("322")], []],
    ["previous chapter skips the placeholder", [before("999")], [errorNav()]],
    ["error page has another title", [before()], [errorNav({ title: "别的章节" })]],
    ["error page links elsewhere", [before()], [errorNav({ prevChapterId: "555" })]],
    ["previous chapter's pages disagree", [before("321"), { ...before("322"), pageIndex: 2, url: "https://www.bilinovel.com/novel/10/100_3.html" }], [errorNav()]],
  ] as [string, PageContent[], ChapterNav[]][])("leaves it unlinked when evidence conflicts: %s", (_, pages, navs) => {
    const c = catalog();
    const r = status(c, pages, navs);
    expect(["conflict", "ambiguous"]).toContain(r.status);
    expect(c.volumes[0].chapters[1].chapterId).toBeUndefined();
  });

  it("never reads cid() or interpolates ID gaps", () => {
    const c = catalog();
    c.volumes[0].chapters[2].chapterId = "101";
    expect(reconcileCatalog(c, [])).toEqual([]);
    expect(c.volumes[0].chapters[1].chapterId).toBeUndefined();
  });

  it("recovers consecutive placeholders one after another when each step is proven", () => {
    const c: Catalog = { bookId: "10", volumes: [{ title: "一", chapters: [
      { title: "前", chapterId: "100", url: url("100") }, { title: "甲" }, { title: "乙" }, { title: "后", chapterId: "999", url: url("999") },
    ] }] };
    const navs: ChapterNav[] = [
      { bookId: "10", chapterId: "201", title: "甲", prevChapterId: "100", nextChapterId: "202" },
      { bookId: "10", chapterId: "202", title: "乙", prevChapterId: "201", nextChapterId: "999" },
    ];
    expect(reconcileCatalog(c, [], navs).map((ch) => ch.chapterId)).toEqual(["201", "202"]);
  });
});
