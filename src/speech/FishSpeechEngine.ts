import { bodyText, httpRequest, NetworkError, type HttpRequest, type HttpResponse } from "../utils/http";
import { log } from "../utils/log";
import { SpeechEngineError } from "./SpeechEngine";
import type { AzureVoice } from "./AzureSpeechEngine";
import {
  DailyUsageMeter,
  PageSpeechEngine,
  defaultSegmentStore,
  paragraphBounds,
  speakableText,
  type BackendIO,
  type PageBackend,
  type PageEngineOptions,
  type Rendered,
} from "./PageSpeechEngine";

/**
 * Fish Audio text to speech:
 *   POST https://api.fish.audio/v1/tts   (header `model: <model>`)
 *
 * Generated a site page at a time like Gemini (see PageSpeechEngine). The
 * `s2.1-pro-free` model costs nothing (fair use) until 2026-11-30; the other
 * models are billed per UTF-8 byte (about 3 per Chinese character).
 */

export const FISH_API_BASE = "https://api.fish.audio";
export const FISH_DEFAULT_MODEL = "s2.1-pro-free";
export const FISH_MODELS: [string, string][] = [
  ["s2.1-pro-free", "S2.1 Pro Free（免费，至 2026-11-30）"],
  ["s2.1-pro", "S2.1 Pro（付费）"],
  ["drama-3", "Drama 3（付费）"],
  ["s2-pro", "S2 Pro（付费）"],
];
/** Characters per request: smaller than Gemini's so the first page starts sooner. */
export const FISH_MAX_CHARS = 1000;
/** A voice model id (`reference_id`), as in fish.audio/m/<id>. */
export const FISH_VOICE_ID = /^[0-9a-f]{32}$/;

export interface FishConfig {
  key: string;
  model: string;
  /** Voice model id; empty for the model's default voice. */
  voice: string;
  ahead: number;
}

/** Voice id from a pasted id or fish.audio link, or undefined. */
export function parseFishVoice(input: string): string | undefined {
  return /(?:^|[^0-9a-f])([0-9a-f]{32})(?![0-9a-f])/i.exec(input.trim())?.[1]?.toLowerCase();
}

// ---------------------------------------------------------------------------
// Errors

export function fishErrorCode(status: number): string {
  if (status === 401) return "auth";
  if (status === 402) return "billing";
  if (status === 403) return "forbidden";
  if (status === 404) return "model";
  if (status === 400 || status === 422) return "bad-request";
  if (status === 429) return "throttled";
  if (status >= 500) return "server";
  return `http-${status}`;
}

export function describeFishError(code: string): string {
  switch (code) {
    case "config":
      return "未设置 Fish Audio 密钥";
    case "auth":
      return "Fish Audio 密钥不正确";
    case "billing":
      return "Fish Audio 余额不足（付费模型）";
    case "forbidden":
      return "Fish Audio 拒绝了请求（无权使用该模型或声音）";
    case "model":
      return "该 Fish Audio 模型或声音不存在";
    case "throttled":
      return "Fish Audio 请求过于频繁";
    case "server":
      return "Fish Audio 服务暂时出错";
    case "network":
      return "无法连接 Fish Audio";
    case "bad-request":
      return "Fish Audio 不接受该请求";
    case "empty":
      return "Fish Audio 没有返回语音";
    case "audio-error":
      return "音频播放出错";
    case "not-allowed":
      return "需要点击 ▶ 才能播放音频";
    default:
      return `Fish Audio 错误（${code}）`;
  }
}

// ---------------------------------------------------------------------------
// Voices

