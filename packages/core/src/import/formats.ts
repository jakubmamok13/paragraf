import { strFromU8, unzipSync } from "fflate";
import type { Block } from "./blocks";
import { decodeEntities, htmlTitle, parseHtml } from "./html";

// ---------- DOCX (also what Pages exports as "Word") ----------

export async function parseDocx(bytes: Uint8Array): Promise<Block[]> {
  const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
  // mammoth maps Word heading styles to h1–h6, so the structure survives.
  const input = typeof Buffer !== "undefined" ? { buffer: Buffer.from(bytes) } : { arrayBuffer: buffer };
  // Loaded on demand: only the laptop imports Word files.
  const mammoth = (await import("mammoth")).default;
  const { value } = await mammoth.convertToHtml(input as any);
  return parseHtml(value);
}

// ---------- ODT ----------

function unzip(bytes: Uint8Array): Record<string, Uint8Array> {
  try {
    return unzipSync(bytes);
  } catch {
    throw new Error("Plik jest uszkodzony albo to nie jest ten format (nie da się go rozpakować).");
  }
}

export function parseOdt(bytes: Uint8Array): Block[] {
  const files = unzip(bytes);
  const xml = files["content.xml"];
  if (!xml) throw new Error("To nie jest dokument ODT (brak content.xml).");
  const src = strFromU8(xml)
    .replace(/<text:s(?: text:c="(\d+)")?\/>/g, (_m, n) => " ".repeat(Number(n ?? 1)))
    .replace(/<text:(tab|line-break)\/>/g, " ")
    .replace(/<text:note\b[\s\S]*?<\/text:note>/g, "");
  const blocks: Block[] = [];
  for (const m of src.matchAll(/<text:(h|p)\b([^>]*)>([\s\S]*?)<\/text:\1>/g)) {
    const text = decodeEntities(m[3]!.replace(/<[^>]+>/g, "")).replace(/\s+/g, " ").trim();
    if (!text) continue;
    if (m[1] === "h") {
      const level = Number(m[2]!.match(/text:outline-level="(\d+)"/)?.[1] ?? 1);
      blocks.push({ kind: "heading", level, text });
    } else {
      blocks.push({ kind: "para", text });
    }
  }
  return blocks;
}

// ---------- RTF ----------

/** Windows-1250 (Central European) upper half, the usual code page of Polish RTF files. */
const CP1250 =
  "€\u0081‚\u0083„…†‡\u0088‰Š‹ŚŤŽŹ\u0090‘’“”•–—\u0098™š›śťžź ˇ˘Ł¤Ą¦§¨©Ş«¬­®Ż°±˛ł´µ¶·¸ąş»Ľ˝ľżŔÁÂĂÄĹĆÇČÉĘËĚÍÎĎĐŃŇÓÔŐÖ×ŘŮÚŰÜÝŢßŕáâăäĺćçčéęëěíîďđńňóôőö÷řůúűüýţ˙";

