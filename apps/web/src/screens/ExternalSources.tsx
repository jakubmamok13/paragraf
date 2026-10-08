import { useState } from "react";
import {
  type ActHit,
  actTitleFor,
  enqueueDocument,
  ExternalError,
  findCaseNumbers,
  getSettings,
  importActArticles,
  importJudgment,
  importScholarly,
  type JudgmentHit,
  listSubjects,
  provisionGaps,
  scholarSearchUrl,
  searchActs,
  searchJudgments,
  searchScholarly,
  updateSettings,
  type WorkHit,
} from "@paragraf/core";
import { Card, Field, useAction, useDb, useToast } from "../ui";
import { startProcessing } from "../processing";
import { parseDeps } from "../runtime";

/**
 * Filling gaps from the internet, in order of authority: ISAP (statutes),
 * SAOS (judgments), OpenAlex (scholarly publications). What you import
 * becomes a source document and goes through the same checks as your notes.
 */
export function ExternalSources({ onBack, initialQuery = "", initialSubjectId }: { onBack: () => void; initialQuery?: string; initialSubjectId?: string }) {
  const { db, changed } = useDb();
  const act = useAction();
  const subjects = listSubjects(db);
  const [subjectId, setSubjectId] = useState(initialSubjectId ?? subjects[0]?.id ?? "");
  const ext = getSettings(db).external;

  return (
    <div className="screen">
      <div className="screen-head">
        <button className="btn btn-ghost" onClick={onBack}>
          ← Wróć
        </button>
        <h1>Źródła z internetu</h1>
      </div>
      {!ext.enabled ? (
        <Card>
          <p className="small">
            Ta funkcja jest wyłączona. Po włączeniu aplikacja może pobierać teksty ustaw z ISAP, orzeczenia z SAOS i streszczenia publikacji z OpenAlex. Do
            internetu wychodzi tylko zapytanie, które widzisz – nigdy treść notatek.
          </p>
          <button className="btn btn-primary" onClick={() => void act(() => updateSettings(db, { external: { ...ext, enabled: true } }))}>
            Włącz
          </button>
        </Card>
      ) : !subjects.length ? (
        <p className="muted">Najpierw dodaj przedmiot.</p>
      ) : (
        <>
          <Field label="Przedmiot">
            <select value={subjectId} onChange={(e) => setSubjectId(e.target.value)}>
              {subjects.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </select>
          </Field>
          <IsapCard subjectId={subjectId} onImported={(id) => (enqueueDocument(db, id), changed(), void startProcessing(db, changed))} />
          <SaosCard subjectId={subjectId} onImported={(id) => (enqueueDocument(db, id), changed(), void startProcessing(db, changed))} />
          <ScholarCard subjectId={subjectId} initialQuery={initialQuery} onImported={(id) => (enqueueDocument(db, id), changed(), void startProcessing(db, changed))} />
        </>
      )}
    </div>
  );
}

function ErrorNote({ error }: { error: unknown }) {
  if (!error) return null;
  const e = error as Error;
  return (
    <p className="status status-warn">
      {e.message}{" "}
      {e instanceof ExternalError && e.manualUrl && (
        <a href={e.manualUrl} target="_blank" rel="noreferrer">
          Otwórz stronę
        </a>
      )}
    </p>
  );
}

// ---------- ISAP ----------

function IsapCard({ subjectId, onImported }: { subjectId: string; onImported: (documentId: string) => void }) {
  const { db } = useDb();
  const toast = useToast();
  const gaps = provisionGaps(db, subjectId);
  const [title, setTitle] = useState(gaps[0] ? (actTitleFor(gaps[0].act) ?? "") : "");
  const [articles, setArticles] = useState(gaps[0]?.articles.join(", ") ?? "");
  const [hits, setHits] = useState<ActHit[] | null>(null);
  const [chosen, setChosen] = useState<string>("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);

  const search = async () => {
    setBusy(true);
    setError(null);
    try {
      const h = await searchActs(db, title);
      setHits(h);
      setChosen(h.find((x) => x.hasHtml || x.hasPdf)?.eli ?? "");
    } catch (e) {
      setError(e);
    }
    setBusy(false);
  };
  const download = async () => {
    const hit = hits?.find((h) => h.eli === chosen);
    if (!hit) return;
    setBusy(true);
    setError(null);
    try {
      // Newest consolidated texts often come only as PDF: the PDF reader loads then.
      const deps = hit.hasHtml ? {} : await parseDeps("akt.pdf");
      const r = await importActArticles(db, { subjectId, act: hit, articles: articles.split(/[\s,;]+/) }, fetch, deps);
      toast(`Pobrano art. ${r.found.join(", ")}${r.missing.length ? `; nie znaleziono: ${r.missing.join(", ")}` : ""}.`);
      onImported(r.result.documentId);
      setHits(null);
    } catch (e) {
      setError(e);
    }
    setBusy(false);
  };

  return (
    <Card title="1. Teksty ustaw (ISAP)">
      {gaps.length > 0 ? (
        <div className="small">
          <p className="muted">Twoje materiały powołują przepisy, których tekstu jeszcze nie masz:</p>
          <ul>
            {gaps.map((g) => (
              <li key={g.act}>
                <button className="link" onClick={() => (setTitle(actTitleFor(g.act) ?? g.abbrev), setArticles(g.articles.join(", ")), setHits(null))}>
                  {g.abbrev}: art. {g.articles.join(", ")}
                </button>
              </li>
            ))}
          </ul>
        </div>
      ) : (
        <p className="muted small">Brak przepisów do uzupełnienia. Możesz wyszukać akt ręcznie.</p>
      )}
      <div className="grid2">
        <Field label="Akt">
          <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Kodeks cywilny" />
        </Field>
        <Field label="Artykuły">
          <input value={articles} onChange={(e) => setArticles(e.target.value)} placeholder="117, 118, 172" />
        </Field>
      </div>
      <button className="btn btn-secondary btn-small" disabled={busy || !title.trim()} onClick={() => void search()}>
        Szukaj tekstu jednolitego: „{title || "…"}”
      </button>
      {hits && (
        <>
          {hits.length === 0 && <p className="muted small">Nic nie znaleziono.</p>}
          {hits.slice(0, 6).map((h) => (
            <label key={h.eli} className="check option">
              <input type="radio" name="act" checked={chosen === h.eli} disabled={!h.hasHtml && !h.hasPdf} onChange={() => setChosen(h.eli)} />
              <span className="small">
                {h.title} <span className="muted">· {h.display}{h.date ? ` · ${h.date}` : ""}{h.hasHtml ? "" : h.hasPdf ? " · PDF" : " · brak tekstu"}</span>
              </span>
            </label>
          ))}
          <button className="btn btn-primary" disabled={busy || !chosen || !articles.trim()} onClick={() => void download()}>
            Pobierz wybrane artykuły
          </button>
        </>
      )}
      <ErrorNote error={error} />
    </Card>
  );
}

// ---------- SAOS ----------

function SaosCard({ subjectId, onImported }: { subjectId: string; onImported: (documentId: string) => void }) {
  const { db } = useDb();
  const toast = useToast();
  const imported = new Set(
    db.all<{ meta_json: string }>("SELECT meta_json FROM source_document WHERE subject_id = ? AND kind = 'case_law'", subjectId).map((r) => JSON.parse(r.meta_json ?? "{}").caseNumber),
  );
  const found = [
    ...new Set(
      db
        .all<{ text: string }>("SELECT c.text FROM source_chunk c JOIN source_document d ON d.id = c.document_id WHERE d.subject_id = ? AND d.kind IN ('note', 'textbook')", subjectId)
        .flatMap((r) => findCaseNumbers(r.text)),
    ),
  ].filter((c) => !imported.has(c));
  const [sig, setSig] = useState(found[0] ?? "");
  const [hits, setHits] = useState<JudgmentHit[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError(e);
    }
    setBusy(false);
  };
  return (
    <Card title="2. Orzeczenia (SAOS)">
      {found.length > 0 && (
        <p className="small">
          <span className="muted">Sygnatury w Twoich materiałach: </span>
          {found.map((f) => (
            <button key={f} className="link" onClick={() => (setSig(f), setHits(null))}>
              {f}{" "}
            </button>
          ))}
        </p>
      )}
      <Field label="Sygnatura">
        <input value={sig} onChange={(e) => setSig(e.target.value)} placeholder="III CZP 12/20" />
      </Field>
      <button className="btn btn-secondary btn-small" disabled={busy || !sig.trim()} onClick={() => void run(async () => setHits(await searchJudgments(db, sig.trim())))}>
        Szukaj w SAOS: „{sig || "…"}”
      </button>
      {hits?.length === 0 && <p className="muted small">SAOS nie ma tego orzeczenia (nie obejmuje m.in. sądów administracyjnych).</p>}
      {hits?.map((h) => (
        <div key={h.id} className="hit">
          <p className="small">
            <strong>{h.caseNumber}</strong> <span className="muted">· {h.court} · {h.date}</span>
          </p>
          <p className="small muted">{h.excerpt}</p>
          <button
            className="btn btn-primary btn-small"
            disabled={busy}
            onClick={() =>
              void run(async () => {
                const r = await importJudgment(db, { subjectId, id: h.id });
                toast(`Dodano orzeczenie ${h.caseNumber}.`);
                onImported(r.documentId);
                setHits(null);
              })
            }
          >
            Dodaj jako źródło
          </button>
        </div>
      ))}
      <ErrorNote error={error} />
    </Card>
  );
}

// ---------- OpenAlex ----------

function ScholarCard({ subjectId, initialQuery, onImported }: { subjectId: string; initialQuery: string; onImported: (documentId: string) => void }) {
  const { db } = useDb();
  const toast = useToast();
  const [q, setQ] = useState(initialQuery);
  const [hits, setHits] = useState<WorkHit[] | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const search = async () => {
    setBusy(true);
    setError(null);
    try {
      setHits(await searchScholarly(db, q.trim()));
    } catch (e) {
      setError(e);
    }
    setBusy(false);
  };
  return (
    <Card title="3. Publikacje naukowe (OpenAlex)">
      <p className="muted small">Gdy ustawy i orzeczenia nie odpowiadają (np. stanowiska doktryny). Importowane jest streszczenie publikacji, zawsze z autorami i rokiem.</p>
      <Field label="Czego szukać" hint="Popraw zapytanie przed wysłaniem – tylko ono wychodzi do internetu.">
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="np. przedawnienie roszczeń nowelizacja 2018" />
      </Field>
      <div className="row-wrap">
        <button className="btn btn-secondary btn-small" disabled={busy || q.trim().length < 3} onClick={() => void search()}>
          Szukaj w OpenAlex
        </button>
        <a className="btn btn-ghost btn-small" href={scholarSearchUrl(q)} target="_blank" rel="noreferrer">
          Google Scholar (ręcznie) ↗
        </a>
      </div>
      {hits?.length === 0 && <p className="muted small">Brak publikacji ze streszczeniem. Spróbuj innych słów albo Google Scholar.</p>}
      {hits?.map((w) => (
        <div key={w.id} className="hit">
          <p className="small">
            <strong>{w.title}</strong>
            <span className="muted">
              {" "}
              · {w.authors.slice(0, 3).join(", ")}
              {w.year ? ` (${w.year})` : ""}
              {w.venue ? ` · ${w.venue}` : ""}
              {w.language ? ` · ${w.language}` : ""}
            </span>
          </p>
          <p className="small muted">{open === w.id ? w.abstract : `${w.abstract.slice(0, 220)}…`}</p>
          <div className="row-wrap">
            <button className="btn btn-ghost btn-small" onClick={() => setOpen(open === w.id ? null : w.id)}>
              {open === w.id ? "Zwiń" : "Całe streszczenie"}
            </button>
            <button
              className="btn btn-primary btn-small"
              disabled={busy}
              onClick={() =>
                void (async () => {
                  try {
                    const r = await importScholarly(db, { subjectId, work: w });
                    toast("Dodano publikację jako źródło.");
                    onImported(r.documentId);
                  } catch (e) {
                    setError(e);
                  }
                })()
              }
            >
              Dodaj jako źródło
            </button>
          </div>
        </div>
      ))}
      <ErrorNote error={error} />
    </Card>
  );
}
