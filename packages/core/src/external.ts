// Official and scholarly sources on the internet, used only to fill gaps the
// user's own materials leave, in this order:
//   1. ISAP / ELI API of the Sejm  – the wording of statutes (top of the source hierarchy)
//   2. SAOS                         – court judgments by case number
//   3. OpenAlex                     – scholarly publications (abstracts), when 1–2 have no answer
// What comes back becomes an ordinary source document, with its address, and
// goes through the same pipeline: quotes are checked, nothing is taken from
// the model's memory. Only the query leaves the computer, never your notes.
import type { FetchFn } from "./ai";
import type { Db } from "./db";
import { type DocumentImportResult, importDocument } from "./documents";
import type { Block, ParsedFile } from "./import/blocks";
import { decodeEntities, parseHtml } from "./import/html";
import type { ParseDeps } from "./import/index";
import { parsePdf } from "./import/pdf";
import { extractProvisions, normalizeAct } from "./legal";
import { getSettings } from "./settings";

export class ExternalError extends Error {
  constructor(
    message: string,
    readonly kind: "disabled" | "blocked" | "http" | "not_found" | "bad_response",
    /** A page where the user can get the same thing by hand. */
    readonly manualUrl?: string,
  ) {
    super(message);
  }
}

async function getJson(url: string, fetchFn: FetchFn, manualUrl?: string): Promise<any> {
  const res = await getRaw(url, fetchFn, manualUrl);
  try {
    return await res.json();
  } catch {
    throw new ExternalError("Serwer odpowiedział w nieoczekiwanym formacie.", "bad_response", manualUrl);
  }
}

async function getRaw(url: string, fetchFn: FetchFn, manualUrl?: string): Promise<Response> {
  let res: Response;
  try {
    res = await fetchFn(url, { signal: AbortSignal.timeout(30_000) });
  } catch {
    throw new ExternalError(
      "Nie udało się połączyć. Serwer może nie zezwalać na zapytania z przeglądarki albo nie ma internetu. Otwórz stronę ręcznie, pobierz plik i wczytaj go w Pracowni.",
      "blocked",
      manualUrl,
    );
  }
  if (res.status === 404) throw new ExternalError("Nie znaleziono.", "not_found", manualUrl);
  if (!res.ok) throw new ExternalError(`Serwer odpowiedział błędem HTTP ${res.status}.`, "http", manualUrl);
  return res;
}

function assertEnabled(db: Db): ReturnType<typeof getSettings>["external"] {
  const ext = getSettings(db).external;
  if (!ext.enabled) throw new ExternalError("Źródła z internetu są wyłączone (Ustawienia → Źródła z internetu).", "disabled");
  return ext;
}

