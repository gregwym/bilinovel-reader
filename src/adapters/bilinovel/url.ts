/**
 * Bilinovel URL patterns:
 *   /novel/{bookId}.html              book info
 *   /novel/{bookId}/catalog           table of contents
 *   /novel/{bookId}/vol_{id}.html     volume page
 *   /novel/{bookId}/{chapterId}.html  chapter, page 1
 *   /novel/{bookId}/{chapterId}_{n}.html  chapter, page n (n >= 2)
 */

export const SUPPORTED_HOSTS = ["www.bilinovel.net", "www.bilinovel.com"];

const CHAPTER_PATH = /^\/novel\/(\d+)\/(\d+)(?:_(\d+))?\.html$/;

export interface ChapterUrlInfo {
  bookId: string;
  chapterId: string;
  /** 0-based page index (`_2.html` -> 1). */
  pageIndex: number;
}

export function parseChapterUrl(url: URL | string): ChapterUrlInfo | null {
  let u: URL;
  try {
    u = typeof url === "string" ? new URL(url) : url;
  } catch {
    return null;
  }
  const m = CHAPTER_PATH.exec(u.pathname);
  if (!m) return null;
  const page = m[3] ? Number(m[3]) : 1;
  if (!Number.isFinite(page) || page < 1) return null;
  return { bookId: m[1], chapterId: m[2], pageIndex: page - 1 };
}

export function isChapterUrl(url: URL | string): boolean {
  return parseChapterUrl(url) !== null;
}

export function buildPageUrl(origin: string, bookId: string, chapterId: string, pageIndex: number): string {
  const suffix = pageIndex > 0 ? `_${pageIndex + 1}` : "";
  return `${origin}/novel/${bookId}/${chapterId}${suffix}.html`;
}

/** Resolves a possibly relative href against `base`; returns undefined for javascript:/empty links. */
export function resolveHref(href: string | null | undefined, base: URL): string | undefined {
  if (!href) return undefined;
  const trimmed = href.trim();
  if (!trimmed || /^javascript:/i.test(trimmed) || trimmed === "#") return undefined;
  try {
    return new URL(trimmed, base).href;
  } catch {
    return undefined;
  }
}
