import { JSDOM } from "jsdom";
import { ParseError, type Catalog, type PageContent } from "../../../src/adapters/types";
import { decodeText, parseChapterLogScript, type ShuffleTemplate } from "../../../src/adapters/bilinovel/deobfuscate";
import { findChapterLogScript, parseBilinovelDocument } from "../../../src/adapters/bilinovel/parser";
import { catalogUrl, parseCatalogDocument } from "../../../src/adapters/bilinovel/catalog";
import { reconcileCatalog } from "../../../src/adapters/bilinovel/reconcileCatalog";
import { buildPageUrl, parseChapterUrl, resolveHref } from "../../../src/adapters/bilinovel/url";
import type { Db } from "../db";
import type { SiteClient } from "./client";

export interface BookInfo {
  title: string;
  author: string;
  coverUrl?: string;
  intro: string;
}

const meta = (doc: Document, prop: string): string =>
  decodeText(doc.querySelector(`meta[property="${prop}"], meta[name="${prop}"]`)?.getAttribute("content") ?? "");
const text = (el: Element | null): string => decodeText(el?.textContent ?? "").replace(/\s+/g, " ").trim();

/** Book page (`/novel/{id}.html`): Open Graph tags first, then the mobile theme's elements. */
export function parseBookInfo(doc: Document, url: URL): BookInfo {
  const title =
    meta(doc, "og:novel:book_name") ||
    text(doc.querySelector(".book-title, .book-name, h1")) ||
    meta(doc, "og:title").replace(/[_|].*$/, "") ||
    decodeText(doc.title.split(/[_|]/)[0] ?? "");
  const author =
    meta(doc, "og:novel:author") ||
    text(doc.querySelector(".book-rand-a a, .authorname a, .book-author a, .au-name a, .book-author")).replace(/^作者[:：]\s*/, "");
  const cover =
    meta(doc, "og:image") ||
    doc.querySelector(".book-cover img, .module-book-cover img, .book-img img, img.cover")?.getAttribute("data-src") ||
    doc.querySelector(".book-cover img, .module-book-cover img, .book-img img, img.cover")?.getAttribute("src") ||
    "";
  const intro =
    meta(doc, "og:description") || text(doc.querySelector("#bookSummary, .book-summary, .book-dec, .book-intro"));
  if (!title) throw new ParseError("Book page has no title", url.href);
  return { title, author, coverUrl: resolveHref(cover, url), intro };
}

/** Catalog plus what the catalog page shows about the book. */
export interface SiteCatalog extends Catalog {
  title?: string;
  /** First volume's cover. */
  cover?: string;
}

export function parseSiteCatalog(doc: Document, url: URL, bookId: string): SiteCatalog {
  const catalog: SiteCatalog = parseCatalogDocument(doc, url, bookId);
  const title = meta(doc, "og:novel:book_name") || decodeText(doc.title.split(/[_|]/)[0] ?? "").replace(/目录$/, "");
  if (title) catalog.title = title;
  for (const img of Array.from(doc.querySelectorAll("img"))) {
    const src = img.getAttribute("data-src") || img.getAttribute("src") || "";
    if (src && !/loading|lazy|blank/i.test(src)) {
      catalog.cover = resolveHref(src, url);
      break;
    }
  }
  return catalog;
}

interface PageRow {
  data: string;
}

/**
 * Book content from the site, parsed with the userscript's parsers (over
 * jsdom) and kept in the database: a page is fetched once, whoever needs it
 * (the reader, the audio generator).
 */
export class SiteSource {
  private readonly templates = new Map<string, Promise<ShuffleTemplate>>();
  private readonly catalogs = new Map<string, { at: number; catalog: Promise<SiteCatalog> }>();
  private readonly pending = new Map<string, Promise<PageContent>>();
  private readonly pageListeners: ((bookId: string) => void)[] = [];

  constructor(
    private readonly db: Db,
    private readonly client: SiteClient,
    private readonly origin: () => string,
  ) {}

  pageUrl(bookId: string, chapterId: string, pageIndex: number): string {
    return buildPageUrl(this.origin(), bookId, chapterId, pageIndex);
  }

  onPageCached(fn: (bookId: string) => void): void {
    this.pageListeners.push(fn);
  }

  /** Reuses existing content without network requests or guessing IDs. */
  reconcileCatalog(catalog: Catalog) {
    if (!catalog.volumes.some((v) => v.chapters.some((c) => !c.chapterId))) return [];
    const pages = this.db.all<PageRow>("select data from pages where book_id = ? and page_index = 0", catalog.bookId);
    return reconcileCatalog(catalog, pages.map((r) => JSON.parse(r.data) as PageContent));
  }

  private parse<T>(html: string, url: string, fn: (doc: Document) => T): T {
    const dom = new JSDOM(html, { url });
    try {
      return fn(dom.window.document);
    } finally {
      dom.window.close();
    }
  }

  cachedPage(bookId: string, chapterId: string, pageIndex: number): PageContent | undefined {
    const row = this.db.get<PageRow>(
      "select data from pages where book_id = ? and chapter_id = ? and page_index = ?",
      bookId,
      chapterId,
      pageIndex,
    );
    return row ? (JSON.parse(row.data) as PageContent) : undefined;
  }

