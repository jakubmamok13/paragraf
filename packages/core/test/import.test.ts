import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import * as pdfjs from "pdfjs-dist/legacy/build/pdf.mjs";
import initSqlJs, { type SqlJsStatic } from "sql.js";
import { beforeAll, describe, expect, it } from "vitest";
import {
  chunkBlocks,
  createSubject,
  Db,
  deleteDocument,
  detectDate,
  extractProvisions,
  importDocument,
  listDocuments,
  locateQuote,
  numbersIn,
  parseFile,
  parseRtf,
  type PdfJs,
  SearchIndex,
  unsupportedFacts,
} from "../src";

const fixture = (name: string) => new Uint8Array(readFileSync(fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url))));
const deps = { pdfjs: pdfjs as unknown as PdfJs };

let SQL: SqlJsStatic;
beforeAll(async () => {
  SQL = await initSqlJs();
});

const allText = (blocks: { text: string }[]) => blocks.map((b) => b.text).join("\n");
const headings = (blocks: { kind: string; text: string }[]) => blocks.filter((b) => b.kind === "heading").map((b) => b.text);

describe("file formats", () => {
  for (const name of ["wyklad-2026-10-06.md", "wyklad.docx", "wyklad.odt", "wyklad.html", "wyklad.epub", "wyklad.rtf"]) {
    it(`reads the lecture note from ${name}`, async () => {
      const parsed = await parseFile(name, fixture(name), deps);
      const text = allText(parsed.blocks);
      expect(text).toContain("posiada nieruchomość nieprzerwanie od lat dwudziestu jako posiadacz samoistny");
      expect(text).toContain("złej wierze");
      expect(text).toContain("art. 172 § 2 k.c.");
      if (!name.endsWith(".rtf")) {
        // RTF from a word processor keeps headings as plain paragraphs.
        expect(headings(parsed.blocks)).toEqual(expect.arrayContaining(["Zasiedzenie", "Przedawnienie roszczeń"]));
      }
    });
  }

  it("finds the lecture date in the file name", async () => {
    expect((await parseFile("wyklad-2026-10-06.md", fixture("wyklad-2026-10-06.md"))).detectedDate).toBe("2026-10-06");
    expect(detectDate("Wykład z 6 października 2026")).toBe("2026-10-06");
    expect(detectDate("notatka 13.11.2026")).toBe("2026-11-13");
  });

  it("reads a textbook PDF: headings, printed page numbers, no running headers", async () => {
    const parsed = await parseFile("podrecznik-2015.pdf", fixture("podrecznik-2015.pdf"), deps);
    expect(parsed.paged).toBe(true);
    expect(headings(parsed.blocks)).toEqual(["Rozdział VIII. Przedawnienie roszczeń", "1. Pojęcie i cel przedawnienia", "2. Terminy przedawnienia"]);
    const text = allText(parsed.blocks);
    expect(text).not.toContain("Prawo cywilne – część ogólna");
    expect(text).toContain("Termin przedawnienia wynosi dziesięć lat");
    const term = parsed.blocks.find((b) => b.text.includes("dziesięć lat"))!;
    expect(term.page).toBeGreaterThanOrEqual(41); // printed page, not the file's page 1–2
    expect(parsed.blocks.some((b) => /^\d+$/.test(b.text))).toBe(false);
  });

  it("reads a Pages file through its preview, and explains when there is none", async () => {
    const parsed = await parseFile("notatka.pages", fixture("notatka.pages"), deps);
    expect(allText(parsed.blocks)).toContain("od lat trzech jako posiadacz samoistny");
    await expect(parseFile("bez-podgladu.pages", fixture("bez-podgladu.pages"), deps)).rejects.toThrow(/Eksportuj do → Word/);
  });

  it("reads Polish letters from a Windows-1250 RTF", () => {
    const blocks = parseRtf("{\\rtf1\\ansi\\ansicpg1250{\\fonttbl{\\f0 Times;}}\\f0 Zasiedzenie w z\\'b3ej wierze \\'9cwiadczenie\\par Drugi akapit}");
    expect(blocks.map((b) => b.text)).toEqual(["Zasiedzenie w złej wierze świadczenie", "Drugi akapit"]);
  });

  it("refuses unknown and old formats with a clear message", async () => {
    await expect(parseFile("notatka.doc", new Uint8Array([1, 2, 3]))).rejects.toThrow(/\.docx/);
    await expect(parseFile("plik.xyz", new Uint8Array([1]))).rejects.toThrow(/Nieobsługiwany/);
  });
});

describe("chunks", () => {
  it("keeps the heading path and never mixes sections", async () => {
    const parsed = await parseFile("wyklad.docx", fixture("wyklad.docx"));
    const chunks = chunkBlocks(parsed.blocks);
    expect(chunks.length).toBeGreaterThanOrEqual(2);
    expect(chunks[0]!.headingPath).toEqual(["Wykład 5 – Zasiedzenie i przedawnienie", "Zasiedzenie"]);
    expect(chunks.find((c) => c.text.includes("sześć lat"))!.headingPath.at(-1)).toBe("Przedawnienie roszczeń");
    for (const c of chunks) expect(c.text.length).toBeLessThanOrEqual(2500);
  });

  it("splits a very long paragraph at sentence ends", () => {
    const long = "To jest zdanie o przedawnieniu roszczeń majątkowych. ".repeat(120);
    const chunks = chunkBlocks([{ kind: "para", text: long }]);
    expect(chunks.length).toBeGreaterThan(2);
    for (const c of chunks) expect(c.text.endsWith(".")).toBe(true);
  });
});

