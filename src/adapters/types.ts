/**
 * Site-independent content model. Everything outside `adapters/` works only
 * with these types and never touches a site's DOM directly.
 */

export interface Paragraph {
  /** Stable id: `${chapterId}:${pageIndex}:${indexInPage}`. */
  id: string;
  text?: string;
  imageUrl?: string;
}

export type NextType = "same-chapter-page" | "next-chapter" | "end";

export interface PageContent {
  bookId: string;
  bookTitle: string;
  chapterId: string;
  chapterTitle: string;
  /** 0-based index of this web page within the logical chapter. */
  pageIndex: number;
  /** Absolute URL of this web page. */
  url: string;
  paragraphs: Paragraph[];
  nextUrl?: string;
  nextType: NextType;
  /** Absolute URL of the logical chapter's first page. */
  chapterUrl: string;
}

export interface SiteAdapter {
  readonly name: string;
  canHandle(url: URL): boolean;
  /** Parses a document whose HTML is the server response (scripts not executed). */
  parseDocument(document: Document, url: URL): Promise<PageContent>;
  /**
   * Parses the page the user is looking at, after the site's own scripts ran
   * (so any client-side de-obfuscation already happened). Used as a fallback
   * when re-fetching the current URL fails.
   */
  parseRenderedDocument(document: Document, url: URL): Promise<PageContent>;
  /** Fetches and parses a page through the adapter's rate-limited queue. */
  fetchPage(url: string): Promise<PageContent>;
  /** Builds the URL of a given page of a chapter (used for progress restore). */
  pageUrl(bookId: string, chapterId: string, pageIndex: number): string;
}

/** Thrown when a page was fetched but could not be understood. */
export class ParseError extends Error {
  constructor(
    message: string,
    readonly url: string,
  ) {
    super(message);
    this.name = "ParseError";
  }
}

/** Thrown when the network request failed (after retries). */
export class FetchError extends Error {
  constructor(
    message: string,
    readonly url: string,
    readonly status?: number,
    /** True when the site returned a bot challenge the user must solve in Safari. */
    readonly challenge = false,
  ) {
    super(message);
    this.name = "FetchError";
  }
}
