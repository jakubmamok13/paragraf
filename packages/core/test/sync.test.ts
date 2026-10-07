import initSqlJs, { type SqlJsStatic } from "sql.js";
import { beforeAll, describe, expect, it } from "vitest";
import {
  addManualMaterial,
  createSubject,
  Db,
  decodePackage,
  deletePalace,
  encodePackage,
  exportPackage,
  getSettings,
  importPackage,
  listPalaces,
  listSubjects,
  planSession,
  recordAnswer,
  savePalace,
  undoAnswer,
  updateSettings,
} from "../src";

let SQL: SqlJsStatic;
beforeAll(async () => {
  SQL = await initSqlJs();
});
const fresh = () => new Db(new SQL.Database());
/** What the Drive folder does: one device writes its file, another reads it. */
const sync = (from: Db, to: Db) => importPackage(to, decodePackage(encodePackage(exportPackage(from, "sync"))));
const ROUTE = ["drzwi", "wieszak", "lustro", "szafka", "kuchenka", "zlew", "okno"];

describe("synchronisation through a shared folder", () => {
  it("carries cards, progress and shared settings both ways, never the laptop's AI server", async () => {
    const laptop = fresh();
    const phone = fresh();
    updateSettings(laptop, { ai: { provider: "ollama", baseUrl: "http://localhost:11434", model: "qwen3:14b" }, dailyMinutes: 30 });
    const s = createSubject(laptop, { name: "Prawo cywilne", exams: [] });
    addManualMaterial(laptop, { subjectId: s.id, topicName: "Zasiedzenie", type: "qa", payload: { q: "Ile lat trwa zasiedzenie w dobrej wierze?", a: "20 lat" } });

    sync(laptop, phone);
    expect(listSubjects(phone).map((x) => x.name)).toEqual(["Prawo cywilne"]);
    expect(getSettings(phone).dailyMinutes).toBe(30);
    expect(getSettings(phone).ai.model).toBe("");

    // The phone learns and changes another setting.
    const card = planSession(phone).cards[0]!;
    recordAnswer(phone, { itemId: card.itemId, rating: 3, confidence: 2, durationMs: 4000 });
    await new Promise((r) => setTimeout(r, 5));
    updateSettings(phone, { lessonAudio: true, ai: { provider: "openai", baseUrl: "http://192.168.0.2:1234", model: "x" } });

    sync(phone, laptop);
    expect(laptop.get<{ n: number }>("SELECT COUNT(*) AS n FROM review_log")!.n).toBe(1);
    expect(getSettings(laptop).lessonAudio).toBe(true);
    // A setting changed only on the laptop is not overwritten by the phone's untouched default.
    expect(getSettings(laptop).dailyMinutes).toBe(30);
    expect(getSettings(laptop).ai).toMatchObject({ provider: "ollama", model: "qwen3:14b" });

    // Syncing again changes nothing.
    const again = sync(phone, laptop);
    expect(again.inserted + again.updated + again.deleted).toBe(0);
  });

  it("a fresh device's first change does not overwrite settings made elsewhere", async () => {
    const a = fresh();
    const b = fresh();
    updateSettings(a, { dailyMinutes: 45 });
    await new Promise((r) => setTimeout(r, 5));
    updateSettings(b, { lessonRate: 1.2 }); // b never saw a's change
    sync(b, a);
    sync(a, b);
    for (const db of [a, b]) {
      expect(getSettings(db).dailyMinutes).toBe(45);
      expect(getSettings(db).lessonRate).toBe(1.2);
    }
  });

  it("deletions travel: an undone answer and a deleted palace stay deleted", () => {
    const phone = fresh();
    const tablet = fresh();
    const s = createSubject(phone, { name: "Prawo karne", exams: [] });
    addManualMaterial(phone, { subjectId: s.id, topicName: "Obrona konieczna", type: "qa", payload: { q: "Co odpiera obrona konieczna?", a: "Bezpośredni, bezprawny zamach" } });
    const card = planSession(phone).cards[0]!;
    const { logId } = recordAnswer(phone, { itemId: card.itemId, rating: 1, durationMs: 3000 });
    const palaceId = savePalace(phone, { name: "Dom", loci: ROUTE });
    sync(phone, tablet);
    expect(tablet.get<{ n: number }>("SELECT COUNT(*) AS n FROM review_log")!.n).toBe(1);
    expect(listPalaces(tablet)).toHaveLength(1);

    undoAnswer(phone, logId);
    deletePalace(phone, palaceId);
    sync(phone, tablet);
    sync(tablet, phone); // the tablet's older file must not bring them back
    for (const db of [phone, tablet]) {
      expect(db.get<{ n: number }>("SELECT COUNT(*) AS n FROM review_log")!.n).toBe(0);
      expect(listPalaces(db)).toHaveLength(0);
    }
  });

  it("is refused by an older app version", () => {
    const a = fresh();
    const pkg = exportPackage(a, "sync");
    expect(() => importPackage(fresh(), { ...pkg, schemaVersion: pkg.schemaVersion + 1 })).toThrow(/nowszej wersji/);
  });
});
