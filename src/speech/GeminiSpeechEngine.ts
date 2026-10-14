import { bodyText, httpRequest, NetworkError, type HttpRequest, type HttpResponse } from "../utils/http";
import { log } from "../utils/log";
import { SpeechEngineError } from "./SpeechEngine";
import type { AzureVoice } from "./AzureSpeechEngine";
import {
  DailyUsageMeter,
  PageSpeechEngine,
  defaultSegmentStore,
  hash,
  paragraphBounds,
  pcmToWav,
  type BackendIO,
  type PageBackend,
  type PageEngineOptions,
  type Rendered,
} from "./PageSpeechEngine";

/**
 * Gemini (LLM) speech generation over the Gemini Developer API:
 *   POST https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent
 *
 * Generated a site page at a time (see PageSpeechEngine), which also suits
 * the free tier: it limits requests per day rather than characters.
 */

export const GEMINI_API_BASE = "https://generativelanguage.googleapis.com/v1beta";
export const GEMINI_DEFAULT_MODEL = "gemini-3.8-flash-tts";
export const GEMINI_PRESET_MODELS = ["gemini-3.8-flash-tts", "gemini-3.8-flash-lite-tts", "gemini-3.1-flash-tts"];
export const GEMINI_DEFAULT_VOICE = "Kore";
export const GEMINI_DEFAULT_STYLE = "用自然、生动、富有感情的有声书语气朗读下面的轻小说片段：";
/**
 * Characters per request. TTS output is capped per request (16k audio tokens
 * at ~25 tokens/s, about 10 minutes, for Gemini 2.5 TTS); Chinese is read at
 * roughly 4–5 characters a second, so 2000 characters stay well inside.
 */
export const GEMINI_MAX_CHARS = 2000;

const VOICE_STYLES: [string, string][] = [
  ["Kore", "坚定"],
  ["Aoede", "轻快"],
  ["Leda", "年轻"],
  ["Zephyr", "明亮"],
  ["Puck", "活泼"],
  ["Charon", "沉稳"],
  ["Fenrir", "兴奋"],
  ["Orus", "坚定"],
  ["Callirrhoe", "随和"],
  ["Autonoe", "明亮"],
  ["Enceladus", "气声"],
  ["Iapetus", "清晰"],
  ["Umbriel", "随和"],
  ["Algieba", "顺滑"],
  ["Despina", "顺滑"],
  ["Erinome", "清晰"],
  ["Algenib", "沙哑"],
  ["Rasalgethi", "知性"],
  ["Laomedeia", "欢快"],
  ["Achernar", "柔和"],
  ["Alnilam", "坚定"],
  ["Schedar", "平稳"],
  ["Gacrux", "成熟"],
  ["Pulcherrima", "直率"],
  ["Achird", "友好"],
  ["Zubenelgenubi", "随意"],
  ["Vindemiatrix", "温柔"],
  ["Sadachbia", "活泼"],
  ["Sadaltager", "博学"],
  ["Sulafat", "温暖"],
];

/** Gemini's prebuilt voices (multilingual; the same names work for Chinese). */
export const GEMINI_VOICES: AzureVoice[] = VOICE_STYLES.map(([name, style]) => ({
  shortName: name,
  label: `${name}（${style}）`,
  locale: "",
}));

export interface GeminiConfig {
  key: string;
  model: string;
  voice: string;
  /** Natural-language direction placed before the text ("read it like…"); may be empty. */
  style: string;
  ahead: number;
}

// ---------------------------------------------------------------------------
// Errors

export function geminiErrorCode(status: number, body = ""): string {
  if (status === 400) {
    if (/API_KEY_INVALID|API key not valid/i.test(body)) return "auth";
    if (/location is not supported/i.test(body)) return "location";
    return "bad-request";
  }
  if (status === 401) return "auth";
  if (status === 403) return /SERVICE_DISABLED|has not been used|is disabled/i.test(body) ? "api-disabled" : "auth";
  if (status === 404) return "model";
  if (status === 429) return /PerDay|per day/i.test(body) ? "quota" : "throttled";
  if (status >= 500) return "server";
  return `http-${status}`;
}

/** Server-suggested wait from a 429 body (`"retryDelay": "23s"`), in ms. */
export function geminiRetryDelayMs(body: string): number | undefined {
  const m = /"retryDelay"\s*:\s*"(\d+(?:\.\d+)?)s"/.exec(body);
  return m ? Math.ceil(parseFloat(m[1]) * 1000) : undefined;
}

export function describeGeminiError(code: string): string {
  switch (code) {
    case "config":
      return "未设置 Gemini 密钥";
    case "auth":
      return "Gemini 密钥不正确";
    case "api-disabled":
      return "该项目未启用 Gemini API";
    case "model":
      return "该 Gemini 模型不可用，请换一个模型";
    case "location":
      return "所在地区不支持 Gemini API";
    case "quota":
      return "Gemini 今日免费次数已用完";
    case "throttled":
      return "Gemini 请求过于频繁";
    case "server":
      return "Gemini 服务暂时出错";
    case "network":
      return "无法连接 Gemini";
    case "bad-request":
      return "Gemini 不接受该请求";
    case "too-long":
      return "这一页的语音超过了模型单次输出上限";
    case "empty":
      return "Gemini 没有返回语音";
    case "audio-error":
      return "音频播放出错";
    case "not-allowed":
      return "需要点击 ▶ 才能播放音频";
    default:
      return `Gemini 错误（${code}）`;
  }
}

