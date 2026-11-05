import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { HttpRequest, HttpResponse } from "../../src/utils/http";
import { Db } from "./db";
import { Settings, type Config } from "./config";
import { SiteClient } from "./site/client";
import { SiteSource } from "./site/source";
import { Ffmpeg } from "./audio/ffmpeg";
import { Tts } from "./tts";
import { Library } from "./library";
import { Backup } from "./backup";
import { Images } from "./images";
import { Books } from "./books";
import { Jobs } from "./jobs";
import { Planner } from "./planner";
import type { AppDeps } from "./http";

export interface ServiceOptions {
  /** Site requests (tests pass a fake). */
  fetch?: (url: string, init?: RequestInit) => Promise<Response>;
  /** Speech service requests (tests pass a fake). */
  request?: (req: HttpRequest) => Promise<HttpResponse>;
  sleep?: (ms: number) => Promise<void>;
  ffmpeg?: Ffmpeg;
}

/** Wires the server's parts together. */
export function createServices(config: Config, version: string, options: ServiceOptions = {}): AppDeps {
  mkdirSync(config.dataDir, { recursive: true });
  mkdirSync(config.libraryDir, { recursive: true });
  const db = new Db(join(config.dataDir, "library.db"));
  const settings = new Settings(db, config);
  const client = new SiteClient(() => settings.get(), options.fetch, options.sleep);
  const source = new SiteSource(db, client, () => settings.get().siteOrigin);
  const ffmpeg = options.ffmpeg ?? new Ffmpeg(config.ffmpeg, config.ffprobe);
  const tts = new Tts(db, settings, ffmpeg, config.dataDir, config.libraryDir, options.request, options.sleep);
  const images = new Images(db, client, config.dataDir, config.libraryDir, () => `${settings.get().siteOrigin}/`);
  const library = new Library(db, settings, ffmpeg, tts, images, config.libraryDir, config.dataDir);
  const backup = new Backup(db, library, source, images);
  source.setBackup((b, c, i) => backup.page(b, c, i));
  // A new install (or a lost database) reads back what the library holds.
  const restored = backup.restore();
  if (restored.books) console.log(`[backup] restored ${restored.books} book(s) from the library`);
  const books = new Books(db, settings, source, client, library, tts, ffmpeg);
  const jobs = new Jobs(db, source, tts, library, ffmpeg);
  const planner = new Planner(books, jobs, tts, library, source);
  books.onRecovered((id, recovered) => jobs.recoverChapters(id, recovered));
  source.onPageCached((id, chapterId) => {
    books.reconcile(id);
    void backup.saveChapter(id, chapterId);
  });
  books.onCatalog((id) => {
    void backup.saveBook(id);
    void library.updateCovers(id);
  });
  books.onRemoved((id) => backup.removeBook(id));
  library.onChange((id, chapterId) => void backup.saveChapter(id, chapterId));
  // Upgrade existing libraries before the planner sees their reading positions.
  // This is idempotent and does not require fetching the catalog again.
  for (const book of books.list()) books.reconcile(book.id);
  // What was cached before (or changed while the server was down) into the library.
  void backup.saveAll();
  void (async () => {
    for (const book of books.list()) await library.updateCovers(book.id);
  })();
  settings.onChange(() => {
    client.reset();
    jobs.unblock();
  });
  return { config, version, db, settings, client, source, ffmpeg, tts, library, images, backup, books, jobs, planner };
}
