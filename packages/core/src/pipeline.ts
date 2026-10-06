// Processing pipeline on the laptop: source fragment → topics and fields
// (with verified quotes) → merged knowledge map with conflicts flagged →
// learning materials waiting for approval.
//
// The model is a small local one, so every step is small (one fragment, one
// topic) and every claim is checked in code: a quote must be found in the
// fragment, and numbers and article numbers must appear in the source.
// Anything that fails becomes a suggestion, never a card.
import { AiError, chatJson, type FetchFn } from "./ai";
import type { AiSettings } from "./settings";
import { type Db, newId, nowIso } from "./db";
import { type DocumentKind, DOCUMENT_KIND_LABEL, getChunk, SOURCE_RANK, sha256Hex } from "./documents";
import { extractProvisions, locateQuote, supportingPassage, normalizeForMatch, numbersIn, provisionKey, SearchIndex, tokenize, unsupportedFacts } from "./legal";
import { checkMaterial, type MaterialType } from "./materials";
import type { PromptSet } from "./prompts";
import { getSettings } from "./settings";
import { ensureSynthesis } from "./topics";

export interface PipelineContext {
  prompts: PromptSet;
  fetchFn?: FetchFn;
  signal?: AbortSignal;
  /** Model settings to use instead of the saved ones (model comparison). */
  ai?: AiSettings;
  /** Reuse earlier answers to identical requests (default true). */
  useCache?: boolean;
  onProgress?: (p: JobProgress) => void;
}

export interface JobProgress {
  jobId: string;
  kind: string;
  done: number;
  total: number;
  label: string;
}

// ---------- JSON schemas (strict: every property required, no extras) ----------

const str = { type: "string" };
const bool = { type: "boolean" };
const arr = (items: object) => ({ type: "array", items });
const obj = (props: Record<string, object>) => ({ type: "object", properties: props, required: Object.keys(props), additionalProperties: false });
const oneOf = (...values: string[]) => ({ type: "string", enum: values });

export const FIELD_TYPES = ["definition", "basis", "premise", "element", "effect", "exception", "deadline", "case_law", "doctrine", "ratio"] as const;
export type FieldType = (typeof FIELD_TYPES)[number];
export const FIELD_LABEL: Record<FieldType, string> = {
  definition: "definicja",
  basis: "podstawa prawna",
  premise: "przesłanka",
  element: "element",
  effect: "skutek",
  exception: "wyjątek",
  deadline: "termin",
  case_law: "orzecznictwo",
  doctrine: "doktryna",
  ratio: "cel regulacji",
};

const EXTRACT_SCHEMA = obj({
  topics: arr(
    obj({
      name: str,
      aliases: arr(str),
      emphasized: bool,
      fields: arr(obj({ type: oneOf(...FIELD_TYPES), definition_kind: oneOf("legal", "doctrinal", "none"), text: str, quote: str })),
      relations: arr(obj({ type: oneOf("is_a", "distinguish", "exception_to", "applies_mutatis"), target: str })),
    }),
  ),
  gaps: arr(str),
});

const MERGE_SCHEMA = obj({ decision: oneOf("same", "different"), existing_name: str });

const GENERATED_TYPES = ["qa", "cloze", "list", "distinction", "why", "provision"] as const;
const GENERATE_SCHEMA = obj({
  materials: arr(
    obj({
      type: oneOf(...GENERATED_TYPES),
      question: str,
      answer: str,
      cloze_text: str,
      list_prompt: str,
      list_items: arr(str),
      field_ids: arr(str),
      citations: arr(obj({ chunk_id: str, quote: str })),
    }),
  ),
  suggestions: arr(str),
});

interface ExtractedField {
  type: FieldType;
  definition_kind: "legal" | "doctrinal" | "none";
  text: string;
  quote: string;
}
interface ExtractedTopic {
  name: string;
  aliases: string[];
  emphasized: boolean;
  fields: ExtractedField[];
  relations: { type: string; target: string }[];
}
interface ExtractOutput {
  topics: ExtractedTopic[];
  gaps: string[];
}

// ---------- AI call with cache ----------

async function callAi<T>(db: Db, ctx: PipelineContext, promptId: string, user: string, schema: object): Promise<T> {
  const prompt = ctx.prompts[promptId];
  if (!prompt) throw new Error(`Brak promptu „${promptId}”.`);
  const ai = ctx.ai ?? getSettings(db).ai;
  const inputHash = await sha256Hex(`${prompt.system}\n\n${user}`);
  if (ctx.useCache !== false) {
    const hit = db.get<{ output_json: string }>(
      "SELECT output_json FROM ai_call WHERE prompt_id = ? AND prompt_version = ? AND model = ? AND input_hash = ? AND status = 'ok' ORDER BY created_at DESC LIMIT 1",
      prompt.id,
      prompt.version,
      ai.model,
      inputHash,
    );
    if (hit) return JSON.parse(hit.output_json) as T;
  }
  try {
    const res = await chatJson<T>(ai, { system: prompt.system, user, schema, numCtx: 8192, ...(ctx.signal ? { signal: ctx.signal } : {}) }, ctx.fetchFn);
    db.run(
      "INSERT INTO ai_call (id, prompt_id, prompt_version, model, input_hash, output_json, duration_ms, tokens_in, tokens_out, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'ok', ?)",
      newId(),
      prompt.id,
      prompt.version,
      ai.model,
      inputHash,
      JSON.stringify(res.value),
      res.durationMs,
      res.tokensIn,
      res.tokensOut,
      nowIso(),
    );
    return res.value;
  } catch (e) {
    if (!isAbort(e)) {
      db.run(
        "INSERT INTO ai_call (id, prompt_id, prompt_version, model, input_hash, status, error, created_at) VALUES (?, ?, ?, ?, ?, 'error', ?, ?)",
        newId(),
        prompt.id,
        prompt.version,
        ai.model,
        inputHash,
        e instanceof Error ? e.message : String(e),
        nowIso(),
      );
    }
    throw e;
  }
}

const isAbort = (e: unknown) => e instanceof Error && (e.name === "AbortError" || /abort/i.test(e.message));

// ---------- helpers ----------

