import {
  FetchError,
  ParseError,
  type Catalog,
  type CatalogChapter,
  type PageContent,
  type SiteAdapter,
} from "../adapters/types";
import { SpeechPlayer, type PlaybackSource } from "../speech/SpeechPlayer";
import { WebSpeechEngine, type SpeechEngine } from "../speech/SpeechEngine";
import {
  AzureSpeechEngine,
  AzureUsageMeter,
  describeAzureError,
  listAzureChineseVoices,
  type AzureVoice,
} from "../speech/AzureSpeechEngine";
import {
  GOOGLE_FREE_CHARS,
  GoogleSpeechEngine,
  GoogleUsageMeter,
  describeGoogleError,
  googleTier,
  googleTierLabel,
  listGoogleChineseVoices,
} from "../speech/GoogleSpeechEngine";
import type { CloudSpeechEngine } from "../speech/CloudSpeechEngine";
import { FallbackSpeechEngine } from "../speech/FallbackSpeechEngine";
import { SpeechEngineError } from "../speech/SpeechEngine";
import { VoiceManager } from "../speech/VoiceManager";
import { ReaderView, type TocState, type TocStep, type ViewAction } from "../ui/ReaderView";
import { debounce } from "../utils/async";
import { log } from "../utils/log";
import { ChapterBuffer, type ReaderParagraph } from "./ChapterBuffer";
import {
  AZURE_KEY_SECRET,
  DEFAULT_SETTINGS,
  GOOGLE_KEY_SECRET,
  type CloudProvider,
  ProgressStore,
  SecretStore,
  SettingsStore,
  type SavedProgress,
  type Settings,
} from "./ProgressStore";

/** Prefetch the next site page when this few paragraphs remain loaded ahead of the cursor. */
const PREFETCH_REMAINING = 8;
/** Rolling buffer: chapters kept in memory/DOM. */
const MAX_CHAPTERS = 4;

/** Scroll reports that count as "reading on here" while the restore prompt is open. */
const AUTO_ACCEPT_SCROLLS = 40;

export const EXITED_URL_KEY = "biliReader.exitedUrl";

/** A place to move the cursor to. */
interface JumpTarget {
  /** Unknown only when `url` is given. */
  chapterId?: string;
  pageIndex: number;
  /** Clamped to the page's last paragraph. */
  paragraphIndex: number;
  /** Start of the paragraph's text; wins over the index when it still matches. */
  snippet?: string;
  url?: string;
}

/** A network TTS service (Azure, Google) with its key and system-voice fallback. */
interface CloudSlot {
  name: string;
  secret: string;
  key: string;
  engine: CloudSpeechEngine;
  withFallback: FallbackSpeechEngine;
  describe(code: string): string;
  usageText(): string;
  listVoices(key: string): Promise<AzureVoice[]>;
  sample: string;
}

const snippetOf = (p: ReaderParagraph): string | undefined => p.text?.slice(0, 24) || undefined;

/** This tab's own position, kept in `history.state` (survives Safari reloading or restoring the tab). */
interface TabPosition {
  bookId: string;
  chapterId: string;
  pageIndex: number;
  paragraphIndex: number;
  snippet?: string;
  updatedAt: number;
}
const TAB_STATE_KEY = "biliReader";

function readTabPosition(): TabPosition | undefined {
  try {
    const t = (history.state as Record<string, unknown> | null)?.[TAB_STATE_KEY] as TabPosition | undefined;
    return t && typeof t.chapterId === "string" && typeof t.updatedAt === "number" ? t : undefined;
  } catch {
    return undefined;
  }
}

function describeError(err: unknown): { message: string; detail: string } {
  if (err instanceof FetchError && err.challenge) {
    return {
      message: "网站要求人机验证。请打开原网页完成验证后再返回阅读模式。",
      detail: err.url,
    };
  }
  if (err instanceof FetchError) {
    return { message: "网络请求失败。", detail: `${err.message} · ${err.url}` };
  }
  if (err instanceof ParseError) {
    return { message: "无法解析此 Bilinovel 页面。", detail: `${err.message} · ${err.url}` };
  }
  return { message: "出现了意外错误。", detail: String(err) };
}

/**
 * Orchestrates adapter, chapter buffer, view, speech and persistence around a
 * single shared cursor (the current paragraph), used by both reading and
 * listening.
 */
export class Reader implements PlaybackSource {
  private readonly buffer = new ChapterBuffer();
  private readonly view: ReaderView;
  private readonly voices = new VoiceManager();
  private readonly player: SpeechPlayer;
  private readonly webEngine: WebSpeechEngine;
  private readonly cloud: Record<CloudProvider, CloudSlot>;
  private readonly secrets = new SecretStore();
  private readonly azureUsage = new AzureUsageMeter();
  private readonly googleUsage = new GoogleUsageMeter();
  private settings!: Settings;
  private cursorId?: string;
  private loading?: Promise<boolean>;
  private loadFailed = false;
  /** Saving is held back while the "continue where you left off?" prompt is open. */
  private savingEnabled = false;
  private scrollReportsWhilePrompt = 0;
  /** The cursor moved since the last save (only then may this tab overwrite saved progress). */
  private dirty = false;
  /** `updatedAt` of the newest saved progress this tab knows about. */
  private knownUpdatedAt = 0;
  /** Bumped whenever the buffer is replaced, so late page loads for old content are dropped. */
  private generation = 0;
  private jumpSeq = 0;
  private catalog?: Catalog;
  private catalogLoading?: Promise<Catalog | undefined>;
  private catalogError?: string;
  private readonly originalUrl = location.href;
  private readonly originalTitle = document.title;
  private active = false;

