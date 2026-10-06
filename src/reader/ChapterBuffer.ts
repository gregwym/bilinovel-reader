import type { NextType, PageContent, Paragraph } from "../adapters/types";

/** A paragraph placed in the logical (chapter-level) reading order. */
export interface ReaderParagraph extends Paragraph {
  chapterId: string;
  pageIndex: number;
  /** Index within its source page; together with pageIndex forms the saved position. */
  indexInPage: number;
  pageUrl: string;
}

export interface Chapter {
  chapterId: string;
  title: string;
  chapterUrl: string;
  /** Site page indexes loaded into this chapter, in order. */
  pageIndexes: number[];
  paragraphs: ReaderParagraph[];
}

export type AppendResult =
  | { kind: "duplicate" }
  | { kind: "same-chapter"; chapter: Chapter; added: ReaderParagraph[] }
  | { kind: "new-chapter"; chapter: Chapter; added: ReaderParagraph[] };

/**
 * Holds the loaded part of the book as chapters of paragraphs. Site page
 * boundaries are folded into chapters so nothing above this layer sees them.
 */
export class ChapterBuffer {
  readonly chapters: Chapter[] = [];
  bookId = "";
  bookTitle = "";
  private nextUrl?: string;
  private nextType: NextType = "end";
  private readonly loadedUrls = new Set<string>();
  private readonly index = new Map<string, ReaderParagraph>();

  get isEmpty(): boolean {
    return this.chapters.length === 0;
  }

  /** The URL that continues the loaded content, if any. */
  get pending(): { url: string; type: Exclude<NextType, "end"> } | undefined {
    return this.nextUrl && this.nextType !== "end" ? { url: this.nextUrl, type: this.nextType } : undefined;
  }

  get atEnd(): boolean {
    return !this.isEmpty && !this.pending;
  }

  reset(): void {
    this.chapters.length = 0;
    this.loadedUrls.clear();
    this.index.clear();
    this.nextUrl = undefined;
    this.nextType = "end";
  }

  append(page: PageContent): AppendResult {
    if (this.loadedUrls.has(page.url)) return { kind: "duplicate" };
    this.loadedUrls.add(page.url);
    this.bookId = page.bookId;
    if (page.bookTitle) this.bookTitle = page.bookTitle;
    this.nextUrl = page.nextUrl;
    this.nextType = page.nextType;

    const added: ReaderParagraph[] = page.paragraphs.map((p, i) => ({
      ...p,
      chapterId: page.chapterId,
      pageIndex: page.pageIndex,
      indexInPage: i,
      pageUrl: page.url,
    }));
    added.forEach((p) => this.index.set(p.id, p));

    const last = this.chapters[this.chapters.length - 1];
    if (last && last.chapterId === page.chapterId) {
      last.pageIndexes.push(page.pageIndex);
      last.paragraphs.push(...added);
      if (!last.title && page.chapterTitle) last.title = page.chapterTitle;
      return { kind: "same-chapter", chapter: last, added };
    }
    const chapter: Chapter = {
      chapterId: page.chapterId,
      title: page.chapterTitle,
      chapterUrl: page.chapterUrl,
      pageIndexes: [page.pageIndex],
      paragraphs: added,
    };
    this.chapters.push(chapter);
    return { kind: "new-chapter", chapter, added };
  }

  get(id: string): ReaderParagraph | undefined {
    return this.index.get(id);
  }

  chapterOf(id: string): Chapter | undefined {
    const p = this.index.get(id);
    return p && this.chapters.find((c) => c.chapterId === p.chapterId);
  }

  find(chapterId: string, pageIndex: number, indexInPage: number): ReaderParagraph | undefined {
    const ch = this.chapters.find((c) => c.chapterId === chapterId);
    return ch?.paragraphs.find((p) => p.pageIndex === pageIndex && p.indexInPage === indexInPage);
  }

  first(): ReaderParagraph | undefined {
    return this.chapters[0]?.paragraphs[0];
  }

  /** Next paragraph in reading order, "pending" if more content can be loaded, or "end". */
  next(id: string): ReaderParagraph | "pending" | "end" {
    const loc = this.locate(id);
    if (!loc) return "end";
    const { ci, pi } = loc;
    const ch = this.chapters[ci];
    if (pi + 1 < ch.paragraphs.length) return ch.paragraphs[pi + 1];
    for (let c = ci + 1; c < this.chapters.length; c++) {
      if (this.chapters[c].paragraphs.length) return this.chapters[c].paragraphs[0];
    }
    return this.pending ? "pending" : "end";
  }

  prev(id: string): ReaderParagraph | undefined {
    const loc = this.locate(id);
    if (!loc) return undefined;
    const { ci, pi } = loc;
    if (pi > 0) return this.chapters[ci].paragraphs[pi - 1];
    for (let c = ci - 1; c >= 0; c--) {
      const ps = this.chapters[c].paragraphs;
      if (ps.length) return ps[ps.length - 1];
    }
    return undefined;
  }

  /** Number of paragraphs after `id` that are already loaded. */
  remainingAfter(id: string): number {
    const loc = this.locate(id);
    if (!loc) return 0;
    let n = this.chapters[loc.ci].paragraphs.length - loc.pi - 1;
    for (let c = loc.ci + 1; c < this.chapters.length; c++) n += this.chapters[c].paragraphs.length;
    return n;
  }

  /** Drops whole chapters from the front (rolling buffer). Returns the removed chapters. */
  dropBefore(chapterIndex: number): Chapter[] {
    if (chapterIndex <= 0) return [];
    const removed = this.chapters.splice(0, chapterIndex);
    for (const ch of removed) for (const p of ch.paragraphs) this.index.delete(p.id);
    return removed;
  }

  private locate(id: string): { ci: number; pi: number } | undefined {
    const p = this.index.get(id);
    if (!p) return undefined;
    const ci = this.chapters.findIndex((c) => c.chapterId === p.chapterId);
    if (ci < 0) return undefined;
    const pi = this.chapters[ci].paragraphs.indexOf(p);
    return pi < 0 ? undefined : { ci, pi };
  }
}