const normName = (s: string) => tokenize(s).join(" ");
function jaccard(a: string[], b: string[]): number {
  const A = new Set(a);
  const B = new Set(b);
  if (!A.size || !B.size) return 0;
  let inter = 0;
  for (const x of A) if (B.has(x)) inter++;
  return inter / (A.size + B.size - inter);
}
/** Words of a claim with numbers and provisions taken out: to see if two claims say the same thing apart from the facts. */
const wordsSansFacts = (s: string) => tokenize(s.replace(/\bart\.\s*\d+[a-z]*(\s*§\s*\d+)?/gi, " ")).filter((t) => !/^\d/.test(t) && t !== "§");
function factsOf(s: string): string {
  const provs = extractProvisions(s).map(provisionKey).sort();
  const nums = [...numbersIn(s.replace(/\bart\.\s*\d+[a-z]*(\s*§\s*\d+[a-z]?)?(\s*(pkt|ust\.)\s*\d+)?/gi, " "))].sort();
  return JSON.stringify([provs, nums]);
}

function headingSection(db: Db, subjectId: string, title: string, origin: string): string {
  const existing = db.get<{ id: string }>("SELECT id FROM section WHERE subject_id = ? AND lower(title) = lower(?)", subjectId, title);
  if (existing) return existing.id;
  const id = newId();
  const ord = db.get<{ n: number }>("SELECT COUNT(*) AS n FROM section WHERE subject_id = ?", subjectId)!.n;
  db.run("INSERT INTO section (id, subject_id, title, ord, origin, updated_at) VALUES (?, ?, ?, ?, ?, ?)", id, subjectId, title, ord, origin, nowIso());
  return id;
}

function findTopic(db: Db, subjectId: string, name: string, aliases: string[] = []): string | undefined {
  const wanted = new Set([name, ...aliases].map(normName).filter(Boolean));
  for (const t of db.all<{ id: string; name: string; aliases_json: string }>("SELECT id, name, aliases_json FROM topic WHERE subject_id = ?", subjectId)) {
    const names = [t.name, ...(JSON.parse(t.aliases_json) as string[])].map(normName);
    if (names.some((n) => wanted.has(n))) return t.id;
  }
  return undefined;
}

function similarTopics(db: Db, subjectId: string, name: string): { id: string; name: string; score: number }[] {
  const toks = tokenize(name);
  return db
    .all<{ id: string; name: string; aliases_json: string }>("SELECT id, name, aliases_json FROM topic WHERE subject_id = ?", subjectId)
    .map((t) => ({
      id: t.id,
      name: t.name,
      score: Math.max(...[t.name, ...(JSON.parse(t.aliases_json) as string[])].map((n) => jaccard(toks, tokenize(n)))),
    }))
    .filter((t) => t.score >= 0.5)
    .sort((a, b) => b.score - a.score)
    .slice(0, 3);
}

function addSuggestion(db: Db, subjectId: string, kind: string, text: string, topicId?: string | null, chunkId?: string | null): void {
  const t = text.trim();
  if (!t) return;
  if (db.get("SELECT 1 FROM suggestion WHERE subject_id = ? AND kind = ? AND text = ? AND status = 'open'", subjectId, kind, t)) return;
  const now = nowIso();
  db.run(
    "INSERT INTO suggestion (id, subject_id, topic_id, chunk_id, kind, text, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    newId(),
    subjectId,
    topicId ?? null,
    chunkId ?? null,
    kind,
    t,
    now,
    now,
  );
}

// ---------- extraction ----------

export interface ValidatedTopic {
  name: string;
  aliases: string[];
  emphasized: boolean;
  fields: { type: FieldType; definitionKind: string; text: string; quote: string; start: number; end: number }[];
  relations: { type: string; target: string }[];
}

/** Keeps only fields whose quote is in the fragment and whose numbers and provisions come from it. */
export function validateExtraction(out: ExtractOutput, chunkText: string): { topics: ValidatedTopic[]; rejected: { topic: string; text: string; reason: string }[] } {
  const topics: ValidatedTopic[] = [];
  const rejected: { topic: string; text: string; reason: string }[] = [];
  for (const t of out?.topics ?? []) {
    const name = String(t?.name ?? "").replace(/\s+/g, " ").trim();
    if (!name || name.length > 120) continue;
    const fields: ValidatedTopic["fields"] = [];
    for (const f of t.fields ?? []) {
      if (!FIELD_TYPES.includes(f?.type) || !f.text?.trim()) continue;
      // The model's quote, else its claim copied from the text, else the sentence that backs the claim.
      const loc = locateQuote(f.quote ?? "", chunkText) ?? locateQuote(f.text, chunkText) ?? supportingPassage(f.text, chunkText);
      if (!loc) {
        const said = f.quote?.trim() ? `; cytat modelu: „${f.quote.trim().slice(0, 120)}”` : "";
        rejected.push({ topic: name, text: f.text, reason: `nie znaleziono w źródle zdania, które to potwierdza${said}` });
        continue;
      }
      const bad = unsupportedFacts(f.text, chunkText);
      if (bad.length) {
        rejected.push({ topic: name, text: f.text, reason: `${bad.join(", ")} – tego nie ma w źródle` });
        continue;
      }
      fields.push({ type: f.type, definitionKind: f.type === "definition" ? f.definition_kind : "none", text: f.text.trim(), quote: loc.text, start: loc.start, end: loc.end });
    }
    if (!fields.length) continue;
    topics.push({
      name,
      aliases: (t.aliases ?? []).map((a) => String(a).trim()).filter((a) => a && a !== name),
      emphasized: !!t.emphasized,
      fields,
      relations: (t.relations ?? []).filter((r) => r?.target?.trim()),
    });
  }
  return { topics, rejected };
}