  /** A chapter page: from the database, or fetched and stored. */
  page(bookId: string, chapterId: string, pageIndex: number, refresh = false): Promise<PageContent> {
    if (!refresh) {
      const cached = this.cachedPage(bookId, chapterId, pageIndex);
      if (cached) return Promise.resolve(cached);
    }
    const id = `${bookId}/${chapterId}/${pageIndex}`;
    let p = this.pending.get(id);
    if (!p) {
      p = this.fetchPage(this.pageUrl(bookId, chapterId, pageIndex));
      this.pending.set(id, p);
      const done = () => this.pending.delete(id);
      p.then(done, done);
    }
    return p;
  }

  private async fetchPage(url: string): Promise<PageContent> {
    const html = await this.client.html(url);
    const scriptUrl = this.parse(html, url, (doc) => findChapterLogScript(doc, new URL(url)));
    const shuffle = scriptUrl ? await this.template(scriptUrl) : undefined;
    const page = this.parse(html, url, (doc) => parseBilinovelDocument(doc, new URL(url), { shuffle }));
    this.db.run(
      `insert into pages (book_id, chapter_id, page_index, data, fetched_at) values (?, ?, ?, ?, ?)
       on conflict (book_id, chapter_id, page_index) do update set data = excluded.data, fetched_at = excluded.fetched_at`,
      page.bookId,
      page.chapterId,
      page.pageIndex,
      JSON.stringify(page),
      Date.now(),
    );
    this.pageListeners.forEach((fn) => fn(page.bookId));
    return page;
  }

  /** Shuffle constants of a chapterlog.js version (kept in the database per script URL). */
  private template(src: string): Promise<ShuffleTemplate> {
    let p = this.templates.get(src);
    if (!p) {
      p = (async () => {
        const key = `site.chapterlog:${src}`;
        const saved = this.db.getJson<ShuffleTemplate>(key);
        if (saved) return saved;
        try {
          const js = (await this.client.binary(src)).body.toString("utf8");
          const t = parseChapterLogScript(js);
          if (t) {
            this.db.setJson(key, t);
            return t;
          }
          throw new ParseError("Could not read the paragraph order constants", src);
        } catch (err) {
          this.templates.delete(src);
          // Guessing constants would silently scramble the text (see BilinovelAdapter.parseDocument).
          throw err;
        }
      })();
      this.templates.set(src, p);
    }
    return p;
  }

  /** The pages of a chapter already in the database (from the first, until one is missing). */
  /** Changes when a page of the book is cached or fetched again. */
  pagesRevision(bookId: string): string {
    const r = this.db.get<{ n: number; t: number | null }>("select count(*) as n, max(fetched_at) as t from pages where book_id = ?", bookId)!;
    return `${r.n}:${r.t ?? 0}`;
  }

  cachedChapterPages(bookId: string, chapterId: string): { pages: PageContent[]; complete: boolean } {
    const pages: PageContent[] = [];
    for (let i = 0; i < 100; i++) {
      const page = this.cachedPage(bookId, chapterId, i);
      if (!page) return { pages, complete: false };
      pages.push(page);
      if (page.nextType !== "same-chapter-page" || !page.nextUrl) break;
      const next = parseChapterUrl(page.nextUrl);
      if (!next || next.chapterId !== chapterId || next.pageIndex !== i + 1) break;
    }
    return { pages, complete: true };
  }

  /** All pages of a chapter, in order. */
  async chapterPages(bookId: string, chapterId: string, onPage?: (n: number) => void): Promise<PageContent[]> {
    const pages: PageContent[] = [];
    for (let i = 0; i < 100; i++) {
      const page = await this.page(bookId, chapterId, i);
      pages.push(page);
      onPage?.(pages.length);
      if (page.nextType !== "same-chapter-page" || !page.nextUrl) break;
      const next = parseChapterUrl(page.nextUrl);
      if (!next || next.chapterId !== chapterId || next.pageIndex !== i + 1) break;
    }
    return pages;
  }

  /** Table of contents (cached in memory for 10 minutes unless refreshed). */
  catalog(bookId: string, refresh = false): Promise<SiteCatalog> {
    const cached = this.catalogs.get(bookId);
    if (cached && !refresh && Date.now() - cached.at < 10 * 60_000) return cached.catalog;
    const url = catalogUrl(this.origin(), bookId);
    const catalog = this.client
      .html(url)
      .then((html) => this.parse(html, url, (doc) => parseSiteCatalog(doc, new URL(url), bookId)));
    this.catalogs.set(bookId, { at: Date.now(), catalog });
    catalog.catch(() => this.catalogs.delete(bookId));
    return catalog;
  }

  async bookInfo(bookId: string): Promise<BookInfo> {
    const url = `${this.origin()}/novel/${bookId}.html`;
    const html = await this.client.html(url);
    return this.parse(html, url, (doc) => parseBookInfo(doc, new URL(url)));
  }
}
