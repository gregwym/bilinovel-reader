// @vitest-environment node
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig } from "../../app/server/config";
import { createServices } from "../../app/server/services";
import { createApp } from "../../app/server/http";
import { Ffmpeg } from "../../app/server/audio/ffmpeg";
import type { BookDetail, BookSummary, ChapterSegments, JobsOverview } from "../../app/shared/api";
import type { HttpRequest, HttpResponse } from "../../src/utils/http";
import { fixture } from "../helpers";

const ORIGIN = "https://www.bilinovel.com";

const BOOK_PAGE = `<!doctype html><html><head><title>测试轻小说_哔哩轻小说</title>
<meta property="og:novel:book_name" content="测试轻小说">
<meta property="og:novel:author" content="测试作者">
<meta property="og:image" content="https://img3.readpai.com/5/5369/5369s.jpg">
<meta property="og:description" content="一本用于测试的书。">
</head><body><h1 class="book-title">测试轻小说</h1></body></html>`;

const PAGES: Record<string, string> = {
  "/novel/5369.html": BOOK_PAGE,
  "/novel/5369/catalog": fixture("catalog.html"),
  "/novel/5369/180204.html": fixture("paginated-page-1.html"),
  "/novel/5369/180204_2.html": fixture("paginated-page-2.html"),
  "/novel/5369/180204_3.html": fixture("next-chapter.html"),
  "/novel/5369/180205.html": fixture("chapter-with-images.html"),
  "/novel/5369/180207.html": fixture("shuffled-2026-05.html"),
  "/scripts/chapterlog.js": fixture("chapterlog-2026-05.js"),
  "/novel/7777.html": BOOK_PAGE,
  "/novel/7777/catalog": fixture("catalog.html").replaceAll("5369", "7777"),
};

/** Holds requests for book 7777 until released (a slow site). */
let siteGate: Promise<void> = Promise.resolve();

const hasFfmpeg = (() => {
  try {
    execFileSync("ffmpeg", ["-version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();

let dir: string;
let mp3: Buffer;
const siteRequests: string[] = [];
let ttsRequests: { url: string; text: string }[] = [];
let ttsStatus = 200;
let services: ReturnType<typeof createServices>;
let app: ReturnType<typeof createApp>;

async function siteFetch(url: string): Promise<Response> {
  const u = new URL(url);
  siteRequests.push(u.pathname);
  if (u.pathname.startsWith("/novel/7777")) await siteGate;
  if (/readpai\.com/.test(u.hostname)) {
    return new Response(new Uint8Array(readFileSync(join(dir, "cover.png"))), { headers: { "content-type": "image/png" } });
  }
  const body = PAGES[u.pathname];
  return body ? new Response(body, { headers: { "content-type": "text/html" } }) : new Response("missing", { status: 404 });
}

async function ttsRequest(req: HttpRequest): Promise<HttpResponse> {
  ttsRequests.push({ url: req.url, text: req.body ? (JSON.parse(req.body) as { text: string }).text : "" });
  if (ttsStatus !== 200) return { status: ttsStatus, headers: {}, body: new ArrayBuffer(0) };
  const body = mp3.buffer.slice(mp3.byteOffset, mp3.byteOffset + mp3.byteLength) as ArrayBuffer;
  return { status: 200, headers: { "content-type": "audio/mpeg" }, body };
}

const json = async <T>(res: Response | Promise<Response>): Promise<T> => (await res).json() as Promise<T>;
const call = (path: string, init?: RequestInit) => app.request(path, init);
const send = (method: string, path: string, body?: unknown) =>
  app.request(path, { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });

async function waitFor<T>(fn: () => T | undefined | false | Promise<T | undefined | false>, ms = 20_000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 50));
  }
}

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "bili-app-"));
  if (hasFfmpeg) {
    execFileSync("ffmpeg", ["-loglevel", "error", "-f", "lavfi", "-i", "sine=frequency=440:duration=2", "-ac", "1", "-b:a", "32k", join(dir, "tone.mp3")]);
    execFileSync("ffmpeg", ["-loglevel", "error", "-f", "lavfi", "-i", "color=c=red:s=60x80", "-frames:v", "1", join(dir, "cover.png")]);
    mp3 = readFileSync(join(dir, "tone.mp3"));
  }
  const config = loadConfig({ DATA_DIR: join(dir, "data"), LIBRARY_DIR: join(dir, "library"), WEB_DIR: join(dir, "web"), FISH_API_KEY: "fish-key" }, dir);
  services = createServices(config, "test", {
    fetch: (url) => siteFetch(url),
    request: ttsRequest,
    sleep: async () => undefined,
    ffmpeg: new Ffmpeg(),
  });
  app = createApp(services);
});

