import { describe, expect, it } from "vitest";
import { parseBilinovelDocument, extractReadParams } from "../src/adapters/bilinovel/parser";
import { ParseError } from "../src/adapters/types";
import { ORIGIN, loadFixture, parseHtml } from "./helpers";

const url = (path: string) => new URL(ORIGIN + path);
const texts = (page: { paragraphs: { text?: string }[] }) => page.paragraphs.map((p) => p.text);

describe("normal chapter", () => {
  const page = parseBilinovelDocument(loadFixture("normal-chapter.html"), url("/novel/5369/180210.html"));

  it("extracts ids and titles", () => {
    expect(page.bookId).toBe("5369");
    expect(page.chapterId).toBe("180210");
    expect(page.pageIndex).toBe(0);
    expect(page.bookTitle).toBe("测试轻小说");
    expect(page.chapterTitle).toBe("第十章 普通的一章");
    expect(page.chapterUrl).toBe(`${ORIGIN}/novel/5369/180210.html`);
  });

  it("keeps paragraph order and drops empty paragraphs and ads", () => {
    expect(page.paragraphs).toHaveLength(8);
    expect(page.paragraphs[0].text).toBe("第10章第1页第01段。这是用于测试的正文内容。");
    expect(page.paragraphs[7].text).toBe("第10章第1页第08段。这是用于测试的正文内容。");
    expect(texts(page).join("")).not.toContain("zation");
  });

  it("decodes private-use-area characters and strips zero-width spaces", () => {
    expect(page.paragraphs[2].text).toBe("他就这样走了。");
  });

  it("assigns stable paragraph ids", () => {
    expect(page.paragraphs.map((p) => p.id).slice(0, 2)).toEqual(["180210:0:0", "180210:0:1"]);
  });

  it("classifies the next link as next chapter", () => {
    expect(page.nextType).toBe("next-chapter");
    expect(page.nextUrl).toBe(`${ORIGIN}/novel/5369/180211.html`);
  });
});

describe("paginated chapter", () => {
  const p1 = parseBilinovelDocument(loadFixture("paginated-page-1.html"), url("/novel/5369/180204.html"));
  const p2 = parseBilinovelDocument(loadFixture("paginated-page-2.html"), url("/novel/5369/180204_2.html"));
  const p3 = parseBilinovelDocument(loadFixture("next-chapter.html"), url("/novel/5369/180204_3.html"));

  it("restores the chapterlog.js paragraph shuffle", () => {
    expect(p1.paragraphs).toHaveLength(30);
    expect(texts(p1)).toEqual(
      Array.from({ length: 30 }, (_, i) => `第4章第1页第${String(i + 1).padStart(2, "0")}段。这是用于测试的正文内容。`),
    );
    expect(texts(p2)).toEqual(
      Array.from({ length: 25 }, (_, i) => `第4章第2页第${String(i + 1).padStart(2, "0")}段。这是用于测试的正文内容。`),
    );
  });

  it("drops anti-scrape tags and inline scripts inside the content", () => {
    expect(texts(p1).join("")).not.toContain("反爬虫");
    expect(texts(p1).join("")).not.toContain("var a");
  });

  it("strips the (n/m) suffix so all pages share the chapter title", () => {
    expect(p1.chapterTitle).toBe("第四章 分页的章节");
    expect(p2.chapterTitle).toBe("第四章 分页的章节");
    expect(p3.chapterTitle).toBe("第四章 分页的章节");
  });

  it("detects page indexes", () => {
    expect([p1.pageIndex, p2.pageIndex, p3.pageIndex]).toEqual([0, 1, 2]);
    expect(p2.chapterUrl).toBe(`${ORIGIN}/novel/5369/180204.html`);
  });

  it("classifies next page vs next chapter", () => {
    expect(p1.nextType).toBe("same-chapter-page");
    expect(p1.nextUrl).toBe(`${ORIGIN}/novel/5369/180204_2.html`);
    expect(p2.nextType).toBe("same-chapter-page");
    expect(p2.nextUrl).toBe(`${ORIGIN}/novel/5369/180204_3.html`);
    expect(p3.nextType).toBe("next-chapter");
    expect(p3.nextUrl).toBe(`${ORIGIN}/novel/5369/180205.html`);
  });

  it("does not restore when told the DOM is already in reading order", () => {
    const raw = parseBilinovelDocument(loadFixture("paginated-page-1.html"), url("/novel/5369/180204.html"), {
      shuffle: null,
    });
    expect(texts(raw)).not.toEqual(texts(p1));
    expect(texts(raw).slice(0, 20)).toEqual(texts(p1).slice(0, 20));
  });
});

