// Spaced repetition (FSRS) and the daily session planner.
//
// - Every active material has review items (one per cloze gap, else one).
// - The session fits the daily time budget. Overdue items are taken by
//   priority (exam weight × chance of having forgotten × exam proximity); the
//   rest wait for the next days, so a break never dumps hundreds of cards at once.
// - New materials come only when there is no backlog.
// - Siblings (gaps of one cloze) are not shown on the same day.
import { type Card, type FSRS, fsrs, type Grade, Rating, State } from "ts-fsrs";
import { type Db, newId } from "./db";
import { type MaterialType, SESSION_TYPES, subKeys } from "./materials";
import { getSettings } from "./settings";

/** A study day ends at 4:00 local time, so a late evening session still counts as "today". */
export const DAY_START_HOUR = 4;

export function studyDayStart(now: Date): Date {
  const d = new Date(now);
  d.setHours(DAY_START_HOUR, 0, 0, 0);
  if (now < d) d.setDate(d.getDate() - 1);
  return d;
}
export function studyDayEnd(now: Date): Date {
  const d = studyDayStart(now);
  d.setDate(d.getDate() + 1);
  return d;
}

const MAINTENANCE_RETENTION = 0.8;
/** Answers longer than this (phone left on the table) count as this long. */
const MAX_ANSWER_MS = 120_000;
/** A card due again within this time comes back in the same session. */
const REQUEUE_WITHIN_MS = 20 * 60_000;
/** New cards cost more: first look plus likely relearning steps. */
const NEW_COST_FACTOR = 1.6;
const DEFAULT_SECONDS: Record<string, number> = { qa: 12, cloze: 12, list: 35, provision: 12, distinction: 20, why: 18 };

const schedulers = new Map<number, FSRS>();
function scheduler(retention: number): FSRS {
  const key = Math.round(retention * 1000) / 1000;
  let f = schedulers.get(key);
  if (!f) {
    f = fsrs({ request_retention: key, enable_fuzz: true });
    schedulers.set(key, f);
  }
  return f;
}

// ---------- rows ↔ cards ----------

interface ItemRow {
  id: string;
  material_id: string;
  sub_key: string;
  due: string;
  stability: number;
  difficulty: number;
  elapsed_days: number;
  scheduled_days: number;
  learning_steps: number;
  reps: number;
  lapses: number;
  state: number;
  last_review: string | null;
}

function toCard(r: ItemRow): Card {
  return {
    due: new Date(r.due),
    stability: r.stability,
    difficulty: r.difficulty,
    elapsed_days: r.elapsed_days,
    scheduled_days: r.scheduled_days,
    learning_steps: r.learning_steps,
    reps: r.reps,
    lapses: r.lapses,
    state: r.state as State,
    ...(r.last_review ? { last_review: new Date(r.last_review) } : {}),
  };
}

const CARD_COLS = "due, stability, difficulty, elapsed_days, scheduled_days, learning_steps, reps, lapses, state, last_review";

function cardValues(c: Card): (string | number | null)[] {
  return [
    c.due.toISOString(),
    c.stability,
    c.difficulty,
    c.elapsed_days,
    c.scheduled_days,
    c.learning_steps,
    c.reps,
    c.lapses,
    c.state,
    c.last_review ? c.last_review.toISOString() : null,
  ];
}

function retentionFor(globalRetention: number, subject: { status: string; target_retention: number | null }): number {
  if (subject.status === "maintenance") return Math.min(subject.target_retention ?? MAINTENANCE_RETENTION, MAINTENANCE_RETENTION);
  return subject.target_retention ?? globalRetention;
}

// ---------- review items ----------

