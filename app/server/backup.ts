import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync } from "node:fs";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { Catalog, PageContent } from "../../src/adapters/types";
import type { SavedProgress } from "../../src/reader/ProgressStore";
import type { Db } from "./db";
import type { Images } from "./images";
import { bookCatalog, findChapter, type BookRow, type ChapterAudioRow, type Library } from "./library";
import type { SiteSource } from "./site/source";

/**
 * The library as a whole backup of the books: besides the audio, each
 * chapter's text as Markdown (illustrations saved next to it and linked), and
 * the data a new install needs to read and listen from the library alone —
 * book details, catalog, reading position, the cached pages exactly as
 * parsed (the spoken text and so the audio's keys are built from them), and
 * where each audio segment is inside its chapter file. That data is in the
 * book's folder (`author/book/.bili-reader/`, a name the storage template
 * can't make), so a book's folder holds the whole book; the reader's settings
 * are in `.bili-reader/` at the top of the library. It is read back when the
 * database lacks it.
 */

export const BACKUP_DIR = ".bili-reader";
const FORMAT = 1;
const PROGRESS_KEY = "biliReader.progress";
/**
 * Settings kept with the books: the reader's (voice, speed, display; API
 * keys are not among them) and the Gemini reading directions, whose hashes
 * name the stored audio.
 */
const SETTINGS_KEYS = ["biliReader.settings", "server.geminiStyles"];

export interface BookBackup {
  format: number;
  id: string;
  title: string;
  author: string;
  intro: string;
  coverUrl: string | null;
  catalog: Catalog | null;
  catalogAt: number | null;
  addedAt: number;
  readAt: number | null;
  follow: boolean;
  ahead: number;
  progress?: SavedProgress;
}

export interface SegmentBackup {
  key: string;
  start: number;
  bytes: number;
  mime: string;
  bounds: number[];
  boundsVersion: number;
  chars: number;
  createdAt: number;
}

export interface ChapterBackup {
  format: number;
  bookId: string;
  chapterId: string;
  title: string;
  /** The Markdown file, relative to the library. */
  text: string;
  /** The site sent only part of a page. */
  incomplete?: boolean;
  pages: { fetchedAt: number; page: PageContent }[];
  images: { url: string; file: string; type: string }[];
  audio?: {
    /** Relative to the library; empty for a chapter with nothing to read aloud. */
    file: string;
    profile: string;
    bytes: number;
    duration: number | null;
    updatedAt: number;
    segments: SegmentBackup[];
  };
}

interface BackupRow {
  book_id: string;
  chapter_id: string;
  file: string;
  hash: string;
  bytes: number;
  incomplete: number;
  images_missing: number;
}

interface ImageRow {
  url: string;
  file: string;
  type: string;
  bytes: number;
}

const sha1 = (s: string) => createHash("sha1").update(s).digest("hex");

const IMAGE_EXT: Record<string, string> = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp", "image/gif": "gif", "image/avif": "avif" };

