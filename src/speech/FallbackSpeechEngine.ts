import { SpeechEngineError, type SpeakOptions, type SpeechEngine } from "./SpeechEngine";

/** Errors after which switching to the fallback engine keeps reading going. */
const FALLBACK_CODES = new Set(["config", "auth", "quota", "network", "bad-request", "audio-error"]);

/**
 * Uses `primary` (e.g. Azure) until it fails in a way that will not fix
 * itself, then continues with `secondary` (the system voice) for the rest of
 * the session or until `reset()`.
 */
export class FallbackSpeechEngine implements SpeechEngine {
  private failedOver = false;

  constructor(
    private readonly primary: SpeechEngine,
    private readonly secondary: SpeechEngine,
    private readonly onFallback: (code: string) => void = () => undefined,
  ) {}

  private get active(): SpeechEngine {
    return this.failedOver ? this.secondary : this.primary;
  }

  get usingFallback(): boolean {
    return this.failedOver;
  }

  get maxChunkLength(): number | undefined {
    return this.active.maxChunkLength;
  }

  get speaking(): boolean {
    return this.active.speaking;
  }

  reset(): void {
    this.failedOver = false;
  }

  unlock(): void {
    this.primary.unlock();
    this.secondary.unlock();
  }

  async speak(text: string, options: SpeakOptions): Promise<"done" | "cancelled"> {
    if (!this.failedOver) {
      try {
        return await this.primary.speak(text, options);
      } catch (err) {
        if (!(err instanceof SpeechEngineError) || !FALLBACK_CODES.has(err.code)) throw err;
        this.failedOver = true;
        this.onFallback(err.code);
      }
    }
    return this.secondary.speak(text, options);
  }

  prefetch(text: string, options: SpeakOptions): void {
    this.active.prefetch?.(text, options);
  }

  pause(): void {
    this.active.pause();
  }

  resume(): void {
    this.active.resume();
  }

  stop(): void {
    this.primary.stop();
    this.secondary.stop();
  }
}
