import { DatabaseSync, type SQLInputValue } from "node:sqlite";

/**
 * SQLite (built into Node) holding the library index: books, cached site
 * pages, generated audio, jobs and settings. Audio itself lives in files.
 */

const MIGRATIONS = [
  `
  create table kv (key text primary key, value text not null);
  create table books (
    id text primary key,
    title text not null default '',
    author text not null default '',
    cover_url text,
    intro text not null default '',
    catalog text,
    catalog_at integer,
    added_at integer not null,
    read_at integer,
    follow integer not null default 1,
    ahead integer not null default 3
  );
  create table pages (
    book_id text not null,
    chapter_id text not null,
    page_index integer not null,
    data text not null,
    fetched_at integer not null,
    primary key (book_id, chapter_id, page_index)
  );
  create table segments (
    key text primary key,
    file text not null,
    mime text not null,
    bytes integer not null,
    bounds text not null,
    chars integer not null,
    created_at integer not null
  );
  create table chapter_audio (
    book_id text not null,
    chapter_id text not null,
    profile text not null,
    file text not null,
    bytes integer not null,
    duration real,
    updated_at integer not null,
    primary key (book_id, chapter_id)
  );
  create table jobs (
    id integer primary key autoincrement,
    kind text not null,
    book_id text not null,
    target text not null,
    title text not null default '',
    profile text not null default '',
    reason text not null,
    priority integer not null,
    status text not null,
    progress real not null default 0,
    message text,
    error text,
    attempts integer not null default 0,
    not_before integer not null default 0,
    created_at integer not null,
    updated_at integer not null
  );
  create index jobs_status on jobs (status, priority desc, id);
  create index jobs_book on jobs (book_id, target);
  `,
  // Paragraph timing method of each segment (see BOUNDS_VERSION).
  `alter table segments add column bounds_v integer not null default 0;`,
  // A segment inside its chapter's library file: the audio offset there (null: its own file).
  `alter table segments add column start integer;`,
];

export type Row = Record<string, SQLInputValue>;

export class Db {
  readonly sql: DatabaseSync;

  constructor(file: string) {
    this.sql = new DatabaseSync(file);
    this.sql.exec("pragma journal_mode = wal; pragma foreign_keys = on; pragma busy_timeout = 5000;");
    this.migrate();
  }

  private migrate(): void {
    const version = Number((this.sql.prepare("pragma user_version").get() as { user_version: number }).user_version);
    for (let v = version; v < MIGRATIONS.length; v++) {
      this.sql.exec("begin");
      try {
        this.sql.exec(MIGRATIONS[v]);
        this.sql.exec(`pragma user_version = ${v + 1}`);
        this.sql.exec("commit");
      } catch (err) {
        this.sql.exec("rollback");
        throw err;
      }
    }
  }

  all<T>(query: string, ...params: SQLInputValue[]): T[] {
    return this.sql.prepare(query).all(...params) as T[];
  }

  get<T>(query: string, ...params: SQLInputValue[]): T | undefined {
    return this.sql.prepare(query).get(...params) as T | undefined;
  }

  run(query: string, ...params: SQLInputValue[]): { changes: number; lastInsertRowid: number } {
    const r = this.sql.prepare(query).run(...params);
    return { changes: Number(r.changes), lastInsertRowid: Number(r.lastInsertRowid) };
  }

  tx<T>(fn: () => T): T {
    this.sql.exec("begin");
    try {
      const out = fn();
      this.sql.exec("commit");
      return out;
    } catch (err) {
      this.sql.exec("rollback");
      throw err;
    }
  }

  getKv(key: string): string | undefined {
    return this.get<{ value: string }>("select value from kv where key = ?", key)?.value;
  }

  setKv(key: string, value: string | undefined): void {
    if (value === undefined) this.run("delete from kv where key = ?", key);
    else this.run("insert into kv (key, value) values (?, ?) on conflict (key) do update set value = excluded.value", key, value);
  }

  getJson<T>(key: string): T | undefined {
    const raw = this.getKv(key);
    if (raw === undefined) return undefined;
    try {
      return JSON.parse(raw) as T;
    } catch {
      return undefined;
    }
  }

  setJson(key: string, value: unknown): void {
    this.setKv(key, JSON.stringify(value));
  }

  close(): void {
    this.sql.close();
  }
}
