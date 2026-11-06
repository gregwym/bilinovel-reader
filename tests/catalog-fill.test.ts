import { describe, expect, it } from "vitest";
import { fillPlaceholders } from "../src/adapters/bilinovel/fillPlaceholders";
import type { Catalog, CatalogChapter, PageContent } from "../src/adapters/types";

const url = (id: string, page = 0) => `https://www.bilinovel.com/novel/10/${id}${page ? `_${page + 1}` : ""}.html`;
const ref = (id: string) => ({ url: url(id), chapterId: id, pageIndex: 0 });

/** The site: each chapter's title and its neighbours in reading order. */
function site(order: [id: string, title: string, pages?: number][]) {
  const pages = new Map<string, PageContent>();
  for (const [i, [id, title, n = 1]] of order.entries()) {
    for (let p = 0; p < n; p++) {
      const last = p === n - 1;
      const next = order[i + 1]?.[0];
      pages.set(`${id}:${p}`, {
        bookId: "10", bookTitle: "书", chapterId: id, chapterTitle: title, pageIndex: p, url: url(id, p), chapterUrl: url(id),
        paragraphs: [{ id: `${id}:${p}:0`, text: "正文" }],
        prev: p ? { url: url(id, p - 1), chapterId: id, pageIndex: p - 1 } : order[i - 1] && ref(order[i - 1][0]),
        nextType: !last ? "same-chapter-page" : next ? "next-chapter" : "end",
        nextUrl: !last ? url(id, p + 1) : next && url(next),
        // Like the site: only a single-page chapter says how many pages it has.
        pageCount: n === 1 ? 1 : undefined,
      });
    }
  }
  const loads: string[] = [];
  const load = async (chapterId: string, pageIndex: number) => {
    loads.push(`${chapterId}:${pageIndex}`);
    return pages.get(`${chapterId}:${pageIndex}`);
  };
  return { load, loads, pages };
}

const entry = (title: string, chapterId?: string): CatalogChapter => (chapterId ? { title, chapterId, url: url(chapterId) } : { title });
const ids = (c: Catalog) => c.volumes.map((v) => v.chapters.map((ch) => ch.chapterId ?? "?"));

describe("filling catalog placeholders from chapter navigation", () => {
  it("follows the next chapter's previous link, then checks the page it points at", async () => {
    const { load, loads } = site([["100", "前"], ["321", "下次见"], ["999", "后", 3]]);
    const c: Catalog = { bookId: "10", volumes: [{ title: "卷", chapters: [entry("前", "100"), entry("下次见"), entry("后", "999")] }] };
    const linked = await fillPlaceholders(c, load);
    expect(linked).toEqual([entry("下次见", "321")]);
    expect(ids(c)).toEqual([["100", "321", "999"]]);
    expect(loads).toEqual(["999:0", "321:0"]);
  });

  it("works back through a run of placeholders, across volumes", async () => {
    const { load, loads } = site([["100", "前"], ["301", "插图"], ["302", "序章"], ["999", "后"]]);
    const c: Catalog = { bookId: "10", volumes: [
      { title: "一", chapters: [entry("前", "100")] },
      { title: "二", chapters: [entry("插图"), entry("序章"), entry("后", "999")] },
    ] };
    await fillPlaceholders(c, load);
    expect(ids(c)).toEqual([["100"], ["301", "302", "999"]]);
    expect(loads).toEqual(["999:0", "302:0", "301:0"]);
  });

  it("uses the previous chapter's next link for the book's last entry", async () => {
    const { load } = site([["100", "前"], ["321", "后记"]]);
    const c: Catalog = { bookId: "10", volumes: [{ title: "卷", chapters: [entry("前", "100"), entry("后记")] }] };
    await fillPlaceholders(c, load);
    expect(ids(c)).toEqual([["100", "321"]]);
  });

  it("uses what it already has without loading anything", async () => {
    const { load, loads, pages } = site([["100", "前"], ["321", "下次见"], ["999", "后"]]);
    const c: Catalog = { bookId: "10", volumes: [{ title: "卷", chapters: [entry("前", "100"), entry("下次见"), entry("后", "999")] }] };
    const known = new Map([["999:0", pages.get("999:0")!], ["321:0", pages.get("321:0")!]]);
    await fillPlaceholders(c, load, { pages: known });
    expect(ids(c)).toEqual([["100", "321", "999"]]);
    expect(loads).toEqual([]);
  });

  it("leaves the entry alone when the page it points at is another chapter, and stops", async () => {
    // The site skips the placeholder: 999's previous chapter is 100, already in the catalog.
    const skipped = site([["100", "前"], ["999", "后"]]);
    const c1: Catalog = { bookId: "10", volumes: [{ title: "卷", chapters: [entry("前", "100"), entry("下次见"), entry("后", "999")] }] };
    expect(await fillPlaceholders(c1, skipped.load)).toEqual([]);
    expect(skipped.loads).toEqual(["999:0", "100:0"]);

    // A different title.
    const other = site([["100", "前"], ["321", "番外"], ["999", "后"]]);
    const c2: Catalog = { bookId: "10", volumes: [{ title: "卷", chapters: [entry("前", "100"), entry("下次见"), entry("后", "999")] }] };
    expect(await fillPlaceholders(c2, other.load)).toEqual([]);
    expect(ids(c2)).toEqual([["100", "?", "999"]]);
    expect(other.loads).toEqual(["999:0", "321:0", "100:0"]);
  });

  it("stops when pages can't be loaded, and skips pages that failed before", async () => {
    const loads: string[] = [];
    const c: Catalog = { bookId: "10", volumes: [{ title: "卷", chapters: [entry("前", "100"), entry("下次见"), entry("后", "999")] }] };
    await fillPlaceholders(c, async (id, p) => {
      loads.push(`${id}:${p}`);
      throw new Error("offline");
    }, { tried: new Set(["100:0"]) });
    expect(loads).toEqual(["999:0"]);
    expect(ids(c)).toEqual([["100", "?", "999"]]);
  });
});