function extractMessage(db: Db, chunkId: string): { user: string; subjectId: string; docKind: DocumentKind } {
  const c = getChunk(db, chunkId)!;
  const subject = db.get<{ id: string; name: string }>(
    "SELECT s.id, s.name FROM subject s JOIN source_document d ON d.subject_id = s.id WHERE d.id = ?",
    c.documentId,
  )!;
  const known = db
    .all<{ name: string }>("SELECT name FROM topic WHERE subject_id = ? ORDER BY exam_weight DESC, name LIMIT 120", subject.id)
    .map((r) => r.name);
  const where = [
    DOCUMENT_KIND_LABEL[c.documentKind],
    `„${c.documentTitle}”`,
    c.lectureDate ? `wykład z ${c.lectureDate}` : "",
    c.pageFrom ? `s. ${c.pageFrom}${c.pageTo && c.pageTo !== c.pageFrom ? `–${c.pageTo}` : ""}` : "",
  ].filter(Boolean);
  const user = [
    `Przedmiot: ${subject.name}`,
    `Źródło: ${where.join(", ")}`,
    c.headingPath.length ? `Rozdział / sekcja: ${c.headingPath.join(" › ")}` : "",
    known.length ? `Znane zagadnienia w tym przedmiocie (użyj tej samej nazwy, jeśli fragment dotyczy tego samego):\n${known.map((k) => `- ${k}`).join("\n")}` : "",
    `FRAGMENT:\n"""\n${c.text}\n"""`,
  ]
    .filter(Boolean)
    .join("\n\n");
  return { user, subjectId: subject.id, docKind: c.documentKind };
}

export interface ChunkStats {
  topics: number;
  fields: number;
  rejected: number;
  conflicts: number;
}

/** Reads one fragment with the model and adds what it finds to the knowledge map. */
export async function processChunk(db: Db, ctx: PipelineContext, chunkId: string): Promise<ChunkStats> {
  const chunk = getChunk(db, chunkId);
  if (!chunk) throw new Error("Nie ma takiego fragmentu.");
  const { user, subjectId, docKind } = extractMessage(db, chunkId);
  const out = await callAi<ExtractOutput>(db, ctx, "extract-topics", user, EXTRACT_SCHEMA);
  const { topics, rejected } = validateExtraction(out, chunk.text);

  // Decide merges first (they may need the model), then write everything in one transaction.
  const resolved: (string | undefined)[] = [];
  for (const t of topics) {
    let id = findTopic(db, subjectId, t.name, t.aliases);
    if (!id) {
      const cands = similarTopics(db, subjectId, t.name);
      if (cands.length) {
        const msg = [
          `Nowe zagadnienie: ${t.name}`,
          `Co o nim mówi źródło:\n${t.fields.slice(0, 4).map((f) => `- ${f.text}`).join("\n")}`,
          `Istniejące zagadnienia:\n${cands
            .map((c) => {
              const fs = db.all<{ content_json: string }>("SELECT content_json FROM topic_field WHERE topic_id = ? LIMIT 3", c.id).map((f) => JSON.parse(f.content_json).text);
              return `- ${c.name}${fs.length ? `: ${fs.join("; ")}` : ""}`;
            })
            .join("\n")}`,
        ].join("\n\n");
        const dec = await callAi<{ decision: string; existing_name: string }>(db, ctx, "merge-topics", msg, MERGE_SCHEMA);
        if (dec.decision === "same") id = cands.find((c) => normName(c.name) === normName(dec.existing_name))?.id;
      }
    }
    resolved.push(id);
  }

  let fieldCount = 0;
  let conflicts = 0;
  db.tx(() => {
    const now = nowIso();
    topics.forEach((t, i) => {
      let topicId = resolved[i];
      if (!topicId) {
        topicId = newId();
        db.run(
          "INSERT INTO topic (id, subject_id, name, aliases_json, status, created_at, updated_at) VALUES (?, ?, ?, ?, 'active', ?, ?)",
          topicId,
          subjectId,
          t.name,
          JSON.stringify(t.aliases),
          now,
          now,
        );
      } else {
        const row = db.get<{ name: string; aliases_json: string; status: string }>("SELECT name, aliases_json, status FROM topic WHERE id = ?", topicId)!;
        const aliases = new Set<string>(JSON.parse(row.aliases_json));
        for (const a of [t.name, ...t.aliases]) if (normName(a) !== normName(row.name)) aliases.add(a);
        db.run("UPDATE topic SET aliases_json = ?, status = 'active', updated_at = ? WHERE id = ?", JSON.stringify([...aliases]), now, topicId);
      }
      if (t.emphasized) db.run("UPDATE topic SET emphasis = emphasis + 1 WHERE id = ?", topicId);
      // Notes: the heading under the lecture title ("Zasiedzenie"), not the lecture itself; textbooks: the chapter.
      const sectionTitle =
        docKind === "note" ? (chunk.headingPath[1] ?? chunk.headingPath[0] ?? chunk.documentTitle) : (chunk.headingPath[0] ?? null);
      if (sectionTitle) {
        db.run(
          "UPDATE topic SET section_id = ? WHERE id = ? AND section_id IS NULL",
          headingSection(db, subjectId, sectionTitle, docKind === "textbook" ? "textbook" : docKind === "act" ? "act" : "note"),
          topicId,
        );
      }

      for (const f of t.fields) {
        const same = db
          .all<{ id: string; content_json: string }>("SELECT id, content_json FROM topic_field WHERE topic_id = ? AND field_type = ?", topicId, f.type)
          .find((x) => {
            const c = JSON.parse(x.content_json);
            return normalizeForMatch(c.text) === normalizeForMatch(f.text) || normalizeForMatch(c.quote ?? "") === normalizeForMatch(f.quote);
          });
        let fieldId = same?.id;
        if (!fieldId) {
          fieldId = newId();
          const ord = db.get<{ n: number }>("SELECT COUNT(*) AS n FROM topic_field WHERE topic_id = ?", topicId)!.n;
          db.run(
            "INSERT INTO topic_field (id, topic_id, field_type, ord, content_json, status, updated_at) VALUES (?, ?, ?, ?, ?, 'active', ?)",
            fieldId,
            topicId,
            f.type,
            ord,
            JSON.stringify({ text: f.text, quote: f.quote, kind: f.definitionKind }),
            now,
          );
          for (const p of extractProvisions(`${f.text} ${f.quote}`)) {
            const pid = newId();
            db.run("INSERT INTO provision_ref (id, act_id, article, paragraph, point, raw, updated_at) VALUES (?, NULL, ?, ?, ?, ?, ?)", pid, p.article, p.paragraph, p.point, p.raw, now);
            db.run("INSERT OR IGNORE INTO topic_field_provision (topic_field_id, provision_ref_id) VALUES (?, ?)", fieldId, pid);
          }
          fieldCount++;
          conflicts += detectConflict(db, topicId, fieldId, f.type, f.text, chunk.documentId);
        }
        if (!db.get("SELECT 1 FROM citation WHERE owner_type = 'topic_field' AND owner_id = ? AND chunk_id = ?", fieldId, chunkId)) {
          db.run(
            "INSERT INTO citation (id, owner_type, owner_id, chunk_id, quote, char_start, char_end, verified, updated_at) VALUES (?, 'topic_field', ?, ?, ?, ?, ?, 1, ?)",
            newId(),
            fieldId,
            chunkId,
            f.quote,
            f.start,
            f.end,
            now,
          );
        }
      }

      for (const r of t.relations) {
        let target = findTopic(db, subjectId, r.target);
        if (!target) {
          // Mentioned before it is discussed (later in the note): a draft topic that fills in when its fragment is read.
          const name = r.target.replace(/\s+/g, " ").trim();
          if (!name || name.length > 120) continue;
          target = newId();
          db.run("INSERT INTO topic (id, subject_id, name, status, created_at, updated_at) VALUES (?, ?, ?, 'draft', ?, ?)", target, subjectId, name, now, now);
        }
        if (target === topicId) continue;
        if (db.get("SELECT 1 FROM topic_relation WHERE from_topic = ? AND to_topic = ? AND type = ?", topicId, target, r.type)) continue;
        db.run("INSERT INTO topic_relation (id, from_topic, to_topic, type, updated_at) VALUES (?, ?, ?, ?, ?)", newId(), topicId, target, r.type, now);
      }
    });

    for (const g of out?.gaps ?? []) addSuggestion(db, subjectId, "gap", String(g), null, chunkId);
    for (const r of rejected) {
      addSuggestion(db, subjectId, "rejected_field", `${r.topic}: „${r.text}” (${r.reason})`, findTopic(db, subjectId, r.topic) ?? null, chunkId);
    }
    db.run("UPDATE source_chunk SET processed_at = ? WHERE id = ?", now, chunkId);
  });
  return { topics: topics.length, fields: fieldCount, rejected: rejected.length, conflicts };
}

