import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import initSqlJs, { type SqlJsStatic } from "sql.js";
import * as pdfjs from "pdfjs-dist/legacy/build/pdf.mjs";
import { beforeAll, describe, expect, it } from "vitest";
import {
  abstractFromIndex,
  createSubject,
  Db,
  enqueueDocument,
  ExternalError,
  findCaseNumbers,
  importActArticles,
  importDocument,
  importJudgment,
  importScholarly,
  listDocuments,
  parseFile,
  type PdfJs,
  provisionGaps,
  searchActs,
  searchJudgments,
  searchScholarly,
  updateSettings,
} from "../src";

let SQL: SqlJsStatic;
beforeAll(async () => {
  SQL = await initSqlJs();
});

// What the three services answer (shapes as in their public APIs).
const ACT_HTML = `<html><body>
<h1>OBWIESZCZENIE MARSZAŁKA SEJMU RZECZYPOSPOLITEJ POLSKIEJ w sprawie ogłoszenia jednolitego tekstu ustawy – Kodeks cywilny</h1>
<p>Art. 117. § 1. Z zastrzeżeniem wyjątków w ustawie przewidzianych, roszczenia majątkowe ulegają przedawnieniu.</p>
<p>§ 2. Po upływie terminu przedawnienia ten, przeciwko komu przysługuje roszczenie, może uchylić się od jego zaspokojenia, chyba że zrzeka się korzystania z zarzutu przedawnienia.</p>
<p>Art. 118. Jeżeli przepis szczególny nie stanowi inaczej, termin przedawnienia wynosi sześć lat, a dla roszczeń o świadczenia okresowe oraz roszczeń związanych z prowadzeniem działalności gospodarczej – trzy lata. Jednakże koniec terminu przedawnienia przypada na ostatni dzień roku kalendarzowego, chyba że termin przedawnienia jest krótszy niż dwa lata.</p>
<p>Art. 172. § 1. Posiadacz nieruchomości niebędący jej właścicielem nabywa własność, jeżeli posiada nieruchomość nieprzerwanie od lat dwudziestu jako posiadacz samoistny, chyba że uzyskał posiadanie w złej wierze (zasiedzenie).</p>
<p>§ 2. Po upływie lat trzydziestu posiadacz nieruchomości nabywa jej własność, choćby uzyskał posiadanie w złej wierze.</p>
<p>Art. 173. Jeżeli właściciel nieruchomości jest małoletni, zasiedzenie nie może skończyć się wcześniej niż z upływem dwóch lat od uzyskania pełnoletności przez właściciela.</p>
</body></html>`;

function fakeWeb(log: string[] = []) {
  return (async (url: string) => {
    log.push(url);
    const json = (v: unknown) => new Response(JSON.stringify(v), { status: 200, headers: { "Content-Type": "application/json" } });
    if (url.includes("/eli/acts/search")) {
      return json({
        count: 2,
        items: [
          { ELI: "DU/1964/93", title: "Ustawa z dnia 23 kwietnia 1964 r. - Kodeks cywilny", type: "Ustawa", announcementDate: "1964-05-18", textHTML: false, displayAddress: "Dz.U. 1964 nr 16 poz. 93" },
          { ELI: "DU/2025/1071", title: "Obwieszczenie Marszałka Sejmu w sprawie ogłoszenia jednolitego tekstu ustawy - Kodeks cywilny", type: "Obwieszczenie", announcementDate: "2025-08-01", textHTML: true, displayAddress: "Dz.U. 2025 poz. 1071" },
        ],
      });
    }
    if (url.endsWith("/eli/acts/DU/2025/1071/text.html")) return new Response(ACT_HTML, { status: 200, headers: { "Content-Type": "text/html" } });
    if (url.includes("/api/search/judgments")) {
      return json({ items: [{ id: 412345, courtType: "SUPREME", judgmentDate: "2020-05-12", courtCases: [{ caseNumber: "III CZP 12/20" }], textContent: "<p>Uchwała...</p>" }] });
    }
    if (url.endsWith("/api/judgments/412345")) {
      return json({
        data: {
          id: 412345,
          courtType: "SUPREME",
          judgmentDate: "2020-05-12",
          courtCases: [{ caseNumber: "III CZP 12/20" }],
          textContent: "<h2>UCHWAŁA</h2><p>Bieg zasiedzenia nieruchomości nie biegnie przeciwko małoletniemu właścicielowi w sposób dowolny.</p><p>Uzasadnienie.</p>",
        },
      });
    }
    if (url.includes("api.openalex.org/works")) {
      return json({
        results: [
          {
            id: "https://openalex.org/W1",
            display_name: "Statute of limitations in comparative law",
            publication_year: 2019,
            doi: "https://doi.org/10.1/en",
            language: "en",
            authorships: [{ author: { display_name: "J. Smith" } }],
            abstract_inverted_index: { Limitation: [0], periods: [1], differ: [2], widely: [3], "across": [4], European: [5], legal: [6], systems: [7], and: [8], serve: [9], legal_certainty: [10], "in": [11], private: [12], law: [13], relations: [14], "today.": [15] },
          },
          {
            id: "https://openalex.org/W2",
            display_name: "Przedawnienie roszczeń po nowelizacji z 2018 r.",
            publication_year: 2020,
            doi: "https://doi.org/10.1/pl",
            language: "pl",
            authorships: [{ author: { display_name: "A. Kowalska" } }, { author: { display_name: "B. Nowak" } }],
            abstract_inverted_index: {
              Nowelizacja: [0], z: [1, 8], "2018": [2], "r.": [3], skróciła: [4], ogólny: [5], termin: [6], przedawnienia: [7], dziesięciu: [9], do: [10], sześciu: [11], "lat.": [12], Celem: [13], zmiany: [14], było: [15], dyscyplinowanie: [16], "wierzycieli.": [17],
            },
          },
        ],
      });
    }
    return new Response("not found", { status: 404 });
  }) as unknown as typeof fetch;
}