describe("chapter with images", () => {
  const page = parseBilinovelDocument(loadFixture("chapter-with-images.html"), url("/novel/5369/180205.html"));

  it("keeps images in sequence with paragraphs", () => {
    expect(page.paragraphs.map((p) => (p.imageUrl ? `img:${p.imageUrl.split("/").pop()}` : "text"))).toEqual([
      "img:1.jpg",
      "text",
      "img:2.jpg",
      "text",
      "text",
      "img:3.png",
      "img:b4.jpg",
      "text",
    ]);
  });

  it("prefers data-src over placeholder src and normalises URLs", () => {
    const urls = page.paragraphs.filter((p) => p.imageUrl).map((p) => p.imageUrl);
    expect(urls).toEqual([
      "https://img3.readpai.com/0/5369/180205/1.jpg",
      "https://img3.readpai.com/0/5369/180205/2.jpg",
      "https://img3.readpai.com/0/5369/180205/3.png",
      "https://img3.readpai.com/0/5369/180205/b4.jpg",
    ]);
  });

  it("splits text and image inside one paragraph", () => {
    expect(page.paragraphs[4].text).toBe("插图前的文字");
  });
});

describe("end of volume", () => {
  it("treats a catalog link as the end", () => {
    const page = parseBilinovelDocument(loadFixture("end-of-volume.html"), url("/novel/5369/180299.html"));
    expect(page.chapterTitle).toBe("后记");
    expect(page.nextType).toBe("end");
    expect(page.nextUrl).toBeUndefined();
  });
});

describe("malformed and hostile input", () => {
  it("throws ParseError when the content container is missing", () => {
    const doc = parseHtml("<html><body><h1 id='atitle'>x</h1></body></html>");
    expect(() => parseBilinovelDocument(doc, url("/novel/5369/180204.html"))).toThrow(ParseError);
  });

  it("throws ParseError for non-chapter URLs without ReadParams", () => {
    const doc = parseHtml("<div id='acontent'><p>x</p></div>");
    expect(() => parseBilinovelDocument(doc, url("/novel/5369.html"))).toThrow(ParseError);
  });

  it("throws ParseError when the site served its 'load failed' page", () => {
    const doc = parseHtml(
      "<h1 id='atitle'>t</h1><div id='acontent'><p>內容加載失敗，請重載或更換瀏覽器</p></div>",
    );
    expect(() => parseBilinovelDocument(doc, url("/novel/5369/180204.html"))).toThrow(/load/);
  });

  it("throws ParseError for empty content", () => {
    const doc = parseHtml("<h1 id='atitle'>t</h1><div id='acontent'><p> </p><div class='ad'>ad</div></div>");
    expect(() => parseBilinovelDocument(doc, url("/novel/5369/180204.html"))).toThrow(/empty/);
  });

  it("tolerates unclosed tags and missing navigation", () => {
    const doc = parseHtml("<h1 id='atitle'>标题<div id='acontent'><p>第一段<p>第二段<br>第三行</div>");
    const page = parseBilinovelDocument(doc, url("/novel/5369/180204.html"));
    expect(texts(page)).toEqual(["第一段", "第二段", "第三行"]);
    expect(page.nextType).toBe("end");
  });

  it("falls back to the footer link when ReadParams is absent", () => {
    const doc = parseHtml(
      "<h1 id='atitle'>t</h1><div id='acontent'><p>a</p></div>" +
        "<div id='footlink'><a class='prevlink' href='/novel/5369/1.html'>上一章</a>" +
        "<a class='nextlink' href='/novel/5369/180204_2.html'>下一页</a></div>",
    );
    const page = parseBilinovelDocument(doc, url("/novel/5369/180204.html"));
    expect(page.nextType).toBe("same-chapter-page");
  });

  it("treats javascript: links as no next page", () => {
    const doc = parseHtml(
      "<h1 id='atitle'>t</h1><div id='acontent'><p>a</p></div>" +
        "<div id='footlink'><a class='nextlink' href='javascript:cid(0)'>下一章</a></div>",
    );
    expect(parseBilinovelDocument(doc, url("/novel/5369/180204.html")).nextType).toBe("end");
  });
});

describe("extractReadParams", () => {
  it("parses quoted values including escaped quotes", () => {
    const doc = parseHtml(
      `<script>var ReadParams={url_next:'/novel/1/2.html',articlename:'It\\'s',chapterid:'2',page:1};</script>`,
    );
    expect(extractReadParams(doc)).toMatchObject({
      url_next: "/novel/1/2.html",
      articlename: "It's",
      chapterid: "2",
      page: "1",
    });
  });
});
