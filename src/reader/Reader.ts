import { FetchError, ParseError, type PageContent, type SiteAdapter } from "../adapters/types";
import { SpeechPlayer, type PlaybackSource } from "../speech/SpeechPlayer";
import { WebSpeechEngine, type SpeechEngine } from "../speech/SpeechEngine";
import {
  AzureSpeechEngine,
  AzureUsageMeter,
  describeAzureError,
  listAzureChineseVoices,
} from "../speech/AzureSpeechEngine";
import { FallbackSpeechEngine } from "../speech/FallbackSpeechEngine";
import { SpeechEngineError } from "../speech/SpeechEngine";
import { VoiceManager } from "../speech/VoiceManager";
import { ReaderView, type ViewAction } from "../ui/ReaderView";
import { debounce } from "../utils/async";
import { log } from "../utils/log";
import { ChapterBuffer, type ReaderParagraph } from "./ChapterBuffer";
import {
  AZURE_KEY_SECRET,
  DEFAULT_SETTINGS,
  ProgressStore,
  SecretStore,
  SettingsStore,
  type ReaderPosition,
  type SavedProgress,
  type Settings,
} from "./ProgressStore";

/** Prefetch the next site page when this few paragraphs remain loaded ahead of the cursor. */
const PREFETCH_REMAINING = 8;
/** Rolling buffer: chapters kept in memory/DOM. */
const MAX_CHAPTERS = 4;

