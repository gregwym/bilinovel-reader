import { describe, expect, it } from "vitest";
import { ChapterBuffer } from "../src/reader/ChapterBuffer";
import { parseBilinovelDocument } from "../src/adapters/bilinovel/parser";
import { ORIGIN, loadFixture } from "./helpers";

const parse = (name: string, path: string) => parseBilinovelDocument(loadFixture(name), new URL(ORIGIN + path));

describe("ChapterBuffer", () => {
  const p1 = parse("paginated-page-1.html", "/novel/5369/180204.html");
  const p2 = parse("paginated-page-2.html", "/novel/5369/180204_2.html");
  const p3 = parse("next-chapter.html", "/novel/5369/180204_3.html");
  const c5 = parse("chapter-with-images.html", "/novel/5369/180205.html");

  it("folds site pages of one chapter into a single chapter", () => {
    const b = new ChapterBuffer();
    expect(b.append(p1).kind).toBe("new-chapter");
    expect(b.append(p2).kind).toBe("same-chapter");
    expect(b.append(p3).kind).toBe("same-chapter");
    expect(b.append(c5).kind).toBe("new-chapter");
    expect(b.chapters.map((c) => c.chapterId)).toEqual(["180204", "180205"]);
    expect(b.chapters[0].paragraphs).toHaveLength(30 + 25 + 5);
    expect(b.chapters[0].pageIndexes).toEqual([0, 1, 2]);
    expect(b.chapters[0].title).toBe("第四章 分页的章节");
  });

  it("ignores a page that was already loaded", () => {
    const b = new ChapterBuffer();
    b.append(p1);
    expect(b.append(p1).kind).toBe("duplicate");
  });

  it("walks paragraphs across page and chapter boundaries", () => {
    const b = new ChapterBuffer();
    b.append(p1);
    const last1 = b.chapters[0].paragraphs[29];
    expect(b.next(last1.id)).toBe("pending");
    expect(b.pending).toEqual({ url: `${ORIGIN}/novel/5369/180204_2.html`, type: "same-chapter-page" });

    b.append(p2);
    const n = b.next(last1.id);
    expect(typeof n === "object" && n.id).toBe("180204:1:0");

    b.append(p3);
    b.append(c5);
    const lastOfChapter = b.chapters[0].paragraphs.at(-1)!;
    const firstOfNext = b.next(lastOfChapter.id);
    expect(typeof firstOfNext === "object" && firstOfNext.chapterId).toBe("180205");
    expect(b.prev("180205:0:0")?.id).toBe(lastOfChapter.id);
  });

  it("reports the end when there is no next URL", () => {
    const b = new ChapterBuffer();
    b.append(parse("end-of-volume.html", "/novel/5369/180299.html"));
    const last = b.chapters[0].paragraphs.at(-1)!;
    expect(b.next(last.id)).toBe("end");
    expect(b.atEnd).toBe(true);
  });

  it("finds saved positions and counts remaining paragraphs", () => {
    const b = new ChapterBuffer();
    b.append(p1);
    b.append(p2);
    expect(b.find("180204", 1, 3)?.id).toBe("180204:1:3");
    expect(b.remainingAfter("180204:1:20")).toBe(4);
    expect(b.remainingAfter("180204:0:0")).toBe(54);
  });

  it("drops old chapters from the front", () => {
    const b = new ChapterBuffer();
    b.append(p1);
    b.append(c5);
    const removed = b.dropBefore(1);
    expect(removed.map((c) => c.chapterId)).toEqual(["180204"]);
    expect(b.get("180204:0:0")).toBeUndefined();
    expect(b.first()?.chapterId).toBe("180205");
  });
});
