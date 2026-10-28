import { beforeAll, describe, expect, it } from "vitest";
import {
  FISH_DEFAULT_MODEL,
  FishSpeechEngine,
  FishUsageMeter,
  describeFishError,
  fishErrorCode,
  listFishVoices,
  parseFishVoice,
  type AudioDecoder,
  type FishConfig,
} from "../src/speech/FishSpeechEngine";
import { MemorySegmentStore, segmentKey } from "../src/speech/PageSpeechEngine";
import { DEFAULT_SETTINGS, sanitizeSettings } from "../src/reader/ProgressStore";
import type { HttpRequest, HttpResponse } from "../src/utils/http";

const enc = (s: string) => new TextEncoder().encode(s).buffer as ArrayBuffer;
const json = (status: number, body: unknown): HttpResponse => ({ status, headers: {}, body: enc(JSON.stringify(body)) });
const mp3 = (): HttpResponse => ({ status: 200, headers: { "content-type": "audio/mpeg" }, body: new Uint8Array(64).buffer });
const VOICE = "0123456789abcdef0123456789abcdef";

/** Decoded audio: 1 s of tone per paragraph with 0.5 s pauses between, at 8 kHz. */
const decoder =
  (speech: number[]): AudioDecoder =>
  async () => {
    const rate = 8000;
    const out: number[] = [];
    speech.forEach((sec, i) => {
      for (let k = 0; k < sec * rate; k++) out.push(0.3 * Math.sin(k / 3));
      if (i < speech.length - 1) for (let k = 0; k < 0.5 * rate; k++) out.push(0);
    });
    return { samples: Float32Array.from(out), rate };
  };

class FakeAudio {
  paused = true;
  ended = false;
  preload = "";
  currentTime = 0;
  duration = 4;
  readyState = 0;
  playbackRate = 1;
  defaultPlaybackRate = 1;
  private _src = "";
  get src() {
    return this._src;
  }
  set src(v: string) {
    this._src = v;
    this.currentTime = 0;
    this.readyState = 4;
  }
  private listeners: Record<string, (() => void)[]> = {};
  addEventListener(ev: string, fn: () => void) {
    (this.listeners[ev] ??= []).push(fn);
  }
  removeEventListener(ev: string, fn: () => void) {
    this.listeners[ev] = (this.listeners[ev] ?? []).filter((f) => f !== fn);
  }
  play() {
    this.paused = false;
    return Promise.resolve();
  }
  pause() {
    this.paused = true;
    (this.listeners.pause ?? []).forEach((f) => f());
  }
}

const BOOK = [["第一段。", "第二段。"], ["第三段。"]];
const flush = () => new Promise((r) => setTimeout(r, 0));

function engine(responses: HttpResponse[], cfg: Partial<FishConfig> = {}, decode = decoder([1, 1])) {
  const requests: HttpRequest[] = [];
  const waits: number[] = [];
  const statuses: string[] = [];
  const audio = new FakeAudio();
  const store = new MemorySegmentStore();
  const e = new FishSpeechEngine(() => ({ key: "k", model: FISH_DEFAULT_MODEL, voice: VOICE, ahead: 1, ...cfg }), {
    pages: (id) => {
      const [page, para] = id.split(":").map(Number);
      return { pages: BOOK.slice(page, page + 2), index: para };
    },
    audio: audio as unknown as HTMLAudioElement,
    store,
    usage: new FishUsageMeter(undefined),
    decode,
    request: async (r) => {
      requests.push(r);
      const res = responses.shift();
      if (!res) throw new Error("no response");
      return res;
    },
    sleep: async (ms) => void waits.push(ms),
    onStatus: (msg) => void statuses.push(msg),
  });
  return { e, audio, requests, waits, store, statuses };
}

beforeAll(() => {
  URL.createObjectURL ??= () => `blob:${Math.random()}`;
  URL.revokeObjectURL ??= () => undefined;
});

