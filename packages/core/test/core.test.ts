import initSqlJs, { type SqlJsStatic } from "sql.js";
import { beforeAll, describe, expect, it } from "vitest";
import {
  type AiSettings,
  checkAi,
  chatJson,
  createSubject,
  Db,
  deleteSubject,
  exportPackage,
  getSettings,
  getSubject,
  importPackage,
  listSubjects,
  newId,
  parsePackage,
  setSubjectStatus,
  updateSettings,
  updateSubject,
} from "../src";

let SQL: SqlJsStatic;
beforeAll(async () => {
  SQL = await initSqlJs();
});
const freshDb = () => new Db(new SQL.Database());

/** A topic with one active material and one review item, as the phone would have it. */
function seedLearning(db: Db, subjectId: string) {
  const t = "2026-10-01T10:00:00.000Z";
  const topicId = newId();
  const materialId = newId();
  const itemId = newId();
  db.run("INSERT INTO topic (id, subject_id, name, created_at, updated_at) VALUES (?, ?, 'Zasiedzenie', ?, ?)", topicId, subjectId, t, t);
  db.run(
    "INSERT INTO material (id, topic_id, type, payload_json, status, created_at, updated_at) VALUES (?, ?, 'qa', ?, 'active', ?, ?)",
    materialId,
    topicId,
    JSON.stringify({ q: "Ile lat trwa zasiedzenie nieruchomości w dobrej wierze?", a: "20 lat" }),
    t,
    t,
  );
  db.run("INSERT INTO review_item (id, material_id, due, updated_at) VALUES (?, ?, ?, ?)", itemId, materialId, t, t);
  return { topicId, materialId, itemId };
}

describe("database", () => {
  it("migrates a new database and keeps foreign keys on after export", () => {
    const db = freshDb();
    expect(db.schemaVersion).toBeGreaterThan(0);
    db.export();
    expect(db.get<{ foreign_keys: number }>("PRAGMA foreign_keys")!.foreign_keys).toBe(1);
  });

  it("reopens an exported database without migrating again", () => {
    const db = freshDb();
    createSubject(db, { name: "Prawo cywilne", exams: [] });
    const again = new Db(new SQL.Database(db.export()));
    expect(listSubjects(again)).toHaveLength(1);
  });
});

describe("settings", () => {
  it("returns defaults and clamps values", () => {
    const db = freshDb();
    expect(getSettings(db).dailyMinutes).toBe(20);
    expect(getSettings(db).targetRetention).toBe(0.9);
    const s = updateSettings(db, { dailyMinutes: 1000, targetRetention: 0.5, newPerDay: 7.6 });
    expect(s.dailyMinutes).toBe(240);
    expect(s.targetRetention).toBe(0.7);
    expect(s.newPerDay).toBe(8);
  });

  it("merges AI settings and trims the URL", () => {
    const db = freshDb();
    updateSettings(db, { ai: { provider: "openai", baseUrl: " http://localhost:1234/ ", model: "" } });
    updateSettings(db, { dailyMinutes: 30 });
    expect(getSettings(db).ai).toEqual({ provider: "openai", baseUrl: "http://localhost:1234", model: "" });
  });
});

