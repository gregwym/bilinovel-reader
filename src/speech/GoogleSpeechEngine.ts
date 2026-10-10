import { bodyText, httpRequest, NetworkError, type HttpRequest, type HttpResponse } from "../utils/http";
import { log } from "../utils/log";
import { SpeechEngineError } from "./SpeechEngine";
import { CloudSpeechEngine, type CloudEngineOptions } from "./CloudSpeechEngine";
import type { AzureVoice } from "./AzureSpeechEngine";

/**
 * Google Cloud Text-to-Speech over the REST API with an API key:
 *   POST https://texttospeech.googleapis.com/v1/text:synthesize
 *
 * Unlike Azure F0, Google does not stop at the free tier: it bills the
 * billing account. So usage is metered locally per voice type and synthesis
 * stops (error "quota", i.e. fall back to the system voice) once this month's
 * free allowance is reached. The meter is an estimate; a budget alert in the
 * Cloud console is the real safety net.
 */

export interface GoogleConfig {
  key: string;
  voice: string;
}

export type GoogleVoice = AzureVoice;

export const GOOGLE_DEFAULT_VOICE = "cmn-CN-Chirp3-HD-Aoede";

/** Voice types with a monthly free allowance (characters), per Google's pricing page. */
export type GoogleTier = "chirp3-hd" | "wavenet" | "standard";
export const GOOGLE_FREE_CHARS: Record<GoogleTier, number> = {
  "chirp3-hd": 1_000_000,
  wavenet: 1_000_000,
  standard: 4_000_000,
};
const TIER_LABEL: Record<GoogleTier, string> = { "chirp3-hd": "Chirp 3 HD", wavenet: "WaveNet", standard: "Standard" };

export function googleTier(voice: string): GoogleTier | undefined {
  if (/-Chirp3-HD-/i.test(voice)) return "chirp3-hd";
  if (/-Wavenet-/i.test(voice)) return "wavenet";
  if (/-Standard-/i.test(voice)) return "standard";
  return undefined;
}

export const googleTierLabel = (tier: GoogleTier): string => TIER_LABEL[tier];

/** "cmn-CN-Chirp3-HD-Aoede" -> "cmn-CN". */
export function googleLanguageCode(voice: string): string {
  return voice.split("-").slice(0, 2).join("-") || "cmn-CN";
}

/** Used when the voice list cannot be fetched. */
export const GOOGLE_PRESET_VOICES: GoogleVoice[] = [
  { shortName: "cmn-CN-Chirp3-HD-Aoede", label: "Chirp3-HD-Aoede（女，Chirp 3 HD）", locale: "cmn-CN" },
  { shortName: "cmn-CN-Chirp3-HD-Kore", label: "Chirp3-HD-Kore（女，Chirp 3 HD）", locale: "cmn-CN" },
  { shortName: "cmn-CN-Chirp3-HD-Leda", label: "Chirp3-HD-Leda（女，Chirp 3 HD）", locale: "cmn-CN" },
  { shortName: "cmn-CN-Chirp3-HD-Charon", label: "Chirp3-HD-Charon（男，Chirp 3 HD）", locale: "cmn-CN" },
  { shortName: "cmn-CN-Chirp3-HD-Puck", label: "Chirp3-HD-Puck（男，Chirp 3 HD）", locale: "cmn-CN" },
  { shortName: "cmn-CN-Wavenet-A", label: "Wavenet-A（女，WaveNet）", locale: "cmn-CN" },
  { shortName: "cmn-CN-Wavenet-B", label: "Wavenet-B（男，WaveNet）", locale: "cmn-CN" },
  { shortName: "cmn-CN-Standard-A", label: "Standard-A（女，Standard）", locale: "cmn-CN" },
];

const API = "https://texttospeech.googleapis.com/v1";
const REQUEST_TIMEOUT_MS = 20_000;

/** Characters as Google bills them (every character counts once). */
export const googleChars = (text: string): number => [...text].length;

