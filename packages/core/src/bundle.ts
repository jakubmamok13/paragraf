// Packages move data between the laptop (where sources are processed by the
// local AI) and the phone (where learning happens):
//
//   content   laptop → phone   subjects, sources, topics, materials
//   progress  phone → laptop   review state and history
//   backup    either           everything; restoring replaces the database
//
// Merging is by row id. Rows with updated_at: the newer one wins. Rows without
// it (links, logs) are inserted once. A content package never touches review
// state, and a progress package never touches content.
import { gunzipSync, gzipSync, strFromU8, strToU8 } from "fflate";
import { type Db, type Row, nowIso } from "./db";

export type PackageKind = "content" | "progress" | "backup";

export interface Package {
  format: "paragraf-package";
  kind: PackageKind;
  /** Schema version of the device that made the package. */
  schemaVersion: number;
  createdAt: string;
  tables: Record<string, Row[]>;
  tombstones: { table_name: string; id: string; deleted_at: string }[];
}

/** Parents before children, so foreign keys hold while inserting. */
const CONTENT_TABLES = [
  "subject",
  "exam",
  "legal_act",
  "amendment",
  "source_document",
  "source_chunk",
  "section",
  "topic",
  "topic_field",
  "provision_ref",
  "topic_field_provision",
  "topic_relation",
  "citation",
  "source_conflict",
  "material",
  "material_field",
] as const;
// The memory palace course happens on the phone, so it travels with the progress.
const PROGRESS_TABLES = ["review_item", "review_log", "palace", "locus", "palace_drill", "palace_placement"] as const;
const BACKUP_TABLES = ["setting", ...CONTENT_TABLES, ...PROGRESS_TABLES, "ai_call"] as const;

const TABLES: Record<PackageKind, readonly string[]> = {
  content: CONTENT_TABLES,
  progress: PROGRESS_TABLES,
  backup: BACKUP_TABLES,
};

export interface ExportOptions {
  /**
   * Content packages normally carry only the source fragments that materials
   * and topics cite (enough for "show source" on the phone). true = all of them.
   */
  allChunks?: boolean;
}

export function exportPackage(db: Db, kind: PackageKind, opts: ExportOptions = {}): Package {
  const tables: Record<string, Row[]> = {};
  for (const t of TABLES[kind]) {
    if (t === "source_chunk" && kind === "content" && !opts.allChunks) {
      tables[t] = db.all("SELECT * FROM source_chunk WHERE id IN (SELECT chunk_id FROM citation) ORDER BY document_id, ord");
    } else {
      tables[t] = db.all(`SELECT * FROM ${t}`);
    }
  }
  const tombstones =
    kind === "progress"
      ? []
      : db.all<Package["tombstones"][number]>("SELECT table_name, id, deleted_at FROM tombstone");
  return { format: "paragraf-package", kind, schemaVersion: db.schemaVersion, createdAt: nowIso(), tables, tombstones };
}

export interface ImportResult {
  kind: PackageKind;
  inserted: number;
  updated: number;
  deleted: number;
  skipped: number;
}

export function parsePackage(text: string): Package {
  let p: any;
  try {
    p = JSON.parse(text);
  } catch {
    throw new Error("To nie jest plik paczki Paragrafu (nieprawidłowy JSON).");
  }
  if (p?.format !== "paragraf-package" || !["content", "progress", "backup"].includes(p.kind) || typeof p.tables !== "object") {
    throw new Error("To nie jest plik paczki Paragrafu.");
  }
  return p as Package;
}

