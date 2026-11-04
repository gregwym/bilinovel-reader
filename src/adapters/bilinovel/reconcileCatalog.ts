import type { Catalog, CatalogChapter, PageContent } from "../types";
import { parseChapterUrl } from "./url";

const titleKey = (title: string) => title.normalize("NFKC").replace(/\s+/g, "").trim();

/**
 * A placeholder is not proof of a missing chapter. Recover it only from a
 * parsed first page whose title AND adjacent chapter navigation agree.
 * Never interpret cid(...) or interpolate a numerical gap as a chapter ID.
 * Mutates entries in place so an open reader's catalog stays up to date.
 */
export function reconcileCatalog(catalog: Catalog, pages: Iterable<PageContent>): CatalogChapter[] {
  const first = new Map<string, PageContent>();
  for (const page of pages) {
    const info = parseChapterUrl(page.url);
    if (page.bookId !== catalog.bookId || page.pageIndex !== 0 || !page.paragraphs.length ||
        !info || info.bookId !== catalog.bookId || info.chapterId !== page.chapterId || info.pageIndex !== 0) continue;
    first.set(page.chapterId, page);
  }
  const linked = new Set(catalog.volumes.flatMap((v) => v.chapters.flatMap((c) => c.chapterId ? [c.chapterId] : [])));
  const recovered: CatalogChapter[] = [];
  for (const volume of catalog.volumes) {
    for (const [i, chapter] of volume.chapters.entries()) {
      if (chapter.chapterId) continue;
      const before = volume.chapters[i - 1]?.chapterId;
      const after = volume.chapters[i + 1]?.chapterId;
      const candidates = [...first.values()].filter((page) => {
        if (linked.has(page.chapterId) || !titleKey(chapter.title) || titleKey(page.chapterTitle) !== titleKey(chapter.title)) return false;
        const prev = page.prev && parseChapterUrl(page.prev.url);
        const following = after ? first.get(after) : undefined;
        const followingPrev = following && following.prev && parseChapterUrl(following.prev.url);
        const next = page.nextType === "next-chapter" && page.nextUrl ? parseChapterUrl(page.nextUrl) : null;
        // A known contradiction is not outweighed by a matching title/link.
        if (before && prev && (prev.bookId !== catalog.bookId || prev.chapterId !== before)) return false;
        if (after && next && (next.bookId !== catalog.bookId || next.chapterId !== after)) return false;
        if (followingPrev && (followingPrev.bookId !== catalog.bookId || followingPrev.chapterId !== page.chapterId)) return false;
        return !!((before && prev?.bookId === catalog.bookId && prev.chapterId === before) ||
          (after && next?.bookId === catalog.bookId && next.chapterId === after) ||
          (followingPrev?.bookId === catalog.bookId && followingPrev.chapterId === page.chapterId));
      });
      if (candidates.length !== 1) continue;
      const page = candidates[0];
      chapter.chapterId = page.chapterId;
      chapter.url = page.url;
      linked.add(page.chapterId);
      recovered.push(chapter);
    }
  }
  return recovered;
}