const blocked = (async () => {
  throw new TypeError("Failed to fetch");
}) as unknown as typeof fetch;

function setup(enabled = true) {
  const db = new Db(new SQL.Database());
  updateSettings(db, { external: { enabled } as any });
  const s = createSubject(db, { name: "Prawo cywilne", exams: [] });
  return { db, s };
}

describe("ISAP", () => {
  it("finds the consolidated text and imports only the chosen articles as a legal act source", async () => {
    const { db, s } = setup();
    const log: string[] = [];
    const hits = await searchActs(db, "Kodeks cywilny", fakeWeb(log));
    expect(hits[0]!.eli).toBe("DU/2025/1071"); // consolidated text first
    expect(hits[0]!.hasHtml).toBe(true);
    expect(log[0]).toContain("title=Kodeks%20cywilny");

    const r = await importActArticles(db, { subjectId: s.id, act: hits[0]!, articles: ["118", "172", "999"] }, fakeWeb());
    expect(r.found).toEqual(["118", "172"]);
    expect(r.missing).toEqual(["999"]);
    const doc = listDocuments(db, s.id)[0]!;
    expect(doc.kind).toBe("act");
    const act = db.get<any>("SELECT abbrev, state_as_of FROM legal_act");
    expect(act).toEqual({ abbrev: "k.c.", state_as_of: "2025-08-01" });
    const text = db.all<{ text: string }>("SELECT text FROM source_chunk").map((c) => c.text).join("\n");
    expect(text).toContain("termin przedawnienia wynosi sześć lat");
    expect(text).toContain("Po upływie lat trzydziestu");
    expect(text).not.toContain("Art. 173");
    const row = db.get<any>("SELECT url, meta_json FROM source_document");
    expect(row.url).toContain("isap.sejm.gov.pl");
    expect(JSON.parse(row.meta_json).eli).toBe("DU/2025/1071");
  });

  it("imports articles from a consolidated text published only as PDF", async () => {
    const { db, s } = setup();
    const pdf = new Uint8Array(readFileSync(fileURLToPath(new URL("./fixtures/isap-kpk-tylko-pdf.pdf", import.meta.url))));
    const log: string[] = [];
    const web = (async (url: string) => {
      log.push(url);
      if (url.includes("/eli/acts/search")) {
        return new Response(
          JSON.stringify({
            items: [
              { ELI: "DU/2024/37", title: "Obwieszczenie Marszałka Sejmu w sprawie ogłoszenia jednolitego tekstu ustawy - Kodeks postępowania karnego", announcementDate: "2023-12-07", textHTML: true, textPDF: true, displayAddress: "Dz.U. 2024 poz. 37" },
              { ELI: "DU/2026/490", title: "Obwieszczenie Marszałka Sejmu w sprawie ogłoszenia jednolitego tekstu ustawy - Kodeks postępowania karnego", announcementDate: "2026-03-27", textHTML: false, textPDF: true, displayAddress: "Dz.U. 2026 poz. 490" },
            ],
          }),
          { status: 200 },
        );
      }
      if (url.endsWith("/eli/acts/DU/2026/490/text.pdf")) return new Response(pdf, { status: 200, headers: { "Content-Type": "application/pdf" } });
      return new Response("not found", { status: 404 });
    }) as unknown as typeof fetch;
    const hits = await searchActs(db, "Kodeks postępowania karnego", web);
    expect(hits[0]).toMatchObject({ eli: "DU/2026/490", hasHtml: false, hasPdf: true }); // newest first, though PDF only
    await expect(importActArticles(db, { subjectId: s.id, act: hits[0]!, articles: ["2"] }, web)).rejects.toThrow(/czytnika PDF/);
    const r = await importActArticles(db, { subjectId: s.id, act: hits[0]!, articles: ["2", "3", "4", "5", "9"] }, web, { pdfjs: pdfjs as unknown as PdfJs });
    expect(r.found).toEqual(["2", "3", "4", "5"]);
    expect(r.missing).toEqual(["9"]);
    expect(log.at(-1)).toMatch(/text\.pdf$/);
    const text = db.all<{ text: string }>("SELECT text FROM source_chunk ORDER BY ord").map((c) => c.text).join("\n");
    // Article 2 ends where article 3 starts in the same line; a word broken at a line end is whole again.
    expect(text).toContain("na niekorzyść oskarżonego.");
    expect(text).toMatch(/Art\. 3\. Organy prowadzące postępowanie/);
    // Article 4 runs from a footnote mark to the next page's §; no page header in the text.
    expect(text).toContain("prawomocnym wyrokiem");
    expect(text).toContain("rozstrzyga się na korzyść oskarżonego");
    expect(text).not.toMatch(/Dziennik Ustaw/);
    expect(text).not.toContain("Ze zmianą wprowadzoną"); // footnote at the page bottom
    expect(text).toMatch(/Art\. 5\. \(uchylony\)/);
    expect(text).not.toContain("Art. 1.");
    expect(db.get<any>("SELECT state_as_of FROM legal_act")).toEqual({ state_as_of: "2026-03-27" });
    expect(JSON.parse(db.get<any>("SELECT meta_json FROM source_document").meta_json).format).toBe("pdf");
  });

  it("lists articles your materials mention but no imported act covers", async () => {
    const { db, s } = setup();
    const bytes = readFileSync(fileURLToPath(new URL("./fixtures/wyklad-2026-10-06.md", import.meta.url)));
    const parsed = await parseFile("wyklad.md", new Uint8Array(bytes));
    await importDocument(db, { subjectId: s.id, kind: "note", title: "W5", fileName: "wyklad.md", fileBytes: new Uint8Array(bytes), parsed });
    const before = provisionGaps(db, s.id);
    expect(before).toEqual([{ act: "kc", abbrev: "k.c.", articles: ["117", "118", "172", "174"] }]);

    const hits = await searchActs(db, "Kodeks cywilny", fakeWeb());
    await importActArticles(db, { subjectId: s.id, act: hits[0]!, articles: before[0]!.articles }, fakeWeb());
    expect(provisionGaps(db, s.id)).toEqual([{ act: "kc", abbrev: "k.c.", articles: ["174"] }]);
  });

  it("is off by default, and a blocked connection tells where to get the text by hand", async () => {
    const off = setup(false);
    await expect(searchActs(off.db, "Kodeks cywilny", fakeWeb())).rejects.toMatchObject({ kind: "disabled" });
    const { db } = setup();
    const err = await searchActs(db, "Kodeks cywilny", blocked).catch((e) => e);
    expect(err).toBeInstanceOf(ExternalError);
    expect(err.kind).toBe("blocked");
    expect(err.manualUrl).toContain("isap.sejm.gov.pl");
  });
});

