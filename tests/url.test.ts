import { describe, expect, it } from "vitest";
import { buildPageUrl, parseChapterUrl, resolveHref } from "../src/adapters/bilinovel/url";
import { classifyNext, stripPageSuffix } from "../src/adapters/bilinovel/pagination";
import { BilinovelAdapter } from "../src/adapters/bilinovel";

describe("url", () => {
  it("parses chapter and page urls", () => {
    expect(parseChapterUrl("https://www.bilinovel.net/novel/5369/180204.html")).toEqual({
      bookId: "5369",
      chapterId: "180204",
      pageIndex: 0,
    });
    expect(parseChapterUrl("https://www.bilinovel.net/novel/5369/180204_3.html")?.pageIndex).toBe(2);
    expect(parseChapterUrl("https://www.bilinovel.net/novel/5369.html")).toBeNull();
    expect(parseChapterUrl("https://www.bilinovel.net/novel/5369/catalog")).toBeNull();
    expect(parseChapterUrl("https://www.bilinovel.net/novel/5369/vol_1.html")).toBeNull();
  });

  it("builds page urls", () => {
    expect(buildPageUrl("https://x", "1", "2", 0)).toBe("https://x/novel/1/2.html");
    expect(buildPageUrl("https://x", "1", "2", 2)).toBe("https://x/novel/1/2_3.html");
  });

  it("resolves hrefs and rejects javascript links", () => {
    const base = new URL("https://www.bilinovel.net/novel/1/2.html");
    expect(resolveHref("/novel/1/3.html", base)).toBe("https://www.bilinovel.net/novel/1/3.html");
    expect(resolveHref("javascript:void(0)", base)).toBeUndefined();
    expect(resolveHref("", base)).toBeUndefined();
  });

  it("adapter only handles chapter pages on supported hosts", () => {
    const a = new BilinovelAdapter();
    expect(a.canHandle(new URL("https://www.bilinovel.net/novel/5369/180204.html"))).toBe(true);
    expect(a.canHandle(new URL("https://www.bilinovel.net/novel/5369.html"))).toBe(false);
    expect(a.canHandle(new URL("https://example.com/novel/5369/180204.html"))).toBe(false);
  });
});

describe("classifyNext", () => {
  const current = { bookId: "1", chapterId: "100", pageIndex: 0 };
  const u = (p: string) => `https://www.bilinovel.net${p}`;
  it("detects same-chapter pages, next chapters and ends", () => {
    expect(classifyNext({ current, nextUrl: u("/novel/1/100_2.html") }).nextType).toBe("same-chapter-page");
    expect(classifyNext({ current, nextUrl: u("/novel/1/101.html"), linkText: "下一章" }).nextType).toBe("next-chapter");
    expect(classifyNext({ current, nextUrl: u("/novel/1/catalog") }).nextType).toBe("end");
    expect(classifyNext({ current, nextUrl: u("/novel/2/101.html") }).nextType).toBe("end");
    expect(classifyNext({ current, nextUrl: u("/novel/1/101.html"), linkText: "返回目录" }).nextType).toBe("end");
    expect(classifyNext({ current: { ...current, pageIndex: 1 }, nextUrl: u("/novel/1/100.html") }).nextType).toBe("end");
    expect(classifyNext({ current }).nextType).toBe("end");
  });

  it("strips pagination suffixes", () => {
    expect(stripPageSuffix("第一章 开始（2/3）")).toBe("第一章 开始");
    expect(stripPageSuffix("第一章 开始(1/2)")).toBe("第一章 开始");
    expect(stripPageSuffix("第一章 (上)")).toBe("第一章 (上)");
  });
});