/**
 * A fragment the model cannot answer in valid JSON is tried once more without
 * the cache, then skipped with a note; one bad fragment does not stop the queue.
 */
async function processChunkTolerant(db: Db, ctx: PipelineContext, chunkId: string, subjectId: string): Promise<void> {
  try {
    await processChunk(db, ctx, chunkId);
  } catch (e) {
    if (!(e instanceof AiError) || e.kind !== "bad_json") throw e;
    try {
      await processChunk(db, { ...ctx, useCache: false }, chunkId);
    } catch (e2) {
      if (!(e2 instanceof AiError) || e2.kind !== "bad_json") throw e2;
      const c = getChunk(db, chunkId)!;
      addSuggestion(db, subjectId, "gap", `Nie udało się przeanalizować fragmentu „${c.text.slice(0, 80)}…” (${c.documentTitle}). Sprawdź go ręcznie.`, null, chunkId);
      db.run("UPDATE source_chunk SET processed_at = ? WHERE id = ?", nowIso(), chunkId);
    }
  }
}

/**
 * Two fields of the same kind from different documents that say the same
 * thing but with other numbers or article numbers are a conflict for the user
 * to decide (e.g. a textbook from before an amendment). Nothing is chosen silently.
 */
function detectConflict(db: Db, topicId: string, fieldId: string, type: FieldType, text: string, documentId: string): number {
  const others = db.all<{ id: string; content_json: string; doc: string | null }>(
    `SELECT f.id, f.content_json,
       (SELECT ch.document_id FROM citation c JOIN source_chunk ch ON ch.id = c.chunk_id WHERE c.owner_type = 'topic_field' AND c.owner_id = f.id LIMIT 1) AS doc
     FROM topic_field f WHERE f.topic_id = ? AND f.field_type = ? AND f.id != ? AND f.status != 'superseded'`,
    topicId,
    type,
    fieldId,
  );
  const mine = wordsSansFacts(text);
  for (const o of others) {
    if (!o.doc || o.doc === documentId) continue;
    const otherText = JSON.parse(o.content_json).text as string;
    if (jaccard(mine, wordsSansFacts(otherText)) < 0.8) continue;
    if (factsOf(text) === factsOf(otherText)) continue;
    const provsDiffer = JSON.stringify(extractProvisions(text).map(provisionKey).sort()) !== JSON.stringify(extractProvisions(otherText).map(provisionKey).sort());
    const now = nowIso();
    db.run(
      "INSERT INTO source_conflict (id, topic_id, field_type, kind, candidates_json, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 'open', ?, ?)",
      newId(),
      topicId,
      type,
      provsDiffer ? "provision_number" : "content",
      JSON.stringify([o.id, fieldId]),
      now,
      now,
    );
    db.run("UPDATE topic_field SET status = 'conflicted', updated_at = ? WHERE id IN (?, ?)", now, o.id, fieldId);
    return 1;
  }
  return 0;
}

/** Exam topic lists and syllabi need no model: each line is matched to a topic (or becomes one without material yet). */
export function processTopicList(db: Db, documentId: string): number {
  const doc = db.get<{ subject_id: string; kind: DocumentKind }>("SELECT subject_id, kind FROM source_document WHERE id = ?", documentId)!;
  const level = doc.kind === "exam_list" ? 2 : 1;
  let matched = 0;
  db.tx(() => {
    const now = nowIso();
    for (const c of db.all<{ id: string; text: string }>("SELECT id, text FROM source_chunk WHERE document_id = ? AND processed_at IS NULL", documentId)) {
      const items = c.text
        .split(/\n+/)
        .map((s) => s.replace(/^\s*(\d+[.)]|[-*•]|[a-z]\))\s*/i, "").trim())
        .filter((s) => s.length >= 3 && s.length <= 160);
      for (const item of items) {
        let id = findTopic(db, doc.subject_id, item) ?? similarTopics(db, doc.subject_id, item)[0]?.id;
        if (!id) {
          id = newId();
          db.run("INSERT INTO topic (id, subject_id, name, status, created_at, updated_at) VALUES (?, ?, ?, 'draft', ?, ?)", id, doc.subject_id, item, now, now);
        } else matched++;
        db.run("UPDATE topic SET on_exam_list = MAX(on_exam_list, ?), updated_at = ? WHERE id = ?", level, now, id);
      }
      db.run("UPDATE source_chunk SET processed_at = ? WHERE id = ?", now, c.id);
    }
  });
  return matched;
}