describe("documents", () => {
  it("imports once, skips the same file, and re-imports a changed note incrementally", async () => {
    const db = new Db(new SQL.Database());
    const s = createSubject(db, { name: "Prawo cywilne", exams: [] });
    const bytes = fixture("wyklad-2026-10-06.md");
    const parsed = await parseFile("wyklad-2026-10-06.md", bytes);
    const r1 = await importDocument(db, { subjectId: s.id, kind: "note", title: "Wykład 5", fileName: "wyklad-2026-10-06.md", fileBytes: bytes, parsed, lectureDate: "2026-10-06" });
    expect(r1.newChunks).toBe(r1.chunks);
    expect((await importDocument(db, { subjectId: s.id, kind: "note", title: "Wykład 5", fileName: "wyklad-2026-10-06.md", fileBytes: bytes, parsed })).duplicate).toBe(true);

    db.run("UPDATE source_chunk SET processed_at = '2026-10-06T12:00:00Z'");
    const extended = new TextEncoder().encode(`${new TextDecoder().decode(bytes)}\n\n## Dodatek\n\nNowy akapit dopisany po wykładzie o zawieszeniu biegu przedawnienia.\n`);
    const r2 = await importDocument(db, {
      subjectId: s.id,
      kind: "note",
      title: "Wykład 5",
      fileName: "wyklad-2026-10-06.md",
      fileBytes: extended,
      parsed: await parseFile("wyklad-2026-10-06.md", extended),
    });
    expect(r2.version).toBe(2);
    expect(r2.newChunks).toBe(1);
    expect(db.get<{ n: number }>("SELECT COUNT(*) AS n FROM source_chunk WHERE processed_at IS NULL")!.n).toBe(1);
    expect(listDocuments(db, s.id)[0]).toMatchObject({ version: 2, chunks: r2.chunks, processed: r2.chunks - 1 });

    deleteDocument(db, r1.documentId);
    expect(listDocuments(db, s.id)).toHaveLength(0);
  });

  it("needs an abbreviation for a legal act", async () => {
    const db = new Db(new SQL.Database());
    const s = createSubject(db, { name: "Prawo cywilne", exams: [] });
    const bytes = new TextEncoder().encode("Art. 118. Termin przedawnienia wynosi sześć lat.");
    const parsed = await parseFile("kc.txt", bytes);
    await expect(importDocument(db, { subjectId: s.id, kind: "act", title: "Kodeks cywilny", fileName: "kc.txt", fileBytes: bytes, parsed })).rejects.toThrow(/skrót/);
    await importDocument(db, { subjectId: s.id, kind: "act", title: "Kodeks cywilny", fileName: "kc.txt", fileBytes: bytes, parsed, act: { abbrev: "k.c.", stateAsOf: "2026-09-01" } });
    expect(db.get("SELECT abbrev, state_as_of FROM legal_act")).toEqual({ abbrev: "k.c.", state_as_of: "2026-09-01" });
  });
});

describe("legal helpers", () => {
  it("recognises provisions, ranges and acts", () => {
    const ps = extractProvisions("Zob. art. 172 § 2 k.c., art. 5 pkt 3 kpc oraz art. 172–174 k.c.");
    expect(ps.map((p) => `${p.article}|${p.paragraph}|${p.point}|${p.act}`)).toEqual([
      "172|2|null|kc",
      "5|null|3|kpc",
      "172|null|null|kc",
      "173|null|null|kc",
      "174|null|null|kc",
    ]);
  });

  it("reads numbers written as words", () => {
    expect([...numbersIn("od lat dwudziestu, a po upływie lat trzydziestu; jedno z nich")]).toEqual(["20", "30"]);
  });

  it("flags numbers and article numbers that are not in the source", () => {
    const source = "Po upływie lat trzydziestu posiadacz nieruchomości nabywa jej własność (art. 172 § 2 k.c.).";
    expect(unsupportedFacts("Zasiedzenie w złej wierze: 30 lat (art. 172 § 2 k.c.)", source)).toEqual([]);
    expect(unsupportedFacts("Zasiedzenie w złej wierze: 30 lat (art. 176 k.c.)", source)).toEqual(["art. 176 k.c."]);
    expect(unsupportedFacts("Zasiedzenie w złej wierze: 25 lat", source)).toEqual(["25"]);
  });

  it("locates quotes exactly or nearly, in the source's own wording", () => {
    const text = "Według art. 172 § 2 k.c. po upływie lat trzydziestu posiadacz nieruchomości nabywa jej własność, choćby uzyskał posiadanie w złej wierze.";
    expect(locateQuote("po upływie lat  trzydziestu posiadacz nieruchomości", text)?.text).toBe("po upływie lat trzydziestu posiadacz nieruchomości");
    expect(locateQuote("po upływie lat trzydziestu posiadacz nieruchomości nabywa jego własność", text)).not.toBeNull();
    expect(locateQuote("Zasiedzenie wymaga tytułu prawnego do rzeczy", text)).toBeNull();
  });

  it("searches fragments despite Polish inflection", () => {
    const idx = new SearchIndex([
      { id: "a", text: "Zasiedzenie nieruchomości następuje po upływie lat dwudziestu." },
      { id: "b", text: "Przedawnienie roszczeń majątkowych." },
    ]);
    expect(idx.search("zasiedzeniu nieruchomości")[0]!.id).toBe("a");
    expect(idx.search("przedawnieniem roszczenia")[0]!.id).toBe("b");
  });
});
