import { h } from "../../src/utils/dom";
import type { BookDetail, ChapterInfo, ChapterSegments } from "../shared/api";
import { api } from "./api";
import { act, download, icon, menu, poll } from "./ui";

/**
 * A chapter's speech segments in a bottom sheet: each one can be played as
 * soon as it is generated, without waiting for the whole chapter. Playback
 * continues with the next segment, and waits for it while it is generating.
 */
export function segmentSheet(book: BookDetail, chapter: ChapterInfo): { close: () => void } {
  const audio = h("audio", { controls: true, preload: "auto" });
  const status = h("div", { class: "hint" }, "加载中…");
  const chips = h("div", { class: "chips" });
  const list = h("ol", { class: "segments" });
  /** Profile id of the voice shown ("" for the current one). */
  let voice = "";
  let data: ChapterSegments | undefined;
  /** Index playing, or waiting to play once generated. */
  let current = -1;
  let waiting = false;
  let last = "";

  const close = () => {
    stop();
    audio.pause();
    audio.removeAttribute("src");
    backdrop.remove();
    document.removeEventListener("keydown", onKey);
  };
  const onKey = (ev: KeyboardEvent) => ev.key === "Escape" && close();
  const closeBtn = h("button", { class: "icon-btn", "aria-label": "关闭", onclick: close }, icon("close"));
  const sheet = h(
    "div",
    { class: "sheet", role: "dialog", "aria-label": `${chapter.title} 的语音片段` },
    h("header", {}, h("div", { class: "grow" }, h("b", {}, chapter.title), status), closeBtn),
    chips,
    audio,
    list,
  );
  const backdrop = h("div", { class: "sheet-backdrop" }, sheet);
  backdrop.addEventListener("click", (ev) => ev.target === backdrop && close());
  document.addEventListener("keydown", onKey);
  document.body.append(backdrop);

  /** Another voice than the current one: nothing more will be generated in it. */
  const old = () => !!data && !data.voices.find((v) => v.id === data!.voice)?.current;

  const play = (i: number) => {
    if (old() && !data?.segments[i]?.ready) {
      // Skip to the next segment there is audio for.
      const next = data!.segments.findIndex((s, j) => j > i && s.ready);
      if (next < 0) {
        current = -1;
        render();
        return;
      }
      i = next;
    }
    current = i;
    const seg = data?.segments[i];
    if (!seg?.ready || !data) {
      // Not generated yet: start as soon as the next refresh finds it.
      waiting = !!seg || !data?.complete;
      audio.pause();
      render();
      return;
    }
    waiting = false;
    audio.src = `/api/segments/${data.provider}/${encodeURIComponent(seg.key)}`;
    void audio.play().catch(() => undefined);
    if ("mediaSession" in navigator) {
      navigator.mediaSession.metadata = new MediaMetadata({
        title: `${chapter.title}（${i + 1}）`,
        artist: book.author,
        album: book.title,
        artwork: book.hasCover ? [{ src: `/api/books/${book.id}/cover`, type: "image/jpeg" }] : [],
      });
    }
    render();
    list.children[i]?.scrollIntoView({ block: "nearest" });
  };

  audio.addEventListener("ended", () => {
    if (!data) return;
    if (current + 1 < data.segments.length || (!data.complete && !old())) play(current + 1);
    else current = -1;
    render();
  });

  const pick = (id: string) => {
    if (id === data?.voice) return;
    voice = id;
    current = -1;
    waiting = false;
    audio.pause();
    audio.removeAttribute("src");
    void load().catch((err: Error) => (status.textContent = err.message));
  };

  function render() {
    if (!data) return;
    const d = data;
    // Other voices with audio of this chapter can be listened to as well.
    chips.replaceChildren(
      ...(d.voices.length > 1
        ? d.voices.map((v) =>
            h(
              "button",
              { type: "button", class: v.id === d.voice ? "chip on" : "chip", onclick: () => pick(v.id) },
              v.label.replace(/^(Fish Audio|Gemini) · /, ""),
              v.current ? h("span", { class: "tag" }, "当前") : null,
              h("span", { class: "count" }, String(v.ready)),
            ),
          )
        : []),
    );
    const ready = data.segments.filter((s) => s.ready).length;
    const total = data.segments.length;
    status.textContent = !total
      ? data.complete
        ? "本章没有可朗读的文字"
        : "正文尚未获取，开始生成后这里会列出片段"
      : `${ready}/${total}${data.complete ? "" : "+"} 段已生成 · ${old() ? "旧声音，只能播放已有的段" : "点击任一段试听"}`;
    list.replaceChildren(
      ...data.segments.map((s, i) => {
        const playing = i === current;
        const li = h(
          "li",
          { class: ["segment", s.ready ? "ready" : "", playing ? "playing" : ""].join(" ").trim(), title: s.ready ? "播放" : "尚未生成" },
          h("span", { class: "no" }, String(i + 1)),
          h("span", { class: "text" }, s.text + (s.chars > s.text.length ? "…" : "")),
          h(
            "span",
            { class: "state" },
            playing && waiting ? h("span", { class: "spin dark" }) : s.ready ? icon(playing ? "wave" : "play") : h("span", { class: "hint" }, "未生成"),
          ),
          downloadButton(i, s.ready),
          s.ready && !old()
            ? h(
                "button",
                {
                  type: "button",
                  class: "icon-btn redo",
                  title: "重新生成",
                  "aria-label": `重新生成第 ${i + 1} 段`,
                  onclick: (ev: Event) => {
                    ev.stopPropagation();
                    void regenerate(i);
                  },
                },
                icon("stale"),
              )
            : null,
        );
        li.addEventListener("click", () => play(i));
        return li;
      }),
    );
    if (waiting && current >= total) list.append(h("li", { class: "segment" }, h("span", { class: "hint" }, "等待下一段生成…")));
  }

  /** Download menu of one segment: its audio (once generated) or its text. */
  function downloadButton(i: number, ready: boolean): HTMLButtonElement {
    const btn = h(
      "button",
      { type: "button", class: "icon-btn redo", title: "下载", "aria-label": `下载第 ${i + 1} 段` },
      icon("download"),
    );
    btn.addEventListener("click", (ev) => ev.stopPropagation());
    const base = `/api/books/${book.id}/chapters/${chapter.chapterId}/segments/${i}`;
    const query = data ? `?voice=${encodeURIComponent(data.voice)}` : "";
    menu(btn, () => [
      ready ? { label: "语音（MP3）", href: `${base}/audio${query}` } : { label: "语音（MP3）", hint: "尚未生成", disabled: true },
      { label: "原文（TXT）", run: () => act(btn, () => download(`${base}/text${query}`)) },
    ]);
    return btn;
  }

  /** Drops a segment (e.g. garbled by the service) and has it generated again. */
  const regenerate = async (i: number) => {
    if (!confirm(`重新生成第 ${i + 1} 段？当前的音频会被删除，并重新请求一次语音服务。`)) return;
    if (i === current) {
      audio.pause();
      audio.removeAttribute("src");
      waiting = true;
    }
    try {
      await api.post(`/api/books/${book.id}/chapters/${chapter.chapterId}/segments/${i}/regenerate`);
      await load();
    } catch (err) {
      status.textContent = (err as Error).message;
    }
  };

  const load = async () => {
    const query = voice ? `?voice=${encodeURIComponent(voice)}` : "";
    const next = await api.get<ChapterSegments>(`/api/books/${book.id}/chapters/${chapter.chapterId}/segments${query}`);
    const sig = JSON.stringify(next);
    if (sig === last) return;
    last = sig;
    data = next;
    if (waiting && data.segments[current]?.ready) play(current);
    else render();
  };
  void load().catch((err: Error) => (status.textContent = err.message));
  const stop = poll(load, 3000);
  return { close };
}
