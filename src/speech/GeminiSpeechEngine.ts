import { bodyText, httpRequest, NetworkError, type HttpRequest, type HttpResponse } from "../utils/http";
import { log } from "../utils/log";
import { sleep } from "../utils/async";
import { SpeechEngineError, type SpeakOptions, type SpeechEngine } from "./SpeechEngine";
import { silentWavUrl } from "./CloudSpeechEngine";
import type { AzureVoice } from "./AzureSpeechEngine";

/**
 * Gemini (LLM) speech generation over the Gemini Developer API:
 *   POST https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent
 *
 * Unlike the per-sentence TTS engines, Gemini is asked for long segments
 * (many paragraphs, ~1500 characters, several minutes of audio) a few
 * segments ahead of playback, because the free tier limits requests per day
 * rather than characters. Segments are kept in IndexedDB so listening again
 * (or after a reload) costs nothing. One segment is one audio file; the
 * player still moves paragraph by paragraph, using paragraph start times
 * estimated from text length and snapped to pauses in the audio.
 */

export const GEMINI_API_BASE = "https://generativelanguage.googleapis.com/v1beta";
export const GEMINI_DEFAULT_MODEL = "gemini-3.8-flash-tts";
export const GEMINI_PRESET_MODELS = ["gemini-3.8-flash-tts", "gemini-3.8-flash-lite-tts", "gemini-3.1-flash-tts"];
export const GEMINI_DEFAULT_VOICE = "Kore";
export const GEMINI_DEFAULT_STYLE = "用自然、生动、富有感情的有声书语气朗读下面的轻小说片段：";
export const GEMINI_SEGMENT_OPTIONS = [800, 1500, 3000];
export const GEMINI_AHEAD_OPTIONS = [1, 2, 4, 8];
/** Local audio cache limit (IndexedDB); least recently used segments are dropped first. */
export const GEMINI_CACHE_BYTES = 400 * 1024 * 1024;

const VOICE_STYLES: [string, string][] = [
  ["Kore", "坚定"],
  ["Aoede", "轻快"],
  ["Leda", "年轻"],
  ["Zephyr", "明亮"],
  ["Puck", "活泼"],
  ["Charon", "沉稳"],
  ["Fenrir", "兴奋"],
  ["Orus", "坚定"],
  ["Callirrhoe", "随和"],
  ["Autonoe", "明亮"],
  ["Enceladus", "气声"],
  ["Iapetus", "清晰"],
  ["Umbriel", "随和"],
  ["Algieba", "顺滑"],
  ["Despina", "顺滑"],
  ["Erinome", "清晰"],
  ["Algenib", "沙哑"],
  ["Rasalgethi", "知性"],
  ["Laomedeia", "欢快"],
  ["Achernar", "柔和"],
  ["Alnilam", "坚定"],
  ["Schedar", "平稳"],
  ["Gacrux", "成熟"],
  ["Pulcherrima", "直率"],
  ["Achird", "友好"],
  ["Zubenelgenubi", "随意"],
  ["Vindemiatrix", "温柔"],
  ["Sadachbia", "活泼"],
  ["Sadaltager", "博学"],
  ["Sulafat", "温暖"],
];

/** Gemini's prebuilt voices (multilingual; the same names work for Chinese). */
export const GEMINI_VOICES: AzureVoice[] = VOICE_STYLES.map(([name, style]) => ({
  shortName: name,
  label: `${name}（${style}）`,
  locale: "",
}));

export interface GeminiConfig {
  key: string;
  model: string;
  voice: string;
  /** Natural-language direction placed before the text ("read it like…"); may be empty. */
  style: string;
  /** Target characters per request. */
  segmentChars: number;
  /** Segments generated ahead of the one playing. */
  ahead: number;
}

// ---------------------------------------------------------------------------
// Errors

export function geminiErrorCode(status: number, body = ""): string {
  if (status === 400) {
    if (/API_KEY_INVALID|API key not valid/i.test(body)) return "auth";
    if (/location is not supported/i.test(body)) return "location";
    return "bad-request";
  }
  if (status === 401) return "auth";
  if (status === 403) return /SERVICE_DISABLED|has not been used|is disabled/i.test(body) ? "api-disabled" : "auth";
  if (status === 404) return "model";
  if (status === 429) return /PerDay|per day/i.test(body) ? "quota" : "throttled";
  if (status >= 500) return "server";
  return `http-${status}`;
}

