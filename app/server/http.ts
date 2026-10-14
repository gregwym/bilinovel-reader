import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { createReadStream, existsSync, statSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { extname, join, normalize, sep } from "node:path";
import { Readable } from "node:stream";
import { Hono, type Context } from "hono";
import { getCookie, setCookie, deleteCookie } from "hono/cookie";
import { FetchError, ParseError } from "../../src/adapters/types";
import { SpeechEngineError } from "../../src/speech/SpeechEngine";
import { GEMINI_VOICES } from "../../src/speech/GeminiSpeechEngine";
import { listFishVoices } from "../../src/speech/FishSpeechEngine";
import { mergeProgress, type SavedProgress } from "../../src/reader/ProgressStore";
import type { AppInfo, PageProvider, ServerSettingsUpdate } from "../shared/api";
import type { Db } from "./db";
import type { Config, Settings } from "./config";
import type { SiteClient } from "./site/client";
import type { SiteSource } from "./site/source";
import type { Ffmpeg } from "./audio/ffmpeg";
import { PROVIDERS, READER_SETTINGS_KEY, describeError, type Tts } from "./tts";
import type { Library } from "./library";
import { bookCatalog, safeName } from "./library";
import { PROGRESS_KEY, type Books } from "./books";
import { READER_PRIORITY, type Jobs } from "./jobs";
import type { Planner } from "./planner";

export interface AppDeps {
  config: Config;
  version: string;
  db: Db;
  settings: Settings;
  client: SiteClient;
  source: SiteSource;
  ffmpeg: Ffmpeg;
  tts: Tts;
  library: Library;
  books: Books;
  jobs: Jobs;
  planner: Planner;
}

/** Keys the reader may store on the server (its settings and progress). */
const KV_KEYS = new Set([READER_SETTINGS_KEY, PROGRESS_KEY]);
const SESSION_COOKIE = "br_session";

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".webmanifest": "application/manifest+json",
  ".mp3": "audio/mpeg",
  ".m4b": "audio/mp4",
};

const isProvider = (p: string): p is PageProvider => (PROVIDERS as string[]).includes(p);

/** Status and message for an error from the site, a service or the library (also logged). */
function errorResponse(c: Context, err: unknown) {
  console.warn(`[library] ${c.req.method} ${c.req.path}:`, err instanceof Error ? `${err.name}: ${err.message}` : String(err));
  if (err instanceof SpeechEngineError) return c.json({ error: err.message, code: err.code }, 502);
  if (err instanceof FetchError) {
    const where = err.status ? `HTTP ${err.status}` : err.message;
    return c.json(
      {
        error: err.challenge
          ? `站点要求人机验证（${err.message}）：请在设置中填写 Cookie 或配置 FlareSolverr`
          : `无法访问站点（${where}）：${err.url}`,
        code: err.challenge ? "challenge" : "fetch",
        status: err.status,
      },
      502,
    );
  }
  if (err instanceof ParseError) return c.json({ error: `无法解析页面：${err.message}`, code: "parse" }, 502);
  return c.json({ error: err instanceof Error ? err.message : String(err), code: "error" }, 500);
}

/** Serves a file with Range support (audio seeking on iOS needs it). */
function sendFile(c: Context, file: string, type: string, extra: Record<string, string> = {}): Response {
  const size = statSync(file).size;
  const headers: Record<string, string> = { "Content-Type": type, "Accept-Ranges": "bytes", ...extra };
  const range = /^bytes=(\d*)-(\d*)$/.exec(c.req.header("range") ?? "");
  if (range && (range[1] || range[2])) {
    let start = range[1] ? Number(range[1]) : size - Number(range[2]);
    let end = range[1] && range[2] ? Number(range[2]) : size - 1;
    start = Math.max(0, start);
    end = Math.min(size - 1, end);
    if (start > end || start >= size) {
      return new Response(null, { status: 416, headers: { "Content-Range": `bytes */${size}` } });
    }
    const body = Readable.toWeb(createReadStream(file, { start, end })) as ReadableStream;
    return new Response(body, {
      status: 206,
      headers: { ...headers, "Content-Range": `bytes ${start}-${end}/${size}`, "Content-Length": String(end - start + 1) },
    });
  }
  if (c.req.method === "HEAD") return new Response(null, { headers: { ...headers, "Content-Length": String(size) } });
  const body = Readable.toWeb(createReadStream(file)) as ReadableStream;
  return new Response(body, { headers: { ...headers, "Content-Length": String(size) } });
}

/** `filename*` for non-ASCII download names. */
const disposition = (name: string) => `attachment; filename="audiobook.m4b"; filename*=UTF-8''${encodeURIComponent(name)}`;

