import { describe, expect, it } from "vitest";
import { reconcileCatalog } from "../src/adapters/bilinovel/reconcileCatalog";
import type { Catalog, PageContent } from "../src/adapters/types";

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
