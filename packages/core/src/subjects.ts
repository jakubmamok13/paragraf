import { type Db, newId, nowIso } from "./db";

export const EXAM_FORMATS = {
  ustny: "ustny",
  test: "pisemny testowy",
  opisowy: "pisemny opisowy",
  kazusy: "kazusy",
  mieszany: "mieszany",
} as const;
export type ExamFormat = keyof typeof EXAM_FORMATS;

export const EXAM_KINDS = {
  egzamin: "egzamin",
  kolokwium: "kolokwium",
  zaliczenie: "zaliczenie",
} as const;
export type ExamKind = keyof typeof EXAM_KINDS;

export type SubjectStatus = "active" | "maintenance" | "archived";

export interface ExamInput {
  id?: string;
  kind: ExamKind;
  format: ExamFormat;
  /** YYYY-MM-DD or null when not known yet. */
  date: string | null;
  note?: string | null;
}

export interface Exam extends Required<ExamInput> {
  id: string;
  subjectId: string;
}

export interface SubjectInput {
  name: string;
  exams: ExamInput[];
  targetRetention?: number | null;
  dailyNewLimit?: number | null;
}

export interface Subject {
  id: string;
  name: string;
  status: SubjectStatus;
  targetRetention: number | null;
  dailyNewLimit: number | null;
  exams: Exam[];
  /** The nearest exam that has not happened yet, if any. */
  nextExam: Exam | null;
  createdAt: string;
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function validate(input: SubjectInput): void {
  if (!input.name.trim()) throw new Error("Podaj nazwę przedmiotu.");
  for (const e of input.exams) {
    if (!(e.format in EXAM_FORMATS)) throw new Error("Wybierz formę egzaminu.");
    if (!(e.kind in EXAM_KINDS)) throw new Error("Wybierz rodzaj zaliczenia.");
    if (e.date !== null && (!DATE_RE.test(e.date) || Number.isNaN(Date.parse(e.date)))) {
      throw new Error("Nieprawidłowa data egzaminu.");
    }
  }
  const rt = input.targetRetention;
  if (rt != null && (rt < 0.7 || rt > 0.97)) throw new Error("Docelowa retencja musi być między 0,70 a 0,97.");
}

/** Records a deletion so that a package can carry it to the other device. */
export function recordTombstone(db: Db, table: string, id: string): void {
  db.run(
    "INSERT INTO tombstone (table_name, id, deleted_at) VALUES (?, ?, ?) ON CONFLICT DO UPDATE SET deleted_at = excluded.deleted_at",
    table,
    id,
    nowIso(),
  );
}

export function createSubject(db: Db, input: SubjectInput): Subject {
  validate(input);
  const id = newId();
  const now = nowIso();
  db.tx(() => {
    db.run(
      "INSERT INTO subject (id, name, target_retention, daily_new_limit, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
      id,
      input.name.trim(),
      input.targetRetention ?? null,
      input.dailyNewLimit ?? null,
      now,
      now,
    );
    saveExams(db, id, input.exams);
  });
  return getSubject(db, id)!;
}

export function updateSubject(db: Db, id: string, input: SubjectInput): Subject {
  validate(input);
  if (!getSubject(db, id)) throw new Error("Nie ma takiego przedmiotu.");
  db.tx(() => {
    db.run(
      "UPDATE subject SET name = ?, target_retention = ?, daily_new_limit = ?, updated_at = ? WHERE id = ?",
      input.name.trim(),
      input.targetRetention ?? null,
      input.dailyNewLimit ?? null,
      nowIso(),
      id,
    );
    saveExams(db, id, input.exams);
  });
  return getSubject(db, id)!;
}

function saveExams(db: Db, subjectId: string, exams: ExamInput[]): void {
  const now = nowIso();
  const keep = new Set<string>();
  for (const e of exams) {
    const id = e.id ?? newId();
    keep.add(id);
    db.run(
      `INSERT INTO exam (id, subject_id, kind, format, date, note, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET kind = excluded.kind, format = excluded.format, date = excluded.date,
         note = excluded.note, updated_at = excluded.updated_at`,
      id,
      subjectId,
      e.kind,
      e.format,
      e.date,
      e.note?.trim() || null,
      now,
      now,
    );
  }
  for (const { id } of db.all<{ id: string }>("SELECT id FROM exam WHERE subject_id = ?", subjectId)) {
    if (!keep.has(id)) {
      db.run("DELETE FROM exam WHERE id = ?", id);
      recordTombstone(db, "exam", id);
    }
  }
}

/** active → studying; maintenance → after the exam, rare reviews; archived → hidden, data kept. */
export function setSubjectStatus(db: Db, id: string, status: SubjectStatus): void {
  if (db.run("UPDATE subject SET status = ?, updated_at = ? WHERE id = ?", status, nowIso(), id) === 0) {
    throw new Error("Nie ma takiego przedmiotu.");
  }
}

/** Deletes the subject with all its sources, topics, materials and review history. */
export function deleteSubject(db: Db, id: string): void {
  db.tx(() => {
    if (db.run("DELETE FROM subject WHERE id = ?", id) === 0) throw new Error("Nie ma takiego przedmiotu.");
    recordTombstone(db, "subject", id);
  });
}

export interface SubjectStats {
  documents: number;
  topics: number;
  materials: number;
}

export function subjectStats(db: Db, id: string): SubjectStats {
  return {
    documents: db.get<{ n: number }>("SELECT COUNT(*) AS n FROM source_document WHERE subject_id = ?", id)!.n,
    topics: db.get<{ n: number }>("SELECT COUNT(*) AS n FROM topic WHERE subject_id = ?", id)!.n,
    materials: db.get<{ n: number }>(
      "SELECT COUNT(*) AS n FROM material m JOIN topic t ON t.id = m.topic_id WHERE t.subject_id = ? AND m.status = 'active'",
      id,
    )!.n,
  };
}

function toExam(r: any): Exam {
  return { id: r.id, subjectId: r.subject_id, kind: r.kind, format: r.format, date: r.date, note: r.note };
}

export function getSubject(db: Db, id: string, today = localToday()): Subject | undefined {
  const r = db.get("SELECT * FROM subject WHERE id = ?", id);
  if (!r) return undefined;
  const exams = db
    .all("SELECT * FROM exam WHERE subject_id = ? ORDER BY date IS NULL, date, created_at", id)
    .map(toExam);
  return {
    id: r.id,
    name: r.name,
    status: r.status,
    targetRetention: r.target_retention,
    dailyNewLimit: r.daily_new_limit,
    exams,
    nextExam: exams.find((e) => e.date !== null && e.date >= today) ?? null,
    createdAt: r.created_at,
  };
}

export function listSubjects(db: Db, opts: { includeArchived?: boolean; today?: string } = {}): Subject[] {
  const rows = db.all<{ id: string }>(
    `SELECT id FROM subject ${opts.includeArchived ? "" : "WHERE status != 'archived'"} ORDER BY status = 'archived', name COLLATE NOCASE`,
  );
  const subjects = rows.map((r) => getSubject(db, r.id, opts.today)!);
  // Nearest exam first; subjects without a dated exam after them.
  return subjects.sort((a, b) => (a.nextExam?.date ?? "9999").localeCompare(b.nextExam?.date ?? "9999"));
}

/** Today's date (YYYY-MM-DD) in the device's time zone. */
export function localToday(d = new Date()): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/** Whole days from `from` to `to` (both YYYY-MM-DD). */
export function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);
}
