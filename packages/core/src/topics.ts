// A topic as one system: its parts in a fixed order (definition → basis →
// premises → effects → exceptions → deadlines → case law → doctrine →
// purpose), each card placed in a part, the short lesson that introduces a
// new topic, and the synthesis card "Odtwórz schemat".
import { type Db, newId, nowIso } from "./db";
import type { FieldType } from "./pipeline";
import { planSession, type PlannedCard, recallOf } from "./srs";
import { recordTombstone } from "./subjects";

export interface SlotInfo {
  slot: FieldType;
  label: string;
  /** Short glyph shown with the label (never instead of it). */
  icon: string;
}

export const SLOTS: SlotInfo[] = [
  { slot: "definition", label: "Definicja", icon: "📖" },
  { slot: "basis", label: "Podstawa prawna", icon: "⚖️" },
  { slot: "premise", label: "Przesłanki", icon: "☰" },
  { slot: "element", label: "Elementy", icon: "◇" },
  { slot: "effect", label: "Skutki", icon: "→" },
  { slot: "exception", label: "Wyjątki", icon: "⚠️" },
  { slot: "deadline", label: "Terminy", icon: "⏱" },
  { slot: "case_law", label: "Orzecznictwo", icon: "🏛" },
  { slot: "doctrine", label: "Doktryna", icon: "💬" },
  { slot: "ratio", label: "Cel regulacji", icon: "🎯" },
];
export const SLOT_ORDER: Record<string, number> = Object.fromEntries(SLOTS.map((s, i) => [s.slot, i]));
export const slotInfo = (slot: string | null | undefined): SlotInfo | undefined => SLOTS.find((s) => s.slot === slot);

/** The part of the topic each material belongs to: the earliest part among the fields it was made from. */
export function materialSlots(db: Db, materialIds?: string[]): Map<string, FieldType> {
  const rows = db.all<{ material_id: string; field_type: FieldType }>(
    `SELECT mf.material_id, f.field_type FROM material_field mf JOIN topic_field f ON f.id = mf.topic_field_id
     ${materialIds?.length ? `WHERE mf.material_id IN (${materialIds.map(() => "?").join(", ")})` : ""}`,
    ...(materialIds ?? []),
  );
  const out = new Map<string, FieldType>();
  for (const r of rows) {
    const prev = out.get(r.material_id);
    if (!prev || (SLOT_ORDER[r.field_type] ?? 99) < (SLOT_ORDER[prev] ?? 99)) out.set(r.material_id, r.field_type);
  }
  return out;
}

export interface SchemaPart extends SlotInfo {
  points: { fieldId: string; text: string; quote: string; source: string | null }[];
  materials: number;
  /** Items of this part's cards answered at least once. */
  learned: number;
  items: number;
  /** Average chance of recall now (0 if never studied). */
  mastery: number;
}

export interface TopicSchema {
  topicId: string;
  name: string;
  subjectName: string;
  parts: SchemaPart[];
  /** Parts with content in the sources but no card yet. */
  uncovered: SlotInfo[];
}

