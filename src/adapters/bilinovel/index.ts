import type { PageContent, SiteAdapter } from "../types";
import { FetchError } from "../types";
import { RequestQueue } from "../../utils/RequestQueue";
import { log } from "../../utils/log";
import { bodyText, httpRequest } from "../../utils/http";
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

  /** Recent page loads, for the "copy diagnostics" button. */
  private readonly diagnostics: Record<string, unknown>[] = [];

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

  getDiagnostics(): Record<string, unknown>[] {
    return [...this.diagnostics];
  }

  private record(entry: Record<string, unknown>): void {
    this.diagnostics.push({ t: new Date().toISOString(), ...entry });
    if (this.diagnostics.length > 30) this.diagnostics.shift();
  }

  /**
   * Parses server HTML whose scripts did not run (DOMParser output or a
   * script-less frame): undoes the paragraph shuffle itself. With `win`, the
   * document is rendered and invisible elements are dropped as well.
   */
  async parseDocument(doc: Document, url: URL, win?: Window): Promise<PageContent> {
    const scriptUrl = findChapterLogScript(doc, url);
    let shuffle: ShuffleTemplate | undefined;
    if (scriptUrl) {
      shuffle = await this.loadTemplate(scriptUrl);
      // Guessing constants would silently scramble the text; let the site's own script do it instead.
      if (!shuffle) throw new TemplateUnavailableError(url.href);
    }
    const content = findContent(doc);
    const hidden = win && content ? markComputedHidden(content, content, win) : 0;
    const page = parseBilinovelDocument(doc, url, { shuffle });
    this.record({ url: url.href, method: "static", paragraphs: page.paragraphs.length, hidden, ...dupStats(page) });
    return this.logged(page);
  }

  /**
   * Parses a document whose scripts already ran (the live page or a frame):
   * paragraph order is restored by the site, and decoy paragraphs it inserts
   * are hidden, so invisible elements are dropped using the rendered styles.
   */
  async parseRenderedDocument(doc: Document, url: URL): Promise<PageContent> {
    return this.logged(this.parseRendered(doc, url, "rendered"));
  }

  private parseRendered(doc: Document, url: URL, method: string): PageContent {
    // Work on a copy: the parser strips junk and must never mutate the live page.
    const copy = doc.cloneNode(true) as Document;
    const live = findContent(doc);
    const cloned = findContent(copy);
    const win = doc.defaultView;
    const hidden = live && cloned && win ? markComputedHidden(live, cloned, win) : 0;
    const page = parseBilinovelDocument(copy, url, { shuffle: null });
    this.record({ url: url.href, method, paragraphs: page.paragraphs.length, hidden, ...dupStats(page) });
    return page;
  }

  /**
   * The page the user opened. Loaded like every other page (server HTML, so
   * no script-inserted decoys); the rendered DOM is the fallback, and is also
   * used to cross-check the paragraph order restore.
   */
  async loadCurrentPage(doc: Document, url: URL): Promise<PageContent> {
    let page: PageContent;
    try {
      // Never make the user solve a challenge for a page that is already on screen.
      page = await this.queue.run(() => this.loadStatic(url.href));
    } catch (err) {
      log.warn("loading the current page failed; using the rendered page", err);
      return this.logged(this.parseRendered(doc, url, "live"));
    }
    try {
      const live = this.parseRendered(doc, url, "live-check");
      const a = page.paragraphs.map((p) => p.text ?? p.imageUrl);
      const b = live.paragraphs.map((p) => p.text ?? p.imageUrl);
      const firstDiff = a.findIndex((t, i) => t !== b[i]);
      const match = firstDiff < 0 && a.length === b.length;
      this.record({ url: url.href, method: "cross-check", match, static: a.length, live: b.length, firstDiff });
      if (!match) log.warn("server-HTML restore differs from the rendered page", { firstDiff, static: a.length, live: b.length });
    } catch {
      /* diagnostics only */
    }
    return page;
  }

  /** Loads a page through the rate-limited queue. */
  fetchPage(url: string): Promise<PageContent> {
    return this.queue.run(() => this.loadPage(url));
  }

  /**
   * Script-less frame first: a normal navigation (so Cloudflare treats it like
   * the user opening the page), server HTML (no decoys) and the site's CSS.
   * If that hits a challenge or the shuffle constants are unknown, load with
   * scripts (the challenge may need the user) and read the rendered page.
   */
  private loadStatic(url: string): Promise<PageContent> {
    return this.withFrame(url, false, (doc, win) => this.parseDocument(doc, new URL(url), win));
  }

  private async loadPage(url: string): Promise<PageContent> {
    const u = new URL(url);
    try {
      return await this.loadStatic(url);
    } catch (err) {
      const challenge = err instanceof FetchError && err.challenge;
      if (!challenge && !(err instanceof TemplateUnavailableError)) throw err;
      log.info(challenge ? "challenge; loading with scripts" : "shuffle constants unknown; loading with scripts", url);
      this.record({ url, method: "fallback", reason: challenge ? "challenge" : "no-template" });
      return this.withFrame(url, true, async (doc) => this.logged(this.parseRendered(doc, u, "rendered")));
    }
  }

  private async withFrame<T>(url: string, scripts: boolean, use: (doc: Document, win: Window) => Promise<T>): Promise<T> {
    const start = Date.now();
    let frame: LoadedFrame | undefined;
    try {
      frame = await this.frameLoader(url, this.frameHost, {
        scripts,
        // Without scripts, wait for stylesheets (load event) so visibility can be judged; don't wait forever on images.
        isReady: (d) =>
          !!findContent(d) &&
          (d.readyState === "complete" || (d.readyState === "interactive" && (scripts || Date.now() - start > 3000))),
      });
      return await use(frame.doc, frame.win);
    } finally {
      frame?.dispose();
    }
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

  /** Second try through the userscript manager (not subject to the page's bot checks). */
  private async fetchTemplateViaGm(src: string): Promise<ShuffleTemplate | null> {
    try {
      const res = await httpRequest({ method: "GET", url: src, timeoutMs: 15_000 });
      return res.status === 200 ? parseChapterLogScript(bodyText(res)) : null;
    } catch {
      return null;
    }
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
      const template = parseChapterLogScript(await res.text()) ?? (await this.fetchTemplateViaGm(src));
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

/** Repeated paragraph texts within one page: decoys would show up here. */
function dupStats(page: PageContent): { duplicates: number } {
  const seen = new Set<string>();
  let duplicates = 0;
  for (const p of page.paragraphs) {
    if (!p.text || p.text.length < 8) continue;
    if (seen.has(p.text)) duplicates++;
    seen.add(p.text);
  }
  return { duplicates };
}
