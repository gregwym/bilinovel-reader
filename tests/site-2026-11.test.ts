import { describe, expect, it } from "vitest";
import { parseBilinovelDocument } from "../src/adapters/bilinovel/parser";
import { DEFAULT_SHUFFLE_TEMPLATE, parseChapterLogScript } from "../src/adapters/bilinovel/deobfuscate";
import { readGuardScript } from "../app/server/site/client";
import { ORIGIN, fixture, loadFixture, parseHtml } from "./helpers";

/**
 * Book 5370, chapter 288458 page 1 as the site served it on 2026-11-04 (see
 * tests/fixtures/README.md): without the reading ticket only the first 11
 * paragraphs come, the last one cut off and running into the notice; with it,
 * all 122 (shuffled after the 20th by chapterlog.js).
 */
const url = new URL(`${ORIGIN}/novel/5370/288458.html`);
const template = parseChapterLogScript(fixture("chapterlog-2026-11.js"));
const placeholder = (n: number) => `第${n}段占位正文，按网站渲染后的顺序编号。`;

describe("chapter pages since the reading ticket (2026-11)", () => {
  it("reads the shuffle constants from the new obfuscated chapterlog.js (they changed)", () => {
    expect(template).toEqual({ ...DEFAULT_SHUFFLE_TEMPLATE, seedMultiplier: 126, seedOffset: 232 });
  });

  it("restores the complete page to the order the site renders", () => {
    const page = parseBilinovelDocument(loadFixture("complete-2026-11.html"), url, { shuffle: template! });
    expect(page.incomplete).toBeUndefined();
    // As the browser renders it: 122 paragraphs, the section mark 「1」 after the 75th.
    const rendered = Array.from({ length: 122 }, (_, i) => placeholder(i + 1));
    rendered.splice(75, 0, "1");
    expect(page.paragraphs.map((p) => p.text)).toEqual(rendered);
    expect(page).toMatchObject({ chapterTitle: "探求知识", nextType: "same-chapter-page", nextUrl: `${ORIGIN}/novel/5370/288458_2.html` });
  });

  it("keeps all of the cut-off page, its last paragraph without the notice", () => {
    const page = parseBilinovelDocument(loadFixture("incomplete-2026-11.html"), url, { shuffle: template! });
    expect(page.incomplete).toBe(true);
    const texts = page.paragraphs.map((p) => p.text);
    expect(texts).toHaveLength(11);
    expect(texts.slice(0, 10)).toEqual(Array.from({ length: 10 }, (_, i) => placeholder(i + 1)));
    expect(texts[10]).toBe("第11段占位正文的开头，网站只发来这一段的前半部分……");
    expect(texts.join("")).not.toMatch(/加載失敗|瀏覽器/);
    expect(page).toMatchObject({ chapterTitle: "探求知识", nextUrl: `${ORIGIN}/novel/5370/288458_2.html` });
  });

  it("keeps text on both sides of a notice inside a paragraph", () => {
    const doc = parseHtml(`<h1 id='atitle'>t</h1><div id='acontent'><p>前面的正文前面的正文前面的正文。</p>
      <p>这一段的开头（內容加載失敗！請刷新或更換瀏覽器）后面还有字。</p></div>`);
    const page = parseBilinovelDocument(doc, url);
    expect(page.incomplete).toBe(true);
    expect(page.paragraphs.map((p) => p.text)).toEqual(["前面的正文前面的正文前面的正文。", "这一段的开头后面还有字。"]);
  });

  it("reads the guard script without running it", () => {
    expect(readGuardScript(fixture("search-guard-2026-11.js"))).toEqual({
      cookies: { jieqiSearchJs: "100000.test-js-value" },
      maxAge: 3600,
      redeem: "/search.html?search_guard=redeem&r=",
    });
    expect(readGuardScript("nothing here")).toEqual({ cookies: {}, maxAge: undefined, redeem: undefined });
  });
});
