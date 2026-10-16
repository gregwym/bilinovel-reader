import type { PageContent } from "../../src/adapters/types";
import type { ChapterSegments } from "../shared/api";

/**
 * Chapters saved on this device for reading and listening without the
 * server: their pages, illustrations and the current voice's segments go
 * into a cache that the service worker (public/sw.js) answers from when the
 * server can't be reached. The reader asks for the same URLs either way.
 */

/** Cache of saved content; the name is shared with public/sw.js. */
const CACHE = "offline-v1";
const INDEX_KEY = "offline.index";
/** A chapter has a few pages; more means the site's page links loop. */
const MAX_PAGES = 60;

export interface SavedChapter {
  bytes: number;
  /** Segments saved / segments of the chapter (in the voice current when saved). */
  segments: number;
  total: number;
  at: number;
}

type Index = Record<string, Record<string, SavedChapter>>;

export const offlineSupported = typeof caches !== "undefined";

function readIndex(): Index {
  try {
    return (JSON.parse(localStorage.getItem(INDEX_KEY) ?? "{}") as Index) ?? {};
  } catch {
    return {};
  }
}

function writeIndex(index: Index): void {
  try {
    localStorage.setItem(INDEX_KEY, JSON.stringify(index));
  } catch {
    // Private mode: saved content works, it just isn't listed.
  }
}

/** Chapters of a book saved on this device. */
export function savedChapters(bookId: string): Record<string, SavedChapter> {
  return readIndex()[bookId] ?? {};
}

/** Every saved chapter, by book. */
export function savedBooks(): Index {
  return readIndex();
}

/** Fetches `path` and keeps the response; returns its size. */
async function keep(cache: Cache, path: string): Promise<{ res: Response; bytes: number }> {
  const res = await fetch(path, { credentials: "same-origin" });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const body = await res.clone().blob();
  await cache.put(path, res.clone());
  return { res, bytes: body.size };
}

/** What the reader needs besides chapters: app info, the catalog, the book and the shelf (for the pages around it). */
async function saveBook(cache: Cache, bookId: string): Promise<void> {
  await Promise.all(
    ["/api/info", "/api/books", `/api/books/${bookId}`, `/api/catalog/${bookId}`, `/api/books/${bookId}/cover`].map((p) =>
      keep(cache, p).catch(() => undefined),
    ),
  );
}

/**
 * Saves a chapter: every page (fetched from the site by the server if it
 * hasn't been yet), its illustrations, and the segments of the current voice
 * that are generated. Returns what was saved.
 */
export async function saveChapter(bookId: string, chapterId: string, withBook = true): Promise<SavedChapter> {
  const cache = await caches.open(CACHE);
  void navigator.storage?.persist?.().catch(() => false);
  if (withBook) await saveBook(cache, bookId);
  let bytes = 0;
  for (let page = 0; page < MAX_PAGES; page++) {
    const { res, bytes: n } = await keep(cache, `/api/page?book=${bookId}&chapter=${chapterId}&page=${page}`);
    bytes += n;
    const data = (await res.json()) as PageContent;
    for (const p of data.paragraphs) {
      // The same URL as the reader's <img> (reader.ts).
      if (p.imageUrl) bytes += (await keep(cache, `/api/img?url=${encodeURIComponent(p.imageUrl)}`).catch(() => ({ bytes: 0 }))).bytes;
    }
    if (data.nextType !== "same-chapter-page") break;
  }
  let segments = 0;
  let total = 0;
  const list = await fetch(`/api/books/${bookId}/chapters/${chapterId}/segments`, { credentials: "same-origin" })
    .then((r) => (r.ok ? (r.json() as Promise<ChapterSegments>) : undefined))
    .catch(() => undefined);
  if (list) {
    total = list.segments.length;
    for (const seg of list.segments) {
      if (!seg.ready) continue;
      // The same URL the reader asks for (serverStore in reader.ts).
      const got = await keep(cache, `/api/segments/${list.provider}/${encodeURIComponent(seg.key)}`).catch(() => undefined);
      if (!got) continue;
      bytes += got.bytes;
      segments++;
    }
  }
  const saved: SavedChapter = { bytes, segments, total, at: Date.now() };
  const index = readIndex();
  index[bookId] = { ...index[bookId], [chapterId]: saved };
  writeIndex(index);
  return saved;
}

