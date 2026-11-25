// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import type { JobsOverview, ProviderBlock } from "../../app/shared/api";

const server = vi.hoisted(() => ({ overview: undefined as unknown, posted: [] as string[] }));
vi.mock("../../app/web/api", () => ({
  api: {
    cached: () => server.overview,
    keep: async () => server.overview,
    post: async (path: string) => void server.posted.push(path),
  },
}));
vi.mock("../../app/web/offline", () => ({
  offlineSupported: false,
  saveTasks: () => [],
  onSaveChange: () => () => undefined,
  cancelSave: () => undefined,
}));

const { jobsPage } = await import("../../app/web/pages/jobs");

function show(fish: ProviderBlock) {
  const overview: JobsOverview = { paused: false, blocked: { fish }, jobs: [], counts: { queued: 0, running: 0, done: 0, failed: 0, cancelled: 0 } };
  server.overview = overview;
  const page = jobsPage();
  document.body.append(page.el);
  return page;
}

afterEach(() => {
  document.body.replaceChildren();
  server.posted = [];
});

describe("jobs page", () => {
  it("says a service that is down for now is tried again by itself", async () => {
    const page = show({ code: "server", message: "Fish Audio 服务暂时出错", since: Date.now() - 5 * 60_000, retryAt: Date.now() + 4 * 60_000 - 1000 });
    const banner = page.el.querySelector(".banner")!;
    expect(banner.textContent).toContain("Fish Audio 暂时不可用");
    expect(banner.textContent).toContain("Fish Audio 服务暂时出错");
    expect(banner.textContent).toContain("4 分钟后自动重试");
    expect(banner.textContent).not.toContain("前往设置");
    const retry = banner.querySelector("button")!;
    expect(retry.textContent).toBe("立即重试");
    retry.click();
    await vi.waitFor(() => expect(server.posted).toEqual(["/api/jobs/resume"]));
    page.dispose?.();
  });

  it("sends the user to settings for what only they can fix", () => {
    const page = show({ code: "auth", message: "Fish Audio 密钥不正确", since: Date.now() - 5 * 60_000 });
    const banner = page.el.querySelector(".banner")!;
    expect(banner.textContent).toContain("Fish Audio 已停用");
    expect(banner.textContent).toContain("前往设置");
    expect(banner.querySelector("button")!.textContent).toBe("重试");
    page.dispose?.();
  });
});
