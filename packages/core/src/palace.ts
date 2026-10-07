// The memory palace (method of loci) course: palaces and their loci, the
// guided stages with a pass criterion each, drills and their scoring, and
// placing items of your own lists at loci.
//
// Evidence the course is built on (details in docs/MNEMOTECHNIKI.md):
// - meta-analysis of 13 RCTs: medium effect, g = 0.65 (Twomey & Kroneisen 2021);
// - 6 weeks of training gave durable gains still visible after 4 months
//   (Wagner, Dresler et al. 2021, Science Advances);
// - interactive, vivid images roughly double recall of pairs (Bower 1970);
// - students who built a palace on a familiar route recalled ordered lists
//   better (McCabe 2015); used for abstract material too (Qureshi 2014);
// - it works best for ordered lists; it costs time and does not replace
//   retrieval practice (Dunlosky et al. 2013), so it complements the cards.
import { type Db, newId, nowIso } from "./db";
import { recordTombstone } from "./subjects";

// ---------- palaces ----------

export interface Locus {
  id: string;
  ord: number;
  name: string;
}
export interface Palace {
  id: string;
  name: string;
  description: string | null;
  loci: Locus[];
}

export function listPalaces(db: Db): Palace[] {
  return db.all<{ id: string; name: string; description: string | null }>("SELECT id, name, description FROM palace ORDER BY created_at").map((p) => ({
    ...p,
    loci: db.all<Locus>("SELECT id, ord, name FROM locus WHERE palace_id = ? ORDER BY ord", p.id),
  }));
}

export function getPalace(db: Db, id: string): Palace | undefined {
  return listPalaces(db).find((p) => p.id === id);
}

function cleanLoci(names: string[]): string[] {
  const out = names.map((n) => n.replace(/\s+/g, " ").trim()).filter(Boolean);
  const seen = new Set<string>();
  for (const n of out) {
    const k = fold(n);
    if (seen.has(k)) throw new Error(`Miejsce „${n}” powtarza się. Każde miejsce na trasie musi być inne.`);
    seen.add(k);
  }
  return out;
}

/** A palace is a route you know well, with loci in walking order. */
export function savePalace(db: Db, input: { id?: string; name: string; description?: string; loci: string[] }): string {
  const name = input.name.trim();
  if (!name) throw new Error("Nazwij pałac, np. „Moje mieszkanie”.");
  const loci = cleanLoci(input.loci);
  if (loci.length < 5) throw new Error("Wpisz co najmniej 5 miejsc na trasie.");
  const now = nowIso();
  const id = input.id ?? newId();
  db.tx(() => {
    if (input.id) {
      db.run("UPDATE palace SET name = ?, description = ?, updated_at = ? WHERE id = ?", name, input.description?.trim() || null, now, id);
    } else {
      db.run("INSERT INTO palace (id, name, description, created_at, updated_at) VALUES (?, ?, ?, ?, ?)", id, name, input.description?.trim() || null, now, now);
    }
    // Keep loci that stay (placements point at them); rename/reorder by position.
    const existing = db.all<{ id: string }>("SELECT id FROM locus WHERE palace_id = ? ORDER BY ord", id);
    loci.forEach((n, i) => {
      const prev = existing[i];
      if (prev) db.run("UPDATE locus SET ord = ?, name = ?, updated_at = ? WHERE id = ?", i, n, now, prev.id);
      else db.run("INSERT INTO locus (id, palace_id, ord, name, updated_at) VALUES (?, ?, ?, ?, ?)", newId(), id, i, n, now);
    });
    for (const extra of existing.slice(loci.length)) {
      db.run("DELETE FROM locus WHERE id = ?", extra.id);
      recordTombstone(db, "locus", extra.id);
    }
  });
  return id;
}

export function deletePalace(db: Db, id: string): void {
  db.tx(() => {
    db.run("DELETE FROM palace WHERE id = ?", id);
    recordTombstone(db, "palace", id);
  });
}

// ---------- word banks ----------

