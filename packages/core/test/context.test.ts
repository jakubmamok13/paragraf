// A model whose context window is smaller than the prompt used to be: the
// server refused the request ("the prompt is longer than the context
// length…"), the queue stopped and a lecture note gave no cards at all.
// Prompts are now built for the window there is, retried shorter when the
// server still refuses, and the note gives its cards.
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import initSqlJs, { type SqlJsStatic } from "sql.js";
import { beforeAll, describe, expect, it } from "vitest";
import { createSubject, Db, enqueueDocument, importDocument, listJobs, loadPrompts, parseFile, runQueue, splitText, updateSettings } from "../src";
import { FAKE_MODELS, fakeLmStudio } from "./fake-model";

const here = (p: string) => fileURLToPath(new URL(p, import.meta.url));
const promptsDir = here("../../../prompts/");
const prompts = loadPrompts(readdirSync(promptsDir).map((f) => readFileSync(promptsDir + f, "utf8")));

let SQL: SqlJsStatic;
beforeAll(async () => {
  SQL = await initSqlJs();
});

// A long lecture note: the sample note with a long digression after every paragraph, so a
// topic's facts are spread over many full fragments (as in a real 3rd-year lecture).
const FILLER =
  "Na marginesie prowadzący omówił szerzej tło historyczne instytucji, przytaczając rozwiązania prawa rzymskiego, " +
  "dawnego prawa polskiego i kodyfikacji zaborczych, a także poglądy przedwojennej nauki. Zwrócił uwagę, że wiele " +
  "współczesnych sporów ma źródło w odmiennym rozumieniu podstawowych pojęć, dlatego przed egzaminem warto przeczytać " +
  "odpowiedni rozdział podręcznika i porównać go z notatkami z ćwiczeń. ";
const note = readFileSync(here("./fixtures/wyklad-2026-10-06.md"), "utf8")
  .split(/\n\n/)
  .map((p) => (p.startsWith("#") ? p : `${p}\n\n${FILLER.repeat(3)}`))
  .join("\n\n");

async function run(window: number, opts: { report?: boolean; contextSetting?: number; port: number }) {
  const db = new Db(new SQL.Database());
  updateSettings(db, { ai: { provider: "openai", baseUrl: `http://localhost:${opts.port}`, model: FAKE_MODELS[0]!, contextLength: opts.contextSetting ?? 0 } });
  const s = createSubject(db, { name: "Prawo cywilne", exams: [] });
  const bytes = new TextEncoder().encode(note);
  const parsed = await parseFile("wyklad-dlugi.md", bytes);
  const { documentId } = await importDocument(db, { subjectId: s.id, kind: "note", title: "Wykład 5", fileName: "wyklad-dlugi.md", fileBytes: bytes, parsed, lectureDate: "2026-10-06" });
  enqueueDocument(db, documentId);
  const log: { promptTokens: number; maxTokens: number; refused: boolean }[] = [];
  const result = await runQueue(db, { prompts, fetchFn: fakeLmStudio(window, { log, ...(opts.report !== undefined ? { report: opts.report } : {}) }) });
  const cards = db.get<{ n: number }>("SELECT COUNT(*) AS n FROM material")!.n;
  const chunks = db.get<{ n: number }>("SELECT COUNT(*) AS n FROM source_chunk")!.n;
  return { db, result, log, cards, chunks };
}

describe("prompts fit the model's context window", () => {
  it("a long note on a model loaded with 4096 tokens gives cards, with no request refused", async () => {
    const r = await run(4096, { port: 1001 });
    expect(r.chunks).toBeGreaterThan(5);
    expect(r.result.stoppedBy).toBe("empty");
    expect(listJobs(r.db).filter((j) => j.status === "error")).toHaveLength(0);
    expect(r.log.some((x) => x.refused)).toBe(false);
    expect(r.cards).toBeGreaterThan(5);
    expect(Math.max(...r.log.map((x) => x.promptTokens + x.maxTokens))).toBeLessThanOrEqual(4096);
  });

  it("when the server does not say its window and it is smaller than assumed, refused prompts are rebuilt shorter", async () => {
    const r = await run(3000, { report: false, port: 1002 });
    expect(r.log.some((x) => x.refused)).toBe(true);
    expect(r.result.stoppedBy).toBe("empty");
    expect(r.cards).toBeGreaterThan(5);
  });

  it("the window set by hand is used", async () => {
    const r = await run(3000, { report: false, contextSetting: 3000, port: 1003 });
    expect(r.log.some((x) => x.refused)).toBe(false);
    expect(r.cards).toBeGreaterThan(5);
  });

  it("a window too small for any prompt stops with advice on what to change", async () => {
    const r = await run(1500, { port: 1004 });
    expect(r.result.stoppedBy).toBe("error");
    expect(r.result.error).toMatch(/za mały kontekst \(1500 tokenów\).*LM Studio.*Context Length/);
  });
});

describe("cutting a fragment into pieces", () => {
  it("cuts at paragraph and sentence ends, never loses text", () => {
    const text = "Pierwsze zdanie. Drugie zdanie jest dłuższe.\n\nNowy akapit; z wyliczeniem: punkt.";
    const pieces = splitText(text, 30);
    expect(pieces.every((p) => p.length <= 30)).toBe(true);
    expect(pieces.join(" ").replace(/\s+/g, "")).toBe(text.replace(/\s+/g, ""));
    expect(splitText(text, 1000)).toEqual([text]);
  });
});
