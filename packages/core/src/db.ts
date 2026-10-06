// SQLite compiled to WebAssembly (sql.js). The browser keeps the file in
// IndexedDB; tests run the same code in Node.
import type { Database, SqlValue } from "sql.js";
import { MIGRATIONS } from "./schema";

export type Row = Record<string, any>;
export type Param = string | number | boolean | null | undefined | Uint8Array;

export class Db {
  private depth = 0;
  constructor(
    readonly raw: Database,
    private readonly onWrite: () => void = () => undefined,
  ) {
    this.raw.exec("PRAGMA foreign_keys = ON");
    this.migrate();
  }

  private migrate(): void {
    this.raw.exec("CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL)");
    const cur = this.get<{ v: number | null }>("SELECT MAX(version) AS v FROM schema_version")?.v ?? 0;
    for (let v = cur; v < MIGRATIONS.length; v++) {
      this.tx(() => {
        this.raw.exec(MIGRATIONS[v]!);
        this.run("INSERT INTO schema_version (version) VALUES (?)", v + 1);
      });
    }
  }

  get schemaVersion(): number {
    return this.get<{ v: number }>("SELECT MAX(version) AS v FROM schema_version")?.v ?? 0;
  }

  private bind(params: Param[]): SqlValue[] {
    return params.map((p) => (p === undefined ? null : typeof p === "boolean" ? (p ? 1 : 0) : p));
  }

  all<T = Row>(sql: string, ...params: Param[]): T[] {
    const stmt = this.raw.prepare(sql);
    try {
      stmt.bind(this.bind(params));
      const out: T[] = [];
      while (stmt.step()) out.push(stmt.getAsObject() as T);
      return out;
    } finally {
      stmt.free();
    }
  }
  get<T = Row>(sql: string, ...params: Param[]): T | undefined {
    return this.all<T>(sql, ...params)[0];
  }
  run(sql: string, ...params: Param[]): number {
    this.raw.run(sql, this.bind(params));
    const changes = this.raw.getRowsModified();
    if (this.depth === 0) this.onWrite();
    return changes;
  }
  tx<T>(fn: () => T): T {
    if (this.depth > 0) {
      this.depth++;
      try {
        return fn();
      } finally {
        this.depth--;
      }
    }
    this.raw.exec("BEGIN");
    this.depth = 1;
    try {
      const out = fn();
      this.raw.exec("COMMIT");
      return out;
    } catch (e) {
      this.raw.exec("ROLLBACK");
      throw e;
    } finally {
      this.depth = 0;
      this.onWrite();
    }
  }
  meta(key: string): string | undefined {
    return this.get<{ value: string }>("SELECT value FROM meta WHERE key = ?", key)?.value;
  }
  setMeta(key: string, value: string): void {
    this.run("INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", key, value);
  }
  export(): Uint8Array {
    const bytes = this.raw.export();
    // sql.js reopens the database on export, which resets connection pragmas.
    this.raw.exec("PRAGMA foreign_keys = ON");
    return bytes;
  }
  close(): void {
    this.raw.close();
  }
}

export const nowIso = () => new Date().toISOString();
export const newId = () => crypto.randomUUID();
