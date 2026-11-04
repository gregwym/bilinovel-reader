/**
 * Pure Bilinovel page parser. Works on any `Document` (live page, DOMParser
 * output, jsdom) and never touches the network, so it can be unit-tested.
 *
 * Page anatomy (mobile theme served on bilinovel.net / bilinovel.com):
 *   #atitle                     chapter title, "（2/3）" suffix on later pages
 *   #acontent (.bcontent)       chapter body: <p> paragraphs, <img> illustrations,
 *                               plus ads/anti-scrape junk to discard
 *   #footlink a.prevlink/.nextlink   "上一页/上一章" and "下一页/下一章/返回目录"
 *   <script> var ReadParams = {url_previous:'…', url_next:'…', articleid:'…',
 *                              chapterid:'…', articlename:'…', chaptername:'…'}
 *   <script src="/scripts/chapterlog.js?v…">  paragraph shuffle (see deobfuscate.ts)
 */

import { ContentUnavailableError, ParseError, type ChapterNav, type PageContent, type PageRef, type Paragraph } from "../types";
import {
  DEFAULT_SHUFFLE_TEMPLATE,
  decodeText,
  hasUnmappedPua,
  normalizeImageUrl,
  restoreParagraphOrder,
  type ShuffleTemplate,
} from "./deobfuscate";
import { classifyNext, pageCountFromTitle, stripPageSuffix } from "./pagination";
import { buildPageUrl, parseChapterUrl, resolveHref } from "./url";
import { log } from "../../utils/log";

const CONTENT_SELECTORS = ["#acontent", "#TextContent", ".bcontent", "[id^='acontent']"];

/** Junk removed before the shuffle restore (none of these are counted by chapterlog.js). */
const PRE_RESTORE_JUNK = ["script", "ins", "figure", "fig", "iframe", ".tp", ".bd", ".dag", ".google-auto-placed"];
/** Junk removed after the shuffle restore. */
const POST_RESTORE_JUNK = ["style", "noscript", "link", ".ca1", "#show-more-images", "#hidden-images"];

/** Text shown by the site instead of content when it refuses the client. */
const BLOCKED_KEYWORDS = [
  "內容加載失敗",
  "内容加载失败",
  "請重載",
  "请重载",
  "更換瀏覽器",
  "更换浏览器",
  "相容性問題",
  "不支持電腦端閱讀",
  "請使用手機閱讀",
  "请使用手机阅读",
];

/** Readable characters beyond the notice that make a page real content. */
const MIN_REAL_TEXT = 20;
/** A hidden notice element is short; a longer one holds other text too, so only its text node goes. */
const MAX_NOTICE_LENGTH = 80;
const INERT = new Set(["SCRIPT", "STYLE", "NOSCRIPT", "TEMPLATE"]);

/** The nodes inside `content` that show the site's "failed to load" text. */
function blockedNotices(content: Element): Node[] {
  const found = new Set<Node>();
  const walk = (node: Node) => {
    for (const child of Array.from(node.childNodes)) {
      if (child.nodeType === 3) {
        const text = child.nodeValue ?? "";
        if (!BLOCKED_KEYWORDS.some((k) => text.includes(k))) continue;
        const parent = child.parentElement;
        const short = !!parent && parent !== content && (parent.textContent ?? "").trim().length <= MAX_NOTICE_LENGTH;
        if (hiddenWithin(child, content)) found.add(short ? parent : child);
        // A visible notice: its element goes only when it holds nothing else.
        else if (parent && parent !== content && outsideNotice(parent.textContent ?? "") <= MAX_NOTICE_EXTRA) found.add(parent);
        else found.add(isolateNotice(child as Text));
      } else if (child.nodeType === 1) {
        walk(child);
      }
    }
  };
  walk(content);
  return [...found];
}

/** Characters besides the notice (e.g. 「抱歉，」) an element showing it may hold. */
const MAX_NOTICE_EXTRA = 4;
const NOTICE_OPEN = /[（(【[]\s*$/;
const NOTICE_CLOSE = /^[\s！!。.，,、]*[）)】\]]?\s*/;

/**
 * Splits the notice off a text node that also holds chapter text, e.g. the
 * last paragraph of a page the site cut short: 「…我这么心想……（內容加載失敗！
 * 請刷新或更換瀏覽器）」. Returns the node holding only the notice; the text
 * around it stays.
 */
