import { beforeAll, describe, expect, it } from "vitest";
import {
  GeminiSpeechEngine,
  GeminiUsageMeter,
  geminiErrorCode,
  geminiRetryDelayMs,
  type GeminiConfig,
} from "../src/speech/GeminiSpeechEngine";
import { MemorySegmentStore, paragraphBounds, pcmToWav, speakableText, splitPage } from "../src/speech/PageSpeechEngine";
import { DEFAULT_SETTINGS, sanitizeSettings } from "../src/reader/ProgressStore";
import type { HttpRequest, HttpResponse } from "../src/utils/http";

const RATE = 24000;
const enc = (s: string) => new TextEncoder().encode(s).buffer as ArrayBuffer;
const json = (status: number, body: unknown): HttpResponse => ({ status, headers: {}, body: enc(JSON.stringify(body)) });

/** PCM with a tone for each length in `speech` (seconds), separated by `gap` seconds of silence. */
function pcm(speech: number[], gap = 0.5): Int16Array {
  const parts: number[] = [];
  speech.forEach((sec, i) => {
    for (let k = 0; k < sec * RATE; k++) parts.push(Math.round(8000 * Math.sin(k / 6)));
    if (i < speech.length - 1) for (let k = 0; k < gap * RATE; k++) parts.push(0);
  });
  return Int16Array.from(parts);
}

function audioResponse(samples: Int16Array): HttpResponse {
  const data = Buffer.from(samples.buffer, samples.byteOffset, samples.byteLength).toString("base64");
  return json(200, {
    candidates: [
      { finishReason: "STOP", content: { parts: [{ inlineData: { mimeType: "audio/L16;codec=pcm;rate=24000", data } }] } },
    ],
  });
}

class FakeAudio {
  paused = true;
  ended = false;
  preload = "";
  currentTime = 0;
  duration = NaN;
  readyState = 0;
  playbackRate = 1;
  defaultPlaybackRate = 1;
  sources: string[] = [];
  private _src = "";
  private listeners: Record<string, (() => void)[]> = {};
  constructor(private readonly length: number) {}
  get src() {
    return this._src;
  }
  set src(v: string) {
    this._src = v;
    this.sources.push(v);
    this.currentTime = 0;
    this.duration = this.length;
    this.readyState = 4;
  }
  addEventListener(ev: string, fn: () => void) {
    (this.listeners[ev] ??= []).push(fn);
  }
  removeEventListener(ev: string, fn: () => void) {
    this.listeners[ev] = (this.listeners[ev] ?? []).filter((f) => f !== fn);
  }
  emit(ev: string) {
    [...(this.listeners[ev] ?? [])].forEach((f) => f());
  }
  play() {
    this.paused = false;
    this.ended = false;
    return Promise.resolve();
  }
  pause() {
    if (this.paused) return;
    this.paused = true;
    this.emit("pause");
  }
  /** Moves playback to `t` seconds. */
  at(t: number) {
    this.currentTime = t;
    this.emit("timeupdate");
  }
  end() {
    this.currentTime = this.duration;
    this.paused = true;
    this.ended = true;
    this.emit("ended");
  }
}

const cfg: GeminiConfig = { key: "k", model: "gemini-3.8-flash-tts", voice: "Kore", style: "", ahead: 2 };
const BOOK = [
  ["第一段。", "第二段。", "第三段。"],
  ["第四段。", "第五段。"],
  ["第六段。"],
];
const flush = () => new Promise((r) => setTimeout(r, 0));

function engine(responses: HttpResponse[], store = new MemorySegmentStore(), length = 4.5) {
  const requests: HttpRequest[] = [];
  const waits: number[] = [];
  const audio = new FakeAudio(length);
  const e = new GeminiSpeechEngine(() => cfg, {
    pages: (id) => {
      const [page, para] = id.split(":").map(Number);
      return { pages: BOOK.slice(page, page + cfg.ahead + 1), index: para };
    },
    audio: audio as unknown as HTMLAudioElement,
    store,
    usage: new GeminiUsageMeter(undefined),
    request: async (r) => {
      requests.push(r);
      const res = responses.shift();
      if (!res) throw new Error("no response");
      return res;
    },
    sleep: async (ms) => void waits.push(ms),
  });
  return { e, audio, requests, waits };
}

