// A stand-in for a local model (Ollama API) for tests. It "reads" fragments of
// the sample lecture note and textbook and answers like a model would,
// including the mistakes a small model makes: a quote that is not in the
// source, an invented article number, an "Omów…" question. The pipeline must
// keep the good parts and turn the bad ones into suggestions.

interface Fact {
  topic: string;
  aliases?: string[];
  type: string;
  kind?: "legal" | "doctrinal" | "none";
  text: string;
  quote: string;
  /** Present when the fact is triggered by a phrase other than its quote (hallucinations). */
  trigger?: string;
}

const FACTS: Fact[] = [
  { topic: "Zasiedzenie nieruchomości", aliases: ["Zasiedzenie"], type: "definition", kind: "doctrinal", text: "Pierwotny sposób nabycia własności przez długotrwałe posiadanie samoistne.", quote: "Zasiedzenie to pierwotny sposób nabycia własności przez długotrwałe posiadanie samoistne" },
  { topic: "Zasiedzenie nieruchomości", type: "deadline", text: "W dobrej wierze: 20 lat nieprzerwanego posiadania samoistnego (art. 172 § 1 k.c.).", quote: "posiada nieruchomość nieprzerwanie od lat dwudziestu jako posiadacz samoistny, chyba że uzyskał posiadanie w złej wierze" },
  { topic: "Zasiedzenie nieruchomości", type: "deadline", text: "W złej wierze: 30 lat (art. 172 § 2 k.c.).", quote: "po upływie lat trzydziestu posiadacz nieruchomości nabywa jej własność, choćby uzyskał posiadanie w złej wierze" },
  { topic: "Zasiedzenie nieruchomości", type: "premise", text: "posiadanie samoistne", quote: "Przesłankami zasiedzenia nieruchomości są posiadanie samoistne" },
  { topic: "Zasiedzenie nieruchomości", type: "premise", text: "nieprzerwany upływ czasu określonego w ustawie", quote: "nieprzerwany upływ czasu określonego w ustawie" },
  // Hallucination: the quote is not in the note.
  { topic: "Zasiedzenie nieruchomości", type: "premise", text: "tytuł prawny do rzeczy", quote: "Zasiedzenie wymaga tytułu prawnego do rzeczy", trigger: "pierwotny sposób nabycia" },
  { topic: "Zasiedzenie ruchomości", type: "deadline", text: "3 lata posiadania samoistnego w dobrej wierze (art. 174 k.c.).", quote: "posiada rzecz nieprzerwanie od lat trzech jako posiadacz samoistny, chyba że posiada w złej wierze" },
  // Hallucination: wrong article number.
  { topic: "Zasiedzenie ruchomości", type: "basis", text: "Zasiedzenie ruchomości reguluje art. 176 k.c.", quote: "Zasiedzenie ruchomości reguluje art. 174 k.c." },
  { topic: "Przedawnienie roszczeń", aliases: ["Przedawnienie"], type: "effect", text: "Po upływie terminu dłużnik może uchylić się od zaspokojenia roszczenia.", quote: "może uchylić się od jego zaspokojenia" },
  { topic: "Przedawnienie roszczeń", type: "deadline", text: "Ogólny termin przedawnienia wynosi 6 lat, dla świadczeń okresowych i działalności gospodarczej 3 lata (art. 118 k.c.).", quote: "Termin przedawnienia wynosi sześć lat, a dla roszczeń o świadczenia okresowe oraz roszczeń związanych z prowadzeniem działalności gospodarczej – trzy lata (art. 118 k.c.)" },
  { topic: "Przedawnienie roszczeń", type: "deadline", text: "Ogólny termin przedawnienia wynosi 10 lat, dla świadczeń okresowych i działalności gospodarczej 3 lata (art. 118 k.c.).", quote: "Termin przedawnienia wynosi dziesięć lat, a dla roszczeń o świadczenia okresowe oraz roszczeń związanych z prowadzeniem działalności gospodarczej – trzy lata (art. 118 k.c.)" },
  { topic: "Przedawnienie roszczeń", type: "deadline", text: "Koniec terminu przypada na ostatni dzień roku kalendarzowego, chyba że termin jest krótszy niż 2 lata.", quote: "Koniec terminu przedawnienia przypada na ostatni dzień roku kalendarzowego, chyba że termin przedawnienia jest krótszy niż dwa lata" },
  { topic: "Przedawnienie roszczeń", type: "ratio", text: "Stabilizacja stosunków prawnych i dyscyplinowanie wierzyciela.", quote: "Celem przedawnienia jest stabilizacja stosunków prawnych i dyscyplinowanie wierzyciela" },
];

