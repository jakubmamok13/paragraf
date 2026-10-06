import { useState } from "react";
import { DOCUMENT_KIND_LABEL, listConflicts, resolveConflict } from "@paragraf/core";
import { Citation, type SourceRef, SourceViewer } from "../components";
import { useAction, useDb } from "../ui";
import { startProcessing } from "../processing";

const RANK_HINT: Record<number, string> = { 1: "tekst ustawy rozstrzyga o brzmieniu przepisu", 2: "notatki rozstrzygają o zakresie i stanowisku prowadzącego", 3: "podręcznik służy pogłębieniu" };

/** Sources that disagree: the app never picks one silently. */
export function Conflicts({ onBack }: { onBack: () => void }) {
  const { db, changed } = useDb();
  const act = useAction();
  const [source, setSource] = useState<SourceRef | null>(null);
  const [notes, setNotes] = useState<Record<string, string>>({});
  const conflicts = listConflicts(db);

  return (
    <div className="screen">
      <div className="screen-head">
        <button className="btn btn-ghost" onClick={onBack}>
          ← Wróć
        </button>
        <h1>Sprzeczności źródeł</h1>
      </div>
      <p className="muted small">
        Źródła mówią co innego (np. podręcznik sprzed nowelizacji). Wybierz właściwą wersję. Materiały z odrzuconej wersji wrócą do sprawdzenia, a dla wybranej
        powstaną nowe.
      </p>
      {conflicts.length === 0 && <p className="muted">Brak sprzeczności.</p>}
      {conflicts.map((c) => (
        <section key={c.id} className="card">
          <h2 className="card-title">
            {c.topicName} · {c.fieldLabel}
            {c.kind === "provision_number" && <span className="pill">inny przepis</span>}
          </h2>
          <div className="conflict-grid">
            {c.candidates.map((v) => (
              <div key={v.fieldId} className={`version ${c.hintFieldId === v.fieldId ? "hinted" : ""}`}>
                <p className="small muted">{DOCUMENT_KIND_LABEL[v.documentKind]}</p>
                <p className="version-text">{v.text}</p>
                {v.chunkId && <Citation quote={v.quote} title={v.documentTitle} page={v.page} lectureDate={v.lectureDate} onOpen={() => setSource({ chunkId: v.chunkId!, quote: v.quote })} />}
                {c.hintFieldId === v.fieldId && <p className="small">Wskazówka: {RANK_HINT[v.rank]}.</p>}
                <button
                  className="btn btn-primary btn-small"
                  onClick={() =>
                    void act(() => {
                      resolveConflict(db, c.id, v.fieldId, notes[c.id]);
                      void startProcessing(db, changed);
                    }, "Wybrano wersję. Materiały zostaną przygotowane.")
                  }
                >
                  Ta wersja jest właściwa
                </button>
              </div>
            ))}
          </div>
          <label className="field">
            <span className="field-label">Notatka (opcjonalnie)</span>
            <input value={notes[c.id] ?? ""} onChange={(e) => setNotes((n) => ({ ...n, [c.id]: e.target.value }))} placeholder="np. stan po nowelizacji z 2018 r." />
          </label>
        </section>
      ))}
      {source && <SourceViewer source={source} onClose={() => setSource(null)} />}
    </div>
  );
}