/** Saves chapters one after another; `progress` is told after each. */
export async function saveChapters(
  bookId: string,
  chapterIds: string[],
  progress: (done: number) => void,
): Promise<{ saved: number; failed: number; bytes: number }> {
  const cache = await caches.open(CACHE);
  await saveBook(cache, bookId);
  let saved = 0;
  let failed = 0;
  let bytes = 0;
  for (const id of chapterIds) {
    try {
      bytes += (await saveChapter(bookId, id, false)).bytes;
      saved++;
    } catch {
      failed++;
    }
    progress(saved + failed);
  }
  return { saved, failed, bytes };
}

/** Removes saved chapters (all of a book's without `chapterIds`, or everything without `bookId`). */
export async function removeSaved(bookId?: string, chapterIds?: string[]): Promise<void> {
  const index = readIndex();
  if (!bookId) {
    await caches.delete(CACHE);
    writeIndex({});
    return;
  }
  const ids = new Set(chapterIds ?? Object.keys(index[bookId] ?? {}));
  const book = Object.fromEntries(Object.entries(index[bookId] ?? {}).filter(([id]) => !ids.has(id)));
  if (Object.keys(book).length) index[bookId] = book;
  else delete index[bookId];
  writeIndex(index);
  const cache = await caches.open(CACHE);
  for (const req of await cache.keys()) {
    const url = new URL(req.url);
    const page = url.pathname === "/api/page" && url.searchParams.get("book") === bookId && ids.has(url.searchParams.get("chapter") ?? "");
    if (page) await cache.delete(req);
  }
  // Segments and illustrations aren't tied to a chapter by URL: keep the ones another saved chapter uses.
  await prune(cache, index);
}

/** Deletes segments and illustrations no saved page refers to. */
async function prune(cache: Cache, index: Index): Promise<void> {
  const used = new Set<string>();
  const keys = await cache.keys();
  for (const req of keys) {
    const url = new URL(req.url);
    if (url.pathname !== "/api/page") continue;
    const data = (await (await cache.match(req))?.json().catch(() => undefined)) as PageContent | undefined;
    for (const p of data?.paragraphs ?? []) if (p.imageUrl) used.add(`/api/img?url=${encodeURIComponent(p.imageUrl)}`);
  }
  const books = new Set(Object.keys(index));
  for (const req of keys) {
    const url = new URL(req.url);
    const path = url.pathname + url.search;
    if (url.pathname === "/api/img" && !used.has(path)) await cache.delete(req);
    const book = /^\/api\/(?:books|catalog)\/(\d+)/.exec(url.pathname)?.[1];
    if (book && !books.has(book)) await cache.delete(req);
  }
  // Segment keys hash the texts: the segments of the remaining chapters are listed again by the server.
  if (!books.size) {
    await caches.delete(CACHE);
    return;
  }
  const keepSegs = new Set<string>();
  let listed = true;
  for (const [bookId, chapters] of Object.entries(index)) {
    for (const chapterId of Object.keys(chapters)) {
      const list = await fetch(`/api/books/${bookId}/chapters/${chapterId}/segments`, { credentials: "same-origin" })
        .then((r) => (r.ok ? (r.json() as Promise<ChapterSegments>) : undefined))
        .catch(() => undefined);
      if (!list) listed = false;
      for (const seg of list?.segments ?? []) keepSegs.add(`/api/segments/${list!.provider}/${encodeURIComponent(seg.key)}`);
    }
  }
  // Offline (or the server failed): keep the segments rather than delete ones still needed.
  if (!listed) return;
  for (const req of keys) {
    const url = new URL(req.url);
    if (url.pathname.startsWith("/api/segments/") && !keepSegs.has(url.pathname)) await cache.delete(req);
  }
}

/** Space used by this site on the device (all caches and storage), when the browser tells. */
export async function usage(): Promise<number | undefined> {
  return (await navigator.storage?.estimate?.().catch(() => undefined))?.usage;
}
