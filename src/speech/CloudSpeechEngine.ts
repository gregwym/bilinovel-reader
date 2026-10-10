import { httpRequest, type HttpRequest, type HttpResponse } from "../utils/http";
import { log } from "../utils/log";
import { sleep } from "../utils/async";
import { SpeechEngineError, type SpeakOptions, type SpeechEngine } from "./SpeechEngine";

/** A short silent WAV, used to unlock the audio element inside a user gesture. */
function silentWavUrl(): string {
  const samples = 800; // 0.1s at 8kHz
  const buf = new ArrayBuffer(44 + samples);
  const v = new DataView(buf);
  const str = (o: number, s: string) => [...s].forEach((c, i) => v.setUint8(o + i, c.charCodeAt(0)));
  str(0, "RIFF");
  v.setUint32(4, 36 + samples, true);
  str(8, "WAVE");
  str(12, "fmt ");
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true); // PCM
  v.setUint16(22, 1, true); // mono
  v.setUint32(24, 8000, true);
  v.setUint32(28, 8000, true);
  v.setUint16(32, 1, true);
  v.setUint16(34, 8, true);
  str(36, "data");
  v.setUint32(40, samples, true);
  for (let i = 0; i < samples; i++) v.setUint8(44 + i, 128);
  let bin = "";
  new Uint8Array(buf).forEach((b) => (bin += String.fromCharCode(b)));
  return `data:audio/wav;base64,${btoa(bin)}`;
}

export interface CloudEngineOptions {
  request?: (req: HttpRequest) => Promise<HttpResponse>;
  audio?: HTMLAudioElement;
  /** Called with billable characters for every successful synthesis request. */
  onUsage?: (chars: number) => void;
  sleep?: (ms: number) => Promise<void>;
}

const PREFETCH_CONCURRENCY = 2;

/**
 * Network TTS played through one reused <audio> element, which iOS lets keep
 * playing while Safari is in the background (unlike speechSynthesis).
 * Subclasses only synthesize audio; playback, look-ahead synthesis and the
 * cache live here.
 */
export abstract class CloudSpeechEngine implements SpeechEngine {
  abstract readonly maxChunkLength: number;
  readonly firstChunkLength: number = 80;
  prefetchCount = 3;
  protected readonly request: (req: HttpRequest) => Promise<HttpResponse>;
  protected readonly wait: (ms: number) => Promise<void>;
  private prefetchQueue: { text: string; rate: number }[] = [];
  private prefetchActive = 0;
  private readonly audio: HTMLAudioElement;
  private readonly cache = new Map<string, Promise<Blob>>();
  private settle?: (r: "done" | "cancelled") => void;
  private objectUrl?: string;
  private token = 0;
  private unlocked = false;

  constructor(protected readonly options: CloudEngineOptions = {}) {
    this.request = options.request ?? httpRequest;
    this.wait = options.sleep ?? sleep;
    this.audio = options.audio ?? new Audio();
    this.audio.preload = "auto";
  }

  /** Cache key for a chunk with the current configuration; undefined when not configured. */
  protected abstract cacheKey(text: string, rate: number): string | undefined;

  /** Synthesizes one chunk (called at most once per cache key while cached). */
  protected abstract fetchAudio(text: string, rate: number): Promise<Blob>;

  get speaking(): boolean {
    return !!this.settle && !this.audio.paused && !this.audio.ended;
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

  /** Number of upcoming chunks to synthesize ahead (user setting). */
  setPrefetchCount(n: number): void {
    this.prefetchCount = Math.max(0, Math.min(10, Math.round(n)));
  }

  prefetch(texts: string[], options: SpeakOptions): void {
    if (this.cacheKey("", options.rate) === undefined) return;
    // Newest hint wins: drop queued (not yet started) work for an old position.
    this.prefetchQueue = texts
      .slice(0, this.prefetchCount)
      .filter((t) => !this.cache.has(this.cacheKey(t, options.rate)!))
      .map((text) => ({ text, rate: options.rate }));
    this.pumpPrefetch();
  }

  private pumpPrefetch(): void {
    while (this.prefetchActive < PREFETCH_CONCURRENCY && this.prefetchQueue.length) {
      const job = this.prefetchQueue.shift()!;
      this.prefetchActive++;
      this.synthesize(job.text, job.rate)
        .catch(() => undefined)
        .finally(() => {
          this.prefetchActive--;
          this.pumpPrefetch();
        });
    }
  }

  async speak(text: string, options: SpeakOptions): Promise<"done" | "cancelled"> {
    this.stop();
    const token = ++this.token;
    const blob = await this.synthesize(text, options.rate);
    if (token !== this.token) return "cancelled";

    return new Promise((resolve, reject) => {
      const audio = this.audio;
      const cleanup = () => {
        audio.removeEventListener("ended", onEnded);
        audio.removeEventListener("error", onError);
        audio.removeEventListener("pause", onPause);
        if (this.settle === settle) this.settle = undefined;
      };
      const settle = (r: "done" | "cancelled") => {
        cleanup();
        resolve(r);
      };
      const onEnded = () => settle("done");
      const onError = () => {
        cleanup();
        reject(new SpeechEngineError("audio-error"));
      };
      // Paused by the system (phone call, other audio, headphones unplugged, lock-screen
      // control): report it so the player shows "paused" instead of waiting forever.
      // A stale event from stopping the previous chunk arrives after play() and is ignored.
      const onPause = () => {
        if (this.settle === settle && audio.paused && !audio.ended) settle("cancelled");
      };
      audio.addEventListener("ended", onEnded);
      audio.addEventListener("error", onError);
      this.settle = settle;

      this.revokeUrl();
      this.objectUrl = URL.createObjectURL(blob);
      audio.src = this.objectUrl;
      audio
        .play()
        .then(() => {
          if (this.settle === settle) audio.addEventListener("pause", onPause);
        })
        .catch((err: unknown) => {
          if (this.settle !== settle) return; // stopped meanwhile
          cleanup();
          const name = (err as { name?: string })?.name;
          reject(new SpeechEngineError(name === "NotAllowedError" ? "not-allowed" : "audio-error"));
        });
    });
  }

  pause(): void {
    this.audio.pause();
  }

  resume(): void {
    void this.audio.play().catch(() => undefined);
  }

  stop(): void {
    this.token++;
    const settle = this.settle;
    this.settle = undefined;
    if (!this.audio.paused) this.audio.pause();
    settle?.("cancelled");
  }

  /** Fetches (or reuses) synthesized audio for a chunk. */
  synthesize(text: string, rate: number): Promise<Blob> {
    const key = this.cacheKey(text, rate);
    if (key === undefined) return Promise.reject(new SpeechEngineError("config"));
    let pending = this.cache.get(key);
    if (pending) {
      // Refresh LRU position.
      this.cache.delete(key);
      this.cache.set(key, pending);
      return pending;
    }
    pending = this.fetchAudio(text, rate);
    this.cache.set(key, pending);
    pending.catch(() => this.cache.delete(key));
    // Room for the buffered chunks plus a few recent ones (pause/resume, rate change).
    const capacity = Math.max(8, this.prefetchCount * 2 + 4);
    while (this.cache.size > capacity) this.cache.delete(this.cache.keys().next().value!);
    return pending;
  }

  private revokeUrl(): void {
    if (this.objectUrl) URL.revokeObjectURL(this.objectUrl);
    this.objectUrl = undefined;
  }
}
