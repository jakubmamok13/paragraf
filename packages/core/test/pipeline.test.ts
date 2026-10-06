import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import * as pdfjs from "pdfjs-dist/legacy/build/pdf.mjs";
import initSqlJs, { type SqlJsStatic } from "sql.js";
import { beforeAll, describe, expect, it } from "vitest";
import {
  approveMaterials,
  benchmarkModels,
  createSubject,
  Db,
  type DocumentKind,
  editMaterial,
  enqueueDocument,
  exportPackage,
  flagMaterial,
  getChunk,
  importDocument,
  importPackage,
  listConflicts,
  listJobs,
  listSuggestions,
  loadPrompts,
  materialSources,
  parseFile,
  type PdfJs,
  type PipelineContext,
  planSession,
  rejectMaterial,
  resolveConflict,
  retryJobs,
  reviewQueue,
  runQueue,
  updateSettings,
  workshopCounts,
  withOverrides,
} from "../src";
import { FAKE_MODELS, fakeFetch } from "./fake-model";

const here = (p: string) => fileURLToPath(new URL(p, import.meta.url));
const fixture = (name: string) => new Uint8Array(readFileSync(here(`./fixtures/${name}`)));
const promptsDir = here("../../../prompts/");
const prompts = loadPrompts(readdirSync(promptsDir).map((f) => readFileSync(promptsDir + f, "utf8")));

let SQL: SqlJsStatic;
beforeAll(async () => {
  SQL = await initSqlJs();
});

async function addFile(db: Db, subjectId: string, file: string, kind: DocumentKind, lectureDate?: string) {
  const bytes = fixture(file);
  const parsed = await parseFile(file, bytes, { pdfjs: pdfjs as unknown as PdfJs });
  const r = await importDocument(db, { subjectId, kind, title: parsed.title ?? file, fileName: file, fileBytes: bytes, parsed, lectureDate: lectureDate ?? null });
  enqueueDocument(db, r.documentId);
  return r.documentId;
}

async function setup() {
  const db = new Db(new SQL.Database());
  updateSettings(db, { ai: { provider: "ollama", baseUrl: "http://localhost:11434", model: FAKE_MODELS[0]! } });
  const s = createSubject(db, { name: "Prawo cywilne", exams: [{ kind: "egzamin", format: "ustny", date: "2027-02-10" }] });
  const ctx: PipelineContext = { prompts, fetchFn: fakeFetch };
  return { db, s, ctx };
}

const topicByName = (db: Db, name: string) => db.get<any>("SELECT * FROM topic WHERE name = ?", name);

