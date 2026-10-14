import { existsSync } from "node:fs";
import { mkdir, rename, rm } from "node:fs/promises";
import { dirname } from "node:path";
import { FetchError } from "../../src/adapters/types";
import { SpeechEngineError } from "../../src/speech/SpeechEngine";
import type { JobInfo, JobKind, JobReason, JobStatus, JobsOverview, PageProvider, ProviderBlock } from "../shared/api";
import type { Db } from "./db";
import type { Ffmpeg } from "./audio/ffmpeg";
import type { SiteSource } from "./site/source";
import { BLOCKING_CODES, describeError, type Tts } from "./tts";
import { bookCatalog, type ChapterAudioRow, type Library } from "./library";

interface JobRow {
  id: number;
  kind: JobKind;
  book_id: string;
  target: string;
  title: string;
  profile: string;
  reason: JobReason;
  priority: number;
  status: JobStatus;
  progress: number;
  message: string | null;
  error: string | null;
  attempts: number;
  not_before: number;
  created_at: number;
  updated_at: number;
}

export const PRIORITY: Record<JobReason, number> = { manual: 10, follow: 50 };
/** Reader requests (someone is listening) go before any job. */
export const READER_PRIORITY = 100;
const MAX_ATTEMPTS = 5;
const PAUSED_KEY = "server.jobsPaused";

/** Something only the user can fix (a key, a bot check): jobs for it wait until settings change. */
export type BlockKey = PageProvider | "site";

class Cancelled extends Error {}

/**
 * Background generation: a queue of chapter (and export) jobs in the
 * database, run one at a time. Failures that need the user block the
 * service until settings change; quota and throttling wait and retry.
 */
export class Jobs {
  private blocked: Partial<Record<BlockKey, ProviderBlock>> = {};
  private running = new Set<number>();
  private timer?: ReturnType<typeof setTimeout>;
  private stopped = false;
  private listeners: (() => void)[] = [];

  constructor(
    private readonly db: Db,
    private readonly source: SiteSource,
    private readonly tts: Tts,
    private readonly library: Library,
    private readonly ffmpeg: Ffmpeg,
    private readonly now: () => number = Date.now,
  ) {
    // Interrupted by a restart: run again.
    this.db.run("update jobs set status = 'queued' where status = 'running'");
  }

  get paused(): boolean {
    return this.db.getKv(PAUSED_KEY) === "1";
  }

  setPaused(paused: boolean): void {
    this.db.setKv(PAUSED_KEY, paused ? "1" : undefined);
    if (!paused) this.kick();
  }

  /** Clears blocks (settings changed) and looks for work. */
  unblock(): void {
    this.blocked = {};
    this.kick();
  }

  onChange(fn: () => void): void {
    this.listeners.push(fn);
  }

  private changed(): void {
    this.listeners.forEach((fn) => fn());
  }

  // -------------------------------------------------------------------------
  // Queue

  private active(bookId: string, kind: JobKind, target: string): JobRow | undefined {
    return this.db.get<JobRow>(
      "select * from jobs where book_id = ? and kind = ? and target = ? and status in ('queued', 'running')",
      bookId,
      kind,
      target,
    );
  }

  /** Queues a chapter (no-op when one is already queued; a manual request raises its priority). */
  enqueueChapter(bookId: string, chapterId: string, title: string, reason: JobReason): number {
    const existing = this.active(bookId, "chapter", chapterId);
    if (existing) {
      if (PRIORITY[reason] > existing.priority) {
        this.db.run("update jobs set priority = ?, reason = ? where id = ?", PRIORITY[reason], reason, existing.id);
      }
      return existing.id;
    }
    const id = this.insert("chapter", bookId, chapterId, title, reason);
    this.kick();
    return id;
  }

  enqueueExport(bookId: string, volumeIndex: number, title: string): number {
    const existing = this.active(bookId, "export", String(volumeIndex));
    if (existing) return existing.id;
    const id = this.insert("export", bookId, String(volumeIndex), title, "manual");
    this.kick();
    return id;
  }

