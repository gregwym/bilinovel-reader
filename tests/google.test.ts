import { beforeEach, describe, expect, it } from "vitest";
import {
  GoogleSpeechEngine,
  GoogleUsageMeter,
  googleErrorCode,
  googleLanguageCode,
  googleTier,
  listGoogleChineseVoices,
} from "../src/speech/GoogleSpeechEngine";
import { AzureSpeechEngine } from "../src/speech/AzureSpeechEngine";
import { MemoryStore, SettingsStore } from "../src/reader/ProgressStore";
import type { HttpRequest, HttpResponse } from "../src/utils/http";

const enc = (s: string) => new TextEncoder().encode(s).buffer as ArrayBuffer;
const json = (status: number, body: unknown): HttpResponse => ({ status, headers: {}, body: enc(JSON.stringify(body)) });
const audioOk = () => json(200, { audioContent: btoa("mp3") });

/** HTMLAudioElement stand-in with real-ish pause/ended events. */
class FakeAudio {
  paused = true;
  ended = false;
  src = "";
  preload = "";
  plays: string[] = [];
  autoEnd = true;
  private listeners: Record<string, (() => void)[]> = {};
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
    this.plays.push(this.src);
    if (this.autoEnd) {
      setTimeout(() => {
        this.paused = true;
        this.ended = true;
        this.emit("pause"); // browsers fire "pause" right before "ended"
        this.emit("ended");
      }, 0);
    }
    return Promise.resolve();
  }
  pause() {
    if (this.paused) return;
    this.paused = true;
    setTimeout(() => this.emit("pause"), 0);
  }
}

function storage(): Storage {
  const m = new Map<string, string>();
  return {
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => void m.set(k, v),
    removeItem: (k: string) => void m.delete(k),
    clear: () => m.clear(),
    key: () => null,
    length: 0,
  } as Storage;
}

function engine(responses: HttpResponse[], voice = "cmn-CN-Chirp3-HD-Aoede", meter = new GoogleUsageMeter(storage())) {
  const requests: HttpRequest[] = [];
  const audio = new FakeAudio();
  const e = new GoogleSpeechEngine(() => ({ key: "gk", voice }), {
    audio: audio as unknown as HTMLAudioElement,
    meter,
    request: async (r) => {
      requests.push(r);
      const res = responses.shift();
      if (!res) throw new Error("no response");
      return res;
    },
    sleep: async () => undefined,
  });
  return { e, requests, audio, meter };
}

describe("Google voices", () => {
  it("derives tier and language from the voice name", () => {
    expect(googleTier("cmn-CN-Chirp3-HD-Aoede")).toBe("chirp3-hd");
    expect(googleTier("cmn-CN-Wavenet-A")).toBe("wavenet");
    expect(googleTier("cmn-CN-Standard-B")).toBe("standard");
    expect(googleTier("en-US-Studio-O")).toBeUndefined();
    expect(googleLanguageCode("cmn-CN-Chirp3-HD-Aoede")).toBe("cmn-CN");
  });

  it("lists Chinese voices with a free allowance, best first", async () => {
    const voices = await listGoogleChineseVoices("gk", async () =>
      json(200, {
        voices: [
          { name: "en-US-Wavenet-A", languageCodes: ["en-US"], ssmlGender: "FEMALE" },
          { name: "cmn-CN-Standard-A", languageCodes: ["cmn-CN"], ssmlGender: "FEMALE" },
          { name: "cmn-CN-Studio-X", languageCodes: ["cmn-CN"], ssmlGender: "FEMALE" },
          { name: "cmn-CN-Chirp3-HD-Charon", languageCodes: ["cmn-CN"], ssmlGender: "MALE" },
          { name: "cmn-TW-Wavenet-A", languageCodes: ["cmn-TW"], ssmlGender: "FEMALE" },
        ],
      }),
    );
    expect(voices.map((v) => v.shortName)).toEqual(["cmn-CN-Chirp3-HD-Charon", "cmn-CN-Standard-A", "cmn-TW-Wavenet-A"]);
    expect(voices[0].label).toBe("Chirp3-HD-Charon（男，Chirp 3 HD）");
  });

  it("maps errors", () => {
    expect(googleErrorCode(400, "API key not valid. Please pass a valid API key.")).toBe("auth");
    expect(googleErrorCode(400, "Invalid voice")).toBe("bad-request");
    expect(googleErrorCode(403, "This API method requires billing to be enabled")).toBe("billing");
    expect(googleErrorCode(403, "Cloud Text-to-Speech API has not been used in project 1 before or it is disabled")).toBe(
      "api-disabled",
    );
    expect(googleErrorCode(429)).toBe("throttled");
    expect(googleErrorCode(503)).toBe("server");
  });
});