/** Creates missing review items for active materials and removes items of gaps that no longer exist. */
export function syncReviewItems(db: Db, now = new Date()): { created: number; removed: number } {
  const materials = db.all<{ id: string; type: MaterialType; payload_json: string }>(
    `SELECT m.id, m.type, m.payload_json FROM material m
     JOIN topic t ON t.id = m.topic_id JOIN subject s ON s.id = t.subject_id
     WHERE m.status = 'active' AND s.status != 'archived'
       AND m.type IN (${SESSION_TYPES.map(() => "?").join(", ")})`,
    ...SESSION_TYPES,
  );
  const existing = new Map<string, Set<string>>();
  for (const r of db.all<{ material_id: string; sub_key: string }>("SELECT material_id, sub_key FROM review_item")) {
    if (!existing.has(r.material_id)) existing.set(r.material_id, new Set());
    existing.get(r.material_id)!.add(r.sub_key);
  }
  let created = 0;
  let removed = 0;
  const stamp = now.toISOString();
  db.tx(() => {
    for (const m of materials) {
      let keys: string[];
      try {
        keys = subKeys(m.type, JSON.parse(m.payload_json));
      } catch {
        continue;
      }
      const have = existing.get(m.id) ?? new Set<string>();
      for (const k of keys) {
        if (have.has(k)) continue;
        db.run("INSERT INTO review_item (id, material_id, sub_key, due, updated_at) VALUES (?, ?, ?, ?, ?)", newId(), m.id, k, stamp, stamp);
        created++;
      }
      for (const k of have) {
        if (keys.includes(k)) continue;
        removed += db.run("DELETE FROM review_item WHERE material_id = ? AND sub_key = ?", m.id, k);
      }
    }
  });
  return { created, removed };
}

// ---------- planning ----------

export interface PlannedCard {
  itemId: string;
  materialId: string;
  subKey: string;
  type: MaterialType;
  payload: any;
  topicId: string;
  topicName: string;
  subjectId: string;
  subjectName: string;
  isNew: boolean;
  estSeconds: number;
  priority: number;
  /** The part of the topic this card practises (definition, premises…), null for cards without one. */
  slot: string | null;
}

export interface SessionPlan {
  cards: PlannedCard[];
  /** Time left today within the daily limit. */
  budgetSeconds: number;
  estSeconds: number;
  studiedTodaySeconds: number;
  /** Items due today (one per material). */
  dueTotal: number;
  dueIncluded: number;
  newIncluded: number;
  /** Due items that did not fit today; they come first in the next days. */
  deferred: number;
  /** Days needed to clear the backlog at the daily limit (0 = no backlog). */
  backlogDays: number;
  /** New materials are held back while there is a backlog. */
  newPaused: boolean;
  newAvailable: number;
}

export interface PlanOptions {
  /** Only this subject (subject mode). */
  subjectId?: string;
  /** Only materials from this document (the test right after a lecture). */
  documentId?: string;
  /** Ignore the daily limit already used (extra session on demand). */
  ignoreStudiedToday?: boolean;
  /** Time for this session instead of the daily limit. */
  budgetSeconds?: number;
  /** New materials allowed in this session instead of the daily number. */
  newLimit?: number;
  /** Only this topic (the short lesson). */
  topicId?: string;
  /** Keep the order of the topic's schema instead of mixing (the first pass after a lesson). */
  slotOrder?: boolean;
}

/** Order of the parts of a topic; kept here (not imported) to avoid a cycle with topics.ts. */
const PART_ORDER = ["definition", "basis", "premise", "element", "effect", "exception", "deadline", "case_law", "doctrine", "ratio"];

interface CandidateRow extends ItemRow {
  type: MaterialType;
  payload_json: string;
  material_created_at: string;
  topic_id: string;
  topic_name: string;
  exam_weight: number;
  exam_weight_override: number | null;
  subject_id: string;
  subject_name: string;
  subject_status: string;
  target_retention: number | null;
  daily_new_limit: number | null;
}

/** Seconds an answer of each type usually takes, from the recent history (median). */
export function typicalSeconds(db: Db): Record<string, number> {
  const out = { ...DEFAULT_SECONDS };
  const rows = db.all<{ type: string; d: number }>(
    `SELECT m.type, l.duration_ms AS d FROM review_log l
     JOIN review_item i ON i.id = l.review_item_id JOIN material m ON m.id = i.material_id
     WHERE l.duration_ms IS NOT NULL ORDER BY l.ts DESC LIMIT 1000`,
  );
  const by = new Map<string, number[]>();
  for (const r of rows) {
    if (!by.has(r.type)) by.set(r.type, []);
    by.get(r.type)!.push(Math.min(r.d, MAX_ANSWER_MS) / 1000);
  }
  for (const [type, xs] of by) {
    if (xs.length < 10) continue;
    xs.sort((a, b) => a - b);
    out[type] = Math.max(4, xs[Math.floor(xs.length / 2)]!);
  }
  return out;
}