function isolateNotice(node: Text): Text {
  const text = node.nodeValue ?? "";
  const [start, end] = noticeSpan(text);
  if (end < text.length) node.splitText(end);
  return start > 0 ? node.splitText(start) : node;
}

/** Where the notice is in `text` (from its first keyword to its last, with brackets and punctuation). */
function noticeSpan(text: string): [number, number] {
  let start = text.length;
  let end = 0;
  for (const k of BLOCKED_KEYWORDS) {
    for (let i = text.indexOf(k); i >= 0; i = text.indexOf(k, i + k.length)) {
      start = Math.min(start, i);
      end = Math.max(end, i + k.length);
    }
  }
  if (end <= start) return [text.length, text.length];
  start -= NOTICE_OPEN.exec(text.slice(0, start))?.[0].length ?? 0;
  end += NOTICE_CLOSE.exec(text.slice(end))?.[0].length ?? 0;
  return [start, end];
}

/** Non-whitespace characters of `text` outside its notice. */
function outsideNotice(text: string): number {
  const [start, end] = noticeSpan(text);
  return (text.slice(0, start) + text.slice(end)).replace(/\s+/g, "").length;
}

/** Is `node` inside a hidden or inert element of `content`? */
function hiddenWithin(node: Node, content: Element): boolean {
  for (let el = node.nodeType === 1 ? (node as Element) : node.parentElement; el && el !== content; el = el.parentElement) {
    if (INERT.has(el.tagName.toUpperCase()) || isHidden(el)) return true;
  }
  return false;
}

/** Visible, non-whitespace characters of `node`, leaving out `skip`. */
function readableLength(node: Node, skip: Set<Node>): number {
  if (skip.has(node)) return 0;
  if (node.nodeType === 3) return (node.nodeValue ?? "").replace(/\s+/g, "").length;
  if (node.nodeType !== 1) return 0;
  const el = node as Element;
  if (INERT.has(el.tagName.toUpperCase()) || isHidden(el)) return 0;
  let n = 0;
  for (const child of Array.from(el.childNodes)) n += readableLength(child, skip);
  return n;
}

const ANTI_SCRAPE_TAG = /^[a-z]\d{4}$/i;

export interface ParseOptions {
  /**
   * Shuffle constants to use when the page includes chapterlog.js. `undefined`
   * means "use defaults"; `null` disables the restore (the DOM is already in
   * reading order, e.g. the live page after the site's scripts ran).
   */
  shuffle?: ShuffleTemplate | null;
}

export type ReadParams = Record<string, string>;

/** Extracts `ReadParams = {key:'value', ...}` from inline scripts. */
export function extractReadParams(doc: Document): ReadParams {
  const params: ReadParams = {};
  for (const script of Array.from(doc.querySelectorAll("script:not([src])"))) {
    const text = script.textContent ?? "";
    const idx = text.indexOf("ReadParams");
    if (idx < 0) continue;
    const body = text.slice(idx, text.indexOf("}", idx) + 1 || undefined);
    const re = /([A-Za-z_$][\w$]*)\s*:\s*(?:'((?:[^'\\]|\\.)*)'|"((?:[^"\\]|\\.)*)"|(-?\d+))/g;
    for (let m = re.exec(body); m; m = re.exec(body)) {
      params[m[1]] = (m[2] ?? m[3] ?? m[4] ?? "").replace(/\\(.)/g, "$1");
    }
    if (Object.keys(params).length) break;
  }
  return params;
}

/** Returns the absolute chapterlog.js URL if the page shuffles paragraphs. */
export function findChapterLogScript(doc: Document, base: URL): string | undefined {
  for (const s of Array.from(doc.querySelectorAll("script[src]"))) {
    const src = s.getAttribute("src") ?? "";
    if (/chapterlog\.js/i.test(src)) return resolveHref(src, base);
  }
  return undefined;
}

function textOf(el: Element | null | undefined): string {
  return el ? decodeText(el.textContent ?? "") : "";
}

function meta(doc: Document, property: string): string {
  const el = doc.querySelector(`meta[property='${property}'], meta[name='${property}']`);
  return decodeText(el?.getAttribute("content") ?? "");
}

export function findContent(doc: Document): Element | null {
  for (const sel of CONTENT_SELECTORS) {
    const el = doc.querySelector(sel);
    if (el) return el;
  }
  return null;
}

/** Set on elements found to be invisible (computed style or page CSS rules). */
export const HIDDEN_ATTR = "data-br-hidden";

