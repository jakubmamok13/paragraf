import type { Block } from "./blocks";

/** The part of pdf.js we use; the browser and the tests pass their own build of it. */
export interface PdfJs {
  getDocument(src: { data: Uint8Array; [k: string]: unknown }): { promise: Promise<PdfDoc> };
}
interface PdfDoc {
  numPages: number;
  getPage(n: number): Promise<{ getTextContent(): Promise<{ items: any[] }> }>;
  getMetadata?(): Promise<{ info?: any }>;
}

interface Line {
  text: string;
  size: number;
  y: number;
  page: number;
}

/**
 * Reads the text layer of a PDF page by page. Rebuilds lines from text
 * pieces, drops running headers, footers and page numbers, joins words split
 * by hyphenation, and finds headings by font size.
 */
export async function parsePdf(bytes: Uint8Array, pdfjs: PdfJs): Promise<{ blocks: Block[]; title?: string; textPages: number }> {
  let doc: PdfDoc;
  try {
    doc = await pdfjs.getDocument({ data: bytes.slice(), isEvalSupported: false, useSystemFonts: false, verbosity: 0 }).promise;
  } catch {
    throw new Error("Nie udało się otworzyć PDF (plik uszkodzony albo zabezpieczony hasłem).");
  }

  const pages: Line[][] = [];
  for (let p = 1; p <= doc.numPages; p++) {
    const content = await (await doc.getPage(p)).getTextContent();
    const rows = new Map<number, { x: number; str: string; size: number }[]>();
    for (const it of content.items) {
      if (typeof it.str !== "string" || !it.transform) continue;
      const y = Math.round(it.transform[5] * 2) / 2;
      const size = Math.abs(it.transform[3]) || it.height || 10;
      const key = [...rows.keys()].find((k) => Math.abs(k - y) <= size * 0.3) ?? y;
      if (!rows.has(key)) rows.set(key, []);
      rows.get(key)!.push({ x: it.transform[4], str: it.str, size });
    }
    const lines: Line[] = [...rows.entries()]
      .sort((a, b) => b[0] - a[0])
      .map(([y, parts]) => {
        parts.sort((a, b) => a.x - b.x);
        const text = parts.map((x) => x.str).join("").replace(/\s+/g, " ").trim();
        const size = Math.max(...parts.map((x) => x.size));
        return { text, size, y, page: p };
      })
      .filter((l) => l.text);
    pages.push(lines);
  }

  const textPages = pages.filter((ls) => ls.length > 0).length;
  if (textPages === 0) {
    throw new Error("Ten PDF nie ma warstwy tekstowej (to skan). Rozpoznawanie tekstu (OCR) pojawi się w wersji 3.");
  }

  // Running headers and footers: first/last lines that repeat on many pages (digits ignored).
  const norm = (s: string) => s.replace(/\d+/g, "#").toLowerCase();
  const edgeCount = new Map<string, number>();
  for (const ls of pages) {
    for (const l of [...ls.slice(0, 2), ...ls.slice(-2)]) edgeCount.set(norm(l.text), (edgeCount.get(norm(l.text)) ?? 0) + 1);
  }
  const repeated = (l: Line) => pages.length >= 2 && (edgeCount.get(norm(l.text)) ?? 0) >= Math.max(2, pages.length * 0.3);
  const isPageNumber = (l: Line) => /^(-\s*)?(\d{1,4}|[ivxlc]{1,6})(\s*-)?$/i.test(l.text) || /^(str\.|strona)\s*\d+/i.test(l.text);

  const body: Line[] = [];
  const offsets = new Map<number, number>();
  for (const ls of pages) {
    ls.forEach((l, i) => {
      const edge = i < 2 || i >= ls.length - 2;
      if (edge && isPageNumber(l)) {
        const printed = Number(l.text.match(/\d+/)?.[0]);
        if (Number.isFinite(printed)) offsets.set(printed - l.page, (offsets.get(printed - l.page) ?? 0) + 1);
        return;
      }
      if (edge && repeated(l)) return;
      body.push(l);
    });
  }
  // Printed page numbers (s. 42 in the book) when most pages agree on the offset to the file's page index.
  const [bestOffset, votes] = [...offsets.entries()].sort((a, b) => b[1] - a[1])[0] ?? [0, 0];
  const offset = votes >= Math.max(1, Math.ceil(pages.length * 0.5)) ? bestOffset : 0;
  if (offset) for (const l of body) l.page += offset;

  // Body text size: the most common size weighted by text length.
  const bySize = new Map<number, number>();
  for (const l of body) bySize.set(Math.round(l.size), (bySize.get(Math.round(l.size)) ?? 0) + l.text.length);
  const bodySize = [...bySize.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? 10;
  const headingSizes = [...new Set(body.filter((l) => l.size >= bodySize * 1.15 && l.text.length < 120).map((l) => Math.round(l.size)))].sort((a, b) => b - a);

  const blocks: Block[] = [];
  let para: Line[] = [];
  const flush = () => {
    if (!para.length) return;
    let text = "";
    for (const l of para) {
      if (text.endsWith("-") && /^[a-ząćęłńóśźż]/.test(l.text)) text = text.slice(0, -1) + l.text;
      else text += (text ? " " : "") + l.text;
    }
    blocks.push({ kind: "para", text, page: para[0]!.page });
    para = [];
  };
  for (let i = 0; i < body.length; i++) {
    const l = body[i]!;
    const level = headingSizes.indexOf(Math.round(l.size));
    if (level >= 0 && l.size >= bodySize * 1.15 && l.text.length < 120) {
      flush();
      const prev = blocks[blocks.length - 1];
      // A heading split over two lines.
      if (prev?.kind === "heading" && prev.level === Math.min(3, level + 1) && body[i - 1] && Math.round(body[i - 1]!.size) === Math.round(l.size)) {
        prev.text += ` ${l.text}`;
      } else {
        blocks.push({ kind: "heading", level: Math.min(3, level + 1), text: l.text, page: l.page });
      }
      continue;
    }
    const prev = para[para.length - 1];
    if (prev) {
      const gap = prev.page === l.page ? prev.y - l.y : 0;
      const newPara = (prev.page === l.page && gap > l.size * 1.9) || (/[.:;]$/.test(prev.text) && prev.text.length < 55);
      if (newPara) flush();
    }
    para.push(l);
  }
  flush();

  let title: string | undefined;
  try {
    title = (await doc.getMetadata?.())?.info?.Title || undefined;
  } catch {
    /* no metadata */
  }
  return { blocks, ...(title ? { title } : {}), textPages };
}
