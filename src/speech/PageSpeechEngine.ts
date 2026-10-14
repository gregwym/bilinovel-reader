import { httpRequest, type HttpRequest, type HttpResponse } from "../utils/http";
import { log } from "../utils/log";
import { sleep } from "../utils/async";
import { SpeechEngineError, type SpeakOptions, type SpeechEngine } from "./SpeechEngine";
import { silentWavUrl } from "./CloudSpeechEngine";

/**
 * Speech generated one site page at a time (Gemini, Fish Audio).
 *
 * Unlike the per-sentence TTS engines, these services are asked for a whole
 * page (a few minutes of audio), a few pages ahead of playback. A page longer
 * than one request allows is split the same way every time, so a page always
 * maps to the same audio wherever reading starts, and the audio is kept in
 * IndexedDB: listening again (or after a reload) costs nothing. The player
 * still moves paragraph by paragraph, using paragraph start times estimated
 * from text length and snapped to pauses in the audio.
 *
 * What differs per service (the request, the response, the cache key) is a
 * `PageBackend`.
 */

export const PAGE_AHEAD_OPTIONS = [1, 2, 4, 8];
/** Local audio cache limit per service (IndexedDB); least recently used segments are dropped first. */
export const PAGE_CACHE_BYTES = 400 * 1024 * 1024;

export interface PageEngineConfig {
  key: string;
  /** Pages generated ahead of the one playing. */
  ahead: number;
}

export interface Rendered {
  audio: Blob;
  bounds: number[];
}

export interface BackendIO {
  request(req: HttpRequest): Promise<HttpResponse>;
  wait(ms: number): Promise<void>;
  onStatus(message: string): void;
}

export interface PageBackend<C extends PageEngineConfig> {
  /** Service name for messages. */
  readonly name: string;
  /** Characters per request. */
  readonly maxChars: number;
  /** Everything in the configuration that changes the audio. */
  cacheKey(cfg: C): string;
  /** Generates audio for `texts` (one paragraph each); throws SpeechEngineError. */
  generate(cfg: C, texts: string[], io: BackendIO): Promise<Rendered>;
}

// ---------------------------------------------------------------------------
// Audio helpers

/** Wraps 16-bit little-endian mono PCM in a WAV container. */
export function pcmToWav(pcm: Uint8Array, sampleRate: number): Blob {
  const header = new ArrayBuffer(44);
  const v = new DataView(header);
  const str = (o: number, s: string) => [...s].forEach((c, i) => v.setUint8(o + i, c.charCodeAt(0)));
  str(0, "RIFF");
  v.setUint32(4, 36 + pcm.byteLength, true);
  str(8, "WAVE");
  str(12, "fmt ");
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true);
  v.setUint16(22, 1, true);
  v.setUint32(24, sampleRate, true);
  v.setUint32(28, sampleRate * 2, true);
  v.setUint16(32, 2, true);
  v.setUint16(34, 16, true);
  str(36, "data");
  v.setUint32(40, pcm.byteLength, true);
  return new Blob([header, pcm as BlobPart], { type: "audio/wav" });
}

/** Relative speaking time of a paragraph: spoken characters plus pauses for punctuation and the paragraph break. */
export function speechWeight(text: string): number {
  let w = 0;
  for (const ch of text) {
    if (/[\p{L}\p{N}]/u.test(ch)) w += ch.charCodeAt(0) < 0x2e80 ? 0.5 : 1;
    else if (/[，、,；;：:]/.test(ch)) w += 0.6;
    else if (/[。！？!?…—]/.test(ch)) w += 0.8;
  }
  return w + 1.5;
}

/**
 * Start of each paragraph as a fraction of the audio (n + 1 entries, first 0,
 * last 1). Estimated from text length, then moved to the nearest pause in
 * the audio when samples (any scale, e.g. 16-bit PCM or decoded floats) are
 * available.
 */