describe("pipeline with the sample note, an old textbook and an exam list", () => {
  it("builds the knowledge map, rejects invented facts, flags the conflict, and makes sourced materials", async () => {
    const { db, s, ctx } = await setup();
    await addFile(db, s.id, "zagadnienia.txt", "exam_list");
    const noteId = await addFile(db, s.id, "wyklad-2026-10-06.md", "note", "2026-10-06");
    await addFile(db, s.id, "podrecznik-2015.pdf", "textbook");

    const progress: string[] = [];
    const run = await runQueue(db, { ...ctx, onProgress: (p) => progress.push(`${p.kind} ${p.done}/${p.total}`) });
    expect(run.stoppedBy).toBe("empty");
    expect(listJobs(db, { activeOnly: true })).toHaveLength(0);
    expect(progress.length).toBeGreaterThan(0);

    // Knowledge map.
    const zn = topicByName(db, "Zasiedzenie nieruchomości");
    const pr = topicByName(db, "Przedawnienie roszczeń");
    const zr = topicByName(db, "Zasiedzenie ruchomości");
    expect(zn.status).toBe("active");
    expect(zn.emphasis).toBeGreaterThan(0);
    expect(zn.exam_weight).toBe(1); // on the exam list
    expect(pr.exam_weight).toBe(1);
    expect(zr.exam_weight).toBe(0.5); // lecture only
    expect(topicByName(db, "Nieważność czynności prawnej").status).toBe("draft"); // on the list, no material yet
    expect(db.get("SELECT 1 FROM topic_relation WHERE from_topic = ? AND to_topic = ? AND type = 'distinguish'", zn.id, pr.id)).toBeTruthy();

    // Invented facts never become fields; they are suggestions.
    const fields = db.all<{ content_json: string }>("SELECT content_json FROM topic_field").map((f) => JSON.parse(f.content_json).text as string);
    expect(fields.some((t) => t.includes("tytuł prawny"))).toBe(false);
    expect(fields.some((t) => t.includes("176"))).toBe(false);
    const sugg = listSuggestions(db, s.id).map((x) => x.text);
    expect(sugg.some((t) => t.includes("tytuł prawny") && t.includes("cytatu nie ma"))).toBe(true);
    expect(sugg.some((t) => t.includes("art. 176 k.c.") && t.includes("nie ma w źródle"))).toBe(true);

    // The old textbook says 10 years, the lecture 6: a conflict, not a silent choice.
    const conflicts = listConflicts(db, s.id);
    expect(conflicts).toHaveLength(1);
    const c = conflicts[0]!;
    expect(c.topicName).toBe("Przedawnienie roszczeń");
    expect(c.candidates.map((x) => x.documentKind).sort()).toEqual(["note", "textbook"]);
    const noteVersion = c.candidates.find((x) => x.documentKind === "note")!;
    expect(c.hintFieldId).toBe(noteVersion.fieldId);
    expect(c.candidates.find((x) => x.documentKind === "textbook")!.page).toBeGreaterThanOrEqual(41);

    // Materials: sourced, nothing invented, no "Omów", none about the conflicting deadline yet.
    const queue = reviewQueue(db, s.id);
    expect(queue.length).toBeGreaterThanOrEqual(6);
    for (const m of queue) {
      expect(m.citations.length).toBeGreaterThan(0);
      for (const cit of m.citations) expect(getChunk(db, cit.chunkId)!.text).toContain(cit.quote);
      const text = JSON.stringify(m.payload);
      expect(text).not.toContain("999");
      expect(text).not.toMatch(/Omów/);
      expect(text).not.toMatch(/dziesięć|10 lat|6 lat/);
    }
    expect(queue.map((m) => m.type)).toEqual(expect.arrayContaining(["cloze", "qa", "why", "distinction"]));
    // At most 4 materials per topic in one pass ("lepiej mniej, a dobrze").
    const perTopic = new Map<string, number>();
    for (const m of queue) perTopic.set(m.topicId, (perTopic.get(m.topicId) ?? 0) + 1);
    for (const n of perTopic.values()) expect(n).toBeLessThanOrEqual(4);
    expect(sugg.length).toBeLessThan(listSuggestions(db, s.id).length + 1);
    expect(listSuggestions(db, s.id).some((x) => x.kind === "rejected_material" && x.text.includes("999"))).toBe(true);
    // Highest exam weight first.
    expect(queue[0]!.examWeight).toBe(1);
    // Every material links back to the note.
    expect(queue.some((m) => m.citations.some((ci) => ci.documentKind === "note" && ci.lectureDate === "2026-10-06"))).toBe(true);
    expect(db.get<{ n: number }>("SELECT COUNT(*) AS n FROM material WHERE generation_run_id IN (SELECT id FROM job WHERE document_id = ?)", noteId)!.n).toBeLessThanOrEqual(20);

    // Decide: approve, edit one, reject one as too easy.
    const [first, second, ...rest] = queue;
    rejectMaterial(db, first!.id, { tooEasy: true });
    if (second!.type === "qa" || second!.type === "why") editMaterial(db, second!.id, { ...second!.payload, a: `${second!.payload.a}` });
    approveMaterials(db, [second!.id, ...rest.map((m) => m.id)]);
    expect(workshopCounts(db).pending).toBe(0);

    // Resolve the conflict for the lecture's 6 years: the deadline card appears, from the note.
    resolveConflict(db, c.id, noteVersion.fieldId, "Stan po nowelizacji z 2018 r.");
    expect(listConflicts(db, s.id)).toHaveLength(0);
    await runQueue(db, ctx);
    const after = reviewQueue(db, s.id);
    const deadline = after.find((m) => JSON.stringify(m.payload).includes("6 lat"));
    expect(deadline).toBeTruthy();
    expect(deadline!.citations[0]!.documentKind).toBe("note");
    expect(after.some((m) => JSON.stringify(m.payload).includes("10 lat"))).toBe(false);
    approveMaterials(db, after.map((m) => m.id));

    // To the phone: learn, see the source, flag a wrong card back to the laptop.
    const phone = new Db(new SQL.Database());
    importPackage(phone, exportPackage(db, "content"));
    updateSettings(phone, { newPerDay: 50, dailyMinutes: 60 });
    const plan = planSession(phone, new Date("2026-10-06T18:00:00Z"));
    expect(plan.cards.length).toBeGreaterThanOrEqual(6);
    const src = materialSources(phone, plan.cards[0]!.materialId);
    expect(src.length).toBeGreaterThan(0);
    flagMaterial(phone, plan.cards[0]!.materialId);
    importPackage(db, exportPackage(phone, "progress"));
    expect(workshopCounts(db).flagged).toBe(1);
    expect(reviewQueue(db, s.id)[0]!.flagged).toBe(true);
  });

  it("re-running changes nothing, pausing keeps the place, an unreachable AI stops with a message", async () => {
    const { db, s, ctx } = await setup();
    await addFile(db, s.id, "wyklad-2026-10-06.md", "note", "2026-10-06");

    const stop = new AbortController();
    stop.abort();
    expect((await runQueue(db, { ...ctx, signal: stop.signal })).stoppedBy).toBe("paused");
    expect(listJobs(db)[0]!.status).toBe("paused");

    const down = (async () => {
      throw new TypeError("Failed to fetch");
    }) as unknown as typeof fetch;
    retryJobs(db);
    const failed = await runQueue(db, { ...ctx, fetchFn: down });
    expect(failed.stoppedBy).toBe("error");
    expect(failed.error).toMatch(/Brak połączenia z lokalnym AI/);

    retryJobs(db);
    expect((await runQueue(db, ctx)).stoppedBy).toBe("empty");
    const materials = db.get<{ n: number }>("SELECT COUNT(*) AS n FROM material")!.n;
    expect(materials).toBeGreaterThan(0);

    // Same document again: nothing new to read, nothing duplicated.
    const calls = db.get<{ n: number }>("SELECT COUNT(*) AS n FROM ai_call")!.n;
    await addFile(db, s.id, "wyklad-2026-10-06.md", "note", "2026-10-06");
    await runQueue(db, ctx);
    expect(db.get<{ n: number }>("SELECT COUNT(*) AS n FROM material")!.n).toBe(materials);
    expect(db.get<{ n: number }>("SELECT COUNT(*) AS n FROM ai_call")!.n).toBe(calls);
  });

  it("compares models on a document without saving anything", async () => {
    const { db, s, ctx } = await setup();
    const docId = await addFile(db, s.id, "wyklad-2026-10-06.md", "note");
    const rows = await benchmarkModels(db, ctx, FAKE_MODELS, docId, 2);
    expect(rows.map((r) => r.model)).toEqual(FAKE_MODELS);
    for (const r of rows) {
      expect(r.validJson).toBe(2);
      expect(r.fields).toBeGreaterThan(0);
      expect(r.rejected).toBeGreaterThan(0);
      expect(r.verifiedShare).toBeGreaterThan(0.5);
      expect(r.verifiedShare).toBeLessThan(1);
    }
    expect(db.get<{ n: number }>("SELECT COUNT(*) AS n FROM topic")!.n).toBe(0);
  });

  it("a prompt edited by the user gets its own version, so old cached answers are not reused", () => {
    const edited = withOverrides(prompts, { "extract-topics": `${prompts["extract-topics"]!.system}\nDodatkowa zasada.` });
    expect(edited["extract-topics"]!.version).not.toBe(prompts["extract-topics"]!.version);
    expect(withOverrides(prompts, { "extract-topics": prompts["extract-topics"]!.system })["extract-topics"]!.version).toBe(prompts["extract-topics"]!.version);
  });
});
