// What you know and what you don't: mastery by subject, section and topic,
// what to learn today, the hardest cards, calibration and exam readiness.
import type { Db } from "./db";
import { MATERIAL_LABEL, type MaterialType } from "./materials";
import { calibration, type CalibrationRow, recallOf, studyDayStart } from "./srs";

interface ItemRow {
  id: string;
  material_id: string;
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
  topic_id: string;
}

export interface TopicMastery {
  id: string;
  name: string;
  /** Average chance of recall now over all its items (never studied = 0). */
  mastery: number;
  items: number;
  learned: number;
  examWeight: number;
  onExamList: boolean;
  /** No material yet (e.g. from the exam list). */
  empty: boolean;
}

export interface SectionMastery {
  id: string | null;
  title: string;
  mastery: number;
  topics: TopicMastery[];
}

export interface SubjectProgress {
  id: string;
  name: string;
  status: string;
  mastery: number;
  items: number;
  learned: number;
  examDate: string | null;
  /** Expected share recalled on the exam day if nothing more is learned (coverage × memory). */
  readiness: number | null;
  sections: SectionMastery[];
}

const avg = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);

function itemsBySubject(db: Db, subjectId: string): ItemRow[] {
  return db.all<ItemRow>(
    `SELECT i.*, m.topic_id FROM review_item i JOIN material m ON m.id = i.material_id JOIN topic t ON t.id = m.topic_id
     WHERE t.subject_id = ? AND m.status = 'active' AND i.suspended = 0`,
    subjectId,
  );
}

export function subjectProgress(db: Db, now = new Date()): SubjectProgress[] {
  const today = localDay(studyDayStart(now));
  return db.all<{ id: string; name: string; status: string }>("SELECT id, name, status FROM subject WHERE status != 'archived' ORDER BY name COLLATE NOCASE").map((s) => {
    const items = itemsBySubject(db, s.id);
    const byTopic = new Map<string, ItemRow[]>();
    for (const it of items) {
      if (!byTopic.has(it.topic_id)) byTopic.set(it.topic_id, []);
      byTopic.get(it.topic_id)!.push(it);
    }
    const topics = db.all<{ id: string; name: string; section_id: string | null; exam_weight: number; exam_weight_override: number | null; on_exam_list: number }>(
      "SELECT id, name, section_id, exam_weight, exam_weight_override, on_exam_list FROM topic WHERE subject_id = ? ORDER BY name COLLATE NOCASE",
      s.id,
    );
    const sections = new Map<string | null, SectionMastery>();
    for (const sec of db.all<{ id: string; title: string }>("SELECT id, title FROM section WHERE subject_id = ? ORDER BY ord", s.id)) {
      sections.set(sec.id, { id: sec.id, title: sec.title, mastery: 0, topics: [] });
    }
    for (const t of topics) {
      const its = byTopic.get(t.id) ?? [];
      const tm: TopicMastery = {
        id: t.id,
        name: t.name,
        mastery: avg(its.map((i) => recallOf(i, now))),
        items: its.length,
        learned: its.filter((i) => i.reps > 0).length,
        examWeight: t.exam_weight_override ?? t.exam_weight,
        onExamList: t.on_exam_list === 2,
        empty: its.length === 0,
      };
      const key = t.section_id && sections.has(t.section_id) ? t.section_id : null;
      if (!sections.has(key)) sections.set(key, { id: null, title: "Bez działu", mastery: 0, topics: [] });
      sections.get(key)!.topics.push(tm);
    }
    const secList = [...sections.values()].filter((x) => x.topics.length);
    for (const sec of secList) {
      const withItems = sec.topics.filter((t) => !t.empty);
      sec.mastery = withItems.length ? avg(withItems.map((t) => t.mastery)) : 0;
    }
    const exam = db.get<{ date: string }>("SELECT MIN(date) AS date FROM exam WHERE subject_id = ? AND date >= ?", s.id, today)?.date ?? null;
    let readiness: number | null = null;
    if (exam && items.length) {
      const at = new Date(`${exam}T09:00:00`);
      readiness = avg(items.map((i) => recallOf(i, at)));
    }
    return {
      id: s.id,
      name: s.name,
      status: s.status,
      mastery: avg(items.map((i) => recallOf(i, now))),
      items: items.length,
      learned: items.filter((i) => i.reps > 0).length,
      examDate: exam,
      readiness,
      sections: secList,
    };
  });
}

export interface FocusTopic {
  subjectName: string;
  topic: TopicMastery;
  /** Why it is on the list. */
  reason: string;
}

/** Topics most worth today's attention: important for the exam and weakly remembered. */
export function todayFocus(progress: SubjectProgress[], limit = 5): FocusTopic[] {
  const all: FocusTopic[] = [];
  for (const s of progress) {
    if (s.status !== "active") continue;
    for (const sec of s.sections) {
      for (const t of sec.topics) {
        if (t.empty && !t.onExamList) continue;
        // Well remembered and nothing new: not today's concern.
        if (!t.empty && t.learned === t.items && t.mastery >= 0.9) continue;
        const reason = t.empty
          ? "na liście egzaminacyjnej, brak materiałów"
          : t.learned < t.items
            ? `nowe materiały: ${t.items - t.learned}`
            : `pamiętasz ok. ${Math.round(t.mastery * 100)}%`;
        all.push({ subjectName: s.name, topic: t, reason });
      }
    }
  }
  return all.sort((a, b) => (0.3 + b.topic.examWeight) * (1 - b.topic.mastery) - (0.3 + a.topic.examWeight) * (1 - a.topic.mastery)).slice(0, limit);
}

