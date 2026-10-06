// How well quotes written by a small model are found in the source. Small
// models rarely copy character for character: they drop Polish letters, skip
// or add a word, write "§2" for "§ 2", cut the middle with "…". Such quotes
// must be found; invented ones must not.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { locateQuote, supportingPassage } from "../src";

const note = readFileSync(fileURLToPath(new URL("./fixtures/wyklad-2026-10-06.md", import.meta.url)), "utf8").replace(/^#.*$/gm, "").trim();
const sentences = note.split(/(?<=[.!?])\s+/).map((s) => s.trim()).filter((s) => s.split(" ").length >= 6);

const stripPolish = (s: string) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/ł/g, "l").replace(/Ł/g, "L");
const words = (s: string) => s.split(" ");
const PERTURB: Record<string, (s: string) => string> = {
  "brak polskich znaków": stripPolish,
  "pominięte słowo": (s) => {
    const w = words(s);
    w.splice(Math.floor(w.length / 2), 1);
    return w.join(" ");
  },
  "dodane słowo": (s) => {
    const w = words(s);
    w.splice(Math.floor(w.length / 3), 0, "właśnie");
    return w.join(" ");
  },
  "zmieniona interpunkcja": (s) => s.replace(/§ /g, "§").replace(/,/g, "").replace(/–/g, "-").replace(/\.$/, ""),
  "wielokropek w środku": (s) => {
    const w = words(s);
    return [...w.slice(0, 4), "(…)", ...w.slice(-4)].join(" ");
  },
  "ligatury i cudzysłowy": (s) => `"${s.replace(/fi/g, "ﬁ")}"`,
  "inna odmiana słowa": (s) => s.replace(/nieruchomość\b/, "nieruchomości").replace(/posiadanie\b/, "posiadania"),
};

describe("quotes from a small model", () => {
  it("finds every honest but inexact quote", () => {
    const misses: string[] = [];
    let total = 0;
    for (const s of sentences) {
      for (const [name, f] of Object.entries(PERTURB)) {
        total++;
        const loc = locateQuote(f(s), note);
        if (!loc || !note.slice(loc.start, loc.end).includes(s.split(" ")[1]!)) misses.push(`${name}: ${f(s)}`);
      }
    }
    const byKind: Record<string, number> = {};
    for (const m of misses) byKind[m.split(":")[0]!] = (byKind[m.split(":")[0]!] ?? 0) + 1;
    console.log(`QUOTES found ${total - misses.length}/${total}`, byKind);
    expect(misses, misses.join("\n")).toEqual([]);
    expect(total).toBeGreaterThan(50);
  });

  it("still rejects invented quotes", () => {
    for (const fake of [
      "Zasiedzenie wymaga tytułu prawnego do rzeczy",
      "Termin przedawnienia roszczeń o zachowek wynosi pięć lat od ogłoszenia testamentu",
      "Posiadacz w dobrej wierze nabywa własność ruchomości z chwilą jej wydania",
      "Przedawnienie powoduje wygaśnięcie roszczenia z mocy prawa",
    ]) {
      expect(locateQuote(fake, note), fake).toBeNull();
    }
  });

  it("returns the source's own wording, not the model's", () => {
    const loc = locateQuote("po uplywie lat trzydziestu posiadacz nieruchomosci nabywa jej wlasnosc", note)!;
    expect(note.slice(loc.start, loc.end)).toBe("po upływie lat trzydziestu posiadacz nieruchomości nabywa jej własność");
  });

  it("finds the passage that backs a claim when the model's quote is unusable", () => {
    const p = supportingPassage("Przesłanki zasiedzenia nieruchomości: posiadanie samoistne i nieprzerwany upływ czasu", note);
    expect(p?.text).toContain("Przesłankami zasiedzenia nieruchomości są posiadanie samoistne");
    expect(supportingPassage("Zasiedzenie wymaga tytułu prawnego i wpisu do księgi wieczystej", note)).toBeNull();
  });
});
