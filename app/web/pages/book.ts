import { h } from "../../../src/utils/dom";
import type { BookDetail, BookVoice, BookVoices, ChapterInfo, VolumeInfo } from "../../shared/api";
import type { Settings } from "../../../src/reader/ProgressStore";
import { api } from "../api";
import { segmentSheet } from "../segments";
import { offlineSupported, onSaveChange, queueSave, removeSaved, savedChapters, savingState, type SavedChapter } from "../offline";
import { navigate } from "../router";
import {
  act,
  cover,
  download,
  formatBytes,
  formatDuration,
  formatTime,
  icon,
  menu,
  openReader,
  poll,
  stepper,
  switchInput,
  type MenuItem,
  toast,
  topbar,
  type Page,
} from "../ui";

const READER_SETTINGS_KEY = "biliReader.settings";
const PROVIDER_LABEL: Record<string, string> = { gemini: "Gemini", fish: "Fish Audio" };

/** A book: reading, its chapters' audio, generation and export. */
export function bookPage({ id }: Record<string, string>): Page {
  const el = h("div", {}, topbar("", "/"));
  const body = h("div");
  el.append(body);
  /** Volumes whose M4B was asked for while being packed (downloaded when ready). */
  const wanted = new Set<number>();
  /** Volumes the user opened (kept across refreshes). */
  const open = new Set<number>();
  let opened = false;
  let player: HTMLElement | undefined;
  let sheet: { close: () => void } | undefined;
  let last = "";
  let shown: BookDetail | undefined;
  /** Audio per voice (slower to compute: fetched on changes, at most every 15 s). */
  let voices: BookVoices | undefined;
  let voicesAt = 0;

  const loadVoices = async () => {
    voicesAt = Date.now();
    voices = await api.keep<BookVoices>(`/api/books/${id}/voices`);
    if (shown) draw(shown);
  };

  const draw = (book: BookDetail) => {
    const y = window.scrollY;
    body.replaceChildren(...render(book));
    window.scrollTo(0, y);
  };

  const load = async (force = false) => show(await api.keep<BookDetail>(`/api/books/${id}`), force);
  const show = (book: BookDetail, force = false) => {
    const sig = JSON.stringify(book);
    if (sig === last && !force) return;
    last = sig;
    shown = book;
    // M4B asked for while being packed: saved once it is ready.
    for (const vi of wanted) {
      const v = book.volumes[vi];
      if (v?.export && !v.export.stale) location.href = `/api/books/${id}/volumes/${vi}/export`;
      if (!v || (v.export && !v.export.stale) || v.exportJob?.status === "failed") wanted.delete(vi);
    }
    if (force || Date.now() - voicesAt > 15_000) void loadVoices().catch(() => undefined);
    if (!opened) {
      opened = true;
      const cur = currentVolume(book);
      open.add(cur >= 0 ? cur : 0);
    }
    document.title = `${book.title} · Bili Reader`;
    draw(book);
  };

  const refresh = () => void load(true).catch((err: Error) => toast(err.message));

  const generate = (button: HTMLButtonElement | null, payload: object, what: string) =>
    act(button, async () => {
      const r = await api.post<{ queued: number }>(`/api/books/${id}/generate`, payload);
      toast(r.queued ? `已加入 ${r.queued} 章到生成队列` : `${what}的语音都已生成`);
      refresh();
    });

  const play = (book: BookDetail, ch: ChapterInfo) => {
    player?.remove();
    sheet?.close();
    sheet = undefined;
    const audio = h("audio", { controls: true, autoplay: true, preload: "auto", src: `/api/books/${id}/chapters/${ch.chapterId}/audio` });
    const close = h("button", { class: "icon-btn", "aria-label": "关闭", onclick: () => (player?.remove(), (player = undefined)) }, icon("close"));
    player = h(
      "div",
      { class: "player" },
      h("div", { class: "what" }, h("b", {}, ch.title), h("span", { class: "hint" }, book.title), audio),
      close,
    );
    document.body.append(player);
    if ("mediaSession" in navigator) {
      navigator.mediaSession.metadata = new MediaMetadata({
        title: ch.title,
        artist: book.author,
        album: book.title,
        artwork: book.hasCover ? [{ src: `/api/books/${id}/cover`, type: "image/jpeg" }] : [],
      });
    }
  };

  function render(book: BookDetail): Node[] {
    const backdrop = h("div", { class: "backdrop" });
    if (book.hasCover) backdrop.style.backgroundImage = `url("/api/books/${id}/cover")`;
    const readBtn = h(
      "button",
      { class: "btn primary", onclick: () => openReader(book.id, book.position ?? firstChapter(book)) },
      book.position ? "继续阅读" : "开始阅读",
    );
    const refreshBtn = h("button", { class: "btn" }, "刷新目录");
    refreshBtn.addEventListener("click", () =>
      void act(refreshBtn, async () => {
        const res = await api.post<BookDetail>(`/api/books/${id}/refresh`);
        toast(res.loading ? "网站响应较慢，目录在后台继续获取" : "目录已更新");
        refresh();
      }),
    );
    const hero = h(
      "section",
      { class: "hero" },
      backdrop,
      h(
        "div",
        { class: "inner" },
        cover(book),
        h(
          "div",
          {},
          h("h1", {}, book.title),
          h("div", { class: "author" }, book.author || "未知作者"),
          book.position
            ? h("div", { class: "hint", style: "margin-bottom:10px" }, `读到 ${book.position.chapterTitle ?? ""} · ${formatTime(book.position.updatedAt)}`)
            : null,
          h("div", { class: "buttons" }, readBtn, refreshBtn),
        ),
      ),
    );
    const intro = book.intro ? h("p", { class: "intro" }, book.intro) : null;
    intro?.addEventListener("click", () => intro.classList.toggle("open"));
    const status = book.loading
      ? h("div", { class: "banner" }, h("span", { class: "spin" }), "正在从网站获取目录…（网站限速，可能需要一两分钟）")
      : book.loadError
        ? h(
            "div",
            { class: "banner error", role: "alert" },
            h(
              "div",
              { class: "grow" },
              h("b", {}, "目录获取失败"),
              h("div", { class: "mono" }, book.loadError),
              h("div", { class: "hint" }, "可在", h("a", { href: "/settings", "data-link": true }, "设置 → 网站访问"), "中测试连接，然后点“刷新目录”"),
            ),
          )
        : null;
    return [hero, status, intro, audioCard(book), offlineCard(book), ...book.volumes.map((v, vi) => volume(book, v, vi)), dangerZone(book)].filter(
      Boolean,
    ) as Node[];
  }

  function audioCard(book: BookDetail): HTMLElement {
    const duration = book.volumes.flatMap((v) => v.chapters).reduce((s, c) => s + (c.audio === "done" ? (c.duration ?? 0) : 0), 0);
    const voiceName = book.profile && (book.profileLabel ?? `${PROVIDER_LABEL[book.profile.provider]} · ${book.profile.voice || "默认声音"}`);
    const profile = voiceName
      ? h("a", { class: "badge voice", href: "/settings", "data-link": true, title: voiceName }, voiceName)
      : h("a", { class: "badge muted", href: "/settings", "data-link": true }, "未配置语音");
    const allBtn = h("button", { class: "btn small" }, "生成全书");
    allBtn.addEventListener("click", () => {
      if (!confirm(`为《${book.title}》全部 ${book.chapters} 章生成语音？`)) return;
      void generate(allBtn, { all: true }, "全书");
    });
    const nextBtn = h("button", { class: "btn small" }, "从当前起生成 10 章");
    nextBtn.addEventListener("click", () => {
      const from = book.position?.chapterId ?? firstChapter(book)?.chapterId;
      if (from) void generate(nextBtn, { from, count: 10 }, "这些章节");
    });
    return h(
      "section",
      { class: "card" },
      h("h2", {}, "有声书"),
      h(
        "div",
        { class: "stats" },
        h("div", {}, h("b", {}, `${book.audioChapters}/${book.chapters}`), h("span", {}, "已生成章节")),
        h("div", {}, h("b", {}, duration ? formatDuration(duration) : "—"), h("span", {}, "总时长")),
        h("div", {}, h("b", {}, book.audioBytes ? formatBytes(book.audioBytes) : "—"), h("span", {}, "占用空间")),
      ),
      h(
        "div",
        { class: "row" },
        h("div", { class: "grow" }, h("div", { class: "label" }, "声音"), h("div", { class: "hint" }, "在设置中更改；换声音后旧音频保留，见下方")),
        profile,
      ),
      voiceRows(),
      h(
        "div",
        { class: "row" },
        h(
          "div",
          { class: "grow" },
          h("div", { class: "label" }, "自动生成"),
          h("div", { class: "hint" }, "跟随阅读进度，在后台生成正在读的章节和之后几章。生成较慢，新加的书默认关闭"),
        ),
        switchInput(book.follow, (follow) => void api.patch(`/api/books/${id}`, { follow }).then(refresh, (e: Error) => toast(e.message))),
      ),
      book.follow
        ? h(
            "div",
            { class: "row" },
            h("div", { class: "grow" }, h("div", { class: "label" }, "提前生成章节数")),
            stepper(book.ahead, 0, 20, (ahead) => void api.patch(`/api/books/${id}`, { ahead }).catch((e: Error) => toast(e.message))),
          )
        : null,
      h("div", { class: "actions" }, nextBtn, allBtn),
    );
  }

  /** Chapters saved on this device, to read and listen to without the server. */
  function offlineCard(book: BookDetail): HTMLElement | null {
    if (!offlineSupported) return null;
    const saved = Object.values(savedChapters(id));
    const bytes = saved.reduce((s, c) => s + c.bytes, 0);
    const linked = book.volumes.flatMap((v) => v.chapters).filter((c) => c.chapterId);
    const from = Math.max(0, linked.findIndex((c) => c.chapterId === (book.position?.chapterId ?? firstChapter(book)?.chapterId)));
    const nextBtn = h("button", { class: "btn small" }, "从当前起保存 10 章");
    nextBtn.addEventListener("click", () => saveMany(book, linked.slice(from, from + 10)));
    const delBtn = saved.length ? h("button", { class: "btn small danger" }, "删除本机内容") : null;
    delBtn?.addEventListener("click", () => {
      if (!confirm(`删除本机保存的《${book.title}》${saved.length} 章（${formatBytes(bytes)}）？服务器上的内容不受影响。`)) return;
      void act(delBtn, async () => {
        await removeSaved(id);
        toast("已删除本机内容");
        draw(book);
      });
    });
    return h(
      "section",
      { class: "card" },
      h("h2", {}, "离线阅读"),
      h(
        "div",
        { class: "row" },
        h(
          "div",
          { class: "grow" },
          h("div", { class: "label" }, saved.length ? `本机已保存 ${saved.length} 章 · ${formatBytes(bytes)}` : "本机未保存章节"),
          h("div", { class: "hint" }, "保存原文、插图和当前声音已生成的语音；连不上服务器时照常阅读和朗读。也可在章节或整卷的「下载」菜单里保存。章节的下载按钮上：实心勾＝已存（含全部语音），空心圈＝已存原文、语音不全，圆环＝正在保存。进度也在“任务”页"),
        ),
      ),
      h("div", { class: "actions" }, nextBtn, delBtn),
    );
  }

  /** Queues chapters to save on this device (pages not read yet are fetched from the site first). */
  function saveMany(book: BookDetail, chapters: ChapterInfo[]) {
    const list = chapters.flatMap((c) => (c.chapterId ? [{ id: c.chapterId, title: c.title }] : []));
    if (!list.length) return;
    queueSave(id, book.title, list);
    toast(list.length > 1 ? `正在保存 ${list.length} 章到本机，进度见“任务”页` : "正在保存到本机…");
  }

  /** Voices this book has audio in: listen (per chapter), switch to, or delete. */
  function voiceRows(): HTMLElement | null {
    const list = voices?.voices.filter((v) => v.segments || v.chapterFiles) ?? [];
    if (!list.length) return null;
    return h(
      "div",
      { class: "voices" },
      h("div", { class: "hint" }, "已有音频的声音（在章节的", icon("list"), "里按声音试听）"),
      ...list.map((v) => {
        const facts = [
          v.model,
          v.segments ? `${v.segments} 段` : "",
          v.chapters ? `${v.chapters} 章完整` : "",
          v.partial ? `${v.partial} 章部分` : "",
          v.chapterFiles ? `${v.chapterFiles} 章已合成` : "",
          v.bytes ? formatBytes(v.bytes) : "",
        ].filter(Boolean);
        const del = h("button", { class: "btn small danger", type: "button" }, "删除");
        del.addEventListener("click", () => {
          const warn = v.current ? "这是当前声音，删除后需要重新生成（会再次请求）。" : "";
          if (!confirm(`删除本书「${v.label}」的全部音频（${facts.slice(1).join("，")}）？${warn}`)) return;
          void act(del, async () => {
            const r = await api.del<{ bytes: number }>(`/api/books/${id}/voices/${encodeURIComponent(v.id)}`);
            toast(`已删除 ${formatBytes(r.bytes)}`);
            refresh();
          });
        });
        const use = !v.current && v.switchable ? h("button", { class: "btn small", type: "button" }, "设为当前") : null;
        use?.addEventListener("click", () => void act(use, () => switchTo(v)));
        return h(
          "div",
          { class: v.current ? "voice-item current" : "voice-item" },
          h(
            "div",
            { class: "grow" },
            h("div", { class: "name" }, v.label, v.current ? h("span", { class: "badge ok" }, "当前") : null),
            h("div", { class: "hint" }, facts.join(" · ")),
          ),
          use,
          del,
        );
      }),
    );
  }

  async function switchTo(v: BookVoice) {
    const kv = await api.get<{ value: string | null }>(`/api/kv/${READER_SETTINGS_KEY}`);
    const s = (kv.value ? JSON.parse(kv.value) : {}) as Partial<Settings>;
    const next: Partial<Settings> =
      v.provider === "fish"
        ? { ...s, ttsEngine: "fish", fishModel: v.model, fishVoice: v.voice }
        : { ...s, ttsEngine: "gemini", geminiModel: v.model, geminiVoice: v.voice, geminiStyle: v.style ?? "" };
    await api.put(`/api/kv/${READER_SETTINGS_KEY}`, { value: JSON.stringify(next) });
    toast(`已切换到「${v.label}」；阅读器和后台生成都会使用这个声音`);
    refresh();
  }

  /** How many of a volume's chapters are saved on this device. */
  function offlineBadge(linked: ChapterInfo[]): HTMLElement | null {
    if (!offlineSupported) return null;
    const saved = savedChapters(id);
    const n = linked.filter((c) => c.chapterId && saved[c.chapterId]).length;
    if (!n) return null;
    return h("span", { class: n === linked.length ? "badge ok" : "badge muted", title: `已存本机 ${n}/${linked.length} 章` }, icon("device"), `${n}/${linked.length}`);
  }

  function volume(book: BookDetail, v: VolumeInfo, vi: number): HTMLElement {
    const linked = v.chapters.filter((c) => c.chapterId);
    const done = linked.filter((c) => c.audio === "done").length;
    const isOpen = open.has(vi);
    const header = h(
      "header",
      {},
      h("span", { class: "chev" }, icon("chevron")),
      h("span", { class: "title" }, v.title),
      offlineBadge(linked),
      done ? h("span", { class: done === linked.length ? "badge ok" : "badge" }, `🎧 ${done}/${linked.length}`) : h("span", { class: "count" }, `${linked.length} 章`),
    );
    const section = h("section", { class: isOpen ? "volume open" : "volume" }, header);
    header.addEventListener("click", () => {
      if (open.has(vi)) open.delete(vi);
      else open.add(vi);
      section.replaceWith(volume(book, v, vi));
    });
    if (!isOpen) return section;

    const genBtn = h("button", { class: "btn small" }, "生成本卷");
    genBtn.addEventListener("click", () => void generate(genBtn, { volume: vi }, "本卷"));
    const tools = h("div", { class: "tools" }, genBtn);
    const exp = v.exportJob;
    const packing = exp && (exp.status === "queued" || exp.status === "running");
    const fresh = v.export && !v.export.stale;
    const exportUrl = `/api/books/${id}/volumes/${vi}/export`;
    const dl = h("button", { class: fresh ? "btn small primary" : "btn small", type: "button" }, icon("download"), "下载");
    menu(dl, () => [
      fresh
        ? { label: "语音（M4B）", hint: formatBytes(v.export!.bytes), href: exportUrl }
        : packing
          ? { label: "语音（M4B）", hint: exp.status === "queued" ? "排队打包中…" : `打包中 ${exp.progress}%`, disabled: true }
          : done < linked.length || !linked.length
            ? { label: "语音（M4B）", hint: `还有 ${linked.length - done} 章未生成`, disabled: true }
            : {
                label: "语音（M4B）",
                hint: "打包后下载",
                run: () =>
                  act(dl, async () => {
                    await api.post(exportUrl);
                    wanted.add(vi);
                    toast("正在打包整卷语音，完成后自动下载");
                    refresh();
                  }),
              },
      { label: "原文（TXT）", hint: "整卷", run: () => saveText(dl, `/api/books/${id}/volumes/${vi}/text`) },
      ...(offlineSupported
        ? [{ label: "保存到本机", hint: `离线阅读 · ${linked.length} 章`, run: () => saveMany(book, linked) }]
        : []),
    ]);
    tools.append(dl);
    if (packing) tools.append(h("span", { class: "hint" }, exp.status === "queued" ? "M4B 排队打包中…" : `M4B 打包中 ${exp.progress}%`));
    if (exp?.status === "failed") tools.append(h("span", { class: "hint", style: "color:var(--danger)" }, exp.message ?? "打包失败"));
    section.append(tools, h("ol", {}, ...v.chapters.map((c) => chapterRow(book, c))));
    return section;
  }

  function chapterRow(book: BookDetail, c: ChapterInfo): HTMLElement {
    const current = !!c.chapterId && c.chapterId === book.position?.chapterId;
    const cls = ["chapter-row", current ? "current" : "", c.chapterId ? "" : "disabled"].join(" ").trim();
    if (!c.chapterId) return h("li", { class: cls }, h("div", { class: "name" }, c.title, h("div", { class: "sub" }, "暂无链接")));
    const sub: string[] = [];
    if (current) sub.push("正在读");
    if (c.audio === "done" && c.silent) sub.push("仅插图，无语音");
    else if (c.duration) sub.push(formatDuration(c.duration));
    if (c.audio === "stale") sub.push("声音已更换，需重新生成");
    if ((c.audio === "running" || c.audio === "queued" || c.audio === "failed") && c.message) sub.push(c.message);
    const name = h(
      "div",
      { class: "name" },
      h("a", { href: `/novel/${book.id}/${c.chapterId}.html` }, c.title),
      sub.length ? h("div", { class: "sub" }, sub.join(" · ")) : null,
    );
    const segBtn =
      (c.audio !== "none" || voices?.chapters.includes(c.chapterId)) && !c.silent
        ? h("button", { class: "state", type: "button", title: "按段试听（生成一段即可播放）", "aria-label": "语音片段" }, icon("list"))
        : null;
    segBtn?.addEventListener("click", () => {
      sheet?.close();
      player?.remove();
      player = undefined;
      sheet = segmentSheet(book, c);
    });
    const dl = downloadButton(c.chapterId);
    const audio = c.audio === "done" && !c.silent;
    menu(dl, () => [
      audio
        ? { label: "语音（MP3）", hint: c.duration ? formatDuration(c.duration) : "", href: `/api/books/${id}/chapters/${c.chapterId}/audio?download` }
        : { label: "语音（MP3）", hint: c.silent ? "仅插图" : "尚未生成", disabled: true },
      { label: "原文（TXT）", run: () => saveText(dl, `/api/books/${id}/chapters/${c.chapterId}/text`) },
      ...(offlineSupported ? offlineItems(book, c) : []),
    ]);
    return h("li", { class: cls }, name, segBtn, dl, stateButton(book, c));
  }

  /** Save a chapter on this device (again, to take newly generated audio), or delete it. */
  function offlineItems(book: BookDetail, c: ChapterInfo): MenuItem[] {
    const chapterId = c.chapterId!;
    const busy = savingState(id, chapterId);
    if (busy) return [{ label: "保存到本机", hint: "fraction" in busy ? `保存中 ${Math.round(busy.fraction * 100)}%` : "排队中", disabled: true }];
    const saved = savedChapters(id)[chapterId];
    if (!saved) return [{ label: "保存到本机", hint: "离线阅读", run: () => saveMany(book, [c]) }];
    return [
      { label: "更新本机内容", hint: `${formatBytes(saved.bytes)} · ${offlineAudio(saved)}`, run: () => saveMany(book, [c]) },
      {
        label: "从本机删除",
        run: async () => {
          await removeSaved(id, [chapterId]);
          toast("已从本机删除");
          if (shown) draw(shown);
        },
      },
    ];
  }

  /** The chapter's download button, which also shows whether it is saved on this device (or being saved). */
  function downloadButton(chapterId: string): HTMLButtonElement {
    const btn = h("button", { class: "state dl", type: "button", "aria-label": "下载" });
    const busy = offlineSupported ? savingState(id, chapterId) : undefined;
    const saved = offlineSupported ? savedChapters(id)[chapterId] : undefined;
    if (busy && "fraction" in busy) {
      btn.innerHTML = ring(busy.fraction);
      btn.classList.add("saving");
      btn.title = `正在保存到本机 ${Math.round(busy.fraction * 100)}%`;
      return btn;
    }
    btn.append(icon("download"));
    if (busy) {
      btn.append(h("span", { class: "mark queued" }));
      btn.title = "等待保存到本机";
    } else if (saved) {
      const full = !saved.total || saved.segments >= saved.total;
      btn.append(full ? h("span", { class: "mark ok" }, icon("tick")) : h("span", { class: "mark partial" }));
      btn.title = `已存本机（${formatBytes(saved.bytes)}，${offlineAudio(saved)}）`;
    } else {
      btn.title = "下载";
    }
    return btn;
  }

  function stateButton(book: BookDetail, c: ChapterInfo): HTMLElement {
    const btn = h("button", { class: `state ${c.audio}`, type: "button" });
    switch (c.audio) {
      case "done":
        if (c.silent) {
          btn.append(icon("image"));
          btn.title = "仅插图";
          btn.disabled = true;
          break;
        }
        btn.append(icon("play"));
        btn.title = "播放";
        btn.addEventListener("click", () => play(book, c));
        break;
      case "running": {
        const p = (c.progress ?? 0) / 100;
        btn.innerHTML = ring(p);
        btn.title = `生成中 ${c.progress ?? 0}%（点击取消）`;
        btn.addEventListener("click", () => cancel(btn, c));
        break;
      }
      case "queued":
        btn.append(icon("clock"));
        btn.title = "排队中（点击取消）";
        btn.addEventListener("click", () => cancel(btn, c));
        break;
      case "failed":
        btn.append(icon("alert"));
        btn.title = `${c.message ?? "失败"}（点击重试）`;
        btn.addEventListener("click", () => void generate(btn, { chapters: [c.chapterId] }, "本章"));
        break;
      case "stale":
        btn.append(icon("stale"));
        btn.title = "用当前声音重新生成";
        btn.addEventListener("click", () => void generate(btn, { chapters: [c.chapterId] }, "本章"));
        break;
      default:
        btn.append(icon("gen"));
        btn.title = "生成语音";
        btn.addEventListener("click", () => void generate(btn, { chapters: [c.chapterId] }, "本章"));
    }
    return btn;
  }

  /** Text downloads may fetch chapters from the (rate-limited) site first. */
  function saveText(btn: HTMLButtonElement, url: string) {
    const slow = setTimeout(() => toast("正在从网站获取原文…"), 800);
    return act(btn, () => download(url)).finally(() => clearTimeout(slow));
  }

  function cancel(btn: HTMLButtonElement, c: ChapterInfo) {
    if (!c.jobId) return;
    void act(btn, async () => {
      await api.post(`/api/jobs/${c.jobId}/cancel`);
      refresh();
    });
  }

  function dangerZone(book: BookDetail): HTMLElement {
    const delAudio = h("button", { class: "btn small danger", disabled: !book.audioBytes }, "删除本书音频");
    delAudio.addEventListener("click", () => {
      if (!confirm("删除本书所有已生成的章节音频和导出文件？（缓存的语音片段保留，重新生成时不会再次请求）")) return;
      void act(delAudio, async () => {
        await api.del(`/api/books/${id}/audio`);
        toast("已删除音频");
        refresh();
      });
    });
    const delBook = h("button", { class: "btn small danger" }, "从书架移除");
    delBook.addEventListener("click", () => {
      if (!confirm(`从书架移除《${book.title}》？已生成的音频也会删除。`)) return;
      void act(delBook, async () => {
        await api.del(`/api/books/${id}`);
        toast("已移除");
        navigate("/", true);
      });
    });
    return h(
      "section",
      { class: "card" },
      h(
        "div",
        { class: "row" },
        h("div", { class: "grow" }, h("div", { class: "label" }, "原网页"), h("div", { class: "hint mono" }, book.sourceUrl)),
        h("a", { class: "btn small", href: book.sourceUrl, target: "_blank", rel: "noopener" }, "打开"),
      ),
      h("div", { class: "actions" }, delAudio, delBook),
    );
  }

  // Drawn at once from the last answers; the server's replace them when they come.
  voices = api.cached<BookVoices>(`/api/books/${id}/voices`);
  const kept = api.cached<BookDetail>(`/api/books/${id}`);
  if (kept) show(kept);
  void load().catch((err: Error) => (kept ? toast(err.message) : body.replaceChildren(h("div", { class: "banner error" }, err.message))));
  const stop = poll(() => load(), 3000);
  // Saving on this device: redrawn as it goes (at most once a frame).
  let frame = 0;
  const unsubscribe = onSaveChange(() => {
    if (frame || !shown) return;
    frame = requestAnimationFrame(() => {
      frame = 0;
      if (shown) draw(shown);
    });
  });
  return {
    el,
    dispose: () => {
      stop();
      unsubscribe();
      cancelAnimationFrame(frame);
      player?.remove();
      sheet?.close();
    },
  };
}

function firstChapter(book: BookDetail): { chapterId: string; pageIndex: number } | undefined {
  for (const v of book.volumes) for (const c of v.chapters) if (c.chapterId) return { chapterId: c.chapterId, pageIndex: 0 };
  return undefined;
}

function currentVolume(book: BookDetail): number {
  const id = book.position?.chapterId;
  return id ? book.volumes.findIndex((v) => v.chapters.some((c) => c.chapterId === id)) : -1;
}

function ring(fraction: number): string {
  const r = 9;
  const len = 2 * Math.PI * r;
  return `<svg class="ring" viewBox="0 0 22 22"><circle class="track" cx="11" cy="11" r="${r}"/><circle class="bar" cx="11" cy="11" r="${r}" stroke-dasharray="${len}" stroke-dashoffset="${len * (1 - fraction)}"/></svg>`;
}

function offlineAudio(saved: SavedChapter): string {
  return saved.total ? `语音 ${saved.segments}/${saved.total} 段` : "无语音";
}
