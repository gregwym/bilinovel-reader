import { describe, expect, it } from "vitest";
import { ReaderView, type ViewCallbacks } from "../src/ui/ReaderView";
import { DEFAULT_SETTINGS } from "../src/reader/ProgressStore";

describe("table of contents", () => {
  it("shows each volume's cover next to its title", () => {
    (globalThis as { IntersectionObserver?: unknown }).IntersectionObserver ??= class {
      observe() {}
      unobserve() {}
      disconnect() {}
    };
    const cb = new Proxy({}, { get: () => () => undefined }) as ViewCallbacks;
    const view = new ReaderView(cb, DEFAULT_SETTINGS, "test");
    view.mount();
    view.openToc({
      chapterId: "2",
      loading: false,
      catalog: {
        bookId: "1",
        volumes: [
          { title: "第一卷", cover: "https://img.example/1.jpg", chapters: [{ title: "一", chapterId: "2", url: "https://x/novel/1/2.html" }] },
          { title: "第二卷", chapters: [{ title: "二", chapterId: "3", url: "https://x/novel/1/3.html" }] },
        ],
      },
    });
    const root = [...document.querySelectorAll("*")].find((e) => e.shadowRoot)!.shadowRoot!;
    const vols = [...root.querySelectorAll(".br-toc-vol")];
    expect(vols.map((v) => v.textContent)).toEqual(["第一卷", "第二卷"]);
    expect(vols[0].querySelector("img")?.getAttribute("src")).toBe("https://img.example/1.jpg");
    expect(vols[1].querySelector("img")).toBeNull();
  });
});