export function paragraphBounds(texts: string[], samples?: ArrayLike<number>, sampleRate = 24000): number[] {
  const weights = texts.map(speechWeight);
  const total = weights.reduce((a, b) => a + b, 0) || 1;
  const bounds = [0];
  let acc = 0;
  for (let i = 0; i < texts.length - 1; i++) {
    acc += weights[i];
    bounds.push(acc / total);
  }
  bounds.push(1);
  if (!samples || samples.length < sampleRate || texts.length < 2) return bounds;

  // Energy per 20 ms frame; pauses are runs of quiet frames.
  const frame = Math.max(1, Math.round(sampleRate * 0.02));
  const frames = Math.floor(samples.length / frame);
  const energy = new Float64Array(frames);
  for (let f = 0; f < frames; f++) {
    let sum = 0;
    for (let i = f * frame; i < (f + 1) * frame; i++) sum += Math.abs(samples[i]);
    energy[f] = sum / frame;
  }
  const sorted = [...energy].sort((a, b) => a - b);
  const loud = sorted[Math.floor(sorted.length * 0.9)] || 1;
  const quiet = loud * 0.08;
  const gaps: { center: number; length: number }[] = [];
  let start = -1;
  for (let f = 0; f <= frames; f++) {
    const silent = f < frames && energy[f] < quiet;
    if (silent && start < 0) start = f;
    if (!silent && start >= 0) {
      const len = f - start;
      if (len >= 10 && start > 0 && f < frames) gaps.push({ center: (start + len / 2) / frames, length: len });
      start = -1;
    }
  }
  // Snap each estimate to the nearest unused pause after the previous boundary.
  const duration = samples.length / sampleRate;
  const window = Math.max(3, duration * 0.06) / duration;
  let prev = 0;
  for (let i = 1; i < bounds.length - 1; i++) {
    const est = bounds[i];
    let best: number | undefined;
    for (const g of gaps) {
      if (g.center <= prev + 0.2 / duration || Math.abs(g.center - est) > window) continue;
      if (best === undefined || Math.abs(g.center - est) < Math.abs(best - est)) best = g.center;
    }
    bounds[i] = Math.max(best ?? est, prev);
    prev = bounds[i];
  }
  return bounds;
}

/**
 * Splits one page's texts into requests of at most about `maxChars`
 * characters, in parts of similar size. Depends only on the page, so the same
 * page always gives the same parts.
 */
export function splitPage(texts: string[], maxChars: number): string[][] {
  const total = texts.reduce((n, t) => n + t.length, 0);
  const parts = Math.max(1, Math.ceil(total / maxChars));
  const out: string[][] = [];
  let acc = 0;
  let last = -1;
  for (const t of texts) {
    // Each text goes to the part its midpoint falls in.
    const part = Math.min(parts - 1, Math.floor(((acc + t.length / 2) / total) * parts));
    if (part !== last) out.push([]);
    out[out.length - 1].push(t);
    last = part;
    acc += t.length;
  }
  return out;
}

export function hash(s: string): string {
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 16777619);
    h2 = Math.imul(h2 ^ c, 2246822519);
  }
  return `${(h1 >>> 0).toString(36)}${(h2 >>> 0).toString(36)}${s.length.toString(36)}`;
}

/** Cache key of the audio for `texts` under a backend's `cacheKey(cfg)`. */
export function segmentKey(prefix: string, texts: string[]): string {
  return `${prefix}:${hash(texts.join("\n"))}`;
}

// ---------------------------------------------------------------------------
// Persistent segment cache

export interface StoredSegment {
  key: string;
  texts: string[];
  audio: Blob;
  bounds: number[];
}

export interface SegmentMeta {
  key: string;
  texts: string[];
  bytes: number;
  usedAt: number;
}

export interface SegmentStore {
  list(): Promise<SegmentMeta[]>;
  get(key: string): Promise<StoredSegment | undefined>;
  put(seg: StoredSegment): Promise<void>;
  delete(key: string): Promise<void>;
  clear(): Promise<void>;
}

export class MemorySegmentStore implements SegmentStore {
  private readonly items = new Map<string, { meta: SegmentMeta; seg: StoredSegment }>();

  async list(): Promise<SegmentMeta[]> {
    return [...this.items.values()].map((i) => ({ ...i.meta }));
  }

  async get(key: string): Promise<StoredSegment | undefined> {
    const item = this.items.get(key);
    if (item) item.meta.usedAt = Date.now();
    return item?.seg;
  }

  async put(seg: StoredSegment): Promise<void> {
    this.items.set(seg.key, { seg, meta: { key: seg.key, texts: seg.texts, bytes: seg.audio.size, usedAt: Date.now() } });
  }

