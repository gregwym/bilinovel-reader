import { describe, expect, it } from "vitest";
import {
  DEFAULT_SHUFFLE_TEMPLATE,
  evalIntExpression,
  normalizeImageUrl,
  parseChapterLogScript,
  shuffleOrder,
  unshuffle,
} from "../src/adapters/bilinovel/deobfuscate";

describe("shuffle", () => {
  it("is the identity for 20 or fewer paragraphs", () => {
    expect(shuffleOrder(20, 180204, DEFAULT_SHUFFLE_TEMPLATE)).toEqual([...Array(20).keys()]);
  });

  it("is a permutation that keeps the first 20 in place", () => {
    const order = shuffleOrder(50, 180204, DEFAULT_SHUFFLE_TEMPLATE);
    expect([...order].sort((a, b) => a - b)).toEqual([...Array(50).keys()]);
    expect(order.slice(0, 20)).toEqual([...Array(20).keys()]);
    expect(order.slice(20)).not.toEqual([...Array(30).keys()].map((i) => i + 20));
  });

  it("round-trips: unshuffle(scramble(x)) == x", () => {
    const original = [...Array(37).keys()];
    const order = shuffleOrder(original.length, 99, DEFAULT_SHUFFLE_TEMPLATE);
    const scrambled = order.map((o) => original[o]);
    expect(unshuffle(scrambled, 99, DEFAULT_SHUFFLE_TEMPLATE)).toEqual(original);
  });
});

describe("chapterlog.js constant extraction", () => {
  it("reads plain (de-obfuscated) source", () => {
    const js = `
      var chapterId = ReadParams.chapterid;
      function shuffle(array, seed) {
        var len = array.length;
        seed = Number(seed);
        for (var i = len - 1; i > 0; i--) {
          seed = (seed * 9302 + 49397) % 233280;
          var j = Math.floor(seed / 233280 * (i + 1));
        }
      }
      var seed = Number(chapterId) * 127 + 235;
      if (paragraphCount > 20) { shuffle(rest, seed); }
    `;
    expect(parseChapterLogScript(js)).toEqual(DEFAULT_SHUFFLE_TEMPLATE);
  });

  it("reads javascript-obfuscator style source with hex literals", () => {
    const js =
      "var _0x1a=_0x3(_0x4(Number(_0x2b),0x83),0x101),_0x9=[];" +
      "_0x5c=_0xf(_0xe(_0xd(_0x5c,0x2457),0xc0f6),0x38f41);";
    expect(parseChapterLogScript(js)).toEqual({
      fixedLength: 20,
      seedMultiplier: 0x83,
      seedOffset: 0x101,
      a: 0x2457,
      c: 0xc0f6,
      mod: 0x38f41,
    });
  });

  it("returns null for unrelated scripts", () => {
    expect(parseChapterLogScript("console.log('hello');")).toBeNull();
  });

  it("evaluates integer expressions", () => {
    expect(evalIntExpression("0x10 + 2 * (3 - 1)")).toBe(20);
    expect(evalIntExpression("-0x5 ^ 3")).toBe(-5 ^ 3);
    expect(evalIntExpression("1 +")).toBeNull();
  });
});

describe("normalizeImageUrl", () => {
  const base = new URL("https://www.bilinovel.net/novel/1/2.html");
  it("handles protocol-relative, relative and look-alike characters", () => {
    expect(normalizeImageUrl("//img.example.com/a.jpg", base)).toBe("https://img.example.com/a.jpg");
    expect(normalizeImageUrl("/files/a.jpg", base)).toBe("https://www.bilinovel.net/files/a.jpg");
    expect(normalizeImageUrl("https://img.example.com/\u{1D623}.jpg", base)).toBe("https://img.example.com/b.jpg");
    expect(normalizeImageUrl("data:image/gif;base64,AAAA", base)).toBeUndefined();
    expect(normalizeImageUrl("", base)).toBeUndefined();
  });
});