/** Concrete, easy to picture Polish nouns for the training lists. */
export const CONCRETE_WORDS = (
  "jabłko parasol młotek kaczka rower świeca żyrafa kapelusz banan krawat słoń trąbka gitara pomarańcza kaktus lampa " +
  "rakieta skarpetka balon pingwin czajnik nożyczki ślimak korona drabina wiadro pędzel arbuz koń szczotka zegar " +
  "żaba latarnia kanapka miotła ogórek telefon tygrys walizka orzech piłka motyl łódka kotwica dywan widelec cytryna " +
  "kogut kowadło ser lizak harfa wieloryb maska kostka pizza bęben grzebień sowa ołówek klucz kalosz parasolka mrówka " +
  "rękawica torba kangur papuga kamień beczka miecz tort jajko chmura księżyc rogal gwizdek pióro róża sanki bałwan " +
  "kometa lew wąż marchewka pociąg traktor wiatrak zamek globus magnes kompas strzała tarcza ananas szalik łyżwy kran " +
  "lodówka poduszka fotel krab ośmiornica jeż dzwon gruszka wózek namiot ognisko kwiat sztanga hamak kubek lustro"
).split(" ");

/** Legal terms for practising substitute images; the first ones come with an example. */
export const LEGAL_TERMS: { term: string; example?: string }[] = [
  { term: "zasiedzenie", example: "Ktoś SIEDZI na dachu cudzego domu z kalendarzem, który odlicza 20 i 30 lat." },
  { term: "przedawnienie", example: "Dłużnik zamyka przed wierzycielem drzwi z napisem „ZA PÓŹNO”, a kalendarz za nim spada." },
  { term: "potrącenie" },
  { term: "odnowienie" },
  { term: "nieważność bezwzględna" },
  { term: "bezskuteczność zawieszona" },
  { term: "zadatek" },
  { term: "kara umowna" },
  { term: "służebność gruntowa" },
  { term: "hipoteka" },
  { term: "zachowek" },
  { term: "pełnomocnictwo" },
  { term: "obrona konieczna" },
  { term: "stan wyższej konieczności" },
  { term: "usiłowanie nieudolne" },
  { term: "recydywa" },
];

/** Simple seeded shuffle, so a drill can be repeated with the same list. */
export function drawWords(pool: string[], n: number, seed: number, avoid: Set<string> = new Set()): string[] {
  let x = seed || 1;
  const rnd = () => {
    x = (x * 1103515245 + 12345) & 0x7fffffff;
    return x / 0x7fffffff;
  };
  const fresh = pool.filter((w) => !avoid.has(w));
  const src = fresh.length >= n ? fresh : pool;
  const a = [...src];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [a[i], a[j]] = [a[j]!, a[i]!];
  }
  return a.slice(0, n);
}

// ---------- scoring ----------

const fold = (s: string) => s.normalize("NFKD").replace(/[̀-ͯ]/g, "").replace(/ł/g, "l").replace(/Ł/g, "l").toLowerCase().replace(/[^a-z0-9 ]/g, "").replace(/\s+/g, " ").trim();

