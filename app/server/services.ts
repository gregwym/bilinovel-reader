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
  const tts = new Tts(db, settings, ffmpeg, config.dataDir, options.request, options.sleep);
  const library = new Library(db, settings, ffmpeg, config.libraryDir, config.dataDir);
  const books = new Books(db, settings, source, client, library, tts, ffmpeg);
  const jobs = new Jobs(db, source, tts, library, ffmpeg);
  const planner = new Planner(books, jobs, tts, library);
  settings.onChange(() => {
    client.reset();
    jobs.unblock();
  });
  return { config, version, db, settings, client, source, ffmpeg, tts, library, books, jobs, planner };
}
