import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, open, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { PageContent } from "../../src/adapters/types";
import { splitIntoChunks } from "../../src/speech/SpeechPlayer";
import { spokenText } from "../../src/speech/spoken";
import { SpeechEngineError } from "../../src/speech/SpeechEngine";
import {
  hash,
  paragraphBounds,
  segmentKey,
  splitPage,
  type BackendIO,
  type PageBackend,
  type Rendered,
} from "../../src/speech/PageSpeechEngine";
import { geminiBackend, describeGeminiError, type GeminiConfig } from "../../src/speech/GeminiSpeechEngine";
import { GEMINI_VOICES } from "../../src/speech/GeminiSpeechEngine";
import {
  FISH_API_BASE,
  FISH_VOICE_ID,
  describeFishError,
  fishBackend,
  listFishVoices,
  type FishConfig,
} from "../../src/speech/FishSpeechEngine";
import { DEFAULT_SETTINGS, sanitizeSettings, type Settings as ReaderSettings } from "../../src/reader/ProgressStore";
import { bodyText, httpRequest, type HttpRequest, type HttpResponse } from "../../src/utils/http";
import { sleep } from "../../src/utils/async";
import type { PageProvider, VoiceProfile } from "../shared/api";
import type { Db } from "./db";
import type { Settings } from "./config";
import type { Ffmpeg } from "./audio/ffmpeg";
import { id3Size, isFrameStart } from "./audio/mp3";

/** Where the reader keeps its settings (synced to the server's key-value store). */
export const READER_SETTINGS_KEY = "biliReader.settings";
export const PROVIDERS: PageProvider[] = ["gemini", "fish"];
/** Gemini reading directions by hash (cache keys only hold the hash). */
const STYLES_KEY = "server.geminiStyles";
/** Paragraph timing method; segments timed by an older one are aligned again when played. */
const BOUNDS_VERSION = 1;
const PROVIDER_LABEL: Record<PageProvider, string> = { gemini: "Gemini", fish: "Fish Audio" };

export interface Configs {
  gemini: GeminiConfig;
  fish: FishConfig;
}

/** A segment as stored: audio file plus paragraph start fractions. */
export interface StoredAudio {
  file: string;
  /** Inside a chapter's library file: where its audio starts after the file's ID3 tag (`bytes` long). */
  start?: number;
  mime: string;
  bounds: number[];
  bytes: number;
  boundsVersion: number;
}

/** A segment's voice settings without the key (what the reader sends). */
export type VoiceRequest = { model?: string; voice?: string; style?: string };

type Lane = { id: string; priority: number; seq: number; run: () => void }[];

export const describeError = (provider: PageProvider, code: string): string =>
  provider === "gemini" ? describeGeminiError(code) : describeFishError(code);

/** Error codes that need the user (no point retrying until settings change). */
export const BLOCKING_CODES = new Set(["config", "auth", "billing", "forbidden", "api-disabled", "location", "model"]);

/**
 * Speech generation on the server. The keys are the server's; the voice is
 * the reader's (its synced settings), so the reader and the background
 * generator produce, and share, the same segments.
 */
export class Tts {
  readonly backends: { [P in PageProvider]: PageBackend<Configs[P]> };
  private readonly lanes: Record<PageProvider, { queue: Lane; busy: boolean; seq: number }> = {
    gemini: { queue: [], busy: false, seq: 0 },
    fish: { queue: [], busy: false, seq: 0 },
  };
  private readonly inflight = new Map<string, Promise<StoredAudio>>();
  /** Fish Audio voice names by id ("" while unknown), and when they were last looked up. */
  private readonly fishNames = new Map<string, string>();
  private fishNamesAt = 0;
  private fishNamesLoading?: Promise<void>;

  constructor(
    private readonly db: Db,
    private readonly settings: Settings,
    private readonly ffmpeg: Ffmpeg,
    private readonly dataDir: string,
    private readonly libraryDir: string,
    private readonly request: (req: HttpRequest) => Promise<HttpResponse> = httpRequest,
    private readonly wait: (ms: number) => Promise<void> = sleep,
  ) {
    const decode = async (data: ArrayBuffer) =>
      (await this.ffmpeg.check()) ? this.ffmpeg.decode(Buffer.from(data)) : undefined;
    this.backends = { gemini: geminiBackend, fish: fishBackend(decode) };
  }

  readerSettings(): ReaderSettings {
    const saved = this.db.getJson<Partial<ReaderSettings>>(READER_SETTINGS_KEY) ?? {};
    return sanitizeSettings({ ...DEFAULT_SETTINGS, ...saved });
  }

