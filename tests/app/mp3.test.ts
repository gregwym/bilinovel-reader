import { describe, expect, it } from "vitest";
import { id3Size, id3Tag, isFrameStart, mp3Frames } from "../../app/server/audio/mp3";

/** A constant bitrate MPEG1 Layer III frame (128 kbps, 44.1 kHz, mono). */
function frame(): Uint8Array {
  const f = new Uint8Array(417);
  f.set([0xff, 0xfb, 0x90, 0xc4]);
  return f;
}

describe("mp3", () => {
  it("writes an ID3 tag whose size reads back", () => {
    const tag = id3Tag({ title: "第一章", artist: "作者" });
    expect(id3Size(tag)).toBe(tag.length);
    expect(isFrameStart(tag)).toBe(false);
  });

  it("takes the frames out of a file, without tags", () => {
    const tag = id3Tag({ title: "x" });
    const data = new Uint8Array(tag.length + 3 * 417);
    data.set(tag);
    for (let i = 0; i < 3; i++) data.set(frame(), tag.length + i * 417);
    const mp3 = mp3Frames(data)!;
    expect(mp3.frames.length).toBe(3 * 417);
    expect(mp3.format).toEqual({ version: 3, sampleRate: 44100, mono: true, bitrate: 128000 });
    expect(mp3.seconds).toBeCloseTo((3 * 1152) / 44100);
    expect(mp3Frames(new Uint8Array(100))).toBeUndefined();
    // Cut off mid-frame: not joined as is.
    expect(mp3Frames(data.subarray(0, data.length - 10))).toBeUndefined();
  });
});
