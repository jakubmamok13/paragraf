import { useEffect, useState } from "react";
import { type AiCheck, aiCheckHint, checkAi, exportPackage, getSettings, packageFileName, updateSettings } from "@paragraf/core";
import { Card, Field, useAction, useDb, useToast } from "../ui";
import { saveFile } from "../runtime";
import { importFromPicker } from "./Settings";

/** The laptop part: local AI, importing sources (next steps), packages for the phone. */
export function Workshop() {
  const { db, changed } = useDb();
  const act = useAction();
  const toast = useToast();
  const ai = getSettings(db).ai;
  const [check, setCheck] = useState<AiCheck | null>(null);
  const [checking, setChecking] = useState(false);
  const [baseUrl, setBaseUrl] = useState(ai.baseUrl);

  const runCheck = async () => {
    setChecking(true);
    setCheck(await checkAi(getSettings(db).ai));
    setChecking(false);
  };
  useEffect(() => {
    void runCheck();
    // Check once on open; later checks are manual.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const setProvider = (provider: "ollama" | "openai") => {
    const url = provider === "ollama" ? "http://localhost:11434" : "http://localhost:1234";
    setBaseUrl(url);
    void act(() => updateSettings(db, { ai: { ...ai, provider, baseUrl: url, model: "" } })).then(runCheck);
  };

  const pending = db.get<{ n: number }>("SELECT COUNT(*) AS n FROM material WHERE status = 'pending'")!.n;
  const active = db.get<{ n: number }>("SELECT COUNT(*) AS n FROM material WHERE status = 'active'")!.n;

  return (
    <div className="screen">
      <div className="screen-head">
        <h1>Pracownia</h1>
      </div>
      <p className="muted small">Tu, na komputerze, lokalne AI zamienia notatki i podręczniki w materiały do nauki. Nic nie wychodzi poza Twój komputer.</p>

      <Card title="Lokalne AI">
        <div className="segmented">
          <button className={ai.provider === "ollama" ? "on" : ""} onClick={() => setProvider("ollama")}>
            Ollama
          </button>
          <button className={ai.provider === "openai" ? "on" : ""} onClick={() => setProvider("openai")}>
            LM Studio / inny
          </button>
        </div>
        <Field label="Adres serwera">
          <input
            value={baseUrl}
            onChange={(e) => setBaseUrl(e.target.value)}
            onBlur={() => baseUrl !== ai.baseUrl && void act(() => updateSettings(db, { ai: { ...ai, baseUrl } })).then(runCheck)}
          />
        </Field>
        {check?.ok && check.models.length > 0 && (
          <Field label="Model">
            <select value={ai.model} onChange={(e) => void act(() => updateSettings(db, { ai: { ...ai, model: e.target.value } })).then(runCheck)}>
              <option value="">— wybierz —</option>
              {check.models.map((m) => (
                <option key={m}>{m}</option>
              ))}
            </select>
          </Field>
        )}
        <p className={`status ${check?.ok && check.modelAvailable ? "status-ok" : "status-warn"}`}>
          {checking ? "Sprawdzam…" : check ? aiCheckHint(check, ai, location.origin) : ""}
        </p>
        <button className="btn btn-secondary btn-small" onClick={() => void runCheck()} disabled={checking}>
          Sprawdź połączenie
        </button>
      </Card>

      <Card title="Źródła">
        <p className="muted small">
          Import notatek (Pages → Word, DOCX, TXT, MD, ODT, RTF, HTML), podręczników (PDF, EPUB) i tekstów ustaw pojawi się w kolejnym kroku.
        </p>
      </Card>

      <Card title="Telefon">
        <p className="muted small">
          Materiały: {active} aktywnych{pending ? `, ${pending} czeka na zatwierdzenie` : ""}. Paczkę przenieś na telefon przez iCloud Drive, mail albo
          komunikator, a na telefonie wybierz Ustawienia → Wczytaj paczkę.
        </p>
        <div className="row-wrap">
          <button
            className="btn btn-primary"
            onClick={() =>
              void act(async () => {
                await saveFile(packageFileName("content"), JSON.stringify(exportPackage(db, "content")));
              })
            }
          >
            Wyślij treść na telefon
          </button>
          <button className="btn btn-secondary" onClick={() => void importFromPicker(db, toast, changed)}>
            Wczytaj postęp z telefonu
          </button>
        </div>
      </Card>
    </div>
  );
}
