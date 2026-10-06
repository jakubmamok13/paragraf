// Client for a local model server on the laptop: Ollama (own API) or any
// OpenAI-compatible server (LM Studio, llama.cpp server). Nothing leaves the
// computer. Answers are forced into a JSON schema by the server.
import type { AiSettings } from "./settings";

export type FetchFn = typeof fetch;

export type AiCheck =
  | { ok: true; models: string[]; modelAvailable: boolean }
  | { ok: false; reason: "no_url" | "unreachable" | "http" | "bad_response"; detail: string };

/** Lists models and tells what is wrong when the server cannot be reached. */
export async function checkAi(cfg: AiSettings, fetchFn: FetchFn = fetch, timeoutMs = 5000): Promise<AiCheck> {
  if (!cfg.baseUrl) return { ok: false, reason: "no_url", detail: "Nie podano adresu serwera." };
  const url = cfg.provider === "ollama" ? `${cfg.baseUrl}/api/tags` : `${cfg.baseUrl}/v1/models`;
  let res: Response;
  try {
    res = await fetchFn(url, { signal: AbortSignal.timeout(timeoutMs) });
  } catch (e) {
    // The browser does not say whether the server is down or blocked by CORS.
    return { ok: false, reason: "unreachable", detail: e instanceof Error ? e.message : String(e) };
  }
  if (!res.ok) return { ok: false, reason: "http", detail: `HTTP ${res.status}` };
  let body: any;
  try {
    body = await res.json();
  } catch {
    return { ok: false, reason: "bad_response", detail: "Serwer nie zwrócił JSON." };
  }
  const models: string[] =
    cfg.provider === "ollama"
      ? (body?.models ?? []).map((m: any) => String(m.name ?? m.model))
      : (body?.data ?? []).map((m: any) => String(m.id));
  return { ok: true, models, modelAvailable: !!cfg.model && models.includes(cfg.model) };
}

export interface ChatJsonRequest {
  system: string;
  user: string;
  /** JSON Schema the answer must follow. */
  schema: object;
  signal?: AbortSignal;
  /** Context window to request from Ollama (tokens). */
  numCtx?: number;
}

export interface ChatJsonResult<T> {
  value: T;
  raw: string;
  durationMs: number;
  tokensIn: number | null;
  tokensOut: number | null;
}

export class AiError extends Error {
  constructor(
    message: string,
    readonly kind: "unreachable" | "http" | "bad_json" | "no_model",
  ) {
    super(message);
  }
}

export async function chatJson<T>(cfg: AiSettings, req: ChatJsonRequest, fetchFn: FetchFn = fetch): Promise<ChatJsonResult<T>> {
  if (!cfg.model) throw new AiError("Nie wybrano modelu AI (Ustawienia → Lokalne AI).", "no_model");
  const messages = [
    { role: "system", content: req.system },
    { role: "user", content: req.user },
  ];
  const ollama = cfg.provider === "ollama";
  const url = ollama ? `${cfg.baseUrl}/api/chat` : `${cfg.baseUrl}/v1/chat/completions`;
  const body = ollama
    ? {
        model: cfg.model,
        messages,
        stream: false,
        format: req.schema,
        options: { temperature: 0, ...(req.numCtx ? { num_ctx: req.numCtx } : {}) },
      }
    : {
        model: cfg.model,
        messages,
        temperature: 0,
        response_format: { type: "json_schema", json_schema: { name: "answer", strict: true, schema: req.schema } },
      };

  const started = Date.now();
  let res: Response;
  try {
    res = await fetchFn(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      ...(req.signal ? { signal: req.signal } : {}),
    });
  } catch (e) {
    throw new AiError(`Brak połączenia z lokalnym AI: ${e instanceof Error ? e.message : e}`, "unreachable");
  }
  if (!res.ok) throw new AiError(`Lokalne AI zwróciło błąd HTTP ${res.status}: ${await res.text().catch(() => "")}`, "http");
  const data: any = await res.json();
  const raw: string = ollama ? data?.message?.content ?? "" : data?.choices?.[0]?.message?.content ?? "";
  let value: T;
  try {
    value = JSON.parse(raw) as T;
  } catch {
    throw new AiError("Model zwrócił odpowiedź, która nie jest poprawnym JSON.", "bad_json");
  }
  return {
    value,
    raw,
    durationMs: Date.now() - started,
    tokensIn: (ollama ? data?.prompt_eval_count : data?.usage?.prompt_tokens) ?? null,
    tokensOut: (ollama ? data?.eval_count : data?.usage?.completion_tokens) ?? null,
  };
}

/** Human-readable hint for a failed check, in Polish, for the settings screen. */
export function aiCheckHint(check: AiCheck, cfg: AiSettings, pageOrigin: string): string {
  if (check.ok) {
    if (!check.models.length) return "Serwer działa, ale nie ma pobranego żadnego modelu.";
    if (!cfg.model) return "Połączono. Wybierz model z listy.";
    if (!check.modelAvailable) return `Połączono, ale modelu „${cfg.model}” nie ma na serwerze. Wybierz inny.`;
    return "Połączono. Model gotowy.";
  }
  switch (check.reason) {
    case "no_url":
      return "Podaj adres serwera, np. http://localhost:11434 dla Ollamy.";
    case "unreachable":
      return cfg.provider === "ollama"
        ? `Nie można połączyć się z Ollamą. Sprawdź, czy działa, i czy ma zezwolenie dla tej strony: ustaw zmienną środowiskową OLLAMA_ORIGINS=${pageOrigin} i uruchom Ollamę ponownie. Jeśli przeglądarka pyta o dostęp do urządzeń w sieci lokalnej, zezwól.`
        : "Nie można połączyć się z serwerem. Sprawdź, czy jest uruchomiony i czy ma włączone CORS (LM Studio: Developer → Settings → Enable CORS).";
    case "http":
      return `Serwer odpowiedział błędem (${check.detail}). Sprawdź adres i rodzaj serwera.`;
    case "bad_response":
      return "Pod tym adresem działa coś innego niż serwer AI. Sprawdź adres i rodzaj serwera.";
  }
}