beforeAll(() => {
  URL.createObjectURL ??= () => `blob:${Math.random()}`;
  URL.revokeObjectURL ??= () => undefined;
});

describe("Gemini helpers", () => {
  it("maps API errors", () => {
    expect(geminiErrorCode(400, '{"reason":"API_KEY_INVALID"}')).toBe("auth");
    expect(geminiErrorCode(400, "User location is not supported for the API use.")).toBe("location");
    expect(geminiErrorCode(403, "SERVICE_DISABLED")).toBe("api-disabled");
    expect(geminiErrorCode(404)).toBe("model");
    expect(geminiErrorCode(429, "GenerateRequestsPerDayPerProjectPerModel-FreeTier")).toBe("quota");
    expect(geminiErrorCode(429, "PerMinute")).toBe("throttled");
    expect(geminiErrorCode(503)).toBe("server");
    expect(geminiRetryDelayMs('{"@type":"RetryInfo","retryDelay": "23s"}')).toBe(23000);
    expect(geminiRetryDelayMs("{}")).toBeUndefined();
  });

  it("wraps PCM in a WAV header", async () => {
    const wav = pcmToWav(new Uint8Array(100), RATE);
    expect(wav.size).toBe(144);
    const head = new DataView(await wav.arrayBuffer());
    expect(head.getUint32(24, true)).toBe(RATE);
    expect(head.getUint32(40, true)).toBe(100);
  });

  it("snaps paragraph starts to pauses in the audio", () => {
    // Equal texts, unequal speech: the estimate (1/3, 2/3) moves to the real gaps.
    const samples = pcm([1, 3, 1]);
    const total = samples.length / RATE; // 6 s
    const bounds = paragraphBounds(["一二三四五六", "一二三四五六", "一二三四五六"], samples, RATE);
    expect(bounds[0]).toBe(0);
    expect(bounds[3]).toBe(1);
    expect(bounds[1] * total).toBeCloseTo(1.25, 1);
    expect(bounds[2] * total).toBeCloseTo(4.75, 1);
  });

  it("times paragraphs by speaking time, so long pauses inside one don't shift the rest", () => {
    // Six equal paragraphs of 3 s speech; the first two also pause 2 s halfway.
    const parts: number[] = [];
    const add = (sec: number, loud: boolean) => {
      for (let k = 0; k < sec * RATE; k++) parts.push(loud ? Math.round(8000 * Math.sin(k / 6)) : 0);
    };
    for (let i = 0; i < 6; i++) {
      if (i) add(0.6, false);
      add(1.5, true);
      if (i < 2) add(2, false);
      add(1.5, true);
    }
    const samples = Int16Array.from(parts);
    const total = samples.length / RATE; // 25 s
    const bounds = paragraphBounds(Array(6).fill("一二三四五六"), samples, RATE);
    // Each start is just before its paragraph's speech (which starts at the end of the gap).
    [5.6, 11.2, 14.8, 18.4, 22].forEach((start, i) => {
      expect(Math.abs(bounds[i + 1] * total - (start - 0.25))).toBeLessThan(0.1);
    });
  });

  it("sends diagrams and symbols as plain text, without the symbols", () => {
    const texts = ["特别考试 配置", "④A班 → ①B班", "↑ ↓", "③D班 ← ②C班", "※注意事项★"];
    expect(speakableText(texts)).toBe("特别考试 配置\n\n4A班 1B班\n\n3D班 2C班\n\n注意事项");
    expect(speakableText(["……", "——"])).toBe("……\n\n——");
  });

  it("estimates by text length without audio", () => {
    const b = paragraphBounds(["一二三", "一二三"]);
    expect(b[1]).toBeCloseTo(0.5);
  });
});