  /**
   * The voice used for generated audiobooks: the reader's AI voice engine
   * when one is selected, else the first service with a key.
   */
  profile(): VoiceProfile | undefined {
    const s = this.readerSettings();
    const chosen = s.ttsEngine === "gemini" || s.ttsEngine === "fish" ? s.ttsEngine : undefined;
    const provider = chosen ?? PROVIDERS.slice().reverse().find((p) => this.settings.key(p));
    if (!provider) return undefined;
    return provider === "gemini"
      ? { provider, model: s.geminiModel, voice: s.geminiVoice, style: s.geminiStyle.trim() }
      : { provider, model: s.fishModel, voice: s.fishVoice };
  }

  /** Identifies audio made with a profile; chapters with another id are out of date. */
  profileId(p: VoiceProfile): string {
    return `${p.provider}|${(this.backends[p.provider] as PageBackend<Configs[PageProvider]>).cacheKey(this.config(p.provider, p))}`;
  }

  /** The voice of a profile id (see profileId); the style is undefined when no longer known. */
  parseProfileId(id: string): (VoiceProfile & { id: string }) | undefined {
    const [provider, model, voice, styleHash, ...rest] = id.split("|");
    if (rest.length || !model) return undefined;
    if (provider === "fish" && styleHash === undefined) return { id, provider, model, voice: voice ?? "" };
    if (provider !== "gemini" || !voice || styleHash === undefined) return undefined;
    const known = { ...this.db.getJson<Record<string, string>>(STYLES_KEY), [hash("")]: "" };
    const current = this.readerSettings().geminiStyle.trim();
    known[hash(current)] = current;
    return { id, provider, model, voice, style: known[styleHash] };
  }

  /** Voices with stored segments of a service, as profile ids. */
  storedVoices(provider: PageProvider): string[] {
    return this.db
      .all<{ prefix: string }>(
        "select distinct substr(key, 1, instr(key, ':') - 1) as prefix from segments where key like ?",
        `${provider}/%`,
      )
      .map((r) => `${provider}|${r.prefix.slice(provider.length + 1)}`);
  }

  /** Segment key of `texts` in a voice given by its profile id. */
  keyIn(profileId: string, texts: string[]): string {
    return segmentKey(profileId.slice(profileId.indexOf("|") + 1), texts);
  }

  /** A readable name for a voice: Fish Audio names are looked up (and cached) in the background. */
  voiceLabel(p: VoiceProfile): string {
    let name: string;
    if (p.provider === "gemini") name = GEMINI_VOICES.find((v) => v.shortName === p.voice)?.label ?? p.voice;
    else if (!p.voice) name = "模型默认声音";
    else {
      name = this.fishNames.get(p.voice) || `${p.voice.slice(0, 8)}…`;
      if (!this.fishNames.has(p.voice) || Date.now() - this.fishNamesAt > 3600_000) void this.loadFishNames([p.voice]);
    }
    return `${PROVIDER_LABEL[p.provider]} · ${name}`;
  }

  /** Looks up Fish Audio voice names (the account's and popular ones, then `ids` one by one). */
  loadFishNames(ids: string[]): Promise<void> {
    const key = this.settings.key("fish");
    if (!key) return Promise.resolve();
    const missing = () => ids.filter((id) => FISH_VOICE_ID.test(id) && !this.fishNames.get(id));
    this.fishNamesLoading ??= (async () => {
      this.fishNamesAt = Date.now();
      for (const v of await listFishVoices(key, this.request).catch(() => [])) {
        if (v.shortName) this.fishNames.set(v.shortName, v.label.replace(/^我的：/, ""));
      }
      for (const id of missing()) {
        this.fishNames.set(id, "");
        try {
          const res = await this.request({
            method: "GET",
            url: `${FISH_API_BASE}/model/${id}`,
            headers: { Authorization: `Bearer ${key}` },
            timeoutMs: 20_000,
          });
          const body = res.status === 200 ? (JSON.parse(bodyText(res)) as { title?: unknown }) : {};
          if (typeof body.title === "string" && body.title) this.fishNames.set(id, body.title);
        } catch {
          // Shown by id until the next lookup.
        }
      }
    })().finally(() => (this.fishNamesLoading = undefined));
    return this.fishNamesLoading;
  }