const stripTags = (html: string) => decodeEntities(html.replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();

// ====================== ISAP / ELI ======================

export interface ActHit {
  /** ELI address, e.g. "DU/2025/1071". */
  eli: string;
  title: string;
  type: string;
  /** Date the act or announcement was published (YYYY-MM-DD). */
  date: string | null;
  inForce: boolean | null;
  hasHtml: boolean;
  /** The newest consolidated texts often come only as PDF. */
  hasPdf: boolean;
  /** "Dz.U. 2025 poz. 1071". */
  display: string;
}

/** The ISAP page of an act, for opening by hand. */
export function isapPageUrl(eli: string): string {
  const [pub, year, pos] = eli.split("/");
  return `https://isap.sejm.gov.pl/isap.nsf/DocDetails.xsp?id=W${pub === "MP" ? "MP" : "DU"}${year}${String(pos).padStart(7, "0")}`;
}

const ACT_TITLES: Record<string, string> = {
  kc: "Kodeks cywilny",
  kk: "Kodeks karny",
  kpc: "Kodeks postępowania cywilnego",
  kpk: "Kodeks postępowania karnego",
  kro: "Kodeks rodzinny i opiekuńczy",
  kp: "Kodeks pracy",
  kpa: "Kodeks postępowania administracyjnego",
  ksh: "Kodeks spółek handlowych",
  kw: "Kodeks wykroczeń",
  kkw: "Kodeks karny wykonawczy",
  konst: "Konstytucja Rzeczypospolitej Polskiej",
};
export const actTitleFor = (abbrev: string) => ACT_TITLES[normalizeAct(abbrev)];
export function abbrevForTitle(title: string): string | null {
  const t = title.toLowerCase();
  // Longest names first: "kodeks postępowania cywilnego" before "kodeks cywilny".
  const entries = Object.entries(ACT_TITLES).sort((a, b) => b[1].length - a[1].length);
  const hit = entries.find(([, name]) => t.includes(name.toLowerCase()));
  if (!hit) return null;
  return { kc: "k.c.", kk: "k.k.", kpc: "k.p.c.", kpk: "k.p.k.", kro: "k.r.o.", kp: "k.p.", kpa: "k.p.a.", ksh: "k.s.h.", kw: "k.w.", kkw: "k.k.w.", konst: "Konstytucja RP" }[hit[0]]!;
}

/**
 * Searches acts by title. For codes the useful hits are announcements of the
 * consolidated text ("tekst jednolity"), newest first.
 */
export async function searchActs(db: Db, title: string, fetchFn: FetchFn = fetch): Promise<ActHit[]> {
  const ext = assertEnabled(db);
  const url = `${ext.isapUrl}/eli/acts/search?title=${encodeURIComponent(title)}&limit=50`;
  const body = await getJson(url, fetchFn, `https://isap.sejm.gov.pl/isap.nsf/search.xsp?title=${encodeURIComponent(title)}`);
  const items: any[] = Array.isArray(body) ? body : (body?.items ?? []);
  return items
    .map((a) => {
      const eli = String(a.ELI ?? a.eli ?? (a.publisher && a.year && a.pos ? `${a.publisher}/${a.year}/${a.pos}` : ""));
      const [pub, year, pos] = eli.split("/");
      return {
        eli,
        title: String(a.title ?? ""),
        type: String(a.type ?? ""),
        date: a.announcementDate ?? a.promulgation ?? null,
        inForce: a.inForce === undefined ? null : a.inForce === "IN_FORCE" || a.inForce === true,
        hasHtml: !!(a.textHTML ?? a.textHtml),
        hasPdf: !!(a.textPDF ?? a.textPdf),
        display: a.displayAddress ?? (pub && year && pos ? `${pub === "MP" ? "M.P." : "Dz.U."} ${year} poz. ${pos}` : eli),
      } satisfies ActHit;
    })
    .filter((a) => a.eli && a.title)
    .sort((a, b) => Number(/jednolit/i.test(b.title)) - Number(/jednolit/i.test(a.title)) || String(b.date ?? "").localeCompare(String(a.date ?? "")));
}

// "Art. 118." / "Art. 4.1)" (a footnote mark) – an article starts here. References inside the
// text are written "art. 118" in lower case, so only "Art." with a capital counts.
const ARTICLE_START = /^Art\.\s?(\d+[a-z]*)\.?(?:\d{1,2}\))?(?:\s|$)/;
// In a PDF the reader joins lines into paragraphs, so an article or a § may start mid-paragraph,
// right after the previous sentence.
const ARTICLE_IN_TEXT = /(?<=[.;:)]\s)(?=Art\.\s?\d+[a-z]*\.(?:\d{1,2}\))?\s)/g;
const PARAGRAPH_IN_TEXT = /(?<=[.;:]\s)(?=§\s?\d+[a-z]*\.\s)/g;
// Page headers and footers of Dziennik Ustaw and ISAP printouts that may survive in the text.
const PRINT_NOISE = /\s*(?:Dziennik Ustaw\s*[–-]\s*\d+\s*[–-]\s*Poz\.\s*\d+|©\s*Kancelaria Sejmu\s*s\.\s*\d+\/\d+|\d{4}-\d{2}-\d{2}\s*$)\s*/g;

// Footnotes of a consolidated text ("1) Ze zmianą wprowadzoną przez…"): about the act's history, not its wording.
// Numbered points inside an article ("1) sąd…") do not start with these words.
const FOOTNOTE = /^\d{1,3}\)\s*(?:Ze zmian|Zmiany|W brzmieniu|Dodan|Uchylon|Utracił|Niniejsza ustawa|Z dniem|Obecnie|Przepis|Zgodnie z art\. \d+ ustawy z dnia)/;

/** One block per article start and per §, without print headers and footnotes. */
function explodeArticles(blocks: Block[]): Block[] {
  const out: Block[] = [];
  for (const b of blocks) {
    if (b.kind !== "para") {
      out.push(b);
      continue;
    }
    const text = b.text.replace(PRINT_NOISE, " ").trim();
    if (FOOTNOTE.test(text)) continue;
    for (const art of text.split(ARTICLE_IN_TEXT)) {
      for (const piece of art.split(PARAGRAPH_IN_TEXT)) if (piece.trim()) out.push({ ...b, text: piece.trim() });
    }
  }
  return out;
}

