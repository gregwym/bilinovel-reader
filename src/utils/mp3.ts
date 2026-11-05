/**
 * MP3 frames: what a stored segment holds, how long it plays, and whether
 * segments can be joined without re-encoding (see app/server/audio/mp3.ts).
 */

/**
 * What frames must share to be joined: version, sample rate, channel mode
 * and bitrate (a file without a Xing header has to be constant bitrate for
 * players to get its duration right).
 */
export interface Mp3Format {
  version: number;
  sampleRate: number;
  mono: boolean;
  bitrate: number;
}

export const sameFormat = (a: Mp3Format, b: Mp3Format) =>
  a.version === b.version && a.sampleRate === b.sampleRate && a.mono === b.mono && a.bitrate === b.bitrate;

const BITRATES_V1 = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320];
const BITRATES_V2 = [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160];
const RATES: Record<number, number[]> = { 3: [44100, 48000, 32000], 2: [22050, 24000, 16000], 0: [11025, 12000, 8000] };

interface Frame extends Mp3Format {
  length: number;
}

/** A Layer III frame header at `at`, if there is one. */
function frameAt(data: Uint8Array, at: number): Frame | undefined {
  if (at + 4 > data.length || data[at] !== 0xff || (data[at + 1] & 0xe0) !== 0xe0) return undefined;
  const version = (data[at + 1] >> 3) & 3;
  const layer = (data[at + 1] >> 1) & 3;
  const bitrateIndex = data[at + 2] >> 4;
  const rateIndex = (data[at + 2] >> 2) & 3;
  if (version === 1 || layer !== 1 || bitrateIndex === 0 || bitrateIndex === 15 || rateIndex === 3) return undefined;
  const sampleRate = RATES[version][rateIndex];
  const bitrate = (version === 3 ? BITRATES_V1 : BITRATES_V2)[bitrateIndex] * 1000;
  const padding = (data[at + 2] >> 1) & 1;
  const length = Math.floor(((version === 3 ? 144 : 72) * bitrate) / sampleRate) + padding;
  return { version, sampleRate, mono: data[at + 3] >> 6 === 3, bitrate, length };
}

/** Size of a leading ID3v2 tag (0 if none). */
export function id3Size(data: Uint8Array): number {
  if (data.length < 10 || data[0] !== 0x49 || data[1] !== 0x44 || data[2] !== 0x33) return 0;
  const size = ((data[6] & 0x7f) << 21) | ((data[7] & 0x7f) << 14) | ((data[8] & 0x7f) << 7) | (data[9] & 0x7f);
  return 10 + size + (data[5] & 0x10 ? 10 : 0);
}

/** Whether audio frames start at `at` (a stored range still points at audio). */
export function isFrameStart(data: Uint8Array, at = 0): boolean {
  return !!frameAt(data, at);
}

/**
 * The audio frames of an MP3 file: without ID3 tags and without the
 * Xing/Info/VBRI header frame (it describes one file; in the middle of a
 * chapter it would be wrong). Undefined when it isn't constant bitrate
 * Layer III MP3 throughout.
 */
export function mp3Frames(data: Uint8Array): { frames: Uint8Array; format: Mp3Format; seconds: number } | undefined {
  let start = id3Size(data);
  let first = frameAt(data, start);
  if (!first) return undefined;
  const side = first.version === 3 ? (first.mono ? 17 : 32) : first.mono ? 9 : 17;
  const tag = (at: number) => String.fromCharCode(...data.subarray(at, at + 4));
  const info = tag(start + 4 + side);
  if (info === "Xing" || info === "Info" || tag(start + 36) === "VBRI") {
    start += first.length;
    first = frameAt(data, start);
    if (!first) return undefined;
  }
  let end = data.length;
  // ID3v1 at the end.
  if (end - start >= 128 && data[end - 128] === 0x54 && data[end - 127] === 0x41 && data[end - 126] === 0x47) end -= 128;
  const format: Mp3Format = { version: first.version, sampleRate: first.sampleRate, mono: first.mono, bitrate: first.bitrate };
  let at = start;
  let count = 0;
  while (at < end) {
    const f = frameAt(data, at);
    if (!f || !sameFormat(f, format) || at + f.length > end) return undefined;
    at += f.length;
    count++;
  }
  const samples = first.version === 3 ? 1152 : 576;
  return { frames: data.subarray(start, end), format, seconds: (count * samples) / format.sampleRate };
}

/** Plays for how many seconds: `data` a WAV (PCM) or MP3 file; undefined when it is neither. */
export function audioSeconds(data: Uint8Array): number | undefined {
  const mp3 = mp3Frames(data);
  if (mp3) return mp3.seconds;
  return wavSeconds(data);
}

/** Length of a PCM WAV file (its `data` chunk over the byte rate). */
export function wavSeconds(data: Uint8Array): number | undefined {
  const tag = (at: number) => String.fromCharCode(...data.subarray(at, at + 4));
  if (data.length < 12 || tag(0) !== "RIFF" || tag(8) !== "WAVE") return undefined;
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  let byteRate = 0;
  for (let at = 12; at + 8 <= data.length; ) {
    const size = view.getUint32(at + 4, true);
    if (tag(at) === "fmt " && at + 20 <= data.length) byteRate = view.getUint32(at + 16, true);
    if (tag(at) === "data") return byteRate ? Math.min(size, data.length - at - 8) / byteRate : undefined;
    at += 8 + size + (size & 1);
  }
  return undefined;
}