describe("GoogleSpeechEngine", () => {
  it("synthesizes with the API key header and meters usage per voice type", async () => {
    const { e, requests, audio, meter } = engine([audioOk()]);
    await expect(e.speak("你好，世界", { rate: 1.2 })).resolves.toBe("done");
    const req = requests[0];
    expect(req.url).toBe("https://texttospeech.googleapis.com/v1/text:synthesize");
    expect(req.headers?.["X-Goog-Api-Key"]).toBe("gk");
    expect(JSON.parse(req.body!)).toEqual({
      input: { text: "你好，世界" },
      voice: { languageCode: "cmn-CN", name: "cmn-CN-Chirp3-HD-Aoede" },
      audioConfig: { audioEncoding: "MP3", speakingRate: 1.2 },
    });
    expect(audio.plays).toHaveLength(1);
    expect(meter.get("chirp3-hd")).toBe(5);
    expect(meter.get("wavenet")).toBe(0);
  });

  it("retries without speakingRate if the voice rejects it", async () => {
    const { e, requests } = engine([json(400, { error: { message: "speaking_rate is not supported" } }), audioOk(), audioOk()]);
    await e.speak("一", { rate: 1.5 });
    await e.speak("二", { rate: 1.5 });
    expect(JSON.parse(requests[0].body!).audioConfig.speakingRate).toBe(1.5);
    expect(JSON.parse(requests[1].body!).audioConfig.speakingRate).toBeUndefined();
    expect(JSON.parse(requests[2].body!).audioConfig.speakingRate).toBeUndefined();
  });

  it("stops at the monthly free allowance instead of billing", async () => {
    const meter = new GoogleUsageMeter(storage());
    meter.add("chirp3-hd", 1_000_000 - 2);
    const { e, requests } = engine([audioOk()], undefined, meter);
    await expect(e.speak("你好世界", { rate: 1 })).rejects.toMatchObject({ code: "quota" });
    expect(requests).toHaveLength(0);
    // Other voice types have their own allowance.
    const other = engine([audioOk()], "cmn-CN-Wavenet-A", meter);
    await expect(other.e.speak("你好世界", { rate: 1 })).resolves.toBe("done");
  });

  it("refuses voice types without a free allowance", async () => {
    const { e, requests } = engine([audioOk()], "cmn-CN-Studio-X");
    await expect(e.speak("你好", { rate: 1 })).rejects.toMatchObject({ code: "quota" });
    expect(requests).toHaveLength(0);
  });

  it("fails with config when no key is set", async () => {
    const e = new GoogleSpeechEngine(() => undefined, { audio: new FakeAudio() as unknown as HTMLAudioElement });
    await expect(e.speak("a", { rate: 1 })).rejects.toMatchObject({ code: "config" });
  });
});

describe("cloud audio interruptions", () => {
  let audio: FakeAudio;
  let e: AzureSpeechEngine;
  beforeEach(() => {
    audio = new FakeAudio();
    audio.autoEnd = false;
    e = new AzureSpeechEngine(() => ({ key: "k", region: "eastasia", voice: "v" }), {
      audio: audio as unknown as HTMLAudioElement,
      request: async () => ({ status: 200, headers: {}, body: enc("mp3") }),
    });
  });

  it("reports a system pause (call, other audio, headphones) as cancelled", async () => {
    const p = e.speak("一", { rate: 1 });
    await new Promise((r) => setTimeout(r, 0));
    audio.pause(); // not via the engine
    await expect(p).resolves.toBe("cancelled");
  });

  it("ignores the pause event from stopping the previous chunk", async () => {
    const first = e.speak("一", { rate: 1 });
    await new Promise((r) => setTimeout(r, 0));
    const second = e.speak("二", { rate: 1 }); // stops the first; its "pause" event arrives later
    await expect(first).resolves.toBe("cancelled");
    let settled = false;
    void second.then(() => (settled = true));
    await new Promise((r) => setTimeout(r, 10));
    expect(settled).toBe(false);
    expect(audio.paused).toBe(false);
  });
});

describe("settings", () => {
  it("keeps the Google engine and sanitises its voice", async () => {
    const kv = new MemoryStore();
    await kv.set("biliReader.settings", JSON.stringify({ ttsEngine: "google", googleVoice: "<x>" }));
    const s = await new SettingsStore(kv).load();
    expect(s.ttsEngine).toBe("google");
    expect(s.googleVoice).toBe("cmn-CN-Chirp3-HD-Aoede");
  });
});
