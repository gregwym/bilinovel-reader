// @vitest-environment node
import { describe, expect, it } from "vitest";
import { chapterMarkdown, escapeMarkdown } from "../../app/server/backup";
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
