import { h } from "../../src/utils/dom";
import type { BookDetail, ChapterInfo, ChapterSegments } from "../shared/api";
import { api } from "./api";
import { icon, poll } from "./ui";

/**
 * A chapter's speech segments in a bottom sheet: each one can be played as
 * soon as it is generated, without waiting for the whole chapter. Playback
 * continues with the next segment, and waits for it while it is generating.
 */
export function segmentSheet(book: BookDetail, chapter: ChapterInfo): { close: () => void } {
  const audio = h("audio", { controls: true, preload: "auto" });
  const status = h("div", { class: "hint" }, "加载中…");
  const list = h("ol", { class: "segments" });
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
    audio,
    list,
  );
  const backdrop = h("div", { class: "sheet-backdrop" }, sheet);
  backdrop.addEventListener("click", (ev) => ev.target === backdrop && close());
  document.addEventListener("keydown", onKey);
  document.body.append(backdrop);

  const play = (i: number) => {
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
    if (current + 1 < data.segments.length || !data.complete) play(current + 1);
    else current = -1;
    render();
  });

  function render() {
    if (!data) return;
    const ready = data.segments.filter((s) => s.ready).length;
    const total = data.segments.length;
    status.textContent = !total
      ? data.complete
        ? "本章没有可朗读的文字"
        : "正文尚未获取，开始生成后这里会列出片段"
      : `${ready}/${total}${data.complete ? "" : "+"} 段已生成 · 点击任一段试听`;
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
        );
        li.addEventListener("click", () => play(i));
        return li;
      }),
    );
    if (waiting && current >= total) list.append(h("li", { class: "segment" }, h("span", { class: "hint" }, "等待下一段生成…")));
  }

  const load = async () => {
    const next = await api.get<ChapterSegments>(`/api/books/${book.id}/chapters/${chapter.chapterId}/segments`);
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
