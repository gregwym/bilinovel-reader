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
import { NetworkError, type HttpRequest, type HttpResponse } from "../src/utils/http";
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
    e.prefetch(["下一句"], { rate: 1 });
    await e.speak("下一句", { rate: 1 });
    expect(requests).toHaveLength(1);
  });

  it("maps auth and quota failures", async () => {
    await expect(engine([fail(401)]).e.speak("a", { rate: 1 })).rejects.toMatchObject({ code: "auth" });
    await expect(engine([fail(403)]).e.speak("a", { rate: 1 })).rejects.toMatchObject({ code: "quota" });
    // Throttling is retried before giving up.
    const throttled = engine([fail(429), ok()]);
    await expect(throttled.e.speak("a", { rate: 1 })).resolves.toBe("done");
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

describe("FallbackSpeechEngine (circuit breaker)", () => {
  const stub = (impl: () => Promise<"done" | "cancelled">, spoken: string[], name: string): SpeechEngine => ({
    unlock() {},
    speak: (t) => (spoken.push(`${name}:${t}`), impl()),
    pause() {},
    resume() {},
    stop() {},
    speaking: false,
  });

  function setup(errors: (string | null)[]) {
    let now = 0;
    const spoken: string[] = [];
    const events: string[] = [];
    const primary = stub(() => {
      const e = errors.shift();
      return e ? Promise.reject(new SpeechEngineError(e)) : Promise.resolve("done");
    }, spoken, "azure");
    const secondary = stub(() => Promise.resolve("done"), spoken, "web");
    const f = new FallbackSpeechEngine(
      primary,
      secondary,
      { onFallback: (c, at) => events.push(`fallback:${c}:${at}`), onRecover: () => events.push("recover") },
      () => now,
    );
    return { f, spoken, events, advance: (ms: number) => (now += ms) };
  }

  it("a transient error only affects that utterance's engine until a short cooldown", async () => {
    const { f, spoken, events, advance } = setup(["network", null]);
    await f.speak("一", { rate: 1 });
    await f.speak("二", { rate: 1 }); // still cooling down
    advance(20_001);
    await f.speak("三", { rate: 1 }); // primary again, succeeds
    expect(spoken).toEqual(["azure:一", "web:一", "web:二", "azure:三"]);
    expect(events).toEqual(["fallback:network:20000", "recover"]);
    expect(f.usingFallback).toBe(false);
  });

  it("backs off longer on repeated transient failures", async () => {
    const { f, events, advance } = setup(["server", "server"]);
    await f.speak("一", { rate: 1 });
    advance(20_001);
    await f.speak("二", { rate: 1 });
    expect(events[1]).toBe(`fallback:server:${20_001 + 40_000}`);
  });

  it("waits 30 minutes after quota errors and for a reset after auth errors", async () => {
    const q = setup(["quota"]);
    await q.f.speak("一", { rate: 1 });
    expect(q.events[0]).toBe(`fallback:quota:${30 * 60_000}`);

    const a = setup(["auth", null]);
    await a.f.speak("一", { rate: 1 });
    a.advance(24 * 3600_000);
    await a.f.speak("二", { rate: 1 });
    expect(a.spoken).toEqual(["azure:一", "web:一", "web:二"]);
    a.f.reset();
    await a.f.speak("三", { rate: 1 });
    expect(a.spoken.at(-1)).toBe("azure:三");
  });

  it("does not fall back on user-gesture errors", async () => {
    const { f } = setup(["not-allowed"]);
    await expect(f.speak("一", { rate: 1 })).rejects.toMatchObject({ code: "not-allowed" });
  });

  it("only prefetches while the primary is in use", async () => {
    const got: string[][] = [];
    const { f } = setup(["network"]);
    (f as unknown as { primary: SpeechEngine }).primary.prefetch = (t: string[]) => void got.push(t);
    f.prefetch(["a"], { rate: 1 });
    await f.speak("一", { rate: 1 });
    f.prefetch(["b"], { rate: 1 });
    expect(got).toEqual([["a"]]);
  });
});

describe("Azure error handling", () => {
  it("retries network failures with backoff before failing", async () => {
    let calls = 0;
    const e = new AzureSpeechEngine(() => cfg, {
      audio: new FakeAudio() as unknown as HTMLAudioElement,
      sleep: async () => undefined,
      request: async () => {
        calls++;
        if (calls < 3) throw new NetworkError("offline");
        return ok();
      },
    });
    await expect(e.speak("a", { rate: 1 })).resolves.toBe("done");
    expect(calls).toBe(3);
  });

  it("distinguishes throttling from an exhausted quota", async () => {
    const quotaBody: HttpResponse = { status: 429, headers: {}, body: enc("Quota exceeded") };
    await expect(engine([quotaBody]).e.speak("a", { rate: 1 })).rejects.toMatchObject({ code: "quota" });
    await expect(engine([fail(429), fail(429), fail(429)]).e.speak("a", { rate: 1 })).rejects.toMatchObject({
      code: "throttled",
    });
    await expect(engine([fail(503), fail(503), fail(503)]).e.speak("a", { rate: 1 })).rejects.toMatchObject({
      code: "server",
    });
  });

  it("synthesizes up to N upcoming chunks ahead, two at a time", async () => {
    let inFlight = 0;
    let peak = 0;
    const urls: string[] = [];
    const e = new AzureSpeechEngine(() => cfg, {
      audio: new FakeAudio() as unknown as HTMLAudioElement,
      request: async (r) => {
        urls.push(r.body!);
        inFlight++;
        peak = Math.max(peak, inFlight);
        await new Promise((res) => setTimeout(res, 5));
        inFlight--;
        return ok();
      },
    });
    e.setPrefetchCount(3);
    e.prefetch(["一", "二", "三", "四", "五"], { rate: 1 });
    await new Promise((res) => setTimeout(res, 40));
    expect(urls).toHaveLength(3);
    expect(peak).toBe(2);
    // Already buffered: speaking them needs no new request.
    await e.speak("二", { rate: 1 });
    expect(urls).toHaveLength(3);
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
