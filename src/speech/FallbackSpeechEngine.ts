import { SpeechEngineError, type SpeakOptions, type SpeechEngine } from "./SpeechEngine";

/** Errors that go away by themselves: retry the primary engine soon. */
const TRANSIENT = new Set(["network", "throttled", "server", "audio-error", "timeout"]);
/** Errors that need a settings change (or the user pressing "retry"). */
const UNTIL_RESET = new Set(["config", "auth", "bad-request", "billing", "api-disabled"]);
/** Monthly quota used up: probe again occasionally. */
const QUOTA_COOLDOWN_MS = 30 * 60_000;
const TRANSIENT_BASE_MS = 20_000;
const TRANSIENT_MAX_MS = 5 * 60_000;

export interface FallbackEvents {
  /** Primary failed; secondary is used until `retryAt` (Infinity = until reset). */
  onFallback?(code: string, retryAt: number): void;
  /** Primary works again. */
  onRecover?(): void;
}

/**
 * Circuit breaker around a primary engine (e.g. Azure) with a secondary
 * fallback (the system voice), applied per utterance:
 *
 * - a transient failure (network, throttling, server) speaks just that
 *   utterance with the secondary and retries the primary after a short,
 *   growing cooldown;
 * - quota exhaustion retries after 30 minutes;
 * - bad credentials/config wait for `reset()` (settings change or the user's
 *   "retry" button).
 */
export class FallbackSpeechEngine implements SpeechEngine {
  private openUntil = 0;
  private failures = 0;
  private lastCode?: string;
  /** A fallback happened and the recovery has not been announced yet. */
  private degraded = false;
  private lastUsed: SpeechEngine;

  constructor(
    private readonly primary: SpeechEngine,
    private readonly secondary: SpeechEngine,
    private readonly events: FallbackEvents = {},
    private readonly now: () => number = () => Date.now(),
  ) {
    this.lastUsed = primary;
  }

  /** True while utterances go to the secondary engine. */
  get usingFallback(): boolean {
    return this.now() < this.openUntil;
  }

  get fallbackReason(): string | undefined {
    return this.usingFallback ? this.lastCode : undefined;
  }

  get retryAt(): number {
    return this.openUntil;
  }

  get maxChunkLength(): number | undefined {
    return (this.usingFallback ? this.secondary : this.primary).maxChunkLength;
  }

  get firstChunkLength(): number | undefined {
    return this.usingFallback ? undefined : this.primary.firstChunkLength;
  }

  get prefetchCount(): number | undefined {
    return this.usingFallback ? undefined : this.primary.prefetchCount;
  }

  get speaking(): boolean {
    return this.lastUsed.speaking;
  }

  /** Closes the breaker: the next utterance tries the primary again. */
  reset(): void {
    this.openUntil = 0;
    this.failures = 0;
    this.lastCode = undefined;
  }

  unlock(): void {
    this.primary.unlock();
    this.secondary.unlock();
  }

  async speak(text: string, options: SpeakOptions): Promise<"done" | "cancelled"> {
    if (!this.usingFallback) {
      try {
        this.lastUsed = this.primary;
        const r = await this.primary.speak(text, options);
        if (r === "done") {
          this.failures = 0;
          this.lastCode = undefined;
          if (this.degraded) {
            this.degraded = false;
            this.events.onRecover?.();
          }
        }
        return r;
      } catch (err) {
        if (!(err instanceof SpeechEngineError) || !this.handles(err.code)) throw err;
        this.trip(err.code);
      }
    }
    this.lastUsed = this.secondary;
    return this.secondary.speak(text, options);
  }

  private handles(code: string): boolean {
    return TRANSIENT.has(code) || UNTIL_RESET.has(code) || code === "quota";
  }

  private trip(code: string): void {
    this.failures++;
    this.lastCode = code;
    this.degraded = true;
    let cooldown: number;
    if (UNTIL_RESET.has(code)) cooldown = Infinity;
    else if (code === "quota") cooldown = QUOTA_COOLDOWN_MS;
    else cooldown = Math.min(TRANSIENT_MAX_MS, TRANSIENT_BASE_MS * 2 ** (this.failures - 1));
    this.openUntil = this.now() + cooldown;
    this.events.onFallback?.(code, this.openUntil);
  }

  prefetch(texts: string[], options: SpeakOptions): void {
    if (!this.usingFallback) this.primary.prefetch?.(texts, options);
  }

  pause(): void {
    this.lastUsed.pause();
  }

  resume(): void {
    this.lastUsed.resume();
  }

  stop(): void {
    this.primary.stop();
    this.secondary.stop();
  }
}
