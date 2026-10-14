import { FetchError, ParseError, type Catalog, type PageContent, type SiteAdapter } from "../../src/adapters/types";
import { parseChapterUrl, buildPageUrl } from "../../src/adapters/bilinovel/url";
import { Reader, type PageConfigs, type ReaderHost } from "../../src/reader/Reader";
import { ProgressStore, SettingsStore, type KeyValueStore, type PageProvider } from "../../src/reader/ProgressStore";
import { SpeechEngineError } from "../../src/speech/SpeechEngine";
import { geminiBackend } from "../../src/speech/GeminiSpeechEngine";
import { fishBackend } from "../../src/speech/FishSpeechEngine";
import type { PageBackend, SegmentStore, StoredSegment } from "../../src/speech/PageSpeechEngine";
import type { AzureVoice } from "../../src/speech/AzureSpeechEngine";
import { api } from "./api";

/**
 * The userscript's reader, running in the library app: pages come from the
 * server (which fetches and keeps them), speech is generated and kept by the
 * server with its keys, and settings and progress are stored on the server
 * so every device continues where another stopped.
 */

const imageUrl = (url: string) => `/api/img?url=${encodeURIComponent(url)}`;

/** Replaces the site's origin with the app's (the reader mirrors page URLs in the address bar). */
function local(url: string | undefined): string | undefined {
  if (!url) return url;
  try {
    const u = new URL(url, location.origin);
    return /^\/novel\//.test(u.pathname) ? `${location.origin}${u.pathname}` : url;
  } catch {
    return url;
  }
}

/** Reads book content through the library server. */
export class LibraryAdapter implements SiteAdapter {
  readonly name = "library";

  canHandle(url: URL): boolean {
    return parseChapterUrl(url) !== null;
  }

  pageUrl(bookId: string, chapterId: string, pageIndex: number): string {
    return buildPageUrl(location.origin, bookId, chapterId, pageIndex);
  }

  async parseDocument(_doc: Document, url: URL): Promise<PageContent> {
    return this.fetchPage(url.href);
  }

  async loadCurrentPage(_doc: Document, url: URL): Promise<PageContent> {
    return this.fetchPage(url.href);
  }

  async fetchPage(url: string): Promise<PageContent> {
    const info = parseChapterUrl(new URL(url, location.origin));
    if (!info) throw new ParseError("Not a chapter page", url);
    const res = await fetch(`/api/page?book=${info.bookId}&chapter=${info.chapterId}&page=${info.pageIndex}`).catch(() => {
      throw new FetchError("无法连接服务器", url);
    });
    const data = (await res.json().catch(() => ({}))) as PageContent & { error?: string; code?: string; status?: number };
    if (!res.ok) {
      if (res.status === 401) location.href = `/login?next=${encodeURIComponent(location.pathname)}`;
      if (data.code === "parse") throw new ParseError(data.error ?? "无法解析页面", url);
      throw new FetchError(data.error ?? `HTTP ${res.status}`, url, data.status ?? res.status, data.code === "challenge");
    }
    return {
      ...data,
      url: local(data.url)!,
      chapterUrl: local(data.chapterUrl)!,
      nextUrl: data.nextType === "end" ? data.nextUrl : local(data.nextUrl),
      prev: data.prev ? { ...data.prev, url: local(data.prev.url)! } : undefined,
      paragraphs: data.paragraphs.map((p) => (p.imageUrl ? { ...p, imageUrl: imageUrl(p.imageUrl) } : p)),
    };
  }

  async fetchCatalog(bookId: string): Promise<Catalog> {
    const catalog = await api.get<Catalog>(`/api/catalog/${bookId}`);
    return {
      ...catalog,
      volumes: catalog.volumes.map((v) => ({ ...v, chapters: v.chapters.map((c) => ({ ...c, url: local(c.url) })) })),
    };
  }
}

/** Reader settings and progress on the server, with a local copy for when it can't be reached. */
export class ServerKvStore implements KeyValueStore {
  async get(key: string): Promise<string | null> {
    try {
      const { value } = await api.get<{ value: string | null }>(`/api/kv/${encodeURIComponent(key)}`);
      if (value !== null) this.local(key, value);
      return value ?? this.local(key);
    } catch {
      return this.local(key);
    }
  }

  async set(key: string, value: string): Promise<void> {
    this.local(key, value);
    await api.put(`/api/kv/${encodeURIComponent(key)}`, { value }).catch(() => undefined);
  }

  private local(key: string, value?: string): string | null {
    try {
      if (value !== undefined) localStorage.setItem(`library.${key}`, value);
      return localStorage.getItem(`library.${key}`);
    } catch {
      return null;
    }
  }
}

/** A page backend whose requests the server makes (with its keys) and keeps. */
function serverBackend<P extends PageProvider>(provider: P): PageBackend<PageConfigs[P]> {
  const real = (provider === "gemini" ? geminiBackend : fishBackend()) as unknown as PageBackend<PageConfigs[P]>;
  return {
    name: real.name,
    maxChars: real.maxChars,
    cacheKey: (cfg) => real.cacheKey(cfg),
    generate: async (cfg, texts) => {
      const { model, voice } = cfg;
      const style = "style" in cfg ? cfg.style : undefined;
      let res: Response;
      try {
        res = await fetch(`/api/segments/${provider}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ texts, voice: { model, voice, style } }),
        });
      } catch {
        throw new SpeechEngineError("network");
      }
      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as { code?: string };
        throw new SpeechEngineError(data.code ?? (res.status >= 500 ? "server" : `http-${res.status}`));
      }
      return { audio: await res.blob(), bounds: JSON.parse(res.headers.get("x-bounds") ?? "[]") as number[] };
    },
  };
}

/** Segments already on the server (generated by the reader or the background jobs). */
function serverStore(provider: PageProvider): SegmentStore {
  return {
    list: async () => [],
    get: async (key, texts): Promise<StoredSegment | undefined> => {
      const url = `/api/segments/${provider}/${encodeURIComponent(key)}`;
      const res = await (texts
        ? fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ texts }) })
        : fetch(url)
      ).catch(() => undefined);
      if (!res?.ok) return undefined;
      return { key, texts: [], audio: await res.blob(), bounds: JSON.parse(res.headers.get("x-bounds") ?? "[]") as number[] };
    },
    put: async () => undefined,
    delete: async () => undefined,
    clear: async () => undefined,
  };
}

export function startReader(version: string, siteOrigin: string): void {
  const info = parseChapterUrl(location.href);
  const kv = new ServerKvStore();
  const host: ReaderHost = {
    exit: () => {
      location.href = info ? `/book/${info.bookId}` : "/";
    },
    openOriginal: (url) => {
      const u = new URL(url, location.origin);
      window.open(`${siteOrigin}${u.pathname}`, "_blank", "noopener");
    },
    engines: ["system", "gemini", "fish"],
    managedKeys: ["gemini", "fish"],
    pageEngine: { backend: serverBackend, store: serverStore },
    listVoices: (provider) => api.get<AzureVoice[]>(`/api/voices/${provider}`),
  };
  const reader = new Reader(new LibraryAdapter(), new ProgressStore(kv), new SettingsStore(kv), version, host);
  void reader.start();
}