/** Server-suggested wait from a 429 body (`"retryDelay": "23s"`), in ms. */
export function geminiRetryDelayMs(body: string): number | undefined {
  const m = /"retryDelay"\s*:\s*"(\d+(?:\.\d+)?)s"/.exec(body);
  return m ? Math.ceil(parseFloat(m[1]) * 1000) : undefined;
}

export function describeGeminiError(code: string): string {
  switch (code) {
    case "config":
      return "未设置 Gemini 密钥";
    case "auth":
      return "Gemini 密钥不正确";
    case "api-disabled":
      return "该项目未启用 Gemini API";
    case "model":
      return "该 Gemini 模型不可用，请换一个模型";
    case "location":
      return "所在地区不支持 Gemini API";
    case "quota":
      return "Gemini 今日免费次数已用完";
    case "throttled":
      return "Gemini 请求过于频繁";
    case "server":
      return "Gemini 服务暂时出错";
    case "network":
      return "无法连接 Gemini";
    case "bad-request":
      return "Gemini 不接受该请求";
    case "too-long":
      return "一次生成的文字太多，请把「每次生成」调小";
    case "empty":
      return "Gemini 没有返回语音";
    case "audio-error":
      return "音频播放出错";
    case "not-allowed":
      return "需要点击 ▶ 才能播放音频";
    default:
      return `Gemini 错误（${code}）`;
  }
}

// ---------------------------------------------------------------------------
// Audio helpers

export function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** Sample rate of raw PCM (`audio/L16;codec=pcm;rate=24000`), or undefined for other formats. */
export function pcmRate(mime: string): number | undefined {
  if (!/^audio\/(l16|pcm)/i.test(mime)) return undefined;
  return Number(/rate=(\d+)/i.exec(mime)?.[1] ?? 24000);
}

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
 * the audio when PCM samples are available.
 */
export function paragraphBounds(texts: string[], samples?: Int16Array, sampleRate = 24000): number[] {
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

/** Groups consecutive texts into requests of about `maxChars` characters. */
export function planSegments(texts: string[], maxChars: number): string[][] {
  const out: string[][] = [];
  let cur: string[] = [];
  let len = 0;
  for (const t of texts) {
    if (cur.length && len + t.length > maxChars) {
      out.push(cur);
      cur = [];
      len = 0;
    }
    cur.push(t);
    len += t.length;
  }
  if (cur.length) out.push(cur);
  return out;
}

function hash(s: string): string {
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 16777619);
    h2 = Math.imul(h2 ^ c, 2246822519);
  }
  return `${(h1 >>> 0).toString(36)}${(h2 >>> 0).toString(36)}${s.length.toString(36)}`;
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

  constructor(private readonly name = "biliReader.gemini") {}

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

export function defaultSegmentStore(): SegmentStore {
  return typeof indexedDB !== "undefined" ? new IdbSegmentStore() : new MemorySegmentStore();
}

// ---------------------------------------------------------------------------
// Usage

/** Requests and characters sent today (local count; the free tier's limits are per request). */
export class GeminiUsageMeter {
  static readonly KEY = "biliReader.geminiUsage";

  constructor(private readonly storage: Storage | undefined = globalThis.localStorage) {}

  private day(): string {
    const d = new Date();
    return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
  }

  get(): { requests: number; chars: number } {
    try {
      const raw = JSON.parse(this.storage?.getItem(GeminiUsageMeter.KEY) ?? "null") as {
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
        GeminiUsageMeter.KEY,
        JSON.stringify({ day: this.day(), requests: cur.requests + 1, chars: cur.chars + chars }),
      );
    } catch {
      /* ignore */
    }
  }
}