function editDistance(a: string, b: string): number {
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) d[0]![j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      d[i]![j] = Math.min(d[i - 1]![j]! + 1, d[i]![j - 1]! + 1, d[i - 1]![j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
  }
  return d[a.length]![b.length]!;
}

/** Does an answer name the expected word? Polish letters, case, a typo or another ending are forgiven. */
export function sameWord(expected: string, answer: string): boolean {
  const e = fold(expected);
  const a = fold(answer);
  if (!a) return false;
  if (e === a) return true;
  // Short words must be exact ("koń" is not "kot").
  if (e.length <= 4) return false;
  if (e.length >= 6 && a.length >= 6 && e.slice(0, 5) === a.slice(0, 5)) return true;
  return editDistance(e, a) <= (e.length >= 8 ? 2 : 1);
}

/** For phrases (list items like "posiadanie samoistne"): most of the meaningful words must be there. */
export function samePhrase(expected: string, answer: string): boolean {
  const words = (x: string) => fold(x).split(" ").filter((w) => w.length >= 3);
  const want = words(expected);
  const have = words(answer);
  if (!want.length) return sameWord(expected, answer);
  const hit = want.filter((w) => have.some((h) => sameWord(w, h))).length;
  return hit / want.length >= 0.6;
}

/** Recall in order: one point per locus where the right item was given. */
export function scoreRecall(expected: string[], answers: string[]): { correct: number; perItem: boolean[] } {
  const perItem = expected.map((e, i) => sameWord(e, answers[i] ?? ""));
  return { correct: perItem.filter(Boolean).length, perItem };
}

// ---------- drills ----------

export type DrillKind = "quiz" | "route_forward" | "route_backward" | "images" | "words" | "terms" | "material";

export function recordDrill(
  db: Db,
  input: { stage: number; kind: DrillKind; size: number; correct: number; palaceId?: string | null; durationMs?: number; detail?: unknown },
): string {
  const id = newId();
  db.run(
    "INSERT INTO palace_drill (id, stage, kind, palace_id, size, correct, duration_ms, detail_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
    id,
    input.stage,
    input.kind,
    input.palaceId ?? null,
    input.size,
    input.correct,
    input.durationMs ?? null,
    input.detail === undefined ? null : JSON.stringify(input.detail),
    nowIso(),
  );
  return id;
}

export function drillHistory(db: Db, kind?: DrillKind): { stage: number; kind: DrillKind; size: number; correct: number; createdAt: string; detail: any }[] {
  return db
    .all<any>(`SELECT * FROM palace_drill ${kind ? "WHERE kind = ?" : ""} ORDER BY created_at`, ...(kind ? [kind] : []))
    .map((r) => ({ stage: r.stage, kind: r.kind, size: r.size, correct: r.correct, createdAt: r.created_at, detail: r.detail_json ? JSON.parse(r.detail_json) : null }));
}

/** Words used in the last word drills: the next list avoids them. */
export function recentWords(db: Db, n = 3): Set<string> {
  const out = new Set<string>();
  for (const d of drillHistory(db, "words").slice(-n)) for (const w of d.detail?.words ?? []) out.add(w);
  return out;
}

// ---------- placements of your own lists ----------

export interface Placement {
  itemIndex: number;
  locusId: string;
  locusName: string;
  locusOrd: number;
  image: string;
}

/** Puts the items of a list card (e.g. premises) at loci of a palace, each with your image. */
export function placeList(db: Db, input: { materialId: string; palaceId: string; items: { itemIndex: number; locusId: string; image: string }[] }): void {
  const m = db.get<{ type: string; payload_json: string }>("SELECT type, payload_json FROM material WHERE id = ?", input.materialId);
  if (!m || m.type !== "list") throw new Error("W pałacu umieszcza się wyliczenia (np. przesłanki).");
  const count = (JSON.parse(m.payload_json).items as string[]).length;
  const loci = new Set(db.all<{ id: string }>("SELECT id FROM locus WHERE palace_id = ?", input.palaceId).map((l) => l.id));
  const used = new Set<string>();
  for (const it of input.items) {
    if (it.itemIndex < 0 || it.itemIndex >= count) throw new Error("Nieprawidłowa pozycja listy.");
    if (!loci.has(it.locusId)) throw new Error("To miejsce nie należy do wybranego pałacu.");
    if (used.has(it.locusId)) throw new Error("Każda pozycja musi mieć inne miejsce.");
    used.add(it.locusId);
  }
  const now = nowIso();
  db.tx(() => {
    for (const p of db.all<{ id: string }>("SELECT id FROM palace_placement WHERE material_id = ?", input.materialId)) {
      recordTombstone(db, "palace_placement", p.id);
    }
    db.run("DELETE FROM palace_placement WHERE material_id = ?", input.materialId);
    for (const it of input.items) {
      db.run(
        "INSERT INTO palace_placement (id, palace_id, material_id, item_index, locus_id, image, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
        newId(),
        input.palaceId,
        input.materialId,
        it.itemIndex,
        it.locusId,
        it.image.trim(),
        now,
      );
    }
  });
}

export function placementsFor(db: Db, materialId: string): { palaceName: string; placements: Placement[] } | null {
  const rows = db.all<any>(
    `SELECT p.item_index, p.locus_id, p.image, l.name AS locus_name, l.ord, pa.name AS palace_name FROM palace_placement p
     JOIN locus l ON l.id = p.locus_id JOIN palace pa ON pa.id = p.palace_id WHERE p.material_id = ? ORDER BY l.ord`,
    materialId,
  );
  if (!rows.length) return null;
  return {
    palaceName: rows[0].palace_name,
    placements: rows.map((r) => ({ itemIndex: r.item_index, locusId: r.locus_id, locusName: r.locus_name, locusOrd: r.ord, image: r.image })),
  };
}

/** List cards that can go into a palace: approved lists (premises, elements…), not yet placed first. */
export function placeableLists(db: Db): { materialId: string; prompt: string; items: string[]; topicName: string; placed: boolean }[] {
  return db
    .all<any>(
      `SELECT m.id, m.payload_json, t.name AS topic_name,
         EXISTS (SELECT 1 FROM palace_placement p WHERE p.material_id = m.id) AS placed
       FROM material m JOIN topic t ON t.id = m.topic_id
       WHERE m.type = 'list' AND m.status = 'active' ORDER BY placed, t.name`,
    )
    .map((r) => {
      const p = JSON.parse(r.payload_json);
      return { materialId: r.id, prompt: p.prompt, items: p.items, topicName: r.topic_name, placed: !!r.placed };
    });
}

// ---------- the course ----------

export interface QuizQuestion {
  q: string;
  options: string[];
  correct: number;
  why: string;
}

export const INTRO_QUIZ: QuizQuestion[] = [
  {
    q: "Do czego pałac pamięci nadaje się najlepiej?",
    options: ["Do zrozumienia, dlaczego przepis brzmi tak, a nie inaczej", "Do zapamiętania kompletnej listy w ustalonej kolejności", "Do rozwiązywania kazusów"],
    correct: 1,
    why: "Metoda miejsc najlepiej sprawdza się przy listach i kolejności. Zrozumienia i stosowania prawa uczysz się fiszkami „dlaczego” i kazusami.",
  },
  {
    q: "Jaki obraz zapamiętasz najlepiej na miejscu „lodówka”?",
    options: ["Jabłko leżące obok lodówki", "Ogromne jabłko, które z hukiem wybija drzwi lodówki i pachnie cynamonem", "Słowo „jabłko” napisane na lodówce"],
    correct: 1,
    why: "Obraz powinien wchodzić w interakcję z miejscem, być przesadzony, w ruchu i angażować zmysły (Bower 1970: obrazy interaktywne podwajają zapamiętanie par).",
  },
  {
    q: "Czy pałac pamięci zastępuje powtórki fiszek?",
    options: ["Tak, wystarczy raz umieścić listę w pałacu", "Nie – pałac pomaga zakodować listę, a powtórki z przywoływaniem utrwalają ją na długo"],
    correct: 1,
    why: "Mnemotechniki kosztują czas i same nie dają trwałości; w badaniach przewaga często wynikała z przywoływania. Dlatego listy z pałacu dalej wracają w powtórkach.",
  },
];

export interface StageDef {
  stage: number;
  title: string;
  /** What to do and why, from the research. */
  body: string[];
  criterion: string;
}

export const STAGES: StageDef[] = [
  {
    stage: 1,
    title: "Na czym polega pałac pamięci",
    body: [
      "Wyobrażasz sobie trasę po miejscu, które znasz na pamięć (mieszkanie, droga na uczelnię), i na kolejnych punktach tej trasy „kładziesz” obrazy rzeczy do zapamiętania. Przypominając sobie, idziesz tą samą trasą i „zbierasz” obrazy po kolei.",
      "Dowody: metaanaliza 13 badań z losowym przydziałem pokazała średnio umiarkowanie silny efekt (g = 0,65). Po 6 tygodniach treningu osoby wcześniej niewytrenowane zapamiętywały wyraźnie więcej, a efekt utrzymywał się po 4 miesiącach.",
      "Ograniczenia: technika wymaga treningu i czasu, a najlepiej działa dla list w ustalonej kolejności. Nie zastępuje powtórek fiszek ani rozumienia – jest dodatkiem do nich.",
      "Plan kursu: najpierw zbudujesz i utrwalisz trasę, potem nauczysz się tworzyć mocne obrazy, przećwiczysz listy słów, a na końcu umieścisz w pałacu swoje wyliczenia z prawa. Ćwicz kilka razy w tygodniu; badany trening trwał 6 tygodni.",
    ],
    criterion: "Odpowiedz poprawnie na 3 pytania.",
  },
  {
    stage: 2,
    title: "Zbuduj pierwszy pałac",
    body: [
      "Wybierz miejsce, które znasz najlepiej – zwykle własne mieszkanie. Przejdź je w myślach zawsze w tym samym kierunku.",
      "Wypisz co najmniej 10 miejsc (loci) w kolejności, w jakiej je mijasz: np. drzwi wejściowe, wieszak, lustro, szafka na buty, kuchenka…",
      "Zasady: miejsca wyraźnie różne od siebie (nie trzy podobne szafki), stałe (nie przesuwające się), w naturalnej kolejności chodzenia, na tyle duże, żeby „zmieścił się” na nich obraz.",
    ],
    criterion: "Zapisz pałac z co najmniej 10 miejscami.",
  },
  {
    stage: 3,
    title: "Utrwal trasę",
    body: [
      "Zanim cokolwiek położysz na trasie, sama trasa musi być automatyczna. Przejdź ją z pamięci: aplikacja podaje numer miejsca, Ty przywołujesz jego nazwę i sprawdzasz.",
      "Potem przejdź ją wstecz – to sprawdza, że każde miejsce jest osobnym, mocnym punktem, a nie tylko elementem wyuczonej sekwencji.",
    ],
    criterion: "Dwa bezbłędne przejścia w przód i jedno wstecz.",
  },
  {
    stage: 4,
    title: "Twórz żywe obrazy",
    body: [
      "Siła metody to obraz, który łączy rzecz z miejscem. Dobry obraz: wchodzi w interakcję z miejscem, jest przesadzony (ogromny, absurdalny), w ruchu i angażuje zmysły (dźwięk, zapach, dotyk).",
      "Słabe: „jabłko obok lodówki”. Mocne: „wielkie jabłko z hukiem wybija drzwi lodówki, sok tryska na podłogę”.",
      "W tym etapie opisujesz 5 obrazów i oceniasz każdy według czterech cech.",
    ],
    criterion: "5 obrazów, każdy z co najmniej 3 z 4 cech.",
  },
  {
    stage: 5,
    title: "Lista 10 słów",
    body: [
      "Dostaniesz 10 słów. Każde połóż – jako żywy obraz – na kolejnym miejscu trasy. Daj sobie około 20 sekund na słowo.",
      "Potem krótka przerwa z liczeniem (żeby słowa nie zostały tylko w pamięci krótkotrwałej) i przywołanie: idziesz trasą i wpisujesz słowo z każdego miejsca.",
    ],
    criterion: "Co najmniej 9 z 10 słów, dwa razy.",
  },
  {
    stage: 6,
    title: "Dłuższe listy",
    body: [
      "Rozbuduj pałac do co najmniej 20 miejsc (dopisz kolejne pomieszczenia albo drugą trasę, np. klatkę schodową i ulicę).",
      "Ta sama procedura z 20 słowami. Zwróć uwagę, które miejsca „gubią” obrazy – zwykle są zbyt podobne do sąsiednich; zmień je.",
    ],
    criterion: "Co najmniej 18 z 20 słów.",
  },
  {
    stage: 7,
    title: "Pojęcia prawnicze jako obrazy",
    body: [
      "Prawo jest abstrakcyjne, więc pojęcie trzeba zamienić na konkretny obraz-zastępnik: przez brzmienie słowa („zasiedzenie” → ktoś SIEDZI na cudzym dachu) albo przez sens („przedawnienie” → drzwi z napisem „ZA PÓŹNO”).",
      "Najpierw zobaczysz dwa przykłady, potem wymyślisz własne obrazy – własne skojarzenia działają lepiej niż cudze – i przywołasz pojęcia z trasy.",
    ],
    criterion: "Co najmniej 7 z 8 pojęć.",
  },
  {
    stage: 8,
    title: "Twoje wyliczenia w pałacu",
    body: [
      "Wybierz wyliczenie ze swoich fiszek (np. przesłanki) i umieść każdą pozycję na kolejnym miejscu, z własnym obrazem.",
      "Od tej pory, gdy ta fiszka wróci w powtórkach, po odpowiedzi zobaczysz swoje obrazy i miejsca. Najpierw jednak zawsze próbujesz przypomnieć sobie sam.",
    ],
    criterion: "Umieść jedno wyliczenie i przywołaj je bezbłędnie z trasy.",
  },
  {
    stage: 9,
    title: "Podtrzymanie",
    body: [
      "Trasy i obrazy też zapominasz. Raz w tygodniu przejdź każdy pałac z pamięci (etap 3) i odśwież obrazy wyliczeń, które w powtórkach sprawiają trudność.",
      "Nie zapełniaj jednego pałacu wszystkim: jedno wyliczenie na odcinek trasy, a dla nowego przedmiotu – nowa trasa.",
    ],
    criterion: "Etap otwarty: przejście trasy raz w tygodniu.",
  },
];

export interface StageStatus extends StageDef {
  done: boolean;
  unlocked: boolean;
  /** Short progress note, e.g. "1 z 2 przejść w przód". */
  progress: string;
}

const best = (db: Db, kind: DrillKind) => drillHistory(db, kind);

/** Where you are in the course: each stage unlocks when the previous one is passed. */
export function courseStatus(db: Db): StageStatus[] {
  const palaces = listPalaces(db);
  const maxLoci = Math.max(0, ...palaces.map((p) => p.loci.length));
  const quiz = best(db, "quiz").some((d) => d.correct === d.size && d.size >= INTRO_QUIZ.length);
  const fwd = best(db, "route_forward").filter((d) => d.correct === d.size && d.size >= 10).length;
  const bwd = best(db, "route_backward").filter((d) => d.correct === d.size && d.size >= 10).length;
  const images = best(db, "images").filter((d) => d.correct >= 3).length;
  const words10 = best(db, "words").filter((d) => d.size >= 10 && d.size < 20 && d.correct >= 9).length;
  const words20 = best(db, "words").filter((d) => d.size >= 20 && d.correct >= 18).length;
  const terms = best(db, "terms").filter((d) => d.size >= 8 && d.correct >= 7).length;
  const material = best(db, "material").filter((d) => d.correct === d.size && d.size > 0).length;
  const lastWalk = [...best(db, "route_forward"), ...best(db, "route_backward")].map((d) => d.createdAt).sort().at(-1);

  const checks: [boolean, string][] = [
    [quiz, quiz ? "zaliczone" : "quiz do zrobienia"],
    [maxLoci >= 10, `najdłuższa trasa: ${maxLoci} miejsc`],
    [fwd >= 2 && bwd >= 1, `w przód ${Math.min(fwd, 2)}/2, wstecz ${Math.min(bwd, 1)}/1`],
    [images >= 5, `obrazy: ${Math.min(images, 5)}/5`],
    [words10 >= 2, `udane listy: ${Math.min(words10, 2)}/2`],
    [words20 >= 1 && maxLoci >= 20, maxLoci < 20 ? `rozbuduj trasę do 20 miejsc (teraz ${maxLoci})` : `udane listy 20 słów: ${Math.min(words20, 1)}/1`],
    [terms >= 1, `udane serie: ${Math.min(terms, 1)}/1`],
    [material >= 1, material ? "zaliczone" : "umieść i przywołaj wyliczenie"],
    [false, lastWalk ? `ostatnie przejście trasy: ${lastWalk.slice(0, 10)}` : "jeszcze nie było przejścia"],
  ];
  let unlocked = true;
  return STAGES.map((s, i) => {
    const [done, progress] = checks[i]!;
    const st: StageStatus = { ...s, done, unlocked, progress };
    if (!done) unlocked = false;
    return st;
  });
}

/** The stage to work on now. */
export const currentStage = (db: Db): StageStatus => courseStatus(db).find((s) => s.unlocked && !s.done) ?? courseStatus(db).at(-1)!;
