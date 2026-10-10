import { describe, expect, it, vi } from "vitest";
import { parseCatalogDocument } from "../src/adapters/bilinovel/catalog";
import { pageCountFromTitle } from "../src/adapters/bilinovel/pagination";
import { parseBilinovelDocument } from "../src/adapters/bilinovel/parser";
import { ChapterBuffer } from "../src/reader/ChapterBuffer";
import { DurableStore, MemoryStore, ProgressStore, mergeProgress } from "../src/reader/ProgressStore";
import { ORIGIN, loadFixture, parseHtml } from "./helpers";

const url = (path: string) => new URL(ORIGIN + path);

describe("catalog", () => {
  const catalog = parseCatalogDocument(loadFixture("catalog.html"), url("/novel/5369/catalog"), "5369");

  it("groups chapters by volume and skips covers and other links", () => {
    expect(catalog.volumes.map((v) => v.title)).toEqual(["第一卷 开始", "第二卷 继续"]);
    expect(catalog.volumes[0].chapters.map((c) => c.title)).toEqual([
      "序章",
      "第一章 只到来",
      "第二章 缺链接",
      "第四章 分页的章节",
    ]);
    expect(catalog.volumes[1].chapters.map((c) => c.chapterId)).toEqual(["180205", "180206"]);
    expect(catalog.volumes[0].chapters[0]).toEqual({
      title: "序章",
      chapterId: "180201",
      url: `${ORIGIN}/novel/5369/180201.html`,
    });
  });

  it("keeps chapters without a link as placeholders", () => {
    expect(catalog.volumes[0].chapters[2]).toEqual({ title: "第二章 缺链接" });
  });

  it("falls back to every chapter link of the book", () => {
    const doc = parseHtml(
      `<body><h2>第一卷</h2><a href="/novel/1/10.html">一</a><a href="/novel/2/11.html">别的书</a>` +
        `<a href="/novel/1/10_2.html">分页</a><h2>第二卷</h2><a href="/novel/1/12.html">二</a></body>`,
    );
    const c = parseCatalogDocument(doc, url("/novel/1/catalog"), "1");
    expect(c.volumes.map((v) => [v.title, v.chapters.map((x) => x.chapterId)])).toEqual([
      ["第一卷", ["10"]],
      ["第二卷", ["12"]],
    ]);
  });

  it("rejects pages without chapters", () => {
    expect(() => parseCatalogDocument(parseHtml("<body><p>Just a moment</p></body>"), url("/novel/1/catalog"), "1")).toThrow();
  });
});

describe("page count and previous link", () => {
  it("reads the page count from the title suffix", () => {
    expect(pageCountFromTitle("第四章 分页的章节（2/3）")).toBe(3);
    expect(pageCountFromTitle("第四章 (1/12)")).toBe(12);
    expect(pageCountFromTitle("第十章 普通的一章")).toBeUndefined();
  });

  it("parses pageCount and prev from chapter pages", () => {
    const p1 = parseBilinovelDocument(loadFixture("paginated-page-1.html"), url("/novel/5369/180204.html"));
    expect(p1.pageCount).toBe(3);
    expect(p1.prev).toEqual({ url: `${ORIGIN}/novel/5369/180203.html`, chapterId: "180203", pageIndex: 0 });
    const p3 = parseBilinovelDocument(loadFixture("next-chapter.html"), url("/novel/5369/180204_3.html"));
    expect(p3.prev).toEqual({ url: `${ORIGIN}/novel/5369/180204_2.html`, chapterId: "180204", pageIndex: 1 });
    const single = parseBilinovelDocument(loadFixture("chapter-with-images.html"), url("/novel/5369/180205.html"));
    expect(single.pageCount).toBe(1);
  });

  it("buffer keeps the chapter's page count and first prev link", () => {
    const b = new ChapterBuffer();
    b.append(parseBilinovelDocument(loadFixture("paginated-page-2.html"), url("/novel/5369/180204_2.html")));
    b.append(parseBilinovelDocument(loadFixture("next-chapter.html"), url("/novel/5369/180204_3.html")));
    const ch = b.chapters[0];
    expect(ch.pageCount).toBe(3);
    expect(ch.pageIndexes).toEqual([1, 2]);
    expect(ch.prev?.pageIndex).toBe(0);
    expect(b.pageParagraphs("180204", 2).map((p) => p.indexInPage)).toEqual(
      Array.from({ length: b.pageParagraphs("180204", 2).length }, (_, i) => i),
    );
    expect(b.pageParagraphs("180204", 0)).toEqual([]);
  });
});

describe("DurableStore", () => {
  const gmStore = () => {
    const data = new Map<string, unknown>();
    return {
      data,
      getValue: async (k: string, d?: unknown) => (data.has(k) ? data.get(k) : d),
      setValue: async (k: string, v: unknown) => void data.set(k, v),
    };
  };

  it("prefers the userscript manager's storage and mirrors writes locally", async () => {
    const gm = gmStore();
    const legacy = new MemoryStore();
    const store = new DurableStore(gm, legacy);
    await store.set("k", "v");
    expect(gm.data.get("k")).toBe("v");
    expect(await legacy.get("k")).toBe("v");
    expect(await store.get("k")).toBe("v");
  });

  it("reads progress saved in localStorage by older versions", async () => {
    const legacy = new MemoryStore();
    await new ProgressStore(legacy).save({ bookId: "1", chapterId: "2", pageIndex: 1, paragraphIndex: 5 });
    const progress = new ProgressStore(new DurableStore(gmStore(), legacy));
    expect((await progress.get("1"))?.paragraphIndex).toBe(5);
  });

  it("save returns the stored record with the snippet", async () => {
    const progress = new ProgressStore(new MemoryStore());
    const rec = await progress.save({ bookId: "1", chapterId: "2", pageIndex: 0, paragraphIndex: 3 }, { snippet: "开头" });
    expect(rec.snippet).toBe("开头");
    expect((await progress.get("1"))?.updatedAt).toBe(rec.updatedAt);
  });

  it("keeps each book's newest record when the two copies disagree", async () => {
    const gm = gmStore();
    const legacy = new MemoryStore();
    // The manager's copy is stale (its write was lost); localStorage has the newer position.
    gm.data.set("biliReader.progress", JSON.stringify({ "1": { chapterId: "c", pageIndex: 0, paragraphIndex: 1, updatedAt: 100 } }));
    await legacy.set(
      "biliReader.progress",
      JSON.stringify({
        "1": { chapterId: "c", pageIndex: 2, paragraphIndex: 7, updatedAt: 200 },
        "2": { chapterId: "x", pageIndex: 0, paragraphIndex: 0, updatedAt: 50 },
      }),
    );
    const progress = new ProgressStore(new DurableStore(gm, legacy, mergeProgress));
    expect((await progress.get("1"))?.paragraphIndex).toBe(7);
    expect((await progress.get("2"))?.chapterId).toBe("x");
  });

  it("writes localStorage even if the manager's storage never answers", async () => {
    vi.useFakeTimers();
    try {
      const legacy = new MemoryStore();
      const hung = { getValue: () => new Promise<unknown>(() => {}), setValue: () => new Promise<void>(() => {}) };
      const store = new DurableStore(hung, legacy, mergeProgress);
      const write = store.set("k", "v");
      await vi.advanceTimersByTimeAsync(3000);
      await write;
      expect(await legacy.get("k")).toBe("v");
      const read = store.get("k");
      await vi.advanceTimersByTimeAsync(3000);
      expect(await read).toBe("v");
    } finally {
      vi.useRealTimers();
    }
  });
});
