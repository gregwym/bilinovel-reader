import { copyFile, mkdir, open, readdir, rename, rm, rmdir, stat, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join, sep } from "node:path";
import type { Catalog } from "../../src/adapters/types";
import type { LibraryStats, RescanResult } from "../shared/api";
import type { Db } from "./db";
import type { Settings } from "./config";
import type { Ffmpeg, Tags } from "./audio/ffmpeg";
import { id3Tag, mp3Frames, sameFormat, type Mp3Format } from "./audio/mp3";
import type { StoredAudio, Tts } from "./tts";
import type { PageProvider } from "../shared/api";

/** A segment going into a chapter file. */
export interface ChapterPart {
  provider: PageProvider;
  key: string;
  audio: StoredAudio;
}

/**
 * The audiobook library on disk: one MP3 per chapter in folders named from
 * the storage template (by default `author/book/01 volume/001 chapter.mp3`,
 * which audiobook servers such as Audiobookshelf understand), with the cover
 * next to them. The database indexes the files; the files stay usable
 * without it, and a rescan or a new template brings the two back in line.
 */

export interface BookRow {
  id: string;
  title: string;
  author: string;
  cover_url: string | null;
  intro: string;
  catalog: string | null;
  catalog_at: number | null;
  added_at: number;
  read_at: number | null;
  follow: number;
  ahead: number;
}

export interface ChapterAudioRow {
  book_id: string;
  chapter_id: string;
  profile: string;
  file: string;
  bytes: number;
  duration: number | null;
  updated_at: number;
}

/** Where a chapter sits in the catalog. */
export interface ChapterPlace {
  volumeIndex: number;
  volumeTitle: string;
  chapterIndex: number;
  chapterTitle: string;
}

export function bookCatalog(book: Pick<BookRow, "catalog">): Catalog | undefined {
  try {
    return book.catalog ? (JSON.parse(book.catalog) as Catalog) : undefined;
  } catch {
    return undefined;
  }
}

export function findChapter(catalog: Catalog | undefined, chapterId: string): ChapterPlace | undefined {
  for (const [v, vol] of (catalog?.volumes ?? []).entries()) {
    const c = vol.chapters.findIndex((ch) => ch.chapterId === chapterId);
    if (c >= 0) return { volumeIndex: v, volumeTitle: vol.title, chapterIndex: c, chapterTitle: vol.chapters[c].title };
  }
  return undefined;
}

/** A safe file or folder name (any OS, any NAS share). */
export function safeName(s: string, fallback = "未命名"): string {
  const out = s
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .replace(/[/\\]/g, "／")
    .replace(/:/g, "：")
    .replace(/\*/g, "＊")
    .replace(/\?/g, "？")
    .replace(/"/g, "＂")
    .replace(/</g, "＜")
    .replace(/>/g, "＞")
    .replace(/\|/g, "｜")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^\.+|[. ]+$/g, "");
  return [...(out || fallback)].slice(0, 80).join("");
}

export interface PathVars {
  author: string;
  book: string;
  bookId: string;
  volume: string;
  volumeNo: number;
  chapter: string;
  chapterNo: number;
  chapterId: string;
}

/** A chapter's path (relative to the library, without extension) from the storage template. */
export function renderTemplate(template: string, v: PathVars): string {
  const values: Record<string, string> = {
    author: safeName(v.author, "未知作者"),
    book: safeName(v.book, v.bookId),
    bookId: v.bookId,
    volume: safeName(v.volume, `第${v.volumeNo}卷`),
    volumeNo: String(v.volumeNo).padStart(2, "0"),
    chapter: safeName(v.chapter, v.chapterId),
    chapterNo: String(v.chapterNo).padStart(3, "0"),
    chapterId: v.chapterId,
  };
  return template
    .split("/")
    .map((part) => safeName(part.replace(/\{(\w+)\}/g, (m, k: string) => values[k] ?? m), "_"))
    .filter((part) => part && part !== "." && part !== "..")
    .join("/");
}

async function dirSize(dir: string): Promise<{ files: number; bytes: number }> {
  let files = 0;
  let bytes = 0;
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return { files, bytes };
  }
  for (const e of entries) {
    const p = join(dir, e.name);
    if (e.isDirectory()) {
      const sub = await dirSize(p);
      files += sub.files;
      bytes += sub.bytes;
    } else if (e.isFile()) {
      files++;
      bytes += (await stat(p)).size;
    }
  }
  return { files, bytes };
}