const squash = (s: string) => s.replace(/\s+/g, " ").toLowerCase();

/** Sloppy mode: quotes the way a small model often writes them (no Polish letters, a word dropped, wrong fragment label). */
let sloppy = false;
export const setSloppy = (on: boolean) => {
  sloppy = on;
};
const mangle = (q: string) => {
  if (!sloppy) return q;
  const w = q.normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/ł/g, "l").split(" ");
  if (w.length > 6) w.splice(Math.floor(w.length / 2), 1);
  return w.join(" ").replace(/§ /g, "§");
};

function extract(user: string) {
  const fragment = user.split('FRAGMENT:\n"""\n')[1]?.split('\n"""')[0] ?? "";
  const f = squash(fragment);
  const topics = new Map<string, any>();
  for (const fact of FACTS) {
    if (!f.includes(squash(fact.trigger ?? fact.quote))) continue;
    if (!topics.has(fact.topic)) topics.set(fact.topic, { name: fact.topic, aliases: fact.aliases ?? [], emphasized: false, fields: [], relations: [] });
    topics.get(fact.topic).fields.push({ type: fact.type, definition_kind: fact.kind ?? "none", text: fact.text, quote: fact.trigger ? fact.quote : mangle(fact.quote) });
  }
  const zn = topics.get("Zasiedzenie nieruchomości");
  if (zn && /ważne/i.test(fragment)) zn.emphasized = true;
  if (/odróżnij zasiedzenie od przedawnienia/i.test(fragment)) {
    if (!topics.has("Zasiedzenie nieruchomości")) {
      topics.set("Zasiedzenie nieruchomości", {
        name: "Zasiedzenie nieruchomości",
        aliases: [],
        emphasized: false,
        fields: [{ type: "effect", definition_kind: "none", text: "Zasiedzenie prowadzi do nabycia prawa.", quote: "zasiedzenie prowadzi do nabycia prawa" }],
        relations: [],
      });
    }
    topics.get("Zasiedzenie nieruchomości").relations.push({ type: "distinguish", target: "Przedawnienie roszczeń" });
  }
  const gaps = /ruchomości/i.test(fragment) ? ["Fragment nie mówi, czy rzecz ruchomą można zasiedzieć w złej wierze."] : [];
  return { topics: [...topics.values()], gaps };
}

function merge(user: string) {
  const newName = user.match(/Nowe zagadnienie: (.*)/)?.[1]?.trim() ?? "";
  const existing = [...user.matchAll(/^- ([^:\n]+)/gm)].map((m) => m[1]!.trim());
  const same = existing.find((e) => e.toLowerCase().startsWith(newName.toLowerCase()) || newName.toLowerCase().startsWith(e.toLowerCase()));
  return same && !/ruchomości/.test(newName + same) ? { decision: "same", existing_name: same } : { decision: "different", existing_name: "" };
}

