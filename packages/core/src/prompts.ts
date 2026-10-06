// System prompts live in prompts/*.md (front matter: id, version). The user
// can override any of them in the app; the override changes the version, so
// cached AI answers made with the old text are not reused.

export interface Prompt {
  id: string;
  version: string;
  system: string;
}
export type PromptSet = Record<string, Prompt>;

export function parsePromptFile(src: string): Prompt {
  const m = src.replace(/\r\n?/g, "\n").match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!m) throw new Error("Plik promptu musi zaczynać się od nagłówka --- id/version ---.");
  const meta: Record<string, string> = {};
  for (const line of m[1]!.split("\n")) {
    const kv = line.match(/^(\w+):\s*(.*)$/);
    if (kv) meta[kv[1]!] = kv[2]!.trim();
  }
  if (!meta.id) throw new Error("Brak id w nagłówku promptu.");
  return { id: meta.id, version: meta.version ?? "1", system: m[2]!.trim() };
}

export function loadPrompts(files: string[]): PromptSet {
  const set: PromptSet = {};
  for (const f of files) {
    const p = parsePromptFile(f);
    set[p.id] = p;
  }
  return set;
}

/** Applies the user's edited texts on top of the bundled prompts. */
export function withOverrides(base: PromptSet, overrides: Record<string, string>): PromptSet {
  const out: PromptSet = { ...base };
  for (const [id, text] of Object.entries(overrides)) {
    const p = base[id];
    if (!p || !text.trim() || text.trim() === p.system) continue;
    out[id] = { ...p, version: `${p.version}-user-${simpleHash(text)}`, system: text.trim() };
  }
  return out;
}

function simpleHash(s: string): string {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return (h >>> 0).toString(36);
}
