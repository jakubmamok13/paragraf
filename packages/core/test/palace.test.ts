import initSqlJs, { type SqlJsStatic } from "sql.js";
import { beforeAll, describe, expect, it } from "vitest";
import {
  addManualMaterial,
  CONCRETE_WORDS,
  courseStatus,
  createSubject,
  currentStage,
  Db,
  drawWords,
  exportPackage,
  importPackage,
  INTRO_QUIZ,
  listPalaces,
  placeableLists,
  placeList,
  placementsFor,
  recentWords,
  recordDrill,
  samePhrase,
  sameWord,
  savePalace,
  scoreRecall,
} from "../src";

let SQL: SqlJsStatic;
beforeAll(async () => {
  SQL = await initSqlJs();
});
const fresh = () => new Db(new SQL.Database());
const ROUTE = ["drzwi wejściowe", "wieszak", "lustro", "szafka na buty", "kuchenka", "lodówka", "zlew", "okno", "kanapa", "telewizor"];

describe("palaces", () => {
  it("saves a route in walking order and refuses repeated or too few loci", () => {
    const db = fresh();
    expect(() => savePalace(db, { name: "Dom", loci: ["a", "b"] })).toThrow(/co najmniej 5/);
    expect(() => savePalace(db, { name: "Dom", loci: ["lustro", "Lustro", "c", "d", "e"] })).toThrow(/powtarza/);
    const id = savePalace(db, { name: "Moje mieszkanie", loci: ROUTE });
    expect(listPalaces(db)[0]!.loci.map((l) => l.name)).toEqual(ROUTE);
    // Extending keeps the loci that were there (placements point at them).
    const firstLocus = listPalaces(db)[0]!.loci[0]!.id;
    savePalace(db, { id, name: "Moje mieszkanie", loci: [...ROUTE, "balkon", "sypialnia"] });
    expect(listPalaces(db)[0]!.loci).toHaveLength(12);
    expect(listPalaces(db)[0]!.loci[0]!.id).toBe(firstLocus);
  });
});

describe("scoring", () => {
  it("forgives Polish letters, case, typos and endings, but not another word", () => {
    expect(sameWord("żyrafa", "Zyrafa")).toBe(true);
    expect(sameWord("pomarańcza", "pomarancze")).toBe(true);
    expect(sameWord("parasol", "parsol")).toBe(true);
    expect(sameWord("koń", "kot")).toBe(false);
    expect(sameWord("zasiedzenie", "przedawnienie")).toBe(false);
    expect(scoreRecall(["jabłko", "lampa", "sowa"], ["jablko", "", "sowa"])).toEqual({ correct: 2, perItem: [true, false, true] });
    expect(samePhrase("nieprzerwany upływ czasu określonego w ustawie", "nieprzerwany uplyw czasu")).toBe(true);
    expect(samePhrase("posiadanie samoistne", "dobra wiara")).toBe(false);
  });

  it("draws lists from the word bank, avoiding words used recently", () => {
    const a = drawWords(CONCRETE_WORDS, 10, 42);
    expect(new Set(a).size).toBe(10);
    expect(drawWords(CONCRETE_WORDS, 10, 42)).toEqual(a);
    const db = fresh();
    recordDrill(db, { stage: 5, kind: "words", size: 10, correct: 10, detail: { words: a } });
    const b = drawWords(CONCRETE_WORDS, 10, 43, recentWords(db));
    expect(b.some((w) => a.includes(w))).toBe(false);
  });
});

