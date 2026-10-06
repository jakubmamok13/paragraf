import type { Db } from "./db";

export type AiProvider = "ollama" | "openai";

export interface AiSettings {
  /** "ollama" = Ollama's own API; "openai" = OpenAI-compatible server (LM Studio, llama.cpp). */
  provider: AiProvider;
  baseUrl: string;
  /** Model used for extraction and generation. Empty = not chosen yet. */
  model: string;
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
}

export const DEFAULT_SETTINGS: Settings = {
  dailyMinutes: 20,
  targetRetention: 0.9,
  newPerDay: 15,
  maxNewPerLecture: 20,
  interleaveSubjects: true,
  ai: { provider: "ollama", baseUrl: "http://localhost:11434", model: "" },
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
  return { ...DEFAULT_SETTINGS, ...stored, ai } as Settings;
}

export function updateSettings(db: Db, patch: Partial<Settings>): Settings {
  const next: Settings = { ...getSettings(db), ...patch };
  if (patch.ai) next.ai = { ...getSettings(db).ai, ...patch.ai };
  for (const [key, range] of Object.entries(LIMITS) as [keyof typeof LIMITS, readonly [number, number]][]) {
    const v = Number(next[key]);
    if (!Number.isFinite(v)) throw new Error(`Nieprawidłowa wartość: ${key}`);
    next[key] = key === "targetRetention" ? clamp(v, range) : Math.round(clamp(v, range));
  }
  next.ai.baseUrl = next.ai.baseUrl.trim().replace(/\/+$/, "");
  db.tx(() => {
    for (const [key, value] of Object.entries(next)) {
      db.run(
        "INSERT INTO setting (key, value_json) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json",
        key,
        JSON.stringify(value),
      );
    }
  });
  return next;
}