/**
 * Exam weight 0–1: exam list 1.0; lecture notes 0.5 (+0.1 for each further
 * lecture, +0.2 when stressed, up to 0.9); syllabus 0.5; act 0.3; textbook only 0.2.
 */
export function recomputeWeights(db: Db, subjectId: string): void {
  db.tx(() => {
    for (const t of db.all<{ id: string; emphasis: number; on_exam_list: number }>("SELECT id, emphasis, on_exam_list FROM topic WHERE subject_id = ?", subjectId)) {
      const kinds = new Map(
        db
          .all<{ kind: DocumentKind; n: number }>(
            `SELECT d.kind, COUNT(DISTINCT d.id) AS n FROM topic_field f
             JOIN citation c ON c.owner_type = 'topic_field' AND c.owner_id = f.id
             JOIN source_chunk ch ON ch.id = c.chunk_id JOIN source_document d ON d.id = ch.document_id
             WHERE f.topic_id = ? GROUP BY d.kind`,
            t.id,
          )
          .map((r) => [r.kind, r.n]),
      );
      const notes = kinds.get("note") ?? 0;
      const w = Math.max(
        t.on_exam_list === 2 ? 1 : 0,
        t.on_exam_list === 1 ? 0.5 : 0,
        notes ? Math.min(0.9, 0.5 + 0.1 * (notes - 1) + (t.emphasis > 0 ? 0.2 : 0)) : 0,
        kinds.has("act") ? 0.3 : 0,
        kinds.has("textbook") || kinds.has("case_law") || kinds.has("scholarly") ? 0.2 : 0,
      );
      db.run("UPDATE topic SET exam_weight = ? WHERE id = ?", Math.round(w * 100) / 100, t.id);
    }
  });
}

// ---------- generation ----------

interface GeneratedMaterial {
  type: (typeof GENERATED_TYPES)[number];
  question: string;
  answer: string;
  cloze_text: string;
  list_prompt: string;
  list_items: string[];
  field_ids: string[];
  citations: { chunk_id: string; quote: string }[];
}

interface FieldRow {
  id: string;
  topic_id: string;
  field_type: FieldType;
  content_json: string;
}

/** Text used to check a material's facts and to find duplicates. */
function materialText(type: MaterialType, p: any): string {
  if (type === "cloze") return String(p.text).replace(/\{\{c\d+::(.*?)(?:::.*?)?\}\}/g, "$1");
  if (type === "list") return `${p.prompt} ${(p.items as string[]).join(" ")}`;
  return `${p.q} ${p.a}`;
}

export interface GenerateStats {
  created: number;
  rejected: number;
}

