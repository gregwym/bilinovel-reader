import { describe, expect, it } from "vitest";
import { RequestQueue, looksLikeChallenge } from "../src/utils/RequestQueue";
import { FetchError } from "../src/adapters/types";
import { MemoryStore, ProgressStore, SettingsStore, DEFAULT_SETTINGS } from "../src/reader/ProgressStore";

function fakeClock() {
  let t = 1_000_000;
  const sleeps: number[] = [];
  return {
    now: () => t,
    sleep: async (ms: number) => {
      sleeps.push(ms);
      t += ms;
    },
    sleeps,
  };
}

const response = (status: number, body = "<html>ok</html>") =>
  ({ ok: status >= 200 && status < 300, status, text: async () => body }) as Response;

describe("RequestQueue", () => {
  it("runs one request at a time and enforces the minimum interval", async () => {
    const clock = fakeClock();
    const log: string[] = [];
    let active = 0;
    const q = new RequestQueue({
      minIntervalMs: 4000,
      now: clock.now,
      sleep: clock.sleep,
      fetchImpl: (async (url: string) => {
        active++;
        expect(active).toBe(1);
        log.push(url);
        await Promise.resolve();
        active--;
        return response(200);
      }) as typeof fetch,
    });
    await Promise.all([q.fetchText("a"), q.fetchText("b"), q.fetchText("c")]);
    expect(log).toEqual(["a", "b", "c"]);
    expect(clock.sleeps).toEqual([4000, 4000]);
  });

  it("de-duplicates identical in-flight requests", async () => {
    const clock = fakeClock();
    let calls = 0;
    const q = new RequestQueue({
      now: clock.now,
      sleep: clock.sleep,
      fetchImpl: (async () => (calls++, response(200))) as typeof fetch,
    });
    await Promise.all([q.fetchText("a"), q.fetchText("a")]);
    expect(calls).toBe(1);
  });

  it("retries temporary failures with exponential backoff", async () => {
    const clock = fakeClock();
    const statuses = [503, 503, 200];
    const q = new RequestQueue({
      minIntervalMs: 0,
      backoffBaseMs: 1000,
      now: clock.now,
      sleep: clock.sleep,
      fetchImpl: (async () => response(statuses.shift()!)) as typeof fetch,
    });
    await expect(q.fetchText("a")).resolves.toContain("ok");
    expect(clock.sleeps).toEqual([1000, 2000]);
  });

  it("does not retry 404 and gives up after maxRetries", async () => {
    const clock = fakeClock();
    let calls = 0;
    const q404 = new RequestQueue({
      now: clock.now,
      sleep: clock.sleep,
      fetchImpl: (async () => (calls++, response(404))) as typeof fetch,
    });
    await expect(q404.fetchText("a")).rejects.toBeInstanceOf(FetchError);
    expect(calls).toBe(1);

    calls = 0;
    const qNet = new RequestQueue({
      maxRetries: 2,
      now: clock.now,
      sleep: clock.sleep,
      fetchImpl: (async () => {
        calls++;
        throw new TypeError("Load failed");
      }) as typeof fetch,
    });
    await expect(qNet.fetchText("a")).rejects.toBeInstanceOf(FetchError);
    expect(calls).toBe(3);
  });

  it("recognises bot challenges and does not retry them", async () => {
    const clock = fakeClock();
    let calls = 0;
    const q = new RequestQueue({
      now: clock.now,
      sleep: clock.sleep,
      fetchImpl: (async () => (calls++, response(403, "<title>Just a moment...</title>"))) as typeof fetch,
    });
    await expect(q.fetchText("a")).rejects.toMatchObject({ challenge: true });
    expect(calls).toBe(1);
    expect(looksLikeChallenge("<p>normal</p>")).toBe(false);
  });

  it("continues with later requests after one fails", async () => {
    const clock = fakeClock();
    const q = new RequestQueue({
      maxRetries: 0,
      now: clock.now,
      sleep: clock.sleep,
      fetchImpl: (async (url: string) => response(url === "bad" ? 404 : 200)) as typeof fetch,
    });
    await expect(q.fetchText("bad")).rejects.toBeTruthy();
    await expect(q.fetchText("good")).resolves.toContain("ok");
  });
});

describe("ProgressStore", () => {
  it("stores progress per book", async () => {
    const store = new ProgressStore(new MemoryStore());
    await store.save({ bookId: "1", chapterId: "10", pageIndex: 1, paragraphIndex: 5 }, { chapterTitle: "c" });
    await store.save({ bookId: "2", chapterId: "20", pageIndex: 0, paragraphIndex: 0 });
    expect(await store.get("1")).toMatchObject({ chapterId: "10", pageIndex: 1, paragraphIndex: 5, chapterTitle: "c" });
    expect((await store.get("1"))?.updatedAt).toBeTypeOf("number");
    expect(await store.get("3")).toBeUndefined();
  });

  it("survives corrupt data", async () => {
    const kv = new MemoryStore();
    await kv.set("biliReader.progress", "{not json");
    expect(await new ProgressStore(kv).get("1")).toBeUndefined();
  });
});

describe("SettingsStore", () => {
  it("returns defaults and sanitises stored values", async () => {
    const kv = new MemoryStore();
    const store = new SettingsStore(kv);
    expect(await store.load()).toEqual(DEFAULT_SETTINGS);
    await kv.set("biliReader.settings", JSON.stringify({ fontSize: 999, theme: "neon", rate: 1.2 }));
    const s = await store.load();
    expect(s.fontSize).toBe(32);
    expect(s.theme).toBe("system");
    expect(s.rate).toBe(1.2);
  });
});