export class Library {
  constructor(
    private readonly db: Db,
    private readonly settings: Settings,
    private readonly ffmpeg: Ffmpeg,
    private readonly tts: Tts,
    readonly dir: string,
    private readonly dataDir: string,
  ) {}

  book(id: string): BookRow | undefined {
    return this.db.get<BookRow>("select * from books where id = ?", id);
  }

  /** The chapter's path relative to the library (with `.mp3`), or undefined if it isn't in the catalog. */
  chapterPath(book: BookRow, chapterId: string, template = this.settings.get().storageTemplate): string | undefined {
    const place = findChapter(bookCatalog(book), chapterId);
    if (!place) return undefined;
    const rel = renderTemplate(template, {
      author: book.author,
      book: book.title,
      bookId: book.id,
      volume: place.volumeTitle,
      volumeNo: place.volumeIndex + 1,
      chapter: place.chapterTitle,
      chapterNo: place.chapterIndex + 1,
      chapterId,
    });
    return `${rel}.mp3`;
  }

  abs(rel: string): string {
    return join(this.dir, ...rel.split("/"));
  }

  coverFile(bookId: string): string {
    return join(this.dataDir, "covers", `${bookId}.jpg`);
  }

  exportFile(bookId: string, volumeIndex: number): string {
    return join(this.dataDir, "exports", bookId, `${volumeIndex}.m4b`);
  }

  tmpFile(name: string): string {
    return join(this.dataDir, "tmp", name);
  }

  chapterAudio(bookId: string): ChapterAudioRow[] {
    return this.db.all<ChapterAudioRow>("select * from chapter_audio where book_id = ?", bookId);
  }

  /**
   * Joins a chapter's segments into its library file and indexes it. When
   * their MP3 frames can simply be put one after another (the usual case),
   * that is done without ffmpeg and the segments then point into the file
   * instead of keeping their own copy. With `joinOnly`, nothing is done
   * (undefined) when that isn't possible.
   */
  async assemble(book: BookRow, chapterId: string, parts: ChapterPart[], profile: string, joinOnly = false): Promise<ChapterAudioRow | undefined> {
    const rel = this.chapterPath(book, chapterId);
    const place = findChapter(bookCatalog(book), chapterId);
    if (!rel || !place) throw new Error(`Chapter ${chapterId} is not in the catalog`);
    const out = this.abs(rel);
    const tmp = this.tmpFile(`${book.id}-${chapterId}-${Date.now()}.mp3`);
    await mkdir(dirname(tmp), { recursive: true });
    await mkdir(dirname(out), { recursive: true });
    const tags: Tags = {
      title: place.chapterTitle,
      album: [book.title, place.volumeTitle].filter(Boolean).join(" "),
      artist: book.author,
      track: String(place.chapterIndex + 1),
      disc: String(place.volumeIndex + 1),
      genre: "Audiobook",
    };
    const old = this.db.get<ChapterAudioRow>(
      "select * from chapter_audio where book_id = ? and chapter_id = ?",
      book.id,
      chapterId,
    );
    let joined: Awaited<ReturnType<Library["joinFrames"]>>;
    try {
      joined = await this.joinFrames(parts, tags, tmp);
      if (!joined && joinOnly) return undefined;
      if (!joined) {
        const files: string[] = [];
        for (const [i, p] of parts.entries()) {
          if (p.audio.start === undefined) files.push(p.audio.file);
          else {
            const own = `${tmp}.${i}.mp3`;
            await writeFile(own, await this.tts.data(p.audio));
            files.push(own);
          }
        }
        await this.ffmpeg.concatMp3(files, tmp, tags, `${tmp}.txt`);
      }
      // The old file's other segments get their own files again before it goes.
      if (old?.file) {
        const keep = old.profile !== profile || !joined;
        await this.tts.release(old.file, keep, joined ? new Set(parts.map((p) => `${p.provider}/${p.key}`)) : undefined);
      }
      await this.moveInto(tmp, out);
    } finally {
      await rm(tmp, { force: true });
      await rm(`${tmp}.txt`, { force: true });
      for (const i of parts.keys()) await rm(`${tmp}.${i}.mp3`, { force: true });
    }
    if (joined) await this.tts.adopt(rel, joined.parts);
    await this.placeCover(book.id, dirname(out));
    if (old?.file && old.file !== rel) await this.removeFile(old.file);
    const row: ChapterAudioRow = {
      book_id: book.id,
      chapter_id: chapterId,
      profile,
      file: rel,
      bytes: (await stat(out)).size,
      duration: joined ? joined.seconds : ((await this.ffmpeg.duration(out)) ?? null),
      updated_at: Date.now(),
    };
    this.db.run(
      `insert into chapter_audio (book_id, chapter_id, profile, file, bytes, duration, updated_at) values (?, ?, ?, ?, ?, ?, ?)
       on conflict (book_id, chapter_id) do update set profile = excluded.profile, file = excluded.file,
       bytes = excluded.bytes, duration = excluded.duration, updated_at = excluded.updated_at`,
      row.book_id,
      row.chapter_id,
      row.profile,
      row.file,
      row.bytes,
      row.duration,
      row.updated_at,
    );
    return row;
  }