/** Splits a statute's text into articles: "Art. 118." … up to the next article. */
export function splitArticles(input: Block[]): Map<string, Block[]> {
  const blocks = explodeArticles(input);
  const out = new Map<string, Block[]>();
  let current: Block[] | null = null;
  for (const b of blocks) {
    const m = b.text.match(ARTICLE_START);
    if (m) {
      current = [];
      // The same number may appear twice (e.g. in an attached act): keep the first.
      if (!out.has(m[1]!.toLowerCase())) out.set(m[1]!.toLowerCase(), current);
      current.push({ kind: "para", text: b.text });
      continue;
    }
    if (current && b.kind === "para") current.push(b);
    if (b.kind === "heading" && current) current = null;
  }
  return out;
}

export interface ActImport {
  result: DocumentImportResult;
  found: string[];
  missing: string[];
}

/**
 * Downloads an act's text and imports only the chosen articles, as a legal
 * act source (highest in the hierarchy). The legal state is the publication
 * date of the consolidated text.
 */
export async function importActArticles(
  db: Db,
  input: { subjectId: string; act: ActHit; articles: string[]; abbrev?: string },
  fetchFn: FetchFn = fetch,
  /** pdf.js, for acts published only as PDF. */
  deps: ParseDeps = {},
): Promise<ActImport> {
  const ext = assertEnabled(db);
  const page = isapPageUrl(input.act.eli);
  let all: Map<string, Block[]>;
  if (input.act.hasHtml) {
    const res = await getRaw(`${ext.isapUrl}/eli/acts/${input.act.eli}/text.html`, fetchFn, page);
    all = splitArticles(parseHtml(await res.text()));
  } else if (input.act.hasPdf) {
    if (!deps.pdfjs) throw new ExternalError("Brak czytnika PDF w tej wersji aplikacji.", "bad_response", page);
    const res = await getRaw(`${ext.isapUrl}/eli/acts/${input.act.eli}/text.pdf`, fetchFn, page);
    const bytes = new Uint8Array(await res.arrayBuffer());
    let parsed: Awaited<ReturnType<typeof parsePdf>>;
    try {
      parsed = await parsePdf(bytes, deps.pdfjs);
    } catch (e) {
      throw new ExternalError(`Nie udało się odczytać PDF z ISAP: ${e instanceof Error ? e.message : String(e)}`, "bad_response", page);
    }
    all = splitArticles(parsed.blocks);
  } else {
    throw new ExternalError("Ten akt nie ma w ISAP ani tekstu HTML, ani PDF. Otwórz stronę ISAP i pobierz go ręcznie.", "not_found", page);
  }
  const wanted = [...new Set(input.articles.map((a) => a.trim().toLowerCase()).filter(Boolean))].sort((a, b) => parseInt(a) - parseInt(b) || a.localeCompare(b));
  const found = wanted.filter((a) => all.has(a));
  const missing = wanted.filter((a) => !all.has(a));
  if (!found.length) throw new ExternalError(`W tekście aktu nie znaleziono artykułów: ${wanted.join(", ")}.`, "not_found", page);
  const abbrev = input.abbrev ?? abbrevForTitle(input.act.title) ?? input.act.display;
  const blocks: Block[] = [];
  for (const a of found) {
    blocks.push({ kind: "heading", level: 1, text: `Art. ${a} ${abbrev}` });
    blocks.push(...all.get(a)!.map((b) => ({ ...b })));
  }
  const parsed: ParsedFile = { blocks, title: `${abbrev}: art. ${found.join(", ")}`, paged: false };
  const text = blocks.map((b) => b.text).join("\n");
  const result = await importDocument(db, {
    subjectId: input.subjectId,
    kind: "act",
    title: `${actTitleFor(abbrev) ?? input.act.title} – art. ${found.join(", ")} (${input.act.display})`,
    fileName: `isap:${input.act.eli}:art:${found.join(",")}`,
    fileBytes: new TextEncoder().encode(text),
    parsed,
    act: { abbrev, title: input.act.title, stateAsOf: input.act.date },
    url: isapPageUrl(input.act.eli),
    meta: { source: "ISAP", eli: input.act.eli, display: input.act.display, articles: found, format: input.act.hasHtml ? "html" : "pdf" },
  });
  return { result, found, missing };
}

export interface ProvisionGap {
  act: string;
  /** Abbreviation as written (k.c.). */
  abbrev: string;
  articles: string[];
}