export function studiedSecondsSince(db: Db, since: Date): number {
  const r = db.get<{ ms: number | null }>(
    `SELECT SUM(MIN(COALESCE(duration_ms, 0), ${MAX_ANSWER_MS})) AS ms FROM review_log WHERE ts >= ?`,
    since.toISOString(),
  );
  return Math.round((r?.ms ?? 0) / 1000);
}

/** Days to the nearest coming exam of each subject. */
function daysToExam(db: Db, now: Date): Map<string, number> {
  const today = studyDayStart(now);
  const out = new Map<string, number>();
  for (const r of db.all<{ subject_id: string; date: string }>("SELECT subject_id, MIN(date) AS date FROM exam WHERE date >= ? GROUP BY subject_id", localDate(today))) {
    out.set(r.subject_id, Math.round((Date.parse(`${r.date}T00:00:00`) - Date.parse(`${localDate(today)}T00:00:00`)) / 86_400_000));
  }
  return out;
}

function localDate(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/** 1 far from the exam, up to 2.5 in the last days before it. */
function examUrgency(days: number | undefined): number {
  if (days === undefined) return 1;
  return 1 + 1.5 * Math.exp(-Math.max(0, days) / 14);
}

export function planSession(db: Db, now = new Date(), opts: PlanOptions = {}): SessionPlan {
  syncReviewItems(db, now);
  const settings = getSettings(db);
  const dayStart = studyDayStart(now);
  const dayEnd = studyDayEnd(now);
  const studiedTodaySeconds = studiedSecondsSince(db, dayStart);
  const fullBudget = settings.dailyMinutes * 60;
  const budgetSeconds = opts.budgetSeconds ?? Math.max(0, fullBudget - (opts.ignoreStudiedToday ? 0 : studiedTodaySeconds));
  const typical = typicalSeconds(db);
  const examDays = daysToExam(db, now);
  const nowIso = now.toISOString();

  const rows = db.all<CandidateRow>(
    `SELECT i.*, m.type, m.payload_json, m.created_at AS material_created_at,
            t.id AS topic_id, t.name AS topic_name, t.exam_weight, t.exam_weight_override,
            s.id AS subject_id, s.name AS subject_name, s.status AS subject_status, s.target_retention, s.daily_new_limit
     FROM review_item i
     JOIN material m ON m.id = i.material_id
     JOIN topic t ON t.id = m.topic_id
     JOIN subject s ON s.id = t.subject_id
     WHERE m.status = 'active' AND s.status != 'archived' AND i.suspended = 0
       AND (i.buried_until IS NULL OR i.buried_until <= ?)
       AND m.type IN (${SESSION_TYPES.map(() => "?").join(", ")})
       ${opts.subjectId ? "AND s.id = ?" : ""}
       ${opts.topicId ? "AND t.id = ?" : ""}
       ${opts.documentId ? "AND m.id IN (SELECT ci.owner_id FROM citation ci JOIN source_chunk ch ON ch.id = ci.chunk_id WHERE ci.owner_type = 'material' AND ch.document_id = ?)" : ""}`,
    nowIso,
    ...SESSION_TYPES,
    ...(opts.subjectId ? [opts.subjectId] : []),
    ...(opts.topicId ? [opts.topicId] : []),
    ...(opts.documentId ? [opts.documentId] : []),
  );

  // The part of the topic of each material: the earliest part among its fields.
  const slotOf = new Map<string, string>();
  for (const r of db.all<{ material_id: string; field_type: string }>(
    "SELECT mf.material_id, f.field_type FROM material_field mf JOIN topic_field f ON f.id = mf.topic_field_id",
  )) {
    const prev = slotOf.get(r.material_id);
    if (!prev || PART_ORDER.indexOf(r.field_type) < PART_ORDER.indexOf(prev)) slotOf.set(r.material_id, r.field_type);
  }
  // "Odtwórz schemat" waits until every other card of its topic has been answered at least once.
  const synthesisReady = (topicId: string) =>
    !db.get(
      `SELECT 1 FROM material m WHERE m.topic_id = ? AND m.status = 'active' AND COALESCE(json_extract(m.payload_json, '$.synthesis'), 0) = 0
       AND NOT EXISTS (SELECT 1 FROM review_item i WHERE i.material_id = m.id AND i.reps > 0)`,
      topicId,
    );

  const toPlanned = (r: CandidateRow, priority: number): PlannedCard => {
    const isNew = r.state === State.New;
    const base = typical[r.type] ?? 15;
    return {
      itemId: r.id,
      materialId: r.material_id,
      subKey: r.sub_key,
      type: r.type,
      payload: JSON.parse(r.payload_json),
      topicId: r.topic_id,
      topicName: r.topic_name,
      subjectId: r.subject_id,
      subjectName: r.subject_name,
      isNew,
      estSeconds: Math.round(isNew ? base * NEW_COST_FACTOR : base),
      priority,
      slot: slotOf.get(r.material_id) ?? null,
    };
  };

  // Due items: the best one per material.
  const dueByMaterial = new Map<string, PlannedCard>();
  for (const r of rows) {
    if (r.state === State.New || r.due > dayEnd.toISOString()) continue;
    const f = scheduler(retentionFor(settings.targetRetention, { status: r.subject_status, target_retention: r.target_retention }));
    const recall = f.get_retrievability(toCard(r), now, false);
    const weight = r.exam_weight_override ?? r.exam_weight ?? 0;
    const learning = r.state === State.Learning || r.state === State.Relearning;
    const urgency = r.subject_status === "maintenance" ? 0.5 : examUrgency(examDays.get(r.subject_id));
    // Cards in the middle of (re)learning go first: they are short and losing them wastes the first look.
    const priority = (learning ? 10 : 0) + (1 - recall) * (0.5 + weight) * urgency;
    const prev = dueByMaterial.get(r.material_id);
    if (!prev || priority > prev.priority) dueByMaterial.set(r.material_id, toPlanned(r, priority));
  }
  const due = [...dueByMaterial.values()].sort((a, b) => b.priority - a.priority);

  const reviews: PlannedCard[] = [];
  let used = 0;
  for (const c of due) {
    if (used + c.estSeconds > budgetSeconds) continue;
    reviews.push(c);
    used += c.estSeconds;
  }
  const deferred = due.length - reviews.length;
  const dueSeconds = due.reduce((s, c) => s + c.estSeconds, 0);
  const backlogDays = deferred > 0 ? Math.ceil(dueSeconds / Math.max(60, fullBudget)) : 0;

  // New items: none while there is a backlog; then up to the daily limits and the time left.
  const fresh = new Map<string, CandidateRow>();
  for (const r of rows) {
    if (r.state !== State.New || r.subject_status !== "active") continue;
    if (r.payload_json.includes('"synthesis":true') && !synthesisReady(r.topic_id)) continue;
    // Only the first gap of a new cloze today; the others follow on later days.
    const prev = fresh.get(r.material_id);
    if (!prev || r.sub_key.localeCompare(prev.sub_key, undefined, { numeric: true }) < 0) fresh.set(r.material_id, r);
  }
  const newAvailable = fresh.size;
  const newPaused = deferred > 0 && opts.newLimit === undefined;
  const added: PlannedCard[] = [];
  if (!newPaused) {
    const introduced = introducedSince(db, dayStart);
    let left = opts.newLimit ?? Math.max(0, settings.newPerDay - [...introduced.values()].reduce((a, b) => a + b, 0));
    const perSubjectLeft = new Map<string, number>();
    // Nearest exam first, heavier topics first, then in the order they were made.
    const ordered = [...fresh.values()].sort(
      (a, b) =>
        (examDays.get(a.subject_id) ?? 9999) - (examDays.get(b.subject_id) ?? 9999) ||
        (b.exam_weight_override ?? b.exam_weight) - (a.exam_weight_override ?? a.exam_weight) ||
        a.material_created_at.localeCompare(b.material_created_at),
    );
    const queue = settings.interleaveSubjects ? roundRobin(ordered, (r) => r.subject_id) : ordered;
    for (const r of queue) {
      if (left <= 0) break;
      if (r.daily_new_limit != null && opts.newLimit === undefined) {
        const l = perSubjectLeft.get(r.subject_id) ?? r.daily_new_limit - (introduced.get(r.subject_id) ?? 0);
        if (l <= 0) continue;
        perSubjectLeft.set(r.subject_id, l - 1);
      }
      const c = toPlanned(r, 0);
      if (used + c.estSeconds > budgetSeconds) break;
      added.push(c);
      used += c.estSeconds;
      left--;
    }
  }

  const ordered = opts.slotOrder
    ? [...reviews, ...added].sort(
        (a, b) =>
          (a.payload?.synthesis ? 1 : 0) - (b.payload?.synthesis ? 1 : 0) ||
          (a.slot ? PART_ORDER.indexOf(a.slot) : 99) - (b.slot ? PART_ORDER.indexOf(b.slot) : 99),
      )
    : arrange(reviews, added, settings.interleaveSubjects, examDays);
  return {
    cards: ordered,
    budgetSeconds,
    estSeconds: used,
    studiedTodaySeconds,
    dueTotal: due.length,
    dueIncluded: reviews.length,
    newIncluded: added.length,
    deferred,
    backlogDays,
    newPaused,
    newAvailable,
  };
}

/** New items introduced (first answered) since `since`, per subject. */
function introducedSince(db: Db, since: Date): Map<string, number> {
  const rows = db.all<{ subject_id: string; n: number }>(
    `SELECT t.subject_id, COUNT(*) AS n FROM (
       SELECT review_item_id, MIN(ts) AS first FROM review_log WHERE counted_in_fsrs = 1 GROUP BY review_item_id
     ) f
     JOIN review_item i ON i.id = f.review_item_id JOIN material m ON m.id = i.material_id JOIN topic t ON t.id = m.topic_id
     WHERE f.first >= ? GROUP BY t.subject_id`,
    since.toISOString(),
  );
  return new Map(rows.map((r) => [r.subject_id, r.n]));
}

function roundRobin<T>(xs: T[], key: (x: T) => string): T[] {
  const groups = new Map<string, T[]>();
  for (const x of xs) {
    const k = key(x);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k)!.push(x);
  }
  const lists = [...groups.values()];
  const out: T[] = [];
  for (let i = 0; out.length < xs.length; i++) for (const l of lists) if (l[i] !== undefined) out.push(l[i]!);
  return out;
}