describe("course", () => {
  it("unlocks stages one by one as their criteria are met", () => {
    const db = fresh();
    expect(currentStage(db).stage).toBe(1);
    expect(courseStatus(db).filter((s) => s.unlocked).map((s) => s.stage)).toEqual([1]);

    recordDrill(db, { stage: 1, kind: "quiz", size: INTRO_QUIZ.length, correct: INTRO_QUIZ.length });
    expect(currentStage(db).stage).toBe(2);
    const palaceId = savePalace(db, { name: "Dom", loci: ROUTE });
    expect(currentStage(db).stage).toBe(3);

    recordDrill(db, { stage: 3, kind: "route_forward", size: 10, correct: 10, palaceId });
    recordDrill(db, { stage: 3, kind: "route_backward", size: 10, correct: 10, palaceId });
    expect(currentStage(db).progress).toBe("w przód 1/2, wstecz 1/1");
    recordDrill(db, { stage: 3, kind: "route_forward", size: 10, correct: 9, palaceId }); // not perfect
    expect(currentStage(db).stage).toBe(3);
    recordDrill(db, { stage: 3, kind: "route_forward", size: 10, correct: 10, palaceId });
    expect(currentStage(db).stage).toBe(4);

    for (let i = 0; i < 5; i++) recordDrill(db, { stage: 4, kind: "images", size: 4, correct: i === 0 ? 2 : 4 });
    expect(currentStage(db).stage).toBe(4); // one image had only 2 of 4 features
    recordDrill(db, { stage: 4, kind: "images", size: 4, correct: 3 });
    expect(currentStage(db).stage).toBe(5);

    recordDrill(db, { stage: 5, kind: "words", size: 10, correct: 9 });
    recordDrill(db, { stage: 5, kind: "words", size: 10, correct: 10 });
    expect(currentStage(db).stage).toBe(6);
    recordDrill(db, { stage: 6, kind: "words", size: 20, correct: 19 });
    expect(currentStage(db).progress).toContain("rozbuduj trasę do 20 miejsc"); // the route has only 10 loci
    savePalace(db, { id: palaceId, name: "Dom", loci: [...ROUTE, ...Array.from({ length: 10 }, (_, i) => `miejsce ${i + 11}`)] });
    expect(currentStage(db).stage).toBe(7);
    recordDrill(db, { stage: 7, kind: "terms", size: 8, correct: 7 });
    expect(currentStage(db).stage).toBe(8);
    recordDrill(db, { stage: 8, kind: "material", size: 3, correct: 3 });
    expect(currentStage(db).stage).toBe(9);
    expect(courseStatus(db).every((s) => s.unlocked)).toBe(true);
  });

  it("places a list of premises in a palace and carries it to the laptop with the progress", () => {
    const phone = fresh();
    const laptop = fresh();
    const s = createSubject(laptop, { name: "Prawo cywilne", exams: [] });
    const { id: materialId } = addManualMaterial(laptop, {
      subjectId: s.id,
      topicName: "Zasiedzenie",
      type: "list",
      payload: { prompt: "Wymień przesłanki zasiedzenia", items: ["posiadanie samoistne", "upływ czasu", "nieprzerwane posiadanie"] },
    });
    importPackage(phone, exportPackage(laptop, "content"));
    expect(placeableLists(phone)[0]!.materialId).toBe(materialId);

    const palaceId = savePalace(phone, { name: "Dom", loci: ROUTE });
    const loci = listPalaces(phone)[0]!.loci;
    expect(() => placeList(phone, { materialId, palaceId, items: [0, 1].map((i) => ({ itemIndex: i, locusId: loci[0]!.id, image: "x" })) })).toThrow(/inne miejsce/);
    placeList(phone, {
      materialId,
      palaceId,
      items: [
        { itemIndex: 0, locusId: loci[0]!.id, image: "Ktoś rozsiada się w drzwiach jak właściciel" },
        { itemIndex: 1, locusId: loci[1]!.id, image: "Na wieszaku wisi klepsydra, piasek się sypie" },
        { itemIndex: 2, locusId: loci[2]!.id, image: "Lustro, którego nikt nie może rozbić" },
      ],
    });
    const p = placementsFor(phone, materialId)!;
    expect(p.palaceName).toBe("Dom");
    expect(p.placements.map((x) => x.locusName)).toEqual(["drzwi wejściowe", "wieszak", "lustro"]);

    recordDrill(phone, { stage: 8, kind: "material", size: 3, correct: 3, palaceId });
    importPackage(laptop, exportPackage(phone, "progress"));
    expect(placementsFor(laptop, materialId)!.placements).toHaveLength(3);
    expect(laptop.get<{ n: number }>("SELECT COUNT(*) AS n FROM palace_drill")!.n).toBe(1);
  });
});
