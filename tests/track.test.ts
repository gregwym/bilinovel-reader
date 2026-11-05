import { beforeAll, describe, expect, it } from "vitest";
import {
  MemorySegmentStore,
  PageSpeechEngine,
  pcmToWav,
  segmentKey,
  type ChapterTimeline,
  type PageBackend,
  type PageEngineConfig,
  type TrackPosition,
} from "../src/speech/PageSpeechEngine";

/** An audio element that plays instantly and reports the events the engine listens to. */
class FakeAudio {
  paused = true;
  ended = false;
  preload = "";
  currentTime = 0;
  duration = NaN;
  readyState = 0;
  playbackRate = 1;
  defaultPlaybackRate = 1;
  private _src = "";
  private listeners: Record<string, (() => void)[]> = {};
  get src() {
    return this._src;
  }
  set src(v: string) {
    this._src = v;
    this.currentTime = 0;
    this.readyState = 4;
    this.emit("loadedmetadata");
  }
  addEventListener(ev: string, fn: () => void) {
    (this.listeners[ev] ??= []).push(fn);
  }
  removeEventListener(ev: string, fn: () => void) {
    this.listeners[ev] = (this.listeners[ev] ?? []).filter((f) => f !== fn);
  }
  emit(ev: string) {
    for (const f of [...(this.listeners[ev] ?? [])]) f();
  }
  play() {
    this.paused = false;
    this.emit("playing");
    return Promise.resolve();
  }
  pause() {
    this.paused = true;
    this.emit("pause");
  }
}

const PREFIX = "test|voice";
const backend: PageBackend<PageEngineConfig> = {
  name: "Test",
  maxChars: 1000,
  cacheKey: () => PREFIX,
  generate: async () => {
    throw new Error("everything is stored");
  },
};

/** A chapter of two site pages: page 0 has two paragraphs, page 1 one. */
const PAGES = [["第一段。", "第二段。"], ["第三段。"]];
/** Seconds of each page's stored audio. */
const SECONDS = [4, 6];
const wav = (seconds: number) => pcmToWav(new Uint8Array(seconds * 8000 * 2), 8000);

async function setup(stored = [true, true]) {
  const audio = new FakeAudio();
  const store = new MemorySegmentStore();
  for (const [i, texts] of PAGES.entries()) {
    if (stored[i]) await store.put({ key: segmentKey(PREFIX, texts), texts, audio: wav(SECONDS[i]), bounds: i === 0 ? [0, 0.25, 1] : [0, 1] });
  }
  const tracks: (TrackPosition | undefined)[] = [];
  const timeline: ChapterTimeline = {
    chapterId: "c1",
    segments: PAGES.map((texts, pageIndex) => ({ key: segmentKey(PREFIX, texts), pageIndex, first: 0 })),
  };
  const e = new PageSpeechEngine(backend, () => ({ key: "k", ahead: 0 }), {
    // Paragraph ids are "page:index".
    pages: (id) => {
      const [page, index] = id.split(":").map(Number);
      return { pages: PAGES.slice(page), index };
    },
    timeline: async () => timeline,
    onTrack: (p) => void tracks.push(p),
    audio: audio as unknown as HTMLAudioElement,
    store,
  });
  return { e, audio, tracks };
}

const flush = async () => {
  for (let i = 0; i < 10; i++) await new Promise((r) => setTimeout(r, 0));
};

beforeAll(() => {
  URL.createObjectURL ??= () => `blob:${Math.random()}`;
  URL.revokeObjectURL ??= () => undefined;
});

describe("a chapter's stored audio as one track", () => {
  it("reports the position in the whole chapter, not in the segment playing", async () => {
    const { e, audio, tracks } = await setup();
    void e.speak("第一段。", { rate: 1, paragraphId: "0:0" });
    await flush();
    expect(tracks.at(-1)).toEqual({ duration: 10, position: 0, rate: 1 });

    // The next page's audio: 4 s (the first page) plus where it is.
    void e.speak("第三段。", { rate: 1, paragraphId: "1:0" });
    await flush();
    audio.currentTime = 2;
    audio.playbackRate = 1.5;
    audio.emit("ratechange");
    expect(tracks.at(-1)).toEqual({ duration: 10, position: 6, rate: 1.5 });
    e.stop();
  });

  it("reports none while part of the chapter isn't stored", async () => {
    const { e, tracks } = await setup([true, false]);
    void e.speak("第一段。", { rate: 1, paragraphId: "0:0" });
    await flush();
    expect(tracks.length).toBeGreaterThan(0);
    expect(tracks.every((t) => t === undefined)).toBe(true);
    expect(await e.locate(1)).toBeUndefined();
    e.stop();
  });

  it("finds the paragraph to play from for a moment in the chapter", async () => {
    const { e } = await setup();
    void e.speak("第一段。", { rate: 1, paragraphId: "0:0" });
    await flush();
    // The first page's second paragraph starts at 1 s (a quarter of 4 s).
    expect(await e.locate(0.5)).toEqual({ chapterId: "c1", pageIndex: 0, utterance: 0 });
    expect(await e.locate(1.2)).toEqual({ chapterId: "c1", pageIndex: 0, utterance: 1 });
    expect(await e.locate(7)).toEqual({ chapterId: "c1", pageIndex: 1, utterance: 0 });
    expect(await e.locate(99)).toEqual({ chapterId: "c1", pageIndex: 1, utterance: 0 });
    e.stop();
  });
});