export interface HardCard {
  materialId: string;
  label: string;
  text: string;
  topicName: string;
  lapses: number;
  againShare: number;
}

/** Cards you forget most often. */
export function hardestCards(db: Db, limit = 8): HardCard[] {
  return db
    .all(
      `SELECT m.id, m.type, m.payload_json, t.name AS topic_name, MAX(i.lapses) AS lapses,
              (SELECT AVG(l.rating = 1) FROM review_log l JOIN review_item i2 ON i2.id = l.review_item_id WHERE i2.material_id = m.id) AS again_share,
              (SELECT COUNT(*) FROM review_log l JOIN review_item i2 ON i2.id = l.review_item_id WHERE i2.material_id = m.id) AS answers
       FROM material m JOIN review_item i ON i.material_id = m.id JOIN topic t ON t.id = m.topic_id
       WHERE m.status = 'active' GROUP BY m.id HAVING answers >= 3 AND (lapses > 0 OR again_share >= 0.3)
       ORDER BY again_share DESC, lapses DESC LIMIT ?`,
      limit,
    )
    .map((r) => {
      const p = JSON.parse(r.payload_json);
      const text = r.type === "cloze" ? String(p.text).replace(/\{\{c\d+::(.*?)(?:::.*?)?\}\}/g, "[$1]") : r.type === "list" ? p.prompt : p.q;
      return { materialId: r.id, label: MATERIAL_LABEL[r.type as MaterialType], text, topicName: r.topic_name, lapses: r.lapses, againShare: r.again_share };
    });
}

export interface StudyStats {
  /** Days in a row with at least one answer, up to today (or yesterday if not studied yet today). */
  streak: number;
  answersToday: number;
  /** Answers per study day for the last 14 days, oldest first. */
  last14: { day: string; answers: number }[];
  calibration30: CalibrationRow[];
}

function localDay(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

export function studyStats(db: Db, now = new Date()): StudyStats {
  const start = studyDayStart(now);
  const days = new Map<string, number>();
  for (const r of db.all<{ ts: string }>("SELECT ts FROM review_log WHERE ts >= ?", new Date(start.getTime() - 400 * 86_400_000).toISOString())) {
    const d = localDay(studyDayStart(new Date(r.ts)));
    days.set(d, (days.get(d) ?? 0) + 1);
  }
  const dayAt = (k: number) => {
    const d = new Date(start);
    d.setDate(d.getDate() - k);
    return localDay(d);
  };
  let streak = 0;
  for (let k = days.has(dayAt(0)) ? 0 : 1; days.has(dayAt(k)); k++) streak++;
  const last14 = Array.from({ length: 14 }, (_, i) => dayAt(13 - i)).map((day) => ({ day, answers: days.get(day) ?? 0 }));
  return {
    streak,
    answersToday: days.get(dayAt(0)) ?? 0,
    last14,
    calibration30: calibration(db, { since: new Date(now.getTime() - 30 * 86_400_000) }),
  };
}

export interface RecentLecture {
  documentId: string;
  title: string;
  subjectName: string;
  lectureDate: string;
  /** Materials from this note not yet answered even once. */
  fresh: number;
}

/** Notes from today and yesterday whose materials have not been tried yet: for the test right after the lecture. */
export function recentLectures(db: Db, now = new Date()): RecentLecture[] {
  const today = studyDayStart(now);
  const yesterday = new Date(today);
  yesterday.setDate(yesterday.getDate() - 1);
  return db
    .all(
      `SELECT d.id, d.title, d.lecture_date, s.name AS subject_name,
         (SELECT COUNT(DISTINCT m.id) FROM material m
            JOIN citation ci ON ci.owner_type = 'material' AND ci.owner_id = m.id
            JOIN source_chunk ch ON ch.id = ci.chunk_id
            WHERE ch.document_id = d.id AND m.status = 'active'
              AND COALESCE(json_extract(m.payload_json, '$.synthesis'), 0) = 0
              AND NOT EXISTS (SELECT 1 FROM review_item i WHERE i.material_id = m.id AND i.reps > 0)) AS fresh
       FROM source_document d JOIN subject s ON s.id = d.subject_id
       WHERE d.kind = 'note' AND d.lecture_date IN (?, ?) AND s.status = 'active'
       ORDER BY d.lecture_date DESC`,
      localDay(today),
      localDay(yesterday),
    )
    .filter((r) => r.fresh > 0)
    .map((r) => ({ documentId: r.id, title: r.title, subjectName: r.subject_name, lectureDate: r.lecture_date, fresh: r.fresh }));
}
