import { describe, expect, it, beforeEach } from "vitest";
import { BilinovelAdapter } from "../src/adapters/bilinovel";
import { parseChapterLogScript } from "../src/adapters/bilinovel/deobfuscate";
import { isInvisible, parseBilinovelDocument } from "../src/adapters/bilinovel/parser";
import { FetchError, type FrameHost } from "../src/adapters/types";
import { RequestQueue } from "../src/utils/RequestQueue";
import { ORIGIN, fixture, loadFixture } from "./helpers";

const SCRIPT = fixture("chapterlog-2026-05.js");
const URL_7 = new URL(`${ORIGIN}/novel/5369/180207.html`);
const expected = Array.from(
  { length: 40 },
  (_, i) => `第7章第1页第${String(i + 1).padStart(2, "0")}段。这是用于测试的正文内容。`,
);

/** Loads a fixture into the global jsdom document and runs the site's chapterlog.js on it, like Safari does. */
function renderLikeSite(name: string, chapterid: string): void {
  const html = fixture(name);
  document.documentElement.innerHTML = html.replace(/^[\s\S]*?<html[^>]*>/i, "").replace(/<\/html>\s*$/i, "");
  (globalThis as unknown as { ReadParams: unknown }).ReadParams = { chapterid };
  new Function(SCRIPT)();
}

describe("chapterlog.js (2026-05 version)", () => {
  it("constants are extracted from the real script", () => {
    expect(parseChapterLogScript(SCRIPT)).toEqual({
      fixedLength: 20,
      seedMultiplier: 135,
      seedOffset: 234,
      a: 9302,
      c: 49397,
      mod: 233280,
    });
  });

  it("fetched HTML is restored with the extracted constants", () => {
    const page = parseBilinovelDocument(loadFixture("shuffled-2026-05.html"), URL_7, {
      shuffle: parseChapterLogScript(SCRIPT),
    });
    expect(page.paragraphs.map((p) => p.text)).toEqual(expected);
  });
});

describe("rendered page (site scripts already ran)", () => {
  beforeEach(() => {
    renderLikeSite("shuffled-2026-05.html", "180207");
  });

  it("the site inserts hidden decoy copies of earlier paragraphs", () => {
    const ps = document.querySelectorAll("#acontent > p");
    expect(ps.length).toBe(60); // 40 real + 20 decoys
  });

  it("drops the hidden decoys and keeps the site's restored order", async () => {
    const page = await new BilinovelAdapter().parseRenderedDocument(document, URL_7);
    expect(page.paragraphs.map((p) => p.text)).toEqual(expected);
  });

  it("does not modify the live page", async () => {
    const before = document.getElementById("acontent")!.innerHTML;
    await new BilinovelAdapter().parseRenderedDocument(document, URL_7);
    expect(document.getElementById("acontent")!.innerHTML).toBe(before);
  });
});

const TEMPLATE_2026_05 = { fixedLength: 20, seedMultiplier: 135, seedOffset: 234, a: 9302, c: 49397, mod: 233280 };

function cacheTemplate(): void {
  localStorage.setItem(
    "biliReader.chapterlogTemplate",
    JSON.stringify({ src: `${ORIGIN}/scripts/chapterlog.js?v1006b8-5`, template: TEMPLATE_2026_05 }),
  );
}

type Loader = ConstructorParameters<typeof BilinovelAdapter>[2];
const host: FrameHost = { attach() {}, reveal() {}, detach() {} };
const queue = () => new RequestQueue({ minIntervalMs: 0 });

/**
 * Fake frame loader: a script-less frame gets the server HTML (or a challenge),
 * a scripted frame gets the page after the site's chapterlog.js ran.
 */
