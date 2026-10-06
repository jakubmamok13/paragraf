import { useState } from "react";
import {
  type Db,
  exportPackage,
  getSettings,
  importPackage,
  LIMITS,
  packageFileName,
  parsePackage,
  type Settings as S,
  updateSettings,
} from "@paragraf/core";
import { Card, Field, useAction, useDb, useToast } from "../ui";
import { pickTextFile, saveFile } from "../runtime";

const KIND_LABEL = { content: "treść", progress: "postęp nauki", backup: "pełna kopia" } as const;

export async function importFromPicker(db: Db, toast: (t: string, k?: "ok" | "error") => void, changed: () => void): Promise<void> {
  const text = await pickTextFile();
  if (text === null) return;
  try {
    const pkg = parsePackage(text);
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
            onClick={() => void act(() => saveFile(packageFileName("progress"), JSON.stringify(exportPackage(db, "progress"))))}
          >
            Wyślij postęp na komputer
          </button>
          <button
            className="btn btn-secondary"
            onClick={() => void act(() => saveFile(packageFileName("backup"), JSON.stringify(exportPackage(db, "backup"))))}
          >
            Eksportuj pełną kopię
          </button>
        </div>
      </Card>

      <p className="muted small center">Paragraf {__APP_VERSION__} · schemat bazy v{db.schemaVersion}</p>
    </div>
  );
}
