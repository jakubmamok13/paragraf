// What the user decides on the laptop: the approval queue, suggestions,
// source conflicts, and cards flagged on the phone.
import { type Db, nowIso } from "./db";
import { type DocumentKind, SOURCE_RANK } from "./documents";
import { checkMaterial, type MaterialType } from "./materials";
import { enqueueGeneration, FIELD_LABEL, type FieldType } from "./pipeline";

export interface CitationView {
  chunkId: string;
  quote: string;
  documentTitle: string;
  documentKind: DocumentKind;
  page: number | null;
  lectureDate: string | null;
}

export interface ReviewMaterial {
  id: string;
  type: MaterialType;
  payload: any;
  status: string;
  topicId: string;
  topicName: string;
  subjectId: string;
  subjectName: string;
  examWeight: number;
  citations: CitationView[];
  /** Suspended on the phone (marked as wrong or outdated). */
  flagged: boolean;
}

function citationsOf(db: Db, materialId: string): CitationView[] {
  return db
    .all(
      `SELECT c.chunk_id, c.quote, d.title, d.kind, ch.page_from, d.lecture_date FROM citation c
       JOIN source_chunk ch ON ch.id = c.chunk_id JOIN source_document d ON d.id = ch.document_id
       WHERE c.owner_type = 'material' AND c.owner_id = ?`,
      materialId,
    )
    .map((r) => ({ chunkId: r.chunk_id, quote: r.quote, documentTitle: r.title, documentKind: r.kind, page: r.page_from, lectureDate: r.lecture_date }));
}

/** Materials waiting for a decision: new ones, ones that lost their source, and ones flagged on the phone. */
export function reviewQueue(db: Db, subjectId?: string): ReviewMaterial[] {
  return db
    .all(
      `SELECT m.id, m.type, m.payload_json, m.status, t.id AS topic_id, t.name AS topic_name, t.exam_weight,
              s.id AS subject_id, s.name AS subject_name,
              EXISTS (SELECT 1 FROM review_item i WHERE i.material_id = m.id AND i.suspended = 1) AS flagged
       FROM material m JOIN topic t ON t.id = m.topic_id JOIN subject s ON s.id = t.subject_id
       WHERE (m.status IN ('pending', 'needs_review')
              OR (m.status = 'active' AND EXISTS (SELECT 1 FROM review_item i WHERE i.material_id = m.id AND i.suspended = 1)))
         ${subjectId ? "AND s.id = ?" : ""}
       ORDER BY flagged DESC, m.status = 'needs_review' DESC, t.exam_weight DESC, t.name, m.created_at`,
      ...(subjectId ? [subjectId] : []),
    )
    .map((r) => ({
      id: r.id,
      type: r.type,
      payload: JSON.parse(r.payload_json),
      status: r.status,
      topicId: r.topic_id,
      topicName: r.topic_name,
      subjectId: r.subject_id,
      subjectName: r.subject_name,
      examWeight: r.exam_weight,
      citations: citationsOf(db, r.id),
      flagged: !!r.flagged,
    }));
}

export function approveMaterials(db: Db, ids: string[]): number {
  let n = 0;
  db.tx(() => {
    const now = nowIso();
    for (const id of ids) {
      n += db.run("UPDATE material SET status = 'active', updated_at = ? WHERE id = ? AND status IN ('pending', 'needs_review', 'active')", now, id);
      db.run("UPDATE review_item SET suspended = 0, updated_at = ? WHERE material_id = ? AND suspended = 1", now, id);
    }
  });
  return n;
}

/** Rejects a material. "Too easy" is remembered as feedback for the generator's statistics. */
export function rejectMaterial(db: Db, id: string, opts: { tooEasy?: boolean } = {}): void {
  db.run("UPDATE material SET status = 'rejected', too_easy = ?, updated_at = ? WHERE id = ?", opts.tooEasy ? 1 : 0, nowIso(), id);
}

