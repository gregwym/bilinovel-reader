import { FetchError, ParseError, type PageContent, type SiteAdapter } from "../adapters/types";
import { SpeechPlayer, type PlaybackSource } from "../speech/SpeechPlayer";
import { WebSpeechEngine } from "../speech/SpeechEngine";
import { VoiceManager } from "../speech/VoiceManager";
import { ReaderView, type ViewAction } from "../ui/ReaderView";
import { debounce } from "../utils/async";
import { log } from "../utils/log";
import { ChapterBuffer, type ReaderParagraph } from "./ChapterBuffer";
import { ProgressStore, SettingsStore, type ReaderPosition, type SavedProgress, type Settings } from "./ProgressStore";

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
    const engine = new WebSpeechEngine(globalThis.speechSynthesis, (uri) => this.voices.resolve(uri));
    this.player = new SpeechPlayer(engine, this, {
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
        onOpenOriginal: () => this.openOriginal(),
        onRestartChapter: () => {
          const p = this.cursorId ? this.buffer.get(this.cursorId) : undefined;
          if (p) void this.jumpTo({ bookId: this.buffer.bookId, chapterId: p.chapterId, pageIndex: 0, paragraphIndex: 0 });
        },
      },
      { fontSize: 20, lineHeight: 1.8, theme: "system", fontFamily: "sans", rate: 1 },
      version,
    );
  }

  // ---------------------------------------------------------------------------
  // Lifecycle

  async start(): Promise<void> {
    this.settings = await this.settingsStore.load();
    this.view.mount();
    this.view.applySettings(this.settings);
    this.view.setTitles("Bili Reader", "正在加载…");
    this.view.show();
    this.active = true;
    this.player.setRate(this.settings.rate);
    this.player.setVoice(this.settings.voiceURI);
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

  /**
   * The server HTML of the current URL is re-fetched (usually from the HTTP
   * cache) so the first page goes through exactly the same parser as every
   * following page. If that fails, fall back to the rendered DOM.
   */
  private async fetchCurrentPage(): Promise<PageContent> {
    try {
      return await this.adapter.fetchPage(location.href);
    } catch (err) {
      log.warn("re-fetching the current page failed; parsing the rendered page instead", err);
      try {
        return await this.adapter.parseRenderedDocument(document, new URL(location.href));
      } catch (fallbackErr) {
        log.warn("rendered page parse failed too", fallbackErr);
        throw err;
      }
    }
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
    this.settings = s;
    this.view.applySettings(s);
    void this.settingsStore.save(s);
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
