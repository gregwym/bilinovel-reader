import { describe, expect, it, vi } from "vitest";
import { ReaderView, type ViewCallbacks } from "../src/ui/ReaderView";
import { DEFAULT_SETTINGS } from "../src/reader/ProgressStore";

/**
 * A shown view with 100 paragraphs, each 100px tall, in an 800px reading
 * area scrolled to `top` (jsdom has no layout, so the geometry is faked).
 */
function setup(top: number) {
  (globalThis as { IntersectionObserver?: unknown }).IntersectionObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
  (globalThis as { CSS?: unknown }).CSS ??= { escape: (s: string) => s };
  const cb = new Proxy({}, { get: () => () => undefined }) as ViewCallbacks;
  const view = new ReaderView(cb, DEFAULT_SETTINGS, "test");
  view.mount();
  view.show();
  view.appendChapter(
    "2",
    "第一章",
    Array.from({ length: 100 }, (_, i) => ({ id: `2:0:${i}`, text: `段落 ${i}` })),
  );
  const root = [...document.querySelectorAll("*")].filter((e) => e.shadowRoot).at(-1)!.shadowRoot!;
  const scrollEl = root.querySelector<HTMLElement>(".br-scroll")!;
  scrollEl.getBoundingClientRect = () => new DOMRect(0, 0, 400, 800);
  Object.defineProperty(scrollEl, "scrollTop", { get: () => top, set: (v: number) => (top = v), configurable: true });
  const scrollTo = vi.fn((opts: ScrollToOptions) => (top = opts.top ?? top));
  scrollEl.scrollTo = scrollTo as unknown as HTMLElement["scrollTo"];
  root.querySelectorAll<HTMLElement>("p[data-id]").forEach((el, i) => {
    el.getBoundingClientRect = () => new DOMRect(0, i * 100 - top, 400, 100);
  });
  return { view, scrollTo };
}

describe("coming back to the page", () => {
  it("stays where the reader read on to after pausing, not at the paused paragraph", () => {
    const { view, scrollTo } = setup(5000);
    view.setActive("2:0:3"); // paused here, then read on to paragraph 50
    view.revealOnReturn("2:0:50", false);
    expect(scrollTo).not.toHaveBeenCalled();
  });

  it("catches up with the voice while listening", () => {
    const { view, scrollTo } = setup(0);
    view.setActive("2:0:60"); // the voice went on in the background
    view.revealOnReturn("2:0:60", true);
    expect(scrollTo).toHaveBeenCalledWith({ top: 6000 - 240, behavior: "instant" });
  });

  it("shows where the voice got to when it was paused from the lock screen", () => {
    const { view, scrollTo } = setup(0);
    view.setActive("2:0:60");
    view.revealOnReturn("2:0:60", false);
    expect(scrollTo).toHaveBeenCalledWith({ top: 6000 - 240, behavior: "instant" });
  });
});