describe("SAOS", () => {
  it("finds case numbers in text and imports the judgment as a source", async () => {
    expect(findCaseNumbers("Por. uchwałę SN z 12.05.2020 r., III CZP 12/20, oraz wyrok I CSK 123/19 i TK SK 12/15; Dz.U. 12/20 to nie sygnatura.")).toEqual([
      "III CZP 12/20",
      "I CSK 123/19",
      "SK 12/15",
    ]);
    const { db, s } = setup();
    const hits = await searchJudgments(db, "III CZP 12/20", fakeWeb());
    expect(hits[0]).toMatchObject({ id: 412345, caseNumber: "III CZP 12/20", date: "2020-05-12" });
    await importJudgment(db, { subjectId: s.id, id: 412345 }, fakeWeb());
    const doc = listDocuments(db, s.id)[0]!;
    expect(doc.kind).toBe("case_law");
    expect(doc.title).toContain("III CZP 12/20");
    expect(db.all<{ text: string }>("SELECT text FROM source_chunk").map((c) => c.text).join(" ")).toContain("Bieg zasiedzenia nieruchomości");
  });
});

describe("OpenAlex", () => {
  it("rebuilds abstracts, puts Polish works first, and imports one as a cited scholarly source", async () => {
    expect(abstractFromIndex({ b: [1], a: [0], c: [2] })).toBe("a b c");
    const { db, s } = setup();
    const works = await searchScholarly(db, "przedawnienie nowelizacja 2018", fakeWeb());
    expect(works[0]!.language).toBe("pl");
    expect(works[0]!.abstract).toContain("skróciła ogólny termin przedawnienia z dziesięciu do sześciu lat");
    await importScholarly(db, { subjectId: s.id, work: works[0]! });
    const doc = listDocuments(db, s.id)[0]!;
    expect(doc.kind).toBe("scholarly");
    expect(doc.title).toBe("A. Kowalska, B. Nowak (2020): Przedawnienie roszczeń po nowelizacji z 2018 r.");
    enqueueDocument(db, doc.id); // goes through the same pipeline as any source
  });
});
