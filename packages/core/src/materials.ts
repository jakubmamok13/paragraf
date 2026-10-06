// Learning materials: payload formats, review units, and cards added by hand.
import { type Db, newId, nowIso } from "./db";

export type MaterialType = "qa" | "cloze" | "list" | "provision" | "distinction" | "why" | "case" | "oral" | "table";

/** qa, provision ("Który artykuł…?"), distinction ("Czym różni się…?"), why ("Dlaczego…?"). */
export interface QaPayload {
  q: string;
  a: string;
}
/** Text with gaps: "Termin zasiedzenia w złej wierze wynosi {{c1::trzydzieści lat}}." */
export interface ClozePayload {
  text: string;
}
/** "Wymień przesłanki…": recalled as a whole, revealed and graded item by item. */
export interface ListPayload {
  prompt: string;
  items: string[];
}

export const MATERIAL_LABEL: Record<MaterialType, string> = {
  qa: "Pytanie",
  cloze: "Luki",
  list: "Wyliczenie",
  provision: "Przepis",
  distinction: "Odróżnij",
  why: "Dlaczego?",
  case: "Kazus",
  oral: "Pytanie ustne",
  table: "Tabela",
};

/** Types the flashcard session can show (the rest come in v2). */
export const SESSION_TYPES: MaterialType[] = ["qa", "cloze", "list", "provision", "distinction", "why"];
const QA_LIKE: MaterialType[] = ["qa", "provision", "distinction", "why"];

// ---------- cloze ----------

const CLOZE_RE = /\{\{c(\d+)::(.*?)(?:::(.*?))?\}\}/g;

export type ClozeSegment =
  | { kind: "text"; text: string }
  | { kind: "gap"; key: string; answer: string; hint: string | null; active: boolean };

/** Splits cloze text; gaps of `activeKey` are the ones to recall, others are shown filled in. */
export function parseCloze(text: string, activeKey?: string): ClozeSegment[] {
  const out: ClozeSegment[] = [];
  let last = 0;
  for (const m of text.matchAll(CLOZE_RE)) {
    if (m.index! > last) out.push({ kind: "text", text: text.slice(last, m.index) });
    const key = `c${m[1]}`;
    out.push({ kind: "gap", key, answer: m[2]!, hint: m[3] ?? null, active: key === activeKey });
    last = m.index! + m[0].length;
  }
  if (last < text.length) out.push({ kind: "text", text: text.slice(last) });
  return out;
}

export function clozeKeys(text: string): string[] {
  return [...new Set([...text.matchAll(CLOZE_RE)].map((m) => `c${m[1]}`))].sort(
    (a, b) => Number(a.slice(1)) - Number(b.slice(1)),
  );
}

/** Review units of a material: one per cloze number, otherwise one for the whole material. */
export function subKeys(type: MaterialType, payload: unknown): string[] {
  if (type === "cloze") return clozeKeys((payload as ClozePayload).text);
  return [""];
}

// ---------- validation ----------

const words = (s: string) => s.trim().split(/\s+/).filter(Boolean).length;

/** Throws on a material that cannot be learned; returns warnings for ones that break the minimum-information rule. */
export function checkMaterial(type: MaterialType, payload: any): string[] {
  const warnings: string[] = [];
  if (QA_LIKE.includes(type)) {
    if (!payload?.q?.trim() || !payload?.a?.trim()) throw new Error("Wpisz pytanie i odpowiedź.");
    if (words(payload.a) > 20) warnings.push("Odpowiedź ma ponad 20 słów. Rozważ podział na kilka fiszek.");
    if (/^\s*(omów|scharakteryzuj|przedstaw)\b/i.test(payload.q)) {
      warnings.push("Pytania „Omów…” należą do trybu ustnego, nie do fiszek.");
    }
  } else if (type === "cloze") {
    if (!payload?.text?.trim()) throw new Error("Wpisz tekst z lukami.");
    if (clozeKeys(payload.text).length === 0) throw new Error("Zaznacz co najmniej jedną lukę: {{c1::tekst}}.");
  } else if (type === "list") {
    const items = (payload?.items ?? []).filter((s: string) => s.trim());
    if (!payload?.prompt?.trim()) throw new Error("Wpisz polecenie, np. „Wymień przesłanki…”.");
    if (items.length < 2) throw new Error("Wyliczenie musi mieć co najmniej dwie pozycje.");
    if (items.length > 7) warnings.push("Ponad 7 pozycji. Rozważ podział na mniejsze grupy.");
  } else {
    throw new Error("Tego rodzaju materiału nie da się jeszcze dodać ręcznie.");
  }
  return warnings;
}

// ---------- materials added by hand ----------

export interface ManualMaterialInput {
  subjectId: string;
  topicName: string;
  type: MaterialType;
  payload: QaPayload | ClozePayload | ListPayload;
}

/** Adds a card written by the user (active at once, no source needed: it is their own). */
export function addManualMaterial(db: Db, input: ManualMaterialInput): { id: string; warnings: string[] } {
  const warnings = checkMaterial(input.type, input.payload);
  const topicName = input.topicName.trim();
  if (!topicName) throw new Error("Podaj zagadnienie, którego dotyczy fiszka.");
  if (!db.get("SELECT 1 FROM subject WHERE id = ?", input.subjectId)) throw new Error("Nie ma takiego przedmiotu.");
  const payload =
    input.type === "list"
      ? { ...(input.payload as ListPayload), items: (input.payload as ListPayload).items.map((s) => s.trim()).filter(Boolean) }
      : input.payload;
  const now = nowIso();
  const id = newId();
  db.tx(() => {
    let topic = db.get<{ id: string }>(
      "SELECT id FROM topic WHERE subject_id = ? AND lower(name) = lower(?)",
      input.subjectId,
      topicName,
    );
    if (!topic) {
      topic = { id: newId() };
      db.run(
        "INSERT INTO topic (id, subject_id, name, status, created_at, updated_at) VALUES (?, ?, ?, 'active', ?, ?)",
        topic.id,
        input.subjectId,
        topicName,
        now,
        now,
      );
    }
    db.run(
      "INSERT INTO material (id, topic_id, type, payload_json, status, created_at, updated_at) VALUES (?, ?, ?, ?, 'active', ?, ?)",
      id,
      topic.id,
      input.type,
      JSON.stringify(payload),
      now,
      now,
    );
  });
  return { id, warnings };
}

export function topicNames(db: Db, subjectId: string): string[] {
  return db.all<{ name: string }>("SELECT name FROM topic WHERE subject_id = ? ORDER BY name COLLATE NOCASE", subjectId).map((r) => r.name);
}

export interface MaterialSource {
  chunkId: string;
  quote: string;
  documentTitle: string;
  documentKind: string;
  page: number | null;
  lectureDate: string | null;
}

/** Where a material comes from, for "show source" (empty for cards added by hand). */
export function materialSources(db: Db, materialId: string): MaterialSource[] {
  return db
    .all(
      `SELECT c.chunk_id, c.quote, d.title, d.kind, ch.page_from, d.lecture_date FROM citation c
       JOIN source_chunk ch ON ch.id = c.chunk_id JOIN source_document d ON d.id = ch.document_id
       WHERE c.owner_type = 'material' AND c.owner_id = ? ORDER BY ch.ord`,
      materialId,
    )
    .map((r) => ({ chunkId: r.chunk_id, quote: r.quote, documentTitle: r.title, documentKind: r.kind, page: r.page_from, lectureDate: r.lecture_date }));
}
