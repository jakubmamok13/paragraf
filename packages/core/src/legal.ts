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

interface Tok {
  /** Lower case, no Polish letters, no ligatures. */
  norm: string;
  /** First letters only: tolerates another case or ending ("nieruchomość" / "nieruchomości"). */
  stem: string;
  start: number;
  end: number;
}

const foldChars = (s: string) =>
  s.normalize("NFKD").replace(/[̀-ͯ]/g, "").replace(/ł/g, "l").replace(/Ł/g, "L").toLowerCase();

/** Words and numbers with their place in the original text (punctuation, §, quotes are ignored). */
function tokens(text: string): Tok[] {
  const out: Tok[] = [];
  for (const m of text.matchAll(/[\p{L}\p{N}]+/gu)) {
    const norm = foldChars(m[0]);
    out.push({ norm, stem: /^\d/.test(norm) ? norm : norm.slice(0, 5), start: m.index!, end: m.index! + m[0].length });
  }
  return out;
}

/** Longest common subsequence of stems; returns its length and the first/last matched index in `b`. */
function lcs(a: Tok[], b: Tok[]): { len: number; first: number; last: number } {
  const n = a.length;
  const m = b.length;
  const dp: Uint16Array[] = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1));
  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= m; j++) {
      dp[i]![j] = a[i - 1]!.stem === b[j - 1]!.stem ? dp[i - 1]![j - 1]! + 1 : Math.max(dp[i - 1]![j]!, dp[i]![j - 1]!);
    }
  }
  // Walk back to find which tokens of b took part.
  let i = n;
  let j = m;
  let first = -1;
  let last = -1;
  while (i > 0 && j > 0) {
    if (a[i - 1]!.stem === b[j - 1]!.stem) {
      if (last < 0) last = j - 1;
      first = j - 1;
      i--;
      j--;
    } else if (dp[i - 1]![j]! >= dp[i]![j - 1]!) i--;
    else j--;
  }
  return { len: dp[n]![m]!, first, last };
}

/** One piece of a quote (between "…") located in `src` tokens from position `from`. */
function locateSegment(q: Tok[], src: Tok[], from: number): { first: number; last: number } | null {
  if (!q.length) return null;
  // Exact sequence (letters folded, punctuation ignored).
  for (let i = from; i + q.length <= src.length; i++) {
    let k = 0;
    while (k < q.length && src[i + k]!.norm === q[k]!.norm) k++;
    if (k === q.length) return { first: i, last: i + q.length - 1 };
  }
  // Short pieces must match exactly: three words prove nothing.
  if (q.length < 4) return null;
  // Close enough: most words in the same order, with a word or two missing, added or inflected otherwise.
  const span = Math.ceil(q.length * 1.4) + 2;
  let best: { len: number; first: number; last: number } | null = null;
  const anchors = new Set(q.slice(0, 3).map((t) => t.stem));
  for (let i = from; i < src.length; i++) {
    if (!anchors.has(src[i]!.stem)) continue;
    const r = lcs(q, src.slice(i, i + span));
    if (r.len && (!best || r.len > best.len)) best = { len: r.len, first: i + r.first, last: i + r.last };
  }
  if (!best) return null;
  const covered = best.len / q.length;
  const width = best.last - best.first + 1;
  if (covered < 0.8 || best.len / width < 0.7) return null;
  return best;
}

/**
 * Finds a quote in a fragment, the way a small model writes quotes: Polish
 * letters dropped, punctuation and "§ 2"/"§2" changed, a word missing, added
 * or in another form, the middle cut with "…". Returns the fragment's own
 * wording, so what is stored is always the real source text.
 */
export function locateQuote(quote: string, text: string): { start: number; end: number; text: string } | null {
  const src = tokens(text);
  const segments = quote
    .split(/\s*(?:\(\s*(?:\.\.\.|…)\s*\)|\[\s*(?:\.\.\.|…)\s*\]|\.\.\.|…)\s*/)
    .map(tokens)
    .filter((seg) => seg.length > 0);
  if (!segments.length || segments.reduce((n, s) => n + s.length, 0) < 2) return null;
  let from = 0;
  let first = -1;
  let last = -1;
  for (const seg of segments) {
    const r = locateSegment(seg, src, from);
    if (!r) return null;
    if (first < 0) first = r.first;
    last = r.last;
    from = r.last + 1;
  }
  const start = src[first]!.start;
  const end = src[last]!.end;
  return { start, end, text: text.slice(start, end) };
}

const CONTENT_STOP = new Set(
  "a aby albo ale bez by być czy dla do gdy i ich im iż jak jako je jego jej jest jeśli już lub ma może na nie niż o od oraz po pod przez przy się są ta tak te tego to tym u w we z za ze że który która które których którym jeżeli albo".split(" ").map(foldChars),
);

/**
 * When the model's quote cannot be found, the sentence (or two neighbouring
 * sentences) of the fragment that holds most of the claim's words, if it
 * holds at least 70% of them. An invented claim finds no such passage.
 */
export function supportingPassage(claim: string, text: string): { start: number; end: number; text: string } | null {
  const want = [...new Set(tokens(claim).filter((t) => t.norm.length >= 3 && !CONTENT_STOP.has(t.norm)).map((t) => t.stem))];
  if (want.length < 3) return null;
  const bounds: { start: number; end: number }[] = [];
  const re = /[^.!?;\n]+(?:[.!?;]+|$)/g;
  for (const m of text.matchAll(re)) if (m[0].trim()) bounds.push({ start: m.index!, end: m.index! + m[0].length });
  let best: { score: number; start: number; end: number } | null = null;
  for (let i = 0; i < bounds.length; i++) {
    for (const j of [i, i + 1]) {
      if (j >= bounds.length) continue;
      const start = bounds[i]!.start;
      const end = bounds[j]!.end;
      const have = new Set(tokens(text.slice(start, end)).map((t) => t.stem));
      const score = want.filter((w) => have.has(w)).length / want.length - (j > i ? 0.05 : 0);
      if (!best || score > best.score) best = { score, start, end };
    }
  }
  if (!best || best.score < 0.7) return null;
  const raw = text.slice(best.start, best.end);
  const lead = raw.length - raw.trimStart().length;
  const trail = raw.length - raw.trimEnd().length;
  const start = best.start + lead;
  const end = best.end - trail;
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
