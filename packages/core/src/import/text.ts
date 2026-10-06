import type { Block } from "./blocks";

/** Markdown: # headings, paragraphs separated by blank lines, list items kept as their own paragraphs. */
export function parseMarkdown(src: string): Block[] {
  const blocks: Block[] = [];
  let para: string[] = [];
  const flush = () => {
    if (para.length) blocks.push({ kind: "para", text: para.join(" ") });
    para = [];
  };
  for (const raw of src.replace(/\r\n?/g, "\n").split("\n")) {
    const line = raw.trim();
    const h = line.match(/^(#{1,6})\s+(.*?)\s*#*$/);
    if (h) {
      flush();
      blocks.push({ kind: "heading", level: h[1]!.length, text: stripInline(h[2]!) });
    } else if (!line) {
      flush();
    } else if (/^([-*+]|\d+[.)])\s+/.test(line)) {
      flush();
      para.push(stripInline(line));
      flush();
    } else {
      para.push(stripInline(line));
    }
  }
  flush();
  return blocks;
}

function stripInline(s: string): string {
  return s
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/(\*\*|__)(.+?)\1/g, "$2")
    .replace(/(\*|_)(.+?)\1/g, "$2")
    .replace(/`([^`]+)`/g, "$1");
}

/**
 * Plain text: paragraphs separated by blank lines. A short line on its own
 * that looks like a title (Rozdział…, numbered "1.", "I.", or written in
 * capitals) becomes a heading.
 */
export function parseText(src: string): Block[] {
  const blocks: Block[] = [];
  for (const part of src.replace(/\r\n?/g, "\n").split(/\n\s*\n/)) {
    const lines = part.split("\n").map((l) => l.trim()).filter(Boolean);
    if (!lines.length) continue;
    const first = lines[0]!;
    const item = /^(\d+[.)]|[-*•]|[a-z]\))\s+\S/i;
    if (lines.length > 1 && lines.every((l) => item.test(l))) {
      // A numbered or bulleted list: one paragraph per item (exam topic lists, premises).
      for (const l of lines) blocks.push({ kind: "para", text: l });
    } else if (lines.length === 1 && looksLikeHeading(first)) {
      blocks.push({ kind: "heading", level: headingLevel(first), text: first });
    } else if (looksLikeHeading(first) && lines.length > 1 && first.length < 80 && !/[.:,;]$/.test(first)) {
      blocks.push({ kind: "heading", level: headingLevel(first), text: first });
      blocks.push({ kind: "para", text: lines.slice(1).join(" ") });
    } else {
      blocks.push({ kind: "para", text: lines.join(" ") });
    }
  }
  return blocks;
}

function looksLikeHeading(line: string): boolean {
  if (line.length > 90 || /[.,;]$/.test(line)) return false;
  if (/^(rozdział|dział|część|wykład|temat)\b/i.test(line)) return true;
  if (/^([IVXLC]+|\d+(\.\d+)*)[.)]\s+\S/.test(line) && line.length < 70) return true;
  const letters = line.replace(/[^A-Za-zĄĆĘŁŃÓŚŹŻąćęłńóśźż]/g, "");
  return letters.length >= 4 && letters === letters.toUpperCase();
}

function headingLevel(line: string): number {
  if (/^(rozdział|dział|część|wykład)\b/i.test(line)) return 1;
  const m = line.match(/^(\d+(?:\.\d+)*)[.)]?\s/);
  if (m) return Math.min(3, m[1]!.split(".").length + 1);
  return 2;
}
