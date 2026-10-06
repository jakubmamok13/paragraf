// Legal text helpers: provisions (art. 172 § 2 k.c.), numbers in words, and
// a light search index over source fragments (BM25 with prefix stemming,
// which works reasonably for Polish inflection).

export interface Provision {
  article: string;
  paragraph: string | null;
  point: string | null;
  /** Normalised act abbreviation: "kc", "kk", "kpc"…, "" when not given. */
  act: string;
  raw: string;
}

const ACT = String.raw`(k\.?\s?p\.?\s?c\.?|k\.?\s?p\.?\s?k\.?|k\.?\s?p\.?\s?a\.?|k\.?\s?r\.?\s?o\.?|k\.?\s?s\.?\s?h\.?|k\.?\s?k\.?\s?w\.?|k\.?\s?c\.?|k\.?\s?k\.?|k\.?\s?w\.?|k\.?\s?p\.?|Konstytucji(?:\s+RP)?|u\.\s?k\.?\s?w\.?|p\.?\s?u\.?\s?s\.?\s?a\.?)`;
const PROVISION_RE = new RegExp(
  String.raw`\bart\.\s*(\d+[a-z]{0,3})(?:\s*[-–]\s*(\d+[a-z]{0,3}))?(?:\s*§\s*(\d+[a-z]?))?(?:\s*(?:pkt|ust\.)\s*(\d+[a-z]?))?(?:\s+${ACT}(?![a-ząćęłńóśźż]))?`,
  "gi",
);

export function normalizeAct(s: string | undefined): string {
  if (!s) return "";
  const t = s.toLowerCase().replace(/[\s.]/g, "");
  return t.startsWith("konstytucj") ? "konst" : t;
}

/** All provisions mentioned in a text; ranges (art. 172–174) give each article. */
export function extractProvisions(text: string): Provision[] {
  const out: Provision[] = [];
  for (const m of text.matchAll(PROVISION_RE)) {
    const act = normalizeAct(m[5]);
    const from = m[1]!;
    const to = m[2];
    const articles = [from];
    if (to && /^\d+$/.test(from) && /^\d+$/.test(to) && +to > +from && +to - +from <= 20) {
      for (let a = +from + 1; a <= +to; a++) articles.push(String(a));
    } else if (to) articles.push(to);
    for (const article of articles) {
      out.push({ article: article.toLowerCase(), paragraph: m[3] ?? null, point: m[4] ?? null, act, raw: m[0].trim() });
    }
  }
  return out;
}

export const provisionKey = (p: Provision) => `${p.act}:${p.article}${p.paragraph ? `§${p.paragraph}` : ""}${p.point ? `pkt${p.point}` : ""}`;

/** Is provision `p` backed by one of `source`? Same article (and § / point when given); acts must match when both name one. */
export function provisionSupported(p: Provision, source: Provision[]): boolean {
  return source.some(
    (s) =>
      s.article === p.article &&
      (!p.paragraph || !s.paragraph || s.paragraph === p.paragraph) &&
      (!p.point || !s.point || s.point === p.point) &&
      (!p.act || !s.act || s.act === p.act),
  );
}

// ---------- numbers ----------

const NUMBER_WORDS: Record<string, number> = {};
for (const [n, forms] of [
  [2, "dwa dwóch dwu dwie dwoma dwom"],
  [3, "trzy trzech trzema"],
  [4, "cztery czterech czterema"],
  [5, "pięć pięciu"],
  [6, "sześć sześciu"],
  [7, "siedem siedmiu"],
  [8, "osiem ośmiu"],
  [9, "dziewięć dziewięciu"],
  [10, "dziesięć dziesięciu"],
  [12, "dwanaście dwunastu"],
  [14, "czternaście czternastu"],
  [15, "piętnaście piętnastu"],
  [20, "dwadzieścia dwudziestu"],
  [30, "trzydzieści trzydziestu"],
  [40, "czterdzieści czterdziestu"],
  [50, "pięćdziesiąt pięćdziesięciu"],
  [100, "sto stu"],
] as const) {
  for (const f of forms.split(" ")) NUMBER_WORDS[f] = n;
}

/** Numbers in a text, written in digits or as Polish cardinal words ("lat dwudziestu" → 20). "Jeden" is left out: "jedno z…" is not a number. */
export function numbersIn(text: string): Set<string> {
  const out = new Set<string>();
  for (const m of text.matchAll(/\d+(?:[.,]\d+)?/g)) out.add(m[0].replace(",", "."));
  for (const w of text.toLowerCase().match(/[a-ząćęłńóśźż]+/g) ?? []) {
    const n = NUMBER_WORDS[w];
    if (n !== undefined) out.add(String(n));
  }
  return out;
}

/**
 * Numbers and provisions in `claim` that do not appear in `source`. The
 * generator's guard against invented article numbers, deadlines and amounts.
 */