// ---------------------------------------------------------------------------
// Audio helpers

export function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** Sample rate of raw PCM (`audio/L16;codec=pcm;rate=24000`), or undefined for other formats. */
export function pcmRate(mime: string): number | undefined {
  if (!/^audio\/(l16|pcm)/i.test(mime)) return undefined;
  return Number(/rate=(\d+)/i.exec(mime)?.[1] ?? 24000);
}

/** Lists the account's TTS-capable Gemini models; throws SpeechEngineError on failure. */
export async function listGeminiTtsModels(
  key: string,
  request: (req: HttpRequest) => Promise<HttpResponse> = httpRequest,
): Promise<string[]> {
  let res: HttpResponse;
  try {
    res = await request({
      method: "GET",
      url: `${GEMINI_API_BASE}/models?pageSize=1000`,
      headers: { "x-goog-api-key": key },
      timeoutMs: 20_000,
    });
  } catch {
    throw new SpeechEngineError("network");
  }
  if (res.status < 200 || res.status >= 300) throw new SpeechEngineError(geminiErrorCode(res.status, bodyText(res)));
  const list = (JSON.parse(bodyText(res)) as { models?: { name: string }[] }).models ?? [];
  return list
    .map((m) => m.name.replace(/^models\//, ""))
    .filter((n) => /tts/i.test(n))
    .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
}


// ---------------------------------------------------------------------------
// Engine

const REQUEST_TIMEOUT_MS = 5 * 60_000;

/** Requests and characters sent today (local count; the free tier's limits are per request). */
export class GeminiUsageMeter extends DailyUsageMeter {
  static readonly KEY = "biliReader.geminiUsage";

  constructor(storage: Storage | undefined = globalThis.localStorage) {
    super(GeminiUsageMeter.KEY, storage);
  }
}

export const geminiBackend: PageBackend<GeminiConfig> = {
  name: "Gemini",
  maxChars: GEMINI_MAX_CHARS,
  cacheKey: (cfg) => `${cfg.model}|${cfg.voice}|${hash(cfg.style)}`,
  generate: generateGemini,
};

async function generateGemini(cfg: GeminiConfig, texts: string[], io: BackendIO): Promise<Rendered> {
  const text = texts.join("\n\n");
  const body = JSON.stringify({
    contents: [{ parts: [{ text: cfg.style ? `${cfg.style}\n\n${text}` : text }] }],
    generationConfig: {
      responseModalities: ["AUDIO"],
      speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: cfg.voice } } },
    },
  });
  for (let attempt = 0; ; attempt++) {
    let res: HttpResponse;
    try {
      res = await io.request({
        method: "POST",
        url: `${GEMINI_API_BASE}/models/${encodeURIComponent(cfg.model)}:generateContent`,
        headers: { "x-goog-api-key": cfg.key, "Content-Type": "application/json" },
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
    const raw = bodyText(res);
    if (res.status >= 200 && res.status < 300) return decodeGemini(raw, texts);
    const code = geminiErrorCode(res.status, raw);
    if (code === "throttled" && attempt < 4) {
      const delay = Math.min(90_000, geminiRetryDelayMs(raw) ?? 15_000 * (attempt + 1));
      io.onStatus(`Gemini 请求过于频繁，${Math.ceil(delay / 1000)} 秒后重试…`);
      await io.wait(delay);
      continue;
    }
    if (code === "server" && attempt < 2) {
      await io.wait(2000 * 3 ** attempt);
      continue;
    }
    log.warn("Gemini TTS failed", res.status, raw.slice(0, 300));
    throw new SpeechEngineError(code);
  }
}

function decodeGemini(raw: string, texts: string[]): Rendered {
  type Part = { inlineData?: { mimeType?: string; data?: string } };
  let json: { candidates?: { finishReason?: string; content?: { parts?: Part[] } }[] };
  try {
    json = JSON.parse(raw) as typeof json;
  } catch {
    throw new SpeechEngineError("server");
  }
  const cand = json.candidates?.[0];
  if (cand?.finishReason === "MAX_TOKENS") throw new SpeechEngineError("too-long");
  const parts = (cand?.content?.parts ?? []).filter((p) => p.inlineData?.data);
  if (!parts.length) throw new SpeechEngineError("empty");
  const mime = parts[0].inlineData!.mimeType ?? "audio/L16;codec=pcm;rate=24000";
  const chunks = parts.map((p) => base64ToBytes(p.inlineData!.data!));
  const bytes = new Uint8Array(chunks.reduce((n, c) => n + c.byteLength, 0));
  let o = 0;
  for (const c of chunks) {
    bytes.set(c, o);
    o += c.byteLength;
  }
  const rate = pcmRate(mime);
  if (rate === undefined) return { audio: new Blob([bytes], { type: mime }), bounds: paragraphBounds(texts) };
  const samples = new Int16Array(bytes.buffer, 0, Math.floor(bytes.byteLength / 2));
  return { audio: pcmToWav(bytes, rate), bounds: paragraphBounds(texts, samples, rate) };
}

export class GeminiSpeechEngine extends PageSpeechEngine<GeminiConfig> {
  constructor(getConfig: () => GeminiConfig | undefined, options: PageEngineOptions = {}) {
    super(geminiBackend, getConfig, {
      ...options,
      store: options.store ?? defaultSegmentStore("biliReader.gemini"),
      usage: options.usage ?? new GeminiUsageMeter(),
    });
  }
}