function isHidden(el: Element): boolean {
  if (el.hasAttribute("hidden") || el.hasAttribute(HIDDEN_ATTR)) return true;
  const style = (el.getAttribute("style") ?? "").replace(/\s+/g, "").toLowerCase();
  return style.includes("display:none") || style.includes("visibility:hidden");
}

/**
 * Marks elements hidden by the page's own CSS (`<style>` text). The site's
 * chapterlog.js inserts decoy copies of earlier paragraphs and hides them
 * with a class rule; in a rendered page they must be skipped.
 */
export function markStyleRuleHidden(doc: Document): void {
  const css = Array.from(doc.querySelectorAll("style"))
    .map((s) => s.textContent ?? "")
    .join("\n")
    .replace(/\/\*[\s\S]*?\*\//g, "");
  const ruleRe = /([^{}@]+)\{([^{}]*)\}/g;
  for (let m = ruleRe.exec(css); m; m = ruleRe.exec(css)) {
    const body = m[2].replace(/\s+/g, "").toLowerCase();
    if (!/display:none|visibility:hidden/.test(body)) continue;
    for (const selector of m[1].split(",")) {
      const sel = selector.trim();
      if (!sel || !/acontent|TextContent|^\.|^p\b/.test(sel)) continue; // only rules that can affect the body text
      try {
        doc.querySelectorAll(sel).forEach((el) => el.setAttribute(HIDDEN_ATTR, ""));
      } catch {
        /* unsupported selector */
      }
    }
  }
}

const TRANSPARENT = /^(transparent|rgba\([^)]*,\s*0(\.0+)?\))$/i;

/**
 * Is a rendered element invisible to the reader? Covers the usual ways of
 * hiding text: display/visibility/opacity, zero font size, transparent
 * colour, zero-size or clipped boxes, and positions far outside the content.
 * Geometry checks only apply when layout is available (`contentRect`).
 */
export function isInvisible(el: Element, win: Window, contentRect?: DOMRect): boolean {
  const cs = win.getComputedStyle(el);
  if (cs.display === "none" || cs.visibility === "hidden" || cs.visibility === "collapse") return true;
  if (parseFloat(cs.opacity) === 0) return true;
  const check = (el as Element & { checkVisibility?: (o?: object) => boolean }).checkVisibility;
  if (typeof check === "function" && !check.call(el, { opacityProperty: true, visibilityProperty: true })) return true;
  const tag = el.tagName.toLowerCase();
  if (tag === "img" || !el.textContent?.trim()) return false;
  if (parseFloat(cs.fontSize) < 2) return true;
  if (TRANSPARENT.test(cs.color.trim())) return true;
  if (/^rect\(0(px)?,?\s*0(px)?,?\s*0(px)?,?\s*0(px)?\)$/.test(cs.clip) || /inset\((50|100)%\)/.test(cs.clipPath)) return true;
  if (contentRect && contentRect.width > 0 && contentRect.height > 0) {
    const r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) return true;
    const margin = 40;
    if (r.right < contentRect.left - margin || r.left > contentRect.right + margin) return true;
    if (r.bottom < contentRect.top - margin || r.top > contentRect.bottom + margin) return true;
  }
  return false;
}

/**
 * Marks invisible elements of a rendered tree onto `target` (the same tree,
 * or an unmodified deep clone of it, so the live page is never touched).
 * Returns the number of invisible non-empty paragraphs.
 */
export function markComputedHidden(live: Element, target: Element, win: Window): number {
  const liveEls = live.querySelectorAll("*");
  const targetEls = target === live ? liveEls : target.querySelectorAll("*");
  if (liveEls.length !== targetEls.length) return 0;
  const contentRect = live.getBoundingClientRect();
  let n = 0;
  liveEls.forEach((el, i) => {
    if (isInvisible(el, win, contentRect)) {
      targetEls[i].setAttribute(HIDDEN_ATTR, "");
      if (el.tagName.toLowerCase() === "p" && el.textContent?.trim()) n++;
    }
  });
  return n;
}

/** Replaces wrapper divs by the images they contain; removes other divs (ads, widgets). */
function hoistImagesAndDropDivs(content: Element): void {
  for (const div of Array.from(content.querySelectorAll("div"))) {
    if (!div.isConnected || !content.contains(div)) continue;
    const imgs = Array.from(div.querySelectorAll("img"));
    if (imgs.length && !isHidden(div)) div.replaceWith(...imgs);
    else div.remove();
  }
}