  config<P extends PageProvider>(provider: P, voice: VoiceRequest = {}): Configs[P] {
    const s = this.readerSettings();
    const key = this.settings.key(provider) ?? "";
    const cfg =
      provider === "gemini"
        ? ({
            key,
            model: voice.model || s.geminiModel,
            voice: voice.voice || s.geminiVoice,
            style: (voice.style ?? s.geminiStyle).trim(),
            ahead: 0,
          } satisfies GeminiConfig)
        : ({ key, model: voice.model || s.fishModel, voice: voice.voice ?? s.fishVoice, ahead: 0 } satisfies FishConfig);
    return cfg as Configs[P];
  }

  /** Requests of a chapter, in the same parts the reader plays (see Reader.pagesFrom and PageSpeechEngine.plan). */
  parts(provider: PageProvider, pages: PageContent[]): string[][] {
    const max = this.backends[provider].maxChars;
    return pages.flatMap((page) => {
      const texts = page.paragraphs.flatMap((_, i) => {
        const text = spokenText(page.paragraphs, i, page.pageIndex, page.chapterTitle);
        return text ? splitIntoChunks(text, max) : [];
      });
      return texts.length ? splitPage(texts, max) : [];
    });
  }

  key(provider: PageProvider, cfg: Configs[PageProvider], texts: string[]): string {
    return segmentKey((this.backends[provider] as PageBackend<typeof cfg>).cacheKey(cfg), texts);
  }

  // -------------------------------------------------------------------------
  // Storage

  private rowKey = (provider: PageProvider, key: string) => `${provider}/${key}`;

  stored(provider: PageProvider, key: string): StoredAudio | undefined {
    const row = this.db.get<{ file: string; mime: string; bounds: string; bytes: number; bounds_v: number; start: number | null }>(
      "select file, mime, bounds, bytes, bounds_v, start from segments where key = ?",
      this.rowKey(provider, key),
    );
    return row
      ? {
          file: row.start === null ? join(this.dataDir, row.file) : join(this.libraryDir, ...row.file.split("/")),
          start: row.start ?? undefined,
          mime: row.mime,
          bounds: JSON.parse(row.bounds) as number[],
          bytes: row.bytes,
          boundsVersion: row.bounds_v,
        }
      : undefined;
  }

  /**
   * A stored segment with paragraph timing from the current method: older
   * segments are aligned again from their audio (`texts` must be the
   * segment's; checked against its key).
   */
  async aligned(provider: PageProvider, key: string, texts: string[], s: StoredAudio): Promise<StoredAudio> {
    if (s.boundsVersion >= BOUNDS_VERSION || !key.endsWith(`:${hash(texts.join("\n"))}`)) return s;
    if (!(await this.ffmpeg.check())) return s;
    try {
      const { samples, rate } = await this.ffmpeg.decode(await this.data(s));
      const bounds = paragraphBounds(texts, samples, rate);
      this.db.run(
        "update segments set bounds = ?, bounds_v = ? where key = ?",
        JSON.stringify(bounds),
        BOUNDS_VERSION,
        this.rowKey(provider, key),
      );
      return { ...s, bounds, boundsVersion: BOUNDS_VERSION };
    } catch (err) {
      console.warn("[tts] could not align a stored segment", err);
      return s;
    }
  }

  private rememberStyle(style: string): void {
    const known = this.db.getJson<Record<string, string>>(STYLES_KEY) ?? {};
    const h = hash(style);
    if (known[h] !== style) this.db.setJson(STYLES_KEY, { ...known, [h]: style });
  }

  /** A stored segment's audio. Throws when it can't be read (a chapter file changed or gone). */
  async data(s: StoredAudio): Promise<Buffer> {
    if (s.start === undefined) return readFile(s.file);
    const fh = await open(s.file, "r");
    try {
      const head = Buffer.alloc(10);
      await fh.read(head, 0, 10, 0);
      const out = Buffer.alloc(s.bytes);
      const { bytesRead } = await fh.read(out, 0, s.bytes, id3Size(head) + s.start);
      if (bytesRead !== s.bytes || !isFrameStart(out)) throw new Error(`segment no longer in ${s.file}`);
      return out;
    } finally {
      await fh.close();
    }
  }

  /**
   * Points segments at their audio inside a chapter's library file (`rel`,
   * offsets after its ID3 tag) and deletes their own files: the audio is
   * kept once.
   */
  async adopt(rel: string, parts: { provider: PageProvider; key: string; start: number; bytes: number }[]): Promise<void> {
    for (const p of parts) {
      const s = this.stored(p.provider, p.key);
      if (!s) continue;
      this.db.run(
        "update segments set file = ?, start = ?, bytes = ? where key = ?",
        rel,
        p.start,
        p.bytes,
        this.rowKey(p.provider, p.key),
      );
      if (s.start === undefined) await rm(s.file, { force: true });
    }
  }

