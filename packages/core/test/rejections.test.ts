// Why fields are rejected at analysis, and that true ones are no longer lost:
// a sentence cut between two fragments, a word broken at a line end. A
// definition the model wrote from its own knowledge stays rejected, with the
// reason and the closest sentence of the source shown.
import initSqlJs from "sql.js";
import { describe, expect, it } from "vitest";
import { createSubject, Db, importDocument, listSuggestions, recheckRejected, validateExtraction } from "../src";

const claim = "Proces karny to system organizacyjny sądownictwa karnego, który obejmuje etapy od zgłoszenia przestępstwa do jego rozstrzygnięcia.";
const out = (text: string, quote = text) => ({ topics: [{ name: "Proces karny", fields: [{ type: "definition", definition_kind: "doctrinal", text, quote }] }] }) as any;

describe("validating what the model extracted", () => {
  it("keeps the whole word broken at a line end", () => {
    const src = "Proces karny to system organizacyjny sądownictwa karnego, który obejmuje etapy od zgłoszenia przestęp-\nstwa do jego rozstrzyg-\nnięcia.";
    const v = validateExtraction(out(claim), src);
    expect(v.topics[0]!.fields[0]!.quote).toMatch(/rozstrzyg-\nnięcia$/);
  });

  it("finds a sentence cut by the edge of the fragment and cites the right fragment", () => {
    const before = "Wykład 1. Zagadnienia wstępne. Proces karny to system organizacyjny sądownictwa karnego, który obejmuje";
    const chunk = "etapy od zgłoszenia przestępstwa do jego rozstrzygnięcia. Zasady procesu omówimy dalej.";
    expect(validateExtraction(out(claim), chunk).topics).toHaveLength(0);
    const v = validateExtraction(out(claim), chunk, { before });
    const f = v.topics[0]!.fields[0]!;
    expect(f.where).toBe("here");
    expect(f.quote).toContain("Proces karny to system");
    expect(f.quote).toContain("rozstrzygnięcia");
    // Wholly in the next fragment: cited there.
    const w = validateExtraction(out(claim), "Wstęp do przedmiotu.", { after: claim }).topics[0]!.fields[0]!;
    expect(w.where).toBe("after");
    expect(claim.slice(w.start, w.end)).toBe(w.quote);
  });

  it("rejects a definition the source does not give, saying why and what is closest", () => {
    const src = "Proces karny – etapy: postępowanie przygotowawcze (śledztwo, dochodzenie), postępowanie jurysdykcyjne, postępowanie wykonawcze.";
    const v = validateExtraction(out(claim), src);
    expect(v.topics).toHaveLength(0);
    const reason = v.rejected[0]!.reason;
    expect(reason).toMatch(/własne zdanie/);
    expect(reason).toMatch(/najbliżej w źródle \(\d+% słów\): „Proces karny – etapy/);
    // A real quote of the model is shown in full, not cut at 120 characters.
    const long = `${"Ala ma kota i psa oraz rybki w akwarium. ".repeat(4)}Koniec.`;
    expect(validateExtraction(out("Coś zupełnie innego o procesie karnym i sądach.", long), src).rejected[0]!.reason).toContain("Koniec.");
  });

  it("does not let numbers in through the neighbouring fragment that the sentence does not hold", () => {
    const v = validateExtraction(out("Zasiedzenie w złej wierze następuje po 30 latach.", "Zasiedzenie w złej wierze następuje po latach"), "Zasiedzenie w złej wierze następuje po latach.", { after: "Rok 2030 to przykład." });
    expect(v.topics).toHaveLength(0);
    expect(v.rejected[0]!.reason).toMatch(/30/);
  });
});

describe("checking rejected fields again", () => {
  it("closes their suggestions and queues their fragments for another reading", async () => {
    const SQL = await initSqlJs();
    const db = new Db(new SQL.Database());
    const s = createSubject(db, { name: "Postępowanie karne", exams: [] });
    const { documentId } = await importDocument(db, {
      subjectId: s.id,
      kind: "note",
      title: "Wykład 1",
      fileName: "w1.txt",
      fileBytes: new TextEncoder().encode("x"),
      parsed: { title: "Wykład 1", blocks: [{ kind: "paragraph", text: "Proces karny – etapy postępowania." }] } as any,
      lectureDate: null,
    });
    const chunk = db.get<{ id: string }>("SELECT id FROM source_chunk WHERE document_id = ?", documentId)!;
    db.run("UPDATE source_chunk SET processed_at = '2026-10-01' WHERE id = ?", chunk.id);
    db.run("UPDATE job SET status = 'done'");
    db.run(
      "INSERT INTO suggestion (id, subject_id, chunk_id, kind, text, created_at, updated_at) VALUES ('g1', ?, ?, 'rejected_field', 'Proces karny: „x” (powód)', '', '')",
      s.id,
      chunk.id,
    );
    expect(recheckRejected(db)).toEqual({ chunks: 1, documents: 1 });
    expect(listSuggestions(db)).toHaveLength(0);
    expect(db.get<{ p: string | null }>("SELECT processed_at AS p FROM source_chunk WHERE id = ?", chunk.id)!.p).toBeNull();
    expect(db.get<{ n: number }>("SELECT COUNT(*) AS n FROM job WHERE document_id = ? AND kind = 'extract' AND status = 'queued'", documentId)!.n).toBe(1);
  });
});