export function parseRtf(src: string): Block[] {
  if (!src.startsWith("{\\rtf")) throw new Error("To nie jest plik RTF.");
  const ansi1250 = /\\ansicpg1250/.test(src);
  const out: string[] = [];
  let i = 0;
  let depth = 0;
  let skipDepth = -1;
  let ucSkip = 1;
  let pendingSkip = 0;
  const push = (s: string) => {
    if (skipDepth < 0) out.push(s);
  };
  while (i < src.length) {
    const ch = src[i]!;
    if (ch === "{") {
      depth++;
      i++;
      // Destinations that hold no text (fonts, colours, styles, pictures, metadata).
      const dest = src.slice(i, i + 30).match(/^\\\*?\\?(fonttbl|colortbl|stylesheet|info|pict|header|footer|listtable|listoverridetable|rsidtbl|generator|xmlnstbl|themedata|colorschememapping|latentstyles|datastore|mmathPr)\b/);
      if ((dest || src.startsWith("\\*", i)) && skipDepth < 0) skipDepth = depth;
      continue;
    }
    if (ch === "}") {
      if (depth === skipDepth) skipDepth = -1;
      depth--;
      i++;
      continue;
    }
    if (ch === "\\") {
      const next = src[i + 1];
      if (next === "'") {
        const code = parseInt(src.slice(i + 2, i + 4), 16);
        i += 4;
        if (pendingSkip > 0) {
          pendingSkip--;
          continue;
        }
        push(code < 128 ? String.fromCharCode(code) : ansi1250 ? CP1250[code - 128]! : String.fromCharCode(code));
        continue;
      }
      if (next === "\\" || next === "{" || next === "}") {
        push(next);
        i += 2;
        continue;
      }
      if (next === "~") {
        push(" ");
        i += 2;
        continue;
      }
      const m = src.slice(i).match(/^\\([a-z]+)(-?\d+)? ?/i);
      if (!m) {
        i += 2;
        continue;
      }
      i += m[0].length;
      const word = m[1]!;
      const arg = m[2] !== undefined ? Number(m[2]) : undefined;
      if (word === "par" || word === "line" || word === "sect" || word === "page") push("\n");
      else if (word === "tab") push(" ");
      else if (word === "uc") ucSkip = arg ?? 1;
      else if (word === "u" && arg !== undefined) {
        push(String.fromCharCode(arg < 0 ? arg + 65536 : arg));
        pendingSkip = ucSkip;
      } else if (word === "emdash") push("—");
      else if (word === "endash") push("–");
      else if (word === "lquote" || word === "rquote") push("'");
      else if (word === "ldblquote" || word === "rdblquote") push('"');
      continue;
    }
    if (ch === "\r" || ch === "\n") {
      i++;
      continue;
    }
    if (pendingSkip > 0) {
      pendingSkip--;
      i++;
      continue;
    }
    push(ch);
    i++;
  }
  return out
    .join("")
    .split("\n")
    .map((s) => s.replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .map((text) => ({ kind: "para", text }) as Block);
}

// ---------- EPUB ----------

export function parseEpub(bytes: Uint8Array): { blocks: Block[]; title?: string } {
  const files = unzip(bytes);
  const read = (p: string) => (files[p] ? strFromU8(files[p]!) : undefined);
  const container = read("META-INF/container.xml");
  const opfPath = container?.match(/full-path="([^"]+)"/)?.[1];
  const opf = opfPath ? read(opfPath) : undefined;
  if (!opf || !opfPath) throw new Error("To nie jest książka EPUB (brak spisu treści).");
  const base = opfPath.includes("/") ? opfPath.slice(0, opfPath.lastIndexOf("/") + 1) : "";
  const manifest = new Map<string, string>();
  for (const m of opf.matchAll(/<item\b[^>]*>/g)) {
    const id = m[0].match(/\bid="([^"]+)"/)?.[1];
    const href = m[0].match(/\bhref="([^"]+)"/)?.[1];
    if (id && href) manifest.set(id, decodeURIComponent(href));
  }
  const blocks: Block[] = [];
  let chapter = 0;
  for (const m of opf.matchAll(/<itemref\b[^>]*idref="([^"]+)"/g)) {
    const href = manifest.get(m[1]!);
    if (!href) continue;
    const html = read(base + href);
    if (!html) continue;
    chapter++;
    blocks.push(...parseHtml(html, chapter));
  }
  const title = opf.match(/<dc:title[^>]*>([\s\S]*?)<\/dc:title>/)?.[1];
  return { blocks, ...(title ? { title: decodeEntities(title).trim() } : {}) };
}

// ---------- Pages ----------

/**
 * A .pages file is a zip in Apple's closed format. Its text cannot be read
 * reliably, but files saved with a preview carry a PDF of the document.
 */
export function pagesPreviewPdf(bytes: Uint8Array): Uint8Array {
  let files: Record<string, Uint8Array>;
  try {
    files = unzipSync(bytes);
  } catch {
    throw new Error(PAGES_HELP);
  }
  const key = Object.keys(files).find((k) => /(^|\/)(QuickLook\/)?Preview\.pdf$/i.test(k));
  if (!key) throw new Error(PAGES_HELP);
  return files[key]!;
}

export const PAGES_HELP =
  "Tego pliku Pages nie da się odczytać bezpośrednio. W Pages wybierz Plik → Eksportuj do → Word (albo PDF) i wczytaj ten plik.";

export { htmlTitle };