/** Popular Chinese voices and the account's own; throws SpeechEngineError on failure. */
export async function listFishVoices(
  key: string,
  request: (req: HttpRequest) => Promise<HttpResponse> = httpRequest,
): Promise<AzureVoice[]> {
  type Item = { _id: string; title: string; type?: string; samples?: { audio?: string }[] };
  const get = async (query: string): Promise<Item[]> => {
    let res: HttpResponse;
    try {
      res = await request({
        method: "GET",
        url: `${FISH_API_BASE}/model?${query}`,
        headers: { Authorization: `Bearer ${key}` },
        timeoutMs: 20_000,
      });
    } catch {
      throw new SpeechEngineError("network");
    }
    if (res.status < 200 || res.status >= 300) throw new SpeechEngineError(fishErrorCode(res.status));
    return (JSON.parse(bodyText(res)) as { items?: Item[] }).items ?? [];
  };
  const [mine, popular] = await Promise.all([
    get("self=true&page_size=20&sort_by=created_at").catch(() => [] as Item[]),
    get("language=zh&page_size=40&sort_by=task_count"),
  ]);
  const out: AzureVoice[] = [{ shortName: "", label: "模型默认声音", locale: "" }];
  const seen = new Set<string>();
  const add = (items: Item[], prefix: string) => {
    for (const i of items) {
      // Skip singing-voice models and anything that isn't a plain id.
      if (i.type === "svc" || !FISH_VOICE_ID.test(i._id) || seen.has(i._id)) continue;
      seen.add(i._id);
      const sample = i.samples?.find((s) => typeof s.audio === "string" && /^https:\/\//.test(s.audio))?.audio;
      out.push({ shortName: i._id, label: `${prefix}${i.title}`, locale: "", ...(sample ? { sample } : {}) });
    }
  };
  add(mine, "我的：");
  add(popular, "");
  return out;
}

// ---------------------------------------------------------------------------
// Engine

const REQUEST_TIMEOUT_MS = 5 * 60_000;

export class FishUsageMeter extends DailyUsageMeter {
  static readonly KEY = "biliReader.fishUsage";

  constructor(storage: Storage | undefined = globalThis.localStorage) {
    super(FishUsageMeter.KEY, storage);
  }
}

/** Decoded mono samples of an audio file, for finding pauses; undefined if the browser can't decode it. */
export type AudioDecoder = (data: ArrayBuffer) => Promise<{ samples: Float32Array; rate: number } | undefined>;

/** Decodes with Web Audio at a low sample rate (pauses don't need more, and it keeps memory small). */
export const webAudioDecoder: AudioDecoder = async (data) => {
  const Ctx = globalThis.OfflineAudioContext as typeof OfflineAudioContext | undefined;
  if (!Ctx) return undefined;
  for (const rate of [8000, 22050]) {
    let ctx: OfflineAudioContext;
    try {
      ctx = new Ctx(1, 1, rate);
    } catch {
      continue;
    }
    try {
      const buf = await ctx.decodeAudioData(data.slice(0));
      return { samples: buf.getChannelData(0), rate: buf.sampleRate };
    } catch (err) {
      log.debug("Fish audio decode failed", err);
      return undefined;
    }
  }
  return undefined;
};

export function fishBackend(decode: AudioDecoder = webAudioDecoder): PageBackend<FishConfig> {
  return {
    name: "Fish Audio",
    maxChars: FISH_MAX_CHARS,
    cacheKey: (cfg) => `${cfg.model}|${cfg.voice}`,
    generate: async (cfg: FishConfig, texts: string[], io: BackendIO): Promise<Rendered> => {
      const res = await requestFish(cfg, speakableText(texts), io);
      if (!res.body.byteLength) throw new SpeechEngineError("empty");
      const type = res.headers["content-type"]?.split(";")[0] || "audio/mpeg";
      const decoded = await decode(res.body).catch(() => undefined);
      return {
        audio: new Blob([res.body], { type }),
        bounds: paragraphBounds(texts, decoded?.samples, decoded?.rate),
      };
    },
  };
}

async function requestFish(cfg: FishConfig, text: string, io: BackendIO): Promise<HttpResponse> {
  const body = JSON.stringify({
    text,
    ...(cfg.voice ? { reference_id: cfg.voice } : {}),
    format: "mp3",
    mp3_bitrate: 128,
    latency: "normal",
    chunk_length: 300,
    normalize: true,
  });
  for (let attempt = 0; ; attempt++) {
    let res: HttpResponse;
    try {
      res = await io.request({
        method: "POST",
        url: `${FISH_API_BASE}/v1/tts`,
        headers: { Authorization: `Bearer ${cfg.key}`, "Content-Type": "application/json", model: cfg.model },
        body,
        timeoutMs: REQUEST_TIMEOUT_MS,
      });
    } catch (err) {
      if (err instanceof NetworkError && attempt < 2) {
        await io.wait(2000 * 3 ** attempt);
        continue;
      }
      throw new SpeechEngineError("network");
    }
    if (res.status >= 200 && res.status < 300) return res;
    const code = fishErrorCode(res.status);
    if (code === "throttled" && attempt < 4) {
      const after = Number(res.headers["retry-after"]);
      const delay = Math.min(90_000, after > 0 ? after * 1000 : 15_000 * (attempt + 1));
      io.onStatus(`Fish Audio 请求过于频繁，${Math.ceil(delay / 1000)} 秒后重试…`);
      await io.wait(delay);
      continue;
    }
    if (code === "server" && attempt < 2) {
      await io.wait(2000 * 3 ** attempt);
      continue;
    }
    log.warn("Fish Audio TTS failed", res.status, bodyText(res).slice(0, 300));
    throw new SpeechEngineError(code);
  }
}

export class FishSpeechEngine extends PageSpeechEngine<FishConfig> {
  constructor(
    getConfig: () => FishConfig | undefined,
    options: PageEngineOptions & { decode?: AudioDecoder } = {},
  ) {
    super(fishBackend(options.decode), getConfig, {
      ...options,
      store: options.store ?? defaultSegmentStore("biliReader.fish"),
      usage: options.usage ?? new FishUsageMeter(),
    });
  }
}
