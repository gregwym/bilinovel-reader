import type { Catalog, CatalogChapter, ChapterNav, PageContent } from "../types";
import { buildPageUrl, parseChapterUrl } from "./url";

const titleKey = (title: string) => title.normalize("NFKC").replace(/\s+/g, "").trim();

/** Why a placeholder entry was or was not given a link. */
export type PlaceholderStatus = "recovered" | "no-evidence" | "conflict" | "ambiguous";

export interface PlaceholderReport {
  volume: number;
  index: number;
  title: string;
  status: PlaceholderStatus;
  chapterId?: string;
  /** Human-readable evidence and contradictions considered. */
  notes: string[];
}

/**
 * What a parsed page proves about its chapter's neighbours. A page's text is
 * not needed, so only this is kept as evidence. Pages whose URL does not
 * match their own IDs prove nothing.
 */
export function navFromPage(page: PageContent): ChapterNav | undefined {
  const info = parseChapterUrl(page.url);
  if (!info || info.bookId !== page.bookId || info.chapterId !== page.chapterId || info.pageIndex !== page.pageIndex) {
    return undefined;
  }
  const nav: ChapterNav = { bookId: page.bookId, chapterId: page.chapterId };
  if (page.pageIndex === 0) nav.url = page.url;
  if (page.pageIndex === 0 && page.paragraphs.length && page.chapterTitle) nav.title = page.chapterTitle;
  if (page.pageIndex === 0 && page.prev && page.prev.chapterId !== page.chapterId) {
    const prev = parseChapterUrl(page.prev.url);
    if (prev && prev.bookId === page.bookId && prev.chapterId === page.prev.chapterId) nav.prevChapterId = prev.chapterId;
  }
  if (page.nextType === "next-chapter" && page.nextUrl) {
    const next = parseChapterUrl(page.nextUrl);
    if (next && next.bookId === page.bookId && next.chapterId !== page.chapterId) nav.nextChapterId = next.chapterId;
  }
  return nav;
}

/** Everything known about one chapter; more than one value means the evidence disagrees. */
interface Known {
  url?: string;
  titles: Set<string>;
  prev: Set<string>;
  next: Set<string>;
}

function collect(bookId: string, navs: Iterable<ChapterNav>): Map<string, Known> {
  const known = new Map<string, Known>();
  for (const nav of navs) {
    if (nav.bookId !== bookId || !/^\d+$/.test(nav.chapterId)) continue;
    let k = known.get(nav.chapterId);
    if (!k) known.set(nav.chapterId, (k = { titles: new Set(), prev: new Set(), next: new Set() }));
    if (nav.url && parseChapterUrl(nav.url)?.chapterId === nav.chapterId) k.url ??= nav.url;
    if (nav.title && titleKey(nav.title)) k.titles.add(titleKey(nav.title));
    if (nav.prevChapterId) k.prev.add(nav.prevChapterId);
    if (nav.nextChapterId) k.next.add(nav.nextChapterId);
  }
  return known;
}

const one = (s: Set<string> | undefined): string | undefined => (s?.size === 1 ? [...s][0] : undefined);

/**
 * A placeholder is not proof of a missing chapter. Give it an ID only when
 * the site's own chapter navigation points at exactly one chapter for that
 * slot and nothing known contradicts it:
 * - the chapters before and after it both link to X, or
 * - X's title (from its page, or the error page the site served for it)
 *   matches, and at least one link connects X with a neighbour.
 * One link alone proves nothing: the catalog may skip a chapter entirely.
 * Any disagreement (between neighbours, with X's title or links, or another
 * chapter claiming the slot) leaves it unlinked. `cid(...)` values and gaps
 * between IDs are never used. Mutates entries in place so an open reader's
 * catalog stays up to date.
 */
