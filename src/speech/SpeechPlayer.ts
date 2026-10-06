import { log } from "../utils/log";
import { SpeechEngineError, type SpeechEngine } from "./SpeechEngine";

export type PlayerState = "idle" | "playing" | "paused" | "buffering" | "error";

/** What the player reads from. Implemented by the Reader; knows nothing about the DOM. */
export interface PlaybackSource {
  /** Paragraph to start from when play() is called without an id. */
  cursor(): string | undefined;
  /** Speakable text, or undefined for non-text paragraphs (images). */
  textOf(id: string): string | undefined;
  next(id: string): string | "pending" | "end";
  prev(id: string): string | undefined;
  /** Loads more content. Resolves true if something new became available. */
  loadMore(): Promise<boolean>;
}

export interface PlayerEvents {
  onState?(state: PlayerState, message?: string): void;
  /** A paragraph became the current one (started speaking, or moved to while paused). */
  onParagraph?(id: string): void;
}

const MAX_CHUNK = 120;

/**
 * Splits a paragraph into utterance-sized chunks at sentence boundaries so
 * pausing/resuming and rate changes lose little and WebKit never gets a
 * very long utterance.
 */
export function splitIntoChunks(text: string, max = MAX_CHUNK): string[] {
  const sentences = text.match(/[^。！？!?…；;]+[。！？!?…；;」』”’）)]*|[。！？!?…；;」』”’）)]+/g) ?? [text];
  const chunks: string[] = [];
  let buf = "";
  for (const s of sentences) {
    if (buf && (buf + s).length > max) {
      chunks.push(buf);
      buf = "";
    }
    buf += s;
    while (buf.length > max * 1.5) {
      // A single over-long sentence: cut at a comma if possible, else hard cut.
      const cut = Math.max(buf.lastIndexOf("，", max), buf.lastIndexOf(",", max));
      const at = cut > max / 3 ? cut + 1 : max;
      chunks.push(buf.slice(0, at));
      buf = buf.slice(at);
    }
  }
  if (buf.trim()) chunks.push(buf);
  return chunks.map((c) => c.trim()).filter((c) => c && /[\p{L}\p{N}]/u.test(c));
}

/**
 * Paragraph-by-paragraph TTS state machine.
 *
 *   idle --play--> playing --pause--> paused --resume--> playing
 *   playing --end of loaded content--> buffering --loaded--> playing
 *   playing --engine error--> error --play--> playing
 */
export class SpeechPlayer {
  private _state: PlayerState = "idle";
  private current?: string;
  private chunkIndex = 0;
  /** Incremented to invalidate the running loop. */
  private generation = 0;
  private rate: number;
  private voiceURI?: string;

  constructor(
    private readonly engine: SpeechEngine,
    private readonly source: PlaybackSource,
    private readonly events: PlayerEvents = {},
    options: { rate?: number; voiceURI?: string } = {},
  ) {
    this.rate = options.rate ?? 1;
    this.voiceURI = options.voiceURI;
  }

  get state(): PlayerState {
    return this._state;
  }

  get currentId(): string | undefined {
    return this.current;
  }

  get isActive(): boolean {
    return this._state === "playing" || this._state === "buffering";
  }

  /** Starts playing from `fromId`, the current paragraph, or the source cursor. Call from a user gesture. */
  play(fromId?: string): void {
    this.engine.unlock();
    if (fromId) {
      this.current = fromId;
      this.chunkIndex = 0;
    } else if (!this.current || this._state === "idle") {
      this.current = this.source.cursor() ?? this.current;
      this.chunkIndex = 0;
    }
    if (!this.current) return;
    this.restartLoop();
  }

  pause(): void {
    if (!this.isActive) return;
    this.generation++;
    this.engine.stop();
    this.setState("paused");
  }

  resume(): void {
    if (this._state !== "paused" && this._state !== "error") return;
    this.play();
  }

  toggle(): void {
    if (this.isActive) this.pause();
    else if (this._state === "paused") this.resume();
    else this.play();
  }

