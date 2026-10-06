import { describe, expect, it, beforeEach } from "vitest";
import { BilinovelAdapter } from "../src/adapters/bilinovel";
import { parseChapterLogScript } from "../src/adapters/bilinovel/deobfuscate";
import { parseBilinovelDocument } from "../src/adapters/bilinovel/parser";
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

  it("loadCurrentPage trusts a rendered page that shows decoys (no request)", async () => {
    const queue = new RequestQueue({
      fetchImpl: (() => {
        throw new Error("should not fetch");
      }) as typeof fetch,
    });
    const page = await new BilinovelAdapter(queue).loadCurrentPage(document, URL_7);
    expect(page.paragraphs).toHaveLength(40);
  });

  it("does not modify the live page", async () => {
    const before = document.getElementById("acontent")!.innerHTML;
    await new BilinovelAdapter().parseRenderedDocument(document, URL_7);
    expect(document.getElementById("acontent")!.innerHTML).toBe(before);
  });
});

describe("bot challenge on fetch", () => {
  it("switches to frame loading and stays there", async () => {
    let fetches = 0;
    const queue = new RequestQueue({
      minIntervalMs: 0,
      fetchImpl: (async () => {
        fetches++;
        return { ok: false, status: 403, text: async () => "<title>Just a moment...</title>" } as Response;
      }) as typeof fetch,
    });
    const framed: string[] = [];
    const frameLoader = (async (url: string) => {
      framed.push(url);
      renderLikeSite("shuffled-2026-05.html", "180207");
      return { doc: document, win: window, dispose: () => undefined };
    }) as unknown as ConstructorParameters<typeof BilinovelAdapter>[2];
    const host: FrameHost = { attach() {}, reveal() {}, detach() {} };
    const adapter = new BilinovelAdapter(queue, host, frameLoader);

    const p1 = await adapter.fetchPage(URL_7.href);
    expect(p1.paragraphs.map((p) => p.text)).toEqual(expected);
    await adapter.fetchPage(`${ORIGIN}/novel/5369/180207_2.html`);
    expect(fetches).toBe(1); // second page went straight to the frame
    expect(framed).toHaveLength(2);
  });

  it("surfaces non-challenge fetch errors", async () => {
    const queue = new RequestQueue({
      minIntervalMs: 0,
      maxRetries: 0,
      fetchImpl: (async () => ({ ok: false, status: 404, text: async () => "nope" }) as Response) as typeof fetch,
    });
    await expect(new BilinovelAdapter(queue).fetchPage(URL_7.href)).rejects.toBeInstanceOf(FetchError);
  });
});

describe("loadCurrentPage without evidence of de-obfuscation", () => {
  it("loads the page instead of trusting a scrambled live DOM", async () => {
    // Live DOM still scrambled (site script not run), with a hidden <script> in the content.
    const html = fixture("paginated-page-1.html");
    document.documentElement.innerHTML = html.replace(/^[\s\S]*?<html[^>]*>/i, "").replace(/<\/html>\s*$/i, "");
    let fetched = 0;
    const queue = new RequestQueue({
      minIntervalMs: 0,
      fetchImpl: (async () => (fetched++, { ok: true, status: 200, text: async () => html }) as Response) as typeof fetch,
    });
    const adapter = new BilinovelAdapter(queue);
    // Avoid a network fetch of chapterlog.js: provide the constants through the cache.
    localStorage.setItem(
      "biliReader.chapterlogTemplate",
      JSON.stringify({
        src: `${ORIGIN}/scripts/chapterlog.js?v1006b8-5`,
        template: { fixedLength: 20, seedMultiplier: 127, seedOffset: 235, a: 9302, c: 49397, mod: 233280 },
      }),
    );
    const page = await adapter.loadCurrentPage(document, new URL(`${ORIGIN}/novel/5369/180204.html`));
    expect(fetched).toBe(1);
    expect(page.paragraphs[25].text).toContain("第26段");
  });
});
