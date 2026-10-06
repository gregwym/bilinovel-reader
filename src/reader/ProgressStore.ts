/**
 * Persistence for reading progress and reader settings.
 *
 * Everything goes through the async `KeyValueStore` interface so the
 * localStorage backend can later be swapped for IndexedDB without touching
 * callers.
 */

export interface KeyValueStore {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
}

export class LocalStorageStore implements KeyValueStore {
  constructor(private readonly storage: Storage | undefined = globalThis.localStorage) {}

  async get(key: string): Promise<string | null> {
    try {
      return this.storage?.getItem(key) ?? null;
    } catch {
      return null;
    }
  }

  async set(key: string, value: string): Promise<void> {
    try {
      this.storage?.setItem(key, value);
    } catch {
      /* quota exceeded or storage disabled (private mode): progress is best-effort */
    }
  }
}

export class MemoryStore implements KeyValueStore {
  private readonly data = new Map<string, string>();
  async get(key: string): Promise<string | null> {
    return this.data.get(key) ?? null;
  }
  async set(key: string, value: string): Promise<void> {
    this.data.set(key, value);
  }
}

export interface ReaderPosition {
  bookId: string;
  chapterId: string;
  /** 0-based site page within the chapter. */
  pageIndex: number;
  /** 0-based paragraph index within that page. */
  paragraphIndex: number;
}

export interface SavedProgress extends Omit<ReaderPosition, "bookId"> {
  bookTitle?: string;
  chapterTitle?: string;
  url?: string;
  updatedAt: number;
}

const PROGRESS_KEY = "biliReader.progress";
const SETTINGS_KEY = "biliReader.settings";
const MAX_BOOKS = 200;

export class ProgressStore {
  constructor(private readonly kv: KeyValueStore = new LocalStorageStore()) {}

  private async readAll(): Promise<Record<string, SavedProgress>> {
    try {
      const raw = await this.kv.get(PROGRESS_KEY);
      const parsed = raw ? (JSON.parse(raw) as unknown) : {};
      return parsed && typeof parsed === "object" ? (parsed as Record<string, SavedProgress>) : {};
    } catch {
      return {};
    }
  }

  async get(bookId: string): Promise<SavedProgress | undefined> {
    const all = await this.readAll();
    const p = all[bookId];
    if (!p || typeof p.chapterId !== "string") return undefined;
    return p;
  }

  async save(position: ReaderPosition, meta: Omit<SavedProgress, keyof ReaderPosition | "updatedAt"> = {}): Promise<void> {
    const all = await this.readAll();
    const { bookId, ...rest } = position;
    all[bookId] = { ...rest, ...meta, updatedAt: Date.now() };
    // Keep the store bounded: drop the least recently read books.
    const ids = Object.keys(all);
    if (ids.length > MAX_BOOKS) {
      ids
        .sort((a, b) => all[a].updatedAt - all[b].updatedAt)
        .slice(0, ids.length - MAX_BOOKS)
        .forEach((id) => delete all[id]);
    }
    await this.kv.set(PROGRESS_KEY, JSON.stringify(all));
  }
}

export type Theme = "system" | "light" | "dark" | "sepia";
export type FontFamily = "sans" | "serif";
export type TtsEngine = "system" | "azure";

export interface Settings {
  fontSize: number;
  lineHeight: number;
  theme: Theme;
  fontFamily: FontFamily;
  voiceURI?: string;
  rate: number;
  ttsEngine: TtsEngine;
  azureRegion: string;
  azureVoice: string;
}

export const DEFAULT_SETTINGS: Settings = {
  fontSize: 20,
  lineHeight: 1.8,
  theme: "system",
  fontFamily: "sans",
  rate: 1.0,
  ttsEngine: "system",
  azureRegion: "eastasia",
  azureVoice: "zh-CN-XiaoxiaoNeural",
};

export const RATE_OPTIONS = [0.75, 0.85, 0.9, 1.0, 1.1, 1.2, 1.35, 1.5];
export const FONT_SIZE_RANGE = { min: 14, max: 32 };
export const LINE_HEIGHT_OPTIONS = [1.5, 1.65, 1.8, 2.0, 2.2];

export class SettingsStore {
  constructor(private readonly kv: KeyValueStore = new LocalStorageStore()) {}

  async load(): Promise<Settings> {
    try {
      const raw = await this.kv.get(SETTINGS_KEY);
      const parsed = raw ? (JSON.parse(raw) as Partial<Settings>) : {};
      return sanitizeSettings({ ...DEFAULT_SETTINGS, ...parsed });
    } catch {
      return { ...DEFAULT_SETTINGS };
    }
  }

  async save(settings: Settings): Promise<void> {
    await this.kv.set(SETTINGS_KEY, JSON.stringify(sanitizeSettings(settings)));
  }
}

export function sanitizeSettings(s: Settings): Settings {
  const clamp = (v: number, lo: number, hi: number, d: number) =>
    typeof v === "number" && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : d;
  return {
    fontSize: clamp(s.fontSize, FONT_SIZE_RANGE.min, FONT_SIZE_RANGE.max, DEFAULT_SETTINGS.fontSize),
    lineHeight: clamp(s.lineHeight, 1.2, 3, DEFAULT_SETTINGS.lineHeight),
    theme: (["system", "light", "dark", "sepia"] as const).includes(s.theme) ? s.theme : "system",
    fontFamily: s.fontFamily === "serif" ? "serif" : "sans",
    voiceURI: typeof s.voiceURI === "string" ? s.voiceURI : undefined,
    rate: clamp(s.rate, 0.5, 2, DEFAULT_SETTINGS.rate),
    ttsEngine: s.ttsEngine === "azure" ? "azure" : "system",
    azureRegion:
      typeof s.azureRegion === "string" && /^[a-z0-9]+$/.test(s.azureRegion.trim().toLowerCase())
        ? s.azureRegion.trim().toLowerCase()
        : DEFAULT_SETTINGS.azureRegion,
    azureVoice:
      typeof s.azureVoice === "string" && /^[A-Za-z0-9-]+$/.test(s.azureVoice) ? s.azureVoice : DEFAULT_SETTINGS.azureVoice,
  };
}

interface GmStorage {
  getValue?(key: string, defaultValue?: unknown): Promise<unknown>;
  setValue?(key: string, value: unknown): Promise<void>;
}

/**
 * Storage for secrets such as API keys. Prefers the userscript manager's
 * private storage (GM.getValue/GM.setValue), which page scripts cannot read;
 * falls back to localStorage when the manager does not provide it.
 */
export class SecretStore implements KeyValueStore {
  private readonly fallback: KeyValueStore;

  constructor(
    private readonly gm: GmStorage | undefined = (globalThis as { GM?: GmStorage }).GM,
    fallback?: KeyValueStore,
  ) {
    this.fallback = fallback ?? new LocalStorageStore();
  }

  get isPrivate(): boolean {
    return typeof this.gm?.getValue === "function" && typeof this.gm?.setValue === "function";
  }

  async get(key: string): Promise<string | null> {
    if (this.isPrivate) {
      try {
        const v = await this.gm!.getValue!(key, null);
        return typeof v === "string" ? v : null;
      } catch {
        return null;
      }
    }
    return this.fallback.get(key);
  }

  async set(key: string, value: string): Promise<void> {
    if (this.isPrivate) {
      try {
        await this.gm!.setValue!(key, value);
        return;
      } catch {
        /* fall through */
      }
    }
    await this.fallback.set(key, value);
  }
}

export const AZURE_KEY_SECRET = "biliReader.azureKey";