  /**
   * Before a chapter's library file is replaced or deleted: its segments
   * (except `except`, row keys) get their own files again when `keep`, else
   * are forgotten.
   */
  async release(rel: string, keep: boolean, except = new Set<string>()): Promise<void> {
    const rows = this.db.all<{ key: string }>("select key from segments where file = ? and start is not null", rel);
    for (const { key } of rows) {
      if (except.has(key)) continue;
      const [provider, ...rest] = key.split("/");
      const s = keep ? this.stored(provider as PageProvider, rest.join("/")) : undefined;
      const data = s ? await this.data(s).catch(() => undefined) : undefined;
      if (!data) {
        this.db.run("delete from segments where key = ?", key);
        continue;
      }
      const own = this.ownFile(key, "mp3");
      await this.write(own, data);
      this.db.run("update segments set file = ?, start = null where key = ?", own, key);
    }
  }

  /** A chapter file moved (template change): its segments follow. */
  moved(from: string, to: string): void {
    this.db.run("update segments set file = ? where file = ? and start is not null", to, from);
  }

  /** Where a segment gets its own file (relative to the data folder). */
  private ownFile(rowKey: string, ext: string): string {
    const digest = createHash("sha1").update(rowKey).digest("hex");
    const [provider] = rowKey.split("/");
    return join("segments", provider, digest.slice(0, 2), `${digest}.${ext}`);
  }

  private async write(rel: string, data: Buffer): Promise<void> {
    const file = join(this.dataDir, rel);
    await mkdir(dirname(file), { recursive: true });
    await writeFile(`${file}.tmp`, data);
    await rename(`${file}.tmp`, file);
  }

  /** Changes when segments are added or deleted (for caching what is computed from them). */
  revision(): string {
    const r = this.db.get<{ n: number; t: number | null; b: number | null }>(
      "select count(*) as n, max(created_at) as t, sum(bytes) as b from segments",
    )!;
    return `${r.n}:${r.t ?? 0}:${r.b ?? 0}`;
  }

  /** Deletes stored segments (files and rows; audio inside a chapter file stays there). */
  async remove(provider: PageProvider, keys: string[]): Promise<number> {
    let bytes = 0;
    for (const key of keys) {
      const s = this.stored(provider, key);
      if (!s) continue;
      if (s.start === undefined) await rm(s.file, { force: true });
      this.db.run("delete from segments where key = ?", this.rowKey(provider, key));
      bytes += s.bytes;
    }
    return bytes;
  }

  private async save(provider: PageProvider, key: string, texts: string[], rendered: Rendered): Promise<StoredAudio> {
    let data: Buffer = Buffer.from(await rendered.audio.arrayBuffer());
    let mime = rendered.audio.type || "audio/mpeg";
    // Gemini returns WAV (~2.9 MB a minute); MP3 is a twentieth of that.
    if (mime !== "audio/mpeg" && (await this.ffmpeg.check())) {
      data = await this.ffmpeg.toMp3(data);
      mime = "audio/mpeg";
    }
    const ext = mime === "audio/mpeg" ? "mp3" : mime === "audio/wav" ? "wav" : "bin";
    const rel = this.ownFile(this.rowKey(provider, key), ext);
    const file = join(this.dataDir, rel);
    await this.write(rel, data);
    this.db.run(
      `insert into segments (key, file, mime, bytes, bounds, bounds_v, chars, created_at, start) values (?, ?, ?, ?, ?, ?, ?, ?, null)
       on conflict (key) do update set file = excluded.file, mime = excluded.mime, bytes = excluded.bytes,
       bounds = excluded.bounds, bounds_v = excluded.bounds_v, chars = excluded.chars, created_at = excluded.created_at,
       start = null`,
      this.rowKey(provider, key),
      rel,
      mime,
      data.byteLength,
      JSON.stringify(rendered.bounds),
      BOUNDS_VERSION,
      texts.join("").length,
      Date.now(),
    );
    this.countUsage(provider, texts.join("").length);
    return { file, mime, bounds: rendered.bounds, bytes: data.byteLength, boundsVersion: BOUNDS_VERSION };
  }