/**
 * Final order: new items spread among reviews (one every few cards), no two
 * cards of the same topic in a row, and subjects either mixed (interleaving)
 * or in blocks by nearest exam.
 */
function arrange(reviews: PlannedCard[], fresh: PlannedCard[], interleave: boolean, examDays: Map<string, number>): PlannedCard[] {
  const merged: PlannedCard[] = [];
  const gap = fresh.length ? Math.max(1, Math.floor(reviews.length / fresh.length)) : 0;
  let r = 0;
  let n = 0;
  while (r < reviews.length || n < fresh.length) {
    for (let k = 0; k < gap && r < reviews.length; k++) merged.push(reviews[r++]!);
    if (n < fresh.length) merged.push(fresh[n++]!);
    if (gap === 0) while (r < reviews.length) merged.push(reviews[r++]!);
  }

  const blocks = interleave
    ? [merged]
    : [...new Set(merged.map((c) => c.subjectId))]
        .sort((a, b) => (examDays.get(a) ?? 9999) - (examDays.get(b) ?? 9999))
        .map((s) => merged.filter((c) => c.subjectId === s));

  return blocks.flatMap((block) => spread(block, interleave));
}

/** Greedy reorder so that neighbours differ in topic (and in subject when mixing). */
function spread(cards: PlannedCard[], bySubject: boolean): PlannedCard[] {
  const pool = [...cards];
  const out: PlannedCard[] = [];
  while (pool.length) {
    const last = out[out.length - 1];
    let idx = pool.findIndex((c) => !last || (c.topicId !== last.topicId && (!bySubject || c.subjectId !== last.subjectId)));
    if (idx < 0) idx = pool.findIndex((c) => !last || c.topicId !== last.topicId);
    if (idx < 0) idx = 0;
    out.push(pool.splice(idx, 1)[0]!);
  }
  return out;
}

