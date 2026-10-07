import type { FrameHost, Paragraph } from "../adapters/types";
import type { PlayerState } from "../speech/SpeechPlayer";
import type { VoiceInfo } from "../speech/VoiceManager";
import { AZURE_PRESET_VOICES, AzureUsageMeter, type AzureVoice } from "../speech/AzureSpeechEngine";
import {
  FONT_SIZE_RANGE,
  LINE_HEIGHT_OPTIONS,
  RATE_OPTIONS,
  type Settings,
  type Theme,
} from "../reader/ProgressStore";
import { h, svg } from "../utils/dom";
import { ICONS } from "./icons";
import css from "./styles.css?inline";

export interface ViewAction {
  label: string;
  onClick: () => void;
  primary?: boolean;
}

export interface ViewCallbacks {
  onExit(): void;
  onReenter(): void;
  onNearEnd(): void;
  /** Topmost visible paragraph changed because the user scrolled. */
  onVisibleParagraph(id: string): void;
  onParagraphTap(id: string): void;
  onReadFromHere(id: string): void;
  onTogglePlay(): void;
  onPrev(): void;
  onNext(): void;
  onRate(rate: number): void;
  onVoice(voiceURI: string | undefined): void;
  onSettings(settings: Settings): void;
  /** New Azure key entered (empty string clears it). */
  onAzureKey(key: string): void;
  /** Speak a short sample with the Azure voice (called from a tap). */
  onAzureTest(): void;
  /** Try Azure again now after it fell back to the system voice. */
  onAzureRetry(): void;
  onCopyDiagnostics(): void;
  onOpenOriginal(): void;
  onRestartChapter(): void;
}

export const formatRate = (r: number): string => `${Number.isInteger(r * 10) ? r.toFixed(1) : String(r)}x`;

export type StatusKind = "idle" | "loading" | "error" | "end";

const USER_SCROLL_GRACE_MS = 4000;

/**
 * All DOM for the reader, mounted in a Shadow DOM so the site's CSS cannot
 * leak in (and ours cannot leak out). The original page is only hidden by an
 * overlay plus a reversible scroll lock; it is never modified.
 */
export class ReaderView {
  private host!: HTMLElement;
  private shadow!: ShadowRoot;
  private root!: HTMLElement;
  private titleEl!: HTMLElement;
  private subtitleEl!: HTMLElement;
  private bannerEl!: HTMLElement;
  private scrollEl!: HTMLElement;
  private contentEl!: HTMLElement;
  private statusEl!: HTMLElement;
  private sentinel!: HTMLElement;
  private chipEl!: HTMLButtonElement;
  private playerEl!: HTMLElement;
  private playerStatusEl!: HTMLElement;
  private playBtn!: HTMLButtonElement;
  private rateLabel!: HTMLElement;
  private rateSelect!: HTMLSelectElement;
  private sheetEl?: HTMLElement;
  private pillEl!: HTMLButtonElement;
  private fatalEl?: HTMLElement;
  private frameLayer!: HTMLElement;
  private frameMessage!: HTMLElement;
  private frameCancel?: () => void;

  /** Paragraph elements in document order, for fast visibility lookup. */
  private paraEls: HTMLElement[] = [];
  private byId = new Map<string, HTMLElement>();
  private activeId?: string;
  private selectedId?: string;
  private lastUserScroll = 0;
  private lastReportedTop?: string;
  private scrollRaf = 0;
  private chipTimer?: ReturnType<typeof setTimeout>;
  private savedPageStyles?: { html: string; body: string };
  private voices: VoiceInfo[] = [];
  private azureVoices: AzureVoice[] = AZURE_PRESET_VOICES;
  private azureKeySet = false;
  private azureStatus = "";
  private azureUsage = 0;
  private azureFallback = false;
  private systemDark = globalThis.matchMedia?.("(prefers-color-scheme: dark)");