/** Saves the user's correction and makes the material active (a fixed card keeps its review history). */
export function editMaterial(db: Db, id: string, payload: unknown): string[] {
  const m = db.get<{ type: MaterialType }>("SELECT type FROM material WHERE id = ?", id);
  if (!m) throw new Error("Nie ma takiego materiału.");
  const warnings = checkMaterial(m.type, payload);
  db.tx(() => {
    const now = nowIso();
    db.run("UPDATE material SET payload_json = ?, edited = 1, status = 'active', updated_at = ? WHERE id = ?", JSON.stringify(payload), now, id);
    db.run("UPDATE review_item SET suspended = 0, updated_at = ? WHERE material_id = ?", now, id);
  });
  return warnings;
}

/** From the phone: a card is wrong or outdated. It stops coming up and waits on the laptop. */
export function flagMaterial(db: Db, materialId: string): void {
  db.run("UPDATE review_item SET suspended = 1, updated_at = ? WHERE material_id = ?", nowIso(), materialId);
}

// ---------- suggestions ----------

export interface SuggestionView {
  id: string;
  kind: string;
  text: string;
  subjectId: string;
  topicName: string | null;
  chunkId: string | null;
}

export function listSuggestions(db: Db, subjectId?: string): SuggestionView[] {
  return db
    .all(
      `SELECT g.id, g.kind, g.text, g.subject_id, g.chunk_id, t.name AS topic_name FROM suggestion g LEFT JOIN topic t ON t.id = g.topic_id
       WHERE g.status = 'open' ${subjectId ? "AND g.subject_id = ?" : ""} ORDER BY g.created_at DESC`,
      ...(subjectId ? [subjectId] : []),
    )
    .map((r) => ({ id: r.id, kind: r.kind, text: r.text, subjectId: r.subject_id, topicName: r.topic_name, chunkId: r.chunk_id }));
}

export function dismissSuggestion(db: Db, id: string): void {
  db.run("UPDATE suggestion SET status = 'dismissed', updated_at = ? WHERE id = ?", nowIso(), id);
}

/** Dismisses every open suggestion (of one subject, if given). Returns how many. */
export function dismissAllSuggestions(db: Db, subjectId?: string): number {
  return db.run(
    `UPDATE suggestion SET status = 'dismissed', updated_at = ? WHERE status = 'open' ${subjectId ? "AND subject_id = ?" : ""}`,
    nowIso(),
    ...(subjectId ? [subjectId] : []),
  );
}

// ---------- conflicts ----------

export interface ConflictCandidate {
  fieldId: string;
  text: string;
  quote: string;
  documentTitle: string;
  documentKind: DocumentKind;
  page: number | null;
  lectureDate: string | null;
  chunkId: string | null;
  /** 1 = act (decides on wording), 2 = notes (scope), 3 = textbook. */
  rank: number;
}

export interface ConflictView {
  id: string;
  topicId: string;
  topicName: string;
  subjectId: string;
  fieldType: FieldType;
  fieldLabel: string;
  kind: string;
  candidates: ConflictCandidate[];
  /** The candidate the hierarchy of sources points to; a hint only, the user decides. */
  hintFieldId: string | null;
}

export function listConflicts(db: Db, subjectId?: string): ConflictView[] {
  return db
    .all(
      `SELECT c.*, t.name AS topic_name, t.subject_id FROM source_conflict c JOIN topic t ON t.id = c.topic_id
       WHERE c.status = 'open' ${subjectId ? "AND t.subject_id = ?" : ""} ORDER BY c.created_at`,
      ...(subjectId ? [subjectId] : []),
    )
    .map((r) => {
      const ids: string[] = JSON.parse(r.candidates_json);
      const candidates = ids
        .map((fid) => {
          const f = db.get<{ content_json: string }>("SELECT content_json FROM topic_field WHERE id = ?", fid);
          if (!f) return null;
          const content = JSON.parse(f.content_json);
          const src = db.get(
            `SELECT c.chunk_id, d.title, d.kind, ch.page_from, d.lecture_date FROM citation c
             JOIN source_chunk ch ON ch.id = c.chunk_id JOIN source_document d ON d.id = ch.document_id
             WHERE c.owner_type = 'topic_field' AND c.owner_id = ? LIMIT 1`,
            fid,
          );
          return {
            fieldId: fid,
            text: content.text,
            quote: content.quote ?? "",
            documentTitle: src?.title ?? "?",
            documentKind: src?.kind ?? "textbook",
            page: src?.page_from ?? null,
            lectureDate: src?.lecture_date ?? null,
            chunkId: src?.chunk_id ?? null,
            rank: SOURCE_RANK[(src?.kind ?? "textbook") as DocumentKind],
          } satisfies ConflictCandidate;
        })
        .filter((c): c is ConflictCandidate => !!c);
      const best = [...candidates].sort((a, b) => a.rank - b.rank);
      const hint = best.length > 1 && best[0]!.rank < best[1]!.rank ? best[0]!.fieldId : null;
      return {
        id: r.id,
        topicId: r.topic_id,
        topicName: r.topic_name,
        subjectId: r.subject_id,
        fieldType: r.field_type,
        fieldLabel: FIELD_LABEL[r.field_type as FieldType] ?? r.field_type,
        kind: r.kind,
        candidates,
        hintFieldId: hint,
      };
    });
}

