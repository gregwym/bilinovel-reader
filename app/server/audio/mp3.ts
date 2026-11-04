/**
 * MP3 files joined without re-encoding or ffmpeg: a chapter file is an ID3
 * tag followed by its segments' frames, so each segment stays a byte range
 * of the chapter (see Tts.adopt) and isn't stored twice.
 */

import type { Tags } from "./ffmpeg";

export { audioSeconds, id3Size, isFrameStart, mp3Frames, sameFormat, type Mp3Format } from "../../../src/utils/mp3";

const syncsafe = (n: number) => [(n >> 21) & 0x7f, (n >> 14) & 0x7f, (n >> 7) & 0x7f, n & 0x7f];

/** An ID3v2.3 tag with text frames (UTF-16, so any title works). */
export function id3Tag(tags: Tags): Uint8Array {
  const ids: Record<keyof Tags, string> = { title: "TIT2", album: "TALB", artist: "TPE1", track: "TRCK", disc: "TPOS", genre: "TCON" };
  const frames: Uint8Array[] = [];
  for (const [k, id] of Object.entries(ids) as [keyof Tags, string][]) {
    const value = tags[k];
    if (!value) continue;
    // Encoding 1 (UTF-16 with BOM), little endian.
    const text = new Uint8Array(3 + value.length * 2);
    text.set([1, 0xff, 0xfe]);
    for (let i = 0; i < value.length; i++) {
      const c = value.charCodeAt(i);
      text[3 + i * 2] = c & 0xff;
      text[4 + i * 2] = c >> 8;
    }
    const n = text.length;
    const header = new Uint8Array([...[...id].map((ch) => ch.charCodeAt(0)), (n >>> 24) & 0xff, (n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff, 0, 0]);
    frames.push(header, text);
  }
  const size = frames.reduce((n, f) => n + f.length, 0);
  const out = new Uint8Array(10 + size);
  out.set([0x49, 0x44, 0x33, 3, 0, 0, ...syncsafe(size)]);
  let o = 10;
  for (const f of frames) {
    out.set(f, o);
    o += f.length;
  }
  return out;
}