/** Writes up to `limit` materials for one topic, each tied to its fields and to verified quotes. */
export async function generateForTopic(db: Db, ctx: PipelineContext, topicId: string, limit: number, runId: string | null = null): Promise<GenerateStats> {
  const topic = db.get<{ id: string; name: string; subject_id: string }>("SELECT id, name, subject_id FROM topic WHERE id = ?", topicId);
  if (!topic || limit <= 0) return { created: 0, rejected: 0 };
  const subject = db.get<{ name: string; learn_article_numbers: number }>("SELECT name, learn_article_numbers FROM subject WHERE id = ?", topic.subject_id)!;
  const fields = db.all<FieldRow>("SELECT id, topic_id, field_type, content_json FROM topic_field WHERE topic_id = ? AND status = 'active' ORDER BY ord", topicId);
  if (!fields.length) return { created: 0, rejected: 0 };

  // Related topics to tell apart (for "Czym różni się…").
  const related = db.all<{ id: string; name: string }>(
    `SELECT t.id, t.name FROM topic_relation r JOIN topic t ON t.id = CASE WHEN r.from_topic = ? THEN r.to_topic ELSE r.from_topic END
     WHERE (r.from_topic = ? OR r.to_topic = ?) AND r.type = 'distinguish' LIMIT 2`,
    topicId,
    topicId,
    topicId,
  );
  const relatedFields = related.flatMap((t) =>
    db.all<FieldRow>("SELECT id, topic_id, field_type, content_json FROM topic_field WHERE topic_id = ? AND status = 'active' ORDER BY ord LIMIT 4", t.id),
  );

  const allFields = [...fields, ...relatedFields];
  const fieldLabel = new Map<string, string>();
  const labelField = new Map<string, FieldRow>();
  allFields.forEach((f, i) => {
    fieldLabel.set(f.id, `F${i + 1}`);
    labelField.set(`F${i + 1}`, f);
  });
  const chunkIds: string[] = [];
  const fieldChunk = new Map<string, string>();
  for (const f of allFields) {
    const c = db.get<{ chunk_id: string }>("SELECT chunk_id FROM citation WHERE owner_type = 'topic_field' AND owner_id = ? LIMIT 1", f.id);
    if (!c) continue;
    fieldChunk.set(f.id, c.chunk_id);
    if (!chunkIds.includes(c.chunk_id) && chunkIds.length < 5) chunkIds.push(c.chunk_id);
  }
  const chunks = chunkIds.map((id) => getChunk(db, id)!).filter(Boolean);
  const chunkLabel = new Map(chunks.map((c, i) => [`C${i + 1}`, c]));
  const labelOfChunk = new Map(chunks.map((c, i) => [c.id, `C${i + 1}`]));

  // Already made for this topic, plus "Czym różni się…" made from the other side of a pair.
  const existing = db
    .all<{ type: MaterialType; payload_json: string }>(
      `SELECT type, payload_json FROM material WHERE topic_id = ?
       ${related.length ? `UNION ALL SELECT type, payload_json FROM material WHERE type = 'distinction' AND topic_id IN (${related.map(() => "?").join(", ")})` : ""}`,
      topicId,
      ...related.map((t) => t.id),
    )
    .map((m) => materialText(m.type, JSON.parse(m.payload_json)));

  const describe = (f: FieldRow) => {
    const c = JSON.parse(f.content_json);
    const kind = f.field_type === "definition" && c.kind !== "none" ? ` (${c.kind === "legal" ? "legalna" : "doktrynalna"})` : "";
    const src = fieldChunk.get(f.id) ? ` [${labelOfChunk.get(fieldChunk.get(f.id)!) ?? "?"}]` : "";
    return `[${fieldLabel.get(f.id)}] ${FIELD_LABEL[f.field_type]}${kind}: ${c.text}${src}${c.quote ? `\n    cytat: "${c.quote}"` : ""}`;
  };
  const user = [
    `Przedmiot: ${subject.name}`,
    `Zagadnienie: ${topic.name}`,
    `Pola zagadnienia:\n${fields.map(describe).join("\n")}`,
    related.length ? `Zagadnienia do odróżnienia:\n${related.map((t) => `${t.name}:\n${relatedFields.filter((f) => f.topic_id === t.id).map(describe).join("\n")}`).join("\n")}` : "",
    `Fragmenty źródeł:\n${chunks.map((c) => `[${labelOfChunk.get(c.id)}] (${DOCUMENT_KIND_LABEL[c.documentKind]} „${c.documentTitle}”${c.pageFrom ? `, s. ${c.pageFrom}` : ""})\n"""\n${c.text.slice(0, 2500)}\n"""`).join("\n\n")}`,
    existing.length ? `Istniejące materiały (nie powtarzaj):\n${existing.map((e) => `- ${e}`).join("\n")}` : "",
    subject.learn_article_numbers ? "Typ provision jest dozwolony." : "Nie twórz materiałów typu provision.",
    `Utwórz najwyżej ${limit} materiałów. W "field_ids" podaj etykiety pól (np. F1), w "citations" etykiety fragmentów (np. C1).`,
  ]
    .filter(Boolean)
    .join("\n\n");

  const out = await callAi<{ materials: GeneratedMaterial[]; suggestions: string[] }>(db, ctx, "generate-materials", user, GENERATE_SCHEMA);
  const seen = new Set(existing.map(normalizeForMatch));
  let created = 0;
  let rejected = 0;
  const now = nowIso();
  const prompt = ctx.prompts["generate-materials"]!;

  db.tx(() => {
    for (const m of (out?.materials ?? []).slice(0, limit + 2)) {
      if (created >= limit) break;
      const type = m.type as MaterialType;
      if (!GENERATED_TYPES.includes(m.type) || (type === "provision" && !subject.learn_article_numbers)) {
        rejected++;
        continue;
      }
      const payload =
        type === "cloze"
          ? { text: m.cloze_text?.trim() }
          : type === "list"
            ? { prompt: m.list_prompt?.trim(), items: (m.list_items ?? []).map((s) => s.trim()).filter(Boolean) }
            : { q: m.question?.trim(), a: m.answer?.trim() };
      const text = materialText(type, payload);
      const reject = (reason: string) => {
        rejected++;
        addSuggestion(db, topic.subject_id, "rejected_material", `${topic.name}: „${text.slice(0, 200)}” (${reason})`, topicId);
      };
      try {
        const warnings = checkMaterial(type, payload);
        if (warnings.length) {
          reject(warnings.join(" "));
          continue;
        }
      } catch (e) {
        rejected++;
        continue;
      }
      if (seen.has(normalizeForMatch(text))) continue;

      // Every quote must be found in the fragment it points to.
      const cites: { chunkId: string; quote: string; start: number; end: number }[] = [];
      for (const c of m.citations ?? []) {
        // A wrong fragment label is common with small models: then look in every fragment given.
        const named = chunkLabel.get(String(c.chunk_id).trim()) ?? chunks.find((x) => x.id === c.chunk_id);
        for (const chunk of named ? [named, ...chunks.filter((x) => x !== named)] : chunks) {
          const loc = locateQuote(c.quote ?? "", chunk.text);
          if (loc) {
            cites.push({ chunkId: chunk.id, quote: loc.text, start: loc.start, end: loc.end });
            break;
          }
        }
      }
      if (!cites.length) {
        // The sentence that backs the card's answer…
        for (const chunk of chunks) {
          const loc = supportingPassage(text, chunk.text);
          if (loc) {
            cites.push({ chunkId: chunk.id, quote: loc.text, start: loc.start, end: loc.end });
            break;
          }
        }
      }
      if (!cites.length) {
        // …or the already verified quotes of the fields the card was made from.
        for (const label of m.field_ids ?? []) {
          const f = labelField.get(String(label).trim());
          if (!f) continue;
          const c = db.get<{ chunk_id: string; quote: string; char_start: number | null; char_end: number | null }>(
            "SELECT chunk_id, quote, char_start, char_end FROM citation WHERE owner_type = 'topic_field' AND owner_id = ? AND verified = 1 LIMIT 1",
            f.id,
          );
          if (c && chunks.some((x) => x.id === c.chunk_id)) cites.push({ chunkId: c.chunk_id, quote: c.quote, start: c.char_start ?? 0, end: c.char_end ?? 0 });
        }
      }
      if (!cites.length) {
        reject("nie znaleziono w źródle zdania, które to potwierdza");
        continue;
      }
      // Numbers and article numbers only from the cited fragments.
      const sourceText = [...new Set(cites.map((c) => c.chunkId))].map((id) => chunks.find((c) => c.id === id)!.text).join("\n");
      const bad = unsupportedFacts(text, sourceText);
      if (bad.length) {
        reject(`${bad.join(", ")} – tego nie ma w cytowanym źródle`);
        continue;
      }

      const id = newId();
      db.run(
        "INSERT INTO material (id, topic_id, type, payload_json, status, generation_run_id, prompt_version, created_at, updated_at) VALUES (?, ?, ?, ?, 'pending', ?, ?, ?, ?)",
        id,
        topicId,
        type,
        JSON.stringify(payload),
        runId,
        `${prompt.id}@${prompt.version}`,
        now,
        now,
      );
      for (const c of cites) {
        db.run(
          "INSERT INTO citation (id, owner_type, owner_id, chunk_id, quote, char_start, char_end, verified, updated_at) VALUES (?, 'material', ?, ?, ?, ?, ?, 1, ?)",
          newId(),
          id,
          c.chunkId,
          c.quote,
          c.start,
          c.end,
          now,
        );
      }
      for (const label of m.field_ids ?? []) {
        const f = labelField.get(String(label).trim());
        if (f) db.run("INSERT OR IGNORE INTO material_field (material_id, topic_field_id) VALUES (?, ?)", id, f.id);
      }
      seen.add(normalizeForMatch(text));
      created++;
    }
    for (const s of out?.suggestions ?? []) addSuggestion(db, topic.subject_id, "gap", `${topic.name}: ${s}`, topicId);
    db.run(
      "INSERT INTO topic_generation (topic_id, fields_hash, generated_at) VALUES (?, ?, ?) ON CONFLICT(topic_id) DO UPDATE SET fields_hash = excluded.fields_hash, generated_at = excluded.generated_at",
      topicId,
      fieldsHash(db, topicId),
      now,
    );
  });
  // The synthesis card is made from verified fields, without the model.
  ensureSynthesis(db, topicId);
  return { created, rejected };
}

