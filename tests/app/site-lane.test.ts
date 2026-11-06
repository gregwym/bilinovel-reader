// @vitest-environment node
import { describe, expect, it } from "vitest";
import { SiteClient } from "../../app/server/site/client";

const settings = () => ({ siteOrigin: "https://www.bilinovel.com", cookie: "", userAgent: "test", flaresolverrUrl: "", requestIntervalMs: 0 });
const site = "https://www.bilinovel.com/novel/1";

describe("site request lane", () => {
  it("serves what a person waits for before background work, one request at a time", async () => {
    const order: string[] = [];
    let running = 0;
    const client = new SiteClient(settings, async (url) => {
      expect(++running).toBe(1);
      await new Promise((r) => setTimeout(r, 5));
      running--;
      order.push(new URL(url).pathname);
      return new Response("<html></html>");
    });
    // Background work queued first (the catalog placeholder lookup, downloads)…
    const background = [1, 2, 3, 4].map((i) => client.html(`${site}/${i}.html`, 0, true));
    await new Promise((r) => setTimeout(r, 1));
    // …then a catalog refresh and the reader's page: they go next, not after all of it.
    const catalog = client.html(`${site}/catalog`, 0);
    const page = client.html(`${site}/9.html`, 0);
    await Promise.all([...background, catalog, page]);
    expect(order).toEqual(["/novel/1/1.html", "/novel/1/catalog", "/novel/1/9.html", "/novel/1/2.html", "/novel/1/3.html", "/novel/1/4.html"]);
  });

  it("moves a background page up once someone waits for it", async () => {
    const order: string[] = [];
    const client = new SiteClient(settings, async (url) => {
      await new Promise((r) => setTimeout(r, 5));
      order.push(new URL(url).pathname);
      return new Response("<html></html>");
    });
    const background = [1, 2, 3].map((i) => client.html(`${site}/${i}.html`, 0, true));
    await new Promise((r) => setTimeout(r, 1));
    client.promote(`${site}/3.html`);
    await Promise.all(background);
    expect(order).toEqual(["/novel/1/1.html", "/novel/1/3.html", "/novel/1/2.html"]);
  });
});
