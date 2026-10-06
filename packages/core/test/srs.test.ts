import initSqlJs, { type SqlJsStatic } from "sql.js";
import { beforeAll, describe, expect, it } from "vitest";
import {
  addManualMaterial,
  calibration,
  checkMaterial,
  clozeKeys,
  createSubject,
  Db,
  formatInterval,
  listRating,
  parseCloze,
  planSession,
  previewIntervals,
  Rating,
  recordAnswer,
  setSubjectStatus,
  State,
  studyDayStart,
  syncReviewItems,
  undoAnswer,
  updateSettings,
} from "../src";

let SQL: SqlJsStatic;
beforeAll(async () => {
  SQL = await initSqlJs();
});
const freshDb = () => new Db(new SQL.Database());
const at = (iso: string) => new Date(iso);
const addDays = (d: Date, n: number) => new Date(d.getTime() + n * 86_400_000);

function subjectWithCards(db: Db, n: number, name = "Prawo cywilne", examDate: string | null = null) {
  const s = createSubject(db, { name, exams: examDate ? [{ kind: "egzamin", format: "ustny", date: examDate }] : [] });
  for (let i = 0; i < n; i++) {
    addManualMaterial(db, { subjectId: s.id, topicName: `Zagadnienie ${i % 25}`, type: "qa", payload: { q: `Pytanie ${i}`, a: `Odpowiedź ${i}` } });
  }
  return s;
}

/** Studies the whole planned session with one rating, taking the estimated time per card. */
function studyDay(db: Db, now: Date, rating: (i: number) => 1 | 2 | 3 | 4 = () => Rating.Good) {
  const plan = planSession(db, now);
  let t = now.getTime();
  plan.cards.forEach((c, i) => {
    recordAnswer(db, { itemId: c.itemId, rating: rating(i), confidence: 2, durationMs: c.estSeconds * 1000, now: new Date(t) });
    t += c.estSeconds * 1000;
  });
  return plan;
}

describe("materials", () => {
  it("parses cloze gaps with hints", () => {
    const text = "Zasiedzenie w {{c1::dobrej wierze}} trwa {{c2::20 lat::liczba}}, w złej {{c2::30 lat}}.";
    expect(clozeKeys(text)).toEqual(["c1", "c2"]);
    const segs = parseCloze(text, "c2");
    expect(segs.filter((s) => s.kind === "gap" && s.active)).toHaveLength(2);
    expect(segs.find((s) => s.kind === "gap" && s.key === "c2")).toMatchObject({ answer: "20 lat", hint: "liczba" });
  });

  it("validates materials and warns about long answers and 'Omów' questions", () => {
    expect(() => checkMaterial("qa", { q: "", a: "x" })).toThrow();
    expect(() => checkMaterial("cloze", { text: "bez luk" })).toThrow(/lukę/);
    expect(() => checkMaterial("list", { prompt: "Wymień", items: ["a"] })).toThrow(/dwie/);
    expect(checkMaterial("qa", { q: "Omów zasiedzenie", a: "x" })[0]).toMatch(/ustnego/);
    expect(checkMaterial("qa", { q: "Co?", a: "słowo ".repeat(25) })[0]).toMatch(/20 słów/);
  });

  it("creates one review item per cloze gap and removes items of deleted gaps", () => {
    const db = freshDb();
    const s = createSubject(db, { name: "Prawo cywilne", exams: [] });
    const { id } = addManualMaterial(db, { subjectId: s.id, topicName: "Zasiedzenie", type: "cloze", payload: { text: "{{c1::a}} {{c2::b}} {{c3::c}}" } });
    expect(syncReviewItems(db).created).toBe(3);
    db.run("UPDATE material SET payload_json = ? WHERE id = ?", JSON.stringify({ text: "{{c1::a}} {{c3::c}}" }), id);
    expect(syncReviewItems(db)).toEqual({ created: 0, removed: 1 });
  });

  it("reuses an existing topic by name, case-insensitively", () => {
    const db = freshDb();
    const s = createSubject(db, { name: "Prawo karne", exams: [] });
    addManualMaterial(db, { subjectId: s.id, topicName: "Obrona konieczna", type: "qa", payload: { q: "a", a: "b" } });
    addManualMaterial(db, { subjectId: s.id, topicName: "obrona konieczna ", type: "qa", payload: { q: "c", a: "d" } });
    expect(db.get<{ n: number }>("SELECT COUNT(*) AS n FROM topic")!.n).toBe(1);
  });
});

