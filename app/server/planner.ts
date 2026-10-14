import { existsSync } from "node:fs";
import type { Books } from "./books";
import { linkedChapters } from "./books";
import type { Jobs } from "./jobs";
import type { Tts } from "./tts";
import { bookCatalog, type BookRow, type Library } from "./library";

/** Catalogs of followed books are reloaded this often (new chapters). */
const CATALOG_MAX_AGE = 12 * 3600_000;

/**
 * Keeps audio ready ahead of the reader: for each followed book, the chapter
 * being read and the next `ahead` chapters are queued when their audio is
 * missing or was made with another voice.
 */
export class Planner {
  private timer?: ReturnType<typeof setInterval>;

  constructor(
    private readonly books: Books,
    private readonly jobs: Jobs,
    private readonly tts: Tts,
    private readonly library: Library,
  ) {}

  start(intervalMs = 10 * 60_000): void {
    this.timer = setInterval(() => void this.planAll(true), intervalMs);
    this.timer.unref?.();
    void this.planAll(false);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }

  async planAll(refreshCatalogs: boolean): Promise<void> {
    for (const book of this.books.list()) {
      if (!book.follow) continue;
      try {
        if (refreshCatalogs && Date.now() - (book.catalog_at ?? 0) > CATALOG_MAX_AGE && this.nearEnd(book)) {
          await this.books.refresh(book.id);
        }
        this.plan(book.id);
      } catch (err) {
        console.warn("[planner]", book.id, String(err));
      }
    }
  }

  /** Whether the reader is within the look-ahead of the last known chapter. */
  private nearEnd(book: BookRow): boolean {
    const chapters = linkedChapters(bookCatalog(book));
    const pos = this.books.progress()[book.id];
    const i = pos ? chapters.findIndex((c) => c.chapterId === pos.chapterId) : -1;
    return i < 0 || i + book.ahead >= chapters.length - 1;
  }

  /** Queues what the book's reading position needs. Returns the queued chapter ids. */
  plan(bookId: string): string[] {
    const book = this.books.get(bookId);
    if (!book?.follow) return [];
    const profile = this.tts.profile();
    if (!profile) return [];
    const profileId = this.tts.profileId(profile);
    const chapters = linkedChapters(bookCatalog(book));
    const pos = this.books.progress()[bookId];
    // Not started yet: nothing to follow (generating from chapter 1 is a manual choice).
    const start = pos ? chapters.findIndex((c) => c.chapterId === pos.chapterId) : -1;
    if (start < 0) return [];
    const window = chapters.slice(start, start + 1 + book.ahead);
    const audio = new Map(this.library.chapterAudio(bookId).map((r) => [r.chapter_id, r]));
    const queued: string[] = [];
    for (const c of window) {
      const row = audio.get(c.chapterId);
      const ready = row?.profile === profileId && (!row.file || existsSync(this.library.abs(row.file)));
      if (ready) continue;
      this.jobs.enqueueChapter(bookId, c.chapterId, c.title, "follow");
      queued.push(c.chapterId);
    }
    this.jobs.cancelFollow(bookId, new Set(window.map((c) => c.chapterId)));
    return queued;
  }
}