/**
 * The user picks the right version. The other one is set aside; materials
 * built on it go back for review, and new materials are queued for the topic.
 */
export function resolveConflict(db: Db, conflictId: string, chosenFieldId: string, note?: string): void {
  const c = db.get<{ topic_id: string; candidates_json: string }>("SELECT topic_id, candidates_json FROM source_conflict WHERE id = ? AND status = 'open'", conflictId);
  if (!c) throw new Error("Ten konflikt jest już rozstrzygnięty.");
  const ids: string[] = JSON.parse(c.candidates_json);
  if (!ids.includes(chosenFieldId)) throw new Error("Wybierz jedną z wersji.");
  const subjectId = db.get<{ subject_id: string }>("SELECT subject_id FROM topic WHERE id = ?", c.topic_id)!.subject_id;
  db.tx(() => {
    const now = nowIso();
    for (const id of ids) {
      if (id === chosenFieldId) {
        // Still conflicted if it takes part in another open conflict.
        const other = db
          .all<{ candidates_json: string }>("SELECT candidates_json FROM source_conflict WHERE status = 'open' AND id != ?", conflictId)
          .some((x) => (JSON.parse(x.candidates_json) as string[]).includes(id));
        db.run("UPDATE topic_field SET status = ?, updated_at = ? WHERE id = ?", other ? "conflicted" : "active", now, id);
      } else {
        db.run("UPDATE topic_field SET status = 'superseded', updated_at = ? WHERE id = ?", now, id);
        db.run(
          `UPDATE material SET status = 'needs_review', updated_at = ? WHERE status IN ('active', 'pending')
           AND id IN (SELECT material_id FROM material_field WHERE topic_field_id = ?)`,
          now,
          id,
        );
      }
    }
    db.run(
      "UPDATE source_conflict SET status = 'resolved', resolution_json = ?, resolved_at = ?, updated_at = ? WHERE id = ?",
      JSON.stringify({ chosen: chosenFieldId, note: note ?? null }),
      now,
      now,
      conflictId,
    );
    enqueueGeneration(db, subjectId, [c.topic_id]);
  });
}

export interface WorkshopCounts {
  pending: number;
  needsReview: number;
  flagged: number;
  conflicts: number;
  suggestions: number;
}

export function workshopCounts(db: Db): WorkshopCounts {
  const n = (sql: string) => db.get<{ n: number }>(sql)!.n;
  return {
    pending: n("SELECT COUNT(*) AS n FROM material WHERE status = 'pending'"),
    needsReview: n("SELECT COUNT(*) AS n FROM material WHERE status = 'needs_review'"),
    flagged: n("SELECT COUNT(DISTINCT material_id) AS n FROM review_item i JOIN material m ON m.id = i.material_id WHERE i.suspended = 1 AND m.status = 'active'"),
    conflicts: n("SELECT COUNT(*) AS n FROM source_conflict WHERE status = 'open'"),
    suggestions: n("SELECT COUNT(*) AS n FROM suggestion WHERE status = 'open'"),
  };
}