/** Lists the account's TTS-capable Gemini models; throws SpeechEngineError on failure. */
export async function listGeminiTtsModels(
  key: string,
  request: (req: HttpRequest) => Promise<HttpResponse> = httpRequest,
): Promise<string[]> {
  let res: HttpResponse;
  try {
    res = await request({
      method: "GET",
      url: `${GEMINI_API_BASE}/models?pageSize=1000`,
      headers: { "x-goog-api-key": key },
      timeoutMs: 20_000,
    });
  } catch {
    throw new SpeechEngineError("network");
  }
  if (res.status < 200 || res.status >= 300) throw new SpeechEngineError(geminiErrorCode(res.status, bodyText(res)));
  const list = (JSON.parse(bodyText(res)) as { models?: { name: string }[] }).models ?? [];
  return list
    .map((m) => m.name.replace(/^models\//, ""))
    .filter((n) => /tts/i.test(n))
    .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
}

// ---------------------------------------------------------------------------
// Engine

interface Rendered {
  audio: Blob;
  bounds: number[];
}

interface Segment {
  key: string;
  texts: string[];
  rendered?: Promise<Rendered>;
  done?: Rendered;
}

export interface GeminiEngineOptions {
  request?: (req: HttpRequest) => Promise<HttpResponse>;
  audio?: HTMLAudioElement;
  sleep?: (ms: number) => Promise<void>;
  store?: SegmentStore;
  usage?: GeminiUsageMeter;
  maxCacheBytes?: number;
  /** Progress while the segment needed now is generated ("" when done). */
  onStatus?(message: string): void;
  /** A request finished (usage changed) or the cache changed size. */
  onUsage?(cacheBytes: number): void;
}

const REQUEST_TIMEOUT_MS = 5 * 60_000;
/** After a paragraph's end, keep the audio running this long for the player to ask for the next one. */
const CONTINUE_GRACE_MS = 1500;

export class GeminiSpeechEngine implements SpeechEngine {
  readonly firstChunkLength = undefined;
  private readonly request: (req: HttpRequest) => Promise<HttpResponse>;
  private readonly wait: (ms: number) => Promise<void>;
  private readonly audio: HTMLAudioElement;
  private readonly store: SegmentStore;
  private readonly usage: GeminiUsageMeter;
  private readonly segments = new Map<string, Segment>();
  /** text -> keys of segments containing it. */
  private readonly byText = new Map<string, Set<string>>();
  private index?: Promise<void>;
  private hint: string[] = [];
  private hintFresh = false;
  private queue: Segment[] = [];
  private working = false;
  private playing?: { seg: Segment; idx: number; url: string; duration: number };
  private settle?: (r: "done" | "cancelled") => void;
  private token = 0;
  private guard?: ReturnType<typeof setTimeout>;
  private unlocked = false;

  constructor(
    private readonly getConfig: () => GeminiConfig | undefined,
    private readonly options: GeminiEngineOptions = {},
  ) {
    this.request = options.request ?? httpRequest;
    this.wait = options.sleep ?? sleep;
    this.audio = options.audio ?? new Audio();
    this.audio.preload = "auto";
    this.store = options.store ?? defaultSegmentStore();
    this.usage = options.usage ?? new GeminiUsageMeter();
  }

  get maxChunkLength(): number {
    return this.getConfig()?.segmentChars ?? 1500;
  }

  /** Enough upcoming paragraphs to plan the segments ahead. */
  get prefetchCount(): number {
    return 400;
  }

  /** Look-ahead is set in segments (GeminiConfig.ahead), not utterances. */
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

  prefetch(texts: string[]): void {
    this.hint = texts;
    this.hintFresh = true;
  }

  async speak(text: string, options: SpeakOptions): Promise<"done" | "cancelled"> {
    const token = ++this.token;
    this.settleCurrent("cancelled");
    this.hintFresh = false;
    // The player sends the look-ahead hint right after calling speak().
    await Promise.resolve();
    if (token !== this.token) return "cancelled";
    const hint = this.hintFresh ? this.hint : [];
    this.hintFresh = false;
    const cfg = this.getConfig();
    if (!cfg?.key) {
      this.pauseAudio();
      throw new SpeechEngineError("config");
    }
    await this.loadIndex();
    if (token !== this.token) return "cancelled";

    const prefix = this.prefix(cfg);
    const { seg, idx } = this.locate(text, prefix, cfg, hint);
    this.planAhead(seg, idx, hint, prefix, cfg);

    const p = this.playing;
    const continuing = !!p && p.seg === seg && idx === p.idx + 1 && !this.audio.ended;
    if (!continuing) this.pauseAudio();
    let rendered = seg.done;
    if (!rendered) {
      this.options.onStatus?.(`Gemini 正在生成约 ${seg.texts.join("").length} 字的语音，请稍候…`);
      try {
        rendered = await this.render(seg, cfg);
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
    for (const seg of this.segments.values()) if (seg !== this.playing?.seg) this.forget(seg);
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

  private prefix(cfg: GeminiConfig): string {
    return `${cfg.model}|${cfg.voice}|${hash(cfg.style)}`;
  }

  private loadIndex(): Promise<void> {
    this.index ??= this.store
      .list()
      .then((metas) => {
        for (const m of metas) this.register(m.key, m.texts);
      })
      .catch((err) => log.warn("Gemini cache unavailable", err));
    return this.index;
  }

  private register(key: string, texts: string[]): Segment {
    let seg = this.segments.get(key);
    if (seg) return seg;
    seg = { key, texts };
    this.segments.set(key, seg);
    for (const t of texts) {
      let keys = this.byText.get(t);
      if (!keys) this.byText.set(t, (keys = new Set()));
      keys.add(key);
    }
    return seg;
  }

  private forget(seg: Segment): void {
    this.segments.delete(seg.key);
    for (const t of seg.texts) this.byText.get(t)?.delete(seg.key);
  }

  private segmentFor(texts: string[], prefix: string): Segment {
    return this.register(`${prefix}:${hash(texts.join("\n"))}`, texts);
  }

  /** Segments (for this configuration) that contain `text`, with its position. */
  private candidates(text: string, prefix: string): { seg: Segment; idx: number }[] {
    const out: { seg: Segment; idx: number }[] = [];
    for (const key of this.byText.get(text) ?? []) {
      if (!key.startsWith(`${prefix}:`)) continue;
      const seg = this.segments.get(key);
      if (seg) out.push({ seg, idx: seg.texts.indexOf(text) });
    }
    return out;
  }

  /** Finds the segment to play `text` from, creating one starting at `text` if none fits. */
  private locate(text: string, prefix: string, cfg: GeminiConfig, hint: string[]): { seg: Segment; idx: number } {
    const p = this.playing;
    if (p && p.seg.key.startsWith(`${prefix}:`)) {
      if (p.seg.texts[p.idx + 1] === text) return { seg: p.seg, idx: p.idx + 1 };
      if (p.seg.texts[p.idx] === text) return { seg: p.seg, idx: p.idx };
    }
    // A segment whose following paragraphs match what comes next here.
    const fits = (c: { seg: Segment; idx: number }) =>
      c.seg.texts.slice(c.idx + 1).every((t, k) => k >= hint.length || hint[k] === t);
    const found = this.candidates(text, prefix).filter(fits);
    const best =
      found.find((c) => c.idx === 0 && c.seg.done) ??
      found.find((c) => c.seg.done) ??
      found.find((c) => c.idx === 0) ??
      found[0];
    if (best) return best;
    const [first] = planSegments([text, ...hint], cfg.segmentChars);
    return { seg: this.segmentFor(first, prefix), idx: 0 };
  }

  /** Ensures the segment being played and the next `ahead` ones exist, and queues their generation. */
  private planAhead(seg: Segment, idx: number, hint: string[], prefix: string, cfg: GeminiConfig): void {
    const chain = [seg];
    let h = seg.texts.length - idx - 1;
    let aligned = seg.texts.slice(idx + 1).every((t, k) => k >= hint.length || hint[k] === t);
    while (aligned && chain.length <= cfg.ahead && h < hint.length) {
      const rest = hint.slice(h);
      const existing = this.candidates(rest[0], prefix).find(
        (c) => c.idx === 0 && c.seg.texts.every((t, k) => k >= rest.length || rest[k] === t),
      );
      let next = existing?.seg;
      if (!next) {
        const [texts] = planSegments(rest, cfg.segmentChars);
        // Wait for more content rather than spending a request on a short tail, unless it is needed next.
        const size = texts.join("").length;
        if (texts.length === rest.length && size < cfg.segmentChars * 0.6 && chain.length > 1) break;
        next = this.segmentFor(texts, prefix);
      }
      chain.push(next);
      h += next.texts.length;
      aligned = true;
    }
    this.queue = chain.slice(1).filter((s) => !s.done);
    void this.pump(cfg);
  }

  private async pump(cfg: GeminiConfig): Promise<void> {
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
          log.warn("Gemini look-ahead failed", code);
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

  private render(seg: Segment, cfg: GeminiConfig): Promise<Rendered> {
    if (seg.done) return Promise.resolve(seg.done);
    seg.rendered ??= (async () => {
      const stored = await this.store.get(seg.key).catch(() => undefined);
      if (stored) return { audio: stored.audio, bounds: stored.bounds };
      const rendered = await this.generate(cfg, seg.texts);
      try {
        await this.store.put({ key: seg.key, texts: seg.texts, ...rendered });
        await this.evict();
      } catch (err) {
        log.warn("Gemini cache write failed", err);
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
    const limit = this.options.maxCacheBytes ?? GEMINI_CACHE_BYTES;
    const metas = (await this.store.list()).sort((a, b) => a.usedAt - b.usedAt);
    let total = metas.reduce((n, m) => n + m.bytes, 0);
    for (const m of metas) {
      if (total <= limit) break;
      if (m.key === this.playing?.seg.key) continue;
      await this.store.delete(m.key);
      const seg = this.segments.get(m.key);
      if (seg) this.forget(seg);
      total -= m.bytes;
    }
    this.options.onUsage?.(total);
  }

  private async generate(cfg: GeminiConfig, texts: string[]): Promise<Rendered> {
    const text = texts.join("\n\n");
    const body = JSON.stringify({
      contents: [{ parts: [{ text: cfg.style ? `${cfg.style}\n\n${text}` : text }] }],
      generationConfig: {
        responseModalities: ["AUDIO"],
        speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: cfg.voice } } },
      },
    });
    for (let attempt = 0; ; attempt++) {
      let res: HttpResponse;
      try {
        res = await this.request({
          method: "POST",
          url: `${GEMINI_API_BASE}/models/${encodeURIComponent(cfg.model)}:generateContent`,
          headers: { "x-goog-api-key": cfg.key, "Content-Type": "application/json" },
          body,
          timeoutMs: REQUEST_TIMEOUT_MS,
        });
      } catch (err) {
        if (err instanceof NetworkError && attempt < 2) {
          await this.wait(2000 * 3 ** attempt);
          continue;
        }
        throw new SpeechEngineError("network");
      }
      const raw = bodyText(res);
      if (res.status >= 200 && res.status < 300) {
        this.usage.add(text.length);
        return this.decode(raw, texts);
      }
      const code = geminiErrorCode(res.status, raw);
      if (code === "throttled" && attempt < 4) {
        const delay = Math.min(90_000, geminiRetryDelayMs(raw) ?? 15_000 * (attempt + 1));
        this.options.onStatus?.(`Gemini 请求过于频繁，${Math.ceil(delay / 1000)} 秒后重试…`);
        await this.wait(delay);
        continue;
      }
      if (code === "server" && attempt < 2) {
        await this.wait(2000 * 3 ** attempt);
        continue;
      }
      log.warn("Gemini TTS failed", res.status, raw.slice(0, 300));
      throw new SpeechEngineError(code);
    }
  }

  private decode(raw: string, texts: string[]): Rendered {
    type Part = { inlineData?: { mimeType?: string; data?: string } };
    let json: { candidates?: { finishReason?: string; content?: { parts?: Part[] } }[] };
    try {
      json = JSON.parse(raw) as typeof json;
    } catch {
      throw new SpeechEngineError("server");
    }
    const cand = json.candidates?.[0];
    if (cand?.finishReason === "MAX_TOKENS") throw new SpeechEngineError("too-long");
    const parts = (cand?.content?.parts ?? []).filter((p) => p.inlineData?.data);
    if (!parts.length) throw new SpeechEngineError("empty");
    const mime = parts[0].inlineData!.mimeType ?? "audio/L16;codec=pcm;rate=24000";
    const chunks = parts.map((p) => base64ToBytes(p.inlineData!.data!));
    const bytes = new Uint8Array(chunks.reduce((n, c) => n + c.byteLength, 0));
    let o = 0;
    for (const c of chunks) {
      bytes.set(c, o);
      o += c.byteLength;
    }
    const rate = pcmRate(mime);
    if (rate === undefined) return { audio: new Blob([bytes], { type: mime }), bounds: paragraphBounds(texts) };
    const samples = new Int16Array(bytes.buffer, 0, Math.floor(bytes.byteLength / 2));
    return { audio: pcmToWav(bytes, rate), bounds: paragraphBounds(texts, samples, rate) };
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
