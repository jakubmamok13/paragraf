import { type Db, nowIso } from "./db";

/** Settings that belong to one device and never travel with synchronisation (the laptop's AI server). */
export const DEVICE_SETTINGS: readonly string[] = ["ai"];

export type AiProvider = "ollama" | "openai";

export interface AiSettings {
  /** "ollama" = Ollama's own API; "openai" = OpenAI-compatible server (LM Studio, llama.cpp). */
  provider: AiProvider;
  baseUrl: string;
  /** Model used for extraction and generation. Empty = not chosen yet. */
  model: string;
}

export interface ExternalSettings {
  /** Off by default: nothing goes to the internet unless you turn it on. */
  enabled: boolean;
  isapUrl: string;
  saosUrl: string;
  openAlexUrl: string;
  /** Optional e-mail for OpenAlex's "polite pool" (faster, more reliable). */
  email: string;
}

export interface Settings {
  /** Upper bound for the daily session, in minutes. */
  dailyMinutes: number;
  /** FSRS desired retention (0.7–0.97). */
  targetRetention: number;
  /** New materials per day across all subjects. */
  newPerDay: number;
  /** Generator limit per lecture note. */
  maxNewPerLecture: number;
  /** Mix subjects in the daily session (interleaving). */
  interleaveSubjects: boolean;
  ai: AiSettings;
  /** Process an imported file right away (else on demand). */
  autoProcess: boolean;
  /** User-edited system prompts, by prompt id. */
  promptOverrides: Record<string, string>;
  external: ExternalSettings;
  /** Read the short lesson aloud (speech synthesis of the device). */
  lessonAudio: boolean;
  lessonRate: number;
}

export const DEFAULT_SETTINGS: Settings = {
  dailyMinutes: 20,
  targetRetention: 0.9,
  newPerDay: 15,
  maxNewPerLecture: 20,
  interleaveSubjects: true,
  ai: { provider: "ollama", baseUrl: "http://localhost:11434", model: "" },
  autoProcess: true,
  promptOverrides: {},
  external: {
    enabled: false,
    isapUrl: "https://api.sejm.gov.pl",
    saosUrl: "https://www.saos.org.pl",
    openAlexUrl: "https://api.openalex.org",
    email: "",
  },
  lessonAudio: false,
  lessonRate: 1,
};

export const LIMITS = {
  dailyMinutes: [5, 240],
  targetRetention: [0.7, 0.97],
  newPerDay: [0, 100],
  maxNewPerLecture: [5, 60],
} as const satisfies Partial<Record<keyof Settings, readonly [number, number]>>;

const clamp = (v: number, [lo, hi]: readonly [number, number]) => Math.min(hi, Math.max(lo, v));

export function getSettings(db: Db): Settings {
  const rows = db.all<{ key: string; value_json: string }>("SELECT key, value_json FROM setting");
  const stored: Record<string, unknown> = {};
  for (const r of rows) {
    try {
      stored[r.key] = JSON.parse(r.value_json);
    } catch {
      /* a broken value falls back to the default */
    }
  }
  const ai = { ...DEFAULT_SETTINGS.ai, ...((stored.ai as Partial<AiSettings>) ?? {}) };
  const external = { ...DEFAULT_SETTINGS.external, ...((stored.external as Partial<ExternalSettings>) ?? {}) };
  return { ...DEFAULT_SETTINGS, ...stored, ai, external } as Settings;
}

export function updateSettings(db: Db, patch: Partial<Settings>): Settings {
  const next: Settings = { ...getSettings(db), ...patch };
  if (patch.ai) next.ai = { ...getSettings(db).ai, ...patch.ai };
  if (patch.external) next.external = { ...getSettings(db).external, ...patch.external };
  next.lessonRate = Math.min(1.6, Math.max(0.6, Number(next.lessonRate) || 1));
  for (const [key, range] of Object.entries(LIMITS) as [keyof typeof LIMITS, readonly [number, number]][]) {
    const v = Number(next[key]);
    if (!Number.isFinite(v)) throw new Error(`Nieprawidłowa wartość: ${key}`);
    next[key] = key === "targetRetention" ? clamp(v, range) : Math.round(clamp(v, range));
  }
  next.ai.baseUrl = next.ai.baseUrl.trim().replace(/\/+$/, "");
  // Only changed keys get a new timestamp, so a change made on another device to a
  // different setting is not overwritten when the two merge.
  const stored = new Map(db.all<{ key: string; value_json: string }>("SELECT key, value_json FROM setting").map((r) => [r.key, r.value_json]));
  const now = nowIso();
  db.tx(() => {
    for (const [key, value] of Object.entries(next)) {
      const json = JSON.stringify(value);
      // A default that was never changed is not written: it must not win over a value set elsewhere.
      if ((stored.get(key) ?? JSON.stringify(DEFAULT_SETTINGS[key as keyof Settings])) === json) continue;
      db.run(
        "INSERT INTO setting (key, value_json, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at",
        key,
        json,
        now,
      );
    }
  });
  return next;
}
