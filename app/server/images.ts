import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Db } from "./db";
import type { SiteClient } from "./site/client";

export class NotImageError extends Error {}

export interface ImageFile {
  file: string;
  type: string;
}

/**
 * Illustrations: fetched through the server (the site checks the referrer)
 * and kept in the data folder. One saved into the library (see backup.ts) is
 * served from there when the data folder doesn't have it, without asking the
 * site.
 */
export class Images {
  constructor(
    private readonly db: Db,
    private readonly client: SiteClient,
    private readonly dataDir: string,
    private readonly libraryDir: string,
    private readonly referer: () => string,
  ) {}

  private cacheFile(url: string): string {
    const digest = createHash("sha1").update(url).digest("hex");
    return join(this.dataDir, "images", digest.slice(0, 2), digest);
  }

  /** Where an image already is (data folder, then library), without a request. */
  async find(url: string): Promise<ImageFile | undefined> {
    const file = this.cacheFile(url);
    if (existsSync(file) && existsSync(`${file}.type`)) return { file, type: (await readFile(`${file}.type`, "utf8")).trim() };
    const rows = this.db.all<{ file: string; type: string }>("select file, type from backup_images where url = ?", url);
    for (const row of rows) {
      const abs = join(this.libraryDir, ...row.file.split("/"));
      if (existsSync(abs)) return { file: abs, type: row.type };
    }
    return undefined;
  }

  /**
   * An image: from where it already is, else fetched from the site (and kept). Throws if it isn't an image.
   *
   * The reader and the library backup often ask for the same illustration at
   * once: it is fetched once, and the file only appears when it is whole (a
   * half-written one would be served, and the browser keeps it for good).
   */
  load(url: string): Promise<{ body: Buffer; type: string }> {
    let p = this.inflight.get(url);
    if (!p) {
      p = this.fetchAndKeep(url);
      this.inflight.set(url, p);
      const done = () => this.inflight.delete(url);
      p.then(done, done);
    }
    return p;
  }

  private readonly inflight = new Map<string, Promise<{ body: Buffer; type: string }>>();

  private async fetchAndKeep(url: string): Promise<{ body: Buffer; type: string }> {
    const found = await this.find(url);
    if (found) return { body: await readFile(found.file), type: found.type };
    const img = await this.client.binary(url, this.referer());
    if (!/^image\//.test(img.type)) throw new NotImageError(`Not an image (${img.type}): ${url}`);
    const file = this.cacheFile(url);
    await mkdir(join(file, ".."), { recursive: true });
    // The type first: find() takes the image once both files are there.
    await writeFile(`${file}.type`, img.type);
    await writeFile(`${file}.part`, img.body);
    await rename(`${file}.part`, file);
    return img;
  }
}
