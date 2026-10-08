// Source documents and their fragments (chunks).
import { type Db, newId, nowIso } from "./db";
import { chunkBlocks, type ParsedFile } from "./import/blocks";
import { recordTombstone } from "./subjects";

export type DocumentKind = "note" | "textbook" | "act" | "syllabus" | "exam_list" | "case_law" | "scholarly";

export const DOCUMENT_KIND_LABEL: Record<DocumentKind, string> = {
  note: "Notatka z wykładu",
  textbook: "Podręcznik",
  act: "Tekst aktu prawnego",
  syllabus: "Sylabus",
  exam_list: "Lista zagadnień egzaminacyjnych",
  case_law: "Orzeczenie (SAOS)",
  scholarly: "Publikacja naukowa",
};

/** Hierarchy of sources: lower = decides (act on wording, notes on scope, textbook for depth). */
export const SOURCE_RANK: Record<DocumentKind, number> = { act: 1, exam_list: 2, note: 2, syllabus: 3, textbook: 3, case_law: 3, scholarly: 4 };

export async function sha256Hex(data: Uint8Array | string): Promise<string> {
  const bytes = typeof data === "string" ? new TextEncoder().encode(data) : data;
  const digest = await crypto.subtle.digest("SHA-256", bytes as BufferSource);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Text normalised for hashing: the same paragraph with other spacing is the same fragment. */
const hashable = (s: string) => s.replace(/\s+/g, " ").trim().toLowerCase();

export interface ImportInput {
  subjectId: string;
  kind: DocumentKind;
  title: string;
  fileName: string;
  fileBytes: Uint8Array;
  parsed: ParsedFile;
  lectureDate?: string | null;
  /** For kind "act": the act's abbreviation (k.c.) and the date of its legal state. */
  act?: { abbrev: string; title?: string; stateAsOf?: string | null };
  /** Where an online source came from (ISAP, SAOS, publication). */
  url?: string | null;
  meta?: Record<string, unknown> | null;
}

export interface DocumentImportResult {
  documentId: string;
  /** The same file was already imported: nothing changed. */
  duplicate: boolean;
  version: number;
  chunks: number;
  /** Fragments the AI has to read (new or changed text). */
  newChunks: number;
}

/**
 * Stores a document cut into fragments. Importing a file with the same name
 * again (e.g. a note completed after the lecture) makes a new version:
 * unchanged fragments keep their id, processing state and citations; only new
 * text goes to the AI.
 */
export async function importDocument(db: Db, input: ImportInput): Promise<DocumentImportResult> {
  if (!db.get("SELECT 1 FROM subject WHERE id = ?", input.subjectId)) throw new Error("Nie ma takiego przedmiotu.");
  const fileHash = await sha256Hex(input.fileBytes);
  const dup = db.get<{ id: string; version: number }>(
    "SELECT id, version FROM source_document WHERE subject_id = ? AND file_hash = ?",
    input.subjectId,
    fileHash,
  );
  if (dup) {
    const n = db.get<{ n: number }>("SELECT COUNT(*) AS n FROM source_chunk WHERE document_id = ?", dup.id)!.n;
    return { documentId: dup.id, duplicate: true, version: dup.version, chunks: n, newChunks: 0 };
  }

  const chunks = chunkBlocks(input.parsed.blocks);
  if (!chunks.length) throw new Error("W pliku nie znaleziono tekstu.");
  const hashes = await Promise.all(chunks.map((c) => sha256Hex(hashable(c.text))));
  const now = nowIso();
  const title = input.title.trim() || input.fileName;

  return db.tx(() => {
    let actId: string | null = null;
    if (input.kind === "act") {
      const abbrev = input.act?.abbrev.trim();
      if (!abbrev) throw new Error("Podaj skrót aktu, np. k.c.");
      const existing = db.get<{ id: string }>("SELECT id FROM legal_act WHERE lower(abbrev) = lower(?)", abbrev);
      actId = existing?.id ?? newId();
      if (existing) {
        db.run("UPDATE legal_act SET state_as_of = COALESCE(?, state_as_of), updated_at = ? WHERE id = ?", input.act?.stateAsOf ?? null, now, actId);
      } else {
        db.run(
          "INSERT INTO legal_act (id, abbrev, title, state_as_of, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
          actId,
          abbrev,
          input.act?.title?.trim() || title,
          input.act?.stateAsOf ?? null,
          now,
          now,
        );
      }
    }

    const prev = db.get<{ id: string; version: number }>(
      "SELECT id, version FROM source_document WHERE subject_id = ? AND file_name = ? AND kind = ?",
      input.subjectId,
      input.fileName,
      input.kind,
    );
    const documentId = prev?.id ?? newId();
    const version = (prev?.version ?? 0) + 1;
    if (prev) {
      db.run(
        "UPDATE source_document SET title = ?, file_hash = ?, lecture_date = ?, legal_act_id = ?, version = ?, url = ?, meta_json = ?, imported_at = ?, updated_at = ? WHERE id = ?",
        title,
        fileHash,
        input.lectureDate ?? null,
        actId,
        version,
        input.url ?? null,
        input.meta ? JSON.stringify(input.meta) : null,
        now,
        now,
        documentId,
      );
    } else {
      db.run(
        `INSERT INTO source_document (id, subject_id, kind, title, file_name, file_hash, lecture_date, legal_act_id, version, url, meta_json, imported_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        documentId,
        input.subjectId,
        input.kind,
        title,
        input.fileName,
        fileHash,
        input.lectureDate ?? null,
        actId,
        version,
        input.url ?? null,
        input.meta ? JSON.stringify(input.meta) : null,
        now,
        now,
      );
    }

    const old = new Map(
      db.all<{ id: string; text_hash: string }>("SELECT id, text_hash FROM source_chunk WHERE document_id = ?", documentId).map((r) => [r.text_hash, r.id]),
    );
    let newChunks = 0;
    const kept = new Set<string>();
    chunks.forEach((c, i) => {
      const hash = hashes[i]!;
      const reuse = old.get(hash);
      if (reuse && !kept.has(reuse)) {
        kept.add(reuse);
        db.run(
          "UPDATE source_chunk SET ord = ?, heading_path = ?, page_from = ?, page_to = ?, updated_at = ? WHERE id = ?",
          c.ord,
          JSON.stringify(c.headingPath),
          input.parsed.paged ? c.pageFrom : null,
          input.parsed.paged ? c.pageTo : null,
          now,
          reuse,
        );
        return;
      }
      newChunks++;
      db.run(
        "INSERT INTO source_chunk (id, document_id, ord, heading_path, page_from, page_to, text, text_hash, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
        newId(),
        documentId,
        c.ord,
        JSON.stringify(c.headingPath),
        input.parsed.paged ? c.pageFrom : null,
        input.parsed.paged ? c.pageTo : null,
        c.text,
        hash,
        now,
      );
    });
    // Fragments that are gone: kept (moved to the end) while something cites them, else removed.
    for (const [, id] of old) {
      if (kept.has(id)) continue;
      if (db.get("SELECT 1 FROM citation WHERE chunk_id = ?", id)) {
        db.run("UPDATE source_chunk SET ord = ?, updated_at = ? WHERE id = ?", 100_000 + chunks.length, now, id);
      } else {
        db.run("DELETE FROM source_chunk WHERE id = ?", id);
        recordTombstone(db, "source_chunk", id);
      }
    }
    return { documentId, duplicate: false, version, chunks: chunks.length, newChunks };
  });
}

export interface DocumentInfo {
  id: string;
  subjectId: string;
  kind: DocumentKind;
  title: string;
  fileName: string | null;
  lectureDate: string | null;
  version: number;
  importedAt: string;
  chunks: number;
  processed: number;
  materials: number;
}

export function listDocuments(db: Db, subjectId?: string): DocumentInfo[] {
  return db
    .all(
      `SELECT d.*,
         (SELECT COUNT(*) FROM source_chunk c WHERE c.document_id = d.id AND c.ord < 100000) AS chunks,
         (SELECT COUNT(*) FROM source_chunk c WHERE c.document_id = d.id AND c.ord < 100000 AND c.processed_at IS NOT NULL) AS processed,
         (SELECT COUNT(DISTINCT ci.owner_id) FROM citation ci JOIN source_chunk c ON c.id = ci.chunk_id
            WHERE c.document_id = d.id AND ci.owner_type = 'material') AS materials
       FROM source_document d ${subjectId ? "WHERE d.subject_id = ?" : ""}
       ORDER BY COALESCE(d.lecture_date, d.imported_at) DESC`,
      ...(subjectId ? [subjectId] : []),
    )
    .map((r) => ({
      id: r.id,
      subjectId: r.subject_id,
      kind: r.kind,
      title: r.title,
      fileName: r.file_name,
      lectureDate: r.lecture_date,
      version: r.version,
      importedAt: r.imported_at,
      chunks: r.chunks,
      processed: r.processed,
      materials: r.materials,
    }));
}

/** Deletes a document. Materials left with no source go back for review. */
export function deleteDocument(db: Db, id: string): void {
  db.tx(() => {
    const affected = db
      .all<{ owner_id: string }>(
        `SELECT DISTINCT ci.owner_id FROM citation ci JOIN source_chunk c ON c.id = ci.chunk_id
         WHERE c.document_id = ? AND ci.owner_type = 'material'`,
        id,
      )
      .map((r) => r.owner_id);
    if (db.run("DELETE FROM source_document WHERE id = ?", id) === 0) throw new Error("Nie ma takiego dokumentu.");
    recordTombstone(db, "source_document", id);
    for (const m of affected) {
      if (!db.get("SELECT 1 FROM citation WHERE owner_type = 'material' AND owner_id = ?", m)) {
        db.run("UPDATE material SET status = 'needs_review', updated_at = ? WHERE id = ? AND status != 'rejected'", nowIso(), m);
      }
    }
  });
}

export interface ChunkView {
  id: string;
  /** Position in the document (neighbouring fragments are ord ± 1). */
  ord: number;
  text: string;
  headingPath: string[];
  pageFrom: number | null;
  pageTo: number | null;
  documentId: string;
  documentTitle: string;
  documentKind: DocumentKind;
  lectureDate: string | null;
}

export function getChunk(db: Db, id: string): ChunkView | undefined {
  const r = db.get(
    `SELECT c.*, d.title, d.kind, d.lecture_date FROM source_chunk c JOIN source_document d ON d.id = c.document_id WHERE c.id = ?`,
    id,
  );
  if (!r) return undefined;
  return {
    id: r.id,
    text: r.text,
    headingPath: JSON.parse(r.heading_path ?? "[]"),
    pageFrom: r.page_from,
    pageTo: r.page_to,
    documentId: r.document_id,
    ord: Number(r.ord),
    documentTitle: r.title,
    documentKind: r.kind,
    lectureDate: r.lecture_date,
  };
}