  private readonly saveSoon = debounce(() => void this.saveNow(), 800);

  constructor(
    private readonly adapter: SiteAdapter,
    private readonly progress = new ProgressStore(),
    private readonly settingsStore = new SettingsStore(),
    private readonly version = "dev",
  ) {
    this.webEngine = new WebSpeechEngine(globalThis.speechSynthesis, (uri) => this.voices.resolve(uri));
    const azure = new AzureSpeechEngine(
      () => {
        const key = this.cloud.azure.key;
        return key ? { key, region: this.settings.azureRegion, voice: this.settings.azureVoice } : undefined;
      },
      { onUsage: (chars) => (this.azureUsage.add(chars), this.renderUsage("azure")) },
    );
    const google = new GoogleSpeechEngine(
      () => {
        const key = this.cloud.google.key;
        return key ? { key, voice: this.settings.googleVoice } : undefined;
      },
      { meter: this.googleUsage, onUsage: () => this.renderUsage("google") },
    );
    this.cloud = {
      azure: {
        name: "Azure",
        secret: AZURE_KEY_SECRET,
        key: "",
        engine: azure,
        withFallback: this.withFallback("azure", azure),
        describe: describeAzureError,
        usageText: () => {
          const used = this.azureUsage.get();
          const pct = Math.min(100, Math.round((used / AzureUsageMeter.FREE_CHARS) * 100));
          return `本月约用 ${used.toLocaleString()} / ${AzureUsageMeter.FREE_CHARS.toLocaleString()} 字符（${pct}%，中文按 2 计，以 Azure 后台为准）`;
        },
        listVoices: (key) => listAzureChineseVoices({ key, region: this.settings.azureRegion }),
        sample: "你好，这是 Azure 神经网络语音的试听。轻小说朗读听起来会是这个样子。",
      },
      google: {
        name: "Google",
        secret: GOOGLE_KEY_SECRET,
        key: "",
        engine: google,
        withFallback: this.withFallback("google", google),
        describe: describeGoogleError,
        usageText: () => {
          const tier = googleTier(this.settings.googleVoice);
          if (!tier) return "该声音没有免费额度，不会使用";
          const used = this.googleUsage.get(tier);
          const free = GOOGLE_FREE_CHARS[tier];
          const pct = Math.min(100, Math.round((used / free) * 100));
          return `${googleTierLabel(tier)} 本月约用 ${used.toLocaleString()} / ${free.toLocaleString()} 字符（${pct}%，本机统计；用满即停用、改用系统语音，不会产生费用。以 Google 后台为准）`;
        },
        listVoices: (key) => listGoogleChineseVoices(key),
        sample: "你好，这是 Google 语音的试听。轻小说朗读听起来会是这个样子。",
      },
    };
    this.player = new SpeechPlayer(this.webEngine, this, {
      onState: (state, message) => {
        this.view.setPlayerState(state, message);
        if (state === "idle") this.view.setActive(undefined);
      },
      onParagraph: (id) => {
        this.view.setSelected(undefined);
        this.view.setActive(id);
        this.view.follow(id);
        this.setCursor(id);
      },
    });
    this.view = new ReaderView(
      {
        onExit: () => this.exit(),
        onReenter: () => this.enter(),
        onNearEnd: () => {
          if (!this.loadFailed) void this.loadMore();
        },
        onVisibleParagraph: (id) => this.onUserScrolledTo(id),
        onParagraphTap: (id) => this.onParagraphTap(id),
        onReadFromHere: (id) => {
          this.view.setSelected(undefined);
          this.acceptCurrentPosition();
          this.player.play(id);
        },
        onTogglePlay: () => this.togglePlay(),
        onPrev: () => this.player.previousParagraph(),
        onNext: () => this.player.nextParagraph(),
        onRate: (rate) => {
          this.updateSettings({ ...this.settings, rate });
          this.player.setRate(rate);
        },
        onVoice: (uri) => this.player.setVoice(uri),
        onSettings: (s) => this.updateSettings(s),
        onCloudKey: (provider, key) => void this.setCloudKey(provider, key),
        onCloudTest: (provider) => this.testCloudVoice(provider),
        onCloudRetry: (provider) => {
          this.cloud[provider].withFallback.reset();
          this.view.setCloudState(provider, { status: `正在重试 ${this.cloud[provider].name}…`, fallback: false });
          this.player.restartCurrent();
        },
        onCopyDiagnostics: () => this.copyDiagnostics(),
        onOpenOriginal: () => this.openOriginal(),
        onRestartChapter: () => {
          const p = this.cursorParagraph();
          if (!p) return;
          this.navigating();
          void this.jumpTo({ chapterId: p.chapterId, pageIndex: 0, paragraphIndex: 0 });
        },
        onOpenToc: () => this.openToc(),
        onTocStep: (step) => {
          this.navigating();
          void this.tocStep(step);
        },
        onTocPage: (pageIndex) => {
          const p = this.cursorParagraph();
          if (!p) return;
          this.navigating();
          void this.jumpTo({ chapterId: p.chapterId, pageIndex, paragraphIndex: 0 });
        },
        onTocChapter: (chapter) => {
          this.navigating();
          void this.gotoCatalogChapter(chapter);
        },
        onTocRetry: () => {
          void this.ensureCatalog(true).then(() => this.view.updateToc(this.tocState()));
          this.view.updateToc(this.tocState());
        },
        onTopNav: () => this.topNav(),
      },
      DEFAULT_SETTINGS,
      version,
    );
  }