/**
 * Articles mentioned in a subject's materials, suggestions and notes that no
 * imported legal act covers yet: what to fetch from ISAP.
 */
export function provisionGaps(db: Db, subjectId: string): ProvisionGap[] {
  const texts = [
    ...db.all<{ text: string }>("SELECT text FROM suggestion WHERE subject_id = ? AND status = 'open'", subjectId).map((r) => r.text),
    ...db
      .all<{ content_json: string }>("SELECT f.content_json FROM topic_field f JOIN topic t ON t.id = f.topic_id WHERE t.subject_id = ?", subjectId)
      .map((r) => JSON.parse(r.content_json).text as string),
    ...db
      .all<{ text: string }>(
        "SELECT c.text FROM source_chunk c JOIN source_document d ON d.id = c.document_id WHERE d.subject_id = ? AND d.kind IN ('note', 'textbook')",
        subjectId,
      )
      .map((r) => r.text),
  ];
  const covered = new Set<string>();
  for (const r of db.all<{ abbrev: string; text: string }>(
    `SELECT a.abbrev, c.text FROM source_chunk c JOIN source_document d ON d.id = c.document_id
     JOIN legal_act a ON a.id = d.legal_act_id WHERE d.subject_id = ? AND d.kind = 'act'`,
    subjectId,
  )) {
    for (const m of r.text.matchAll(/\bArt\.\s*(\d+[a-z]*)/gi)) covered.add(`${normalizeAct(r.abbrev)}:${m[1]!.toLowerCase()}`);
  }
  const byAct = new Map<string, { abbrev: string; articles: Set<string> }>();
  for (const t of texts) {
    for (const p of extractProvisions(t)) {
      if (!p.act || !ACT_TITLES[p.act] || covered.has(`${p.act}:${p.article}`)) continue;
      if (!byAct.has(p.act)) byAct.set(p.act, { abbrev: p.raw.match(/\s(\S+)$/)?.[1] ?? p.act, articles: new Set() });
      byAct.get(p.act)!.articles.add(p.article);
    }
  }
  return [...byAct.entries()].map(([act, v]) => ({
    act,
    abbrev: v.abbrev,
    articles: [...v.articles].sort((a, b) => parseInt(a) - parseInt(b) || a.localeCompare(b)),
  }));
}

// ====================== SAOS ======================

/** Case numbers (sygnatury) like "III CZP 12/20", "I CSK 123/19", "SK 12/15". */
export function findCaseNumbers(text: string): string[] {
  const out = new Set<string>();
  for (const m of text.matchAll(/\b((?:[IVX]{1,4}\s+)?(?:[A-Z][A-Za-z]{0,4}(?:p|P)?)\s+\d{1,5}\/\d{2})\b/g)) {
    const sig = m[1]!.replace(/\s+/g, " ");
    // Ignore things like "Dz.U 12/20" or "art 12/20".
    if (/^(Dz|U|Art|Poz|Nr|Pkt|Ust|Str|S)\b/i.test(sig)) continue;
    out.add(sig);
  }
  return [...out];
}

export interface JudgmentHit {
  id: number;
  caseNumber: string;
  court: string;
  date: string | null;
  excerpt: string;
}

export async function searchJudgments(db: Db, caseNumber: string, fetchFn: FetchFn = fetch): Promise<JudgmentHit[]> {
  const ext = assertEnabled(db);
  const manual = `https://www.saos.org.pl/search?courtCaseNumber=${encodeURIComponent(caseNumber)}`;
  const body = await getJson(`${ext.saosUrl}/api/search/judgments?caseNumber=${encodeURIComponent(caseNumber)}&pageSize=10`, fetchFn, manual);
  return (body?.items ?? []).map((j: any) => ({
    id: Number(j.id),
    caseNumber: (j.courtCases ?? []).map((c: any) => c.caseNumber).join(", ") || caseNumber,
    court: String(j.courtType ?? j.division?.court?.name ?? ""),
    date: j.judgmentDate ?? null,
    excerpt: stripTags(String(j.textContent ?? "")).slice(0, 300),
  }));
}