export function googleErrorCode(status: number, body = ""): string {
  if (status === 400) return /API[_ ]key[_ ]not[_ ]valid|API_KEY_INVALID/i.test(body) ? "auth" : "bad-request";
  if (status === 401) return "auth";
  if (status === 403) {
    if (/billing/i.test(body)) return "billing";
    if (/SERVICE_DISABLED|has not been used|is disabled/i.test(body)) return "api-disabled";
    return "auth";
  }
  if (status === 429) return "throttled";
  if (status >= 500) return "server";
  return `http-${status}`;
}

export function describeGoogleError(code: string): string {
  switch (code) {
    case "config":
      return "未设置 Google API 密钥";
    case "auth":
      return "Google API 密钥无效或无权使用 Text-to-Speech";
    case "billing":
      return "Google 项目未启用结算（免费额度也需要绑定结算账号）";
    case "api-disabled":
      return "Google 项目未启用 Cloud Text-to-Speech API";
    case "quota":
      return "本月 Google 免费额度（本地统计）已用完";
    case "throttled":
      return "Google 请求过于频繁";
    case "server":
      return "Google 服务暂时出错";
    case "audio-error":
      return "音频播放出错";
    case "network":
      return "无法连接 Google";
    case "bad-request":
      return "Google 不接受该声音或文本";
    case "not-allowed":
      return "需要点击 ▶ 才能播放音频";
    default:
      return `Google 错误（${code}）`;
  }
}