  /**
   * Writes an ID3 tag and the segments' frames to `out`, read one at a time.
   * Undefined (nothing written) when they aren't all MP3 of one format.
   */
  private async joinFrames(
    parts: ChapterPart[],
    tags: Tags,
    out: string,
  ): Promise<{ parts: { provider: PageProvider; key: string; start: number; bytes: number }[]; seconds: number } | undefined> {
    if (!parts.length || parts.some((p) => p.audio.mime !== "audio/mpeg")) return undefined;
    const fh = await open(out, "w");
    try {
      const tag = id3Tag(tags);
      await fh.write(tag);
      let format: Mp3Format | undefined;
      let start = 0;
      let seconds = 0;
      const placed = [];
      for (const p of parts) {
        const mp3 = mp3Frames(await this.tts.data(p.audio));
        if (!mp3 || (format && !sameFormat(format, mp3.format))) return undefined;
        format = mp3.format;
        await fh.write(mp3.frames);
        placed.push({ provider: p.provider, key: p.key, start, bytes: mp3.frames.length });
        start += mp3.frames.length;
        seconds += mp3.seconds;
      }
      return { parts: placed, seconds: Math.round(seconds * 1000) / 1000 };
    } finally {
      await fh.close();
    }
  }

  /** Moves a file, also across file systems (data and library are often different volumes). */
  private async moveInto(from: string, to: string): Promise<void> {
    try {
      await rename(from, to);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EXDEV") throw err;
      await copyFile(from, `${to}.part`);
      await rename(`${to}.part`, to);
      await rm(from, { force: true });
    }
  }

  private async placeCover(bookId: string, dir: string): Promise<void> {
    const cover = this.coverFile(bookId);
    const target = join(dir, "cover.jpg");
    if (!existsSync(cover) || existsSync(target)) return;
    await copyFile(cover, target).catch(() => undefined);
  }

  /** Deletes a library file and the folders it leaves empty (with only a cover). */
  private async removeFile(rel: string): Promise<void> {
    const file = this.abs(rel);
    await rm(file, { force: true });
    await this.pruneDirs(dirname(file));
  }

  private async pruneDirs(dir: string): Promise<void> {
    while (dir.startsWith(this.dir + sep)) {
      let entries: string[];
      try {
        entries = await readdir(dir);
      } catch {
        dir = dirname(dir);
        continue;
      }
      if (entries.some((e) => e !== "cover.jpg" && e !== ".DS_Store")) return;
      await rm(join(dir, "cover.jpg"), { force: true });
      await rm(join(dir, ".DS_Store"), { force: true });
      await rmdir(dir).catch(() => undefined);
      dir = dirname(dir);
    }
  }

  /** Deletes a chapter file; its segments are kept (in their own files) when `keepSegments`. */
  async deleteChapter(bookId: string, chapterId: string, keepSegments = false): Promise<void> {
    const row = this.db.get<ChapterAudioRow>(
      "select * from chapter_audio where book_id = ? and chapter_id = ?",
      bookId,
      chapterId,
    );
    if (!row) return;
    if (row.file) {
      await this.tts.release(row.file, keepSegments);
      await this.removeFile(row.file);
    }
    this.db.run("delete from chapter_audio where book_id = ? and chapter_id = ?", bookId, chapterId);
  }