function fieldsHash(db: Db, topicId: string): string {
  return db
    .all<{ id: string }>("SELECT id FROM topic_field WHERE topic_id = ? AND status = 'active' ORDER BY id", topicId)
    .map((r) => r.id)
    .join(",");
}

/** Topics from a document whose fields have no materials yet (or changed), most important first. */
export function topicsToGenerate(db: Db, documentId: string): string[] {
  const doc = db.get<{ kind: DocumentKind }>("SELECT kind FROM source_document WHERE id = ?", documentId);
  if (!doc) return [];
  const rows = db.all<{ id: string; exam_weight: number; emphasis: number }>(
    `SELECT DISTINCT t.id, t.exam_weight, t.emphasis FROM topic t
     JOIN topic_field f ON f.topic_id = t.id AND f.status = 'active'
     JOIN citation c ON c.owner_type = 'topic_field' AND c.owner_id = f.id
     JOIN source_chunk ch ON ch.id = c.chunk_id
     WHERE ch.document_id = ? ORDER BY t.exam_weight DESC, t.emphasis DESC`,
    documentId,
  );
  return rows
    .filter((t) => doc.kind === "note" || t.exam_weight >= 0.5)
    .filter((t) => db.get<{ fields_hash: string }>("SELECT fields_hash FROM topic_generation WHERE topic_id = ?", t.id)?.fields_hash !== fieldsHash(db, t.id))
    .map((t) => t.id);
}

// ---------- job queue ----------

export interface Job {
  id: string;
  subjectId: string;
  kind: "extract" | "generate";
  documentId: string | null;
  topicIds: string[] | null;
  status: "queued" | "running" | "paused" | "done" | "error";
  done: number;
  total: number;
  error: string | null;
  label: string;
  createdAt: string;
}

export function enqueueDocument(db: Db, documentId: string): string {
  const doc = db.get<{ subject_id: string }>("SELECT subject_id FROM source_document WHERE id = ?", documentId);
  if (!doc) throw new Error("Nie ma takiego dokumentu.");
  const open = db.get<{ id: string }>("SELECT id FROM job WHERE document_id = ? AND kind = 'extract' AND status IN ('queued', 'running', 'paused', 'error')", documentId);
  if (open) {
    db.run("UPDATE job SET status = 'queued', error = NULL, updated_at = ? WHERE id = ?", nowIso(), open.id);
    return open.id;
  }
  const id = newId();
  const now = nowIso();
  db.run("INSERT INTO job (id, subject_id, kind, document_id, status, created_at, updated_at) VALUES (?, ?, 'extract', ?, 'queued', ?, ?)", id, doc.subject_id, documentId, now, now);
  return id;
}

/** (Re)generate materials for chosen topics, e.g. after a conflict is resolved. */
export function enqueueGeneration(db: Db, subjectId: string, topicIds: string[]): string {
  const id = newId();
  const now = nowIso();
  db.run("INSERT INTO job (id, subject_id, kind, topic_ids_json, status, created_at, updated_at) VALUES (?, ?, 'generate', ?, 'queued', ?, ?)", id, subjectId, JSON.stringify(topicIds), now, now);
  return id;
}

export function listJobs(db: Db, opts: { activeOnly?: boolean } = {}): Job[] {
  return db
    .all(
      `SELECT j.*, d.title AS doc_title FROM job j LEFT JOIN source_document d ON d.id = j.document_id
       ${opts.activeOnly ? "WHERE j.status != 'done'" : ""} ORDER BY j.created_at`,
    )
    .map((r) => ({
      id: r.id,
      subjectId: r.subject_id,
      kind: r.kind,
      documentId: r.document_id,
      topicIds: r.topic_ids_json ? JSON.parse(r.topic_ids_json) : null,
      status: r.status,
      done: r.done,
      total: r.total,
      error: r.error,
      label: `${r.kind === "extract" ? "Analiza" : "Materiały"}: ${r.doc_title ?? "wybrane zagadnienia"}`,
      createdAt: r.created_at,
    }));
}

/** After the app was closed mid-run: jobs left "running" go back to the queue. */
export function recoverJobs(db: Db): void {
  db.run("UPDATE job SET status = 'queued', updated_at = ? WHERE status = 'running'", nowIso());
}

export function retryJobs(db: Db): void {
  db.run("UPDATE job SET status = 'queued', error = NULL, updated_at = ? WHERE status IN ('paused', 'error')", nowIso());
}

export interface RunResult {
  jobsDone: number;
  stoppedBy: "empty" | "paused" | "error";
  error?: string;
}

/**
 * Works through the queue one job at a time. Progress is saved after every
 * fragment and topic, so pausing, closing the app or a crash loses at most
 * the one in flight.
 */
