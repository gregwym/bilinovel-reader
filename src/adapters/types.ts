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
  /** Number of site pages in this chapter, when the page says so. */
  pageCount?: number;
  /** The site's "previous" link (previous page, or the previous chapter). */
  prev?: PageRef;
  /**
   * The site sent only the start of this page, with its "內容加載失敗" notice
   * where the rest should be (e.g. without its `night` cookie). Shown with a note;
   * fetched again when opened, and not used for generated audio.
   */
  incomplete?: boolean;
}

/** A chapter page reference. */
export interface PageRef {
  url: string;
  chapterId: string;
  pageIndex: number;
}

export interface CatalogChapter {
  title: string;
  /** Missing when the catalog only has a placeholder link for it. */
  chapterId?: string;
  url?: string;
}

export interface CatalogVolume {
  title: string;
  chapters: CatalogChapter[];
  /** The volume's cover image, when the catalog shows one. */
  cover?: string;
}

export interface Catalog {
  bookId: string;
  volumes: CatalogVolume[];
}

/** Where an adapter may place an iframe used to load pages (and show bot challenges). */
export interface FrameHost {
  /** Puts the (invisible) iframe into the document. */
  attach(iframe: HTMLIFrameElement): void;
  /** Makes the iframe visible so the user can solve a challenge; `cancel` aborts the load. */
  reveal(iframe: HTMLIFrameElement, message: string, cancel: () => void): void;
  /** Removes the iframe (and hides any challenge UI). */
  detach(iframe: HTMLIFrameElement): void;
}

export interface SiteAdapter {
  readonly name: string;
  canHandle(url: URL): boolean;
  /** Parses a document whose HTML is the server response (scripts not executed). */
  parseDocument(document: Document, url: URL): Promise<PageContent>;
  /**
   * Content of the page the user opened (`document` is the live, rendered
   * page). The adapter may use the rendered DOM or load the URL itself.
   */
  loadCurrentPage(document: Document, url: URL): Promise<PageContent>;
  /** Fetches and parses a page through the adapter's rate-limited queue. */
  fetchPage(url: string): Promise<PageContent>;
  /** Recent load records for troubleshooting (no reading data beyond URLs and counts). */
  getDiagnostics?(): Record<string, unknown>[];
  /** Lets the UI host the adapter's loader frames. */
  setFrameHost?(host: FrameHost): void;
  /**
   * Loads the book's table of contents. The adapter may keep improving it
   * afterwards (linking placeholder entries in place); `onUpdate` is called then.
   */
  fetchCatalog?(bookId: string, onUpdate?: () => void): Promise<Catalog>;
  /** The book's cover image, when the adapter has one (lock screen artwork when the volume has none). */
  bookCover?(bookId: string): string | undefined;
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

/**
 * What a chapter page says about its place in the book, without its text:
 * from a parsed page, or from a page the site served without content.
 */
export interface ChapterNav {
  bookId: string;
  chapterId: string;
  /** The chapter's first page, when this is it. */
  url?: string;
  /** Chapter title, when the page shows it (first page or an error page). */
  title?: string;
  /** The chapter the site's "previous chapter" link points at. */
  prevChapterId?: string;
  /** The chapter the site's "next chapter" link points at. */
  nextChapterId?: string;
}

/**
 * The site answered (often HTTP 200) with its "內容加載失敗" page instead of
 * the chapter: the content is not available to this client right now. Not a
 * parser bug, so it carries what the page still showed for diagnostics.
 */
export class ContentUnavailableError extends ParseError {
  constructor(
    message: string,
    url: string,
    /** Title and navigation the error page still had. */
    readonly nav?: ChapterNav,
    /** Start of the text shown instead of the chapter. */
    readonly excerpt?: string,
    /**
     * Readable characters the page had besides the notice: the site sent only
     * the start of the chapter.
     */
    readonly partial?: number,
  ) {
    super(message, url);
    this.name = "ContentUnavailableError";
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