/** Image hosts the proxy refuses (the server's own network). */
function privateHost(host: string): boolean {
  const h = host.replace(/^\[|\]$/g, "").toLowerCase();
  return (
    h === "localhost" ||
    h.endsWith(".local") ||
    h.endsWith(".internal") ||
    /^(127|10|0)\./.test(h) ||
    /^192\.168\./.test(h) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(h) ||
    /^169\.254\./.test(h) ||
    h === "::1" ||
    /^f[cd]/.test(h) ||
    /^fe80:/.test(h) ||
    !h.includes(".")
  );
}

export function createApp(d: AppDeps): Hono {
  const app = new Hono();
  const { config, db } = d;

  // -------------------------------------------------------------------------
  // Password (optional): a signed cookie

  let secret = db.getKv("server.secret");
  if (!secret) {
    secret = randomBytes(32).toString("hex");
    db.setKv("server.secret", secret);
  }
  const token = config.password
    ? createHmac("sha256", secret).update(`session:${config.password}`).digest("hex")
    : undefined;
  const loggedIn = (c: Context) => {
    if (!token) return true;
    const got = getCookie(c, SESSION_COOKIE) ?? "";
    return got.length === token.length && timingSafeEqual(Buffer.from(got), Buffer.from(token));
  };

  app.use("/api/*", async (c, next) => {
    const open = c.req.path === "/api/info" || c.req.path === "/api/login";
    if (!open && !loggedIn(c)) return c.json({ error: "需要登录", code: "login" }, 401);
    await next();
  });

  app.get("/api/info", async (c) => {
    const info: AppInfo = {
      version: d.version,
      auth: !!token,
      loggedIn: loggedIn(c),
      ffmpeg: await d.ffmpeg.check(),
      profile: d.tts.profile(),
      siteOrigin: d.settings.get().siteOrigin,
    };
    return c.json(info);
  });

  app.post("/api/login", async (c) => {
    const { password } = await c.req.json<{ password?: string }>().catch(() => ({ password: undefined }));
    if (!token || !config.password) return c.json({ ok: true });
    const a = createHash("sha256").update(String(password ?? "")).digest();
    const b = createHash("sha256").update(config.password).digest();
    if (!timingSafeEqual(a, b)) return c.json({ error: "密码不正确", code: "password" }, 401);
    setCookie(c, SESSION_COOKIE, token, {
      httpOnly: true,
      sameSite: "Lax",
      path: "/",
      maxAge: 365 * 86400,
      secure: new URL(c.req.url).protocol === "https:" || c.req.header("x-forwarded-proto") === "https",
    });
    return c.json({ ok: true });
  });

  app.post("/api/logout", (c) => {
    deleteCookie(c, SESSION_COOKIE, { path: "/" });
    return c.json({ ok: true });
  });

  // -------------------------------------------------------------------------
  // Books

  app.get("/api/books", (c) => {
    const progress = d.books.progress();
    return c.json(d.books.list().map((b) => d.books.summary(b, progress)));
  });

  app.post("/api/books", async (c) => {
    const { url } = await c.req.json<{ url?: string }>().catch(() => ({ url: undefined }));
    if (!url) return c.json({ error: "请输入书籍链接或编号", code: "input" }, 400);
    try {
      const book = await d.books.add(url);
      d.planner.plan(book.id);
      void d.books.pending(book.id)?.then(() => d.planner.plan(book.id), () => undefined);
      return c.json(d.books.summary(book));
    } catch (err) {
      if (err instanceof Error && err.message === "无法识别的书籍链接") return c.json({ error: err.message, code: "input" }, 400);
      return errorResponse(c, err);
    }
  });

  app.get("/api/books/:id", (c) => {
    const book = d.books.get(c.req.param("id"));
    return book ? c.json(d.books.detail(book)) : c.json({ error: "书籍不存在" }, 404);
  });

  app.patch("/api/books/:id", async (c) => {
    const id = c.req.param("id");
    if (!d.books.get(id)) return c.json({ error: "书籍不存在" }, 404);
    const patch = await c.req.json<{ follow?: boolean; ahead?: number }>().catch(() => ({}));
    const book = d.books.update(id, patch);
    d.planner.plan(id);
    return c.json(d.books.detail(book));
  });

  app.delete("/api/books/:id", async (c) => {
    const id = c.req.param("id");
    d.jobs.cancelBook(id);
    await d.books.remove(id);
    return c.json({ ok: true });
  });

  app.post("/api/books/:id/refresh", async (c) => {
    try {
      const book = await d.books.refreshWithin(c.req.param("id"));
      d.planner.plan(book.id);
      void d.books.pending(book.id)?.then(() => d.planner.plan(book.id), () => undefined);
      return c.json(d.books.detail(book));
    } catch (err) {
      return errorResponse(c, err);
    }
  });

  app.get("/api/books/:id/cover", (c) => {
    const file = d.library.coverFile(c.req.param("id"));
    if (!existsSync(file)) return c.body(null, 404);
    return sendFile(c, file, "image/jpeg", { "Cache-Control": "private, max-age=86400" });
  });

  /** Queues chapters: `chapters`, a `volume`, or `from` a chapter onwards (`count` chapters). */
  app.post("/api/books/:id/generate", async (c) => {
    const book = d.books.get(c.req.param("id"));
    if (!book) return c.json({ error: "书籍不存在" }, 404);
    if (!d.tts.profile()) return c.json({ error: "请先在设置中配置 Gemini 或 Fish Audio 密钥", code: "config" }, 400);
    const body = await c.req
      .json<{ chapters?: string[]; volume?: number; from?: string; count?: number; all?: boolean }>()
      .catch(() => ({}) as Record<string, never>);
    const catalog = bookCatalog(book);
    const all = (catalog?.volumes ?? []).flatMap((v, vi) =>
      v.chapters.flatMap((ch) => (ch.chapterId ? [{ id: ch.chapterId, title: ch.title, vi }] : [])),
    );
    let pick = all;
    if (body.chapters) pick = all.filter((ch) => body.chapters!.includes(ch.id));
    else if (body.volume !== undefined) pick = all.filter((ch) => ch.vi === body.volume);
    else if (body.from) {
      const i = all.findIndex((ch) => ch.id === body.from);
      pick = i < 0 ? [] : all.slice(i, body.count ? i + body.count : undefined);
    } else if (!body.all) pick = [];
    const profile = d.tts.profile()!;
    const profileId = d.tts.profileId(profile);
    const ready = new Map(d.library.chapterAudio(book.id).map((r) => [r.chapter_id, r.profile === profileId]));
    let queued = 0;
    for (const ch of pick) {
      if (ready.get(ch.id)) continue;
      d.jobs.enqueueChapter(book.id, ch.id, ch.title, "manual");
      queued++;
    }
    return c.json({ queued });
  });

  app.delete("/api/books/:id/audio", async (c) => {
    const id = c.req.param("id");
    const chapterId = c.req.query("chapter");
    if (chapterId) await d.library.deleteChapter(id, chapterId);
    else {
      d.jobs.cancelBook(id);
      await d.library.deleteBookAudio(id);
    }
    return c.json({ ok: true });
  });

  app.on(["GET", "HEAD"], "/api/books/:id/chapters/:chapter/audio", (c) => {
    const row = d.library
      .chapterAudio(c.req.param("id"))
      .find((r) => r.chapter_id === c.req.param("chapter"));
    if (!row?.file) return c.body(null, 404);
    const file = d.library.abs(row.file);
    if (!existsSync(file)) return c.body(null, 404);
    return sendFile(c, file, "audio/mpeg", { "Cache-Control": "private, max-age=3600" });
  });

  app.post("/api/books/:id/volumes/:vi/export", (c) => {
    const book = d.books.get(c.req.param("id"));
    const vi = Number(c.req.param("vi"));
    const volume = book && bookCatalog(book)?.volumes[vi];
    if (!book || !volume) return c.json({ error: "该卷不存在" }, 404);
    const id = d.jobs.enqueueExport(book.id, vi, `${volume.title}（导出 M4B）`);
    return c.json({ job: id });
  });

  app.on(["GET", "HEAD"], "/api/books/:id/volumes/:vi/export", (c) => {
    const book = d.books.get(c.req.param("id"));
    const vi = Number(c.req.param("vi"));
    const volume = book && bookCatalog(book)?.volumes[vi];
    const file = book ? d.library.exportFile(book.id, vi) : "";
    if (!book || !volume || !existsSync(file)) return c.body(null, 404);
    const name = `${safeName(book.title)} - ${String(vi + 1).padStart(2, "0")} ${safeName(volume.title)}.m4b`;
    return sendFile(c, file, "audio/mp4", { "Content-Disposition": disposition(name) });
  });

  // -------------------------------------------------------------------------
  // Reader content

  app.get("/api/page", async (c) => {
    const book = c.req.query("book") ?? "";
    const chapter = c.req.query("chapter") ?? "";
    const page = Number(c.req.query("page") ?? 0);
    if (!/^\d+$/.test(book) || !/^\d+$/.test(chapter) || !Number.isInteger(page) || page < 0) {
      return c.json({ error: "参数错误" }, 400);
    }
    try {
      return c.json(await d.source.page(book, chapter, page, c.req.query("refresh") === "1"));
    } catch (err) {
      return errorResponse(c, err);
    }
  });

  app.get("/api/catalog/:id", async (c) => {
    const id = c.req.param("id");
    const book = d.books.get(id);
    const saved = book && bookCatalog(book);
    if (saved && book.catalog_at && Date.now() - book.catalog_at < 3600_000) return c.json(saved);
    try {
      const catalog = await d.source.catalog(id);
      if (book) db.run("update books set catalog = ?, catalog_at = ? where id = ?", JSON.stringify(catalog), Date.now(), id);
      return c.json(catalog);
    } catch (err) {
      return saved ? c.json(saved) : errorResponse(c, err);
    }
  });

  /** Illustrations, through the server (the site checks the referrer) and kept on disk. */
  app.get("/api/img", async (c) => {
    const raw = c.req.query("url") ?? "";
    let url: URL;
    try {
      url = new URL(raw);
    } catch {
      return c.body(null, 400);
    }
    if (!/^https?:$/.test(url.protocol) || privateHost(url.hostname)) return c.body(null, 403);
    const digest = createHash("sha1").update(url.href).digest("hex");
    const dir = join(config.dataDir, "images", digest.slice(0, 2));
    const file = join(dir, digest);
    const cache = { "Cache-Control": "private, max-age=2592000, immutable" };
    if (existsSync(file) && existsSync(`${file}.type`)) {
      return sendFile(c, file, (await readFile(`${file}.type`, "utf8")).trim(), cache);
    }
    try {
      const img = await d.client.binary(url.href, `${d.settings.get().siteOrigin}/`);
      if (!/^image\//.test(img.type)) return c.body(null, 502);
      await mkdir(dir, { recursive: true });
      await writeFile(file, img.body);
      await writeFile(`${file}.type`, img.type);
      return c.body(new Uint8Array(img.body), 200, { "Content-Type": img.type, ...cache });
    } catch (err) {
      return errorResponse(c, err);
    }
  });

  // -------------------------------------------------------------------------
  // Speech for the reader

  app.get("/api/segments/:provider/:key", async (c) => {
    const provider = c.req.param("provider");
    if (!isProvider(provider)) return c.body(null, 404);
    const seg = await d.tts.read(provider, c.req.param("key"));
    if (!seg) return c.body(null, 404);
    return c.body(new Uint8Array(seg.data), 200, {
      "Content-Type": seg.mime,
      "X-Bounds": JSON.stringify(seg.bounds),
      "Cache-Control": "private, max-age=31536000, immutable",
    });
  });

  app.post("/api/segments/:provider", async (c) => {
    const provider = c.req.param("provider");
    if (!isProvider(provider)) return c.body(null, 404);
    const body = await c.req
      .json<{ texts?: unknown; voice?: { model?: string; voice?: string; style?: string } }>()
      .catch(() => ({}) as { texts?: unknown; voice?: undefined });
    const texts = body.texts;
    if (!Array.isArray(texts) || !texts.length || !texts.every((t) => typeof t === "string") || texts.join("").length > 20_000) {
      return c.json({ error: "参数错误" }, 400);
    }
    const voice = body.voice ?? {};
    try {
      const seg = await d.tts.segment(provider, texts as string[], {
        voice: {
          model: typeof voice.model === "string" ? voice.model : undefined,
          voice: typeof voice.voice === "string" ? voice.voice : undefined,
          style: typeof voice.style === "string" ? voice.style : undefined,
        },
        priority: READER_PRIORITY,
      });
      const data = await readFile(seg.file);
      return c.body(new Uint8Array(data), 200, { "Content-Type": seg.mime, "X-Bounds": JSON.stringify(seg.bounds) });
    } catch (err) {
      if (err instanceof SpeechEngineError) {
        return c.json({ error: describeError(provider, err.code), code: err.code }, err.code === "config" ? 400 : 502);
      }
      return errorResponse(c, err);
    }
  });

  app.get("/api/voices/:provider", async (c) => {
    const provider = c.req.param("provider");
    if (provider === "gemini") return c.json(GEMINI_VOICES);
    if (provider !== "fish") return c.json([], 404);
    const key = d.settings.key("fish");
    if (!key) return c.json({ error: describeError("fish", "config"), code: "config" }, 400);
    try {
      return c.json(await listFishVoices(key));
    } catch (err) {
      return errorResponse(c, err);
    }
  });

  // -------------------------------------------------------------------------
  // Reader settings and progress (synced between devices)

  app.get("/api/kv/:key", (c) => {
    const key = c.req.param("key");
    if (!KV_KEYS.has(key)) return c.body(null, 404);
    const value = db.getKv(key);
    return c.json({ value: value ?? null });
  });

  app.put("/api/kv/:key", async (c) => {
    const key = c.req.param("key");
    if (!KV_KEYS.has(key)) return c.body(null, 404);
    const { value } = await c.req.json<{ value?: unknown }>().catch(() => ({ value: undefined }));
    if (typeof value !== "string" || value.length > 2_000_000) return c.json({ error: "参数错误" }, 400);
    try {
      JSON.parse(value);
    } catch {
      return c.json({ error: "参数错误" }, 400);
    }
    if (key === PROGRESS_KEY) {
      const before = db.getJson<Record<string, SavedProgress>>(PROGRESS_KEY) ?? {};
      const merged = mergeProgress(db.getKv(PROGRESS_KEY) ?? "{}", value);
      db.setKv(PROGRESS_KEY, merged);
      const after = JSON.parse(merged) as Record<string, SavedProgress>;
      for (const [bookId, p] of Object.entries(after)) {
        if (before[bookId]?.updatedAt === p.updatedAt || !/^\d+$/.test(bookId)) continue;
        d.books.ensure(bookId, p.bookTitle);
        d.books.touch(bookId, p.updatedAt);
        d.planner.plan(bookId);
      }
      return c.json({ value: merged });
    }
    db.setKv(key, value);
    // The voice may have changed: blocked jobs can try again, and followed books get the new voice.
    d.jobs.unblock();
    void d.planner.planAll(false);
    return c.json({ value });
  });

  // -------------------------------------------------------------------------
  // Jobs

  app.get("/api/jobs", (c) => c.json(d.jobs.overview()));
  app.post("/api/jobs/:id/cancel", (c) => (d.jobs.cancel(Number(c.req.param("id"))), c.json({ ok: true })));
  app.post("/api/jobs/:id/retry", (c) => (d.jobs.retry(Number(c.req.param("id"))), c.json({ ok: true })));
  app.post("/api/jobs/pause", (c) => (d.jobs.setPaused(true), c.json({ ok: true })));
  app.post("/api/jobs/resume", (c) => (d.jobs.setPaused(false), d.jobs.unblock(), c.json({ ok: true })));
  app.post("/api/jobs/clear", (c) => (d.jobs.clear(), c.json({ ok: true })));

  // -------------------------------------------------------------------------
  // Settings and library maintenance

  app.get("/api/settings", (c) =>
    c.json({ ...d.settings.view(), usage: { gemini: d.tts.usage("gemini"), fish: d.tts.usage("fish") } }),
  );

  app.put("/api/settings", async (c) => {
    const patch = await c.req.json<ServerSettingsUpdate>().catch(() => ({}));
    const view = d.settings.update(patch);
    return c.json(view);
  });

  /** Connection test: one request to the site's home page. */
  app.post("/api/site/test", async (c) => c.json(await d.client.probe(`${d.settings.get().siteOrigin}/`)));

  app.get("/api/library/stats", async (c) => c.json(await d.library.stats()));
  app.post("/api/library/rescan", async (c) => {
    const result = await d.library.rescan();
    void d.planner.planAll(false);
    return c.json(result);
  });
  app.post("/api/library/relayout", async (c) => c.json(await d.library.relayout()));
  app.post("/api/library/clear-segments", async (c) => {
    await d.tts.clear();
    return c.json({ ok: true });
  });

  app.all("/api/*", (c) => c.json({ error: "Not found" }, 404));

  // -------------------------------------------------------------------------
  // Web app (single page: every other path gets index.html)

  const webRoot = normalize(config.webDir);
  app.get("*", async (c) => {
    const path = decodeURIComponent(new URL(c.req.url).pathname);
    const file = normalize(join(webRoot, path));
    if (file.startsWith(webRoot + sep) && existsSync(file) && statSync(file).isFile()) {
      const cache = path.startsWith("/assets/") ? "public, max-age=31536000, immutable" : "no-cache";
      return sendFile(c, file, MIME[extname(file)] ?? "application/octet-stream", { "Cache-Control": cache });
    }
    const index = join(webRoot, "index.html");
    if (!existsSync(index)) return c.text("Web app not built (npm run build:app)", 404);
    return sendFile(c, index, MIME[".html"], { "Cache-Control": "no-cache" });
  });

  return app;
}
