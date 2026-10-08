/**
 * Table of contents (`/novel/{bookId}/catalog`).
 *
 * Mobile theme (see Montaro2017/bili_novel_packer):
 *   .volume-chapters > li.chapter-bar     volume title
 *   .volume-chapters > li.volume-cover    volume cover (ignored)
 *   .volume-chapters > li.jsChapter > a   chapter link; `href="javascript:…"`
 *                                         when the site has no link for it
 * Other layouts fall back to headings (`h2`/`h3`, `.v-line`) as volume titles
 * and every chapter link of the book, in document order.
 */

import { ParseError, type Catalog, type CatalogChapter, type CatalogVolume } from "../types";
import { decodeText } from "./deobfuscate";
import { parseChapterUrl, resolveHref } from "./url";

const CONTAINER_SELECTORS = ["#volumes", ".catalog-volume", ".volume-list", "#chapterlist", ".chapter-list"];
const VOLUME_TITLE = ".chapter-bar, .v-line, .volume-name, h2, h3";

export function catalogUrl(origin: string, bookId: string): string {
  return `${origin}/novel/${bookId}/catalog`;
}

/** Finds the element holding the volumes (narrower is better: skips "latest chapter" links). */
function findContainer(doc: Document): Element | null {
  const lists = Array.from(doc.querySelectorAll(".volume-chapters"));
  if (lists.length === 1) return lists[0];
  if (lists.length > 1) {
    // Their common ancestor.
    let c: Element | null = lists[0].parentElement;
    while (c && !lists.every((l) => c!.contains(l))) c = c.parentElement;
    return c;
  }
  for (const sel of CONTAINER_SELECTORS) {
    const el = doc.querySelector(sel);
    if (el) return el;
  }
  return doc.body;
}

export function hasCatalog(doc: Document): boolean {
  return !!doc.querySelector(".volume-chapters, .jsChapter, #volumes, .chapter-list");
}

export function parseCatalogDocument(doc: Document, url: URL, bookId: string): Catalog {
  const container = findContainer(doc);
  if (!container) throw new ParseError("Catalog not found", url.href);

  const volumes: CatalogVolume[] = [];
  let volume: CatalogVolume | undefined;
  const seen = new Set<string>();
  const items = container.querySelectorAll(`${VOLUME_TITLE}, a`);
  for (const el of Array.from(items)) {
    if (el.matches(VOLUME_TITLE)) {
      // A heading that wraps a chapter link is not a volume title.
      if (el.querySelector("a[href]") && !el.matches(".chapter-bar, .v-line")) continue;
      const title = decodeText(el.textContent ?? "");
      if (!title) continue;
      volume = { title, chapters: [] };
      volumes.push(volume);
      continue;
    }
    const chapter = toChapter(el, url, bookId);
    if (!chapter) continue;
    if (chapter.chapterId) {
      if (seen.has(chapter.chapterId)) continue;
      seen.add(chapter.chapterId);
    }
    if (!volume) {
      volume = { title: "", chapters: [] };
      volumes.push(volume);
    }
    volume.chapters.push(chapter);
  }
  const nonEmpty = volumes.filter((v) => v.chapters.length);
  if (!nonEmpty.some((v) => v.chapters.some((c) => c.url))) throw new ParseError("Catalog has no chapters", url.href);
  return { bookId, volumes: nonEmpty };
}

function toChapter(a: Element, base: URL, bookId: string): CatalogChapter | undefined {
  const title = decodeText(a.textContent ?? "");
  const href = a.getAttribute("href") ?? "";
  const abs = resolveHref(href, base);
  const info = abs ? parseChapterUrl(abs) : null;
  if (info && info.bookId === bookId && info.pageIndex === 0) {
    return { title: title || `章节 ${info.chapterId}`, chapterId: info.chapterId, url: abs };
  }
  // Placeholder entry the site has no link for (older books).
  if (/^javascript:/i.test(href.trim()) && title && a.closest(".jsChapter, .chapter-li, li")) return { title };
  return undefined;
}

