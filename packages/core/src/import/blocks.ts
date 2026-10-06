// Every importer turns a file into a list of blocks: headings and paragraphs,
// with the page (PDF) or chapter (EPUB) they come from. The chunker then cuts
// blocks into fragments for the AI and for citations.

export type Block =
  | { kind: "heading"; level: number; text: string; page?: number }
  | { kind: "para"; text: string; page?: number };

export interface ParsedFile {
  blocks: Block[];
  /** Title found in the file (first heading or metadata), if any. */
  title?: string;
  /** A date found in the file name or first lines (YYYY-MM-DD): a lecture date candidate. */
  detectedDate?: string;
  /** Page numbers are real book pages (PDF) rather than chapters (EPUB). */
  paged?: boolean;
}

export function cleanText(s: string): string {
  return s
    .replace(/­/g, "") // soft hyphen
    .replace(/[   ]/g, " ")
    .replace(/[ \t]+/g, " ")
    .replace(/ *\n */g, "\n")
    .trim();
}

export interface Chunk {
  ord: number;
  headingPath: string[];
  pageFrom: number | null;
  pageTo: number | null;
  text: string;
}

const TARGET = 1500;
const MAX = 2500;

/** Splits text that is too long into pieces at sentence ends. */
function splitLong(text: string): string[] {
  if (text.length <= MAX) return [text];
  const sentences = text.match(/[^.!?;]+[.!?;]+(?:\s|$)|[^.!?;]+$/g) ?? [text];
  const out: string[] = [];
  let cur = "";
  for (const s of sentences) {
    if (cur && cur.length + s.length > TARGET) {
      out.push(cur.trim());
      cur = "";
    }
    if (s.length > MAX) {
      for (let i = 0; i < s.length; i += TARGET) out.push(s.slice(i, i + TARGET).trim());
      continue;
    }
    cur += s;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

/**
 * Groups paragraphs into fragments of about 1500 characters. A heading always
 * starts a new fragment, so a fragment never mixes two sections, and each
 * fragment keeps its heading path and page range.
 */
export function chunkBlocks(blocks: Block[]): Chunk[] {
  const chunks: Chunk[] = [];
  const path: string[] = [];
  let paras: string[] = [];
  let len = 0;
  let pageFrom: number | null = null;
  let pageTo: number | null = null;

  const flush = () => {
    if (!paras.length) return;
    chunks.push({ ord: chunks.length, headingPath: [...path], pageFrom, pageTo, text: paras.join("\n\n") });
    paras = [];
    len = 0;
    pageFrom = pageTo = null;
  };

  for (const b of blocks) {
    if (b.kind === "heading") {
      flush();
      const level = Math.max(1, Math.min(6, b.level));
      path.length = Math.min(path.length, level - 1);
      while (path.length < level - 1) path.push("");
      path[level - 1] = b.text;
      continue;
    }
    const text = cleanText(b.text);
    if (!text) continue;
    for (const piece of splitLong(text)) {
      if (len && len + piece.length > TARGET) flush();
      paras.push(piece);
      len += piece.length + 2;
      if (b.page != null) {
        pageFrom ??= b.page;
        pageTo = b.page;
      }
    }
  }
  flush();
  // Empty levels (a level-3 heading right under level 1) are dropped from the path.
  for (const c of chunks) c.headingPath = c.headingPath.filter(Boolean);
  return chunks;
}

const MONTHS: Record<string, number> = {
  stycznia: 1, lutego: 2, marca: 3, kwietnia: 4, maja: 5, czerwca: 6,
  lipca: 7, sierpnia: 8, wrzesnia: 9, września: 9, pazdziernika: 10, października: 10, listopada: 11, grudnia: 12,
};

/** Finds a date like 6.10.2026, 2026-10-06 or 6 października 2026. */
export function detectDate(...texts: (string | undefined)[]): string | undefined {
  for (const t of texts) {
    if (!t) continue;
    let m = t.match(/\b(20\d{2})[-_.](\d{1,2})[-_.](\d{1,2})\b/);
    if (m) return iso(+m[1]!, +m[2]!, +m[3]!);
    m = t.match(/\b(\d{1,2})[.\-_/](\d{1,2})[.\-_/](20\d{2})\b/);
    if (m) return iso(+m[3]!, +m[2]!, +m[1]!);
    m = t.toLowerCase().match(/\b(\d{1,2})\s+([a-ząćęłńóśźż]+)\s+(20\d{2})\b/);
    if (m && MONTHS[m[2]!]) return iso(+m[3]!, MONTHS[m[2]!]!, +m[1]!);
  }
  return undefined;
}

function iso(y: number, m: number, d: number): string | undefined {
  if (m < 1 || m > 12 || d < 1 || d > 31) return undefined;
  return `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}