describe("session planner", () => {
  it("limits new materials by the daily number and the time budget", () => {
    const db = freshDb();
    subjectWithCards(db, 100);
    updateSettings(db, { newPerDay: 15, dailyMinutes: 20 });
    const plan = planSession(db, at("2026-10-06T08:00:00Z"));
    expect(plan.newIncluded).toBe(15);
    expect(plan.newAvailable).toBe(100);

    // Here time is the limit, not the number of new materials.
    updateSettings(db, { dailyMinutes: 5, newPerDay: 100 });
    const short = planSession(db, at("2026-10-06T08:00:00Z"));
    expect(short.estSeconds).toBeLessThanOrEqual(5 * 60);
    expect(short.newIncluded).toBeGreaterThan(0);
    expect(short.newIncluded).toBeLessThan(100);
  });

  it("introduces only one gap of a new cloze per day and buries siblings after an answer", () => {
    const db = freshDb();
    const s = createSubject(db, { name: "Prawo cywilne", exams: [] });
    addManualMaterial(db, { subjectId: s.id, topicName: "Zasiedzenie", type: "cloze", payload: { text: "{{c1::a}} {{c2::b}}" } });
    const now = at("2026-10-06T08:00:00Z");
    const plan = planSession(db, now);
    expect(plan.cards.map((c) => c.subKey)).toEqual(["c1"]);
    recordAnswer(db, { itemId: plan.cards[0]!.itemId, rating: Rating.Again, now });
    // c1 comes back in this session; c2 waits for tomorrow.
    const later = planSession(db, new Date(now.getTime() + 2 * 60_000));
    expect(later.cards.map((c) => c.subKey)).toEqual(["c1"]);
    const tomorrow = planSession(db, addDays(now, 1));
    expect(tomorrow.cards.map((c) => c.subKey)).toContain("c2");
  });

  it("counts time already studied today against the limit", () => {
    const db = freshDb();
    subjectWithCards(db, 60);
    updateSettings(db, { dailyMinutes: 10, newPerDay: 60 });
    const morning = at("2026-10-06T08:00:00Z");
    studyDay(db, morning);
    const evening = planSession(db, at("2026-10-06T19:00:00Z"));
    expect(evening.budgetSeconds).toBeLessThan(60);
    expect(evening.newIncluded).toBe(0);
  });

  it("gives no new materials for subjects in maintenance and skips archived ones", () => {
    const db = freshDb();
    const s = subjectWithCards(db, 10);
    setSubjectStatus(db, s.id, "maintenance");
    expect(planSession(db, at("2026-10-06T08:00:00Z")).newIncluded).toBe(0);
    setSubjectStatus(db, s.id, "archived");
    expect(planSession(db, at("2026-10-06T08:00:00Z")).newAvailable).toBe(0);
  });

  it("does not put two cards of the same topic next to each other when it can be avoided", () => {
    const db = freshDb();
    subjectWithCards(db, 30);
    updateSettings(db, { newPerDay: 30, dailyMinutes: 60 });
    const cards = planSession(db, at("2026-10-06T08:00:00Z")).cards;
    for (let i = 1; i < cards.length; i++) expect(cards[i]!.topicId).not.toBe(cards[i - 1]!.topicId);
  });

  it("mixes subjects with interleaving on, and keeps them in blocks with it off", () => {
    const db = freshDb();
    subjectWithCards(db, 10, "Prawo cywilne", "2027-01-20");
    subjectWithCards(db, 10, "Prawo karne", "2027-02-20");
    updateSettings(db, { newPerDay: 20, dailyMinutes: 60 });
    const mixed = planSession(db, at("2026-10-06T08:00:00Z")).cards.map((c) => c.subjectName);
    expect(mixed.slice(0, 4)).toEqual(["Prawo cywilne", "Prawo karne", "Prawo cywilne", "Prawo karne"]);
    updateSettings(db, { interleaveSubjects: false });
    const blocks = planSession(db, at("2026-10-06T08:00:00Z")).cards.map((c) => c.subjectName);
    expect(blocks.slice(0, 10).every((n) => n === "Prawo cywilne")).toBe(true);
  });

  it("after a 5-day break: never over the limit, no new materials until the backlog is gone, backlog spread over days", () => {
    const db = freshDb();
    subjectWithCards(db, 300, "Prawo cywilne", "2027-02-10");
    updateSettings(db, { dailyMinutes: 20, newPerDay: 20 });
    let day = at("2026-10-01T07:00:00Z");

    // Three weeks of regular study, with some mistakes.
    for (let i = 0; i < 21; i++) {
      studyDay(db, day, (k) => (k % 7 === 0 ? Rating.Again : k % 5 === 0 ? Rating.Hard : Rating.Good));
      day = addDays(day, 1);
    }
    const learned = db.get<{ n: number }>("SELECT COUNT(*) AS n FROM review_item WHERE state != 0")!.n;
    expect(learned).toBeGreaterThan(150);

    // Break.
    day = addDays(day, 5);
    const first = planSession(db, day);
    expect(first.estSeconds).toBeLessThanOrEqual(first.budgetSeconds);
    expect(first.deferred).toBeGreaterThan(0);
    expect(first.newPaused).toBe(true);
    expect(first.newIncluded).toBe(0);
    expect(first.backlogDays).toBeGreaterThan(1);

    // Back to daily study: each day within the limit, and new materials return once the backlog is cleared.
    let newBack = false;
    for (let i = 0; i < 10; i++) {
      const plan = studyDay(db, day);
      expect(plan.estSeconds).toBeLessThanOrEqual(20 * 60);
      if (plan.newIncluded > 0) {
        newBack = true;
        break;
      }
      day = addDays(day, 1);
    }
    expect(newBack).toBe(true);

    // Nothing is scheduled in the past and stabilities are sane.
    const bad = db.get<{ n: number }>("SELECT COUNT(*) AS n FROM review_item WHERE state = 2 AND (stability <= 0 OR due < last_review)")!.n;
    expect(bad).toBe(0);
  });
});