export function topicSchema(db: Db, topicId: string, now = new Date()): TopicSchema | undefined {
  const t = db.get<{ name: string; subject_name: string }>("SELECT t.name, s.name AS subject_name FROM topic t JOIN subject s ON s.id = t.subject_id WHERE t.id = ?", topicId);
  if (!t) return undefined;
  const fields = db.all<{ id: string; field_type: FieldType; content_json: string; ord: number }>(
    "SELECT id, field_type, content_json, ord FROM topic_field WHERE topic_id = ? AND status = 'active' ORDER BY ord",
    topicId,
  );
  const materials = db.all<{ id: string }>("SELECT id FROM material WHERE topic_id = ? AND status IN ('active', 'pending')", topicId).map((m) => m.id);
  const slots = materialSlots(db, materials);
  const items = db.all<any>(
    `SELECT i.*, m.id AS mid FROM review_item i JOIN material m ON m.id = i.material_id WHERE m.topic_id = ? AND m.status = 'active' AND i.suspended = 0`,
    topicId,
  );
  const parts: SchemaPart[] = [];
  const uncovered: SlotInfo[] = [];
  for (const info of SLOTS) {
    const fs = fields.filter((f) => f.field_type === info.slot);
    const mats = materials.filter((m) => slots.get(m) === info.slot);
    if (!fs.length && !mats.length) continue;
    const its = items.filter((i) => slots.get(i.mid) === info.slot);
    const points = fs.map((f) => {
      const c = JSON.parse(f.content_json);
      const src = db.get<{ title: string; page_from: number | null; lecture_date: string | null }>(
        `SELECT d.title, ch.page_from, d.lecture_date FROM citation ci JOIN source_chunk ch ON ch.id = ci.chunk_id JOIN source_document d ON d.id = ch.document_id
         WHERE ci.owner_type = 'topic_field' AND ci.owner_id = ? LIMIT 1`,
        f.id,
      );
      const source = src ? `${src.title}${src.page_from ? `, s. ${src.page_from}` : ""}${src.lecture_date ? `, wykład ${src.lecture_date}` : ""}` : null;
      return { fieldId: f.id, text: c.text as string, quote: (c.quote ?? "") as string, source };
    });
    parts.push({
      ...info,
      points,
      materials: mats.length,
      learned: its.filter((i: any) => i.reps > 0).length,
      items: its.length,
      mastery: its.length ? its.reduce((s: number, i: any) => s + recallOf(i, now), 0) / its.length : 0,
    });
    if (fs.length && !mats.length) uncovered.push(info);
  }
  return { topicId, name: t.name, subjectName: t.subject_name, parts, uncovered };
}

// ---------- synthesis card ----------

const short = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s);

/**
 * "Odtwórz schemat: X": recalling the structure of a topic, once its parts
 * have been practised. Made from the verified fields (no model involved),
 * one item per part, waiting for approval like any other card.
 */
export function ensureSynthesis(db: Db, topicId: string): string | null {
  const schema = topicSchema(db, topicId);
  if (!schema) return null;
  const parts = schema.parts.filter((p) => p.points.length);
  if (parts.length < 3) return null;
  const items = parts.map((p) => `${p.label}: ${short(p.points.map((x) => x.text.replace(/\.$/, "")).join("; "), 90)}`);
  const payload = { prompt: `Odtwórz schemat zagadnienia: ${schema.name}`, items, synthesis: true };
  const existing = db.get<{ id: string; payload_json: string }>(
    "SELECT id, payload_json FROM material WHERE topic_id = ? AND type = 'list' AND json_extract(payload_json, '$.synthesis') = 1",
    topicId,
  );
  const now = nowIso();
  let id = existing?.id;
  db.tx(() => {
    if (existing) {
      if (existing.payload_json === JSON.stringify(payload)) return;
      db.run("UPDATE material SET payload_json = ?, updated_at = ? WHERE id = ?", JSON.stringify(payload), now, existing.id);
      for (const c of db.all<{ id: string }>("SELECT id FROM citation WHERE owner_type = 'material' AND owner_id = ?", existing.id)) {
        recordTombstone(db, "citation", c.id);
      }
      db.run("DELETE FROM citation WHERE owner_type = 'material' AND owner_id = ?", existing.id);
      db.run("DELETE FROM material_field WHERE material_id = ?", existing.id);
    } else {
      id = newId();
      db.run(
        "INSERT INTO material (id, topic_id, type, payload_json, status, prompt_version, created_at, updated_at) VALUES (?, ?, 'list', ?, 'pending', 'synthesis@1', ?, ?)",
        id,
        topicId,
        JSON.stringify(payload),
        now,
        now,
      );
    }
    for (const p of parts) {
      const f = p.points[0]!;
      const c = db.get<{ chunk_id: string; quote: string; char_start: number | null; char_end: number | null }>(
        "SELECT chunk_id, quote, char_start, char_end FROM citation WHERE owner_type = 'topic_field' AND owner_id = ? LIMIT 1",
        f.fieldId,
      );
      if (c) {
        db.run(
          "INSERT INTO citation (id, owner_type, owner_id, chunk_id, quote, char_start, char_end, verified, updated_at) VALUES (?, 'material', ?, ?, ?, ?, ?, 1, ?)",
          newId(),
          id!,
          c.chunk_id,
          c.quote,
          c.char_start,
          c.char_end,
          now,
        );
      }
    }
  });
  return id ?? null;
}

