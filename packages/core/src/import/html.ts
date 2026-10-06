import type { Block } from "./blocks";

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", sect: "§", ndash: "–", mdash: "—", bdquo: "„", rdquo: "”", ldquo: "“" };

export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
    if (e[0] === "#") {
      const code = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : m;
    }
    return ENTITIES[e.toLowerCase()] ?? m;
  });
}

/**
 * HTML (also XHTML from EPUB and HTML made from DOCX) into blocks, without a
 * DOM so it runs the same in the browser and in tests. Headings h1–h6;
 * p, li, blockquote, td, div with text become paragraphs.
 */
export function parseHtml(html: string, page?: number): Block[] {
  const body = html
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<(script|style|head|nav|svg)\b[\s\S]*?<\/\1>/gi, "")
    .replace(/<br\s*\/?>/gi, " ");
  const blocks: Block[] = [];
  const re = /<(h[1-6]|p|li|blockquote|td|th|dt|dd|div|caption|figcaption)\b[^>]*>([\s\S]*?)(?=<\/?(?:h[1-6]|p|li|blockquote|td|th|dt|dd|div|caption|figcaption|ul|ol|table|tr)\b|$)/gi;
  for (const m of body.matchAll(re)) {
    const tag = m[1]!.toLowerCase();
    const text = decodeEntities(m[2]!.replace(/<[^>]+>/g, "")).replace(/\s+/g, " ").trim();
    if (!text) continue;
    if (tag[0] === "h" && tag.length === 2) blocks.push({ kind: "heading", level: Number(tag[1]), text, ...(page != null ? { page } : {}) });
    else blocks.push({ kind: "para", text, ...(page != null ? { page } : {}) });
  }
  return blocks;
}

export function htmlTitle(html: string): string | undefined {
  const t = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1];
  return t ? decodeEntities(t).replace(/\s+/g, " ").trim() || undefined : undefined;
}