describe("answering", () => {
  it("schedules with FSRS, logs the answer, and undo restores the card", () => {
    const db = freshDb();
    subjectWithCards(db, 1);
    const now = at("2026-10-06T08:00:00Z");
    const [card] = planSession(db, now).cards;
    const r1 = recordAnswer(db, { itemId: card!.itemId, rating: Rating.Good, confidence: 3, durationMs: 9000, now });
    expect(r1.state).not.toBe(State.New);

    const next = new Date(r1.due.getTime() + 1000);
    const intervals = previewIntervals(db, card!.itemId, next);
    expect(intervals[Rating.Again]).toMatch(/min/);

    const r2 = recordAnswer(db, { itemId: card!.itemId, rating: Rating.Easy, confidence: 3, durationMs: 4000, now: next });
    const before = db.get<{ reps: number }>("SELECT reps FROM review_item WHERE id = ?", card!.itemId)!.reps;
    undoAnswer(db, r2.logId);
    const after = db.get<{ reps: number; due: string }>("SELECT reps, due FROM review_item WHERE id = ?", card!.itemId)!;
    expect(after.reps).toBe(before - 1);
    expect(after.due).toBe(r1.due.toISOString());
    expect(db.get<{ n: number }>("SELECT COUNT(*) AS n FROM review_log")!.n).toBe(1);
  });

  it("practice answers are logged but do not change the schedule", () => {
    const db = freshDb();
    subjectWithCards(db, 1);
    const now = at("2026-10-06T08:00:00Z");
    const [card] = planSession(db, now).cards;
    recordAnswer(db, { itemId: card!.itemId, rating: Rating.Again, countInFsrs: false, mode: "exam", now });
    expect(db.get<{ state: number }>("SELECT state FROM review_item WHERE id = ?", card!.itemId)!.state).toBe(State.New);
  });

  it("compares declared confidence with results", () => {
    const db = freshDb();
    subjectWithCards(db, 6);
    const now = at("2026-10-06T08:00:00Z");
    const cards = planSession(db, now).cards;
    const answers: [1 | 2 | 3, 1 | 3][] = [
      [3, 3],
      [3, 3],
      [3, 1],
      [1, 1],
      [1, 3],
      [2, 3],
    ];
    const ids = cards.map((c, i) => recordAnswer(db, { itemId: c.itemId, confidence: answers[i]![0], rating: answers[i]![1], now }).logId);
    expect(calibration(db, { logIds: ids })).toEqual([
      { confidence: 1, answers: 2, correct: 1 },
      { confidence: 2, answers: 1, correct: 1 },
      { confidence: 3, answers: 3, correct: 2 },
    ]);
  });

  it("suggests a rating for a list and formats intervals in Polish", () => {
    expect(listRating([true, true, true])).toBe(Rating.Good);
    expect(listRating([true, false, true, true])).toBe(Rating.Hard);
    expect(listRating([true, false, true])).toBe(Rating.Again);
    expect(formatInterval(5 * 60_000)).toBe("5 min");
    expect(formatInterval(86_400_000)).toBe("1 dzień");
    expect(formatInterval(12 * 86_400_000)).toBe("12 dni");
    expect(formatInterval(90 * 86_400_000)).toBe("3 mies.");
  });

  it("starts the study day at 4:00", () => {
    const late = new Date(2026, 9, 7, 2, 30);
    expect(studyDayStart(late).getDate()).toBe(6);
    expect(studyDayStart(new Date(2026, 9, 7, 9, 0)).getDate()).toBe(7);
  });
});
