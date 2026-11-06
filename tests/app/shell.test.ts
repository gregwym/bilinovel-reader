// @vitest-environment jsdom
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { swap } from "../../app/web/ui";

const made: string[] = [];
const disposed: string[] = [];
const resumed: string[] = [];
const stub = (name: string) => () => {
  made.push(name);
  const el = document.createElement("div");
  el.textContent = name;
  return { el, dispose: () => disposed.push(name), resume: () => resumed.push(name) };
};

vi.mock("../../app/web/styles.css", () => ({}));
vi.mock("../../app/web/pages/library", () => ({ libraryPage: stub("shelf") }));
vi.mock("../../app/web/pages/book", () => ({ bookPage: ({ id }: { id: string }) => stub(`book ${id}`)() }));
vi.mock("../../app/web/pages/jobs", () => ({ jobsPage: stub("jobs") }));
vi.mock("../../app/web/pages/settings", () => ({ settingsPage: stub("settings") }));
vi.mock("../../app/web/pages/login", () => ({ loginPage: stub("login") }));
vi.mock("../../app/web/offline", () => ({ onSaveChange: () => () => undefined, saveTasks: () => [] }));
vi.mock("../../app/web/api", () => ({ api: { cached: () => undefined, keep: () => new Promise(() => undefined) } }));

describe("swap", () => {
  it("keeps the covers the new drawing shows too", () => {
    const parent = document.createElement("div");
    const keep = (src: string) => {
      const el = document.createElement("img");
      el.src = src;
      el.setAttribute("data-keep", src);
      return el;
    };
    const a1 = keep("/a");
    const a2 = keep("/a");
    const b = keep("/b");
    parent.replaceChildren(a1, a2, b);
    const nextA1 = keep("/a");
    const nextA2 = keep("/a");
    const c = keep("/c");
    const wrap = document.createElement("section");
    wrap.append(nextA1);
    swap(parent, [wrap, nextA2, c]);
    expect(wrap.firstChild).toBe(a1);
    expect(parent.children[1]).toBe(a2);
    expect(parent.children[2]).toBe(c);
    expect(b.isConnected).toBe(false);
  });

  it("keeps an unchanged tile whole, without lending its cover to another", () => {
    const parent = document.createElement("div");
    const tile = (key: string) => {
      const el = document.createElement("a");
      el.setAttribute("data-keep", key);
      const img = document.createElement("img");
      img.setAttribute("data-keep", "/a");
      el.append(img);
      return el;
    };
    const card = tile("card:1");
    const kept = tile("tile:1");
    parent.replaceChildren(card, kept);
    const keptImg = kept.firstChild;
    const cardImg = card.firstChild;
    const nextCard = tile("card:2");
    swap(parent, [nextCard, tile("tile:1")]);
    expect(parent.children[1]).toBe(kept);
    expect(kept.firstChild).toBe(keptImg);
    expect(nextCard.firstChild).toBe(cardImg);
  });

  it("waits for the finger to lift before redrawing", () => {
    vi.useFakeTimers();
    const parent = document.createElement("div");
    const tapped = document.createElement("a");
    parent.append(tapped);
    document.dispatchEvent(new Event("pointerdown"));
    const next = document.createElement("b");
    swap(parent, [next]);
    expect(parent.firstChild).toBe(tapped);
    document.dispatchEvent(new Event("pointerup"));
    expect(parent.firstChild).toBe(tapped);
    vi.advanceTimersByTime(400);
    expect(parent.firstChild).toBe(next);
    vi.useRealTimers();
  });
});

describe("tabs", () => {
  const main = () => document.querySelector("main")!.textContent;
  const tab = (i: number) => document.querySelectorAll<HTMLAnchorElement>(".tabbar a")[i];
  const link = (path: string) => {
    const a = document.createElement("a");
    a.href = path;
    a.setAttribute("data-link", "");
    document.body.append(a);
    a.click();
    a.remove();
  };

  beforeAll(async () => {
    window.scrollTo = () => undefined;
    history.replaceState(null, "", "/");
    const { startShell } = await import("../../app/web/shell");
    startShell();
  });
  beforeEach(() => {
    made.length = disposed.length = resumed.length = 0;
  });

  it("return to the page left in a tab, as it was", () => {
    link("/book/1");
    expect(main()).toBe("book 1");
    tab(1).click();
    expect(main()).toBe("jobs");
    tab(0).click();
    expect(location.pathname).toBe("/book/1");
    expect(main()).toBe("book 1");
    expect(made).toEqual(["book 1", "jobs"]);
    expect(resumed).toEqual(["book 1"]);
    expect(disposed).toEqual([]);
  });

  it("go back to the first page when the tab shown is tapped", () => {
    tab(0).click();
    expect(location.pathname).toBe("/");
    expect(main()).toBe("shelf");
    // The shelf was kept under the book: shown as it was, not made again.
    expect(made).toEqual([]);
    expect(disposed).toEqual(["book 1"]);
  });

  it("show the page below when going back within a tab", () => {
    link("/book/2");
    link("/");
    expect(main()).toBe("shelf");
    expect(made).toEqual(["book 2"]);
    expect(disposed).toEqual(["book 2"]);
    expect(resumed).toEqual(["shelf"]);
  });
});