describe("GeminiSpeechEngine", () => {
  const book = BOOK;
  const at = (page: number, para: number) => ({ rate: 1.2, paragraphId: `${page}:${para}` });

  it("generates a page per request and plays its paragraphs from the same audio", async () => {
    const { e, audio, requests } = engine([1, 2, 3].map(() => audioResponse(pcm([1, 1, 1]))), undefined, 4);
    const first = e.speak(book[0][0], at(0, 0));
    await flush();
    const body = JSON.parse(requests[0].body as string);
    expect(body.contents[0].parts[0].text).toBe(book[0].join("\n\n"));
    expect(body.generationConfig.speechConfig.voiceConfig.prebuiltVoiceConfig.voiceName).toBe("Kore");
    expect(audio.paused).toBe(false);
    expect(audio.playbackRate).toBe(1.2);

    audio.at(0.5);
    audio.at(1.6);
    await expect(first).resolves.toBe("done");
    expect(audio.paused).toBe(false); // keeps running into the next paragraph

    const second = e.speak(book[0][1], at(0, 1));
    await flush();
    audio.at(3.1);
    await expect(second).resolves.toBe("done");

    const third = e.speak(book[0][2], at(0, 2));
    await flush();
    audio.end();
    await expect(third).resolves.toBe("done");
    expect(audio.sources).toHaveLength(1);
    e.stop();
  });

  it("generates the following pages ahead", async () => {
    const { e, requests } = engine([1, 2, 3].map(() => audioResponse(pcm([1]))));
    const p = e.speak(book[0][0], at(0, 0));
    for (let i = 0; i < 5; i++) await flush();
    expect(requests.map((r) => JSON.parse(r.body as string).contents[0].parts[0].text)).toEqual(
      book.map((page) => page.join("\n\n")),
    );
    e.stop();
    await p;
  });

  it("reuses a stored page wherever reading starts", async () => {
    const store = new MemorySegmentStore();
    const a = engine([1, 2, 3].map(() => audioResponse(pcm([1, 1, 1]))), store, 4);
    const p = a.e.speak(book[0][0], at(0, 0));
    for (let i = 0; i < 5; i++) await flush();
    a.e.stop();
    await expect(p).resolves.toBe("cancelled");

    const b = engine([audioResponse(pcm([1]))], store, 4);
    const q = b.e.speak(book[0][1], at(0, 1));
    await flush();
    expect(b.requests).toHaveLength(0);
    expect(b.audio.currentTime).toBeGreaterThan(1); // started at the second paragraph
    b.e.stop();
    await expect(q).resolves.toBe("cancelled");
  });

  it("splits a long page the same way every time", () => {
    const page = Array.from({ length: 10 }, (_, i) => `${i}`.repeat(500));
    const parts = splitPage(page, 2000);
    expect(parts.map((p) => p.length)).toEqual([3, 4, 3]);
    expect(parts.flat()).toEqual(page);
    expect(splitPage(["短"], 2000)).toEqual([["短"]]);
    expect(splitPage([], 2000)).toEqual([]);
  });

  it("generates text without page information on its own (voice sample)", async () => {
    const { e, requests } = engine([audioResponse(pcm([1]))]);
    const p = e.speak("试听。", { rate: 1 });
    await flush();
    expect(JSON.parse(requests[0].body as string).contents[0].parts[0].text).toBe("试听。");
    e.stop();
    await p;
  });

  it("waits and retries when throttled", async () => {
    const { e, requests, waits } = engine([
      json(429, { error: { details: [{ retryDelay: "7s" }] } }),
      audioResponse(pcm([1])),
    ]);
    const p = e.speak("你好。", { rate: 1 });
    await flush();
    await flush();
    expect(requests).toHaveLength(2);
    expect(waits).toEqual([7000]);
    e.stop();
    await p;
  });

  it("reports a daily quota error", async () => {
    const { e } = engine([json(429, { error: { message: "GenerateRequestsPerDayPerProjectPerModel-FreeTier" } })]);
    await expect(e.speak("你好。", { rate: 1 })).rejects.toMatchObject({ code: "quota" });
  });
});

describe("Gemini settings", () => {
  it("sanitizes Gemini options", () => {
    const s = sanitizeSettings({
      ...DEFAULT_SETTINGS,
      ttsEngine: "gemini",
      geminiModel: "bad model!",
      geminiAhead: 3,
    });
    expect(s.ttsEngine).toBe("gemini");
    expect(s.geminiModel).toBe(DEFAULT_SETTINGS.geminiModel);
    expect(s.geminiAhead).toBe(DEFAULT_SETTINGS.geminiAhead);
  });
});