function base64ToBytes(b64: string): Uint8Array<ArrayBuffer> {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** Local per-month, per-voice-type tally of billed characters (Google's own meter is authoritative). */
export class GoogleUsageMeter {
  static readonly KEY = "biliReader.googleUsage";

  constructor(private readonly storage: Storage | undefined = globalThis.localStorage) {}

  private month(): string {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
  }

  private read(): Partial<Record<GoogleTier, number>> {
    try {
      const raw = JSON.parse(this.storage?.getItem(GoogleUsageMeter.KEY) ?? "null") as {
        month: string;
        chars: Partial<Record<GoogleTier, number>>;
      } | null;
      return raw && raw.month === this.month() && raw.chars && typeof raw.chars === "object" ? raw.chars : {};
    } catch {
      return {};
    }
  }

  get(tier: GoogleTier): number {
    return this.read()[tier] ?? 0;
  }

  /** True if `chars` more still fit in this month's free allowance for the tier. */
  allows(tier: GoogleTier, chars: number): boolean {
    return this.get(tier) + chars <= GOOGLE_FREE_CHARS[tier];
  }

  add(tier: GoogleTier, chars: number): number {
    const all = this.read();
    all[tier] = (all[tier] ?? 0) + chars;
    try {
      this.storage?.setItem(GoogleUsageMeter.KEY, JSON.stringify({ month: this.month(), chars: all }));
    } catch {
      /* ignore */
    }
    return all[tier]!;
  }
}

export interface GoogleEngineOptions extends CloudEngineOptions {
  meter?: GoogleUsageMeter;
}

export class GoogleSpeechEngine extends CloudSpeechEngine {
  readonly maxChunkLength = 300;
  private readonly meter: GoogleUsageMeter;
  /** Voices that rejected `speakingRate`: synthesized at normal speed. */
  private readonly noRate = new Set<string>();

  constructor(
    private readonly getConfig: () => GoogleConfig | undefined,
    googleOptions: GoogleEngineOptions = {},
  ) {
    super(googleOptions);
    this.meter = googleOptions.meter ?? new GoogleUsageMeter();
  }

  protected cacheKey(text: string, rate: number): string | undefined {
    const cfg = this.getConfig();
    if (!cfg?.key) return undefined;
    return `${cfg.voice}|${rate}|${text}`;
  }

  protected async fetchAudio(text: string, rate: number): Promise<Blob> {
    const cfg = this.getConfig()!;
    const tier = googleTier(cfg.voice);
    const chars = googleChars(text);
    // Never bill past the free tier.
    if (!tier || !this.meter.allows(tier, chars)) throw new SpeechEngineError("quota");
    for (let attempt = 0; ; attempt++) {
      const withRate = rate !== 1 && !this.noRate.has(cfg.voice);
      let res: HttpResponse;
      try {
        res = await this.request({
          method: "POST",
          url: `${API}/text:synthesize`,
          headers: { "X-Goog-Api-Key": cfg.key, "Content-Type": "application/json; charset=utf-8" },
          body: JSON.stringify({
            input: { text },
            voice: { languageCode: googleLanguageCode(cfg.voice), name: cfg.voice },
            audioConfig: { audioEncoding: "MP3", ...(withRate ? { speakingRate: rate } : {}) },
          }),
          timeoutMs: REQUEST_TIMEOUT_MS,
        });
      } catch (err) {
        if (err instanceof NetworkError && attempt < 2) {
          await this.wait(1000 * 3 ** attempt);
          continue;
        }
        throw new SpeechEngineError("network");
      }
      if (res.status >= 200 && res.status < 300) {
        const audio = (JSON.parse(bodyText(res)) as { audioContent?: string }).audioContent;
        if (!audio) throw new SpeechEngineError("server");
        this.meter.add(tier, chars);
        this.options.onUsage?.(chars);
        return new Blob([base64ToBytes(audio)], { type: "audio/mpeg" });
      }
      const body = bodyText(res);
      if (res.status === 400 && withRate && /speaking_?rate|rate/i.test(body)) {
        log.info("voice does not support speakingRate; using normal speed", cfg.voice);
        this.noRate.add(cfg.voice);
        continue;
      }
      const code = googleErrorCode(res.status, body);
      if ((code === "throttled" || code === "server") && attempt < 2) {
        await this.wait(code === "throttled" ? 3000 * (attempt + 1) : 1000 * 3 ** attempt);
        continue;
      }
      log.warn("Google TTS failed", res.status, body.slice(0, 200));
      throw new SpeechEngineError(code);
    }
  }
}

/** Lists Mandarin/Cantonese voices that have a free allowance; throws SpeechEngineError on failure. */
export async function listGoogleChineseVoices(
  key: string,
  request: (req: HttpRequest) => Promise<HttpResponse> = httpRequest,
): Promise<GoogleVoice[]> {
  let res: HttpResponse;
  try {
    res = await request({ method: "GET", url: `${API}/voices`, headers: { "X-Goog-Api-Key": key }, timeoutMs: REQUEST_TIMEOUT_MS });
  } catch {
    throw new SpeechEngineError("network");
  }
  if (res.status < 200 || res.status >= 300) throw new SpeechEngineError(googleErrorCode(res.status, bodyText(res)));
  const { voices = [] } = JSON.parse(bodyText(res)) as {
    voices?: { name: string; languageCodes: string[]; ssmlGender?: string }[];
  };
  const tierRank: Record<GoogleTier, number> = { "chirp3-hd": 0, wavenet: 1, standard: 2 };
  const langRank = (l: string) => (l === "cmn-CN" ? 0 : l.startsWith("cmn-") ? 1 : 2);
  return voices
    .filter((v) => /^(cmn|yue)-/.test(v.name) && googleTier(v.name))
    .map((v) => {
      const locale = googleLanguageCode(v.name);
      const tier = googleTier(v.name)!;
      const gender = v.ssmlGender === "MALE" ? "男" : v.ssmlGender === "FEMALE" ? "女" : "?";
      return {
        shortName: v.name,
        locale,
        label: `${v.name.slice(locale.length + 1)}（${gender}，${TIER_LABEL[tier]}${locale === "cmn-CN" ? "" : `，${locale}`}）`,
        rank: langRank(locale) * 10 + tierRank[tier],
      };
    })
    .sort((a, b) => a.rank - b.rank || a.label.localeCompare(b.label))
    .map(({ rank: _rank, ...v }) => v);
}