  private insert(kind: JobKind, bookId: string, target: string, title: string, reason: JobReason): number {
    const t = this.now();
    const profile = this.tts.profile();
    return this.db.run(
      `insert into jobs (kind, book_id, target, title, profile, reason, priority, status, created_at, updated_at)
       values (?, ?, ?, ?, ?, ?, ?, 'queued', ?, ?)`,
      kind,
      bookId,
      target,
      title,
      profile ? this.tts.profileId(profile) : "",
      reason,
      PRIORITY[reason],
      t,
      t,
    ).lastInsertRowid;
  }

  cancel(id: number): void {
    this.db.run(
      "update jobs set status = 'cancelled', updated_at = ? where id = ? and status in ('queued', 'running')",
      this.now(),
      id,
    );
    this.changed();
  }

  /** Cancels a book's waiting follow jobs outside `keep` (the reading position moved). */
  cancelFollow(bookId: string, keep: Set<string>): void {
    const rows = this.db.all<JobRow>(
      "select * from jobs where book_id = ? and kind = 'chapter' and reason = 'follow' and status = 'queued'",
      bookId,
    );
    for (const r of rows) if (!keep.has(r.target)) this.cancel(r.id);
  }

  cancelBook(bookId: string): void {
    for (const r of this.db.all<JobRow>("select id from jobs where book_id = ? and status in ('queued', 'running')", bookId)) {
      this.cancel(r.id);
    }
  }

  retry(id: number): void {
    this.db.run(
      `update jobs set status = 'queued', attempts = 0, not_before = 0, error = null, message = null, updated_at = ?
       where id = ? and status in ('failed', 'cancelled', 'queued')`,
      this.now(),
      id,
    );
    this.unblock();
  }

  /** Removes finished jobs from the list. */
  clear(): void {
    this.db.run("delete from jobs where status in ('done', 'failed', 'cancelled')");
    this.changed();
  }

  private info(r: JobRow & { book_title?: string }): JobInfo {
    return {
      id: r.id,
      kind: r.kind,
      bookId: r.book_id,
      bookTitle: r.book_title ?? "",
      target: r.target,
      title: r.title,
      reason: r.reason,
      status: r.status,
      progress: r.progress,
      message: r.message ?? undefined,
      error: r.error ?? undefined,
      notBefore: r.not_before > this.now() ? r.not_before : undefined,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    };
  }

  overview(limit = 300): JobsOverview {
    const rows = this.db.all<JobRow & { book_title: string }>(
      `select jobs.*, coalesce(books.title, '') as book_title from jobs left join books on books.id = jobs.book_id
       order by case jobs.status when 'running' then 0 when 'queued' then 1 else 2 end,
       case when jobs.status in ('running', 'queued') then -jobs.priority else 0 end,
       case when jobs.status in ('running', 'queued') then jobs.id else -jobs.updated_at end
       limit ?`,
      limit,
    );
    const counts: Record<JobStatus, number> = { queued: 0, running: 0, done: 0, failed: 0, cancelled: 0 };
    for (const c of this.db.all<{ status: JobStatus; n: number }>("select status, count(*) as n from jobs group by status")) {
      counts[c.status] = c.n;
    }
    return { paused: this.paused, blocked: this.blocked, jobs: rows.map((r) => this.info(r)), counts };
  }

  // -------------------------------------------------------------------------
  // Worker

  start(): void {
    this.stopped = false;
    this.kick();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
  }

  /** Looks for work now. */
  kick(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    queueMicrotask(() => void this.tick());
    this.changed();
  }

