// @vitest-environment node
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it } from "vitest";
import { Db } from "../../app/server/db";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

it("drops pages 0.10.20 may have stored with only the start of a chapter, keeping older ones", () => {
  const dir = mkdtempSync(join(tmpdir(), "bili-db-"));
  dirs.push(dir);
  const file = join(dir, "db.sqlite");
  new Db(file).sql.close();
  // Back to the schema before that cleanup, with pages from before and after 0.10.20.
  const raw = new DatabaseSync(file);
  raw.exec("pragma user_version = 3");
  const add = raw.prepare("insert into pages values ('5370', ?, 0, '{}', ?)");
  add.run("288334", Date.parse("2026-11-03T12:00:00Z"));
  add.run("288458", Date.parse("2026-11-04T04:30:00Z"));
  raw.close();

  const db = new Db(file);
  expect(db.all("select chapter_id from pages")).toEqual([{ chapter_id: "288334" }]);
  db.sql.close();
});
