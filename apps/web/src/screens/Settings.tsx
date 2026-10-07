import { useState } from "react";
import {
  type Db,
  decodePackage,
  encodePackage,
  exportPackage,
  getSettings,
  importPackage,
  LIMITS,
  packageFileName,
  type Settings as S,
  updateSettings,
} from "@paragraf/core";
import { Card, Field, useAction, useDb, useToast } from "../ui";
import { BUNDLED_PROMPTS, pickFiles, saveFile } from "../runtime";

const KIND_LABEL = { content: "treść", progress: "postęp nauki", backup: "pełna kopia" } as const;

export async function importFromPicker(db: Db, toast: (t: string, k?: "ok" | "error") => void, changed: () => void): Promise<void> {
  const [file] = await pickFiles(".gz,.json,application/gzip,application/json");
  if (!file) return;
  try {
    const pkg = decodePackage(file.bytes);
    if (
      pkg.kind === "backup" &&
      !confirm("To pełna kopia. Wczytanie ZASTĄPI wszystkie dane na tym urządzeniu (przedmioty, materiały, postęp). Kontynuować?")
    ) {
      return;
    }
    const r = importPackage(db, pkg);
    changed();
    toast(`Wczytano paczkę (${KIND_LABEL[r.kind]}): nowe ${r.inserted}, zaktualizowane ${r.updated}, usunięte ${r.deleted}.`);
  } catch (e) {
    toast(e instanceof Error ? e.message : String(e), "error");
  }
}

export function Settings() {
  const { db, changed } = useDb();
  const act = useAction();
  const toast = useToast();
  const s = getSettings(db);
  const [draft, setDraft] = useState({
    dailyMinutes: String(s.dailyMinutes),
    targetRetention: String(s.targetRetention).replace(".", ","),
    newPerDay: String(s.newPerDay),
    maxNewPerLecture: String(s.maxNewPerLecture),
  });

  const commit = (key: keyof typeof draft) => {
    const v = Number(draft[key].replace(",", "."));
    if (!Number.isFinite(v) || draft[key].trim() === "") {
      setDraft((d) => ({ ...d, [key]: String(s[key]).replace(".", ",") }));
      return;
    }
    void act(() => {
      const next = updateSettings(db, { [key]: v } as Partial<S>);
      setDraft((d) => ({ ...d, [key]: String(next[key]).replace(".", ",") }));
    });
  };
  const num = (key: keyof typeof draft, label: string, hint: string, decimal = false) => (
    <Field label={label} hint={`${hint} (${String(LIMITS[key][0]).replace(".", ",")}–${String(LIMITS[key][1]).replace(".", ",")})`}>
      <input
        inputMode={decimal ? "decimal" : "numeric"}
        value={draft[key]}
        onChange={(e) => setDraft((d) => ({ ...d, [key]: e.target.value }))}
        onBlur={() => commit(key)}
      />
    </Field>
  );

  return (
    <div className="screen">
      <div className="screen-head">
        <h1>Ustawienia</h1>
      </div>

      <Card title="Nauka">
        {num("dailyMinutes", "Minuty dziennie", "Sesja nigdy nie przekroczy tego czasu")}
        {num("newPerDay", "Nowe materiały dziennie", "Łącznie dla wszystkich przedmiotów")}
        {num("targetRetention", "Docelowa retencja", "Szansa, że przypomnisz sobie materiał w dniu powtórki", true)}
        {num("maxNewPerLecture", "Limit materiałów z jednego wykładu", "Lepiej mniej, a dobrze")}
        <label className="check">
          <input type="checkbox" checked={s.interleaveSubjects} onChange={(e) => void act(() => updateSettings(db, { interleaveSubjects: e.target.checked }))} />
          Mieszaj przedmioty w codziennej sesji
        </label>
      </Card>

      <Card title="Paczki i kopia zapasowa">
        <p className="muted small">
          Dane są tylko na tym urządzeniu. Rób kopię co jakiś czas i trzymaj ją np. w iCloud Drive.
        </p>
        <div className="row-wrap">
          <button className="btn btn-secondary" onClick={() => void importFromPicker(db, toast, changed)}>
            Wczytaj paczkę
          </button>
          <button
            className="btn btn-secondary"
            onClick={() => void act(() => saveFile(packageFileName("progress"), encodePackage(exportPackage(db, "progress"))))}
          >
            Wyślij postęp na komputer
          </button>
          <button
            className="btn btn-secondary"
            onClick={() => void act(() => saveFile(packageFileName("backup"), encodePackage(exportPackage(db, "backup"))))}
          >
            Eksportuj pełną kopię
          </button>
        </div>
      </Card>

      <Card title="Źródła z internetu">
        <label className="check">
          <input type="checkbox" checked={s.external.enabled} onChange={(e) => void act(() => updateSettings(db, { external: { ...s.external, enabled: e.target.checked } }))} />
          Uzupełniaj braki z oficjalnych i naukowych źródeł
        </label>
        <p className="muted small">
          Kolejność: ISAP (teksty ustaw) → SAOS (orzeczenia) → OpenAlex (publikacje naukowe). Do internetu wychodzi tylko zapytanie, które widzisz przed
          wysłaniem (np. „Kodeks cywilny”, sygnatura, hasło) – nigdy treść Twoich notatek. To, co przyjdzie, staje się zwykłym źródłem z cytatem.
        </p>
        <Field label="E-mail dla OpenAlex (opcjonalnie)" hint="Przyspiesza odpowiedzi OpenAlex; nigdzie indziej nie jest wysyłany.">
          <input
            type="email"
            defaultValue={s.external.email}
            onBlur={(e) => e.target.value !== s.external.email && void act(() => updateSettings(db, { external: { ...s.external, email: e.target.value.trim() } }))}
          />
        </Field>
      </Card>

      <Card title="Lekcje">
        <label className="check">
          <input type="checkbox" checked={s.lessonAudio} onChange={(e) => void act(() => updateSettings(db, { lessonAudio: e.target.checked }))} />
          Czytaj lekcje na głos (głos urządzenia)
        </label>
        <Field label={`Tempo czytania: ${s.lessonRate.toLocaleString("pl-PL")}×`}>
          <input type="range" min={0.6} max={1.6} step={0.1} value={s.lessonRate} onChange={(e) => void act(() => updateSettings(db, { lessonRate: Number(e.target.value) }))} />
        </Field>
        <p className="muted small">Domyślnie lekcja jest do czytania: we własnym tempie czytanie daje co najmniej takie zrozumienie jak słuchanie. Słuchanie przydaje się, gdy nie możesz patrzeć w ekran.</p>
      </Card>

      <Card title="Pracownia (komputer)">
        <label className="check">
          <input type="checkbox" checked={s.autoProcess} onChange={(e) => void act(() => updateSettings(db, { autoProcess: e.target.checked }))} />
          Przetwarzaj wczytane pliki od razu
        </label>
        <PromptEditor />
      </Card>

      <p className="muted small center">Paragraf {__APP_VERSION__} · schemat bazy v{db.schemaVersion}</p>
    </div>
  );
}

