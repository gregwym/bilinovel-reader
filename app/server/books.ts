import { mkdir, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { SavedProgress } from "../../src/reader/ProgressStore";
import type { Catalog } from "../../src/adapters/types";
import type {
  BookDetail,
  BookSummary,
  ChapterAudioState,
  ChapterInfo,
  JobStatus,
  ReadingPosition,
  VolumeInfo,
} from "../shared/api";
import type { Db } from "./db";
import type { Settings } from "./config";
import type { Ffmpeg } from "./audio/ffmpeg";
import type { SiteSource } from "./site/source";
import type { SiteClient } from "./site/client";
import type { Tts } from "./tts";
import { bookCatalog, type BookRow, type ChapterAudioRow, type Library } from "./library";
import { existsSync, statSync } from "node:fs";

export const PROGRESS_KEY = "biliReader.progress";

/** Book id from a site URL (`/novel/123.html`, `/novel/123/456.html`, `/novel/123/catalog`) or a bare id. */
export function parseBookId(input: string): string | undefined {
  const s = input.trim();
  if (/^\d+$/.test(s)) return s;
  return /\/novel\/(\d+)(?:[/._]|$)/.exec(s)?.[1];
}

/** Linked chapters of a catalog, in reading order. */
export function linkedChapters(catalog: Catalog | undefined): { chapterId: string; title: string; volumeIndex: number }[] {
  return (catalog?.volumes ?? []).flatMap((v, volumeIndex) =>
    v.chapters.flatMap((c) => (c.chapterId ? [{ chapterId: c.chapterId, title: c.title, volumeIndex }] : [])),
  );
}

/** How long adding or refreshing a book waits for the site before answering. */
export const ADD_WAIT_MS = 20_000;

/** The promise's outcome if it settles within `ms`, else undefined. */
async function settleWithin<T>(p: Promise<T>, ms: number): Promise<{ value: T } | { error: unknown } | undefined> {
  let timer: number | NodeJS.Timeout | undefined;
  const timeout = new Promise<undefined>((resolve) => {
    timer = globalThis.setTimeout(resolve, ms);
  });
  try {
    return await Promise.race([p.then((value) => ({ value }), (error: unknown) => ({ error })), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

interface JobRow {
  id: number;
  target: string;
  kind: string;
  status: JobStatus;
  progress: number;
  message: string | null;
}

export class Books {
  constructor(
    private readonly db: Db,
    private readonly settings: Settings,
    private readonly source: SiteSource,
    private readonly client: SiteClient,
    private readonly library: Library,
    private readonly tts: Tts,
    private readonly ffmpeg: Ffmpeg,
  ) {}

  get(id: string): BookRow | undefined {
    return this.library.book(id);
  }

  list(): BookRow[] {
    return this.db.all<BookRow>("select * from books order by coalesce(read_at, added_at) desc");
  }

  /** Reading positions saved by the reader (synced key-value store). */
  progress(): Record<string, SavedProgress> {
    return this.db.getJson<Record<string, SavedProgress>>(PROGRESS_KEY) ?? {};
  }

  /** Catalog loads in flight, and the last failure per book (shown until the next attempt). */
  private readonly syncs = new Map<string, Promise<BookRow>>();
  private readonly syncErrors = new Map<string, string>();

  /**
   * Adds a book (or refreshes it if already there). Waits at most `waitMs` for
   * the site: a slow site (rate limit, retries, FlareSolverr) would otherwise
   * outlast a reverse proxy's timeout. After that the book is returned as a
   * placeholder and keeps loading in the background. A new book whose first
   * load fails within the wait is not kept.
   */
  async add(input: string, waitMs = ADD_WAIT_MS): Promise<BookRow> {
    const id = parseBookId(input);
    if (!id) throw new Error("无法识别的书籍链接");
    const isNew = !this.get(id);
    if (isNew) {
      this.db.run(
        "insert into books (id, title, added_at, ahead, follow) values (?, ?, ?, ?, 0) on conflict (id) do nothing",
        id,
        `书籍 ${id}`,
        Date.now(),
        this.settings.get().defaultAhead,
      );
    }
    const sync = this.refresh(id);
    const quick = await settleWithin(sync, waitMs);
    if (quick && "error" in quick) {
      if (isNew && !this.get(id)?.catalog_at) await this.remove(id);
      throw quick.error;
    }
    return this.get(id)!;
  }

  /** A book the reader opened that isn't in the library yet: added in the background. */
  ensure(id: string, title?: string): void {
    if (this.get(id)) return;
    this.db.run(
      "insert into books (id, title, added_at, ahead, follow) values (?, ?, ?, ?, 0) on conflict (id) do nothing",
      id,
      title ?? `书籍 ${id}`,
      Date.now(),
      this.settings.get().defaultAhead,
    );
    void this.refresh(id).catch(() => undefined);
  }

  /** Waits like `add` for a refresh to finish; returns the book either way. */
  async refreshWithin(id: string, waitMs = ADD_WAIT_MS): Promise<BookRow> {
    if (!this.get(id)) throw new Error("书籍不存在");
    const quick = await settleWithin(this.refresh(id), waitMs);
    if (quick && "error" in quick) throw quick.error;
    return this.get(id)!;
  }

  /** The load in flight for a book, if any. */
  pending(id: string): Promise<BookRow> | undefined {
    return this.syncs.get(id);
  }

  /** Reloads the catalog and book page (joins a load already in flight). */
  refresh(id: string): Promise<BookRow> {
    const running = this.syncs.get(id);
    if (running) return running;
    const run = this.load(id).then(
      (book) => {
        this.syncErrors.delete(id);
        return book;
      },
      (err: unknown) => {
        const message = err instanceof Error ? err.message : String(err);
        if (this.get(id)) this.syncErrors.set(id, message);
        console.warn("[library] loading book", id, message);
        throw err;
      },
    );
    const tracked = run.finally(() => this.syncs.delete(id));
    tracked.catch(() => undefined);
    this.syncs.set(id, tracked);
    this.syncErrors.delete(id);
    return tracked;
  }

  private async load(id: string): Promise<BookRow> {
    const book = this.get(id);
    if (!book) throw new Error("书籍不存在");
    const [info, catalog] = await Promise.all([this.source.bookInfo(id).catch(() => undefined), this.source.catalog(id, true)]);
    if (!this.get(id)) throw new Error("书籍已删除");
    this.db.run(
      `update books set title = ?, author = ?, cover_url = coalesce(?, cover_url), intro = ?, catalog = ?, catalog_at = ? where id = ?`,
      info?.title || catalog.title || book.title,
      info?.author || book.author,
      info?.coverUrl ?? catalog.cover ?? null,
      info?.intro || book.intro,
      JSON.stringify(catalog),
      Date.now(),
      id,
    );
    if (!existsSync(this.library.coverFile(id))) {
      await this.fetchCover(id).catch((err) => console.warn("[library] cover", id, String(err)));
    }
    return this.get(id)!;
  }

  private async fetchCover(id: string): Promise<void> {
    const url = this.get(id)?.cover_url;
    if (!url) return;
    const img = await this.client.binary(url, `${this.settings.get().siteOrigin}/`);
    const data = (await this.ffmpeg.check()) ? await this.ffmpeg.toJpeg(img.body).catch(() => img.body) : img.body;
    const file = this.library.coverFile(id);
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, data);
  }

  update(id: string, patch: { follow?: boolean; ahead?: number }): BookRow {
    if (patch.follow !== undefined) this.db.run("update books set follow = ? where id = ?", patch.follow ? 1 : 0, id);
    if (patch.ahead !== undefined && Number.isFinite(patch.ahead)) {
      this.db.run("update books set ahead = ? where id = ?", Math.min(50, Math.max(0, Math.round(patch.ahead))), id);
    }
    return this.get(id)!;
  }

  async remove(id: string): Promise<void> {
    await this.library.deleteBookAudio(id);
    this.db.tx(() => {
      this.db.run("delete from jobs where book_id = ? and status in ('queued', 'done', 'failed', 'cancelled')", id);
      this.db.run("update jobs set status = 'cancelled' where book_id = ? and status = 'running'", id);
      this.db.run("delete from pages where book_id = ?", id);
      this.db.run("delete from books where id = ?", id);
    });
    await rm(this.library.coverFile(id), { force: true });
  }

  /** Marks the book as just read (called when the reader saves progress). */
  touch(id: string, at: number): void {
    this.db.run("update books set read_at = max(coalesce(read_at, 0), ?) where id = ?", at, id);
  }

  // -------------------------------------------------------------------------
  // Views

  private position(p: SavedProgress | undefined): ReadingPosition | undefined {
    if (!p || typeof p.chapterId !== "string") return undefined;
    return {
      chapterId: p.chapterId,
      chapterTitle: p.chapterTitle,
      pageIndex: p.pageIndex ?? 0,
      paragraphIndex: p.paragraphIndex ?? 0,
      url: p.url ? new URL(p.url).pathname : undefined,
      updatedAt: p.updatedAt,
    };
  }

  /** Chapter ids whose audio matches the current voice. */
  private audioState(bookId: string): { rows: Map<string, ChapterAudioRow>; current?: string } {
    const profile = this.tts.profile();
    const rows = new Map(this.library.chapterAudio(bookId).map((r) => [r.chapter_id, r]));
    return { rows, current: profile && this.tts.profileId(profile) };
  }

  summary(book: BookRow, progress = this.progress()): BookSummary {
    const chapters = linkedChapters(bookCatalog(book));
    const { rows, current } = this.audioState(book.id);
    const position = this.position(progress[book.id]);
    const readIndex = position ? chapters.findIndex((c) => c.chapterId === position.chapterId) : -1;
    const active = this.db.get<{ n: number }>(
      "select count(*) as n from jobs where book_id = ? and status in ('queued', 'running')",
      book.id,
    )!.n;
    let audioChapters = 0;
    let audioBytes = 0;
    for (const r of rows.values()) {
      audioBytes += r.bytes;
      if (r.profile === current && chapters.some((c) => c.chapterId === r.chapter_id)) audioChapters++;
    }
    return {
      id: book.id,
      title: book.title,
      author: book.author,
      hasCover: existsSync(this.library.coverFile(book.id)),
      addedAt: book.added_at,
      readAt: Math.max(book.read_at ?? 0, position?.updatedAt ?? 0) || undefined,
      position,
      chapters: chapters.length,
      audioChapters,
      readIndex: readIndex >= 0 ? readIndex : undefined,
      activeJobs: active,
      follow: !!book.follow,
      ahead: book.ahead,
      audioBytes,
      loading: this.syncs.has(book.id) || undefined,
      loadError: this.syncErrors.get(book.id),
    };
  }

  detail(book: BookRow): BookDetail {
    const catalog = bookCatalog(book);
    const { rows, current } = this.audioState(book.id);
    const jobs = this.db.all<JobRow>(
      `select id, target, kind, status, progress, message from jobs
       where book_id = ? and (status in ('queued', 'running') or (status = 'failed' and updated_at > ?)) order by id`,
      book.id,
      Date.now() - 7 * 86400_000,
    );
    const chapterJobs = new Map(jobs.filter((j) => j.kind === "chapter").map((j) => [j.target, j]));
    const exportJobs = new Map(jobs.filter((j) => j.kind === "export").map((j) => [j.target, j]));
    const volumes: VolumeInfo[] = (catalog?.volumes ?? []).map((v, vi) => {
      const chapters: ChapterInfo[] = v.chapters.map((c) => {
        const row = c.chapterId ? rows.get(c.chapterId) : undefined;
        const job = c.chapterId ? chapterJobs.get(c.chapterId) : undefined;
        let audio: ChapterAudioState = "none";
        if (row) audio = row.profile === current ? "done" : "stale";
        if (job && (job.status !== "failed" || audio !== "done")) audio = job.status as ChapterAudioState;
        return {
          chapterId: c.chapterId,
          title: c.title,
          audio,
          progress: job ? Math.round(job.progress * 100) : undefined,
          message: job?.message ?? undefined,
          duration: row?.duration ?? undefined,
          bytes: row?.bytes || undefined,
          jobId: job?.id,
          silent: row ? !row.file : undefined,
        };
      });
      const file = this.library.exportFile(book.id, vi);
      const exp = existsSync(file) ? statSync(file) : undefined;
      const job = exportJobs.get(String(vi));
      return {
        title: v.title,
        chapters,
        export: exp ? { bytes: exp.size, createdAt: exp.mtimeMs } : undefined,
        exportJob: job ? { status: job.status, progress: Math.round(job.progress * 100), message: job.message ?? undefined } : undefined,
      };
    });
    return {
      ...this.summary(book),
      intro: book.intro,
      sourceUrl: `${this.settings.get().siteOrigin}/novel/${book.id}.html`,
      catalogAt: book.catalog_at ?? undefined,
      volumes,
      profile: this.tts.profile(),
    };
  }
}
