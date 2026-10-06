import { describe, expect, it } from "vitest";
import {
  AzureSpeechEngine,
  AzureUsageMeter,
  azureRate,
  billableChars,
  buildSsml,
  listAzureChineseVoices,
} from "../src/speech/AzureSpeechEngine";
import { FallbackSpeechEngine } from "../src/speech/FallbackSpeechEngine";
import { SpeechEngineError, type SpeechEngine } from "../src/speech/SpeechEngine";
import type { HttpRequest, HttpResponse } from "../src/utils/http";
import { SecretStore, MemoryStore, SettingsStore } from "../src/reader/ProgressStore";

const enc = (s: string) => new TextEncoder().encode(s).buffer as ArrayBuffer;
const ok = (body = "mp3"): HttpResponse => ({ status: 200, headers: {}, body: enc(body) });
const fail = (status: number): HttpResponse => ({ status, headers: {}, body: enc("err") });
const cfg = { key: "k", region: "eastasia", voice: "zh-CN-XiaoxiaoNeural" };

/** Minimal HTMLAudioElement stand-in: play() succeeds and "ends" on the next tick. */
class FakeAudio {
  paused = true;
  ended = false;
  src = "";
  preload = "";
  plays: string[] = [];
  private listeners: Record<string, (() => void)[]> = {};
  addEventListener(ev: string, fn: () => void) {
    (this.listeners[ev] ??= []).push(fn);
  }
  removeEventListener(ev: string, fn: () => void) {
    this.listeners[ev] = (this.listeners[ev] ?? []).filter((f) => f !== fn);
  }
  play() {
    this.paused = false;
    this.plays.push(this.src);
    setTimeout(() => {
      this.paused = true;
      this.ended = true;
      this.listeners.ended?.forEach((f) => f());
    }, 0);
    return Promise.resolve();
  }
  pause() {
    this.paused = true;
  }
}

function engine(responses: HttpResponse[], onUsage?: (n: number) => void) {
  const requests: HttpRequest[] = [];
  const audio = new FakeAudio();
  const e = new AzureSpeechEngine(() => cfg, {
    audio: audio as unknown as HTMLAudioElement,
    request: async (r) => {
      requests.push(r);
      const res = responses.shift();
      if (!res) throw new Error("no response");
      return res;
    },
    onUsage,
    sleep: async () => undefined,
  });
  return { e, requests, audio };
}

describe("Azure SSML", () => {
  it("escapes text and sets voice, language and rate", () => {
    const ssml = buildSsml("「你好」<b>&", "zh-CN-YunxiNeural", 1.2);
    expect(ssml).toContain('xml:lang="zh-CN"');
    expect(ssml).toContain('<voice name="zh-CN-YunxiNeural">');
    expect(ssml).toContain('<prosody rate="+20%">「你好」&lt;b&gt;&amp;</prosody>');
  });

  it("formats relative rates", () => {
    expect(azureRate(1)).toBe("+0%");
    expect(azureRate(0.85)).toBe("-15%");
    expect(azureRate(1.35)).toBe("+35%");
  });

  it("counts CJK characters twice like Azure billing", () => {
    expect(billableChars("你好ab，")).toBe(2 + 2 + 1 + 1 + 2);
  });
});

