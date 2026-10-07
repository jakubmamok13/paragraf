import { useEffect, useState } from "react";
import {
  type AiCheck,
  aiCheckHint,
  type BenchRow,
  benchmarkModels,
  checkAi,
  deleteDocument,
  DOCUMENT_KIND_LABEL,
  type DocumentKind,
  encodePackage,
  enqueueDocument,
  exportPackage,
  getSettings,
  importDocument,
  listDocuments,
  listJobs,
  listSubjects,
  localToday,
  packageFileName,
  parseFile,
  ACCEPTED_EXTENSIONS,
  updateSettings,
  workshopCounts,
} from "@paragraf/core";
import { Card, Field, useAction, useDb, useToast } from "../ui";
import { currentPrompts, parseDeps, pickFiles, saveFile } from "../runtime";
import { onProcessing, pauseProcessing, processingState, startProcessing } from "../processing";
import { importFromPicker } from "./Settings";
import { Review } from "./Review";
import { Conflicts } from "./Conflicts";
import { Suggestions } from "./Suggestions";
import { ExternalSources } from "./ExternalSources";

type Sub = "review" | "conflicts" | "suggestions" | { kind: "external"; query: string; subjectId?: string } | null;

/** The laptop part: sources in, local AI, decisions, package for the phone. */
export function Workshop() {
  const { db, changed } = useDb();
  const toast = useToast();
  const [sub, setSub] = useState<Sub>(null);
  const counts = workshopCounts(db);

  if (sub === "review") return <Review onBack={() => setSub(null)} />;
  if (sub === "conflicts") return <Conflicts onBack={() => setSub(null)} />;
  if (sub === "suggestions") return <Suggestions onBack={() => setSub(null)} onResearch={(query, subjectId) => setSub({ kind: "external", query, subjectId })} />;
  if (sub && typeof sub === "object") return <ExternalSources onBack={() => setSub(null)} initialQuery={sub.query} {...(sub.subjectId ? { initialSubjectId: sub.subjectId } : {})} />;

  const toReview = counts.pending + counts.needsReview + counts.flagged;
  return (
    <div className="screen">
      <div className="screen-head">
        <h1>Pracownia</h1>
      </div>
      <p className="muted small">Na komputerze lokalne AI zamienia notatki i podręczniki w materiały do nauki. Nic nie wychodzi poza Twój komputer.</p>

      {(toReview > 0 || counts.conflicts > 0 || counts.suggestions > 0) && (
        <Card title="Do decyzji">
          <div className="todo-grid">
            <button className="todo" onClick={() => setSub("review")} disabled={!toReview}>
              <strong>{toReview}</strong>
              <span>do zatwierdzenia</span>
              {counts.flagged > 0 && <span className="pill">{counts.flagged} zgłoszone z telefonu</span>}
            </button>
            <button className="todo" onClick={() => setSub("conflicts")} disabled={!counts.conflicts}>
              <strong>{counts.conflicts}</strong>
              <span>sprzeczności źródeł</span>
            </button>
            <button className="todo" onClick={() => setSub("suggestions")} disabled={!counts.suggestions}>
              <strong>{counts.suggestions}</strong>
              <span>sugestie AI</span>
            </button>
          </div>
        </Card>
      )}

      <ImportCard />
      <ProcessingCard />
      <Card title="Źródła z internetu">
        <p className="muted small">Brakujące teksty przepisów (ISAP), orzeczenia (SAOS) i publikacje naukowe (OpenAlex) – jako nowe źródła z cytatem.</p>
        <button className="btn btn-secondary" onClick={() => setSub({ kind: "external", query: "" })}>
          Uzupełnij braki
        </button>
      </Card>
      <AiCard />
      <DocumentsCard />

      <Card title="Telefon">
        <p className="muted small">
          Paczkę przenieś na telefon (iCloud Drive, mail, komunikator) i wczytaj w Ustawienia → Wczytaj paczkę. Na telefon trafiają zatwierdzone materiały i
          fragmenty źródeł, z których pochodzą.
        </p>
        <div className="row-wrap">
          <button
            className="btn btn-primary"
            onClick={() => void saveFile(packageFileName("content"), encodePackage(exportPackage(db, "content")))}
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

const KIND_OPTIONS: DocumentKind[] = ["note", "textbook", "act", "exam_list", "syllabus"];

function ImportCard() {
  const { db, changed } = useDb();
  const toast = useToast();
  const subjects = listSubjects(db);
  const [subjectId, setSubjectId] = useState(subjects[0]?.id ?? "");
  const [kind, setKind] = useState<DocumentKind>("note");
  const [lectureDate, setLectureDate] = useState(localToday());
  const [abbrev, setAbbrev] = useState("");
  const [stateAsOf, setStateAsOf] = useState("");
  const [busy, setBusy] = useState(false);
  const subject = subjects.find((s) => s.id === subjectId) ?? subjects[0];

  if (!subjects.length) {
    return (
      <Card title="Wczytaj źródło">
        <p className="muted small">Najpierw dodaj przedmiot (zakładka Przedmioty).</p>
      </Card>
    );
  }

  const choose = async () => {
    const files = await pickFiles(ACCEPTED_EXTENSIONS.join(","), true);
    if (!files.length || !subject) return;
    setBusy(true);
    let added = 0;
    for (const f of files) {
      try {
        const parsed = await parseFile(f.name, f.bytes, await parseDeps(f.name));
        const r = await importDocument(db, {
          subjectId: subject.id,
          kind,
          title: parsed.title ?? f.name,
          fileName: f.name,
          fileBytes: f.bytes,
          parsed,
          // A date in the file name or the first lines beats today's date.
          lectureDate: kind === "note" ? (parsed.detectedDate ?? lectureDate) : null,
          ...(kind === "act" ? { act: { abbrev, stateAsOf: stateAsOf || null } } : {}),
        });
        if (r.duplicate) toast(`„${f.name}”: ten plik jest już wczytany.`);
        else {
          added++;
          toast(`„${f.name}”: ${r.chunks} fragmentów${r.version > 1 ? `, wersja ${r.version} (nowe: ${r.newChunks})` : ""}.`);
          if (r.newChunks > 0) enqueueDocument(db, r.documentId);
        }
      } catch (e) {
        toast(`„${f.name}”: ${e instanceof Error ? e.message : String(e)}`, "error");
      }
    }
    setBusy(false);
    changed();
    if (added && getSettings(db).autoProcess) void startProcessing(db, changed);
  };

  return (
    <Card title="Wczytaj źródło">
      <div className="grid2">
        <Field label="Przedmiot">
          <select value={subject?.id} onChange={(e) => setSubjectId(e.target.value)}>
            {subjects.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Rodzaj">
          <select value={kind} onChange={(e) => setKind(e.target.value as DocumentKind)}>
            {KIND_OPTIONS.map((k) => (
              <option key={k} value={k}>
                {DOCUMENT_KIND_LABEL[k]}
              </option>
            ))}
          </select>
        </Field>
      </div>
      {kind === "note" && (
        <Field label="Data wykładu" hint="Jeśli data jest w nazwie pliku lub w pierwszych linijkach, zostanie użyta ona.">
          <input type="date" value={lectureDate} onChange={(e) => setLectureDate(e.target.value)} />
        </Field>
      )}
      {kind === "act" && (
        <div className="grid2">
          <Field label="Skrót aktu">
            <input value={abbrev} onChange={(e) => setAbbrev(e.target.value)} placeholder="k.c." />
          </Field>
          <Field label="Stan prawny na">
            <input type="date" value={stateAsOf} onChange={(e) => setStateAsOf(e.target.value)} />
          </Field>
        </div>
      )}
      <p className="muted small">PDF, EPUB, DOCX, ODT, RTF, TXT, MD, HTML. Z Pages: Plik → Eksportuj do → Word. Hierarchia: tekst ustawy rozstrzyga o brzmieniu przepisu, notatki o zakresie egzaminu, podręcznik pogłębia.</p>
      <button className="btn btn-primary" onClick={() => void choose()} disabled={busy || (kind === "act" && !abbrev.trim())}>
        {busy ? "Wczytuję…" : "Wybierz pliki"}
      </button>
    </Card>
  );
}

function ProcessingCard() {
  const { db, changed } = useDb();
  const [ps, setPs] = useState(processingState());
  useEffect(() => onProcessing(setPs), []);
  const jobs = listJobs(db, { activeOnly: true });
  const ai = getSettings(db).ai;
  if (!jobs.length && !ps.running && !ps.error) return null;
  return (
    <Card title="Przetwarzanie">
      {jobs.map((j) => (
        <div key={j.id} className="job">
          <div className="list-row">
            <span className="small">{j.label}</span>
            <span className="muted small">
              {j.status === "running" ? "w toku" : j.status === "queued" ? "w kolejce" : j.status === "paused" ? "wstrzymane" : j.status === "error" ? "błąd" : ""}
              {j.total ? ` · ${j.done}/${j.total}` : ""}
            </span>
          </div>
          {j.total > 0 && (
            <div className="bar" title={`${j.done} z ${j.total}`}>
              <span style={{ width: `${(j.done / j.total) * 100}%` }} />
            </div>
          )}
        </div>
      ))}
      {ps.error && <p className="status status-warn">{ps.error}</p>}
      {!ai.model && <p className="status status-warn">Najpierw wybierz model w sekcji Lokalne AI.</p>}
      <div className="row-wrap">
        {ps.running ? (
          <button className="btn btn-secondary" onClick={pauseProcessing}>
            Wstrzymaj
          </button>
        ) : (
          <button className="btn btn-primary" onClick={() => void startProcessing(db, changed)} disabled={!ai.model || !jobs.length}>
            {jobs.some((j) => j.status === "paused" || j.status === "error") ? "Wznów" : "Przetwarzaj"}
          </button>
        )}
      </div>
      <p className="muted small">Postęp zapisuje się po każdym fragmencie: możesz wstrzymać albo zamknąć aplikację i wrócić później. Podręcznik może trwać kilka godzin – zostaw na noc.</p>
    </Card>
  );
}

function AiCard() {
  const { db } = useDb();
  const act = useAction();
  const ai = getSettings(db).ai;
  const [check, setCheck] = useState<AiCheck | null>(null);
  const [checking, setChecking] = useState(false);
  const [baseUrl, setBaseUrl] = useState(ai.baseUrl);
  const [bench, setBench] = useState<{ docId: string; models: string[]; rows: BenchRow[] | null; running: boolean }>({ docId: "", models: [], rows: null, running: false });

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

  // Notes first: the model comparison is most telling on the user's own lecture notes.
  const docs = listDocuments(db)
    .filter((d) => d.kind !== "exam_list" && d.kind !== "syllabus")
    .sort((a, b) => Number(b.kind === "note") - Number(a.kind === "note"));
  const runBench = async () => {
    setBench((b) => ({ ...b, running: true, rows: null }));
    const rows = await benchmarkModels(db, { prompts: currentPrompts(db) }, bench.models, bench.docId || docs[0]!.id, 3);
    setBench((b) => ({ ...b, running: false, rows }));
  };

  return (
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
      <p className={`status ${check?.ok && check.modelAvailable ? "status-ok" : "status-warn"}`}>{checking ? "Sprawdzam…" : check ? aiCheckHint(check, ai, location.origin) : ""}</p>
      <button className="btn btn-secondary btn-small" onClick={() => void runCheck()} disabled={checking}>
        Sprawdź połączenie
      </button>

      {check?.ok && check.models.length > 1 && docs.length > 0 && (
        <details className="bench">
          <summary>Porównaj modele na swojej notatce</summary>
          <p className="muted small">Każdy model analizuje 3 pierwsze fragmenty wybranego dokumentu. Nic nie jest zapisywane. Liczy się odsetek treści potwierdzonych cytatem i czas.</p>
          <Field label="Dokument">
            <select value={bench.docId} onChange={(e) => setBench((b) => ({ ...b, docId: e.target.value }))}>
              {docs.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.title}
                </option>
              ))}
            </select>
          </Field>
          <div className="checks">
            {check.models.map((m) => (
              <label key={m} className="check">
                <input
                  type="checkbox"
                  checked={bench.models.includes(m)}
                  onChange={(e) => setBench((b) => ({ ...b, models: e.target.checked ? [...b.models, m] : b.models.filter((x) => x !== m) }))}
                />
                {m}
              </label>
            ))}
          </div>
          <button className="btn btn-secondary btn-small" disabled={!bench.models.length || bench.running} onClick={() => void runBench()}>
            {bench.running ? "Porównuję…" : "Porównaj"}
          </button>
          {bench.rows && (
            <table className="table">
              <thead>
                <tr>
                  <th>Model</th>
                  <th>Czas</th>
                  <th>Zagadnienia</th>
                  <th>Treści z cytatem</th>
                  <th>Odrzucone</th>
                </tr>
              </thead>
              <tbody>
                {bench.rows.map((r) => (
                  <tr key={r.model}>
                    <td>{r.model}</td>
                    <td>{r.seconds.toLocaleString("pl-PL")} s</td>
                    <td>{r.topics}</td>
                    <td>
                      {r.fields} ({Math.round(r.verifiedShare * 100)}%)
                    </td>
                    <td>{r.error ? `błąd: ${r.error}` : r.rejected}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </details>
      )}
    </Card>
  );
}

function DocumentsCard() {
  const { db } = useDb();
  const act = useAction();
  const docs = listDocuments(db);
  if (!docs.length) return null;
  const subjects = new Map(listSubjects(db, { includeArchived: true }).map((s) => [s.id, s.name]));
  return (
    <Card title="Źródła">
      <ul className="list">
        {docs.map((d) => (
          <li key={d.id} className="doc">
            <div>
              <strong className="small">{d.title}</strong>
              <p className="muted small">
                {subjects.get(d.subjectId)} · {DOCUMENT_KIND_LABEL[d.kind]}
                {d.lectureDate ? ` · ${d.lectureDate}` : ""} · przeanalizowano {d.processed}/{d.chunks} · materiały: {d.materials}
                {d.version > 1 ? ` · wersja ${d.version}` : ""}
              </p>
            </div>
            <button
              className="btn btn-ghost btn-small"
              aria-label={`Usuń ${d.title}`}
              onClick={() =>
                confirm(`Usunąć „${d.title}”? Materiały, które stracą jedyne źródło, wrócą do sprawdzenia.`) &&
                void act(() => deleteDocument(db, d.id), "Usunięto źródło.")
              }
            >
              Usuń
            </button>
          </li>
        ))}
      </ul>
    </Card>
  );
}
