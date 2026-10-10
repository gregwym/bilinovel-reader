import { bodyText, httpRequest, NetworkError, type HttpRequest, type HttpResponse } from "../utils/http";
import { log } from "../utils/log";
import { SpeechEngineError } from "./SpeechEngine";
import { CloudSpeechEngine, type CloudEngineOptions } from "./CloudSpeechEngine";

/**
 * Azure AI Speech neural TTS over the REST API:
 *   POST https://{region}.tts.speech.microsoft.com/cognitiveservices/v1
 * Playback is shared with other cloud engines (CloudSpeechEngine).
 *
 * With a free (F0) Speech resource, Azure refuses requests once the monthly
 * quota is used up instead of billing, so usage stops at the free tier.
 */

export interface AzureConfig {
  key: string;
  region: string;
  voice: string;
}

export interface AzureVoice {
  shortName: string;
  label: string;
  locale: string;
}

export const AZURE_DEFAULT_REGION = "eastasia";
export const AZURE_DEFAULT_VOICE = "zh-CN-XiaoxiaoNeural";

/** Used when the voice list cannot be fetched. */
export const AZURE_PRESET_VOICES: AzureVoice[] = [
  { shortName: "zh-CN-XiaoxiaoNeural", label: "晓晓（女）", locale: "zh-CN" },
  { shortName: "zh-CN-YunxiNeural", label: "云希（男）", locale: "zh-CN" },
  { shortName: "zh-CN-YunjianNeural", label: "云健（男）", locale: "zh-CN" },
  { shortName: "zh-CN-XiaoyiNeural", label: "晓伊（女）", locale: "zh-CN" },
  { shortName: "zh-CN-YunyangNeural", label: "云扬（男）", locale: "zh-CN" },
  { shortName: "zh-CN-XiaochenNeural", label: "晓辰（女）", locale: "zh-CN" },
  { shortName: "zh-CN-XiaohanNeural", label: "晓涵（女）", locale: "zh-CN" },
  { shortName: "zh-CN-XiaomoNeural", label: "晓墨（女）", locale: "zh-CN" },
  { shortName: "zh-CN-YunzeNeural", label: "云泽（男）", locale: "zh-CN" },
  { shortName: "zh-TW-HsiaoChenNeural", label: "曉臻（女，台湾）", locale: "zh-TW" },
];

const OUTPUT_FORMAT = "audio-24khz-48kbitrate-mono-mp3";
const REQUEST_TIMEOUT_MS = 20_000;

export function azureTtsEndpoint(region: string): string {
  return `https://${region}.tts.speech.microsoft.com/cognitiveservices/v1`;
}

export function azureVoicesEndpoint(region: string): string {
  return `https://${region}.tts.speech.microsoft.com/cognitiveservices/voices/list`;
}

function escapeXml(s: string): string {
  return s.replace(/[<>&"']/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;", "'": "&apos;" })[c]!);
}

/** 1.2 -> "+20%", 0.85 -> "-15%". */
export function azureRate(rate: number): string {
  const pct = Math.round((rate - 1) * 100);
  return `${pct >= 0 ? "+" : ""}${pct}%`;
}

export function buildSsml(text: string, voice: string, rate: number): string {
  const lang = /^([a-z]{2,3}-[A-Za-z]{2,4})-/.exec(voice)?.[1] ?? "zh-CN";
  return (
    `<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xml:lang="${lang}">` +
    `<voice name="${escapeXml(voice)}"><prosody rate="${azureRate(rate)}">${escapeXml(text)}</prosody></voice>` +
    `</speak>`
  );
}

/** Characters as Azure bills them: CJK characters count twice. */
export function billableChars(text: string): number {
  let n = 0;
  for (const ch of text) n += /[\u2e80-\u9fff\uac00-\ud7af\uf900-\ufaff\uff00-\uffef]/.test(ch) ? 2 : 1;
  return n;
}

/** Maps an HTTP failure to a SpeechEngineError code the UI can explain. */
/**
 * Maps an HTTP failure to an error code. 429 means short-term throttling
 * unless the body mentions the (monthly) quota.
 */
export function azureErrorCode(status: number, body = ""): string {
  if (status === 401) return "auth";
  if (status === 403) return "quota";
  if (status === 429) return /quota/i.test(body) ? "quota" : "throttled";
  if (status === 400) return "bad-request";
  if (status >= 500) return "server";
  return `http-${status}`;
}

/** Errors that usually go away by themselves (retry soon). */
export const TRANSIENT_AZURE_ERRORS = new Set(["network", "throttled", "server", "audio-error", "timeout"]);

export function describeAzureError(code: string): string {
  switch (code) {
    case "config":
      return "未设置 Azure 密钥";
    case "auth":
      return "Azure 密钥或区域不正确";
    case "quota":
      return "Azure 免费额度已用完";
    case "throttled":
      return "Azure 请求过于频繁";
    case "server":
      return "Azure 服务暂时出错";
    case "audio-error":
      return "音频播放出错";
    case "network":
      return "无法连接 Azure";
    case "bad-request":
      return "Azure 不接受该声音或文本";
    case "not-allowed":
      return "需要点击 ▶ 才能播放音频";
    default:
      return `Azure 错误（${code}）`;
  }
}