  // ---------------------------------------------------------------------------
  // Lifecycle

  async start(): Promise<void> {
    this.settings = await this.settingsStore.load();
    this.view.mount();
    this.adapter.setFrameHost?.(this.view.frameHost);
    this.view.applySettings(this.settings);
    this.view.setTitles("Bili Reader", "正在加载…");
    this.view.show();
    this.active = true;
    this.player.setRate(this.settings.rate);
    this.player.setVoice(this.settings.voiceURI);
    for (const provider of ["azure", "google"] as const) {
      const slot = this.cloud[provider];
      slot.key = (await this.secrets.get(slot.secret)) ?? "";
      this.view.setCloudState(provider, { keySet: !!slot.key, usage: slot.usageText() });
    }
    this.applyEngine();
    if (this.settings.ttsEngine !== "system") void this.refreshCloudVoices(this.settings.ttsEngine);
    this.setupMediaSession();
    this.view.setVoices(this.voices.list());
    this.voices.onChange(() => this.view.setVoices(this.voices.list()));

    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible") {
        this.player.recoverIfStalled();
        void this.checkExternalProgress();
      } else void this.saveNow();
    });
    window.addEventListener("pagehide", () => void this.saveNow());
    // Back/forward cache: the page comes back as it was, but another tab may have read on.
    window.addEventListener("pageshow", (ev) => {
      if (ev.persisted) void this.checkExternalProgress();
    });

    await this.loadInitial();
  }

  private async loadInitial(): Promise<void> {
    this.view.clearContent();
    this.view.setStatus("loading", "正在加载…");
    let page: PageContent;
    try {
      page = await this.fetchCurrentPage();
    } catch (err) {
      log.error("initial load failed", err);
      const { message, detail } = describeError(err);
      this.view.setTitles("Bili Reader");
      this.view.showFatal(message, detail, [
        { label: "重试", primary: true, onClick: () => void this.loadInitial() },
        { label: "打开原网页", onClick: () => this.exit() },
      ]);
      return;
    }
    this.resetBuffer();
    this.appendPage(page);
    const first = this.buffer.first();
    if (first) this.setCursor(first.id, { save: false });
    await this.offerRestore(page);
  }

  /** The page the tab originally loaded (the live DOM belongs to it). */
  private fetchCurrentPage(): Promise<PageContent> {
    return this.adapter.loadCurrentPage(document, new URL(this.originalUrl));
  }

  private exit(): void {
    this.player.stop();
    void this.saveNow();
    this.view.collapse();
    this.active = false;
    // The visible original DOM belongs to the URL the tab originally loaded.
    history.replaceState(history.state, "", this.originalUrl);
    document.title = this.originalTitle;
    try {
      sessionStorage.setItem(EXITED_URL_KEY, this.originalUrl);
    } catch {
      /* ignore */
    }
  }

  private resetBuffer(): void {
    this.generation++;
    this.loadFailed = false;
    this.buffer.reset();
    this.view.clearContent();
    this.cursorId = undefined;
  }

  private cursorParagraph(): ReaderParagraph | undefined {
    return this.cursorId ? this.buffer.get(this.cursorId) : undefined;
  }

  private enter(): void {
    try {
      sessionStorage.removeItem(EXITED_URL_KEY);
    } catch {
      /* ignore */
    }
    this.view.show();
    this.active = true;
    if (this.cursorId) this.syncUrl(this.cursorId);
  }

  private openOriginal(): void {
    const p = this.cursorId ? this.buffer.get(this.cursorId) : undefined;
    const url = p?.pageUrl ?? this.originalUrl;
    void this.saveNow();
    try {
      sessionStorage.setItem(EXITED_URL_KEY, url);
    } catch {
      /* ignore */
    }
    location.href = url;
  }

  // ---------------------------------------------------------------------------
  // Loading

  private appendPage(page: PageContent): void {
    const res = this.buffer.append(page);
    if (res.kind === "duplicate") return;
    if (res.kind === "new-chapter") this.view.appendChapter(res.chapter.chapterId, res.chapter.title, res.added);
    else this.view.appendParagraphs(res.chapter.chapterId, res.added);
    if (this.buffer.chapters.length === 1 && res.kind === "new-chapter") {
      this.view.setTitles(this.buffer.bookTitle, res.chapter.title);
    }
    this.renderTailStatus();
    this.trimBuffer();
    this.renderTopNav();
  }

  private renderTailStatus(): void {
    if (this.buffer.atEnd) this.view.setStatus("end", "没有更多内容了（已到本卷或全书末尾）");
    else this.view.setStatus("idle");
  }

  /** Loads the next site page. Concurrent calls share one request. */
  loadMore(): Promise<boolean> {
    if (this.loading) return this.loading;
    const pending = this.buffer.pending;
    if (!pending) return Promise.resolve(false);
    this.view.setStatus("loading", pending.type === "next-chapter" ? "正在加载下一章…" : "正在加载…");
    const generation = this.generation;
    let stale = false;
    this.loading = this.adapter
      .fetchPage(pending.url)
      .then((page) => {
        // The buffer was replaced (jump) while this page loaded: it no longer continues anything.
        if (generation !== this.generation) return !(stale = true);
        this.loadFailed = false;
        this.appendPage(page);
        return true;
      })
      .catch((err: unknown) => {
        if (generation !== this.generation) return !(stale = true);
        log.error("loading next page failed", pending.url, err);
        this.loadFailed = true;
        const { message, detail } = describeError(err);
        const actions: ViewAction[] = [
          {
            label: "重试",
            primary: true,
            onClick: () => {
              this.loadFailed = false;
              void this.loadMore();
            },
          },
          { label: "打开原网页", onClick: () => (location.href = pending.url) },
        ];
        this.view.setStatus("error", `${message}\n${detail}`, actions);
        return false;
      })
      .finally(() => {
        this.loading = undefined;
        if (stale && this.cursorId) this.prefetchAround(this.cursorId);
      });
    return this.loading;
  }

  /** Drops chapters well behind the cursor so long sessions stay light. */
  private trimBuffer(): void {
    const chapters = this.buffer.chapters;
    if (chapters.length <= MAX_CHAPTERS || !this.cursorId) return;
    const cur = this.buffer.get(this.cursorId);
    const ci = cur ? chapters.findIndex((c) => c.chapterId === cur.chapterId) : -1;
    const drop = Math.min(chapters.length - MAX_CHAPTERS, ci - 1);
    if (drop <= 0) return;
    for (const ch of this.buffer.dropBefore(drop)) this.view.removeChapter(ch.chapterId);
  }

  /** Picks the target paragraph among one page's paragraphs (snippet first, then index). */
  private pickParagraph(list: ReaderParagraph[], target: JumpTarget): ReaderParagraph | undefined {
    if (!list.length) return undefined;
    const idx = Math.min(Math.max(0, target.paragraphIndex), list.length - 1);
    const snippet = target.snippet;
    if (!snippet || list[idx].text?.startsWith(snippet)) return list[idx];
    let best: ReaderParagraph | undefined;
    let bestDistance = Infinity;
    list.forEach((p, i) => {
      if (p.text?.startsWith(snippet) && Math.abs(i - idx) < bestDistance) {
        best = p;
        bestDistance = Math.abs(i - idx);
      }
    });
    return best ?? list[idx];
  }

  /** Moves the cursor to a position, loading its page (and replacing the buffer) if needed. */
  private async jumpTo(target: JumpTarget): Promise<boolean> {
    const wasPlaying = this.player.isActive;
    const local =
      target.chapterId !== undefined
        ? this.pickParagraph(this.buffer.pageParagraphs(target.chapterId, target.pageIndex), target)
        : undefined;
    if (local) {
      this.moveCursorTo(local.id, wasPlaying);
      return true;
    }
    const url = target.url ?? this.adapter.pageUrl(this.buffer.bookId, target.chapterId!, target.pageIndex);
    const seq = ++this.jumpSeq;
    this.player.stop();
    this.view.showBanner("正在跳转…", []);
    try {
      const page = await this.adapter.fetchPage(url);
      if (seq !== this.jumpSeq) return false;
      this.view.hideBanner();
      this.resetBuffer();
      this.appendPage(page);
      const p =
        this.pickParagraph(this.buffer.pageParagraphs(page.chapterId, page.pageIndex), target) ?? this.buffer.first();
      if (p) this.moveCursorTo(p.id, wasPlaying);
      return true;
    } catch (err) {
      if (seq !== this.jumpSeq) return false;
      log.error("jump failed", url, err);
      const { message } = describeError(err);
      this.view.showBanner(`跳转失败：${message}`, [
        { label: "重试", primary: true, onClick: () => (this.view.hideBanner(), void this.jumpTo(target)) },
        { label: "关闭", onClick: () => this.view.hideBanner() },
      ]);
      return false;
    }
  }

  private moveCursorTo(id: string, play: boolean): void {
    // A paused utterance would otherwise resume at the old place.
    if (this.player.state === "paused") this.player.stop();
    this.view.setSelected(undefined);
    this.view.scrollToParagraph(id);
    this.setCursor(id);
    if (play) this.player.play(id);
    else this.player.select(id);
  }

  /** The user navigated on purpose: that answers any pending "continue?" prompt. */
  private navigating(): void {
    if (this.savingEnabled) return;
    this.view.hideBanner();
    this.savingEnabled = true;
  }

  // ---------------------------------------------------------------------------
  // Table of contents and page/chapter navigation

  private openToc(): void {
    this.view.openToc(this.tocState());
    void this.ensureCatalog().then(() => this.view.updateToc(this.tocState()));
  }

  private tocState(): TocState {
    const p = this.cursorParagraph();
    const ch = p ? this.buffer.chapterOf(p.id) : undefined;
    return {
      chapterId: p?.chapterId,
      chapterTitle: ch?.title,
      pageIndex: p?.pageIndex,
      pageCount: ch?.pageCount,
      catalog: this.catalog,
      loading: !!this.catalogLoading,
      error: this.catalogError,
    };
  }

  /** Loads the book's catalog once per session (on demand: it shares the page request queue). */
  private ensureCatalog(force = false): Promise<Catalog | undefined> {
    const bookId = this.buffer.bookId;
    if (!this.adapter.fetchCatalog || !bookId) return Promise.resolve(undefined);
    if (!force && this.catalog?.bookId === bookId) return Promise.resolve(this.catalog);
    if (this.catalogLoading) return this.catalogLoading;
    this.catalogError = undefined;
    this.catalogLoading = this.adapter
      .fetchCatalog(bookId)
      .then(
        (catalog) => (this.catalog = catalog),
        (err: unknown) => {
          log.error("catalog failed", err);
          this.catalogError = describeError(err).message;
          return undefined;
        },
      )
      .finally(() => {
        this.catalogLoading = undefined;
      });
    return this.catalogLoading;
  }

  private async tocStep(step: TocStep): Promise<void> {
    const cur = this.cursorParagraph();
    const ch = cur && this.buffer.chapterOf(cur.id);
    if (!cur || !ch) return;
    switch (step) {
      case "prev-page":
        if (cur.pageIndex > 0) {
          await this.jumpTo({ chapterId: cur.chapterId, pageIndex: cur.pageIndex - 1, paragraphIndex: 0 });
        } else if (ch.pageIndexes[0] === 0 && ch.prev && ch.prev.chapterId !== ch.chapterId) {
          // The site's "previous" from a chapter's first page: the previous chapter's last page.
          await this.jumpTo({ ...ch.prev, paragraphIndex: 0 });
        } else await this.stepChapter(-1);
        return;
      case "next-page":
        if (ch.pageCount !== undefined && cur.pageIndex + 1 >= ch.pageCount) await this.stepChapter(1);
        else await this.jumpTo({ chapterId: cur.chapterId, pageIndex: cur.pageIndex + 1, paragraphIndex: 0 });
        return;
      case "prev-chapter":
        return this.stepChapter(-1);
      case "next-chapter":
        return this.stepChapter(1);
    }
  }

  private async stepChapter(dir: 1 | -1): Promise<void> {
    const cur = this.cursorParagraph();
    const ch = cur && this.buffer.chapterOf(cur.id);
    if (!cur || !ch) return;
    const catalog = await this.ensureCatalog();
    const list = catalog ? catalog.volumes.flatMap((v) => v.chapters) : [];
    const idx = list.findIndex((c) => c.chapterId === cur.chapterId);
    if (idx >= 0) {
      const target = list[idx + dir];
      if (target) await this.gotoCatalogChapter(target);
      else this.view.setPlayerMessage(dir > 0 ? "已经是最后一章" : "已经是第一章");
      return;
    }
    // No usable catalog: follow the site's own links.
    if (dir < 0) {
      if (ch.pageIndexes[0] === 0 && ch.prev && ch.prev.chapterId !== ch.chapterId) {
        await this.jumpTo({ chapterId: ch.prev.chapterId, pageIndex: 0, paragraphIndex: 0 });
        return;
      }
    } else {
      const after = this.buffer.chapters[this.buffer.chapters.indexOf(ch) + 1];
      if (after) {
        await this.jumpTo({ chapterId: after.chapterId, pageIndex: after.pageIndexes[0] ?? 0, paragraphIndex: 0 });
        return;
      }
      const pending = this.buffer.pending;
      if (pending?.type === "next-chapter") {
        await this.jumpTo({ url: pending.url, pageIndex: 0, paragraphIndex: 0 });
        return;
      }
    }
    this.view.showBanner(`无法确定${dir > 0 ? "下" : "上"}一章（目录未能加载）`, [
      { label: "关闭", onClick: () => this.view.hideBanner() },
    ]);
  }

  private async gotoCatalogChapter(chapter: CatalogChapter): Promise<void> {
    if (chapter.chapterId) {
      await this.jumpTo({ chapterId: chapter.chapterId, pageIndex: 0, paragraphIndex: 0 });
      return;
    }
    // The site lists this chapter without a link: the next linked chapter's "previous" link leads to it.
    const list = this.catalog ? this.catalog.volumes.flatMap((v) => v.chapters) : [];
    const next = list.slice(list.indexOf(chapter) + 1).find((c) => c.chapterId && c.url);
    if (next?.url) {
      this.view.showBanner("正在查找这一章的链接…", []);
      try {
        const page = await this.adapter.fetchPage(next.url);
        if (page.prev && page.prev.chapterId !== page.chapterId) {
          chapter.chapterId = page.prev.chapterId;
          this.view.hideBanner();
          await this.jumpTo({ chapterId: page.prev.chapterId, pageIndex: 0, paragraphIndex: 0 });
          return;
        }
      } catch (err) {
        log.warn("could not resolve chapter link", err);
      }
    }
    this.view.showBanner("网站目录中这一章没有链接", [{ label: "关闭", onClick: () => this.view.hideBanner() }]);
  }

  /** "Previous page/chapter" button above the loaded content. */
  private renderTopNav(): void {
    const first = this.buffer.chapters[0];
    const page = first?.pageIndexes[0] ?? 0;
    this.view.setTopNav(first && page > 0 ? `↑ 本章上一页（第 ${page} 页）` : first?.prev ? "↑ 上一章" : undefined);
  }

  private topNav(): void {
    const first = this.buffer.chapters[0];
    if (!first) return;
    this.navigating();
    const page = first.pageIndexes[0] ?? 0;
    if (page > 0) void this.jumpTo({ chapterId: first.chapterId, pageIndex: page - 1, paragraphIndex: 0 });
    else if (first.prev) void this.jumpTo({ ...first.prev, paragraphIndex: 0 });
  }

  // ---------------------------------------------------------------------------
  // Progress restore

  private async offerRestore(page: PageContent): Promise<void> {
    const saved = await this.progress.get(page.bookId);
    this.knownUpdatedAt = saved?.updatedAt ?? 0;
    this.savingEnabled = true;
    const tab = readTabPosition();
    // (The shared record of this same position is written a moment after the tab's own copy.)
    if (tab && tab.bookId === page.bookId && (!saved || tab.updatedAt >= saved.updatedAt - 5000)) {
      // This tab was reloaded/restored (e.g. Safari dropped it in the background): its own position is the newest.
      await this.restoreTo(page, { ...tab });
      return;
    }
    if (!saved) {
      this.dirty = true;
      this.saveSoon();
      return;
    }
    const target: JumpTarget = {
      chapterId: saved.chapterId,
      pageIndex: saved.pageIndex,
      paragraphIndex: saved.paragraphIndex,
      snippet: saved.snippet,
    };
    if (saved.chapterId === page.chapterId) {
      await this.restoreTo(page, target);
      return;
    }
    this.savingEnabled = false;
    this.promptRestore(saved, target);
  }

  /** Silently moves to a position in (or near) the page that was just loaded. */
  private async restoreTo(page: PageContent, target: JumpTarget): Promise<void> {
    if (target.chapterId === page.chapterId && target.pageIndex === page.pageIndex) {
      const p = this.pickParagraph(this.buffer.pageParagraphs(page.chapterId, page.pageIndex), target);
      if (p && p.id !== this.cursorId) {
        this.view.scrollToParagraph(p.id);
        this.setCursor(p.id, { save: false });
        this.player.select(p.id);
      }
    } else if (await this.jumpTo(target)) {
      // E.g. the tab reopened at the chapter's first page.
      this.view.setPlayerMessage("已回到上次阅读位置");
    }
  }

  private promptRestore(saved: SavedProgress, target: JumpTarget): void {
    const page = saved.pageIndex > 0 ? ` 第 ${saved.pageIndex + 1} 页` : "";
    this.scrollReportsWhilePrompt = 0;
    this.view.showBanner(`上次读到「${saved.chapterTitle || `章节 ${saved.chapterId}`}」${page}，要继续吗？`, [
      {
        label: "继续",
        primary: true,
        onClick: () => {
          this.view.hideBanner();
          this.savingEnabled = true;
          void this.jumpTo(target);
        },
      },
      { label: "留在此处", onClick: () => this.acceptCurrentPosition() },
    ]);
  }

  /** The user chose (explicitly or by reading on) to stay where they are. */
  private acceptCurrentPosition(): void {
    if (this.savingEnabled) return;
    this.view.hideBanner();
    this.savingEnabled = true;
    this.dirty = true;
    this.saveSoon();
  }

  /**
   * Another tab (or device sharing the storage) saved newer progress for this
   * book while this one sat in the background: offer to go there instead of
   * silently overwriting it.
   */
  private async checkExternalProgress(): Promise<void> {
    if (!this.active || !this.savingEnabled || !this.buffer.bookId || this.player.isActive) return;
    const saved = await this.progress.get(this.buffer.bookId);
    if (!saved || saved.updatedAt <= this.knownUpdatedAt) return;
    this.knownUpdatedAt = saved.updatedAt;
    const cur = this.cursorParagraph();
    if (
      cur &&
      cur.chapterId === saved.chapterId &&
      cur.pageIndex === saved.pageIndex &&
      Math.abs(cur.indexInPage - saved.paragraphIndex) <= 2
    ) {
      return;
    }
    this.dirty = false;
    const page = saved.pageIndex > 0 ? ` 第 ${saved.pageIndex + 1} 页` : "";
    this.view.showBanner(`在其他页面读到了「${saved.chapterTitle || `章节 ${saved.chapterId}`}」${page}，要跳过去吗？`, [
      {
        label: "跳转",
        primary: true,
        onClick: () => {
          this.view.hideBanner();
          void this.jumpTo({
            chapterId: saved.chapterId,
            pageIndex: saved.pageIndex,
            paragraphIndex: saved.paragraphIndex,
            snippet: saved.snippet,
          });
        },
      },
      {
        label: "留在此处",
        onClick: () => {
          this.view.hideBanner();
          this.dirty = true;
          this.saveSoon();
        },
      },
    ]);
  }

  // ---------------------------------------------------------------------------
  // Cursor

  /**
   * Play/pause. Resuming continues the paused paragraph only while it is still
   * on screen; if the user has scrolled or navigated elsewhere since, playback
   * starts where they are now (the cursor) instead of jumping back.
   */
  private togglePlay(): void {
    this.acceptCurrentPosition();
    if (this.player.state === "error") this.loadFailed = false;
    const at = this.player.currentId;
    const cur = this.cursorId;
    if (!this.player.isActive && this.player.state !== "idle" && cur && at && cur !== at && !this.view.isOnScreen(at)) {
      this.view.setSelected(undefined);
      this.player.play(cur);
      return;
    }
    this.player.toggle();
  }

  private onUserScrolledTo(id: string): void {
    if (this.view.bannerVisible && !this.savingEnabled && ++this.scrollReportsWhilePrompt >= AUTO_ACCEPT_SCROLLS) {
      this.acceptCurrentPosition();
    }
    if (this.player.isActive) {
      // Listening: the spoken paragraph stays the cursor, but still prefetch while browsing ahead.
      this.prefetchAround(id);
      return;
    }
    this.setCursor(id);
  }

  private onParagraphTap(id: string): void {
    if (this.player.isActive) {
      this.player.play(id);
      return;
    }
    this.view.setSelected(id);
    this.player.select(id);
    this.setCursor(id);
    this.view.showChip(id);
  }

  private setCursor(id: string, opts: { save?: boolean } = {}): void {
    const p = this.buffer.get(id);
    if (!p) return;
    const prev = this.cursorId ? this.buffer.get(this.cursorId) : undefined;
    this.cursorId = id;
    if (!prev || prev.chapterId !== p.chapterId) {
      this.view.setTitles(this.buffer.bookTitle, this.buffer.chapterOf(id)?.title);
      this.updateMediaMetadata(this.buffer.chapterOf(id)?.title);
    }
    this.syncUrl(id);
    this.prefetchAround(id);
    if (opts.save !== false) {
      this.dirty = true;
      this.saveSoon();
    }
  }

  private prefetchAround(id: string): void {
    if (!this.loadFailed && this.buffer.remainingAfter(id) < PREFETCH_REMAINING) void this.loadMore();
  }

  /** Mirrors the current site page in the address bar without reloading or adding history. */
  private syncUrl(id: string): void {
    if (!this.active) return;
    const p = this.buffer.get(id);
    if (!p) return;
    if (location.href !== p.pageUrl) {
      try {
        history.replaceState(history.state, "", p.pageUrl);
      } catch (err) {
        log.debug("replaceState failed", err);
      }
    }
    const chapter = this.buffer.chapterOf(id);
    const title = [chapter?.title, this.buffer.bookTitle].filter(Boolean).join(" - ");
    if (title && document.title !== title) document.title = title;
  }

  private async saveNow(): Promise<void> {
    if (!this.savingEnabled || !this.dirty || !this.cursorId) return;
    const p: ReaderParagraph | undefined = this.buffer.get(this.cursorId);
    if (!p) return;
    this.dirty = false;
    this.writeTabPosition(p);
    const saved = await this.progress.save(
      { bookId: this.buffer.bookId, chapterId: p.chapterId, pageIndex: p.pageIndex, paragraphIndex: p.indexInPage },
      {
        bookTitle: this.buffer.bookTitle,
        chapterTitle: this.buffer.chapterOf(p.id)?.title,
        url: p.pageUrl,
        snippet: snippetOf(p),
      },
    );
    this.knownUpdatedAt = Math.max(this.knownUpdatedAt, saved.updatedAt);
    log.debug("progress saved", p.id);
  }

  /** Synchronous, per tab: lands even if the page is frozen before the async store finishes. */
  private writeTabPosition(p: ReaderParagraph): void {
    if (!this.active) return;
    const pos: TabPosition = {
      bookId: this.buffer.bookId,
      chapterId: p.chapterId,
      pageIndex: p.pageIndex,
      paragraphIndex: p.indexInPage,
      snippet: snippetOf(p),
      updatedAt: Date.now(),
    };
    try {
      const state = (history.state as Record<string, unknown> | null) ?? {};
      history.replaceState({ ...state, [TAB_STATE_KEY]: pos }, "", p.pageUrl);
    } catch (err) {
      log.debug("replaceState failed", err);
    }
  }

  private updateSettings(s: Settings): void {
    const prev = this.settings;
    this.settings = s;
    this.view.applySettings(s);
    void this.settingsStore.save(s);
    if (prev.azureBuffer !== s.azureBuffer) for (const slot of Object.values(this.cloud)) slot.engine.setPrefetchCount(s.azureBuffer);
    const engineChanged =
      prev.ttsEngine !== s.ttsEngine ||
      prev.azureRegion !== s.azureRegion ||
      prev.azureVoice !== s.azureVoice ||
      prev.googleVoice !== s.googleVoice;
    if (engineChanged) {
      this.applyEngine();
      if (prev.googleVoice !== s.googleVoice) this.renderUsage("google");
      const provider = s.ttsEngine;
      if (provider !== "system" && (prev.ttsEngine !== provider || prev.azureRegion !== s.azureRegion)) {
        void this.refreshCloudVoices(provider);
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Speech engines

  private withFallback(provider: CloudProvider, engine: CloudSpeechEngine): FallbackSpeechEngine {
    const name = provider === "azure" ? "Azure" : "Google";
    return new FallbackSpeechEngine(engine, this.webEngine, {
      onFallback: (code, retryAt) => {
        const when = Number.isFinite(retryAt)
          ? `，${Math.max(1, Math.round((retryAt - Date.now()) / 60_000))} 分钟内自动重试`
          : "，请检查设置";
        const msg = `${this.cloud[provider].describe(code)}，暂用系统语音${when}`;
        log.warn(msg);
        this.view.setPlayerMessage(msg);
        this.view.setCloudState(provider, { status: msg, fallback: true });
      },
      onRecover: () => {
        this.view.setPlayerMessage(`已恢复 ${name} 语音`);
        this.view.setCloudState(provider, { status: `已恢复 ${name} 语音`, fallback: false });
      },
    });
  }

  private renderUsage(provider: CloudProvider): void {
    this.view.setCloudState(provider, { usage: this.cloud[provider].usageText() });
  }

  private currentEngine(): SpeechEngine {
    const t = this.settings.ttsEngine;
    return t === "system" ? this.webEngine : this.cloud[t].withFallback;
  }

  /** Selects the engine for the current settings; a fresh choice retries the cloud service after a fallback. */
  private applyEngine(): void {
    for (const provider of ["azure", "google"] as const) {
      const slot = this.cloud[provider];
      slot.withFallback.reset();
      slot.engine.setPrefetchCount(this.settings.azureBuffer);
      this.view.setCloudState(provider, {
        fallback: false,
        status: this.settings.ttsEngine === provider && !slot.key ? "请先填写密钥" : "",
      });
    }
    const engine = this.currentEngine();
    // Either way the current chunk restarts with the new engine/voice when playing.
    if (this.player.engineIs(engine)) this.player.restartCurrent();
    else this.player.setEngine(engine);
  }

  private async setCloudKey(provider: CloudProvider, key: string): Promise<void> {
    const slot = this.cloud[provider];
    slot.key = key;
    await this.secrets.set(slot.secret, key);
    this.view.setCloudState(provider, { keySet: !!key });
    this.applyEngine();
    if (key) void this.refreshCloudVoices(provider);
  }

  private async refreshCloudVoices(provider: CloudProvider): Promise<void> {
    const slot = this.cloud[provider];
    if (!slot.key) return;
    try {
      const voices = await slot.listVoices(slot.key);
      const where = provider === "azure" ? `（${this.settings.azureRegion}）` : "";
      this.view.setCloudState(provider, { voices, status: `已连接 ${slot.name}${where}` });
    } catch (err) {
      const code = err instanceof SpeechEngineError ? err.code : String(err);
      this.view.setCloudState(provider, { status: `无法获取声音列表：${slot.describe(code)}` });
    }
  }

  /** Plays a sample sentence with the configured cloud voice (runs inside the tap). */
  private testCloudVoice(provider: CloudProvider): void {
    const slot = this.cloud[provider];
    this.player.pause();
    slot.engine.unlock();
    this.view.setCloudState(provider, { status: "正在试听…" });
    slot.engine
      .speak(slot.sample, { rate: this.settings.rate })
      .then(() => this.view.setCloudState(provider, { status: "试听完成" }))
      .catch((err: unknown) => {
        const code = err instanceof SpeechEngineError ? err.code : String(err);
        this.view.setCloudState(provider, { status: `试听失败：${slot.describe(code)}` });
      });
  }

  /** Copies troubleshooting info (no book text) to the clipboard. */
  private copyDiagnostics(): void {
    const data = JSON.stringify(
      {
        version: this.version,
        userAgent: navigator.userAgent,
        url: location.href,
        engine: this.settings.ttsEngine,
        cloudFallback: this.settings.ttsEngine === "system" ? null : (this.cloud[this.settings.ttsEngine].withFallback.fallbackReason ?? null),
        loads: this.adapter.getDiagnostics?.() ?? [],
      },
      null,
      1,
    );
    const done = () => this.view.setPlayerMessage("诊断信息已复制");
    navigator.clipboard?.writeText(data).then(done, () => window.prompt("复制以下诊断信息", data));
    if (!navigator.clipboard) window.prompt("复制以下诊断信息", data);
  }

  /** Lock-screen / Control Center controls (effective while a cloud voice's audio element plays). */
  private setupMediaSession(): void {
    const ms = (navigator as Navigator & { mediaSession?: MediaSession }).mediaSession;
    if (!ms) return;
    const handlers: [MediaSessionAction, () => void][] = [
      ["play", () => !this.player.isActive && this.togglePlay()],
      ["pause", () => this.player.pause()],
      ["nexttrack", () => this.player.nextParagraph()],
      ["previoustrack", () => this.player.previousParagraph()],
    ];
    for (const [action, fn] of handlers) {
      try {
        ms.setActionHandler(action, fn);
      } catch {
        /* unsupported action */
      }
    }
  }

  private updateMediaMetadata(chapterTitle?: string): void {
    const ms = (navigator as Navigator & { mediaSession?: MediaSession }).mediaSession;
    if (!ms || typeof MediaMetadata === "undefined") return;
    try {
      ms.metadata = new MediaMetadata({ title: chapterTitle || this.buffer.bookTitle, artist: this.buffer.bookTitle });
    } catch {
      /* ignore */
    }
  }

  // ---------------------------------------------------------------------------
  // PlaybackSource

  cursor(): string | undefined {
    return this.cursorId;
  }

  textOf(id: string): string | undefined {
    return this.buffer.get(id)?.text;
  }

  next(id: string): string | "pending" | "end" {
    const n = this.buffer.next(id);
    return typeof n === "string" ? n : n.id;
  }

  prev(id: string): string | undefined {
    return this.buffer.prev(id)?.id;
  }
}
