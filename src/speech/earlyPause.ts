/**
 * iOS takes the audio session away from a web app that stays paused in the
 * background. Back in the foreground, the next play() starts and the system
 * pauses it again right away; only a second play() holds. A pause that comes
 * this soon after starting is therefore retried once instead of being taken
 * as an interruption (call, other audio, headphones unplugged).
 */
const WINDOW_MS = 2000;

export class EarlyPauseRetry {
  private startedAt = -Infinity;
  private used = false;

  /** Call whenever playback is (re)started. */
  started(): void {
    this.startedAt = Date.now();
    this.used = false;
  }

  /** On a pause nobody asked for: true if play() should be tried once more. */
  shouldRetry(): boolean {
    if (this.used || Date.now() - this.startedAt > WINDOW_MS) return false;
    if (typeof document !== "undefined" && document.visibilityState === "hidden") return false;
    this.used = true;
    return true;
  }
}
