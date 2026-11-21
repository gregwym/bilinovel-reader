// @vitest-environment node
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { Db } from "../../app/server/db";

let dir: string;
let db: Db;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "bili-tx-"));
  db = new Db(join(dir, "db.sqlite"));
});
afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

const keys = () => db.all<{ key: string }>("select key from kv order by key").map((r) => r.key);

it("joins a transaction already open (a batch inside a catalog save)", () => {
  db.tx(() => {
    db.setKv("a", "1");
    db.tx(() => db.setKv("b", "1"));
    expect(db.sql.isTransaction).toBe(true);
  });
  expect(db.sql.isTransaction).toBe(false);
  expect(keys()).toEqual(["a", "b"]);
});

it("undoes the whole batch when part of it fails", () => {
  expect(() =>
    db.tx(() => {
      db.setKv("a", "1");
      db.tx(() => {
        db.setKv("b", "1");
        throw new Error("boom");
      });
    }),
  ).toThrow("boom");
  expect(db.sql.isTransaction).toBe(false);
  expect(keys()).toEqual([]);
});