/** Text as Markdown that shows as written (characters Markdown would treat as syntax are escaped). */
export function escapeMarkdown(s: string): string {
  return s
    .replace(/[\\`*_[\]<>|~]/g, (c) => `\\${c}`)
    .replace(/^(\s*)([#>+-]|\d+[.)])/, (_, sp: string, mark: string) => `${sp}${mark.replace(/^(\d*)(.)$/, "$1\\$2")}`);
}

/** A chapter as Markdown: its title, then each paragraph; illustrations link to `image(url)`. */
export function chapterMarkdown(title: string, pages: PageContent[], image: (url: string) => string): string {
  const blocks = pages
    .flatMap((p) => p.paragraphs)
    .flatMap((p) => (p.text?.trim() ? [escapeMarkdown(p.text.trim())] : p.imageUrl ? [`![插图](<${image(p.imageUrl)}>)`] : []));
  return `${[`# ${escapeMarkdown(title)}`, ...blocks].join("\n\n")}\n`;
}

async function writeAtomic(file: string, data: string | Buffer): Promise<void> {
  await mkdir(dirname(file), { recursive: true });
  await writeFile(`${file}.part`, data);
  await rename(`${file}.part`, file);
}

export class Backup {
  private queue: Promise<unknown> = Promise.resolve();
  private readonly bookTimers = new Map<string, NodeJS.Timeout>();

  constructor(
    private readonly db: Db,
    private readonly library: Library,
    private readonly source: SiteSource,
    private readonly images: Images,
  ) {}

  private abs(rel: string): string {
    return this.library.abs(rel);
  }

  private dirKey = (bookId: string) => `backup.dir:${bookId}`;

  /** The book's data folder (absolute): in the book's folder where it was last written, else where it goes. */
  private metaDir(bookId: string): string | undefined {
    const book = this.library.book(bookId);
    const folder = this.db.getKv(this.dirKey(bookId)) ?? (book && this.library.bookDir(book));
    return folder && join(this.abs(folder), BACKUP_DIR);
  }

  private chapterFile(bookId: string, chapterId: string): string | undefined {
    const dir = this.metaDir(bookId);
    return dir && join(dir, "chapters", `${chapterId}.json`);
  }

  /**
   * Keeps the book's data in its folder: when the folder changes (the book
   * was renamed on the site), the data and the audio move to the new one.
   */
  private async ensureFolder(book: BookRow): Promise<string> {
    const folder = this.library.bookDir(book);
    const prev = this.db.getKv(this.dirKey(book.id));
    if (prev === folder) return join(this.abs(folder), BACKUP_DIR);
    const meta = join(this.abs(folder), BACKUP_DIR);
    if (prev) {
      const old = join(this.abs(prev), BACKUP_DIR);
      if (existsSync(old)) {
        if (existsSync(meta)) await rm(old, { recursive: true, force: true });
        else {
          await mkdir(this.abs(folder), { recursive: true });
          await rename(old, meta);
        }
      }
    }
    this.db.setKv(this.dirKey(book.id), folder);
    if (prev) {
      await this.library.relayout(book.id);
      await this.library.pruneDirs(this.abs(prev));
    }
    return meta;
  }

  /** Runs backup work one task at a time; a failure is logged and gives `fallback`. */
  private serial<T>(fn: () => Promise<T>, fallback: T): Promise<T> {
    const run = this.queue.then(fn).catch((err: unknown) => {
      console.warn("[backup]", err instanceof Error ? err.message : String(err));
      return fallback;
    });
    this.queue = run;
    return run;
  }

  /** Writes a chapter's text and data if new or changed; true if written. */
  saveChapter(bookId: string, chapterId: string): Promise<boolean> {
    return this.serial(() => this.writeChapter(bookId, chapterId), false);
  }

  /** Writes a book's details and every chapter that is new or changed; resolves to how many chapters were written. */
  saveBook(bookId: string): Promise<number> {
    return this.serial(() => this.writeBookAll(bookId), 0);
  }

  /** Every book (also writes again what is missing on disk). */
  saveAll(): Promise<number> {
    return this.serial(async () => {
      await this.writeSettings();
      let n = 0;
      for (const { id } of this.db.all<{ id: string }>("select id from books")) n += await this.writeBookAll(id);
      return n;
    }, 0);
  }

  /** A book's details (reading position, settings) changed: written a little later, once for many changes. */
  bookChanged(bookId: string, delayMs = 30_000): void {
    if (this.bookTimers.has(bookId)) return;
    const timer = setTimeout(() => {
      this.bookTimers.delete(bookId);
      void this.serial(() => (bookId ? this.writeBook(bookId) : this.writeSettings()), false);
    }, delayMs);
    timer.unref?.();
    this.bookTimers.set(bookId, timer);
  }

  /** The reader's settings changed: written a little later. */
  settingsChanged(delayMs = 30_000): void {
    this.bookChanged("", delayMs);
  }

  private settingsFile(): string {
    return join(this.library.dir, BACKUP_DIR, "settings.json");
  }

  private async writeSettings(): Promise<boolean> {
    const values: Record<string, string> = {};
    for (const key of SETTINGS_KEYS) {
      const v = this.db.getKv(key);
      if (v !== undefined) values[key] = v;
    }
    if (!Object.keys(values).length) return false;
    const json = JSON.stringify({ format: FORMAT, values });
    const file = this.settingsFile();
    if (existsSync(file) && (await readFile(file, "utf8")) === json) return false;
    await writeAtomic(file, json);
    return true;
  }

  private restoreSettings(): void {
    try {
      const saved = JSON.parse(readFileSync(this.settingsFile(), "utf8")) as { format: number; values: Record<string, string> };
      if (saved.format !== FORMAT) return;
      for (const key of SETTINGS_KEYS) {
        if (typeof saved.values[key] === "string" && this.db.getKv(key) === undefined) this.db.setKv(key, saved.values[key]);
      }
    } catch {
      // None saved yet.
    }
  }

  /** Waits for the work queued so far. */
  async idle(): Promise<void> {
    await this.serial(async () => undefined, undefined);
  }

  /** Removes a book's text, illustrations and data (when the book is removed). */
  removeBook(bookId: string): Promise<void> {
    clearTimeout(this.bookTimers.get(bookId));
    this.bookTimers.delete(bookId);
    return this.serial(async () => {
      for (const row of this.db.all<{ file: string }>("select file from backup_images where book_id = ?", bookId)) {
        await this.library.removeFile(row.file);
      }
      for (const row of this.db.all<{ file: string }>("select file from chapter_backup where book_id = ?", bookId)) {
        await this.library.removeFile(row.file);
      }
      const folder = this.db.getKv(this.dirKey(bookId));
      if (folder) {
        await rm(join(this.abs(folder), BACKUP_DIR), { recursive: true, force: true });
        await this.library.pruneDirs(this.abs(folder));
      }
      this.db.setKv(this.dirKey(bookId), undefined);
      this.db.run("delete from backup_images where book_id = ?", bookId);
      this.db.run("delete from chapter_backup where book_id = ?", bookId);
    }, undefined);
  }

  private readChapter(file: string | undefined): ChapterBackup | undefined {
    try {
      const data = file ? (JSON.parse(readFileSync(file, "utf8")) as ChapterBackup) : undefined;
      return data?.format === FORMAT ? data : undefined;
    } catch {
      return undefined;
    }
  }

  /** A page as saved in the library (when the database and the site don't have it). */
  page(bookId: string, chapterId: string, pageIndex: number): { fetchedAt: number; page: PageContent } | undefined {
    return this.readChapter(this.chapterFile(bookId, chapterId))?.pages.find((p) => p.page.pageIndex === pageIndex);
  }

  private async writeBookAll(bookId: string): Promise<number> {
    await this.writeBook(bookId);
    const book = this.library.book(bookId);
    let n = 0;
    for (const vol of (book && bookCatalog(book)?.volumes) ?? []) {
      for (const ch of vol.chapters) if (ch.chapterId && (await this.writeChapter(bookId, ch.chapterId))) n++;
    }
    return n;
  }

  private async writeBook(bookId: string): Promise<boolean> {
    const book = this.library.book(bookId);
    if (!book) return false;
    const progress = this.db.getJson<Record<string, SavedProgress>>(PROGRESS_KEY)?.[bookId];
    const data: BookBackup = {
      format: FORMAT,
      id: book.id,
      title: book.title,
      author: book.author,
      intro: book.intro,
      coverUrl: book.cover_url,
      catalog: bookCatalog(book) ?? null,
      catalogAt: book.catalog_at,
      addedAt: book.added_at,
      readAt: book.read_at,
      follow: !!book.follow,
      ahead: book.ahead,
      ...(progress ? { progress } : {}),
    };
    const dir = await this.ensureFolder(book);
    const cover = this.library.coverFile(bookId);
    if (existsSync(cover)) {
      // At the top of the book's folder, where audiobook apps look for it.
      const target = join(dir, "..", "cover.jpg");
      const size = existsSync(target) ? (await stat(target)).size : -1;
      if (size !== (await stat(cover)).size) await writeAtomic(target, await readFile(cover));
    }
    const json = JSON.stringify(data);
    const file = join(dir, "book.json");
    if (existsSync(file) && (await readFile(file, "utf8")) === json) return false;
    await writeAtomic(file, json);
    return true;
  }

  private async writeChapter(bookId: string, chapterId: string): Promise<boolean> {
    const book = this.library.book(bookId);
    const place = book && findChapter(bookCatalog(book), chapterId);
    const base = book && this.library.chapterBase(book, chapterId);
    if (!book || !place || !base) return false;
    const meta = await this.ensureFolder(book);
    const jsonFile = join(meta, "chapters", `${chapterId}.json`);
    const cached = this.source.cachedChapterPages(bookId, chapterId);
    let pages = cached.pages;
    const fetched = new Map(
      this.db
        .all<{ page_index: number; fetched_at: number }>("select page_index, fetched_at from pages where book_id = ? and chapter_id = ?", bookId, chapterId)
        .map((r) => [r.page_index, r.fetched_at]),
    );
    if (!cached.complete || !pages.length) {
      // Not cached (any more): what the library has is written again, e.g. at a new place.
      const saved = this.readChapter(jsonFile);
      if (!saved?.pages.length) return false;
      pages = saved.pages.map((p) => p.page);
      for (const p of saved.pages) fetched.set(p.page.pageIndex, p.fetchedAt);
    }
    const incomplete = pages.some((p) => p.incomplete);
    const old = this.db.get<BackupRow>("select * from chapter_backup where book_id = ? and chapter_id = ?", bookId, chapterId);
    // A complete copy is kept when the site later sends only part of the chapter.
    if (incomplete && old && !old.incomplete) return false;

    const images = await this.saveImages(book, chapterId, base, pages);
    const folder = base.split("/").pop()!;
    const local = new Map(images.saved.map((i) => [i.url, `${folder}/${i.file.split("/").pop()}`]));
    const md = chapterMarkdown(place.chapterTitle, pages, (url) => local.get(url) ?? url);
    const mdRel = `${base}.md`;
    const data: ChapterBackup = {
      format: FORMAT,
      bookId,
      chapterId,
      title: place.chapterTitle,
      text: mdRel,
      ...(incomplete ? { incomplete } : {}),
      pages: pages.map((page) => ({ fetchedAt: fetched.get(page.pageIndex) ?? 0, page })),
      images: images.saved.map(({ url, file, type }) => ({ url, file, type })),
      audio: this.audio(bookId, chapterId),
    };
    const json = JSON.stringify(data);
    const hash = sha1(json);
    if (old && old.hash === hash && old.file === mdRel && existsSync(this.abs(mdRel)) && existsSync(jsonFile) && !images.written) {
      return false;
    }
    await writeAtomic(this.abs(mdRel), md);
    await writeAtomic(jsonFile, json);
    await this.library.placeCover(bookId, dirname(this.abs(mdRel)));
    if (old?.file && old.file !== mdRel) await this.library.removeFile(old.file);
    const bytes = Buffer.byteLength(md) + images.saved.reduce((n, i) => n + i.bytes, 0);
    this.db.run(
      `insert into chapter_backup (book_id, chapter_id, file, hash, bytes, incomplete, images_missing, updated_at) values (?, ?, ?, ?, ?, ?, ?, ?)
       on conflict (book_id, chapter_id) do update set file = excluded.file, hash = excluded.hash, bytes = excluded.bytes,
       incomplete = excluded.incomplete, images_missing = excluded.images_missing, updated_at = excluded.updated_at`,
      bookId,
      chapterId,
      mdRel,
      hash,
      bytes,
      incomplete ? 1 : 0,
      images.missing,
      Date.now(),
    );
    return true;
  }

  /**
   * Saves a chapter's illustrations in a folder named like the chapter
   * (`01.jpg`, `02.png`, …); ones the site won't give are linked by URL and
   * tried again next time.
   */
  private async saveImages(
    book: BookRow,
    chapterId: string,
    base: string,
    pages: PageContent[],
  ): Promise<{ saved: ImageRow[]; missing: number; written: boolean }> {
    const urls = [...new Set(pages.flatMap((p) => p.paragraphs).flatMap((p) => (p.imageUrl ? [p.imageUrl] : [])))];
    const old = new Map(
      this.db
        .all<ImageRow>("select url, file, type, bytes from backup_images where book_id = ? and chapter_id = ?", book.id, chapterId)
        .map((r) => [r.url, r]),
    );
    const saved: ImageRow[] = [];
    let missing = 0;
    let written = false;
    for (const [i, url] of urls.entries()) {
      const prev = old.get(url);
      const name = (type: string) => `${base}/${String(i + 1).padStart(2, "0")}.${IMAGE_EXT[type] ?? "img"}`;
      if (prev && prev.file === name(prev.type) && existsSync(this.abs(prev.file))) {
        saved.push(prev);
        continue;
      }
      let img: { body: Buffer; type: string };
      try {
        img = prev && existsSync(this.abs(prev.file)) ? { body: await readFile(this.abs(prev.file)), type: prev.type } : await this.images.load(url);
      } catch (err) {
        console.warn(`[backup] illustration of ${book.id}/${chapterId}: ${err instanceof Error ? err.message : String(err)}`);
        missing++;
        continue;
      }
      const file = name(img.type);
      await writeAtomic(this.abs(file), img.body);
      saved.push({ url, file, type: img.type, bytes: img.body.length });
      written = true;
    }
    const keep = new Set(saved.map((s) => s.file));
    for (const prev of old.values()) if (!keep.has(prev.file)) await this.library.removeFile(prev.file);
    this.db.tx(() => {
      this.db.run("delete from backup_images where book_id = ? and chapter_id = ?", book.id, chapterId);
      for (const s of saved) {
        this.db.run("insert into backup_images (book_id, chapter_id, url, file, type, bytes) values (?, ?, ?, ?, ?, ?)", book.id, chapterId, s.url, s.file, s.type, s.bytes);
      }
    });
    return { saved, missing, written: written || old.size !== saved.length };
  }

  private audio(bookId: string, chapterId: string): ChapterBackup["audio"] {
    const row = this.db.get<ChapterAudioRow>("select * from chapter_audio where book_id = ? and chapter_id = ?", bookId, chapterId);
    if (!row) return undefined;
    const segments = row.file
      ? this.db
          .all<{ key: string; start: number; bytes: number; mime: string; bounds: string; bounds_v: number; chars: number; created_at: number }>(
            "select key, start, bytes, mime, bounds, bounds_v, chars, created_at from segments where file = ? and start is not null order by start",
            row.file,
          )
          .map((s) => ({
            key: s.key,
            start: s.start,
            bytes: s.bytes,
            mime: s.mime,
            bounds: JSON.parse(s.bounds) as number[],
            boundsVersion: s.bounds_v,
            chars: s.chars,
            createdAt: s.created_at,
          }))
      : [];
    return { file: row.file, profile: row.profile, bytes: row.bytes, duration: row.duration, updatedAt: row.updated_at, segments };
  }

  /**
   * Reads back what the database lacks (a new install, a lost database):
   * books with their catalog, cover and reading position, their pages, and
   * the audio and illustrations still in the library. Pages are restored
   * only for books the database didn't have: for the others, a page that is
   * gone (its cache deleted to fetch it again) is taken from the library
   * only when the site doesn't give it (see `page`).
   */
  restore(): { books: number; chapters: number } {
    const result = { books: 0, chapters: 0 };
    this.restoreSettings();
    const dirs = (dir: string) => {
      try {
        return readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory() && !e.name.startsWith(".")).map((e) => e.name);
      } catch {
        return [];
      }
    };
    // Book folders are `author/book`.
    for (const author of dirs(this.library.dir)) {
      for (const title of dirs(join(this.library.dir, author))) {
        const folder = `${author}/${title}`;
        const meta = join(this.abs(folder), BACKUP_DIR);
        if (!existsSync(join(meta, "book.json"))) continue;
        try {
          const book = this.restoreBook(folder, meta);
          if (!book) continue;
          if (book.added) result.books++;
          result.chapters += this.restoreChapters(book.id, meta, !book.added);
        } catch (err) {
          console.warn(`[backup] restoring ${folder}:`, err instanceof Error ? err.message : String(err));
        }
      }
    }
    return result;
  }

  private restoreBook(folder: string, meta: string): { id: string; added: boolean } | undefined {
    const b = JSON.parse(readFileSync(join(meta, "book.json"), "utf8")) as BookBackup;
    const id = b.id;
    if (b.format !== FORMAT || !/^\d+$/.test(String(id))) return undefined;
    const saved = this.db.getKv(this.dirKey(id));
    // Another folder already holds this book's data (a copy): that one stays.
    if (saved && saved !== folder && existsSync(join(this.abs(saved), BACKUP_DIR, "book.json"))) return undefined;
    this.db.setKv(this.dirKey(id), folder);
    let added = false;
    if (!this.library.book(id)) {
      this.db.run(
        `insert into books (id, title, author, cover_url, intro, catalog, catalog_at, added_at, read_at, follow, ahead)
         values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) on conflict (id) do nothing`,
        id,
        b.title,
        b.author,
        b.coverUrl,
        b.intro,
        b.catalog ? JSON.stringify(b.catalog) : null,
        b.catalogAt,
        b.addedAt,
        b.readAt,
        b.follow ? 1 : 0,
        b.ahead,
      );
      added = true;
    }
    const cover = join(meta, "..", "cover.jpg");
    const target = this.library.coverFile(id);
    if (existsSync(cover) && !existsSync(target)) {
      mkdirSync(dirname(target), { recursive: true });
      copyFileSync(cover, target);
    }
    if (b.progress) {
      const all = this.db.getJson<Record<string, SavedProgress>>(PROGRESS_KEY) ?? {};
      if (!all[id]) this.db.setJson(PROGRESS_KEY, { ...all, [id]: b.progress });
    }
    return { id, added };
  }

  /**
   * Restores a book's chapter data. A book the database had (`known`) gets no
   * pages, and its chapters with a backup row written since their data file
   * changed are skipped.
   */
  private restoreChapters(bookId: string, meta: string, known: boolean): number {
    const dir = join(meta, "chapters");
    let files: string[];
    try {
      files = readdirSync(dir).filter((f) => f.endsWith(".json"));
    } catch {
      return 0;
    }
    const rows = new Map(
      this.db
        .all<{ chapter_id: string; updated_at: number }>("select chapter_id, updated_at from chapter_backup where book_id = ?", bookId)
        .map((r) => [r.chapter_id, r.updated_at]),
    );
    let n = 0;
    for (const name of files) {
      const file = join(dir, name);
      const chapterId = name.slice(0, -5);
      const at = rows.get(chapterId);
      if (known && at !== undefined && at >= statSync(file).mtimeMs) continue;
      const json = readFileSync(file, "utf8");
      const c = JSON.parse(json) as ChapterBackup;
      if (c.format !== FORMAT || c.bookId !== bookId || c.chapterId !== chapterId) continue;
      this.restoreChapter(c, sha1(json), !known);
      n++;
    }
    return n;
  }

  private restoreChapter(c: ChapterBackup, hash: string, pages: boolean): void {
    this.db.tx(() => {
      if (pages) {
        for (const p of c.pages) {
          this.db.run(
            `insert into pages (book_id, chapter_id, page_index, data, fetched_at) values (?, ?, ?, ?, ?)
             on conflict (book_id, chapter_id, page_index) do nothing`,
            c.bookId,
            c.chapterId,
            p.page.pageIndex,
            JSON.stringify(p.page),
            p.fetchedAt,
          );
        }
      }
      let bytes = existsSync(this.abs(c.text)) ? statSync(this.abs(c.text)).size : 0;
      for (const img of c.images) {
        if (!existsSync(this.abs(img.file))) continue;
        const size = statSync(this.abs(img.file)).size;
        bytes += size;
        this.db.run(
          "insert into backup_images (book_id, chapter_id, url, file, type, bytes) values (?, ?, ?, ?, ?, ?) on conflict do nothing",
          c.bookId,
          c.chapterId,
          img.url,
          img.file,
          img.type,
          size,
        );
      }
      this.db.run(
        `insert into chapter_backup (book_id, chapter_id, file, hash, bytes, incomplete, images_missing, updated_at) values (?, ?, ?, ?, ?, ?, 0, ?)
         on conflict (book_id, chapter_id) do nothing`,
        c.bookId,
        c.chapterId,
        c.text,
        hash,
        bytes,
        c.incomplete ? 1 : 0,
        Date.now(),
      );
      const a = c.audio;
      const has = this.db.get("select 1 from chapter_audio where book_id = ? and chapter_id = ?", c.bookId, c.chapterId);
      if (!a || has || (a.file && !existsSync(this.abs(a.file)))) return;
      this.db.run(
        "insert into chapter_audio (book_id, chapter_id, profile, file, bytes, duration, updated_at) values (?, ?, ?, ?, ?, ?, ?)",
        c.bookId,
        c.chapterId,
        a.profile,
        a.file,
        a.bytes,
        a.duration,
        a.updatedAt,
      );
      for (const s of a.segments) {
        this.db.run(
          `insert into segments (key, file, mime, bytes, bounds, bounds_v, chars, created_at, start) values (?, ?, ?, ?, ?, ?, ?, ?, ?)
           on conflict (key) do nothing`,
          s.key,
          a.file,
          s.mime,
          s.bytes,
          JSON.stringify(s.bounds),
          s.boundsVersion,
          s.chars,
          s.createdAt,
          s.start,
        );
      }
    });
  }
}