// ---------- the short lesson ----------

export interface LessonCandidate {
  topicId: string;
  name: string;
  subjectName: string;
  cards: number;
  examWeight: number;
}

/** New topics (none of their cards tried yet) worth a short lesson, most important first. */
export function lessonCandidates(db: Db, limit = 3): LessonCandidate[] {
  return db
    .all<any>(
      `SELECT t.id, t.name, s.name AS subject_name, COALESCE(t.exam_weight_override, t.exam_weight) AS w,
         (SELECT COUNT(*) FROM material m WHERE m.topic_id = t.id AND m.status = 'active'
            AND COALESCE(json_extract(m.payload_json, '$.synthesis'), 0) = 0) AS cards
       FROM topic t JOIN subject s ON s.id = t.subject_id
       WHERE s.status = 'active'
         AND NOT EXISTS (SELECT 1 FROM review_item i JOIN material m ON m.id = i.material_id WHERE m.topic_id = t.id AND i.reps > 0)
       ORDER BY w DESC, t.name`,
    )
    .filter((r) => r.cards >= 2)
    .slice(0, limit)
    .map((r) => ({ topicId: r.id, name: r.name, subjectName: r.subject_name, cards: r.cards, examWeight: r.w }));
}

export interface Lesson {
  schema: TopicSchema;
  /** Asked before reading (pretesting): they direct attention and do not change the schedule. */
  prequestions: PlannedCard[];
  /** The topic's new cards in the order of the schema: the first recall right after the lesson. */
  cards: PlannedCard[];
}

export function buildLesson(db: Db, topicId: string, now = new Date()): Lesson | undefined {
  const schema = topicSchema(db, topicId, now);
  if (!schema) return undefined;
  const plan = planSession(db, now, { topicId, newLimit: 100, budgetSeconds: 3600, ignoreStudiedToday: true, slotOrder: true });
  const cards = plan.cards.filter((c) => c.isNew);
  // Two pre-questions from different parts, short answers preferred.
  const pre: PlannedCard[] = [];
  for (const c of [...cards].sort((a, b) => Number(b.type === "qa") - Number(a.type === "qa"))) {
    if (pre.length >= 2) break;
    if (c.type === "list" || pre.some((p) => p.slot === c.slot)) continue;
    pre.push(c);
  }
  return { schema, prequestions: pre, cards };
}

// ---------- reading aloud ----------

const ACT_SPOKEN: Record<string, string> = {
  "k.c.": "kodeksu cywilnego",
  "k.k.": "kodeksu karnego",
  "k.p.c.": "kodeksu postępowania cywilnego",
  "k.p.k.": "kodeksu postępowania karnego",
  "k.r.o.": "kodeksu rodzinnego i opiekuńczego",
  "k.p.": "kodeksu pracy",
  "k.p.a.": "kodeksu postępowania administracyjnego",
  "k.s.h.": "kodeksu spółek handlowych",
  "k.w.": "kodeksu wykroczeń",
};

/** Text for speech synthesis: legal abbreviations read out in full. */
export function speechText(s: string): string {
  let out = s;
  for (const [abbr, full] of Object.entries(ACT_SPOKEN)) out = out.split(abbr).join(full);
  return out
    .replace(/\bart\.\s*/gi, "artykuł ")
    .replace(/§\s*/g, "paragraf ")
    .replace(/\bust\.\s*/g, "ustęp ")
    .replace(/\bpkt\s*/g, "punkt ")
    .replace(/\bnp\./g, "na przykład")
    .replace(/\bm\.in\./g, "między innymi")
    .replace(/\bitd\./g, "i tak dalej")
    .replace(/\btzw\./g, "tak zwany")
    .replace(/\bSN\b/g, "Sąd Najwyższy")
    .replace(/\bTK\b/g, "Trybunał Konstytucyjny")
    .replace(/\s+/g, " ")
    .trim();
}

/** What is read aloud for each part of the lesson. */
export function lessonScript(schema: TopicSchema): { slot: FieldType; text: string }[] {
  return schema.parts
    .filter((p) => p.points.length)
    .map((p) => ({ slot: p.slot, text: speechText(`${p.label}. ${p.points.map((x) => x.text).join(" ")}`) }));
}