  constructor(
    private readonly cb: ViewCallbacks,
    private settings: Settings,
    private readonly version: string,
  ) {}

  mount(): void {
    this.host = h("div", { id: "bili-reader-host" });
    this.host.style.cssText =
      "all:initial;position:fixed;top:0;left:0;width:0;height:0;z-index:2147483647;";
    this.shadow = this.host.attachShadow({ mode: "open" });
    this.shadow.append(h("style", {}, css));
    this.build();
    document.documentElement.append(this.host);
    this.applySettings(this.settings);
    this.systemDark?.addEventListener?.("change", () => this.applyTheme());
  }

  private build(): void {
    const iconBtn = (icon: string, label: string, onClick: () => void) =>
      h("button", { class: "br-icon-btn", "aria-label": label, title: label, onclick: onClick }, svg(icon));

    this.titleEl = h("span", {}, "");
    this.subtitleEl = h("span", { class: "br-subtitle" }, "");
    const top = h(
      "header",
      { class: "br-top" },
      iconBtn(ICONS.back, "退出阅读模式", () => this.cb.onExit()),
      h("div", { class: "br-title" }, this.titleEl, this.subtitleEl),
      iconBtn(ICONS.more, "设置", () => this.openSheet()),
    );

    this.bannerEl = h("div", { class: "br-banner", hidden: true });
    this.contentEl = h("article", { class: "br-content", lang: "zh" });
    this.statusEl = h("div", { class: "br-status" });
    this.sentinel = h("div", { class: "br-sentinel" });
    this.scrollEl = h("main", { class: "br-scroll" }, this.contentEl, this.statusEl, this.sentinel);

    this.chipEl = h("button", { class: "br-chip", hidden: true }, "▶ 从这里开始朗读");
    this.chipEl.addEventListener("click", () => {
      const id = this.chipEl.dataset.id;
      this.hideChip();
      if (id) this.cb.onReadFromHere(id);
    });

    this.rateLabel = h("span", {}, "1.0x");
    this.rateSelect = h("select", { "aria-label": "语速" });
    for (const r of RATE_OPTIONS) this.rateSelect.append(h("option", { value: String(r) }, formatRate(r)));
    this.rateSelect.addEventListener("change", () => this.cb.onRate(Number(this.rateSelect.value)));

    this.playBtn = h("button", { class: "br-play", "aria-label": "播放", onclick: () => this.cb.onTogglePlay() });
    this.playBtn.append(svg(ICONS.play));
    this.playerStatusEl = h("div", { class: "br-player-status" });
    this.playerEl = h(
      "footer",
      { class: "br-player", "data-state": "idle" },
      this.playerStatusEl,
      h(
        "div",
        { class: "br-player-controls" },
        h("label", { class: "br-rate" }, this.rateLabel, this.rateSelect),
        iconBtn(ICONS.prev, "上一段", () => this.cb.onPrev()),
        this.playBtn,
        iconBtn(ICONS.next, "下一段", () => this.cb.onNext()),
        h("span"),
      ),
    );

    this.frameMessage = h("span", {}, "");
    this.frameLayer = h(
      "div",
      { class: "br-frame-layer" },
      h(
        "div",
        { class: "br-frame-bar" },
        this.frameMessage,
        h("button", { class: "br-btn", onclick: () => this.frameCancel?.() }, "取消"),
      ),
    );
    this.root = h(
      "div",
      { class: "br-root" },
      top,
      this.bannerEl,
      this.scrollEl,
      this.chipEl,
      this.playerEl,
      this.frameLayer,
    );
    this.pillEl = h("button", { class: "br-pill", hidden: true, onclick: () => this.cb.onReenter() }, "📖 阅读模式");
    this.shadow.append(this.root, this.pillEl);

    this.scrollEl.addEventListener("scroll", () => this.onScroll(), { passive: true });
    for (const ev of ["touchstart", "touchmove", "wheel"]) {
      this.scrollEl.addEventListener(ev, () => (this.lastUserScroll = Date.now()), { passive: true });
    }
    this.contentEl.addEventListener("click", (ev) => this.onContentClick(ev));

    new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) this.cb.onNearEnd();
      },
      { root: this.scrollEl, rootMargin: "0px 0px 150% 0px" },
    ).observe(this.sentinel);
  }

  /** Hosts page-loader iframes; shows them full-screen when a challenge needs the user. */
  readonly frameHost: FrameHost = {
    attach: (iframe) => {
      iframe.className = "br-loader-frame";
      this.frameLayer.append(iframe);
    },
    reveal: (_iframe, message, cancel) => {
      this.frameMessage.textContent = message;
      this.frameCancel = cancel;
      this.frameLayer.classList.add("visible");
    },
    detach: (iframe) => {
      iframe.remove();
      if (!this.frameLayer.querySelector("iframe")) this.frameLayer.classList.remove("visible");
    },
  };

  // ---------------------------------------------------------------------------
  // Visibility of the whole reader

  show(): void {
    this.root.hidden = false;
    this.pillEl.hidden = true;
    this.lockPageScroll();
  }

  collapse(): void {
    this.closeSheet();
    this.root.hidden = true;
    this.pillEl.hidden = false;
    this.unlockPageScroll();
  }

  private lockPageScroll(): void {
    if (this.savedPageStyles) return;
    const html = document.documentElement;
    const body = document.body;
    this.savedPageStyles = { html: html.style.overflow, body: body?.style.overflow ?? "" };
    html.style.overflow = "hidden";
    if (body) body.style.overflow = "hidden";
  }

  private unlockPageScroll(): void {
    if (!this.savedPageStyles) return;
    document.documentElement.style.overflow = this.savedPageStyles.html;
    if (document.body) document.body.style.overflow = this.savedPageStyles.body;
    this.savedPageStyles = undefined;
  }

  // ---------------------------------------------------------------------------
  // Content

  setTitles(bookTitle: string, chapterTitle?: string): void {
    this.titleEl.textContent = bookTitle || "Bili Reader";
    this.subtitleEl.textContent = chapterTitle ?? "";
  }

  clearContent(): void {
    this.contentEl.replaceChildren();
    this.paraEls = [];
    this.byId.clear();
    this.activeId = undefined;
    this.selectedId = undefined;
    this.lastReportedTop = undefined;
    this.fatalEl?.remove();
    this.fatalEl = undefined;
    this.scrollEl.hidden = false;
    this.scrollEl.scrollTop = 0;
  }

  appendChapter(chapterId: string, title: string, paragraphs: Paragraph[]): void {
    const section = h(
      "section",
      { class: "br-chapter", "data-chapter-id": chapterId },
      h("h2", { class: "br-chapter-title" }, title || "　"),
    );
    this.contentEl.append(section);
    this.appendParagraphs(chapterId, paragraphs);
  }

  appendParagraphs(chapterId: string, paragraphs: Paragraph[]): void {
    const section = this.contentEl.querySelector<HTMLElement>(`section[data-chapter-id="${CSS.escape(chapterId)}"]`);
    if (!section) return;
    const frag = document.createDocumentFragment();
    for (const p of paragraphs) {
      const el = p.imageUrl ? this.renderImage(p) : h("p", { class: "br-p", "data-id": p.id }, p.text ?? "");
      this.byId.set(p.id, el);
      this.paraEls.push(el);
      frag.append(el);
    }
    section.append(frag);
  }

  private renderImage(p: Paragraph): HTMLElement {
    const img = h("img", { src: p.imageUrl, loading: "lazy", decoding: "async", alt: "插图" });
    const fig = h("figure", { class: "br-img", "data-id": p.id }, img);
    img.addEventListener("error", () => fig.classList.add("broken"), { once: true });
    return fig;
  }

  /** Removes a chapter's DOM, keeping the visible content in place. */
  removeChapter(chapterId: string): void {
    const section = this.contentEl.querySelector<HTMLElement>(`section[data-chapter-id="${CSS.escape(chapterId)}"]`);
    if (!section) return;
    const height = section.offsetHeight;
    const above = section.getBoundingClientRect().bottom <= this.scrollEl.getBoundingClientRect().top;
    section.querySelectorAll<HTMLElement>("[data-id]").forEach((el) => this.byId.delete(el.dataset.id ?? ""));
    this.paraEls = this.paraEls.filter((el) => !section.contains(el));
    section.remove();
    if (above) this.scrollEl.scrollTop -= height;
  }

  setStatus(kind: StatusKind, message = "", actions: ViewAction[] = []): void {
    this.statusEl.replaceChildren();
    this.statusEl.dataset.kind = kind;
    if (kind === "idle") return;
    this.statusEl.append(h("div", {}, message));
    if (actions.length) this.statusEl.append(this.actionRow(actions, "br-status-actions"));
  }

  showBanner(text: string, actions: ViewAction[]): void {
    this.bannerEl.replaceChildren(
      h("div", { class: "br-banner-text" }, text),
      this.actionRow(actions, "br-banner-actions"),
    );
    this.bannerEl.hidden = false;
  }

  hideBanner(): void {
    this.bannerEl.hidden = true;
    this.bannerEl.replaceChildren();
  }

  get bannerVisible(): boolean {
    return !this.bannerEl.hidden;
  }

  /** Replaces the content area with a blocking error (nothing could be loaded). */
  showFatal(message: string, detail: string, actions: ViewAction[]): void {
    this.fatalEl?.remove();
    this.scrollEl.hidden = true;
    this.fatalEl = h(
      "div",
      { class: "br-fatal" },
      h("div", {}, message),
      detail ? h("div", { class: "br-fatal-detail" }, detail) : null,
      this.actionRow(actions, "br-status-actions"),
    );
    this.scrollEl.after(this.fatalEl);
  }

  private actionRow(actions: ViewAction[], cls: string): HTMLElement {
    return h(
      "div",
      { class: cls },
      ...actions.map((a) => h("button", { class: `br-btn${a.primary ? " primary" : ""}`, onclick: a.onClick }, a.label)),
    );
  }

  // ---------------------------------------------------------------------------
  // Cursor, highlight and scrolling

  setActive(id: string | undefined): void {
    if (this.activeId === id) return;
    if (this.activeId) this.byId.get(this.activeId)?.classList.remove("active");
    this.activeId = id;
    if (id) this.byId.get(id)?.classList.add("active");
  }

  setSelected(id: string | undefined): void {
    if (this.selectedId) this.byId.get(this.selectedId)?.classList.remove("selected");
    this.selectedId = id;
    if (id) this.byId.get(id)?.classList.add("selected");
  }

  get userScrolledRecently(): boolean {
    return Date.now() - this.lastUserScroll < USER_SCROLL_GRACE_MS;
  }

  /** Puts a paragraph near the top of the reading area (used for restore / jumps). */
  scrollToParagraph(id: string): void {
    const el = this.byId.get(id);
    if (!el) return;
    const align = () => {
      const top = el.getBoundingClientRect().top - this.scrollEl.getBoundingClientRect().top;
      this.scrollEl.scrollTop += top - 12;
      this.lastReportedTop = id;
    };
    align();
    // Images above may still change height while loading; re-align unless the user took over.
    const start = Date.now();
    for (const delay of [250, 800, 1600]) {
      setTimeout(() => {
        if (this.lastUserScroll < start) align();
      }, delay);
    }
  }

  /** Keeps the spoken paragraph in view without fighting a user who is scrolling. */
  follow(id: string): void {
    if (this.userScrolledRecently) return;
    const el = this.byId.get(id);
    if (!el) return;
    const view = this.scrollEl.getBoundingClientRect();
    const r = el.getBoundingClientRect();
    const bandTop = view.top + view.height * 0.1;
    const bandBottom = view.top + view.height * 0.75;
    if (r.top < bandTop || r.bottom > bandBottom) {
      const target = this.scrollEl.scrollTop + (r.top - view.top) - view.height * 0.3;
      this.scrollEl.scrollTo({ top: Math.max(0, target), behavior: "smooth" });
    }
  }

  isRendered(id: string): boolean {
    return this.byId.has(id);
  }

  /** First paragraph whose bottom is below the top edge of the reading area. */
  topVisibleParagraphId(): string | undefined {
    const edge = this.scrollEl.getBoundingClientRect().top + 8;
    let lo = 0;
    let hi = this.paraEls.length - 1;
    let found: HTMLElement | undefined;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (this.paraEls[mid].getBoundingClientRect().bottom > edge) {
        found = this.paraEls[mid];
        hi = mid - 1;
      } else lo = mid + 1;
    }
    return found?.dataset.id;
  }

  private onScroll(): void {
    if (this.scrollRaf) return;
    this.scrollRaf = requestAnimationFrame(() => {
      this.scrollRaf = 0;
      if (!this.userScrolledRecently) return;
      this.hideChip();
      const id = this.topVisibleParagraphId();
      if (id && id !== this.lastReportedTop) {
        this.lastReportedTop = id;
        this.cb.onVisibleParagraph(id);
      }
    });
  }

  private onContentClick(ev: Event): void {
    const selection = (this.shadow as ShadowRoot & { getSelection?: () => Selection | null }).getSelection?.() ??
      document.getSelection();
    if (selection && !selection.isCollapsed && String(selection).trim()) return;
    const target = (ev.target as Element).closest<HTMLElement>("[data-id]");
    const id = target?.dataset.id;
    if (id) this.cb.onParagraphTap(id);
  }

  showChip(id: string): void {
    this.chipEl.dataset.id = id;
    this.chipEl.hidden = false;
    clearTimeout(this.chipTimer);
    this.chipTimer = setTimeout(() => this.hideChip(), 5000);
  }

  hideChip(): void {
    this.chipEl.hidden = true;
    clearTimeout(this.chipTimer);
  }

  // ---------------------------------------------------------------------------
  // Player

  setPlayerState(state: PlayerState, message?: string): void {
    this.playerEl.dataset.state = state;
    const playing = state === "playing" || state === "buffering";
    this.playBtn.replaceChildren(svg(playing ? ICONS.pause : ICONS.play));
    this.playBtn.setAttribute("aria-label", playing ? "暂停" : "播放");
    const fallback: Record<PlayerState, string> = {
      idle: "",
      playing: "",
      paused: "已暂停",
      buffering: "正在加载下一页…",
      error: "朗读出错",
    };
    this.playerStatusEl.textContent = message ?? fallback[state];
  }

  setPlayerMessage(message: string): void {
    this.playerStatusEl.textContent = message;
  }

  setVoices(voices: VoiceInfo[]): void {
    this.voices = voices;
    this.renderSheetIfOpen();
  }

  setAzureState(state: {
    voices?: AzureVoice[];
    keySet?: boolean;
    status?: string;
    usage?: number;
    fallback?: boolean;
  }): void {
    if (state.fallback !== undefined) this.azureFallback = state.fallback;
    if (state.voices) this.azureVoices = state.voices.length ? state.voices : AZURE_PRESET_VOICES;
    if (state.keySet !== undefined) this.azureKeySet = state.keySet;
    if (state.status !== undefined) this.azureStatus = state.status;
    if (state.usage !== undefined) this.azureUsage = state.usage;
    this.renderSheetIfOpen();
  }

  // ---------------------------------------------------------------------------
  // Settings

  applySettings(s: Settings): void {
    this.settings = s;
    this.root.style.setProperty("--font-size", `${s.fontSize}px`);
    this.root.style.setProperty("--line-height", String(s.lineHeight));
    this.root.dataset.font = s.fontFamily;
    this.rateSelect.value = String(s.rate);
    if (this.rateSelect.value !== String(s.rate)) {
      this.rateSelect.append(h("option", { value: String(s.rate) }, formatRate(s.rate)));
      this.rateSelect.value = String(s.rate);
    }
    this.rateLabel.textContent = formatRate(s.rate);
    this.applyTheme();
  }

  private applyTheme(): void {
    const t: Theme = this.settings.theme;
    this.root.dataset.theme = t === "system" ? (this.systemDark?.matches ? "dark" : "light") : t;
  }

  private update(patch: Partial<Settings>): void {
    const next = { ...this.settings, ...patch };
    this.applySettings(next);
    this.cb.onSettings(next);
    this.renderSheetIfOpen();
  }

  private openSheet(): void {
    this.closeSheet();
    this.sheetEl = h("div");
    this.root.append(this.sheetEl);
    this.renderSheet();
  }

  private closeSheet(): void {
    this.sheetEl?.remove();
    this.sheetEl = undefined;
  }

  private renderSheetIfOpen(): void {
    if (this.sheetEl) this.renderSheet();
  }

  private renderSheet(): void {
    if (!this.sheetEl) return;
    const s = this.settings;
    const seg = <T>(options: [T, string][], current: T, onPick: (v: T) => void) =>
      h(
        "div",
        { class: "br-seg" },
        ...options.map(([value, label]) =>
          h("button", { "aria-pressed": value === current ? "true" : "false", onclick: () => onPick(value) }, label),
        ),
      );
    const row = (label: string, control: Node) => h("div", { class: "br-row" }, h("span", {}, label), control);

    const voiceSelect = h("select", { "aria-label": "声音" });
    voiceSelect.append(h("option", { value: "" }, "自动（中文）"));
    for (const v of this.voices) {
      voiceSelect.append(h("option", { value: v.voiceURI }, `${v.name} · ${v.lang}`));
    }
    voiceSelect.value = s.voiceURI ?? "";
    voiceSelect.addEventListener("change", () => {
      const uri = voiceSelect.value || undefined;
      this.update({ voiceURI: uri });
      this.cb.onVoice(uri);
    });

    const azureRows = s.ttsEngine === "azure" ? this.renderAzureRows(row) : [row("声音", voiceSelect)];

    const close = () => this.closeSheet();
    const sheet = h(
      "div",
      { class: "br-sheet", role: "dialog", "aria-label": "阅读设置" },
      h("h3", {}, "阅读设置"),
      row(
        "字号",
        h(
          "div",
          { class: "br-seg" },
          h("button", { onclick: () => this.update({ fontSize: Math.max(FONT_SIZE_RANGE.min, s.fontSize - 1) }) }, "A−"),
          h("button", { "aria-pressed": "false" }, String(s.fontSize)),
          h("button", { onclick: () => this.update({ fontSize: Math.min(FONT_SIZE_RANGE.max, s.fontSize + 1) }) }, "A+"),
        ),
      ),
      row(
        "行距",
        seg(
          LINE_HEIGHT_OPTIONS.map((v) => [v, String(v)] as [number, string]),
          s.lineHeight,
          (v) => this.update({ lineHeight: v }),
        ),
      ),
      row(
        "字体",
        seg<Settings["fontFamily"]>(
          [
            ["sans", "黑体"],
            ["serif", "宋体"],
          ],
          s.fontFamily,
          (v) => this.update({ fontFamily: v }),
        ),
      ),
      row(
        "主题",
        seg<Theme>(
          [
            ["system", "自动"],
            ["light", "浅色"],
            ["sepia", "护眼"],
            ["dark", "深色"],
          ],
          s.theme,
          (v) => this.update({ theme: v }),
        ),
      ),
      row(
        "朗读",
        seg<Settings["ttsEngine"]>(
          [
            ["system", "系统语音"],
            ["azure", "Azure"],
          ],
          s.ttsEngine,
          (v) => this.update({ ttsEngine: v }),
        ),
      ),
      ...azureRows,
      h(
        "div",
        { class: "br-sheet-actions" },
        h("button", { class: "br-btn", onclick: () => (close(), this.cb.onRestartChapter()) }, "从本章开头阅读"),
        h("button", { class: "br-btn", onclick: () => (close(), this.cb.onOpenOriginal()) }, "打开当前页原网页"),
        h("button", { class: "br-btn", onclick: () => this.cb.onCopyDiagnostics() }, "复制诊断信息"),
        h("button", { class: "br-btn", onclick: () => (close(), this.cb.onExit()) }, "退出阅读模式"),
        h("button", { class: "br-btn primary", onclick: close }, "完成"),
      ),
      h("div", { class: "br-version" }, `Bili Reader v${this.version}`),
    );
    this.sheetEl.replaceChildren(h("div", { class: "br-sheet-backdrop", onclick: close }), sheet);
  }

  private renderAzureRows(row: (label: string, control: Node) => HTMLElement): HTMLElement[] {
    const s = this.settings;
    const keyInput = h("input", {
      type: "password",
      autocomplete: "off",
      autocapitalize: "off",
      spellcheck: "false",
      placeholder: this.azureKeySet ? "已保存（输入新密钥以替换）" : "粘贴 Speech 资源密钥",
      "aria-label": "Azure 密钥",
    });
    keyInput.addEventListener("change", () => {
      const v = keyInput.value.trim();
      if (v) this.cb.onAzureKey(v);
    });

    const regionInput = h("input", {
      type: "text",
      autocomplete: "off",
      autocapitalize: "off",
      spellcheck: "false",
      value: s.azureRegion,
      placeholder: "eastasia",
      "aria-label": "Azure 区域",
    });
    regionInput.addEventListener("change", () => {
      const v = regionInput.value.trim().toLowerCase();
      if (v && v !== s.azureRegion) this.update({ azureRegion: v });
    });

    const voiceSelect = h("select", { "aria-label": "Azure 声音" });
    const voices = this.azureVoices.some((v) => v.shortName === s.azureVoice)
      ? this.azureVoices
      : [{ shortName: s.azureVoice, label: s.azureVoice, locale: "" }, ...this.azureVoices];
    for (const v of voices) voiceSelect.append(h("option", { value: v.shortName }, v.label));
    voiceSelect.value = s.azureVoice;
    voiceSelect.addEventListener("change", () => this.update({ azureVoice: voiceSelect.value }));

    const pct = Math.min(100, Math.round((this.azureUsage / AzureUsageMeter.FREE_CHARS) * 100));
    const usage = `本月约用 ${this.azureUsage.toLocaleString()} / ${AzureUsageMeter.FREE_CHARS.toLocaleString()} 字符（${pct}%，中文按 2 计，以 Azure 后台为准）`;

    const actions = h(
      "div",
      { class: "br-seg" },
      h("button", { onclick: () => this.cb.onAzureTest() }, "试听"),
      this.azureFallback ? h("button", { onclick: () => this.cb.onAzureRetry() }, "立即重试 Azure") : null,
      this.azureKeySet ? h("button", { onclick: () => this.cb.onAzureKey("") }, "清除密钥") : null,
    );

    return [
      row("密钥", keyInput),
      row("区域", regionInput),
      row("声音", voiceSelect),
      row(
        "预缓冲",
        h(
          "div",
          { class: "br-seg" },
          ...[1, 3, 5, 8].map((n) =>
            h(
              "button",
              { "aria-pressed": s.azureBuffer === n ? "true" : "false", onclick: () => this.update({ azureBuffer: n }) },
              `${n} 句`,
            ),
          ),
        ),
      ),
      row("", actions),
      h("div", { class: "br-note" }, this.azureStatus ? `${this.azureStatus}\n${usage}` : usage),
    ];
  }
}