function removeAntiScrapeTags(root: Element): void {
  for (const el of Array.from(root.querySelectorAll("*"))) {
    if (ANTI_SCRAPE_TAG.test(el.tagName)) el.remove();
  }
}

function imageSrc(img: Element, base: URL): string | undefined {
  for (const attr of ["data-src", "data-original", "data-lazy-src", "src"]) {
    const url = normalizeImageUrl(img.getAttribute(attr), base);
    if (url && !/(loading|lazy|placeholder|blank)\.(gif|png|svg)/i.test(url)) return url;
  }
  return undefined;
}

type Block = { text: string } | { imageUrl: string };

/** Flattens the cleaned content element into ordered text/image blocks. */
function flatten(content: Element, base: URL): Block[] {
  const blocks: Block[] = [];
  let inline = "";
  const flush = () => {
    const text = decodeText(inline);
    if (text) blocks.push({ text });
    inline = "";
  };
  const walkBlock = (el: Element) => {
    // A block may contain <br>-separated lines and inline images.
    for (const node of Array.from(el.childNodes)) visit(node);
    flush();
  };
  const visit = (node: Node) => {
    if (node.nodeType === 3) {
      inline += node.textContent ?? "";
      return;
    }
    if (node.nodeType !== 1) return;
    const el = node as Element;
    if (isHidden(el)) return;
    const tag = el.tagName.toLowerCase();
    if (tag === "br") return flush();
    if (tag === "img") {
      flush();
      const url = imageSrc(el, base);
      if (url) blocks.push({ imageUrl: url });
      return;
    }
    if (/^(p|h[1-6]|blockquote|section|article|li|center)$/.test(tag)) {
      flush();
      walkBlock(el);
      return;
    }
    // Inline element (span, font, ruby, a, ...): descend.
    for (const child of Array.from(el.childNodes)) visit(child);
  };
  for (const node of Array.from(content.childNodes)) visit(node);
  flush();
  return blocks;
}

const NEXT_TEXT = /下一[页頁章节節]/;

/** Next URL from ReadParams (preferred) or the footer, plus the matching link's text. */
function findNext(doc: Document, base: URL, rp: ReadParams): { nextUrl?: string; linkText?: string } {
  const anchors = Array.from(doc.querySelectorAll("#footlink a, .mlfy_page a, a.nextlink"));
  const fallback =
    doc.querySelector("a.nextlink") ?? anchors.find((a) => NEXT_TEXT.test(a.textContent ?? "")) ?? null;
  const nextUrl = resolveHref(rp.url_next, base) ?? resolveHref(fallback?.getAttribute("href"), base);
  if (!nextUrl) return {};
  const match = anchors.find((a) => resolveHref(a.getAttribute("href"), base) === nextUrl);
  return { nextUrl, linkText: match?.textContent?.trim() || undefined };
}

const PREV_TEXT = /上一[页頁章节節]/;

/** The site's "previous" link (ReadParams preferred), if it points at a page of the same book. */
function findPrev(doc: Document, base: URL, rp: ReadParams, bookId: string): PageRef | undefined {
  const anchor =
    doc.querySelector("a.prevlink") ??
    Array.from(doc.querySelectorAll("#footlink a, .mlfy_page a")).find((a) => PREV_TEXT.test(a.textContent ?? ""));
  const url = resolveHref(rp.url_previous, base) ?? resolveHref(anchor?.getAttribute("href"), base);
  const info = url ? parseChapterUrl(url) : null;
  if (!url || !info || info.bookId !== bookId) return undefined;
  return { url, chapterId: info.chapterId, pageIndex: info.pageIndex };
}

/** Title and chapter links of a page, read without its content (also from error pages). */
function pageNav(doc: Document, url: URL, rp: ReadParams, current: { bookId: string; chapterId: string; pageIndex: number }): ChapterNav {
  const nav: ChapterNav = { bookId: current.bookId, chapterId: current.chapterId };
  const title =
    stripPageSuffix(textOf(doc.querySelector("#atitle"))) || stripPageSuffix(decodeText(rp.chaptername ?? ""));
  if (title && current.pageIndex === 0) nav.title = title;
  const prev = findPrev(doc, url, rp, current.bookId);
  if (prev && prev.chapterId !== current.chapterId) nav.prevChapterId = prev.chapterId;
  const { nextUrl, linkText } = findNext(doc, url, rp);
  const next = classifyNext({ current, nextUrl, linkText });
  const info = next.nextType === "next-chapter" && next.nextUrl ? parseChapterUrl(next.nextUrl) : null;
  if (info) nav.nextChapterId = info.chapterId;
  return nav;
}

