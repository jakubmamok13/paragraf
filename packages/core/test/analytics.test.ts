import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import initSqlJs, { type SqlJsStatic } from "sql.js";
import { beforeAll, describe, expect, it } from "vitest";
import {
  approveMaterials,
  createSubject,
  Db,
  decodePackage,
  encodePackage,
  enqueueDocument,
  exportPackage,
  hardestCards,
  importDocument,
  importPackage,
  loadPrompts,
  parseFile,
  planSession,
  Rating,
  recentLectures,
  recordAnswer,
  reviewQueue,
  runQueue,
  studyStats,
  subjectProgress,
  todayFocus,
  updateSettings,
} from "../src";
import { FAKE_MODELS, fakeFetch } from "./fake-model";

const here = (p: string) => fileURLToPath(new URL(p, import.meta.url));
const promptsDir = here("../../../prompts/");
const prompts = loadPrompts(readdirSync(promptsDir).map((f) => readFileSync(promptsDir + f, "utf8")));

let SQL: SqlJsStatic;
beforeAll(async () => {
  SQL = await initSqlJs();
});

/** Laptop: the note and the exam list processed and approved; phone: content imported. */
async function studied() {
  const laptop = new Db(new SQL.Database());
  updateSettings(laptop, { ai: { provider: "ollama", baseUrl: "http://x", model: FAKE_MODELS[0]! } });
  const s = createSubject(laptop, { name: "Prawo cywilne", exams: [{ kind: "egzamin", format: "ustny", date: "2027-02-10" }] });
  const ids: string[] = [];
  for (const [file, kind, date] of [
    ["zagadnienia.txt", "exam_list", null],
    ["wyklad-2026-10-06.md", "note", "2026-10-06"],
  ] as const) {
    const bytes = new Uint8Array(readFileSync(here(`./fixtures/${file}`)));
    const r = await importDocument(laptop, { subjectId: s.id, kind, title: file, fileName: file, fileBytes: bytes, parsed: await parseFile(file, bytes), lectureDate: date });
    enqueueDocument(laptop, r.documentId);
    ids.push(r.documentId);
  }
  await runQueue(laptop, { prompts, fetchFn: fakeFetch });
  approveMaterials(laptop, reviewQueue(laptop).map((m) => m.id));
  const phone = new Db(new SQL.Database());
  importPackage(phone, decodePackage(encodePackage(exportPackage(laptop, "content"))));
  return { laptop, phone, noteId: ids[1]! };
}

describe("after the lecture", () => {
  it("offers a short test of today's note with all its new materials, the same day", async () => {
    const { phone, noteId } = await studied();
    const evening = new Date(2026, 9, 6, 19, 0);
    updateSettings(phone, { newPerDay: 2 });
    const lectures = recentLectures(phone, evening);
    expect(lectures).toHaveLength(1);
    expect(lectures[0]!.documentId).toBe(noteId);

    const plan = planSession(phone, evening, { documentId: noteId, budgetSeconds: 600, newLimit: 30 });
    expect(plan.newIncluded).toBeGreaterThan(2); // not held to the daily number of new cards
    expect(plan.estSeconds).toBeLessThanOrEqual(600);
    for (const c of plan.cards) recordAnswer(phone, { itemId: c.itemId, rating: Rating.Good, confidence: 2, mode: "after_lecture", now: evening });
    expect(recentLectures(phone, evening)).toHaveLength(0);
    // Two days later the note is no longer "recent".
    expect(recentLectures(phone, new Date(2026, 9, 9, 10, 0))).toHaveLength(0);
  });
});

describe("analytics", () => {
  it("shows mastery per subject and section, what to learn today, hard cards and the streak", async () => {
    const { phone } = await studied();
    updateSettings(phone, { newPerDay: 50, dailyMinutes: 60 });
    const day1 = new Date(2026, 9, 6, 18, 0);
    const before = subjectProgress(phone, day1)[0]!;
    expect(before.mastery).toBe(0);
    expect(before.learned).toBe(0);

    // Day 1: everything right except one card, which keeps failing for three days.
    const plan = planSession(phone, day1);
    const hard = plan.cards[0]!;
    for (const c of plan.cards) recordAnswer(phone, { itemId: c.itemId, rating: c === hard ? Rating.Again : Rating.Good, confidence: 3, now: day1 });
    for (let d = 1; d <= 3; d++) recordAnswer(phone, { itemId: hard.itemId, rating: Rating.Again, confidence: 3, now: new Date(2026, 9, 6 + d, 18, 0) });

    const now = new Date(2026, 9, 9, 19, 0);
    const p = subjectProgress(phone, now)[0]!;
    expect(p.mastery).toBeGreaterThan(0.3);
    // Everything but the "Odtwórz schemat" cards, which unlock in a later session.
    const synthesis = phone.get<{ n: number }>("SELECT COUNT(*) AS n FROM review_item i JOIN material m ON m.id = i.material_id WHERE json_extract(m.payload_json, '$.synthesis') = 1")!.n;
    expect(synthesis).toBeGreaterThan(0);
    expect(p.learned).toBe(p.items - synthesis);
    expect(p.examDate).toBe("2027-02-10");
    expect(p.readiness!).toBeLessThan(p.mastery); // memory fades by February without more study
    expect(p.sections.map((s) => s.title)).toContain("Zasiedzenie");

    const focus = todayFocus([p]);
    expect(focus.some((f) => f.topic.name === "Nieważność czynności prawnej" && f.reason.includes("brak materiałów"))).toBe(true);

    const hardCards = hardestCards(phone);
    expect(hardCards[0]!.materialId).toBe(hard.materialId);

    const stats = studyStats(phone, now);
    expect(stats.streak).toBe(4);
    expect(stats.last14.at(-1)!.answers).toBe(1);
    expect(stats.calibration30.find((c) => c.confidence === 3)!.correct).toBeLessThan(stats.calibration30.find((c) => c.confidence === 3)!.answers);
  });
});

describe("package files", () => {
  it("are compressed and read back, also as plain JSON from older versions", async () => {
    const { laptop } = await studied();
    const pkg = exportPackage(laptop, "content", { allChunks: true });
    const bytes = encodePackage(pkg);
    expect(bytes.length).toBeLessThan(JSON.stringify(pkg).length / 2);
    expect(decodePackage(bytes).tables.material!.length).toBe(pkg.tables.material!.length);
    expect(decodePackage(new TextEncoder().encode(JSON.stringify(pkg))).kind).toBe("content");
    expect(() => decodePackage(new Uint8Array([0x1f, 0x8b, 1, 2, 3]))).toThrow(/uszkodzony/);
  });
});
