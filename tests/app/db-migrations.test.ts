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

it("keeps every cached page when upgrading from a version before 0.10.21", () => {
  const dir = mkdtempSync(join(tmpdir(), "bili-db-"));
  dirs.push(dir);
  const file = join(dir, "db.sqlite");
  new Db(file).sql.close();
  const raw = new DatabaseSync(file);
  const latest = Number((raw.prepare("pragma user_version").get() as { user_version: number }).user_version);
  // Back to the schema before the no-op migration (version 3), with pages from before and after 2026-11-04 04:10 UTC.
  raw.exec("alter table jobs drop column partial; pragma user_version = 3");
  const add = raw.prepare("insert into pages values ('5370', ?, 0, '{}', ?)");
  add.run("288334", Date.parse("2026-11-03T12:00:00Z"));
  add.run("288458", Date.parse("2026-11-04T04:30:00Z"));
  raw.close();

  const db = new Db(file);
  expect(db.all("select chapter_id from pages order by chapter_id")).toEqual([{ chapter_id: "288334" }, { chapter_id: "288458" }]);
  // The no-op keeps the deleting migration's number (4), so later ones keep theirs.
  expect(Number((db.sql.prepare("pragma user_version").get() as { user_version: number }).user_version)).toBe(latest);
  expect(latest).toBe(5);
  db.sql.close();
});