  async delete(key: string): Promise<void> {
    this.items.delete(key);
  }

  async clear(): Promise<void> {
    this.items.clear();
  }
}

function idbRequest<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

/** Audio segments in IndexedDB (bilinovel.net origin): metadata and audio in separate stores. */
export class IdbSegmentStore implements SegmentStore {
  private db?: Promise<IDBDatabase>;

  constructor(private readonly name: string) {}

  private open(): Promise<IDBDatabase> {
    this.db ??= new Promise<IDBDatabase>((resolve, reject) => {
      const req = indexedDB.open(this.name, 1);
      req.onupgradeneeded = () => {
        req.result.createObjectStore("meta", { keyPath: "key" });
        req.result.createObjectStore("audio");
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    this.db.catch(() => (this.db = undefined));
    return this.db;
  }

  private async store(name: "meta" | "audio", mode: IDBTransactionMode = "readonly"): Promise<IDBObjectStore> {
    return (await this.open()).transaction(name, mode).objectStore(name);
  }

  async list(): Promise<SegmentMeta[]> {
    return idbRequest((await this.store("meta")).getAll() as IDBRequest<SegmentMeta[]>);
  }

  async get(key: string): Promise<StoredSegment | undefined> {
    const meta = (await idbRequest((await this.store("meta")).get(key))) as
      | (SegmentMeta & { bounds: number[]; type: string })
      | undefined;
    if (!meta) return undefined;
    const data = (await idbRequest((await this.store("audio")).get(key))) as ArrayBuffer | undefined;
    if (!data) return undefined;
    void this.store("meta", "readwrite").then((s) => s.put({ ...meta, usedAt: Date.now() }));
    return { key, texts: meta.texts, bounds: meta.bounds, audio: new Blob([data], { type: meta.type }) };
  }

  async put(seg: StoredSegment): Promise<void> {
    // ArrayBuffers store reliably in every WebKit version (Blobs did not always).
    const data = await seg.audio.arrayBuffer();
    const db = await this.open();
    const tx = db.transaction(["meta", "audio"], "readwrite");
    tx.objectStore("audio").put(data, seg.key);
    tx.objectStore("meta").put({
      key: seg.key,
      texts: seg.texts,
      bounds: seg.bounds,
      type: seg.audio.type,
      bytes: data.byteLength,
      usedAt: Date.now(),
    });
    await new Promise<void>((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  }

  async delete(key: string): Promise<void> {
    const db = await this.open();
    const tx = db.transaction(["meta", "audio"], "readwrite");
    tx.objectStore("meta").delete(key);
    tx.objectStore("audio").delete(key);
    await new Promise<void>((resolve) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
    });
  }

  async clear(): Promise<void> {
    const db = await this.open();
    const tx = db.transaction(["meta", "audio"], "readwrite");
    tx.objectStore("meta").clear();
    tx.objectStore("audio").clear();
    await new Promise<void>((resolve) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
    });
  }
}

export function defaultSegmentStore(name: string): SegmentStore {
  return typeof indexedDB !== "undefined" ? new IdbSegmentStore(name) : new MemorySegmentStore();
}

// ---------------------------------------------------------------------------
// Usage

/** Requests and characters sent today (local count). */
export class DailyUsageMeter {
  constructor(
    private readonly key: string,
    private readonly storage: Storage | undefined = globalThis.localStorage,
  ) {}

  private day(): string {
    const d = new Date();
    return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
  }

  get(): { requests: number; chars: number } {
    try {
      const raw = JSON.parse(this.storage?.getItem(this.key) ?? "null") as {
        day: string;
        requests: number;
        chars: number;
      } | null;
      return raw && raw.day === this.day() ? { requests: raw.requests, chars: raw.chars } : { requests: 0, chars: 0 };
    } catch {
      return { requests: 0, chars: 0 };
    }
  }

  add(chars: number): void {
    const cur = this.get();
    try {
      this.storage?.setItem(
        this.key,
        JSON.stringify({ day: this.day(), requests: cur.requests + 1, chars: cur.chars + chars }),
      );
    } catch {
      /* ignore */
    }
  }
}

// ---------------------------------------------------------------------------
// Engine

interface Segment {
  key: string;
  texts: string[];
  rendered?: Promise<Rendered>;
  done?: Rendered;
}

/** Pages for planning: the one containing a paragraph and the loaded ones after it. */
export interface PageContext {
  /** Each page's utterance texts, in order; the first is the current page. */
  pages: string[][];
  /** Position of the paragraph's first utterance in `pages[0]`. */
  index: number;
}

export interface PageEngineOptions {
  /** Page layout around a paragraph (`count` pages from its page on). */
  pages?(paragraphId: string, count: number): PageContext | undefined;
  request?: (req: HttpRequest) => Promise<HttpResponse>;
  audio?: HTMLAudioElement;
  sleep?: (ms: number) => Promise<void>;
  store?: SegmentStore;
  usage?: DailyUsageMeter;
  maxCacheBytes?: number;
  /** Progress while the segment needed now is generated ("" when done). */
  onStatus?(message: string): void;
  /** A request finished (usage changed) or the cache changed size. */
  onUsage?(cacheBytes: number): void;
}

/** After a paragraph's end, keep the audio running this long for the player to ask for the next one. */
const CONTINUE_GRACE_MS = 1500;

export class PageSpeechEngine<C extends PageEngineConfig> implements SpeechEngine {
  readonly firstChunkLength = undefined;
  private readonly io: BackendIO;
  private readonly audio: HTMLAudioElement;
  private readonly store: SegmentStore;
  private readonly segments = new Map<string, Segment>();
  private queue: Segment[] = [];
  private working = false;
  private playing?: { seg: Segment; idx: number; url: string; duration: number };
  private settle?: (r: "done" | "cancelled") => void;
  private token = 0;
  private guard?: ReturnType<typeof setTimeout>;
  private unlocked = false;

  constructor(
    private readonly backend: PageBackend<C>,
    private readonly getConfig: () => C | undefined,
    private readonly options: PageEngineOptions = {},
  ) {
    this.io = {
      request: options.request ?? httpRequest,
      wait: options.sleep ?? sleep,
      onStatus: (msg) => options.onStatus?.(msg),
    };
    this.audio = options.audio ?? new Audio();
    this.audio.preload = "auto";
    this.store = options.store ?? new MemorySegmentStore();
  }

  /** Paragraphs are split only when one alone exceeds a request. */
  get maxChunkLength(): number {
    return this.backend.maxChars;
  }

  /** Look-ahead is set in pages (config.ahead), not utterances. */
  setPrefetchCount(): void {}

  get speaking(): boolean {
    return !!this.settle && !this.audio.paused;
  }

  unlock(): void {
    if (this.unlocked) return;
    this.unlocked = true;
    try {
      this.audio.src = silentWavUrl();
      void this.audio.play()?.catch(() => undefined);
    } catch (err) {
      log.debug("audio unlock failed", err);
    }
  }

  async speak(text: string, options: SpeakOptions): Promise<"done" | "cancelled"> {
    const token = ++this.token;
    this.settleCurrent("cancelled");
    const cfg = this.getConfig();
    if (!cfg?.key) {
      this.pauseAudio();
      throw new SpeechEngineError("config");
    }
    const { seg, idx } = this.plan(text, options.paragraphId, cfg);

    const p = this.playing;
    const continuing = !!p && p.seg === seg && idx === p.idx + 1 && !this.audio.ended;
    if (!continuing) this.pauseAudio();
    // The page needed now goes first; the look-ahead follows it.
    const current = this.render(seg, cfg);
    current.then(
      () => void this.pump(cfg),
      () => undefined,
    );
    let rendered = seg.done;
    if (!rendered) {
      this.options.onStatus?.(`${this.backend.name} 正在生成约 ${seg.texts.join("").length} 字的语音，请稍候…`);
      try {
        rendered = await current;
      } finally {
        if (token === this.token) this.options.onStatus?.("");
      }
      if (token !== this.token) return "cancelled";
    }
    return this.playParagraph(seg, idx, rendered, options.rate, continuing);
  }

  pause(): void {
    this.audio.pause();
  }

  resume(): void {
    void this.audio.play().catch(() => undefined);
  }

  stop(): void {
    this.token++;
    this.settleCurrent("cancelled");
    this.pauseAudio();
  }

  /** Drops all cached audio. */
  async clearCache(): Promise<void> {
    this.queue = [];
    for (const seg of this.segments.values()) if (seg !== this.playing?.seg) this.segments.delete(seg.key);
    await this.store.clear().catch(() => undefined);
    this.options.onUsage?.(0);
  }

  /** Bytes of audio kept locally. */
  async cacheBytes(): Promise<number> {
    try {
      return (await this.store.list()).reduce((n, m) => n + m.bytes, 0);
    } catch {
      return 0;
    }
  }

  // -------------------------------------------------------------------------
  // Planning

  private segmentFor(texts: string[], prefix: string): Segment {
    const key = segmentKey(prefix, texts);
    let seg = this.segments.get(key);
    if (!seg) this.segments.set(key, (seg = { key, texts }));
    return seg;
  }

  /**
   * Finds the part of the page to play `text` from and queues the following
   * parts and pages for generation. Without page information (e.g. the voice
   * sample) the text is generated on its own.
   */
  private plan(text: string, paragraphId: string | undefined, cfg: C): { seg: Segment; idx: number } {
    const prefix = this.backend.cacheKey(cfg);
    const max = this.backend.maxChars;
    const ctx = paragraphId ? this.options.pages?.(paragraphId, cfg.ahead + 1) : undefined;
    const [page = [], ...later] = ctx?.pages ?? [];
    let pos = page.indexOf(text, ctx?.index ?? 0);
    if (pos < 0) pos = page.indexOf(text);
    if (pos < 0) return { seg: this.segmentFor([text], prefix), idx: 0 };

    const parts = splitPage(page, max).map((texts) => this.segmentFor(texts, prefix));
    let start = 0;
    let at = 0;
    while (at < parts.length - 1 && pos >= start + parts[at].texts.length) start += parts[at++].texts.length;
    const seg = parts[at];
    const ahead = [
      ...parts.slice(at + 1),
      ...later.flatMap((p) => splitPage(p, max).map((t) => this.segmentFor(t, prefix))),
    ];
    // Only what is playing, planned or being generated stays in memory; the rest is in the store.
    const keep = new Set([seg, ...ahead, this.playing?.seg]);
    for (const s of this.segments.values()) {
      if (!keep.has(s) && (!s.rendered || s.done)) this.segments.delete(s.key);
    }
    this.queue = ahead.filter((s) => !s.done);
    return { seg, idx: pos - start };
  }

  private async pump(cfg: C): Promise<void> {
    if (this.working) return;
    this.working = true;
    try {
      while (this.queue.length) {
        const seg = this.queue.shift()!;
        if (seg.done) continue;
        try {
          await this.render(seg, this.getConfig() ?? cfg);
        } catch (err) {
          const code = err instanceof SpeechEngineError ? err.code : String(err);
          log.warn(`${this.backend.name} look-ahead failed`, code);
          if (code !== "network" && code !== "server") this.queue = [];
          break;
        }
      }
    } finally {
      this.working = false;
    }
  }

  // -------------------------------------------------------------------------
  // Generation

  private render(seg: Segment, cfg: C): Promise<Rendered> {
    if (seg.done) return Promise.resolve(seg.done);
    seg.rendered ??= (async () => {
      const stored = await this.store.get(seg.key).catch(() => undefined);
      if (stored) return { audio: stored.audio, bounds: stored.bounds };
      const rendered = await this.backend.generate(cfg, seg.texts, this.io);
      this.options.usage?.add(seg.texts.join("").length);
      try {
        await this.store.put({ key: seg.key, texts: seg.texts, ...rendered });
        await this.evict();
      } catch (err) {
        log.warn(`${this.backend.name} cache write failed`, err);
      }
      return rendered;
    })();
    seg.rendered.then(
      (r) => (seg.done = r),
      () => (seg.rendered = undefined),
    );
    return seg.rendered;
  }

  private async evict(): Promise<void> {
    const limit = this.options.maxCacheBytes ?? PAGE_CACHE_BYTES;
    const metas = (await this.store.list()).sort((a, b) => a.usedAt - b.usedAt);
    let total = metas.reduce((n, m) => n + m.bytes, 0);
    for (const m of metas) {
      if (total <= limit) break;
      if (m.key === this.playing?.seg.key) continue;
      await this.store.delete(m.key);
      this.segments.delete(m.key);
      total -= m.bytes;
    }
    this.options.onUsage?.(total);
  }

  // -------------------------------------------------------------------------
  // Playback

  private settleCurrent(r: "done" | "cancelled"): void {
    const settle = this.settle;
    this.settle = undefined;
    settle?.(r);
  }

  private pauseAudio(): void {
    this.clearGuard();
    if (!this.audio.paused) this.audio.pause();
  }

  private clearGuard(): void {
    if (this.guard !== undefined) clearTimeout(this.guard);
    this.guard = undefined;
  }

  private playParagraph(
    seg: Segment,
    idx: number,
    rendered: Rendered,
    rate: number,
    continuing: boolean,
  ): Promise<"done" | "cancelled"> {
    const audio = this.audio;
    this.clearGuard();
    if (this.playing?.seg !== seg) {
      if (this.playing) URL.revokeObjectURL(this.playing.url);
      const url = URL.createObjectURL(rendered.audio);
      this.playing = { seg, idx, url, duration: NaN };
      audio.src = url;
    }
    const p = this.playing;
    p.idx = idx;
    const duration = () => (Number.isFinite(audio.duration) && audio.duration > 0 ? audio.duration : p.duration);
    const start = () => rendered.bounds[idx] * duration();
    const end = () => rendered.bounds[idx + 1] * duration();
    const last = idx === seg.texts.length - 1;
    if (!continuing) {
      const seek = () => {
        const t = start();
        if (Number.isFinite(t) && Math.abs(audio.currentTime - t) > 0.25) audio.currentTime = t;
      };
      if (audio.readyState >= 1) seek();
      else audio.addEventListener("loadedmetadata", seek, { once: true });
    }
    audio.defaultPlaybackRate = rate;
    audio.playbackRate = rate;

    return new Promise((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const cleanup = () => {
        audio.removeEventListener("timeupdate", check);
        audio.removeEventListener("ended", onEnded);
        audio.removeEventListener("error", onError);
        audio.removeEventListener("pause", onPause);
        if (timer !== undefined) clearTimeout(timer);
        if (this.settle === settle) this.settle = undefined;
      };
      const settle = (r: "done" | "cancelled") => {
        cleanup();
        resolve(r);
      };
      // Paragraph end: report it but keep the audio running into the next paragraph.
      const finish = () => {
        if (this.settle !== settle) return;
        this.settle = undefined;
        settle("done");
        const myToken = this.token;
        this.guard = setTimeout(() => {
          if (this.token === myToken) this.pauseAudio(); // nobody asked for the next paragraph
        }, CONTINUE_GRACE_MS);
      };
      const check = () => {
        if (timer !== undefined) clearTimeout(timer);
        timer = undefined;
        if (last || audio.paused) return;
        const left = end() - audio.currentTime;
        if (left <= 0.05) return finish();
        // timeupdate fires only every ~250 ms: also check right at the boundary.
        if (Number.isFinite(left)) timer = setTimeout(check, (left / (audio.playbackRate || 1)) * 1000);
      };
      const onEnded = () => {
        if (this.settle === settle) settle("done");
      };
      const onError = () => {
        if (this.settle !== settle) return;
        cleanup();
        reject(new SpeechEngineError("audio-error"));
      };
      // Paused by the system (call, other audio, lock-screen control).
      const onPause = () => {
        if (this.settle === settle && audio.paused && !audio.ended) settle("cancelled");
      };
      this.settle = settle;
      audio.addEventListener("timeupdate", check);
      audio.addEventListener("ended", onEnded);
      audio.addEventListener("error", onError);
      if (!audio.paused) {
        audio.addEventListener("pause", onPause);
        check();
        return;
      }
      audio
        .play()
        .then(() => {
          if (this.settle !== settle) return;
          audio.addEventListener("pause", onPause);
          check();
        })
        .catch((err: unknown) => {
          if (this.settle !== settle) return;
          cleanup();
          const name = (err as { name?: string })?.name;
          reject(new SpeechEngineError(name === "NotAllowedError" ? "not-allowed" : "audio-error"));
        });
    });
  }
}