/**
 * Parses a Bilinovel chapter page. `doc` is modified (junk removed, paragraphs
 * reordered) so pass a disposable document, not the live page.
 */
export function parseBilinovelDocument(doc: Document, url: URL, options: ParseOptions = {}): PageContent {
  const href = url.href;
  const urlInfo = parseChapterUrl(url);
  const rp = extractReadParams(doc);

  const bookId = rp.articleid || urlInfo?.bookId;
  const chapterId = rp.chapterid || urlInfo?.chapterId;
  if (!bookId || !chapterId) throw new ParseError("Not a Bilinovel chapter page", href);
  const pageIndex = urlInfo && urlInfo.chapterId === chapterId ? urlInfo.pageIndex : 0;

  const content = findContent(doc);
  if (!content) throw new ParseError("Chapter content element not found", href);
  markStyleRuleHidden(doc);

  const rawText = content.textContent ?? "";
  let incomplete = false;
  if (BLOCKED_KEYWORDS.filter((k) => rawText.includes(k)).length >= 2) {
    const notices = blockedNotices(content);
    if (readableLength(content, new Set(notices)) < MIN_REAL_TEXT) {
      const shown = notices.map((n) => n.textContent ?? "").join(" ") || rawText;
      throw new ContentUnavailableError(
        "The site returned a 'content failed to load' page instead of the chapter",
        href,
        pageNav(doc, url, rp, { bookId, chapterId, pageIndex }),
        shown.replace(/\s+/g, " ").trim().slice(0, 200),
      );
    }
    // A visible notice next to text: the site sent only the start of the page
    // (its scripts load the rest). Keep what came, marked incomplete. A notice
    // the reader cannot see (hidden, noscript) is only a fallback.
    incomplete = notices.some((n) => readableLength(n, new Set()) > 0 && !hiddenWithin(n, content));
    for (const n of notices) n.parentNode?.removeChild(n);
  }

  for (const sel of PRE_RESTORE_JUNK) content.querySelectorAll(sel).forEach((el) => el.remove());
  hoistImagesAndDropDivs(content);
  removeAntiScrapeTags(content);

  if (options.shuffle !== null && findChapterLogScript(doc, url)) {
    const template = options.shuffle ?? DEFAULT_SHUFFLE_TEMPLATE;
    const cid = Number(chapterId);
    if (Number.isFinite(cid)) restoreParagraphOrder(content, cid, template);
  }

  for (const sel of POST_RESTORE_JUNK) content.querySelectorAll(sel).forEach((el) => el.remove());

  const blocks = flatten(content, url);
  if (!blocks.length) throw new ParseError("Chapter content is empty", href);

  const paragraphs: Paragraph[] = blocks.map((b, i) => ({ id: `${chapterId}:${pageIndex}:${i}`, ...b }));
  if (paragraphs.some((p) => p.text && hasUnmappedPua(p.text))) {
    log.warn("Some characters could not be de-obfuscated (private-use-area code points remain)", href);
  }

  const rawTitle = textOf(doc.querySelector("#atitle"));
  const chapterTitle =
    stripPageSuffix(rawTitle) ||
    stripPageSuffix(decodeText(rp.chaptername ?? "")) ||
    stripPageSuffix(textOf(doc.querySelector("#mlfy_main_text h1, h1"))) ||
    "";

  const bookTitle =
    decodeText(rp.articlename ?? "") ||
    meta(doc, "og:novel:book_name") ||
    textOf(doc.querySelector("#bookname, .book-title, .atitle-book")) ||
    decodeText((doc.title || "").split(/[_|\-–]/)[1] ?? "") ||
    "";

  const { nextUrl: nextAbs, linkText } = findNext(doc, url, rp);
  const { nextType, nextUrl } = classifyNext({
    current: { bookId, chapterId, pageIndex },
    nextUrl: nextAbs,
    linkText,
  });

  return {
    bookId,
    bookTitle,
    chapterId,
    chapterTitle,
    pageIndex,
    url: href,
    paragraphs,
    nextUrl,
    nextType,
    chapterUrl: buildPageUrl(url.origin, bookId, chapterId, 0),
    pageCount: pageCountFromTitle(rawTitle) ?? (nextType === "same-chapter-page" ? undefined : pageIndex + 1),
    prev: findPrev(doc, url, rp, bookId),
    ...(incomplete ? { incomplete: true } : {}),
  };
}
