import type { NextType } from "../types";
import { parseChapterUrl, type ChapterUrlInfo } from "./url";

const NEXT_PAGE_TEXT = /下一[页頁]/;
const NEXT_CHAPTER_TEXT = /下一[章节節]/;

export interface NextLinkInput {
  current: ChapterUrlInfo;
  /** Absolute next URL (from ReadParams.url_next or the footer link). */
  nextUrl?: string;
  /** Visible text of the footer "next" link, if any. */
  linkText?: string;
}

export interface NextLink {
  nextType: NextType;
  nextUrl?: string;
}

/**
 * Decides whether "next" continues the same logical chapter, starts the next
 * chapter, or there is nothing more to read (catalog / book page / missing).
 * The URL is authoritative; link text is only a tie-breaker.
 */
export function classifyNext({ current, nextUrl, linkText }: NextLinkInput): NextLink {
  if (!nextUrl) return { nextType: "end" };
  const next = parseChapterUrl(nextUrl);
  if (!next || next.bookId !== current.bookId) return { nextType: "end" };

  if (next.chapterId === current.chapterId) {
    if (next.pageIndex > current.pageIndex) return { nextType: "same-chapter-page", nextUrl };
    // Pointing back at itself or an earlier page: treat as a dead end rather than looping.
    return { nextType: "end" };
  }

  const text = linkText?.trim() ?? "";
  if (text && !NEXT_CHAPTER_TEXT.test(text) && !NEXT_PAGE_TEXT.test(text)) {
    // e.g. "返回目录" with a chapter-looking URL: be conservative.
    return { nextType: "end" };
  }
  return { nextType: "next-chapter", nextUrl };
}

/** Removes the pagination suffix Bilinovel appends to titles, e.g. "第一章（2/3）". */
export function stripPageSuffix(title: string): string {
  return title.replace(/\s*[（(]\s*\d+\s*\/\s*\d+\s*[）)]\s*$/, "").trim();
}

/** Total page count from a title such as "第一章（2/3）". */
export function pageCountFromTitle(title: string): number | undefined {
  const m = /[（(]\s*\d+\s*\/\s*(\d+)\s*[）)]\s*$/.exec(title);
  const n = m ? Number(m[1]) : NaN;
  return Number.isInteger(n) && n > 0 ? n : undefined;
}