export async function runQueue(db: Db, ctx: PipelineContext): Promise<RunResult> {
  let jobsDone = 0;
  for (;;) {
    const job = db.get<{ id: string; kind: string; subject_id: string; document_id: string | null; topic_ids_json: string | null; done: number }>(
      "SELECT * FROM job WHERE status = 'queued' ORDER BY created_at LIMIT 1",
    );
    if (!job) return { jobsDone, stoppedBy: "empty" };
    const setJob = (status: string, extra: { done?: number; total?: number; error?: string | null } = {}) =>
      db.run(
        "UPDATE job SET status = ?, done = COALESCE(?, done), total = COALESCE(?, total), error = ?, updated_at = ? WHERE id = ?",
        status,
        extra.done ?? null,
        extra.total ?? null,
        extra.error ?? null,
        nowIso(),
        job.id,
      );
    setJob("running");
    const label = listJobs(db).find((j) => j.id === job.id)?.label ?? "";
    try {
      if (job.kind === "extract") {
        const docId = job.document_id!;
        const doc = db.get<{ kind: DocumentKind }>("SELECT kind FROM source_document WHERE id = ?", docId);
        if (!doc) {
          setJob("done");
          continue;
        }
        const total = db.get<{ n: number }>("SELECT COUNT(*) AS n FROM source_chunk WHERE document_id = ? AND ord < 100000", docId)!.n;
        if (doc.kind === "exam_list" || doc.kind === "syllabus") {
          processTopicList(db, docId);
        } else {
          for (;;) {
            if (ctx.signal?.aborted) {
              setJob("paused");
              return { jobsDone, stoppedBy: "paused" };
            }
            const next = db.get<{ id: string }>("SELECT id FROM source_chunk WHERE document_id = ? AND processed_at IS NULL AND ord < 100000 ORDER BY ord LIMIT 1", docId);
            if (!next) break;
            await processChunkTolerant(db, ctx, next.id, job.subject_id);
            const done = total - db.get<{ n: number }>("SELECT COUNT(*) AS n FROM source_chunk WHERE document_id = ? AND processed_at IS NULL AND ord < 100000", docId)!.n;
            setJob("running", { done, total });
            ctx.onProgress?.({ jobId: job.id, kind: "extract", done, total, label });
          }
        }
        recomputeWeights(db, job.subject_id);
        setJob("done", { done: total, total });
        if (doc.kind !== "exam_list" && doc.kind !== "syllabus") {
          const gen = newId();
          const now = nowIso();
          db.run("INSERT INTO job (id, subject_id, kind, document_id, status, created_at, updated_at) VALUES (?, ?, 'generate', ?, 'queued', ?, ?)", gen, job.subject_id, docId, now, now);
        }
      } else {
        const topics: string[] = job.topic_ids_json ? JSON.parse(job.topic_ids_json) : topicsToGenerate(db, job.document_id!);
        let budget = getSettings(db).maxNewPerLecture;
        // Materials already made in this job (when resuming) count against the budget.
        budget -= db.get<{ n: number }>("SELECT COUNT(*) AS n FROM material WHERE generation_run_id = ?", job.id)!.n;
        const total = topics.length;
        for (let i = job.done; i < topics.length && budget > 0; i++) {
          if (ctx.signal?.aborted) {
            setJob("paused");
            return { jobsDone, stoppedBy: "paused" };
          }
          // Enough cards to cover every element of the topic (one thing per card), within the lecture's budget.
          const fields = db.get<{ n: number }>("SELECT COUNT(*) AS n FROM topic_field WHERE topic_id = ? AND status = 'active'", topics[i]!)!.n;
          const r = await generateForTopic(db, ctx, topics[i]!, Math.min(budget, Math.min(10, Math.max(4, fields))), job.id);
          budget -= r.created;
          setJob("running", { done: i + 1, total });
          ctx.onProgress?.({ jobId: job.id, kind: "generate", done: i + 1, total, label });
        }
        setJob("done", { done: total, total });
      }
      jobsDone++;
    } catch (e) {
      if (isAbort(e) || ctx.signal?.aborted) {
        setJob("paused");
        return { jobsDone, stoppedBy: "paused" };
      }
      const msg = e instanceof Error ? e.message : String(e);
      setJob("error", { error: msg });
      return { jobsDone, stoppedBy: "error", error: msg };
    }
  }
}

// ---------- model comparison ----------

export interface BenchRow {
  model: string;
  chunks: number;
  seconds: number;
  validJson: number;
  topics: number;
  fields: number;
  rejected: number;
  /** Share of extracted fields that passed the quote and fact checks. */
  verifiedShare: number;
  error?: string;
}

/** Runs extraction on the first fragments of a document with each model, without saving anything. */
export async function benchmarkModels(db: Db, ctx: PipelineContext, models: string[], documentId: string, maxChunks = 3): Promise<BenchRow[]> {
  const base = getSettings(db).ai;
  const chunks = db.all<{ id: string; text: string }>("SELECT id, text FROM source_chunk WHERE document_id = ? AND ord < 100000 ORDER BY ord LIMIT ?", documentId, maxChunks);
  const rows: BenchRow[] = [];
  for (const model of models) {
    const row: BenchRow = { model, chunks: 0, seconds: 0, validJson: 0, topics: 0, fields: 0, rejected: 0, verifiedShare: 0 };
    const started = Date.now();
    for (const c of chunks) {
      if (ctx.signal?.aborted) break;
      try {
        const out = await callAi<ExtractOutput>(db, { ...ctx, ai: { ...base, model }, useCache: false }, "extract-topics", extractMessage(db, c.id).user, EXTRACT_SCHEMA);
        row.validJson++;
        const v = validateExtraction(out, c.text);
        row.topics += v.topics.length;
        row.fields += v.topics.reduce((s, t) => s + t.fields.length, 0);
        row.rejected += v.rejected.length;
      } catch (e) {
        row.error = e instanceof Error ? e.message : String(e);
      }
      row.chunks++;
    }
    row.seconds = Math.round((Date.now() - started) / 100) / 10;
    row.verifiedShare = row.fields + row.rejected ? row.fields / (row.fields + row.rejected) : 0;
    rows.push(row);
  }
  return rows;
}

// ---------- search over sources ----------

/** BM25 search in one subject's fragments (for the source viewer and later for RAG). */
export function searchChunks(db: Db, subjectId: string, query: string, k = 5): { id: string; score: number }[] {
  const docs = db.all<{ id: string; text: string }>(
    "SELECT c.id, c.text FROM source_chunk c JOIN source_document d ON d.id = c.document_id WHERE d.subject_id = ? AND c.ord < 100000",
    subjectId,
  );
  return new SearchIndex(docs).search(query, k);
}

export const sourceRank = (kind: DocumentKind) => SOURCE_RANK[kind];
