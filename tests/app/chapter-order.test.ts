// @vitest-environment node
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { loadConfig } from "../../app/server/config";
import { createApp } from "../../app/server/http";
import { createServices } from "../../app/server/services";
import type { PageContent } from "../../src/adapters/types";
import { fixture } from "../helpers";

const chapter = "https://www.bilinovel.com/novel/5370/288458.html";
const script = "https://www.bilinovel.com/themes/zhmb/js/chapterlog.js?v=ab-31c8e376ac18bf14299e20e7";
const partial = fixture("incomplete-2026-11-27.html");
const placeholder = (n: number) => `占位段落 ${n}`;
const range = (count: number) => Array.from({ length: count }, (_, i) => i + 1);

async function readPage(html: string): Promise<PageContent> {
  const dir = mkdtempSync(join(tmpdir(), "bili-chapter-order-"));
  const services = createServices(loadConfig({}, dir), "test", {
    fetch: async (url) => {
      if (url === chapter) return new Response(html, { headers: { "content-type": "text/html" } });
      if (url === script) return new Response(fixture("chapterlog-2026-11-27.js"), { headers: { "content-type": "application/javascript" } });
      throw new Error(`Unexpected request: ${url}`);
    },
  });
  services.jobs.setPaused(true);
  try {
    const res = await createApp(services).request("/api/page?book=5370&chapter=288458&page=0");
    const body = await res.json();
    expect(res.status, JSON.stringify(body)).toBe(200);
    return body;
  } finally {
    services.jobs.stop();
    services.db.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

it("reads the paragraphs actually sent by the public sample and reports it as incomplete", async () => {
  const page = await readPage(partial);
  expect(page).toMatchObject({ incomplete: true, nextType: "same-chapter-page" });
  expect(page.paragraphs.map((p) => p.text)).toEqual(range(11).map(placeholder));
});

it("reads a full page using the new script's paragraph order", async () => {
  // Precomputed independently from the sampled arithmetic, for chapter 288458.
  const scrambled = [...range(20), 26, 31, 29, 32, 30, 22, 27, 21, 28, 25, 24, 23];
  const full = partial.replace(/<p>[\s\S]+?(?=<\/div>)/, scrambled.map((n) => `<p>${placeholder(n)}</p>`).join(""));
  const page = await readPage(full);
  expect(page.incomplete).toBeUndefined();
  expect(page.paragraphs.map((p) => p.text)).toEqual(range(32).map(placeholder));
});
