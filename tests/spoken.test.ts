import { describe, expect, it } from "vitest";
import { spokenText } from "../src/speech/spoken";

describe("spokenText", () => {
  const page = [{ imageUrl: "a.jpg" }, { text: "正文第一段。" }, { text: "第二段。" }];

  it("reads the title before a chapter's first text paragraph", () => {
    expect(spokenText(page, 1, 0, "第一章 开端")).toBe("第一章 开端。正文第一段。");
    expect(spokenText(page, 1, 0, "第一章：")).toBe("第一章：正文第一段。");
  });

  it("leaves other paragraphs, later pages and repeated titles alone", () => {
    expect(spokenText(page, 2, 0, "第一章")).toBe("第二段。");
    expect(spokenText(page, 0, 0, "第一章")).toBeUndefined();
    expect(spokenText(page, 1, 1, "第一章")).toBe("正文第一段。");
    expect(spokenText(page, 1, 0, " ")).toBe("正文第一段。");
    expect(spokenText([{ text: "第一章 开端\n正文" }], 0, 0, "第一章 开端")).toBe("第一章 开端\n正文");
  });
});
