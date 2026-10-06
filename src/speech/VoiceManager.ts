export interface VoiceInfo {
  voiceURI: string;
  name: string;
  lang: string;
  localService: boolean;
}

const CHINESE = /^(zh|cmn|yue)([-_]|$)/i;

function langRank(lang: string): number {
  const l = lang.toLowerCase().replace("_", "-");
  if (l.startsWith("zh-cn") || l.startsWith("cmn-hans") || l === "zh") return 0;
  if (l.startsWith("zh-tw") || l.startsWith("cmn-hant")) return 1;
  if (l.startsWith("zh-hk") || l.startsWith("yue")) return 2;
  return 3;
}

/** Sorts Chinese voices: Mainland first, then Taiwan, then Hong Kong; local (offline) voices first. */
export function sortChineseVoices<T extends { lang: string; name: string; localService: boolean }>(voices: T[]): T[] {
  return voices
    .filter((v) => CHINESE.test(v.lang))
    .sort(
      (a, b) =>
        langRank(a.lang) - langRank(b.lang) ||
        Number(b.localService) - Number(a.localService) ||
        a.name.localeCompare(b.name),
    );
}

/**
 * Wraps `speechSynthesis.getVoices()`, which is empty until the browser has
 * loaded its voice list. Safari does not always fire `voiceschanged`, so we
 * also poll briefly.
 */
export class VoiceManager {
  private voices: SpeechSynthesisVoice[] = [];
  private listeners = new Set<() => void>();

  constructor(private readonly synth: SpeechSynthesis | undefined = globalThis.speechSynthesis) {
    if (!synth) return;
    this.refresh();
    synth.addEventListener?.("voiceschanged", () => this.refresh());
    let tries = 0;
    const poll = setInterval(() => {
      tries++;
      if (this.refresh() || tries > 20) clearInterval(poll);
    }, 500);
  }

  private refresh(): boolean {
    const list = this.synth?.getVoices() ?? [];
    const changed = list.length !== this.voices.length;
    this.voices = list;
    if (changed) this.listeners.forEach((l) => l());
    return list.length > 0;
  }

  onChange(listener: () => void): void {
    this.listeners.add(listener);
  }

  /** Chinese voices, best first. Falls back to all voices if none are Chinese. */
  list(): VoiceInfo[] {
    const zh = sortChineseVoices(this.voices);
    return (zh.length ? zh : this.voices).map((v) => ({
      voiceURI: v.voiceURI,
      name: v.name,
      lang: v.lang,
      localService: v.localService,
    }));
  }

  /** The voice for `uri`, else the best Chinese voice, else undefined (browser default). */
  resolve(uri?: string): SpeechSynthesisVoice | undefined {
    if (uri) {
      const exact = this.voices.find((v) => v.voiceURI === uri);
      if (exact) return exact;
    }
    return sortChineseVoices(this.voices)[0];
  }
}