  private schedule(ms: number): void {
    if (this.stopped) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.tick(), Math.max(1000, Math.min(ms, 10 * 60_000)));
    this.timer.unref?.();
  }

  /** Next runnable job of a kind, if any (skipping blocked services). */
  private nextJob(kind: JobKind): JobRow | undefined {
    const rows = this.db.all<JobRow>(
      "select * from jobs where status = 'queued' and kind = ? and not_before <= ? order by priority desc, id limit 50",
      kind,
      this.now(),
    );
    if (kind === "export") return rows[0];
    if (this.blocked.site) return undefined;
    const provider = this.tts.profile()?.provider;
    if (!provider || this.blocked[provider]) return undefined;
    return rows[0];
  }

  private async tick(): Promise<void> {
    if (this.stopped) return;
    if (!this.paused) {
      for (const kind of ["chapter", "export"] as JobKind[]) {
        // One job of each kind at a time.
        if ([...this.running].some((id) => this.db.get<JobRow>("select kind from jobs where id = ?", id)?.kind === kind)) continue;
        const job = this.nextJob(kind);
        if (job) void this.run(job);
      }
    }
    const waiting = this.db.get<{ t: number | null }>(
      "select min(not_before) as t from jobs where status = 'queued' and not_before > ?",
      this.now(),
    )?.t;
    this.schedule(waiting ? waiting - this.now() : 60_000);
  }

  private update(id: number, fields: Partial<Pick<JobRow, "status" | "progress" | "message" | "error" | "attempts" | "not_before">>): void {
    const keys = Object.keys(fields) as (keyof typeof fields)[];
    if (!keys.length) return;
    this.db.run(
      `update jobs set ${keys.map((k) => `${k} = ?`).join(", ")}, updated_at = ? where id = ?`,
      ...keys.map((k) => fields[k] ?? null),
      this.now(),
      id,
    );
    this.changed();
  }

  private checkCancelled(id: number): void {
    if (this.db.get<{ status: string }>("select status from jobs where id = ?", id)?.status !== "running") throw new Cancelled();
  }

  private async run(job: JobRow): Promise<void> {
    this.running.add(job.id);
    this.update(job.id, { status: "running", progress: 0, message: null, error: null });
    try {
      if (job.kind === "chapter") await this.runChapter(job);
      else await this.runExport(job);
      if (this.db.get<{ status: string }>("select status from jobs where id = ?", job.id)?.status === "running") {
        this.update(job.id, { status: "done", progress: 1 });
      }
    } catch (err) {
      if (!(err instanceof Cancelled)) this.failed(job, err);
    } finally {
      this.running.delete(job.id);
      this.kick();
    }
  }

  private block(key: BlockKey, code: string, message: string): void {
    this.blocked[key] = { code, message, since: this.now() };
  }

  /** Decides what a failure means: wait for the user, wait for a quota, retry later or give up. */
  private failed(job: JobRow, err: unknown): void {
    const attempts = job.attempts + 1;
    const provider = this.tts.profile()?.provider;
    if (err instanceof SpeechEngineError && provider) {
      const message = describeError(provider, err.code);
      if (BLOCKING_CODES.has(err.code)) {
        this.block(provider, err.code, message);
        this.update(job.id, { status: "queued", message: `等待设置：${message}` });
        return;
      }
      if (err.code === "quota") {
        this.update(job.id, { status: "queued", message, not_before: nextQuotaReset(this.now()) });
        return;
      }
      if (["throttled", "server", "network", "empty"].includes(err.code) && attempts < MAX_ATTEMPTS) {
        this.update(job.id, { status: "queued", attempts, message, not_before: this.now() + 60_000 * 2 ** attempts });
        return;
      }
      this.update(job.id, { status: "failed", attempts, error: message, message: null });
      return;
    }
    if (err instanceof FetchError && err.challenge) {
      const message = "站点要求人机验证：请在设置中填写 Cookie 或配置 FlareSolverr";
      this.block("site", "challenge", message);
      this.update(job.id, { status: "queued", message });
      return;
    }
    const message = err instanceof Error ? err.message : String(err);
    console.warn(`[jobs] #${job.id} failed`, message);
    if (attempts < MAX_ATTEMPTS && (err instanceof FetchError || /ENOSPC|EBUSY|EAGAIN/.test(message))) {
      this.update(job.id, { status: "queued", attempts, message, not_before: this.now() + 60_000 * 2 ** attempts });
      return;
    }
    this.update(job.id, { status: "failed", attempts, error: message, message: null });
  }

  // -------------------------------------------------------------------------
  // Chapter

  private async runChapter(job: JobRow): Promise<void> {
    const book = this.library.book(job.book_id);
    if (!book) throw new Error("书籍已删除");
    const profile = this.tts.profile();
    if (!profile) throw new SpeechEngineError("config");
    const profileId = this.tts.profileId(profile);
    const existing = this.db.get<ChapterAudioRow>(
      "select * from chapter_audio where book_id = ? and chapter_id = ?",
      book.id,
      job.target,
    );
    if (existing?.profile === profileId && (!existing.file || existsSync(this.library.abs(existing.file)))) return;

    this.update(job.id, { message: "获取正文…" });
    const pages = await this.source.chapterPages(book.id, job.target, (n) =>
      this.update(job.id, { message: `获取正文（第 ${n} 页）…` }),
    );
    this.checkCancelled(job.id);
    const parts = this.tts.parts(profile.provider, pages);
    if (!parts.length) {
      this.library.markSilent(book.id, job.target, profileId);
      return;
    }
    const files: string[] = [];
    const total = parts.reduce((n, p) => n + p.join("").length, 0);
    let done = 0;
    for (const [i, texts] of parts.entries()) {
      this.checkCancelled(job.id);
      this.update(job.id, { message: `生成语音 ${i + 1}/${parts.length}` });
      const seg = await this.tts.segment(profile.provider, texts, {
        priority: job.priority,
        onStatus: (msg) => this.update(job.id, { message: msg }),
      });
      files.push(seg.file);
      done += texts.join("").length;
      this.update(job.id, { progress: (done / total) * 0.95 });
    }
    this.checkCancelled(job.id);
    this.update(job.id, { message: "合成章节文件…" });
    if (!(await this.ffmpeg.check())) throw new Error("未找到 ffmpeg，无法合成章节文件");
    await this.library.assemble(book, job.target, files, profileId);
    this.update(job.id, { message: null });
  }

  // -------------------------------------------------------------------------
  // Export

  private async runExport(job: JobRow): Promise<void> {
    const book = this.library.book(job.book_id);
    if (!book) throw new Error("书籍已删除");
    if (!(await this.ffmpeg.check())) throw new Error("未找到 ffmpeg，无法导出");
    const vi = Number(job.target);
    const volume = bookCatalog(book)?.volumes[vi];
    if (!volume) throw new Error("该卷不在目录中");
    const rows = new Map(this.library.chapterAudio(book.id).map((r) => [r.chapter_id, r]));
    const parts: { title: string; file: string; duration: number }[] = [];
    const missing: string[] = [];
    for (const c of volume.chapters) {
      if (!c.chapterId) continue;
      const row = rows.get(c.chapterId);
      if (row && !row.file) continue;
      if (!row || !existsSync(this.library.abs(row.file))) {
        missing.push(c.title);
        continue;
      }
      const duration = row.duration ?? (await this.ffmpeg.duration(this.library.abs(row.file))) ?? 0;
      parts.push({ title: c.title, file: this.library.abs(row.file), duration });
    }
    if (missing.length) throw new Error(`还有 ${missing.length} 章没有语音（${missing.slice(0, 3).join("、")}…）`);
    if (!parts.length) throw new Error("该卷没有可导出的语音");
    let t = 0;
    const chapters = parts.map((p) => {
      const mark = { title: p.title, start: t, end: t + p.duration };
      t += p.duration;
      return mark;
    });
    const out = this.library.exportFile(book.id, vi);
    const tmp = `${out}.tmp.m4b`;
    await mkdir(dirname(out), { recursive: true });
    this.update(job.id, { message: `编码 ${parts.length} 章…`, progress: 0.1 });
    const cover = this.library.coverFile(book.id);
    try {
      await this.ffmpeg.m4b(
        parts.map((p) => p.file),
        chapters,
        tmp,
        { title: `${book.title} ${volume.title}`.trim(), album: book.title, artist: book.author, genre: "Audiobook" },
        { list: `${tmp}.txt`, meta: `${tmp}.meta` },
        existsSync(cover) ? cover : undefined,
      );
      this.checkCancelled(job.id);
      await rename(tmp, out);
    } finally {
      await rm(tmp, { force: true });
      await rm(`${tmp}.txt`, { force: true });
      await rm(`${tmp}.meta`, { force: true });
    }
    this.update(job.id, { message: null });
  }
}

/** Free-tier daily quotas reset at midnight Pacific time; wait until shortly after. */
export function nextQuotaReset(now: number): number {
  const d = new Date(now);
  // 08:05 UTC is 00:05 PST / 01:05 PDT: after the reset either way.
  const reset = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 8, 5);
  return reset > now ? reset : reset + 86400_000;
}