export const EXITED_URL_KEY = "biliReader.exitedUrl";

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
  private readonly azureEngine: AzureSpeechEngine;
  private readonly azureWithFallback: FallbackSpeechEngine;
  private readonly secrets = new SecretStore();
  private readonly usage = new AzureUsageMeter();
  private azureKey = "";
  private settings!: Settings;
  private cursorId?: string;
  private loading?: Promise<boolean>;
  private loadFailed = false;
  /** Saving is held back while the "continue where you left off?" prompt is open. */
  private savingEnabled = false;
  private scrollReportsWhilePrompt = 0;
  private readonly originalUrl = location.href;
  private readonly originalTitle = document.title;
  private active = false;

  private readonly saveSoon = debounce(() => void this.saveNow(), 800);

  constructor(
    private readonly adapter: SiteAdapter,
    private readonly progress = new ProgressStore(),
    private readonly settingsStore = new SettingsStore(),
    version = "dev",
  ) {
    this.webEngine = new WebSpeechEngine(globalThis.speechSynthesis, (uri) => this.voices.resolve(uri));
    this.azureEngine = new AzureSpeechEngine(
      () =>
        this.azureKey
          ? { key: this.azureKey, region: this.settings.azureRegion, voice: this.settings.azureVoice }
          : undefined,
      { onUsage: (chars) => this.view.setAzureState({ usage: this.usage.add(chars) }) },
    );
    this.azureWithFallback = new FallbackSpeechEngine(this.azureEngine, this.webEngine, (code) => {
      const msg = `${describeAzureError(code)}，已改用系统语音`;
      log.warn(msg);
      this.view.setPlayerMessage(msg);
      this.view.setAzureState({ status: msg });
    });
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
        onTogglePlay: () => {
          this.acceptCurrentPosition();
          if (this.player.state === "error") this.loadFailed = false;
          this.player.toggle();
        },
        onPrev: () => this.player.previousParagraph(),
        onNext: () => this.player.nextParagraph(),
        onRate: (rate) => {
          this.updateSettings({ ...this.settings, rate });
          this.player.setRate(rate);
        },
        onVoice: (uri) => this.player.setVoice(uri),
        onSettings: (s) => this.updateSettings(s),
        onAzureKey: (key) => void this.setAzureKey(key),
        onAzureTest: () => this.testAzureVoice(),
        onOpenOriginal: () => this.openOriginal(),
        onRestartChapter: () => {
          const p = this.cursorId ? this.buffer.get(this.cursorId) : undefined;
          if (p) void this.jumpTo({ bookId: this.buffer.bookId, chapterId: p.chapterId, pageIndex: 0, paragraphIndex: 0 });
        },
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
    this.azureKey = (await this.secrets.get(AZURE_KEY_SECRET)) ?? "";
    this.view.setAzureState({ keySet: !!this.azureKey, usage: this.usage.get() });
    this.applyEngine();
    if (this.settings.ttsEngine === "azure") void this.refreshAzureVoices();
    this.setupMediaSession();
    this.view.setVoices(this.voices.list());
    this.voices.onChange(() => this.view.setVoices(this.voices.list()));

    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible") this.player.recoverIfStalled();
      else void this.saveNow();
    });
    window.addEventListener("pagehide", () => void this.saveNow());

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
    this.buffer.reset();
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
    this.loading = this.adapter
      .fetchPage(pending.url)
      .then((page) => {
        this.loadFailed = false;
        this.appendPage(page);
        return true;
      })
      .catch((err: unknown) => {
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

  /** Moves to a saved/selected position, loading its page if it is not in the buffer. */
  private async jumpTo(pos: ReaderPosition): Promise<void> {
    const local = this.buffer.find(pos.chapterId, pos.pageIndex, pos.paragraphIndex);
    if (local) {
      this.view.scrollToParagraph(local.id);
      this.setCursor(local.id);
      return;
    }
    this.player.stop();
    const url = this.adapter.pageUrl(pos.bookId, pos.chapterId, pos.pageIndex);
    this.view.setStatus("loading", "正在跳转…");
    try {
      const page = await this.adapter.fetchPage(url);
      this.buffer.reset();
      this.view.clearContent();
      this.appendPage(page);
      const chapter = this.buffer.chapters[0];
      this.view.setTitles(this.buffer.bookTitle, chapter?.title);
      const target =
        this.buffer.find(pos.chapterId, pos.pageIndex, Math.min(pos.paragraphIndex, page.paragraphs.length - 1)) ??
        this.buffer.first();
      if (target) {
        this.view.scrollToParagraph(target.id);
        this.setCursor(target.id);
      }
    } catch (err) {
      log.error("jump failed", url, err);
      this.renderTailStatus();
      const { message } = describeError(err);
      this.view.showBanner(`跳转失败：${message}`, [
        { label: "重试", primary: true, onClick: () => (this.view.hideBanner(), void this.jumpTo(pos)) },
        { label: "关闭", onClick: () => this.view.hideBanner() },
      ]);
    }
  }

  // ---------------------------------------------------------------------------
  // Progress restore

  private async offerRestore(page: PageContent): Promise<void> {
    const saved = await this.progress.get(page.bookId);
    if (!saved) {
      this.savingEnabled = true;
      this.saveSoon();
      return;
    }
    if (saved.chapterId === page.chapterId && saved.pageIndex === page.pageIndex) {
      // Same page: restore silently.
      this.savingEnabled = true;
      const p = this.buffer.find(saved.chapterId, saved.pageIndex, saved.paragraphIndex);
      if (p && saved.paragraphIndex > 0) {
        this.view.scrollToParagraph(p.id);
        this.setCursor(p.id);
      }
      return;
    }
    this.promptRestore(page, saved);
  }

  private promptRestore(page: PageContent, saved: SavedProgress): void {
    const where =
      saved.chapterId === page.chapterId
        ? `本章第 ${saved.pageIndex + 1} 页`
        : `「${saved.chapterTitle || `章节 ${saved.chapterId}`}」`;
    this.scrollReportsWhilePrompt = 0;
    this.view.showBanner(`上次读到${where}，要继续吗？`, [
      {
        label: "继续",
        primary: true,
        onClick: () => {
          this.view.hideBanner();
          this.savingEnabled = true;
          void this.jumpTo({ bookId: page.bookId, ...saved });
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
    this.saveSoon();
  }

  // ---------------------------------------------------------------------------
  // Cursor

  private onUserScrolledTo(id: string): void {
    if (this.view.bannerVisible && !this.savingEnabled && ++this.scrollReportsWhilePrompt >= 6) {
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
    if (opts.save !== false) this.saveSoon();
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
    if (!this.savingEnabled || !this.cursorId) return;
    const p: ReaderParagraph | undefined = this.buffer.get(this.cursorId);
    if (!p) return;
    await this.progress.save(
      { bookId: this.buffer.bookId, chapterId: p.chapterId, pageIndex: p.pageIndex, paragraphIndex: p.indexInPage },
      { bookTitle: this.buffer.bookTitle, chapterTitle: this.buffer.chapterOf(p.id)?.title, url: p.pageUrl },
    );
    log.debug("progress saved", p.id);
  }

  private updateSettings(s: Settings): void {
    const prev = this.settings;
    this.settings = s;
    this.view.applySettings(s);
    void this.settingsStore.save(s);
    const azureChanged =
      prev.ttsEngine !== s.ttsEngine || prev.azureRegion !== s.azureRegion || prev.azureVoice !== s.azureVoice;
    if (azureChanged) {
      this.applyEngine();
      if (s.ttsEngine === "azure" && (prev.ttsEngine !== "azure" || prev.azureRegion !== s.azureRegion)) {
        void this.refreshAzureVoices();
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Speech engines

  private currentEngine(): SpeechEngine {
    return this.settings.ttsEngine === "azure" ? this.azureWithFallback : this.webEngine;
  }

  /** Selects the engine for the current settings; a fresh choice retries Azure after a fallback. */
  private applyEngine(): void {
    this.azureWithFallback.reset();
    this.view.setAzureState({ status: this.settings.ttsEngine === "azure" && !this.azureKey ? "请先填写密钥" : "" });
    const engine = this.currentEngine();
    // Either way the current chunk restarts with the new engine/voice when playing.
    if (this.player.engineIs(engine)) this.player.restartCurrent();
    else this.player.setEngine(engine);
  }

  private async setAzureKey(key: string): Promise<void> {
    this.azureKey = key;
    await this.secrets.set(AZURE_KEY_SECRET, key);
    this.view.setAzureState({ keySet: !!key });
    this.applyEngine();
    if (key) void this.refreshAzureVoices();
  }

  private async refreshAzureVoices(): Promise<void> {
    if (!this.azureKey) return;
    try {
      const voices = await listAzureChineseVoices({ key: this.azureKey, region: this.settings.azureRegion });
      this.view.setAzureState({ voices, status: `已连接 Azure（${this.settings.azureRegion}）` });
    } catch (err) {
      const code = err instanceof SpeechEngineError ? err.code : String(err);
      this.view.setAzureState({ status: `无法获取声音列表：${describeAzureError(code)}` });
    }
  }

  /** Plays a sample sentence with the configured Azure voice (runs inside the tap). */
  private testAzureVoice(): void {
    this.player.pause();
    this.azureEngine.unlock();
    this.view.setAzureState({ status: "正在试听…" });
    this.azureEngine
      .speak("你好，这是 Azure 神经网络语音的试听。轻小说朗读听起来会是这个样子。", { rate: this.settings.rate })
      .then(() => this.view.setAzureState({ status: "试听完成" }))
      .catch((err: unknown) => {
        const code = err instanceof SpeechEngineError ? err.code : String(err);
        this.view.setAzureState({ status: `试听失败：${describeAzureError(code)}` });
      });
  }

  /** Lock-screen / Control Center controls (effective while the Azure audio element plays). */
  private setupMediaSession(): void {
    const ms = (navigator as Navigator & { mediaSession?: MediaSession }).mediaSession;
    if (!ms) return;
    const handlers: [MediaSessionAction, () => void][] = [
      ["play", () => this.player.toggle()],
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