  /** Removes a book's audio (library files and exports). */
  async deleteBookAudio(bookId: string): Promise<void> {
    for (const row of this.chapterAudio(bookId)) {
      if (!row.file) continue;
      await this.tts.release(row.file, false);
      await this.removeFile(row.file);
    }
    this.db.run("delete from chapter_audio where book_id = ?", bookId);
    await rm(join(this.dataDir, "exports", bookId), { recursive: true, force: true });
  }

  /**
   * Checks the index against the disk: files moved by a template change are
   * found at their new place, missing ones are dropped from the index (and
   * will be generated again if needed).
   */
  async rescan(): Promise<RescanResult> {
    const rows = this.db.all<ChapterAudioRow>("select * from chapter_audio");
    const result: RescanResult = { checked: rows.length, missing: 0, moved: 0 };
    for (const row of rows) {
      if (!row.file || existsSync(this.abs(row.file))) continue;
      const book = this.book(row.book_id);
      const expected = book ? this.chapterPath(book, row.chapter_id) : undefined;
      if (expected && expected !== row.file && existsSync(this.abs(expected))) {
        this.db.run(
          "update chapter_audio set file = ? where book_id = ? and chapter_id = ?",
          expected,
          row.book_id,
          row.chapter_id,
        );
        this.tts.moved(row.file, expected);
        result.moved++;
      } else {
        await this.tts.release(row.file, false);
        this.db.run("delete from chapter_audio where book_id = ? and chapter_id = ?", row.book_id, row.chapter_id);
        result.missing++;
      }
    }
    return result;
  }

  /** Moves every file to where the current storage template puts it. */
  async relayout(): Promise<RescanResult> {
    const rows = this.db.all<ChapterAudioRow>("select * from chapter_audio");
    const result: RescanResult = { checked: rows.length, missing: 0, moved: 0 };
    for (const row of rows) {
      const book = this.book(row.book_id);
      const expected = book ? this.chapterPath(book, row.chapter_id) : undefined;
      if (!row.file || !book || !expected || expected === row.file) continue;
      const from = this.abs(row.file);
      if (!existsSync(from)) {
        result.missing++;
        continue;
      }
      const to = this.abs(expected);
      await mkdir(dirname(to), { recursive: true });
      await this.moveInto(from, to);
      await this.placeCover(book.id, dirname(to));
      await this.pruneDirs(dirname(from));
      this.db.run(
        "update chapter_audio set file = ? where book_id = ? and chapter_id = ?",
        expected,
        row.book_id,
        row.chapter_id,
      );
      this.tts.moved(row.file, expected);
      result.moved++;
    }
    return result;
  }

  async stats(): Promise<LibraryStats> {
    const lib = this.db.get<{ n: number; bytes: number }>("select count(*) as n, coalesce(sum(bytes), 0) as bytes from chapter_audio")!;
    const seg = this.db.get<{ n: number; bytes: number }>("select count(*) as n, coalesce(sum(bytes), 0) as bytes from segments where start is null")!;
    const books = this.db.get<{ n: number }>("select count(*) as n from books")!;
    const exports = await dirSize(join(this.dataDir, "exports"));
    return {
      books: books.n,
      chapterFiles: lib.n,
      libraryBytes: lib.bytes,
      segmentFiles: seg.n,
      segmentBytes: seg.bytes,
      cacheBytes: exports.bytes,
      libraryDir: this.dir,
      ffmpeg: await this.ffmpeg.check(),
    };
  }

  /** Records a chapter that has nothing to read aloud (only illustrations). */
  markSilent(bookId: string, chapterId: string, profile: string): void {
    this.db.run(
      `insert into chapter_audio (book_id, chapter_id, profile, file, bytes, duration, updated_at) values (?, ?, ?, '', 0, 0, ?)
       on conflict (book_id, chapter_id) do update set profile = excluded.profile, file = '', bytes = 0, duration = 0,
       updated_at = excluded.updated_at`,
      bookId,
      chapterId,
      profile,
      Date.now(),
    );
  }
}
