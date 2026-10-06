import { describe, expect, it } from "vitest";
import { SpeechPlayer, splitIntoChunks, type PlaybackSource, type PlayerState } from "../src/speech/SpeechPlayer";
import { SpeechEngineError, type SpeechEngine } from "../src/speech/SpeechEngine";
import { sortChineseVoices } from "../src/speech/VoiceManager";

/** Engine that "speaks" instantly (or fails on demand) and records what it said. */
class FakeEngine implements SpeechEngine {
  spoken: string[] = [];
  rates: number[] = [];
  failWith?: string;
  hold = false;
  private pending?: (r: "done" | "cancelled") => void;
  speaking = false;
  unlock(): void {}
  speak(text: string, o: { rate: number }): Promise<"done" | "cancelled"> {
    this.pending?.("cancelled");
    if (this.failWith) return Promise.reject(new SpeechEngineError(this.failWith));
    this.spoken.push(text);
    this.rates.push(o.rate);
    if (this.hold) return new Promise((r) => (this.pending = r));
    return Promise.resolve("done");
  }
  pause(): void {}
  resume(): void {}
  stop(): void {
    this.pending?.("cancelled");
    this.pending = undefined;
  }
}

class FakeSource implements PlaybackSource {
  ids: string[];
  text: Record<string, string | undefined> = {};
  more: string[][] = [];
  loads = 0;
  constructor(ids: string[]) {
    this.ids = ids;
    ids.forEach((id) => (this.text[id] = `文本${id}。`));
  }
  cursor() {
    return this.ids[0];
  }
  textOf(id: string) {
    return this.text[id];
  }
  next(id: string) {
    const i = this.ids.indexOf(id);
    if (i + 1 < this.ids.length) return this.ids[i + 1];
    return this.more.length ? "pending" : "end";
  }
  prev(id: string) {
    const i = this.ids.indexOf(id);
    return i > 0 ? this.ids[i - 1] : undefined;
  }
  async loadMore() {
    this.loads++;
    const batch = this.more.shift();
    if (!batch) return false;
    batch.forEach((id) => (this.text[id] = `文本${id}。`));
    this.ids.push(...batch);
    return true;
  }
}

const flush = () => new Promise((r) => setTimeout(r, 0));
async function settle() {
  for (let i = 0; i < 20; i++) await flush();
}