  /** A stored segment's audio; with the segment's texts, its timing is brought up to date (see aligned). */
  async read(provider: PageProvider, key: string, texts?: string[]): Promise<(StoredAudio & { data: Buffer }) | undefined> {
    let s = this.stored(provider, key);
    if (!s) return undefined;
    if (texts) s = await this.aligned(provider, key, texts, s);
    try {
      return { ...s, data: await this.data(s) };
    } catch {
      this.db.run("delete from segments where key = ?", this.rowKey(provider, key));
      return undefined;
    }
  }

  async clear(provider?: PageProvider): Promise<void> {
    const providers = provider ? [provider] : PROVIDERS;
    for (const p of providers) {
      // Audio inside chapter files takes no extra space: kept.
      this.db.run("delete from segments where key like ? and start is null", `${p}/%`);
      await rm(join(this.dataDir, "segments", p), { recursive: true, force: true });
    }
  }

  // -------------------------------------------------------------------------
  // Usage (requests and characters per day, server count)

  private day(): string {
    return new Date().toISOString().slice(0, 10);
  }

  private countUsage(provider: PageProvider, chars: number): void {
    const key = `server.usage.${provider}`;
    const cur = this.db.getJson<{ day: string; requests: number; chars: number }>(key);
    const day = this.day();
    const base = cur?.day === day ? cur : { day, requests: 0, chars: 0 };
    this.db.setJson(key, { day, requests: base.requests + 1, chars: base.chars + chars });
  }

  usage(provider: PageProvider): { requests: number; chars: number } {
    const cur = this.db.getJson<{ day: string; requests: number; chars: number }>(`server.usage.${provider}`);
    return cur?.day === this.day() ? { requests: cur.requests, chars: cur.chars } : { requests: 0, chars: 0 };
  }

  // -------------------------------------------------------------------------
  // Generation

  /**
   * Audio for `texts` (one request), stored or generated. One request per
   * service runs at a time; `priority` orders waiting requests (the reader's
   * go before background jobs); `align` brings a stored segment's timing up
   * to date (for playing). Throws SpeechEngineError.
   */
  segment<P extends PageProvider>(
    provider: P,
    texts: string[],
    options: { voice?: VoiceRequest; priority?: number; onStatus?: (msg: string) => void; align?: boolean } = {},
  ): Promise<StoredAudio> {
    const cfg = this.config(provider, options.voice);
    if (provider === "gemini") this.rememberStyle((cfg as GeminiConfig).style);
    if (!cfg.key) return Promise.reject(new SpeechEngineError("config"));
    const key = this.key(provider, cfg, texts);
    let existing = this.stored(provider, key);
    // Its chapter file was deleted or moved outside the app: made again.
    if (existing?.start !== undefined && !existsSync(existing.file)) {
      this.db.run("delete from segments where key = ?", this.rowKey(provider, key));
      existing = undefined;
    }
    if (existing) return options.align ? this.aligned(provider, key, texts, existing) : Promise.resolve(existing);
    const id = this.rowKey(provider, key);
    let p = this.inflight.get(id);
    if (!p) {
      p = this.inLane(provider, id, options.priority ?? 0, async () => {
        const again = this.stored(provider, key);
        if (again) return again;
        const io: BackendIO = { request: this.request, wait: this.wait, onStatus: options.onStatus ?? (() => undefined) };
        const rendered = await (this.backends[provider] as PageBackend<Configs[P]>).generate(cfg, texts, io);
        return this.save(provider, key, texts, rendered);
      });
      this.inflight.set(id, p);
      const done = () => this.inflight.delete(id);
      p.then(done, done);
    } else {
      // Already waiting (e.g. a background job's): the reader needing it now moves it up.
      for (const item of this.lanes[provider].queue) {
        if (item.id === id) item.priority = Math.max(item.priority, options.priority ?? 0);
      }
    }
    return p;
  }

  private inLane<T>(provider: PageProvider, id: string, priority: number, task: () => Promise<T>): Promise<T> {
    const lane = this.lanes[provider];
    return new Promise<T>((resolve, reject) => {
      lane.queue.push({
        id,
        priority,
        seq: lane.seq++,
        run: () => {
          task().then(resolve, reject).finally(() => {
            lane.busy = false;
            this.next(provider);
          });
        },
      });
      this.next(provider);
    });
  }

  private next(provider: PageProvider): void {
    const lane = this.lanes[provider];
    if (lane.busy || !lane.queue.length) return;
    lane.queue.sort((a, b) => b.priority - a.priority || a.seq - b.seq);
    lane.busy = true;
    lane.queue.shift()!.run();
  }
}