export function unsupportedFacts(claim: string, source: string): string[] {
  const bad: string[] = [];
  const srcProv = extractProvisions(source);
  for (const p of extractProvisions(claim)) if (!provisionSupported(p, srcProv)) bad.push(p.raw);
  // Numbers inside provisions were checked above.
  const srcNums = numbersIn(source);
  for (const n of numbersIn(claim.replace(PROVISION_RE, " "))) if (!srcNums.has(n)) bad.push(n);
  return [...new Set(bad)];
}

// ---------- quotes ----------

export const normalizeForMatch = (s: string) =>
  s
    .toLowerCase()
    .replace(/[„”“"«»]/g, '"')
    .replace(/[‘’']/g, "'")
    .replace(/[–—−]/g, "-")
    .replace(/-\s*\n\s*/g, "")
    .replace(/\s+/g, " ")
    .trim();

/**
 * Finds a quote in a fragment. Exact (after normalising spaces, quotes and
 * dashes) or, failing that, the window of the fragment that shares at least
 * 85% of the quote's words in order. Returns the fragment's own wording.
 */
export function locateQuote(quote: string, text: string): { start: number; end: number; text: string } | null {
  const q = normalizeForMatch(quote).replace(/^[.…\s]+|[.…\s]+$/g, "");
  if (q.length < 8) return null;
  // Map normalised positions back to the original text.
  const map: number[] = [];
  let norm = "";
  const lower = text.toLowerCase();
  for (let i = 0; i < text.length; i++) {
    let ch = lower[i]!;
    if (/[„”“"«»]/.test(ch)) ch = '"';
    else if (/[‘’']/.test(ch)) ch = "'";
    else if (/[–—−]/.test(ch)) ch = "-";
    else if (/\s/.test(ch)) {
      if (norm.endsWith(" ") || !norm) continue;
      ch = " ";
    }
    norm += ch;
    map.push(i);
  }
  const at = norm.indexOf(q);
  if (at >= 0) {
    const start = map[at]!;
    const end = map[at + q.length - 1]! + 1;
    return { start, end, text: text.slice(start, end) };
  }
  // Fuzzy: sliding window over words.
  const qWords = q.split(" ");
  if (qWords.length < 4) return null;
  const words = [...norm.matchAll(/\S+/g)];
  let best: { score: number; i: number } | null = null;
  for (let i = 0; i + qWords.length <= words.length + 2; i++) {
    const win = words.slice(i, i + qWords.length).map((m) => m[0]);
    let hit = 0;
    for (let k = 0; k < qWords.length; k++) if (win[k] === qWords[k] || (win[k] && qWords[k] && win[k]!.slice(0, 5) === qWords[k]!.slice(0, 5))) hit++;
    const score = hit / qWords.length;
    if (!best || score > best.score) best = { score, i };
  }
  if (!best || best.score < 0.85) return null;
  const first = words[best.i]!;
  const last = words[Math.min(words.length - 1, best.i + qWords.length - 1)]!;
  const start = map[first.index!]!;
  const end = map[last.index! + last[0].length - 1]! + 1;
  return { start, end, text: text.slice(start, end) };
}

// ---------- search ----------

const STOP = new Set(
  "a aby ale albo bez by być czy dla do gdy i ich im iż jak jako je jego jej jest jeśli już lub ma może na nie nie niż o od oraz po pod przez przy się są ta tak te tego to tym u w we z za ze że który która które których którym".split(" "),
);

export function tokenize(text: string): string[] {
  return (text.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/ł/g, "l").match(/[a-z0-9§]+/g) ?? [])
    .filter((t) => !STOP.has(t) && (t.length > 1 || /\d/.test(t)))
    .map((t) => (/^\d/.test(t) ? t : t.slice(0, 6)));
}

export interface SearchDoc {
  id: string;
  text: string;
}

/** BM25 over fragments; built in memory when needed. */
export class SearchIndex {
  private docs: { id: string; tf: Map<string, number>; len: number }[] = [];
  private df = new Map<string, number>();
  private avg = 0;

  constructor(docs: SearchDoc[]) {
    for (const d of docs) {
      const tf = new Map<string, number>();
      const toks = tokenize(d.text);
      for (const t of toks) tf.set(t, (tf.get(t) ?? 0) + 1);
      for (const t of tf.keys()) this.df.set(t, (this.df.get(t) ?? 0) + 1);
      this.docs.push({ id: d.id, tf, len: toks.length });
    }
    this.avg = this.docs.reduce((s, d) => s + d.len, 0) / Math.max(1, this.docs.length);
  }

  search(query: string, k = 5): { id: string; score: number }[] {
    const q = [...new Set(tokenize(query))];
    const N = this.docs.length;
    const k1 = 1.2;
    const b = 0.75;
    return this.docs
      .map((d) => {
        let score = 0;
        for (const t of q) {
          const f = d.tf.get(t);
          if (!f) continue;
          const df = this.df.get(t)!;
          const idf = Math.log(1 + (N - df + 0.5) / (df + 0.5));
          score += (idf * f * (k1 + 1)) / (f + k1 * (1 - b + (b * d.len) / this.avg));
        }
        return { id: d.id, score };
      })
      .filter((r) => r.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, k);
  }
}