export function importPackage(db: Db, pkg: Package): ImportResult {
  if (pkg.schemaVersion > db.schemaVersion) {
    throw new Error("Paczka pochodzi z nowszej wersji aplikacji. Zaktualizuj aplikację na tym urządzeniu.");
  }
  const result: ImportResult = { kind: pkg.kind, inserted: 0, updated: 0, deleted: 0, skipped: 0 };
  const allowed = new Set(TABLES[pkg.kind]);

  db.tx(() => {
    if (pkg.kind === "backup") {
      // Restoring replaces everything. Children go first.
      for (const t of [...BACKUP_TABLES].reverse()) db.run(`DELETE FROM ${t}`);
      db.run("DELETE FROM tombstone");
    }

    // Deletions first, so a row deleted on the other device does not come back.
    for (const ts of pkg.tombstones ?? []) {
      if (!allowed.has(ts.table_name)) continue;
      result.deleted += db.run(`DELETE FROM ${ts.table_name} WHERE id = ?`, ts.id);
      db.run(
        "INSERT INTO tombstone (table_name, id, deleted_at) VALUES (?, ?, ?) ON CONFLICT DO NOTHING",
        ts.table_name,
        ts.id,
        ts.deleted_at,
      );
    }

    // Review items are one per (material, gap). Both devices may have made one for the same
    // card with different ids: the one reviewed later wins, and answers move to it.
    const itemRemap = new Map<string, string>();

    for (const table of TABLES[pkg.kind]) {
      const rows = pkg.tables[table];
      if (!rows?.length) continue;
      const cols = columnsOf(db, table);
      const pk = primaryKeyOf(db, table);
      const hasUpdatedAt = cols.includes("updated_at");
      const tombstoned = new Set(
        db.all<{ id: string }>("SELECT id FROM tombstone WHERE table_name = ?", table).map((r) => r.id),
      );
      const parents = db.all<{ table: string; from: string; to: string }>(`PRAGMA foreign_key_list(${table})`);
      // A child of a deleted row (e.g. a topic of a deleted subject in an old package) is dropped.
      const orphan = (row: Row) =>
        parents.some(
          (fk) => row[fk.from] != null && !db.get(`SELECT 1 FROM ${fk.table} WHERE ${fk.to} = ?`, row[fk.from]),
        );

      for (const original of rows) {
        let row = original;
        if (table === "review_log" && itemRemap.has(String(row.review_item_id))) {
          row = { ...row, review_item_id: itemRemap.get(String(row.review_item_id)) };
        }
        if (table === "review_item") {
          const twin = db.get<{ id: string; last_review: string | null; updated_at: string; suspended: number; reps: number }>(
            "SELECT id, last_review, updated_at, suspended, reps FROM review_item WHERE material_id = ? AND sub_key = ? AND id != ?",
            row.material_id,
            row.sub_key ?? "",
            row.id,
          );
          if (twin) {
            // Later review first; on a tie, the one that carries something (a flag, reviews), then the newer one.
            const key = (r: { last_review?: unknown; suspended?: unknown; reps?: unknown; updated_at?: unknown }) =>
              [String(r.last_review ?? ""), Number(r.suspended ?? 0), Number(r.reps ?? 0), String(r.updated_at ?? "")] as const;
            const a = key(row);
            const b = key(twin);
            const incomingWins = a[0] !== b[0] ? a[0] > b[0] : a[1] !== b[1] ? a[1] > b[1] : a[2] !== b[2] ? a[2] > b[2] : a[3] > b[3];
            if (!incomingWins) {
              itemRemap.set(String(row.id), twin.id);
              result.skipped++;
              continue;
            }
            // Make room for the incoming row, move the answers to it, then drop the local twin.
            db.run("UPDATE review_item SET sub_key = ? WHERE id = ?", `~merging~${twin.id}`, twin.id);
            const use = cols.filter((c) => c in row);
            db.run(`INSERT INTO review_item (${use.join(", ")}) VALUES (${use.map(() => "?").join(", ")})`, ...use.map((c) => row[c]));
            db.run("UPDATE review_log SET review_item_id = ? WHERE review_item_id = ?", row.id, twin.id);
            db.run("DELETE FROM review_item WHERE id = ?", twin.id);
            result.updated++;
            continue;
          }
        }
        // Columns this version knows; an older package may lack new ones.
        const use = cols.filter((c) => c in row);
        if (pk.some((k) => !use.includes(k))) {
          result.skipped++;
          continue;
        }
        if ((pk.length === 1 && tombstoned.has(String(row[pk[0]!]))) || orphan(row)) {
          result.skipped++;
          continue;
        }
        const where = pk.map((k) => `${k} = ?`).join(" AND ");
        const existing = db.get<{ updated_at?: string }>(
          `SELECT ${hasUpdatedAt ? "updated_at" : "1 AS x"} FROM ${table} WHERE ${where}`,
          ...pk.map((k) => row[k]),
        );
        if (!existing) {
          db.run(
            `INSERT INTO ${table} (${use.join(", ")}) VALUES (${use.map(() => "?").join(", ")})`,
            ...use.map((c) => row[c]),
          );
          result.inserted++;
        } else if (hasUpdatedAt && String(row.updated_at) > String(existing.updated_at)) {
          // UPDATE, never INSERT OR REPLACE: a replace would cascade-delete children.
          const set = use.filter((c) => !pk.includes(c));
          db.run(
            `UPDATE ${table} SET ${set.map((c) => `${c} = ?`).join(", ")} WHERE ${where}`,
            ...set.map((c) => row[c]),
            ...pk.map((k) => row[k]),
          );
          result.updated++;
        } else {
          result.skipped++;
        }
      }
    }
  });
  return result;
}

function columnsOf(db: Db, table: string): string[] {
  return db.all<{ name: string }>(`PRAGMA table_info(${table})`).map((c) => c.name);
}

function primaryKeyOf(db: Db, table: string): string[] {
  return db
    .all<{ name: string; pk: number }>(`PRAGMA table_info(${table})`)
    .filter((c) => c.pk > 0)
    .sort((a, b) => a.pk - b.pk)
    .map((c) => c.name);
}

export function packageFileName(kind: PackageKind, d = new Date()): string {
  const stamp = d.toISOString().slice(0, 16).replace(/[:T]/g, "-");
  const label = { content: "tresc", progress: "postep", backup: "kopia" }[kind];
  return `paragraf-${label}-${stamp}.json.gz`;
}

/** A package as a file: gzip-compressed JSON (a textbook's text shrinks several times). */
export function encodePackage(pkg: Package): Uint8Array {
  return gzipSync(strToU8(JSON.stringify(pkg)), { level: 6 });
}

/** Reads a package file: compressed (.json.gz) or plain JSON from older versions. */
export function decodePackage(bytes: Uint8Array): Package {
  let text: string;
  if (bytes[0] === 0x1f && bytes[1] === 0x8b) {
    try {
      text = strFromU8(gunzipSync(bytes));
    } catch {
      throw new Error("Plik paczki jest uszkodzony (nie da się go rozpakować).");
    }
  } else {
    text = strFromU8(bytes);
  }
  return parsePackage(text);
}
