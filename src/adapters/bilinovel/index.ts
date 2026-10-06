import type { PageContent, SiteAdapter } from "../types";
import { FetchError, ParseError } from "../types";
import { RequestQueue } from "../../utils/RequestQueue";
import { log } from "../../utils/log";
import { parseChapterLogScript, type ShuffleTemplate } from "./deobfuscate";
import { findChapterLogScript, findContent, markComputedHidden, parseBilinovelDocument } from "./parser";
import { defaultFrameHost, loadInFrame, type FrameHost, type LoadedFrame } from "./frameLoader";
import { SUPPORTED_HOSTS, buildPageUrl, isChapterUrl } from "./url";

const TEMPLATE_CACHE_KEY = "biliReader.chapterlogTemplate";

interface CachedTemplate {
  src: string;
  template: ShuffleTemplate;
}

class TemplateUnavailableError extends Error {
  constructor(readonly url: string) {
    super("chapterlog.js constants unavailable");
  }
}

export class BilinovelAdapter implements SiteAdapter {
  readonly name = "bilinovel";
  private readonly templates = new Map<string, Promise<ShuffleTemplate | undefined>>();

  /** Set after a bot challenge: fetch keeps failing, so load pages in a frame instead. */
  private preferFrame = false;

  constructor(
    private readonly queue: RequestQueue = new RequestQueue(),
    public frameHost: FrameHost = defaultFrameHost,
    private readonly frameLoader: typeof loadInFrame = loadInFrame,
  ) {}

  setFrameHost(host: FrameHost): void {
    this.frameHost = host;
  }

  canHandle(url: URL): boolean {
    return SUPPORTED_HOSTS.includes(url.hostname) && isChapterUrl(url);
  }

  pageUrl(bookId: string, chapterId: string, pageIndex: number): string {
    return buildPageUrl(location.origin, bookId, chapterId, pageIndex);
  }

  /** Parses server HTML (scripts not executed): undoes the paragraph shuffle itself. */
  async parseDocument(doc: Document, url: URL): Promise<PageContent> {
    const scriptUrl = findChapterLogScript(doc, url);
    let shuffle: ShuffleTemplate | undefined;
    if (scriptUrl) {
      shuffle = await this.loadTemplate(scriptUrl);
      // Guessing constants would silently scramble the text; let the site's own script do it instead.
      if (!shuffle) throw new TemplateUnavailableError(url.href);
    }
    return this.logged(parseBilinovelDocument(doc, url, { shuffle }));
  }

  /**
   * Parses a document whose scripts already ran (the live page or a frame):
   * paragraph order is restored, and decoy paragraphs the site inserts are
   * hidden with CSS, so invisible elements are dropped using computed styles.
   */
  async parseRenderedDocument(doc: Document, url: URL): Promise<PageContent> {
    return this.logged(this.parseRendered(doc, url).page);
  }

  private parseRendered(doc: Document, url: URL): { page: PageContent; hidden: number } {
    // Work on a copy: the parser strips junk and must never mutate the live page.
    const copy = doc.cloneNode(true) as Document;
    const live = findContent(doc);
    const cloned = findContent(copy);
    const win = doc.defaultView;
    const hidden = live && cloned && win ? markComputedHidden(live, cloned, win) : 0;
    return { page: parseBilinovelDocument(copy, url, { shuffle: null }), hidden };
  }

  /**
   * The page the user opened. Uses the rendered DOM when the site's
   * de-obfuscation evidently ran (saves a request that Cloudflare may
   * challenge); otherwise loads it like any other page.
   */
  async loadCurrentPage(doc: Document, url: URL): Promise<PageContent> {
    try {
      const { page, hidden } = this.parseRendered(doc, url);
      const shuffled = !!findChapterLogScript(doc, url);
      const textCount = page.paragraphs.filter((p) => p.text).length;
      // chapterlog.js only reorders past 20 paragraphs, and then also inserts hidden decoys.
      if (!shuffled || textCount <= 20 || hidden > 0) return this.logged(page);
      log.debug("rendered page not verifiably de-obfuscated; loading it instead");
    } catch (err) {
      log.warn("parsing the rendered page failed; loading it instead", err);
    }
    return this.fetchPage(url.href);
  }

  async fetchPage(url: string): Promise<PageContent> {
    if (this.preferFrame) return this.fetchViaFrame(url);
    let html: string;
    try {
      html = await this.queue.fetchText(url);
    } catch (err) {
      if (err instanceof FetchError && err.challenge) {
        log.info("bot challenge on fetch; switching to frame loading", url);
        this.preferFrame = true;
        return this.fetchViaFrame(url);
      }
      throw err;
    }
    const doc = new DOMParser().parseFromString(html, "text/html");
    try {
      return await this.parseDocument(doc, new URL(url));
    } catch (err) {
      if (err instanceof TemplateUnavailableError) return this.fetchViaFrame(url);
      if (err instanceof ParseError) log.error("parse failed", url, err.message, { htmlLength: html.length });
      throw err;
    }
  }

  private fetchViaFrame(url: string): Promise<PageContent> {
    return this.queue.run(async () => {
      let frame: LoadedFrame | undefined;
      try {
        frame = await this.frameLoader(url, this.frameHost, {
          isReady: (d) => !!findContent(d) && d.readyState !== "loading",
        });
        return this.logged(this.parseRendered(frame.doc, new URL(url)).page);
      } finally {
        frame?.dispose();
      }
    });
  }

  private logged(page: PageContent): PageContent {
    log.debug("parsed", page.url, {
      chapter: page.chapterTitle,
      paragraphs: page.paragraphs.length,
      next: page.nextType,
      nextUrl: page.nextUrl,
    });
    return page;
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
        log.warn("Could not read shuffle constants from chapterlog.js; pages will load in a frame", src);
        this.templates.delete(src);
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
      log.warn("Failed to load chapterlog.js; pages will load in a frame", err);
      this.templates.delete(src);
      return undefined;
    }
  }
}