export type AzureEngineOptions = CloudEngineOptions;

export class AzureSpeechEngine extends CloudSpeechEngine {
  readonly maxChunkLength = 300;

  constructor(
    private readonly getConfig: () => AzureConfig | undefined,
    options: AzureEngineOptions = {},
  ) {
    super(options);
  }

  protected cacheKey(text: string, rate: number): string | undefined {
    const cfg = this.getConfig();
    if (!cfg?.key || !cfg.region) return undefined;
    return `${cfg.region}|${cfg.voice}|${rate}|${text}`;
  }

  protected fetchAudio(text: string, rate: number): Promise<Blob> {
    return this.fetchAzure(this.getConfig()!, text, rate);
  }

  private async fetchAzure(cfg: AzureConfig, text: string, rate: number): Promise<Blob> {
    const wait = this.wait;
    for (let attempt = 0; ; attempt++) {
      let res: HttpResponse;
      try {
        res = await this.request({
          method: "POST",
          url: azureTtsEndpoint(cfg.region),
          headers: {
            "Ocp-Apim-Subscription-Key": cfg.key,
            "Content-Type": "application/ssml+xml",
            "X-Microsoft-OutputFormat": OUTPUT_FORMAT,
          },
          body: buildSsml(text, cfg.voice, rate),
          timeoutMs: REQUEST_TIMEOUT_MS,
        });
      } catch (err) {
        // Flaky mobile networks: retry with backoff before giving up.
        if (err instanceof NetworkError && attempt < 2) {
          await wait(1000 * 3 ** attempt);
          continue;
        }
        throw new SpeechEngineError("network");
      }
      if (res.status >= 200 && res.status < 300 && res.body.byteLength > 0) {
        this.options.onUsage?.(billableChars(text));
        return new Blob([res.body], { type: "audio/mpeg" });
      }
      const code = azureErrorCode(res.status, bodyText(res));
      if ((code === "throttled" || code === "server") && attempt < 2) {
        await wait(code === "throttled" ? 3000 * (attempt + 1) : 1000 * 3 ** attempt);
        continue;
      }
      log.warn("Azure TTS failed", res.status, bodyText(res).slice(0, 200));
      throw new SpeechEngineError(code);
    }
  }
}

/** Lists Chinese voices for the configured resource; throws SpeechEngineError on failure. */
export async function listAzureChineseVoices(
  cfg: Pick<AzureConfig, "key" | "region">,
  request: (req: HttpRequest) => Promise<HttpResponse> = httpRequest,
): Promise<AzureVoice[]> {
  let res: HttpResponse;
  try {
    res = await request({
      method: "GET",
      url: azureVoicesEndpoint(cfg.region),
      headers: { "Ocp-Apim-Subscription-Key": cfg.key },
      timeoutMs: REQUEST_TIMEOUT_MS,
    });
  } catch {
    throw new SpeechEngineError("network");
  }
  if (res.status < 200 || res.status >= 300) throw new SpeechEngineError(azureErrorCode(res.status));
  const list = JSON.parse(bodyText(res)) as {
    ShortName: string;
    LocalName?: string;
    DisplayName?: string;
    Gender?: string;
    Locale: string;
  }[];
  const rank = (l: string) => (l === "zh-CN" ? 0 : l.startsWith("zh-CN") ? 1 : l === "zh-TW" ? 2 : 3);
  return list
    .filter((v) => /^zh-/i.test(v.Locale))
    .map((v) => ({
      shortName: v.ShortName,
      locale: v.Locale,
      label: `${v.LocalName || v.DisplayName || v.ShortName}（${v.Gender === "Male" ? "男" : v.Gender === "Female" ? "女" : "?"}，${v.Locale}）`,
    }))
    .sort((a, b) => rank(a.locale) - rank(b.locale) || a.label.localeCompare(b.label));
}

/** Rough local tally of billed characters per calendar month (Azure's own meter is authoritative). */
export class AzureUsageMeter {
  static readonly KEY = "biliReader.azureUsage";
  static readonly FREE_CHARS = 500_000;

  constructor(private readonly storage: Storage | undefined = globalThis.localStorage) {}

  private month(): string {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
  }

  get(): number {
    try {
      const raw = JSON.parse(this.storage?.getItem(AzureUsageMeter.KEY) ?? "null") as { month: string; chars: number } | null;
      return raw && raw.month === this.month() ? raw.chars : 0;
    } catch {
      return 0;
    }
  }

  add(chars: number): number {
    const total = this.get() + chars;
    try {
      this.storage?.setItem(AzureUsageMeter.KEY, JSON.stringify({ month: this.month(), chars: total }));
    } catch {
      /* ignore */
    }
    return total;
  }
}