describe("subjects", () => {
  it("creates, edits and lists subjects by nearest exam", () => {
    const db = freshDb();
    const civil = createSubject(db, {
      name: " Prawo cywilne ",
      exams: [
        { kind: "egzamin", format: "ustny", date: "2027-02-10" },
        { kind: "kolokwium", format: "test", date: "2026-11-20" },
      ],
    });
    createSubject(db, { name: "Prawo karne", exams: [{ kind: "egzamin", format: "kazusy", date: "2027-01-25" }] });
    createSubject(db, { name: "Logika", exams: [] });

    expect(civil.name).toBe("Prawo cywilne");
    expect(getSubject(db, civil.id, "2026-10-06")!.nextExam?.kind).toBe("kolokwium");
    expect(getSubject(db, civil.id, "2026-12-01")!.nextExam?.kind).toBe("egzamin");
    expect(listSubjects(db, { today: "2026-10-06" }).map((s) => s.name)).toEqual(["Prawo cywilne", "Prawo karne", "Logika"]);

    const kolokwium = civil.exams.find((e) => e.kind === "kolokwium")!;
    const edited = updateSubject(db, civil.id, { name: "Prawo cywilne I", exams: [{ ...kolokwium, date: "2026-11-27" }] });
    expect(edited.exams).toHaveLength(1);
    expect(edited.exams[0]!.id).toBe(kolokwium.id);
    expect(edited.exams[0]!.date).toBe("2026-11-27");
    expect(db.all("SELECT * FROM tombstone WHERE table_name = 'exam'")).toHaveLength(1);
  });

  it("rejects invalid input", () => {
    const db = freshDb();
    expect(() => createSubject(db, { name: "  ", exams: [] })).toThrow(/nazwę/);
    expect(() => createSubject(db, { name: "X", exams: [{ kind: "egzamin", format: "ustny", date: "10.02.2027" }] })).toThrow(/data/);
    expect(() => createSubject(db, { name: "X", exams: [{ kind: "egzamin", format: "chat" as any, date: null }] })).toThrow(/formę/);
  });

  it("archives and deletes with everything under the subject", () => {
    const db = freshDb();
    const s = createSubject(db, { name: "Prawo rzymskie", exams: [{ kind: "egzamin", format: "ustny", date: null }] });
    seedLearning(db, s.id);
    setSubjectStatus(db, s.id, "archived");
    expect(listSubjects(db)).toHaveLength(0);
    expect(listSubjects(db, { includeArchived: true })).toHaveLength(1);

    deleteSubject(db, s.id);
    for (const t of ["subject", "exam", "topic", "material", "review_item"]) {
      expect(db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM ${t}`)!.n).toBe(0);
    }
    expect(db.get("SELECT * FROM tombstone WHERE table_name = 'subject' AND id = ?", s.id)).toBeTruthy();
  });
});

describe("packages", () => {
  it("content package from the laptop never overwrites learning progress on the phone", () => {
    const laptop = freshDb();
    const phone = freshDb();
    const s = createSubject(laptop, { name: "Prawo cywilne", exams: [{ kind: "egzamin", format: "ustny", date: "2027-02-10" }] });
    const { materialId, itemId } = seedLearning(laptop, s.id);
    laptop.run("DELETE FROM review_item"); // the laptop does not hold review state

    // First transfer.
    const r1 = importPackage(phone, parsePackage(JSON.stringify(exportPackage(laptop, "content"))));
    expect(r1.inserted).toBeGreaterThan(0);
    expect(getSubject(phone, s.id)!.exams).toHaveLength(1);

    // The phone learns.
    phone.run("INSERT INTO review_item (id, material_id, due, reps, updated_at) VALUES (?, ?, '2026-10-20', 3, ?)", itemId, materialId, "2026-10-06T08:00:00Z");

    // The laptop edits the material; the next package updates it without touching review state.
    laptop.run("UPDATE material SET payload_json = ?, updated_at = ? WHERE id = ?", '{"q":"poprawione","a":"20 lat"}', "2026-10-06T12:00:00Z", materialId);
    const r2 = importPackage(phone, exportPackage(laptop, "content"));
    expect(r2.updated).toBe(1);
    expect(phone.get<{ payload_json: string }>("SELECT payload_json FROM material WHERE id = ?", materialId)!.payload_json).toContain("poprawione");
    expect(phone.get<{ reps: number }>("SELECT reps FROM review_item WHERE id = ?", itemId)!.reps).toBe(3);
  });

  it("an older row does not overwrite a newer one", () => {
    const a = freshDb();
    const b = freshDb();
    const s = createSubject(a, { name: "Stara nazwa", exams: [] });
    importPackage(b, exportPackage(a, "content"));
    b.run("UPDATE subject SET name = 'Nowsza nazwa', updated_at = '2099-01-01T00:00:00Z' WHERE id = ?", s.id);
    importPackage(b, exportPackage(a, "content"));
    expect(getSubject(b, s.id)!.name).toBe("Nowsza nazwa");
  });

  it("carries deletions and does not resurrect deleted rows", () => {
    const laptop = freshDb();
    const phone = freshDb();
    const s = createSubject(laptop, { name: "Do usunięcia", exams: [] });
    seedLearning(laptop, s.id);
    importPackage(phone, exportPackage(laptop, "content"));
    expect(listSubjects(phone)).toHaveLength(1);

    const stale = exportPackage(laptop, "content");
    deleteSubject(laptop, s.id);
    expect(importPackage(phone, exportPackage(laptop, "content")).deleted).toBe(1);
    expect(phone.get<{ n: number }>("SELECT COUNT(*) AS n FROM review_item")!.n).toBe(0);

    importPackage(phone, stale);
    expect(listSubjects(phone)).toHaveLength(0);
  });

  it("progress package from the phone brings review state to the laptop", () => {
    const laptop = freshDb();
    const phone = freshDb();
    const s = createSubject(laptop, { name: "Prawo karne", exams: [] });
    const { itemId, materialId } = seedLearning(laptop, s.id);
    importPackage(phone, exportPackage(laptop, "content"));
    phone.run("INSERT INTO review_item (id, material_id, due, reps, updated_at) VALUES (?, ?, '2026-10-09', 5, '2026-10-06T09:00:00Z')", itemId, materialId);
    phone.run("INSERT INTO review_log (id, review_item_id, ts, rating, confidence, mode) VALUES (?, ?, '2026-10-06T09:00:00Z', 3, 2, 'daily')", newId(), itemId);

    const res = importPackage(laptop, exportPackage(phone, "progress"));
    expect(res.kind).toBe("progress");
    expect(laptop.get<{ reps: number }>("SELECT reps FROM review_item WHERE id = ?", itemId)!.reps).toBe(5);
    expect(laptop.get<{ n: number }>("SELECT COUNT(*) AS n FROM review_log")!.n).toBe(1);
    // Importing the same package twice changes nothing.
    expect(importPackage(laptop, exportPackage(phone, "progress")).inserted).toBe(0);
  });

  it("merges review state when both devices made items for the same material (different ids)", () => {
    const laptop = freshDb();
    const phone = freshDb();
    const s = createSubject(laptop, { name: "Prawo cywilne", exams: [] });
    const { materialId, itemId } = seedLearning(laptop, s.id);
    laptop.run("DELETE FROM review_item");
    importPackage(phone, exportPackage(laptop, "content"));
    // The laptop opened "Dziś": it made its own, never-studied item for the material.
    laptop.run("INSERT INTO review_item (id, material_id, sub_key, due, updated_at) VALUES ('laptop-item', ?, '', '2026-10-01', '2026-10-01T00:00:00Z')", materialId);
    // The phone studied with its item.
    phone.run("INSERT INTO review_item (id, material_id, due, reps, last_review, updated_at) VALUES (?, ?, '2026-10-09', 2, '2026-10-06T09:00:00Z', '2026-10-06T09:00:00Z')", itemId, materialId);
    phone.run("INSERT INTO review_log (id, review_item_id, ts, rating, mode) VALUES (?, ?, '2026-10-06T09:00:00Z', 3, 'daily')", newId(), itemId);

    importPackage(laptop, exportPackage(phone, "progress"));
    expect(laptop.all("SELECT id, reps FROM review_item")).toEqual([{ id: itemId, reps: 2 }]);
    expect(laptop.get<{ n: number }>("SELECT COUNT(*) AS n FROM review_log WHERE review_item_id = ?", itemId)!.n).toBe(1);

    // A card flagged on the phone (never answered) beats a newer, empty item made on the laptop.
    const t = "2026-10-01T10:00:00.000Z";
    const m2 = newId();
    laptop.run("INSERT INTO material (id, topic_id, type, payload_json, status, created_at, updated_at) VALUES (?, (SELECT id FROM topic), 'qa', '{\"q\":\"a\",\"a\":\"b\"}', 'active', ?, ?)", m2, t, t);
    importPackage(phone, exportPackage(laptop, "content"));
    phone.run("INSERT INTO review_item (id, material_id, due, suspended, updated_at) VALUES ('phone-m2', ?, ?, 1, '2026-10-06T10:00:00Z')", m2, t);
    laptop.run("INSERT INTO review_item (id, material_id, due, updated_at) VALUES ('laptop-m2', ?, ?, '2026-10-07T10:00:00Z')", m2, t);
    importPackage(laptop, exportPackage(phone, "progress"));
    expect(laptop.get("SELECT id, suspended FROM review_item WHERE material_id = ?", m2)).toEqual({ id: "phone-m2", suspended: 1 });
    laptop.run("DELETE FROM review_item WHERE material_id = ?", m2);
    phone.run("DELETE FROM review_item WHERE material_id = ?", m2);

    // Both studied: the later review wins and no history is lost.
    laptop.raw.exec("PRAGMA foreign_keys = OFF");
    laptop.run("UPDATE review_item SET id = 'laptop-item2' WHERE id = ?", itemId);
    laptop.run("UPDATE review_log SET review_item_id = 'laptop-item2'");
    laptop.raw.exec("PRAGMA foreign_keys = ON");
    laptop.run("UPDATE review_item SET reps = 7, last_review = '2026-10-08T09:00:00Z', updated_at = '2026-10-08T09:00:00Z'");
    phone.run("INSERT INTO review_log (id, review_item_id, ts, rating, mode) VALUES (?, ?, '2026-10-07T09:00:00Z', 4, 'daily')", newId(), itemId);
    importPackage(laptop, exportPackage(phone, "progress"));
    expect(laptop.all("SELECT id, reps FROM review_item")).toEqual([{ id: "laptop-item2", reps: 7 }]);
    expect(laptop.get<{ n: number }>("SELECT COUNT(*) AS n FROM review_log")!.n).toBe(2);
  });

  it("content package carries only cited source fragments unless asked for all", () => {
    const db = freshDb();
    const s = createSubject(db, { name: "Prawo cywilne", exams: [] });
    const { materialId } = seedLearning(db, s.id);
    const t = "2026-10-01T10:00:00.000Z";
    const docId = newId();
    db.run("INSERT INTO source_document (id, subject_id, kind, title, imported_at, updated_at) VALUES (?, ?, 'textbook', 'Podręcznik', ?, ?)", docId, s.id, t, t);
    const cited = newId();
    for (const [i, id] of [cited, newId(), newId()].entries()) {
      db.run("INSERT INTO source_chunk (id, document_id, ord, text, text_hash, updated_at) VALUES (?, ?, ?, ?, ?, ?)", id, docId, i, `fragment ${i}`, `h${i}`, t);
    }
    db.run("INSERT INTO citation (id, owner_type, owner_id, chunk_id, quote, updated_at) VALUES (?, 'material', ?, ?, 'fragment 0', ?)", newId(), materialId, cited, t);

    expect(exportPackage(db, "content").tables.source_chunk).toHaveLength(1);
    expect(exportPackage(db, "content", { allChunks: true }).tables.source_chunk).toHaveLength(3);
  });

  it("restores a backup by replacing everything", () => {
    const a = freshDb();
    const b = freshDb();
    createSubject(a, { name: "Z kopii", exams: [] });
    updateSettings(a, { dailyMinutes: 45 });
    createSubject(b, { name: "Zniknie", exams: [] });
    importPackage(b, exportPackage(a, "backup"));
    expect(listSubjects(b).map((s) => s.name)).toEqual(["Z kopii"]);
    expect(getSettings(b).dailyMinutes).toBe(45);
  });

  it("refuses packages from a newer schema and foreign files", () => {
    const db = freshDb();
    const pkg = exportPackage(db, "content");
    expect(() => importPackage(db, { ...pkg, schemaVersion: db.schemaVersion + 1 })).toThrow(/nowszej wersji/);
    expect(() => parsePackage('{"hello":1}')).toThrow(/paczki/);
    expect(() => parsePackage("nie json")).toThrow(/JSON/);
  });
});

describe("local AI client", () => {
  const ollama: AiSettings = { provider: "ollama", baseUrl: "http://localhost:11434", model: "bielik:11b" };
  const lmStudio: AiSettings = { provider: "openai", baseUrl: "http://localhost:1234", model: "qwen" };
  const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });

  it("lists Ollama models and sees whether the chosen one is there", async () => {
    const fetchFn = (async (url: string) => {
      expect(url).toBe("http://localhost:11434/api/tags");
      return json({ models: [{ name: "bielik:11b" }, { name: "qwen3:14b" }] });
    }) as unknown as typeof fetch;
    expect(await checkAi(ollama, fetchFn)).toEqual({ ok: true, models: ["bielik:11b", "qwen3:14b"], modelAvailable: true });
  });

  it("reports an unreachable server", async () => {
    const fetchFn = (async () => {
      throw new TypeError("Failed to fetch");
    }) as unknown as typeof fetch;
    const r = await checkAi(lmStudio, fetchFn);
    expect(r.ok).toBe(false);
    expect(!r.ok && r.reason).toBe("unreachable");
  });

  it("sends the JSON schema and parses the answer (Ollama and OpenAI-compatible)", async () => {
    const schema = { type: "object", properties: { ok: { type: "boolean" } }, required: ["ok"] };
    const seen: any[] = [];
    const fetchFn = (async (url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body));
      seen.push({ url, body });
      return url.endsWith("/api/chat")
        ? json({ message: { content: '{"ok":true}' }, prompt_eval_count: 12, eval_count: 4 })
        : json({ choices: [{ message: { content: '{"ok":true}' } }], usage: { prompt_tokens: 12, completion_tokens: 4 } });
    }) as unknown as typeof fetch;

    for (const cfg of [ollama, lmStudio]) {
      const r = await chatJson<{ ok: boolean }>(cfg, { system: "s", user: "u", schema }, fetchFn);
      expect(r.value.ok).toBe(true);
      expect(r.tokensIn).toBe(12);
    }
    expect(seen[0].body.format).toEqual(schema);
    expect(seen[0].body.stream).toBe(false);
    expect(seen[1].body.response_format.json_schema.schema).toEqual(schema);
  });

  it("fails clearly on invalid JSON and on a missing model", async () => {
    const fetchFn = (async () => json({ message: { content: "to nie json" } })) as unknown as typeof fetch;
    await expect(chatJson(ollama, { system: "", user: "", schema: {} }, fetchFn)).rejects.toThrow(/JSON/);
    await expect(chatJson({ ...ollama, model: "" }, { system: "", user: "", schema: {} }, fetchFn)).rejects.toThrow(/modelu/);
  });
});
