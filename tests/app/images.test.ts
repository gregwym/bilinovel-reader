// @vitest-environment node
import { describe, expect, it } from "vitest";
import { mkdtempSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Images } from "../../app/server/images";
import type { Db } from "../../app/server/db";
import type { SiteClient } from "../../app/server/site/client";

const URL_ = "https://img3.readpai.com/0/1/2/1.jpg";

function setup(delay = 20) {
  const dir = mkdtempSync(join(tmpdir(), "images-"));
  const body = Buffer.alloc(3_000_000, 7);
  let downloads = 0;
  const client = {
    binary: async () => {
      downloads++;
      await new Promise((r) => setTimeout(r, delay * downloads));
      return { body, type: "image/jpeg" };
    },
  } as unknown as SiteClient;
  const db = { all: () => [] } as unknown as Db;
  return { images: new Images(db, client, dir, dir, () => "https://www.bilinovel.com/"), body, downloads: () => downloads };
}

describe("illustration cache", () => {
  it("fetches an illustration asked for twice at once only once", async () => {
    const { images, body, downloads } = setup();
    const [a, b] = await Promise.all([images.load(URL_), images.load(URL_)]);
    expect(downloads()).toBe(1);
    expect(a.body.length).toBe(body.length);
    expect(b.body.length).toBe(body.length);
  });

  it("never serves a half-written illustration", async () => {
    const { images, body } = setup();
    // The backup and the reader's request start before either has saved it.
    const loads = Promise.all([images.load(URL_), images.load(URL_)]);
    const sizes = new Set<number>();
    let done = false;
    void loads.then(() => (done = true));
    while (!done) {
      const found = await images.find(URL_);
      if (found) sizes.add(statSync(found.file).size);
      await new Promise((r) => setImmediate(r));
    }
    const found = await images.find(URL_);
    if (found) sizes.add(statSync(found.file).size);
    expect([...sizes]).toEqual([body.length]);
  });
});
