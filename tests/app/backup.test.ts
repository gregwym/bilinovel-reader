// @vitest-environment node
import { describe, expect, it } from "vitest";
import { chapterMarkdown, escapeMarkdown } from "../../app/server/backup";
import { DEFAULT_STORAGE_TEMPLATE, bookTemplate } from "../../app/server/config";
import type { PageContent } from "../../src/adapters/types";

describe("chapter Markdown", () => {
  it("shows the text as written", () => {
    expect(escapeMarkdown("# 不是标题")).toBe("\\# 不是标题");
    expect(escapeMarkdown("1. 不是列表")).toBe("1\\. 不是列表");
    expect(escapeMarkdown("- 不是列表")).toBe("\\- 不是列表");
    expect(escapeMarkdown("*重点* <b> [链接] a_b")).toBe("\\*重点\\* \\<b\\> \\[链接\\] a\\_b");
    expect(escapeMarkdown("「普通的对话。」——是吗")).toBe("「普通的对话。」——是吗");
  });

  it("links illustrations to their files", () => {
    const page = {
      paragraphs: [{ text: " 第一段 " }, { imageUrl: "https://img/1.jpg" }, { text: "" }, { text: "第二段" }],
    } as unknown as PageContent;
    expect(chapterMarkdown("第一章", [page], () => "第一章/01.jpg")).toBe(
      "# 第一章\n\n第一段\n\n![插图](<第一章/01.jpg>)\n\n第二段\n",
    );
  });
});

describe("storage template inside the book's folder", () => {
  it("drops folders that name only the book", () => {
    expect(bookTemplate("{author}/{book}/{volumeNo} {volume}/{chapterNo} {chapter}")).toBe(DEFAULT_STORAGE_TEMPLATE);
    expect(bookTemplate("{book}/{volumeNo}-{chapterNo} {chapter}")).toBe("{volumeNo}-{chapterNo} {chapter}");
    expect(bookTemplate("{author} - {book} ({bookId})/{chapterNo} {chapter}")).toBe("{chapterNo} {chapter}");
  });

  it("keeps the book's name in file names, and falls back without the chapter", () => {
    expect(bookTemplate("{book} - {chapterNo} {chapter}")).toBe("{book} - {chapterNo} {chapter}");
    expect(bookTemplate("{author}/{book}")).toBe(DEFAULT_STORAGE_TEMPLATE);
    expect(bookTemplate("")).toBe(DEFAULT_STORAGE_TEMPLATE);
  });
});