describe("Fish Audio helpers", () => {
  it("maps API errors", () => {
    expect(fishErrorCode(401)).toBe("auth");
    expect(fishErrorCode(402)).toBe("billing");
    expect(fishErrorCode(404)).toBe("model");
    expect(fishErrorCode(429)).toBe("throttled");
    expect(fishErrorCode(503)).toBe("server");
    expect(describeFishError("billing")).toContain("余额");
  });

  it("reads a voice id from a link or id", () => {
    expect(parseFishVoice(`https://fish.audio/zh-CN/m/${VOICE}/`)).toBe(VOICE);
    expect(parseFishVoice(VOICE.toUpperCase())).toBe(VOICE);
    expect(parseFishVoice("not a voice")).toBeUndefined();
  });

  it("lists the account's and popular Chinese voices", async () => {
    const mine = "11111111111111111111111111111111";
    const requests: HttpRequest[] = [];
    const voices = await listFishVoices("k", async (r) => {
      requests.push(r);
      return r.url.includes("self=true")
        ? json(200, { items: [{ _id: mine, title: "我的声音", type: "tts" }] })
        : json(200, {
            items: [
              { _id: VOICE, title: "旁白", type: "tts", samples: [{ title: "s", text: "t", audio: "https://cdn.fish.audio/s.mp3" }] },
              { _id: mine, title: "重复", type: "tts" },
              { _id: "22222222222222222222222222222222", title: "唱歌", type: "svc" },
            ],
          });
    });
    expect(requests[0].headers?.Authorization).toBe("Bearer k");
    expect(requests.some((r) => r.url.includes("language=zh"))).toBe(true);
    expect(voices.map((v) => [v.shortName, v.label])).toEqual([
      ["", "模型默认声音"],
      [mine, "我的：我的声音"],
      [VOICE, "旁白"],
    ]);
    // The service's own sample recording, for previews without a request.
    expect(voices.find((v) => v.shortName === VOICE)?.sample).toBe("https://cdn.fish.audio/s.mp3");
    expect(voices.find((v) => v.shortName === mine)?.sample).toBeUndefined();
  });

  it("sanitizes Fish Audio settings", () => {
    const s = sanitizeSettings({ ...DEFAULT_SETTINGS, ttsEngine: "fish", fishVoice: "bad", fishModel: "Bad!", fishAhead: 3 });
    expect(s.ttsEngine).toBe("fish");
    expect(s.fishVoice).toBe("");
    expect(s.fishModel).toBe(FISH_DEFAULT_MODEL);
    expect(s.fishAhead).toBe(DEFAULT_SETTINGS.fishAhead);
    expect(sanitizeSettings({ ...DEFAULT_SETTINGS, fishVoice: VOICE }).fishVoice).toBe(VOICE);
  });
});

describe("FishSpeechEngine", () => {
  it("generates a page per request with the model header and voice", async () => {
    const { e, audio, requests } = engine([mp3(), mp3()]);
    const p = e.speak(BOOK[0][0], { rate: 1.1, paragraphId: "0:0" });
    for (let i = 0; i < 5; i++) await flush();
    expect(requests).toHaveLength(2); // this page, then the next one ahead
    const [first] = requests;
    expect(first.url).toBe("https://api.fish.audio/v1/tts");
    expect(first.headers).toMatchObject({ Authorization: "Bearer k", model: FISH_DEFAULT_MODEL });
    const body = JSON.parse(first.body as string);
    expect(body).toMatchObject({ text: BOOK[0].join("\n\n"), reference_id: VOICE, format: "mp3" });
    expect(JSON.parse(requests[1].body as string).text).toBe(BOOK[1][0]);
    expect(audio.paused).toBe(false);
    expect(audio.playbackRate).toBe(1.1);
    e.stop();
    await expect(p).resolves.toBe("cancelled");
  });

  it("says stored audio is loaded, not generated", async () => {
    const { e, requests, store, statuses } = engine([mp3()]);
    const audio = new Blob([new Uint8Array(64)], { type: "audio/mpeg" });
    await store.put({ key: segmentKey(`${FISH_DEFAULT_MODEL}|${VOICE}`, BOOK[0]), texts: BOOK[0], audio, bounds: [0, 0.5] });
    const p = e.speak(BOOK[0][0], { rate: 1, paragraphId: "0:0" });
    for (let i = 0; i < 5; i++) await flush();
    expect(statuses[0]).toBe("Fish Audio 正在载入语音…");
    expect(statuses.some((s) => s.includes("生成"))).toBe(false);
    // Only the page ahead was generated.
    expect(requests).toHaveLength(1);
    e.stop();
    await p;
  });

  it("says audio that isn't stored is generated", async () => {
    const { e, statuses } = engine([mp3(), mp3()]);
    const p = e.speak(BOOK[0][0], { rate: 1, paragraphId: "0:0" });
    for (let i = 0; i < 5; i++) await flush();
    expect(statuses).toContain(`Fish Audio 正在生成约 ${BOOK[0].join("").length} 字的语音，请稍候…`);
    e.stop();
    await p;
  });

  it("starts a later paragraph at the pause before it", async () => {
    const { e, audio } = engine([mp3(), mp3()]);
    const p = e.speak(BOOK[0][1], { rate: 1, paragraphId: "0:1" });
    for (let i = 0; i < 5; i++) await flush();
    // 1 s speech, 0.5 s pause, 1 s speech (2.5 s decoded) on a 4 s element: the pause center is at 1.25/2.5.
    expect(audio.currentTime).toBeCloseTo(2, 1);
    e.stop();
    await p;
  });

  it("leaves out the voice for the model default and falls back to text estimates without decoding", async () => {
    const { e, requests } = engine([mp3()], { voice: "", ahead: 0 }, async () => undefined);
    const p = e.speak("试听。", { rate: 1 });
    await flush();
    expect(JSON.parse(requests[0].body as string).reference_id).toBeUndefined();
    e.stop();
    await p;
  });

  it("waits for Retry-After when throttled", async () => {
    const { e, requests, waits } = engine([{ ...json(429, {}), headers: { "retry-after": "5" } }, mp3()], { ahead: 0 });
    const p = e.speak("你好。", { rate: 1 });
    for (let i = 0; i < 3; i++) await flush();
    expect(requests).toHaveLength(2);
    expect(waits).toEqual([5000]);
    e.stop();
    await p;
  });

  it("reports an empty balance", async () => {
    const { e } = engine([json(402, { message: "Insufficient balance" })], { ahead: 0 });
    await expect(e.speak("你好。", { rate: 1 })).rejects.toMatchObject({ code: "billing" });
  });
});