export function reconcileCatalogReport(
  catalog: Catalog,
  pages: Iterable<PageContent>,
  navs: Iterable<ChapterNav> = [],
): { recovered: CatalogChapter[]; report: PlaceholderReport[] } {
  const evidence: ChapterNav[] = [...navs];
  for (const page of pages) {
    const nav = navFromPage(page);
    if (nav) evidence.push(nav);
  }
  const known = collect(catalog.bookId, evidence);
  const linked = new Set(catalog.volumes.flatMap((v) => v.chapters.flatMap((c) => (c.chapterId ? [c.chapterId] : []))));
  const recovered: CatalogChapter[] = [];
  const report: PlaceholderReport[] = [];

  for (const [vi, volume] of catalog.volumes.entries()) {
    for (const [i, chapter] of volume.chapters.entries()) {
      if (chapter.chapterId) continue;
      const notes: string[] = [];
      const key = titleKey(chapter.title);
      const before = volume.chapters[i - 1]?.chapterId;
      const after = volume.chapters[i + 1]?.chapterId;
      const beforeNext = before ? known.get(before)?.next : undefined;
      const afterPrev = after ? known.get(after)?.prev : undefined;
      let conflict = false;
      if (beforeNext && beforeNext.size > 1) {
        notes.push(`前一章 ${before} 的「下一章」链接不一致：${[...beforeNext].join("、")}`);
        conflict = true;
      }
      if (afterPrev && afterPrev.size > 1) {
        notes.push(`后一章 ${after} 的「上一章」链接不一致：${[...afterPrev].join("、")}`);
        conflict = true;
      }
      const bNext = one(beforeNext);
      const aPrev = one(afterPrev);
      if (bNext) notes.push(`前一章 ${before} 的「下一章」→ ${bNext}`);
      if (aPrev) notes.push(`后一章 ${after} 的「上一章」→ ${aPrev}`);

      const candidates = new Set<string>();
      for (const id of [...(beforeNext ?? []), ...(afterPrev ?? [])]) candidates.add(id);
      for (const [id, k] of known) if (key && k.titles.has(key)) candidates.add(id);

      const supported: string[] = [];
      const clean: string[] = [];
      for (const id of candidates) {
        if (linked.has(id)) {
          if (id === bNext || id === aPrev) notes.push(`${id} 已是目录中的其他章节`);
          if (id === bNext || id === aPrev) conflict = true;
          continue;
        }
        const k = known.get(id);
        const titleOk = !!key && !!k?.titles.has(key);
        // One link alone is not enough: the catalog may itself skip a chapter.
        const linksHere =
          (id === bNext ? 1 : 0) + (id === aPrev ? 1 : 0) +
          (!!before && one(k?.prev) === before ? 1 : 0) + (!!after && one(k?.next) === after ? 1 : 0);
        // A same-title page with no link to this slot does not claim it.
        if (!linksHere) continue;
        const contra: string[] = [];
        if (k && k.titles.size > 1) contra.push(`${id} 的标题不一致`);
        else if (k && k.titles.size === 1 && !titleOk) contra.push(`${id} 的标题与目录「${chapter.title}」不符`);
        if (k && k.prev.size > 1) contra.push(`${id} 的「上一章」链接不一致`);
        else if (before && k?.prev.size && one(k.prev) !== before) contra.push(`${id} 的「上一章」是 ${one(k.prev)}，不是 ${before}`);
        if (k && k.next.size > 1) contra.push(`${id} 的「下一章」链接不一致`);
        else if (after && k?.next.size && one(k.next) !== after) contra.push(`${id} 的「下一章」是 ${one(k.next)}，不是 ${after}`);
        if (bNext && bNext !== id) contra.push(`前一章指向 ${bNext}，不是 ${id}`);
        if (aPrev && aPrev !== id) contra.push(`后一章指向 ${aPrev}，不是 ${id}`);
        if (titleOk) notes.push(`${id} 的页面标题与目录一致`);
        notes.push(...contra);
        const support = (id === bNext && id === aPrev) || titleOk;
        if (support) supported.push(id);
        if (contra.length) conflict = true;
        else if (support) clean.push(id);
        else notes.push(`${id} 只有单向导航，缺少标题或另一侧导航佐证`);
      }

      let status: PlaceholderStatus;
      if (supported.length > 1 || clean.length > 1) {
        status = "ambiguous";
        notes.push(`有多个章节符合：${supported.join("、")}`);
      } else if (conflict || (supported.length && !clean.length)) {
        status = "conflict";
      } else if (clean.length === 1) {
        status = "recovered";
      } else {
        status = "no-evidence";
        if (!notes.length) notes.push("没有相邻章节的导航缓存，也没有这一章的页面");
      }
      const entry: PlaceholderReport = { volume: vi, index: i, title: chapter.title, status, notes };
      if (status === "recovered") {
        const id = clean[0];
        chapter.chapterId = id;
        chapter.url = known.get(id)?.url ?? buildPageUrl(urlOrigin(catalog, volume.chapters), catalog.bookId, id, 0);
        linked.add(id);
        recovered.push(chapter);
        entry.chapterId = id;
      }
      report.push(entry);
    }
  }
  return { recovered, report };
}

/** Recovers placeholder links in place; returns the entries that were linked. */
export function reconcileCatalog(
  catalog: Catalog,
  pages: Iterable<PageContent>,
  navs: Iterable<ChapterNav> = [],
): CatalogChapter[] {
  return reconcileCatalogReport(catalog, pages, navs).recovered;
}

/** The site origin the catalog's own links use. */
function urlOrigin(catalog: Catalog, near: CatalogChapter[]): string {
  const sample = near.find((c) => c.url) ?? catalog.volumes.flatMap((v) => v.chapters).find((c) => c.url);
  try {
    if (sample?.url) return new URL(sample.url).origin;
  } catch {
    /* fall through */
  }
  return "https://www.bilinovel.com";
}

/** Chapters of the catalog next to placeholder entries: their pages are the evidence to read. */
export function placeholderNeighbours(catalog: Catalog): string[] {
  const ids = new Set<string>();
  for (const volume of catalog.volumes) {
    volume.chapters.forEach((c, i) => {
      if (c.chapterId) return;
      for (const n of [volume.chapters[i - 1], volume.chapters[i + 1]]) if (n?.chapterId) ids.add(n.chapterId);
    });
  }
  return [...ids];
}
