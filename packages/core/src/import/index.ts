import { type Block, detectDate, type ParsedFile } from "./blocks";
import { PAGES_HELP, pagesPreviewPdf, parseDocx, parseEpub, parseOdt, parseRtf } from "./formats";
import { htmlTitle, parseHtml } from "./html";
import { type PdfJs, parsePdf } from "./pdf";
import { parseMarkdown, parseText } from "./text";

export * from "./blocks";
export { parseHtml } from "./html";
export { parseMarkdown, parseText } from "./text";
export { parseDocx, parseOdt, parseRtf, parseEpub, PAGES_HELP } from "./formats";
export { parsePdf, type PdfJs } from "./pdf";

export const ACCEPTED_EXTENSIONS = [".txt", ".md", ".markdown", ".html", ".htm", ".docx", ".odt", ".rtf", ".pdf", ".epub", ".pages"];

export interface ParseDeps {
  /** pdf.js, needed for PDF and Pages files. */
  pdfjs?: PdfJs;
}

/** Text files: UTF-8, or Windows-1250 when UTF-8 does not fit (older Polish files). */
export function decodeText(bytes: Uint8Array): string {
  const utf8 = new TextDecoder("utf-8").decode(bytes);
  if (!utf8.includes("�")) return utf8.replace(/^﻿/, "");
  try {
    return new TextDecoder("windows-1250").decode(bytes);
  } catch {
    return utf8;
  }
}

export async function parseFile(fileName: string, bytes: Uint8Array, deps: ParseDeps = {}): Promise<ParsedFile> {
  const ext = fileName.toLowerCase().match(/\.[a-z0-9]+$/)?.[0] ?? "";
  const base = fileName.replace(/\.[^.]+$/, "");
  let blocks: Block[];
  let title: string | undefined;
  let paged = false;

  const pdf = async (data: Uint8Array) => {
    if (!deps.pdfjs) throw new Error("Brak modułu PDF.");
    const r = await parsePdf(data, deps.pdfjs);
    paged = true;
    return r;
  };

  switch (ext) {
    case ".txt":
      blocks = parseText(decodeText(bytes));
      break;
    case ".md":
    case ".markdown":
      blocks = parseMarkdown(decodeText(bytes));
      break;
    case ".html":
    case ".htm": {
      const html = decodeText(bytes);
      blocks = parseHtml(html);
      title = htmlTitle(html);
      break;
    }
    case ".docx":
      blocks = await parseDocx(bytes);
      break;
    case ".odt":
      blocks = parseOdt(bytes);
      break;
    case ".rtf":
      blocks = parseRtf(decodeText(bytes));
      break;
    case ".epub": {
      const r = parseEpub(bytes);
      blocks = r.blocks;
      title = r.title;
      break;
    }
    case ".pdf": {
      const r = await pdf(bytes);
      blocks = r.blocks;
      title = r.title;
      break;
    }
    case ".pages": {
      const r = await pdf(pagesPreviewPdf(bytes));
      blocks = r.blocks;
      paged = false; // preview pages are not the note's real pages
      break;
    }
    case ".doc":
      throw new Error("Stary format .doc nie jest obsługiwany. Zapisz plik jako .docx i wczytaj ponownie.");
    default:
      throw new Error(`Nieobsługiwany format pliku (${ext || "bez rozszerzenia"}). Obsługiwane: ${ACCEPTED_EXTENSIONS.join(", ")}.`);
  }

  if (!blocks.some((b) => b.kind === "para")) {
    throw new Error(ext === ".pages" ? PAGES_HELP : "W pliku nie znaleziono tekstu.");
  }
  const firstHeading = blocks.find((b) => b.kind === "heading")?.text;
  const firstTexts = blocks.slice(0, 4).map((b) => b.text);
  const detectedDate = detectDate(base, ...firstTexts);
  return {
    blocks,
    title: title || firstHeading || base,
    ...(detectedDate ? { detectedDate } : {}),
    paged,
  };
}