describe("SpeechPlayer", () => {
  it("reads paragraph by paragraph, skipping images, then stops at the end", async () => {
    const engine = new FakeEngine();
    const source = new FakeSource(["a", "img", "b"]);
    source.text.img = undefined;
    const states: PlayerState[] = [];
    const paragraphs: string[] = [];
    const player = new SpeechPlayer(engine, source, {
      onState: (s) => states.push(s),
      onParagraph: (id) => paragraphs.push(id),
    });
    player.play();
    await settle();
    expect(engine.spoken).toEqual(["文本a。", "文本b。"]);
    expect(paragraphs).toEqual(["a", "img", "b"]);
    expect(states).toEqual(["playing", "idle"]);
  });

  it("buffers across page boundaries and continues", async () => {
    const engine = new FakeEngine();
    const source = new FakeSource(["a"]);
    source.more = [["b", "c"]];
    const states: PlayerState[] = [];
    const player = new SpeechPlayer(engine, source, { onState: (s) => states.push(s) });
    player.play();
    await settle();
    expect(engine.spoken).toEqual(["文本a。", "文本b。", "文本c。"]);
    expect(states).toEqual(["playing", "buffering", "playing", "idle"]);
  });

  it("goes to error when the next page cannot be loaded", async () => {
    const engine = new FakeEngine();
    const source = new FakeSource(["a"]);
    source.more = [["x"]];
    source.loadMore = async () => false;
    const states: PlayerState[] = [];
    new SpeechPlayer(engine, source, { onState: (s) => states.push(s) }).play();
    await settle();
    expect(states.at(-1)).toBe("error");
  });

  it("pauses and resumes from the same paragraph", async () => {
    const engine = new FakeEngine();
    engine.hold = true;
    const source = new FakeSource(["a", "b"]);
    const player = new SpeechPlayer(engine, source);
    player.play();
    await settle();
    expect(player.state).toBe("playing");
    player.pause();
    expect(player.state).toBe("paused");
    player.resume();
    await settle();
    expect(engine.spoken).toEqual(["文本a。", "文本a。"]);
    expect(player.currentId).toBe("a");
  });

  it("starts from a tapped paragraph and supports next/previous", async () => {
    const engine = new FakeEngine();
    engine.hold = true;
    const source = new FakeSource(["a", "b", "c"]);
    const player = new SpeechPlayer(engine, source);
    player.play("b");
    await settle();
    expect(engine.spoken.at(-1)).toBe("文本b。");
    player.nextParagraph();
    await settle();
    expect(engine.spoken.at(-1)).toBe("文本c。");
    player.previousParagraph();
    await settle();
    expect(engine.spoken.at(-1)).toBe("文本b。");
  });

  it("applies a rate change immediately", async () => {
    const engine = new FakeEngine();
    engine.hold = true;
    const player = new SpeechPlayer(engine, new FakeSource(["a"]), {}, { rate: 1 });
    player.play();
    await settle();
    player.setRate(1.35);
    await settle();
    expect(engine.rates).toEqual([1, 1.35]);
  });

  it("surfaces engine errors", async () => {
    const engine = new FakeEngine();
    engine.failWith = "synthesis-failed";
    const states: [PlayerState, string | undefined][] = [];
    new SpeechPlayer(engine, new FakeSource(["a"]), { onState: (s, m) => states.push([s, m]) }).play();
    await settle();
    expect(states.at(-1)?.[0]).toBe("error");
  });
});

describe("splitIntoChunks", () => {
  it("keeps short paragraphs whole", () => {
    expect(splitIntoChunks("「你好。」他说。")).toEqual(["「你好。」他说。"]);
  });

  it("splits long paragraphs at sentence ends within the limit", () => {
    const sentence = "这是一个用于测试的句子。";
    const chunks = splitIntoChunks(sentence.repeat(30), 60);
    expect(chunks.join("")).toBe(sentence.repeat(30));
    expect(Math.max(...chunks.map((c) => c.length))).toBeLessThanOrEqual(60);
  });

  it("hard-splits a single very long sentence", () => {
    const chunks = splitIntoChunks("长".repeat(400), 100);
    expect(chunks.join("")).toBe("长".repeat(400));
    expect(chunks.every((c) => c.length <= 150)).toBe(true);
  });

  it("drops punctuation-only chunks", () => {
    expect(splitIntoChunks("……")).toEqual([]);
  });
});

describe("sortChineseVoices", () => {
  it("orders zh-CN before zh-TW/zh-HK and filters other languages", () => {
    const voices = [
      { name: "Samantha", lang: "en-US", localService: true },
      { name: "Sinji", lang: "zh-HK", localService: true },
      { name: "Meijia", lang: "zh-TW", localService: true },
      { name: "Tingting", lang: "zh-CN", localService: true },
    ];
    expect(sortChineseVoices(voices).map((v) => v.name)).toEqual(["Tingting", "Meijia", "Sinji"]);
  });
});

describe("SpeechPlayer engine integration", () => {
  it("prefetches the next chunk/paragraph and can switch engines mid-play", async () => {
    const prefetched: string[] = [];
    const a = new FakeEngine();
    a.hold = true;
    (a as FakeEngine & { prefetch: (t: string) => void }).prefetch = (t: string) => prefetched.push(t);
    const b = new FakeEngine();
    b.hold = true;
    const player = new SpeechPlayer(a, new FakeSource(["a", "b"]));
    player.play();
    await settle();
    expect(prefetched).toEqual(["文本b。"]);
    player.setEngine(b);
    await settle();
    expect(b.spoken).toEqual(["文本a。"]);
    expect(player.state).toBe("playing");
  });
});
