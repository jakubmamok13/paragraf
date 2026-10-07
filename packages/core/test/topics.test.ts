import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import initSqlJs, { type SqlJsStatic } from "sql.js";
import { beforeAll, describe, expect, it } from "vitest";
import {
  approveMaterials,
  buildLesson,
  createSubject,
  Db,
  enqueueDocument,
  importDocument,
  lessonCandidates,
  lessonScript,
  loadPrompts,
  parseFile,
  planSession,
  Rating,
  recordAnswer,
  reviewQueue,
  runQueue,
  SLOT_ORDER,
  speechText,
  topicSchema,
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

async function processedNote() {
  const db = new Db(new SQL.Database());
  updateSettings(db, { ai: { provider: "ollama", baseUrl: "http://x", model: FAKE_MODELS[0]! }, newPerDay: 50, dailyMinutes: 60 });
  const s = createSubject(db, { name: "Prawo cywilne", exams: [] });
  const bytes = new Uint8Array(readFileSync(here("./fixtures/wyklad-2026-10-06.md")));
  const r = await importDocument(db, { subjectId: s.id, kind: "note", title: "W5", fileName: "w.md", fileBytes: bytes, parsed: await parseFile("w.md", bytes) });
  enqueueDocument(db, r.documentId);
  await runQueue(db, { prompts, fetchFn: fakeFetch });
  approveMaterials(db, reviewQueue(db).map((m) => m.id));
  const topicId = db.get<{ id: string }>("SELECT id FROM topic WHERE name = 'Zasiedzenie nieruchomości'")!.id;
  return { db, topicId };
}

describe("topic schema", () => {
  it("lists the parts of a topic in the fixed order, with cards and uncovered parts", async () => {
    const { db, topicId } = await processedNote();
    const schema = topicSchema(db, topicId)!;
    const order = schema.parts.map((p) => p.slot);
    expect(order).toEqual([...order].sort((a, b) => SLOT_ORDER[a]! - SLOT_ORDER[b]!));
    expect(order.slice(0, 3)).toEqual(["definition", "premise", "deadline"]);
    expect(schema.parts.find((p) => p.slot === "premise")!.points.map((p) => p.text)).toEqual(["posiadanie samoistne", "nieprzerwany upływ czasu określonego w ustawie"]);
    for (const p of schema.parts) expect(p.points.every((x) => x.source?.includes("W5"))).toBe(true);
  });

  it("makes a synthesis card from the verified parts that unlocks only after every other card was tried", async () => {
    const { db, topicId } = await processedNote();
    const synth = db.get<{ id: string; payload_json: string; status: string }>("SELECT id, payload_json, status FROM material WHERE topic_id = ? AND json_extract(payload_json, '$.synthesis') = 1", topicId)!;
    const payload = JSON.parse(synth.payload_json);
    expect(payload.prompt).toBe("Odtwórz schemat zagadnienia: Zasiedzenie nieruchomości");
    expect(payload.items[0]).toMatch(/^Definicja: /);
    expect(db.get<{ n: number }>("SELECT COUNT(*) AS n FROM citation WHERE owner_id = ?", synth.id)!.n).toBeGreaterThanOrEqual(3);

    const now = new Date("2026-10-06T18:00:00Z");
    const first = planSession(db, now, { topicId });
    expect(first.cards.some((c) => c.materialId === synth.id)).toBe(false);
    for (const c of first.cards) recordAnswer(db, { itemId: c.itemId, rating: Rating.Easy, now });
    const later = planSession(db, new Date("2026-10-07T18:00:00Z"), { topicId });
    expect(later.cards.some((c) => c.materialId === synth.id)).toBe(true);
  });
});

describe("short lesson", () => {
  it("offers new topics, asks two pre-questions from different parts, then the cards in schema order", async () => {
    const { db, topicId } = await processedNote();
    const candidates = lessonCandidates(db);
    expect(candidates.map((c) => c.name)).toContain("Zasiedzenie nieruchomości");

    const lesson = buildLesson(db, topicId)!;
    expect(lesson.prequestions).toHaveLength(2);
    expect(lesson.prequestions[0]!.slot).not.toBe(lesson.prequestions[1]!.slot);
    const parts = lesson.cards.filter((c) => c.type !== "distinction");
    const order = parts.map((c) => (c.slot ? SLOT_ORDER[c.slot]! : 99));
    expect(order).toEqual([...order].sort((a, b) => a - b));
    // "Czym różni się…" comes after the parts themselves.
    const firstComparison = lesson.cards.findIndex((c) => c.type === "distinction");
    if (firstComparison >= 0) expect(firstComparison).toBe(parts.length);
    expect(lesson.cards.some((c) => c.payload?.synthesis)).toBe(false);

    const script = lessonScript(lesson.schema);
    expect(script[0]!.text.startsWith("Definicja.")).toBe(true);
    expect(script.map((s) => s.text).join(" ")).toContain("artykuł 172 paragraf 1 kodeksu cywilnego");

    // After the first answer the topic is no longer "new".
    recordAnswer(db, { itemId: lesson.cards[0]!.itemId, rating: Rating.Good, mode: "lesson" });
    expect(lessonCandidates(db).map((c) => c.topicId)).not.toContain(topicId);
  });

  it("reads legal abbreviations in full", () => {
    expect(speechText("Zob. art. 172 § 2 k.c. oraz art. 5 pkt 3 k.p.c., np. wg SN.")).toBe(
      "Zob. artykuł 172 paragraf 2 kodeksu cywilnego oraz artykuł 5 punkt 3 kodeksu postępowania cywilnego, na przykład wg Sąd Najwyższy.",
    );
  });
});