  stop(): void {
    this.generation++;
    this.engine.stop();
    this.chunkIndex = 0;
    this.setState("idle");
  }

  nextParagraph(): void {
    if (!this.current) return;
    const n = this.source.next(this.current);
    if (n === "end" || n === "pending") {
      if (n === "pending") void this.source.loadMore();
      return;
    }
    this.moveTo(n);
  }

  previousParagraph(): void {
    if (!this.current) return;
    // Within a paragraph that has progressed, first restart it.
    if (this.isActive && this.chunkIndex > 0) return this.moveTo(this.current);
    const p = this.source.prev(this.current);
    if (p) this.moveTo(p);
  }

  /** Sets the paragraph without starting playback (e.g. user tapped while idle). */
  select(id: string): void {
    if (this.isActive) return this.moveTo(id);
    this.current = id;
    this.chunkIndex = 0;
  }

  setRate(rate: number): void {
    this.rate = rate;
    if (this.isActive) this.restartLoop(); // apply immediately, from the current chunk
  }

  setVoice(voiceURI: string | undefined): void {
    this.voiceURI = voiceURI;
    if (this.isActive) this.restartLoop();
  }

  /** Re-speaks the current chunk if the engine went quiet (e.g. returning from background). */
  recoverIfStalled(): void {
    if (this._state === "playing" && !this.engine.speaking) {
      log.debug("recovering stalled speech");
      this.restartLoop();
    }
  }

  private moveTo(id: string): void {
    this.current = id;
    this.chunkIndex = 0;
    if (this.isActive) this.restartLoop();
    else this.events.onParagraph?.(id);
  }

  private restartLoop(): void {
    const gen = ++this.generation;
    this.engine.stop();
    this.setState("playing");
    void this.loop(gen);
  }

  private setState(state: PlayerState, message?: string): void {
    if (this._state === state && !message) return;
    this._state = state;
    this.events.onState?.(state, message);
  }

  private async loop(gen: number): Promise<void> {
    const alive = () => gen === this.generation;
    let announced: string | undefined;
    let retried = false;
    while (alive() && this.current) {
      const id = this.current;
      const text = this.source.textOf(id);
      if (announced !== id) {
        announced = id;
        this.events.onParagraph?.(id);
      }
      if (text) {
        const chunks = splitIntoChunks(text);
        while (alive() && this.chunkIndex < chunks.length) {
          try {
            const r = await this.engine.speak(chunks[this.chunkIndex], { rate: this.rate, voiceURI: this.voiceURI });
            if (!alive()) return;
            if (r === "cancelled") {
              // Cancelled by something other than us (system interruption): stop cleanly.
              this.generation++;
              this.setState("paused");
              return;
            }
            this.chunkIndex++;
            retried = false;
          } catch (err) {
            if (!alive()) return;
            const code = err instanceof SpeechEngineError ? err.code : String(err);
            log.warn("speech error", code);
            if (code === "no-start" && !retried) {
              retried = true; // WebKit occasionally drops an utterance; try once more
              continue;
            }
            this.generation++;
            if (code === "not-allowed") this.setState("paused", "点击 ▶ 继续朗读");
            else this.setState("error", `朗读出错（${code}）`);
            return;
          }
        }
      }
      if (!alive()) return;

      // Advance to the next paragraph, loading more content if needed.
      let next = this.source.next(id);
      if (next === "pending") {
        this.setState("buffering");
        await this.source.loadMore().catch(() => false);
        if (!alive()) return;
        next = this.source.next(id);
        if (next === "pending") {
          this.generation++;
          this.setState("error", "下一页加载失败，点 ▶ 重试");
          return;
        }
        this.setState("playing");
      }
      if (next === "end") {
        this.generation++;
        this.chunkIndex = 0;
        this.setState("idle", "已经读到最后了");
        return;
      }
      this.current = next;
      this.chunkIndex = 0;
    }
  }
}
