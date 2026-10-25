/**
 * iOS takes the audio session away from a home-screen web app that stays
 * paused in the background (about 30 s), and then ignores `play()` until the
 * app is in the foreground again: the lock-screen / headphone "play" does
 * nothing. Looping silence while paused in the background keeps the session,
 * so "play" can continue right there. Given up after a while (battery).
 */

const MAX_MS = 30 * 60_000;

let audio: HTMLAudioElement | undefined;
let timer: ReturnType<typeof setTimeout> | undefined;

/** One second of 8 kHz 8-bit mono silence as a WAV file. */
function silence(): string {
  const n = 8000;
  const b = new Uint8Array(44 + n);
  const v = new DataView(b.buffer);
  const text = (at: number, s: string) => [...s].forEach((c, i) => (b[at + i] = c.charCodeAt(0)));
  text(0, "RIFF");
  v.setUint32(4, 36 + n, true);
  text(8, "WAVEfmt ");
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true); // PCM
  v.setUint16(22, 1, true); // mono
  v.setUint32(24, 8000, true);
  v.setUint32(28, 8000, true);
  v.setUint16(32, 1, true);
  v.setUint16(34, 8, true);
  text(36, "data");
  v.setUint32(40, n, true);
  b.fill(0x80, 44);
  return URL.createObjectURL(new Blob([b], { type: "audio/wav" }));
}

/** Starts the silence (call from the pause handler, while the session is still ours). */
export function holdAudioSession(): void {
  if (typeof Audio === "undefined") return;
  if (!audio) {
    audio = new Audio(silence());
    audio.loop = true;
  }
  try {
    void Promise.resolve(audio.play()).catch(() => undefined);
  } catch {
    // No audio here (tests, old browsers).
  }
  if (timer !== undefined) clearTimeout(timer);
  timer = setTimeout(releaseAudioSession, MAX_MS);
}

/** Stops the silence (call after the real audio was told to play). */
export function releaseAudioSession(): void {
  if (timer !== undefined) clearTimeout(timer);
  timer = undefined;
  if (audio && !audio.paused) audio.pause();
}