afterAll(async () => {
  services.jobs.setPaused(true);
  services.jobs.stop();
  await waitFor(() => !services.jobs.overview().counts.running);
  services.db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("library server", () => {
  it("reports the app and the voice profile", async () => {
    const info = await json<{ auth: boolean; profile?: { provider: string } }>(call("/api/info"));
    expect(info.auth).toBe(false);
    // Fish has a key (environment), so it is the generation voice.
    expect(info.profile?.provider).toBe("fish");
  });

  it("serves chapter pages for the reader, fetched once", async () => {
    const page = await json<{ chapterId: string; paragraphs: unknown[]; nextType: string }>(
      call("/api/page?book=5369&chapter=180207&page=0"),
    );
    expect(page.chapterId).toBe("180207");
    expect(page.paragraphs.length).toBeGreaterThan(3);
    const before = siteRequests.length;
    await call("/api/page?book=5369&chapter=180207&page=0");
    expect(siteRequests.length).toBe(before);
    expect(siteRequests).toContain("/scripts/chapterlog.js");
  });

  it.skipIf(!hasFfmpeg)("adds a book with its catalog and cover", async () => {
    const res = await send("POST", "/api/books", { url: `${ORIGIN}/novel/5369/180204.html` });
    expect(res.status).toBe(200);
    const book = await json<BookSummary>(res);
    expect(book).toMatchObject({ id: "5369", title: "测试轻小说", author: "测试作者", hasCover: true });
    expect(book.chapters).toBeGreaterThan(3);
    // Generation is slow: following the reading position is opt-in.
    expect(book.follow).toBe(false);
    const list = await json<BookSummary[]>(call("/api/books"));
    expect(list.map((b) => b.id)).toEqual(["5369"]);
    expect((await call("/api/books/5369/cover")).headers.get("content-type")).toBe("image/jpeg");
  });

  it.skipIf(!hasFfmpeg)("generates a chapter into the library", async () => {
    ttsRequests = [];
    const res = await json<{ queued: number }>(send("POST", "/api/books/5369/generate", { chapters: ["180204"] }));
    expect(res.queued).toBe(1);
    const chapter = (d: BookDetail) => d.volumes.flatMap((v) => v.chapters).find((c) => c.chapterId === "180204")!;
    const detail = await waitFor(async () => {
      const d = await json<BookDetail>(call("/api/books/5369"));
      return chapter(d).audio === "done" && d;
    });
    // Three site pages, one request each (short pages).
    expect(ttsRequests).toHaveLength(3);
    expect(ttsRequests[0].url).toBe("https://api.fish.audio/v1/tts");
    expect(chapter(detail).duration).toBeGreaterThan(5);
    expect(detail.audioChapters).toBe(1);
    const files = execFileSync("find", [join(dir, "library"), "-type", "f"]).toString().trim().split("\n").sort();
    expect(files.map((f) => f.slice(join(dir, "library").length + 1))).toEqual([
      "测试作者/测试轻小说/01 第一卷 开始/004 第四章 分页的章节.mp3",
      "测试作者/测试轻小说/01 第一卷 开始/cover.jpg",
    ]);
    const audio = await call("/api/books/5369/chapters/180204/audio", { headers: { range: "bytes=0-99" } });
    expect(audio.status).toBe(206);
    expect((await audio.arrayBuffer()).byteLength).toBe(100);
  });

  it.skipIf(!hasFfmpeg)("serves the generated segments to the reader without new requests", async () => {
    const page = await json<{ paragraphs: { text?: string }[] }>(call("/api/page?book=5369&chapter=180204&page=1"));
    const texts = page.paragraphs.flatMap((p) => (p.text ? [p.text] : []));
    ttsRequests = [];
    const res = await send("POST", "/api/segments/fish", { texts, voice: { model: "s2.1-pro-free", voice: "" } });
    expect(res.status).toBe(200);
    expect(JSON.parse(res.headers.get("x-bounds")!)).toHaveLength(texts.length + 1);
    expect(ttsRequests).toHaveLength(0);
  });

  it.skipIf(!hasFfmpeg)("lists a chapter's segments, each playable once generated", async () => {
    const segs = await json<ChapterSegments>(call("/api/books/5369/chapters/180204/segments"));
    expect(segs).toMatchObject({ provider: "fish", complete: true });
    expect(segs.segments).toHaveLength(3);
    expect(segs.segments.every((s) => s.ready && s.text.length > 0)).toBe(true);
    const audio = await call(`/api/segments/fish/${encodeURIComponent(segs.segments[0].key)}`);
    expect(audio.status).toBe(200);
    expect(audio.headers.get("content-type")).toBe("audio/mpeg");

    // A chapter whose pages were never fetched: nothing yet, more to come.
    const none = await json<ChapterSegments>(call("/api/books/5369/chapters/180206/segments"));
    expect(none).toMatchObject({ complete: false, segments: [] });
  });

  it.skipIf(!hasFfmpeg)("previews a voice once, then from the cache", async () => {
    ttsRequests = [];
    const url = "/api/voices/fish/preview?voice=0123456789abcdef0123456789abcdef&model=s2.1-pro-free";
    expect((await call(url)).status).toBe(200);
    expect((await call(url)).headers.get("content-type")).toBe("audio/mpeg");
    expect(ttsRequests).toHaveLength(1);
  });

  it.skipIf(!hasFfmpeg)("moves files when the storage template changes", async () => {
    await send("PUT", "/api/settings", { storageTemplate: "{book}/{volumeNo}-{chapterNo} {chapter}" });
    const r = await json<{ moved: number }>(send("POST", "/api/library/relayout"));
    expect(r.moved).toBe(1);
    expect(existsSync(join(dir, "library", "测试轻小说", "01-004 第四章 分页的章节.mp3"))).toBe(true);
    expect(existsSync(join(dir, "library", "测试作者"))).toBe(false);
  });

  it.skipIf(!hasFfmpeg)("follows the reading position", async () => {
    await send("PATCH", "/api/books/5369", { follow: true, ahead: 1 });
    const progress = { "5369": { chapterId: "180205", pageIndex: 0, paragraphIndex: 0, updatedAt: Date.now() } };
    await send("PUT", "/api/kv/biliReader.progress", { value: JSON.stringify(progress) });
    const jobs = await json<JobsOverview>(call("/api/jobs"));
    const targets = jobs.jobs.filter((j) => j.reason === "follow" && j.status !== "cancelled").map((j) => j.target);
    expect(targets.sort()).toEqual(["180205", "180206"]);
  });

  it("blocks a service whose key is rejected until settings change", async () => {
    await waitFor(() => !services.jobs.overview().counts.running);
    services.jobs.setPaused(true);
    await send("POST", "/api/jobs/clear");
    ttsStatus = 401;
    services.jobs.setPaused(false);
    await send("DELETE", "/api/books/5369/audio?chapter=180205");
    await send("POST", "/api/library/clear-segments");
    await send("POST", "/api/books/5369/generate", { chapters: ["180205"] });
    const blocked = await waitFor(async () => (await json<JobsOverview>(call("/api/jobs"))).blocked.fish);
    expect(blocked.code).toBe("auth");
    ttsStatus = 200;
    await send("PUT", "/api/settings", { keys: { fish: "new-key" } });
    expect((await json<JobsOverview>(call("/api/jobs"))).blocked.fish).toBeUndefined();
  });

  it("keeps the reader's settings and merges progress", async () => {
    await send("PUT", "/api/kv/biliReader.settings", { value: JSON.stringify({ fontSize: 20 }) });
    expect(await json(call("/api/kv/biliReader.settings"))).toEqual({ value: JSON.stringify({ fontSize: 20 }) });
    expect((await send("PUT", "/api/kv/other", { value: "{}" })).status).toBe(404);
    const old = { "5369": { chapterId: "1", pageIndex: 0, paragraphIndex: 0, updatedAt: 1 } };
    const merged = await json<{ value: string }>(send("PUT", "/api/kv/biliReader.progress", { value: JSON.stringify(old) }));
    expect(JSON.parse(merged.value)["5369"].chapterId).not.toBe("1");
  });

  it("refuses image URLs on the local network", async () => {
    expect((await call("/api/img?url=http://192.168.1.2/x.jpg")).status).toBe(403);
    expect((await call("/api/img?url=http://localhost:8080/x.jpg")).status).toBe(403);
  });
});

describe("site errors", () => {
  it("names the network failure hidden in fetch's cause", async () => {
    const { networkError } = await import("../../app/server/site/client");
    const err = new TypeError("fetch failed", { cause: Object.assign(new Error("getaddrinfo ENOTFOUND www.bilinovel.com"), { code: "ENOTFOUND" }) });
    expect(networkError(err)).toBe("域名解析失败（检查 NAS/容器的 DNS） [ENOTFOUND]: getaddrinfo ENOTFOUND www.bilinovel.com");
  });

  it("reports why adding a book failed, with the site's status", async () => {
    const res = await send("POST", "/api/books", { url: `${ORIGIN}/novel/9999.html` });
    expect(res.status).toBe(502);
    const body = await json<{ error: string; code: string }>(res);
    expect(body.code).toBe("fetch");
    expect(body.error).toBe(`无法访问站点（HTTP 404）：${ORIGIN}/novel/9999/catalog`);
    expect(services.books.get("9999")).toBeUndefined();
  });

  it("answers before a slow site does, and keeps loading the book in the background", async () => {
    let release!: () => void;
    siteGate = new Promise((r) => (release = r));
    const book = await services.books.add(`${ORIGIN}/novel/7777.html`, 50);
    expect(services.books.summary(book)).toMatchObject({ id: "7777", loading: true, chapters: 0 });
    release();
    await services.books.pending("7777");
    const loaded = services.books.summary(services.books.get("7777")!);
    expect(loaded).toMatchObject({ title: "测试轻小说", loading: undefined, loadError: undefined });
    expect(loaded.chapters).toBeGreaterThan(0);

    // A later failure keeps the book and says why.
    siteGate = new Promise((r) => (release = r));
    PAGES["/novel/7777/catalog"] = "";
    const again = await services.books.refreshWithin("7777", 50);
    expect(services.books.summary(again).loading).toBe(true);
    release();
    await services.books.pending("7777")?.catch(() => undefined);
    expect(services.books.summary(services.books.get("7777")!).loadError).toMatch(/HTTP 404/);
    await services.books.remove("7777");
  });

  it("tests the connection to the site", async () => {
    const r = await json<{ ok: boolean; status?: number }>(send("POST", "/api/site/test"));
    // The mocked site has no home page.
    expect(r).toMatchObject({ ok: false, status: 404 });
  });
});
