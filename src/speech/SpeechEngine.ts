import { log } from "../utils/log";

export interface SpeakOptions {
  rate: number;
  voiceURI?: string;
  lang?: string;
}

/**
 * Minimal text-to-speech backend. `speak` resolves when the utterance has
 * finished, resolves with `"cancelled"` when interrupted by `stop()`, and
 * rejects on engine errors. A future NativeSpeechEngine can implement this.
 */
export interface SpeechEngine {
  /** Must be called synchronously inside a user gesture before the first `speak` (iOS). */
  unlock(): void;
  speak(text: string, options: SpeakOptions): Promise<"done" | "cancelled">;
  /** Optional hint: `text` will probably be spoken next (network engines start synthesizing it). */
  prefetch?(text: string, options: SpeakOptions): void;
  /** Preferred maximum utterance length in characters. */
  readonly maxChunkLength?: number;
  pause(): void;
  resume(): void;
  stop(): void;
  /** True while audio is (supposed to be) playing. */
  readonly speaking: boolean;
}

export class SpeechEngineError extends Error {
  constructor(readonly code: string) {
    super(`Speech synthesis error: ${code}`);
    this.name = "SpeechEngineError";
  }
}

/**
 * Web Speech API implementation with workarounds for WebKit:
 * - keeps a reference to the active utterance (otherwise it can be GC'd and
 *   `onend` never fires);
 * - a watchdog resolves the promise if `onend` is lost (seen when Safari is
 *   backgrounded or the audio session is interrupted);
 * - `unlock()` primes the synthesizer from a user gesture.
 */
export class WebSpeechEngine implements SpeechEngine {
  private utterance?: SpeechSynthesisUtterance;
  private settle?: (r: "done" | "cancelled") => void;
  private watchdog?: ReturnType<typeof setInterval>;
  private unlocked = false;

  constructor(
    private readonly synth: SpeechSynthesis | undefined = globalThis.speechSynthesis,
    private readonly getVoice: (uri?: string) => SpeechSynthesisVoice | undefined = () => undefined,
  ) {}

  static isSupported(): boolean {
    return typeof window !== "undefined" && "speechSynthesis" in window && "SpeechSynthesisUtterance" in window;
  }

  get speaking(): boolean {
    return !!this.utterance && !!this.synth?.speaking && !this.synth.paused;
  }

  unlock(): void {
    if (this.unlocked || !this.synth) return;
    this.unlocked = true;
    try {
      const u = new SpeechSynthesisUtterance(" ");
      u.volume = 0;
      this.synth.speak(u);
    } catch (err) {
      log.warn("speech unlock failed", err);
    }
  }

  speak(text: string, options: SpeakOptions): Promise<"done" | "cancelled"> {
    this.stop();
    const synth = this.synth;
    if (!synth) return Promise.reject(new SpeechEngineError("unsupported"));
    return new Promise((resolve, reject) => {
      const u = new SpeechSynthesisUtterance(text);
      u.rate = options.rate;
      u.lang = options.lang ?? "zh-CN";
      const voice = this.getVoice(options.voiceURI);
      if (voice) {
        u.voice = voice;
        u.lang = voice.lang;
      }
      let started = false;
      let quietTicks = 0;
      const startedAt = Date.now();

      const finish = (result: "done" | "cancelled" | SpeechEngineError) => {
        if (this.utterance !== u) return; // stale callback
        this.clearWatchdog();
        this.utterance = undefined;
        this.settle = undefined;
        if (result instanceof SpeechEngineError) reject(result);
        else resolve(result);
      };

      u.onstart = () => {
        started = true;
      };
      u.onend = () => finish("done");
      u.onerror = (ev) => {
        const code = (ev as SpeechSynthesisErrorEvent).error ?? "unknown";
        if (code === "interrupted" || code === "canceled") finish("cancelled");
        else finish(new SpeechEngineError(code));
      };

      this.utterance = u;
      this.settle = (r) => finish(r);

      this.watchdog = setInterval(() => {
        if (synth.paused) return;
        if (synth.speaking || synth.pending) {
          quietTicks = 0;
          return;
        }
        quietTicks++;
        // Synth is idle but we never got onend: assume it finished (or was dropped).
        if ((started && quietTicks >= 2) || (!started && Date.now() - startedAt > 6000)) {
          log.debug("speech watchdog fired", { started, text: text.slice(0, 20) });
          finish(started ? "done" : new SpeechEngineError("no-start"));
        }
      }, 1000);

      try {
        synth.speak(u);
      } catch (err) {
        finish(new SpeechEngineError(String(err)));
      }
    });
  }

  pause(): void {
    this.synth?.pause();
  }

  resume(): void {
    this.synth?.resume();
  }

  stop(): void {
    const settle = this.settle;
    this.clearWatchdog();
    this.settle = undefined;
    if (settle) settle("cancelled");
    this.utterance = undefined;
    if (this.synth && (this.synth.speaking || this.synth.pending)) this.synth.cancel();
  }

  private clearWatchdog(): void {
    if (this.watchdog !== undefined) clearInterval(this.watchdog);
    this.watchdog = undefined;
  }
}
