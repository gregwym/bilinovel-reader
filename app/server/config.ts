import { resolve } from "node:path";
import type { Db } from "./db";
import type { PageProvider, ServerSettings, ServerSettingsUpdate } from "../shared/api";

/** Process configuration (environment). Settings editable in the app live in the database (`Settings`). */
export interface Config {
  port: number;
  host: string;
  /** Database, audio cache, exports. */
  dataDir: string;
  /** Generated audiobooks, organized for people and audiobook apps. */
  libraryDir: string;
  /** Built web app. */
  webDir: string;
  /** Optional password for the whole app. */
  password?: string;
  ffmpeg: string;
  ffprobe: string;
  defaults: Omit<ServerSettings, "keys">;
  /** Keys from the environment (used when none is saved in the app). */
  envKeys: Partial<Record<PageProvider, string>>;
}

export const DEFAULT_STORAGE_TEMPLATE = "{author}/{book}/{volumeNo} {volume}/{chapterNo} {chapter}";
export const MOBILE_UA =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Mobile/15E148 Safari/604.1";

export function loadConfig(env: NodeJS.ProcessEnv = process.env, cwd = process.cwd()): Config {
  const num = (v: string | undefined, d: number) => (v && Number.isFinite(Number(v)) ? Number(v) : d);
  return {
    port: num(env.PORT, 8790),
    host: env.HOST ?? "0.0.0.0",
    dataDir: resolve(cwd, env.DATA_DIR ?? "data"),
    libraryDir: resolve(cwd, env.LIBRARY_DIR ?? "library"),
    webDir: resolve(cwd, env.WEB_DIR ?? "dist-app/web"),
    password: env.APP_PASSWORD || undefined,
    ffmpeg: env.FFMPEG_PATH ?? "ffmpeg",
    ffprobe: env.FFPROBE_PATH ?? "ffprobe",
    defaults: {
      siteOrigin: (env.SITE_ORIGIN ?? "https://www.bilinovel.com").replace(/\/$/, ""),
      cookie: env.SITE_COOKIE ?? "",
      userAgent: env.SITE_USER_AGENT ?? MOBILE_UA,
      flaresolverrUrl: env.FLARESOLVERR_URL ?? "",
      requestIntervalMs: num(env.SITE_REQUEST_INTERVAL_MS, 3000),
      defaultAhead: num(env.DEFAULT_AHEAD, 3),
      storageTemplate: env.STORAGE_TEMPLATE ?? DEFAULT_STORAGE_TEMPLATE,
    },
    envKeys: { gemini: env.GEMINI_API_KEY || undefined, fish: env.FISH_API_KEY || undefined },
  };
}

const SETTINGS_KEY = "server.settings";
const KEY_PREFIX = "server.key.";

/** Settings changed in the app, over the environment defaults. */
export class Settings {
  private listeners: (() => void)[] = [];

  constructor(
    private readonly db: Db,
    private readonly config: Config,
  ) {}

  get(): Omit<ServerSettings, "keys"> {
    const saved = this.db.getJson<Partial<ServerSettings>>(SETTINGS_KEY) ?? {};
    return sanitize({ ...this.config.defaults, ...saved }, this.config.defaults);
  }

  view(): ServerSettings {
    return { ...this.get(), keys: { gemini: !!this.key("gemini"), fish: !!this.key("fish") } };
  }

  key(provider: PageProvider): string | undefined {
    return this.db.getKv(KEY_PREFIX + provider) || this.config.envKeys[provider] || undefined;
  }

  update(patch: ServerSettingsUpdate): ServerSettings {
    const { keys, ...rest } = patch;
    const next = sanitize({ ...this.get(), ...rest }, this.config.defaults);
    this.db.setJson(SETTINGS_KEY, next);
    for (const [provider, key] of Object.entries(keys ?? {})) {
      if (typeof key === "string") this.db.setKv(KEY_PREFIX + provider, key.trim() || undefined);
    }
    this.listeners.forEach((fn) => fn());
    return this.view();
  }

  onChange(fn: () => void): void {
    this.listeners.push(fn);
  }
}

function sanitize(s: Omit<ServerSettings, "keys">, d: Omit<ServerSettings, "keys">): Omit<ServerSettings, "keys"> {
  const str = (v: unknown, fallback: string) => (typeof v === "string" ? v.trim() : fallback);
  let origin = str(s.siteOrigin, d.siteOrigin).replace(/\/+$/, "");
  try {
    const u = new URL(origin);
    origin = u.protocol === "https:" || u.protocol === "http:" ? u.origin : d.siteOrigin;
  } catch {
    origin = d.siteOrigin;
  }
  const template = str(s.storageTemplate, d.storageTemplate);
  return {
    siteOrigin: origin,
    cookie: str(s.cookie, "").replace(/[\r\n]/g, ""),
    userAgent: str(s.userAgent, d.userAgent).replace(/[\r\n]/g, "") || d.userAgent,
    flaresolverrUrl: str(s.flaresolverrUrl, "").replace(/\/+$/, ""),
    requestIntervalMs: Math.min(60_000, Math.max(500, Math.round(Number(s.requestIntervalMs) || d.requestIntervalMs))),
    defaultAhead: Number.isFinite(Number(s.defaultAhead))
      ? Math.min(50, Math.max(0, Math.round(Number(s.defaultAhead))))
      : d.defaultAhead,
    storageTemplate: template.includes("{chapter") ? template : d.storageTemplate,
  };
}
