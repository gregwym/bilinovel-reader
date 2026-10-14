import { createHash } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { PageContent } from "../../src/adapters/types";
import { splitIntoChunks } from "../../src/speech/SpeechPlayer";
import { SpeechEngineError } from "../../src/speech/SpeechEngine";
import { segmentKey, splitPage, type BackendIO, type PageBackend, type Rendered } from "../../src/speech/PageSpeechEngine";
import { geminiBackend, describeGeminiError, type GeminiConfig } from "../../src/speech/GeminiSpeechEngine";
import { describeFishError, fishBackend, type FishConfig } from "../../src/speech/FishSpeechEngine";
import { DEFAULT_SETTINGS, sanitizeSettings, type Settings as ReaderSettings } from "../../src/reader/ProgressStore";
import { httpRequest, type HttpRequest, type HttpResponse } from "../../src/utils/http";
import { sleep } from "../../src/utils/async";
import type { PageProvider, VoiceProfile } from "../shared/api";
import type { Db } from "./db";
import type { Settings } from "./config";
import type { Ffmpeg } from "./audio/ffmpeg";

/** Where the reader keeps its settings (synced to the server's key-value store). */
export const READER_SETTINGS_KEY = "biliReader.settings";
export const PROVIDERS: PageProvider[] = ["gemini", "fish"];

export interface Configs {
  gemini: GeminiConfig;
  fish: FishConfig;
}

/** A segment as stored: audio file plus paragraph start fractions. */
export interface StoredAudio {
  file: string;
  mime: string;
  bounds: number[];
  bytes: number;
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

  constructor(
    private readonly db: Db,
    private readonly settings: Settings,
    private readonly ffmpeg: Ffmpeg,
    private readonly dataDir: string,
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
      const texts = page.paragraphs.flatMap((p) => (p.text ? splitIntoChunks(p.text, max) : []));
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
    const row = this.db.get<{ file: string; mime: string; bounds: string; bytes: number }>(
      "select file, mime, bounds, bytes from segments where key = ?",
      this.rowKey(provider, key),
    );
    return row ? { file: join(this.dataDir, row.file), mime: row.mime, bounds: JSON.parse(row.bounds) as number[], bytes: row.bytes } : undefined;
  }

  private async save(provider: PageProvider, key: string, texts: string[], rendered: Rendered): Promise<StoredAudio> {
    let data: Buffer = Buffer.from(await rendered.audio.arrayBuffer());
    let mime = rendered.audio.type || "audio/mpeg";
    // Gemini returns WAV (~2.9 MB a minute); MP3 is a twentieth of that.
    if (mime !== "audio/mpeg" && (await this.ffmpeg.check())) {
      data = await this.ffmpeg.toMp3(data);
      mime = "audio/mpeg";
    }
    const digest = createHash("sha1").update(this.rowKey(provider, key)).digest("hex");
    const ext = mime === "audio/mpeg" ? "mp3" : mime === "audio/wav" ? "wav" : "bin";
    const rel = join("segments", provider, digest.slice(0, 2), `${digest}.${ext}`);
    const file = join(this.dataDir, rel);
    await mkdir(dirname(file), { recursive: true });
    await writeFile(`${file}.tmp`, data);
    await rename(`${file}.tmp`, file);
    this.db.run(
      `insert into segments (key, file, mime, bytes, bounds, chars, created_at) values (?, ?, ?, ?, ?, ?, ?)
       on conflict (key) do update set file = excluded.file, mime = excluded.mime, bytes = excluded.bytes,
       bounds = excluded.bounds, chars = excluded.chars, created_at = excluded.created_at`,
      this.rowKey(provider, key),
      rel,
      mime,
      data.byteLength,
      JSON.stringify(rendered.bounds),
      texts.join("").length,
      Date.now(),
    );
    this.countUsage(provider, texts.join("").length);
    return { file, mime, bounds: rendered.bounds, bytes: data.byteLength };
  }

  async read(provider: PageProvider, key: string): Promise<(StoredAudio & { data: Buffer }) | undefined> {
    const s = this.stored(provider, key);
    if (!s) return undefined;
    try {
      return { ...s, data: await readFile(s.file) };
    } catch {
      this.db.run("delete from segments where key = ?", this.rowKey(provider, key));
      return undefined;
    }
  }

  async clear(provider?: PageProvider): Promise<void> {
    const providers = provider ? [provider] : PROVIDERS;
    for (const p of providers) {
      this.db.run("delete from segments where key like ?", `${p}/%`);
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
   * go before background jobs). Throws SpeechEngineError.
   */
  segment<P extends PageProvider>(
    provider: P,
    texts: string[],
    options: { voice?: VoiceRequest; priority?: number; onStatus?: (msg: string) => void } = {},
  ): Promise<StoredAudio> {
    const cfg = this.config(provider, options.voice);
    if (!cfg.key) return Promise.reject(new SpeechEngineError("config"));
    const key = this.key(provider, cfg, texts);
    const existing = this.stored(provider, key);
    if (existing) return Promise.resolve(existing);
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
