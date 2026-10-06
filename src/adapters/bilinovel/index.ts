import type { PageContent, SiteAdapter } from "../types";
import { ParseError } from "../types";
import { RequestQueue } from "../../utils/RequestQueue";
import { log } from "../../utils/log";
import { parseChapterLogScript, type ShuffleTemplate } from "./deobfuscate";
import { findChapterLogScript, parseBilinovelDocument } from "./parser";
import { SUPPORTED_HOSTS, buildPageUrl, isChapterUrl } from "./url";

const TEMPLATE_CACHE_KEY = "biliReader.chapterlogTemplate";

interface CachedTemplate {
  src: string;
  template: ShuffleTemplate;
}

export class BilinovelAdapter implements SiteAdapter {
  readonly name = "bilinovel";
  private readonly templates = new Map<string, Promise<ShuffleTemplate | undefined>>();

  constructor(private readonly queue: RequestQueue = new RequestQueue()) {}

  canHandle(url: URL): boolean {
    return SUPPORTED_HOSTS.includes(url.hostname) && isChapterUrl(url);
  }

  pageUrl(bookId: string, chapterId: string, pageIndex: number): string {
    return buildPageUrl(location.origin, bookId, chapterId, pageIndex);
  }

  async parseDocument(doc: Document, url: URL): Promise<PageContent> {
    const scriptUrl = findChapterLogScript(doc, url);
    const shuffle = scriptUrl ? await this.loadTemplate(scriptUrl) : undefined;
    const page = parseBilinovelDocument(doc, url, { shuffle });
    log.debug("parsed", page.url, {
      chapter: page.chapterTitle,
      paragraphs: page.paragraphs.length,
      next: page.nextType,
      nextUrl: page.nextUrl,
    });
    return page;
  }

  async parseRenderedDocument(doc: Document, url: URL): Promise<PageContent> {
    // Work on a copy: the parser strips junk and must never mutate the live page.
    const copy = doc.cloneNode(true) as Document;
    return parseBilinovelDocument(copy, url, { shuffle: null });
  }

  async fetchPage(url: string): Promise<PageContent> {
    const html = await this.queue.fetchText(url);
    const doc = new DOMParser().parseFromString(html, "text/html");
    try {
      return await this.parseDocument(doc, new URL(url));
    } catch (err) {
      if (err instanceof ParseError) log.error("parse failed", url, err.message, { htmlLength: html.length });
      throw err;
    }
  }

  /**
   * Loads shuffle constants for a chapterlog.js version. Cached in memory and
   * in localStorage (keyed by the versioned script URL) so it costs at most
   * one request per script version.
   */
  private loadTemplate(src: string): Promise<ShuffleTemplate | undefined> {
    let pending = this.templates.get(src);
    if (!pending) {
      pending = this.fetchTemplate(src);
      this.templates.set(src, pending);
    }
    return pending;
  }

  private async fetchTemplate(src: string): Promise<ShuffleTemplate | undefined> {
    try {
      const cached = JSON.parse(localStorage.getItem(TEMPLATE_CACHE_KEY) ?? "null") as CachedTemplate | null;
      if (cached?.src === src) return cached.template;
    } catch {
      /* ignore corrupt cache */
    }
    try {
      // Static asset: let the HTTP cache serve it and skip the page rate limit.
      const res = await fetch(src, { credentials: "include", cache: "force-cache" });
      const template = parseChapterLogScript(await res.text());
      if (!template) {
        log.warn("Could not read shuffle constants from chapterlog.js; using defaults", src);
        return undefined;
      }
      log.debug("chapterlog template", template);
      try {
        localStorage.setItem(TEMPLATE_CACHE_KEY, JSON.stringify({ src, template } satisfies CachedTemplate));
      } catch {
        /* storage full / disabled */
      }
      return template;
    } catch (err) {
      log.warn("Failed to load chapterlog.js; using default shuffle constants", err);
      this.templates.delete(src);
      return undefined;
    }
  }
}
