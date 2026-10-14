import { h } from "../../../src/utils/dom";
import type { JobInfo, JobStatus, JobsOverview } from "../../shared/api";
import { api } from "../api";
import { act, formatTime, poll, progressBar, toast, topbar, type Page } from "../ui";

const STATUS_LABEL: Record<JobStatus, string> = {
  queued: "排队",
  running: "进行中",
  done: "完成",
  failed: "失败",
  cancelled: "已取消",
};
const PROVIDER_LABEL: Record<string, string> = { gemini: "Gemini", fish: "Fish Audio", site: "哔哩轻小说" };

/** The generation queue. */
export function jobsPage(): Page {
  const el = h("div");
  const pauseBtn = h("button", { class: "btn small" });
  el.append(topbar("任务", undefined, pauseBtn));
  const body = h("div");
  el.append(body);
  let state: JobsOverview | undefined;
  let last = "";

  pauseBtn.addEventListener("click", () =>
    void act(pauseBtn, async () => {
      await api.post(state?.paused ? "/api/jobs/resume" : "/api/jobs/pause");
      await load();
    }),
  );

  const load = async () => {
    const data = await api.get<JobsOverview>("/api/jobs");
    state = data;
    pauseBtn.textContent = data.paused ? "继续" : "暂停";
    pauseBtn.className = data.paused ? "btn small primary" : "btn small";
    const sig = JSON.stringify(data);
    if (sig === last) return;
    last = sig;
    body.replaceChildren(...render(data));
  };

  function render(data: JobsOverview): Node[] {
    const nodes: Node[] = [];
    if (data.paused) nodes.push(h("div", { class: "banner" }, "队列已暂停：新任务会排队，但不会开始生成。"));
    for (const [provider, block] of Object.entries(data.blocked)) {
      if (!block) continue;
      const retry = h("button", { class: "btn small" }, "重试");
      retry.addEventListener("click", () =>
        void act(retry, async () => {
          await api.post("/api/jobs/resume");
          await load();
        }),
      );
      nodes.push(
        h(
          "div",
          { class: "banner error" },
          h(
            "div",
            { class: "grow" },
            h("b", {}, `${PROVIDER_LABEL[provider] ?? provider} 已停用`),
            h("div", {}, block.message),
            h("div", { class: "hint" }, `${formatTime(block.since)} · 修改设置后自动恢复 · `, h("a", { href: "/settings", "data-link": true }, "前往设置")),
          ),
          retry,
        ),
      );
    }
    const c = data.counts;
    const clear = h("button", { class: "btn small ghost" }, "清除已结束");
    clear.addEventListener("click", () =>
      void act(clear, async () => {
        await api.post("/api/jobs/clear");
        await load();
      }),
    );
    nodes.push(
      h(
        "div",
        { class: "counts" },
        h("span", { class: "badge" }, `进行中 ${c.running}`),
        h("span", { class: "badge muted" }, `排队 ${c.queued}`),
        h("span", { class: "badge ok" }, `完成 ${c.done}`),
        c.failed ? h("span", { class: "badge", style: "color:var(--danger);background:var(--danger-soft)" }, `失败 ${c.failed}`) : null,
        c.done + c.failed + c.cancelled ? clear : null,
      ),
    );
    if (!data.jobs.length) {
      nodes.push(h("div", { class: "empty" }, h("div", { class: "big" }, "🎧"), h("div", {}, "没有任务"), h("div", { class: "hint" }, "在书籍页面生成章节，或开启“跟随阅读进度”")));
      return nodes;
    }
    const active = data.jobs.filter((j) => j.status === "running" || j.status === "queued");
    const finished = data.jobs.filter((j) => j.status !== "running" && j.status !== "queued");
    if (active.length) nodes.push(h("div", { class: "section-title" }, "队列"), h("section", { class: "card" }, ...active.map(job)));
    if (finished.length) nodes.push(h("div", { class: "section-title" }, "最近"), h("section", { class: "card" }, ...finished.map(job)));
    return nodes;
  }

  function job(j: JobInfo): HTMLElement {
    const buttons: HTMLElement[] = [];
    if (j.status === "queued" || j.status === "running") {
      const cancel = h("button", { class: "btn small ghost" }, "取消");
      cancel.addEventListener("click", () => void act(cancel, async () => (await api.post(`/api/jobs/${j.id}/cancel`), await load())));
      buttons.push(cancel);
    } else if (j.status === "failed" || j.status === "cancelled") {
      const retry = h("button", { class: "btn small" }, "重试");
      retry.addEventListener("click", () => void act(retry, async () => (await api.post(`/api/jobs/${j.id}/retry`), await load())));
      buttons.push(retry);
    }
    const msg =
      j.status === "failed"
        ? h("div", { class: "msg error" }, j.error ?? "失败")
        : j.notBefore && j.notBefore > Date.now() && j.status === "queued"
          ? h("div", { class: "msg" }, `${j.message ?? "等待"} · ${formatTime(j.notBefore)}重试`)
          : j.message
            ? h("div", { class: "msg" }, j.message)
            : null;
    return h(
      "div",
      { class: "job" },
      h(
        "div",
        { class: "body" },
        h("div", { class: "title" }, j.title),
        h(
          "a",
          { class: "book", href: `/book/${j.bookId}`, "data-link": true },
          `${j.bookTitle} · ${j.kind === "export" ? "导出" : j.reason === "follow" ? "跟随阅读" : "手动"} · ${STATUS_LABEL[j.status]} · ${formatTime(j.updatedAt)}`,
        ),
        msg,
        j.status === "running" ? progressBar(j.progress) : null,
      ),
      ...buttons,
    );
  }

  void load().catch((err: Error) => toast(err.message));
  return { el, dispose: poll(load, 2000) };
}