export async function importJudgment(db: Db, input: { subjectId: string; id: number }, fetchFn: FetchFn = fetch): Promise<DocumentImportResult> {
  const ext = assertEnabled(db);
  const page = `https://www.saos.org.pl/judgments/${input.id}`;
  const body = await getJson(`${ext.saosUrl}/api/judgments/${input.id}`, fetchFn, page);
  const j = body?.data ?? body;
  const caseNumber = (j?.courtCases ?? []).map((c: any) => c.caseNumber).join(", ");
  const html = String(j?.textContent ?? "");
  if (!html.trim()) throw new ExternalError("SAOS nie ma treści tego orzeczenia.", "not_found", page);
  let blocks = parseHtml(html.includes("<") ? html : html.split(/\n+/).map((p) => `<p>${p}</p>`).join(""));
  const court = String(j?.courtType ?? "");
  const title = `${court ? `${court}, ` : ""}${caseNumber}${j?.judgmentDate ? `, ${j.judgmentDate}` : ""}`;
  blocks = [{ kind: "heading", level: 1, text: title }, ...blocks];
  const text = blocks.map((b) => b.text).join("\n");
  return importDocument(db, {
    subjectId: input.subjectId,
    kind: "case_law",
    title,
    fileName: `saos:${input.id}`,
    fileBytes: new TextEncoder().encode(text),
    parsed: { blocks, title, paged: false },
    url: page,
    meta: { source: "SAOS", id: input.id, caseNumber, date: j?.judgmentDate ?? null, court },
  });
}

// ====================== OpenAlex (scholarly) ======================

export interface WorkHit {
  id: string;
  title: string;
  year: number | null;
  authors: string[];
  doi: string | null;
  venue: string | null;
  language: string | null;
  abstract: string;
  url: string;
}

/** OpenAlex stores abstracts as {word: [positions]}; this puts the words back in order. */
export function abstractFromIndex(index: Record<string, number[]> | null | undefined): string {
  if (!index) return "";
  const words: string[] = [];
  for (const [w, positions] of Object.entries(index)) for (const p of positions) words[p] = w;
  return words.filter((w) => w !== undefined).join(" ");
}

/** Scholarly works with an abstract, Polish first. */
export async function searchScholarly(db: Db, query: string, fetchFn: FetchFn = fetch): Promise<WorkHit[]> {
  const ext = assertEnabled(db);
  const q = encodeURIComponent(query);
  const select = "id,display_name,publication_year,doi,authorships,abstract_inverted_index,primary_location,language";
  const contact = ext.email ? `&mailto=${encodeURIComponent(ext.email)}` : "";
  const manual = `https://scholar.google.com/scholar?hl=pl&q=${q}`;
  const body = await getJson(`${ext.openAlexUrl}/works?search=${q}&filter=has_abstract:true&per-page=10&select=${select}${contact}`, fetchFn, manual);
  return (body?.results ?? [])
    .map((w: any) => ({
      id: String(w.id ?? ""),
      title: String(w.display_name ?? ""),
      year: w.publication_year ?? null,
      authors: (w.authorships ?? []).map((a: any) => a?.author?.display_name).filter(Boolean).slice(0, 6),
      doi: w.doi ?? null,
      venue: w.primary_location?.source?.display_name ?? null,
      language: w.language ?? null,
      abstract: abstractFromIndex(w.abstract_inverted_index),
      url: w.doi ?? w.primary_location?.landing_page_url ?? w.id,
    }))
    .filter((w: WorkHit) => w.title && w.abstract.length > 80)
    .sort((a: WorkHit, b: WorkHit) => Number(b.language === "pl") - Number(a.language === "pl"));
}

/** Imports a publication's abstract as a scholarly source (lowest in the hierarchy, always cited with authors and year). */
export async function importScholarly(db: Db, input: { subjectId: string; work: WorkHit }): Promise<DocumentImportResult> {
  assertEnabled(db);
  const w = input.work;
  const cite = `${w.authors.slice(0, 3).join(", ")}${w.authors.length > 3 ? " i in." : ""}${w.year ? ` (${w.year})` : ""}`;
  const title = `${cite}: ${w.title}`;
  const blocks: Block[] = [
    { kind: "heading", level: 1, text: w.title },
    { kind: "para", text: w.abstract },
  ];
  return importDocument(db, {
    subjectId: input.subjectId,
    kind: "scholarly",
    title,
    fileName: `openalex:${w.id}`,
    fileBytes: new TextEncoder().encode(`${w.title}\n${w.abstract}`),
    parsed: { blocks, title, paged: false },
    url: w.url,
    meta: { source: "OpenAlex", authors: w.authors, year: w.year, doi: w.doi, venue: w.venue },
  });
}

/** A web search limited to scholarly results, for when the user wants to look by hand. */
export const scholarSearchUrl = (query: string) => `https://scholar.google.com/scholar?hl=pl&q=${encodeURIComponent(query)}`;