function fakeFrames(opts: { staticChallenge?: boolean } = {}) {
  const calls: string[] = [];
  const loader = (async (url: string, _host: FrameHost, o: { scripts?: boolean }) => {
    calls.push(`${o.scripts ? "scripted" : "static"} ${new URL(url).pathname}`);
    if (!o.scripts) {
      if (opts.staticChallenge) throw new FetchError("challenge", url, 403, true);
      const doc = new DOMParser().parseFromString(fixture("shuffled-2026-05.html"), "text/html");
      return { doc, win: window, dispose: () => undefined };
    }
    renderLikeSite("shuffled-2026-05.html", "180207");
    return { doc: document, win: window, dispose: () => undefined };
  }) as unknown as Loader;
  return { loader, calls };
}

describe("page loading through frames", () => {
  beforeEach(() => {
    localStorage.clear();
    cacheTemplate();
  });

  it("loads server HTML in a script-less frame: no decoys can exist, order restored", async () => {
    const { loader, calls } = fakeFrames();
    const page = await new BilinovelAdapter(queue(), host, loader).fetchPage(URL_7.href);
    expect(page.paragraphs.map((p) => p.text)).toEqual(expected);
    expect(calls).toEqual(["static /novel/5369/180207.html"]);
  });

  it("falls back to a scripted frame (rendered, decoys filtered) on a challenge", async () => {
    const { loader, calls } = fakeFrames({ staticChallenge: true });
    const adapter = new BilinovelAdapter(queue(), host, loader);
    const page = await adapter.fetchPage(URL_7.href);
    expect(page.paragraphs.map((p) => p.text)).toEqual(expected);
    expect(calls).toEqual(["static /novel/5369/180207.html", "scripted /novel/5369/180207.html"]);
    expect(adapter.getDiagnostics().some((d) => d.reason === "challenge")).toBe(true);
  });

  it("uses a scripted frame when the shuffle constants are unknown", async () => {
    localStorage.clear();
    const fetchSpy = globalThis.fetch;
    globalThis.fetch = (async () => ({ text: async () => "not a script" }) as Response) as typeof fetch;
    try {
      const { loader, calls } = fakeFrames();
      const page = await new BilinovelAdapter(queue(), host, loader).fetchPage(URL_7.href);
      expect(page.paragraphs.map((p) => p.text)).toEqual(expected);
      expect(calls[1]).toBe("scripted /novel/5369/180207.html");
    } finally {
      globalThis.fetch = fetchSpy;
    }
  });

  it("current page: loads the server HTML and cross-checks it against the rendered page", async () => {
    renderLikeSite("shuffled-2026-05.html", "180207");
    const { loader } = fakeFrames();
    const adapter = new BilinovelAdapter(queue(), host, loader);
    const page = await adapter.loadCurrentPage(document, URL_7);
    expect(page.paragraphs).toHaveLength(40);
    const check = adapter.getDiagnostics().find((d) => d.method === "cross-check");
    expect(check).toMatchObject({ match: true, static: 40, live: 40 });
  });

  it("current page: falls back to the rendered page when loading fails", async () => {
    renderLikeSite("shuffled-2026-05.html", "180207");
    const loader = (async () => {
      throw new FetchError("offline", URL_7.href);
    }) as unknown as Loader;
    const page = await new BilinovelAdapter(queue(), host, loader).loadCurrentPage(document, URL_7);
    expect(page.paragraphs.map((p) => p.text)).toEqual(expected);
  });
});

describe("isInvisible", () => {
  const make = (style: string) => {
    document.body.innerHTML = `<div id="c"><p style="${style}">一段文字</p></div>`;
    return document.querySelector("p")!;
  };
  it.each([
    ["display:none"],
    ["visibility:hidden"],
    ["opacity:0"],
    ["font-size:0"],
    ["color:transparent"],
    ["color:rgba(0, 0, 0, 0)"],
    ["position:absolute;clip:rect(0px, 0px, 0px, 0px)"],
  ])("treats %s as hidden", (style) => {
    expect(isInvisible(make(style), window)).toBe(true);
  });

  it("keeps normal paragraphs", () => {
    expect(isInvisible(make("color:#333;font-size:18px"), window)).toBe(false);
  });
});