describe("AzureSpeechEngine", () => {
  it("synthesizes, plays and reports usage", async () => {
    let used = 0;
    const { e, requests, audio } = engine([ok()], (n) => (used += n));
    await expect(e.speak("你好", { rate: 1 })).resolves.toBe("done");
    expect(requests[0].url).toBe("https://eastasia.tts.speech.microsoft.com/cognitiveservices/v1");
    expect(requests[0].headers?.["Ocp-Apim-Subscription-Key"]).toBe("k");
    expect(requests[0].headers?.["X-Microsoft-OutputFormat"]).toMatch(/mp3/);
    expect(audio.plays).toHaveLength(1);
    expect(used).toBe(4);
  });

  it("reuses prefetched audio instead of requesting again", async () => {
    const { e, requests } = engine([ok()]);
    e.prefetch("下一句", { rate: 1 });
    await e.speak("下一句", { rate: 1 });
    expect(requests).toHaveLength(1);
  });

  it("maps auth and quota failures", async () => {
    await expect(engine([fail(401)]).e.speak("a", { rate: 1 })).rejects.toMatchObject({ code: "auth" });
    await expect(engine([fail(403)]).e.speak("a", { rate: 1 })).rejects.toMatchObject({ code: "quota" });
    // 429 is retried once before giving up.
    const throttled = engine([fail(429), ok()]);
    await expect(throttled.e.speak("a", { rate: 1 })).resolves.toBe("done");
    await expect(engine([fail(429), fail(429)]).e.speak("a", { rate: 1 })).rejects.toMatchObject({ code: "quota" });
  });

  it("fails with config when no key is set", async () => {
    const e = new AzureSpeechEngine(() => undefined, { audio: new FakeAudio() as unknown as HTMLAudioElement });
    await expect(e.speak("a", { rate: 1 })).rejects.toMatchObject({ code: "config" });
  });

  it("resolves cancelled when stopped during synthesis", async () => {
    let release!: (r: HttpResponse) => void;
    const audio = new FakeAudio();
    const e = new AzureSpeechEngine(() => cfg, {
      audio: audio as unknown as HTMLAudioElement,
      request: () => new Promise((r) => (release = r)),
    });
    const p = e.speak("a", { rate: 1 });
    e.stop();
    release(ok());
    await expect(p).resolves.toBe("cancelled");
    expect(audio.plays).toHaveLength(0);
  });

  it("lists Chinese voices, Mainland first", async () => {
    const voices = await listAzureChineseVoices({ key: "k", region: "eastasia" }, async () => ({
      status: 200,
      headers: {},
      body: enc(
        JSON.stringify([
          { ShortName: "en-US-JennyNeural", LocalName: "Jenny", Gender: "Female", Locale: "en-US" },
          { ShortName: "zh-TW-HsiaoChenNeural", LocalName: "曉臻", Gender: "Female", Locale: "zh-TW" },
          { ShortName: "zh-CN-YunxiNeural", LocalName: "云希", Gender: "Male", Locale: "zh-CN" },
        ]),
      ),
    }));
    expect(voices.map((v) => v.shortName)).toEqual(["zh-CN-YunxiNeural", "zh-TW-HsiaoChenNeural"]);
    expect(voices[0].label).toBe("云希（男，zh-CN）");
  });
});

describe("FallbackSpeechEngine", () => {
  const stub = (impl: () => Promise<"done" | "cancelled">, spoken: string[], name: string): SpeechEngine => ({
    unlock() {},
    speak: (t) => (spoken.push(`${name}:${t}`), impl()),
    pause() {},
    resume() {},
    stop() {},
    speaking: false,
  });

  it("switches to the secondary engine on quota errors and stays there", async () => {
    const spoken: string[] = [];
    const reasons: string[] = [];
    const primary = stub(() => Promise.reject(new SpeechEngineError("quota")), spoken, "azure");
    const secondary = stub(() => Promise.resolve("done"), spoken, "web");
    const f = new FallbackSpeechEngine(primary, secondary, (c) => reasons.push(c));
    await f.speak("一", { rate: 1 });
    await f.speak("二", { rate: 1 });
    expect(spoken).toEqual(["azure:一", "web:一", "web:二"]);
    expect(reasons).toEqual(["quota"]);
    f.reset();
    expect(f.usingFallback).toBe(false);
  });

  it("does not fall back on user-gesture errors", async () => {
    const spoken: string[] = [];
    const f = new FallbackSpeechEngine(
      stub(() => Promise.reject(new SpeechEngineError("not-allowed")), spoken, "azure"),
      stub(() => Promise.resolve("done"), spoken, "web"),
    );
    await expect(f.speak("一", { rate: 1 })).rejects.toMatchObject({ code: "not-allowed" });
  });
});

describe("storage", () => {
  it("keeps secrets in GM storage when available", async () => {
    const data = new Map<string, unknown>();
    const gm = {
      getValue: async (k: string, d?: unknown) => (data.has(k) ? data.get(k) : d),
      setValue: async (k: string, v: unknown) => void data.set(k, v),
    };
    const fallback = new MemoryStore();
    const store = new SecretStore(gm, fallback);
    await store.set("key", "secret");
    expect(await store.get("key")).toBe("secret");
    expect(await fallback.get("key")).toBeNull();
  });

  it("falls back to the KV store without GM", async () => {
    const store = new SecretStore(undefined, new MemoryStore());
    await store.set("key", "s");
    expect(await store.get("key")).toBe("s");
  });

  it("sanitises Azure settings", async () => {
    const kv = new MemoryStore();
    await kv.set("biliReader.settings", JSON.stringify({ ttsEngine: "azure", azureRegion: "East Asia!", azureVoice: "<x>" }));
    const s = await new SettingsStore(kv).load();
    expect(s.ttsEngine).toBe("azure");
    expect(s.azureRegion).toBe("eastasia");
    expect(s.azureVoice).toBe("zh-CN-XiaoxiaoNeural");
  });

  it("tracks monthly usage", () => {
    const m = new AzureUsageMeter(globalThis.localStorage);
    globalThis.localStorage.removeItem(AzureUsageMeter.KEY);
    expect(m.add(10)).toBe(10);
    expect(m.add(5)).toBe(15);
    globalThis.localStorage.setItem(AzureUsageMeter.KEY, JSON.stringify({ month: "1999-01", chars: 99 }));
    expect(m.get()).toBe(0);
  });
});