const PROMPT_NAMES: Record<string, string> = {
  "extract-topics": "Ekstrakcja zagadnień",
  "merge-topics": "Scalanie zagadnień",
  "generate-materials": "Generowanie materiałów",
};

/** System prompts are plain text: you can tune them. A changed prompt is a new version; old AI answers are not reused. */
function PromptEditor() {
  const { db } = useDb();
  const act = useAction();
  const overrides = getSettings(db).promptOverrides;
  const [open, setOpen] = useState<string | null>(null);
  const [text, setText] = useState("");
  return (
    <details>
      <summary>Prompty AI (zaawansowane)</summary>
      <p className="muted small">Instrukcje dla lokalnego modelu. Zasady o cytatach i zakazie dopisywania numerów artykułów i tak sprawdza aplikacja.</p>
      {Object.values(BUNDLED_PROMPTS).map((p) => (
        <div key={p.id} className="prompt">
          <div className="list-row">
            <span className="small">
              {PROMPT_NAMES[p.id] ?? p.id} {overrides[p.id] ? <span className="pill">zmieniony</span> : null}
            </span>
            <button
              className="btn btn-ghost btn-small"
              onClick={() => {
                setOpen(open === p.id ? null : p.id);
                setText(overrides[p.id] ?? p.system);
              }}
            >
              {open === p.id ? "Zamknij" : "Edytuj"}
            </button>
          </div>
          {open === p.id && (
            <>
              <textarea className="prompt-text" rows={14} value={text} onChange={(e) => setText(e.target.value)} />
              <div className="row-wrap">
                <button className="btn btn-primary btn-small" onClick={() => void act(() => updateSettings(db, { promptOverrides: { ...overrides, [p.id]: text } }), "Zapisano prompt.")}>
                  Zapisz
                </button>
                <button
                  className="btn btn-ghost btn-small"
                  onClick={() => {
                    const { [p.id]: _drop, ...rest } = overrides;
                    setText(p.system);
                    void act(() => updateSettings(db, { promptOverrides: rest }), "Przywrócono domyślny.");
                  }}
                >
                  Przywróć domyślny
                </button>
              </div>
            </>
          )}
        </div>
      ))}
    </details>
  );
}
