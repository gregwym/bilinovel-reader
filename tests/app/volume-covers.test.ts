// @vitest-environment node
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadConfig } from "../../app/server/config";
import { createServices } from "../../app/server/services";
import { createApp } from "../../app/server/http";
import type { Catalog } from "../../src/adapters/types";

const catalog: Catalog = {
  bookId: "10",
  volumes: [0, 1, 2].map((i) => ({ title: `卷${i}`, cover: `https://img3.readpai.com/0/10/${i}.jpg`, chapters: [{ title: "章", chapterId: String(100 + i) }] })),
};
const dirs: string[] = [];
const opened: ReturnType<typeof createServices>[] = [];
afterEach(() => {
  for (const s of opened.splice(0)) {
    s.jobs.stop();
    s.db.close();
  }
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("volume covers", () => {
  it("are answered without waiting for a slow image host", async () => {
    const dir = mkdtempSync(join(tmpdir(), "bili-covers-"));
    dirs.push(dir);
    const config = loadConfig({ DATA_DIR: join(dir, "data"), LIBRARY_DIR: join(dir, "library") }, dir);
    const asked: string[] = [];
    // An image host that never answers (until the request times out).
    const s = createServices(config, "test", {
      fetch: (url, init) => {
        asked.push(url);
        return new Promise((_, reject) => init?.signal?.addEventListener("abort", () => reject(init.signal!.reason)));
      },
    });
    opened.push(s);
    s.jobs.setPaused(true);
    s.db.run("insert into books(id,title,catalog,catalog_at,added_at,follow) values(?,?,?,?,?,0)", "10", "书", JSON.stringify(catalog), 1, 1);
    const bookCover = s.library.coverFile("10");
    mkdirSync(dirname(bookCover), { recursive: true });
    writeFileSync(bookCover, "book cover");
    const app = createApp(s);

    // The book page asks for every volume's at once: each is answered now, with the book's in its place.
    const started = Date.now();
    const answers = await Promise.all([0, 1, 2].map((i) => app.request(`/api/books/10/volumes/${i}/cover`)));
    expect(Date.now() - started).toBeLessThan(1000);
    expect(answers.map((r) => r.status)).toEqual([200, 200, 200]);
    expect(await answers[0].text()).toBe("book cover");
    // Kept only briefly: the volume's own shows once it is fetched.
    expect(answers[0].headers.get("cache-control")).toBe("private, max-age=600");
    expect(asked).toHaveLength(1);
  });

  it("that failed are left alone for a while", async () => {
    const dir = mkdtempSync(join(tmpdir(), "bili-covers-"));
    dirs.push(dir);
    const config = loadConfig({ DATA_DIR: join(dir, "data"), LIBRARY_DIR: join(dir, "library") }, dir);
    const asked: string[] = [];
    const s = createServices(config, "test", {
      fetch: async (url) => {
        asked.push(url);
        return new Response("", { status: 404 });
      },
    });
    opened.push(s);
    s.jobs.setPaused(true);
    s.db.run("insert into books(id,title,catalog,catalog_at,added_at,follow) values(?,?,?,?,?,0)", "10", "书", JSON.stringify(catalog), 1, 1);
    await s.library.updateCovers("10");
    expect(asked).toHaveLength(3);
    // Every catalog save (a refresh) runs this again: the image queue isn't taken by the same failures.
    await s.library.updateCovers("10");
    expect(asked).toHaveLength(3);
  });
});