function generate(user: string) {
  const topic = user.match(/Zagadnienie: (.*)/)?.[1]?.trim() ?? "";
  const fields = [...user.matchAll(/^\[(F\d+)\] ([^:]+?)(?: \([a-z]+\))?: (.*?)(?: \[(C\d+)\])?\n {4}cytat: "(.*)"$/gm)].map((m) => ({
    label: m[1]!,
    kind: m[2]!,
    text: m[3]!,
    chunk: m[4] ?? "C1",
    quote: m[5]!,
  }));
  const own = fields.filter((f) => user.split("Zagadnienia do odróżnienia:")[0]!.includes(`[${f.label}]`));
  const materials: any[] = [];
  const blank = { question: "", answer: "", cloze_text: "", list_prompt: "", list_items: [] as string[] };
  for (const f of own) {
    const cite = [{ chunk_id: sloppy ? "C9" : f.chunk, quote: mangle(f.quote) }];
    if (f.kind === "definicja") {
      const phrase = "pierwotny sposób nabycia własności";
      const text = f.quote.includes(phrase) ? `${f.quote.replace(phrase, `{{c1::${phrase}}}`)}.` : `{{c1::${f.quote}}}`;
      materials.push({ ...blank, type: "cloze", cloze_text: text, field_ids: [f.label], citations: cite });
    } else if (f.kind === "termin") {
      materials.push({ ...blank, type: "qa", question: `${topic}: jaki termin wynika z przepisu? (${f.quote.slice(0, 40)}…)`, answer: f.text, field_ids: [f.label], citations: cite });
    } else if (f.kind === "cel regulacji") {
      materials.push({ ...blank, type: "why", question: `Jaki jest cel instytucji: ${topic}?`, answer: f.text, field_ids: [f.label], citations: cite });
    } else if (f.kind === "skutek") {
      materials.push({ ...blank, type: "qa", question: `Jaki jest skutek: ${topic}?`, answer: f.text, field_ids: [f.label], citations: cite });
    }
  }
  const premises = own.filter((f) => f.kind === "przesłanka");
  if (premises.length >= 2) {
    materials.push({
      ...blank,
      type: "list",
      list_prompt: `Wymień przesłanki: ${topic}`,
      list_items: premises.map((p) => p.text),
      field_ids: premises.map((p) => p.label),
      citations: premises.map((p) => ({ chunk_id: p.chunk, quote: p.quote })),
    });
  }
  // Fragment label whose text holds a sentence.
  const chunkWith = (quote: string) =>
    [...user.matchAll(/^\[(C\d+)\] \([^\n]*\)\n"""\n([\s\S]*?)\n"""/gm)].find((m) => squash(m[2]!).includes(squash(quote)))?.[1];
  const first: any[] = [];
  const contrast = "zasiedzenie prowadzi do nabycia prawa, a przedawnienie nie powoduje wygaśnięcia roszczenia";
  if (user.includes("Zagadnienia do odróżnienia:") && chunkWith(contrast)) {
    first.push({
      ...blank,
      type: "distinction",
      question: "Czym różni się zasiedzenie od przedawnienia?",
      answer: "Zasiedzenie prowadzi do nabycia prawa; przedawnienie nie powoduje wygaśnięcia roszczenia.",
      field_ids: own[0] ? [own[0].label] : [],
      citations: [{ chunk_id: chunkWith(contrast), quote: contrast }],
    });
  }
  if (topic === "Zasiedzenie nieruchomości" && own[0]) {
    // Mistakes the guard must catch.
    first.push({ ...blank, type: "qa", question: "Który przepis reguluje zasiedzenie?", answer: "art. 999 k.c.", field_ids: [], citations: [{ chunk_id: own[0].chunk, quote: own[0].quote }] });
    first.push({ ...blank, type: "qa", question: "Omów zasiedzenie.", answer: "Instytucja prawa rzeczowego.", field_ids: [], citations: [{ chunk_id: own[0].chunk, quote: own[0].quote }] });
  }
  materials.unshift(...first);
  return { materials, suggestions: topic.startsWith("Zasiedzenie") ? ["Warto dodać przerwanie biegu zasiedzenia."] : [] };
}

/** Answers one Ollama /api/chat request body. */
export function fakeModelReply(body: any): unknown {
  const system: string = body.messages?.[0]?.content ?? "";
  const user: string = body.messages?.[1]?.content ?? "";
  let value: unknown;
  if (system.startsWith("Jesteś asystentem, który porządkuje")) value = extract(user);
  else if (system.startsWith("Rozstrzygasz")) value = merge(user);
  else if (system.startsWith("Tworzysz materiały")) value = generate(user);
  else value = {};
  return { model: body.model, message: { role: "assistant", content: JSON.stringify(value) }, done: true, prompt_eval_count: Math.round(user.length / 4), eval_count: 200 };
}

export const FAKE_MODELS = ["bielik-11b:fake", "qwen3-14b:fake"];

/** fetch() that behaves like a local Ollama with the fake model. */
export const fakeFetch = (async (url: string, init?: RequestInit) => {
  const json = (v: unknown) => new Response(JSON.stringify(v), { status: 200, headers: { "Content-Type": "application/json" } });
  if (url.endsWith("/api/tags")) return json({ models: FAKE_MODELS.map((name) => ({ name })) });
  if (url.endsWith("/api/chat")) return json(fakeModelReply(JSON.parse(String(init?.body))));
  return new Response("not found", { status: 404 });
}) as unknown as typeof fetch;