/** Chance of recalling an item now (0 for one never studied). */
export function recallOf(row: Pick<ItemRow, "due" | "stability" | "difficulty" | "elapsed_days" | "scheduled_days" | "learning_steps" | "reps" | "lapses" | "state" | "last_review">, at: Date): number {
  if (row.state === State.New || !row.last_review) return 0;
  return scheduler(0.9).get_retrievability(toCard(row as ItemRow), at, false);
}

// ---------- answering ----------

export type Confidence = 1 | 2 | 3;
export const CONFIDENCE_LABEL: Record<Confidence, string> = { 1: "Zgaduję", 2: "Chyba wiem", 3: "Pewnie" };

export interface AnswerInput {
  itemId: string;
  rating: Grade;
  /** Declared before seeing the answer. */
  confidence?: Confidence | null;
  durationMs?: number;
  mode?: string;
  /** Extra detail, e.g. which list items were recalled. */
  answer?: unknown;
  /** false = practice that does not change the schedule (e.g. exam simulation). */
  countInFsrs?: boolean;
  now?: Date;
}

export interface AnswerResult {
  logId: string;
  due: Date;
  state: State;
  /** Due again soon: show it once more in this session. */
  requeue: boolean;
}

function loadItem(db: Db, itemId: string) {
  const row = db.get<ItemRow & { subject_status: string; target_retention: number | null }>(
    `SELECT i.*, s.status AS subject_status, s.target_retention FROM review_item i
     JOIN material m ON m.id = i.material_id JOIN topic t ON t.id = m.topic_id JOIN subject s ON s.id = t.subject_id
     WHERE i.id = ?`,
    itemId,
  );
  if (!row) throw new Error("Nie ma takiej fiszki (mogła zostać usunięta).");
  return row;
}

export function recordAnswer(db: Db, input: AnswerInput): AnswerResult {
  const now = input.now ?? new Date();
  const row = loadItem(db, input.itemId);
  const count = input.countInFsrs ?? true;
  const logId = newId();
  const durationMs = input.durationMs != null ? Math.max(0, Math.round(input.durationMs)) : null;
  let card = toCard(row);

  db.tx(() => {
    if (count) {
      const f = scheduler(retentionFor(getSettings(db).targetRetention, { status: row.subject_status, target_retention: row.target_retention }));
      card = f.next(card, now, input.rating).card;
      db.run(
        `UPDATE review_item SET ${CARD_COLS.split(", ").map((c) => `${c} = ?`).join(", ")}, updated_at = ? WHERE id = ?`,
        ...cardValues(card),
        now.toISOString(),
        row.id,
      );
      // Other gaps of the same cloze wait until tomorrow, so this one does not give them away.
      db.run(
        "UPDATE review_item SET buried_until = ?, updated_at = ? WHERE material_id = ? AND id != ?",
        studyDayEnd(now).toISOString(),
        now.toISOString(),
        row.material_id,
        row.id,
      );
    }
    db.run(
      `INSERT INTO review_log (id, review_item_id, ts, rating, confidence, duration_ms, mode, counted_in_fsrs, answer_text, prev_state_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      logId,
      row.id,
      now.toISOString(),
      input.rating,
      input.confidence ?? null,
      durationMs,
      input.mode ?? "daily",
      count ? 1 : 0,
      input.answer === undefined ? null : JSON.stringify(input.answer),
      count ? JSON.stringify(row) : null,
    );
  });

  const learning = card.state === State.Learning || card.state === State.Relearning;
  return { logId, due: card.due, state: card.state, requeue: count && learning && card.due.getTime() - now.getTime() <= REQUEUE_WITHIN_MS };
}

/** Takes back an answer (a mis-tap): restores the card as it was and deletes the log. */
export function undoAnswer(db: Db, logId: string): void {
  const log = db.get<{ review_item_id: string; prev_state_json: string | null }>("SELECT review_item_id, prev_state_json FROM review_log WHERE id = ?", logId);
  if (!log) throw new Error("Nie ma czego cofnąć.");
  db.tx(() => {
    if (log.prev_state_json) {
      const prev = JSON.parse(log.prev_state_json) as ItemRow & { buried_until: string | null };
      db.run(
        `UPDATE review_item SET ${CARD_COLS.split(", ").map((c) => `${c} = ?`).join(", ")}, updated_at = ? WHERE id = ?`,
        prev.due,
        prev.stability,
        prev.difficulty,
        prev.elapsed_days,
        prev.scheduled_days,
        prev.learning_steps,
        prev.reps,
        prev.lapses,
        prev.state,
        prev.last_review,
        new Date().toISOString(),
        log.review_item_id,
      );
    }
    db.run("DELETE FROM review_log WHERE id = ?", logId);
  });
}

/** When the card would come back for each rating, e.g. { 1: "1 min", 3: "3 dni" }. */
export function previewIntervals(db: Db, itemId: string, now = new Date()): Record<Grade, string> {
  const row = loadItem(db, itemId);
  const f = scheduler(retentionFor(getSettings(db).targetRetention, { status: row.subject_status, target_retention: row.target_retention }));
  const p = f.repeat(toCard(row), now);
  const out = {} as Record<Grade, string>;
  for (const g of [Rating.Again, Rating.Hard, Rating.Good, Rating.Easy] as Grade[]) {
    out[g] = formatInterval(p[g].card.due.getTime() - now.getTime());
  }
  return out;
}

export function formatInterval(ms: number): string {
  const min = Math.max(1, Math.round(ms / 60_000));
  if (min < 60) return `${min} min`;
  const h = Math.round(min / 60);
  if (h < 24) return `${h} h`;
  const d = Math.round(h / 24);
  if (d < 31) return d === 1 ? "1 dzień" : `${d} dni`;
  const mo = Math.round(d / 30.4);
  if (mo < 12) return `${mo} mies.`;
  const y = Math.round((d / 365) * 10) / 10;
  return `${String(y).replace(".", ",")} ${y < 2 ? "rok" : y < 5 ? "lata" : "lat"}`;
}

/** Suggested rating for a list after marking each item as recalled or not. */
export function listRating(recalled: boolean[]): Grade {
  const missed = recalled.filter((x) => !x).length;
  if (missed === 0) return Rating.Good;
  if (missed === 1 && recalled.length >= 4) return Rating.Hard;
  return Rating.Again;
}

// ---------- calibration (metacognition) ----------

export interface CalibrationRow {
  confidence: Confidence;
  answers: number;
  /** Answers rated Good or Easy. */
  correct: number;
}

/** Declared confidence against the actual result, since `since` (optionally one session's logs). */
export function calibration(db: Db, opts: { since?: Date; logIds?: string[] } = {}): CalibrationRow[] {
  const where: string[] = ["confidence IS NOT NULL"];
  const params: string[] = [];
  if (opts.since) {
    where.push("ts >= ?");
    params.push(opts.since.toISOString());
  }
  if (opts.logIds) {
    if (!opts.logIds.length) return [];
    where.push(`id IN (${opts.logIds.map(() => "?").join(", ")})`);
    params.push(...opts.logIds);
  }
  const rows = db.all<{ confidence: Confidence; answers: number; correct: number }>(
    `SELECT confidence, COUNT(*) AS answers, SUM(rating >= 3) AS correct FROM review_log
     WHERE ${where.join(" AND ")} GROUP BY confidence ORDER BY confidence`,
    ...params,
  );
  return rows;
}

export { Rating, State };
export type { Grade };
