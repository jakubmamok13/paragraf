import { useState } from "react";
import { dismissAllSuggestions, dismissSuggestion, listSuggestions, recheckRejected } from "@paragraf/core";
import { type SourceRef, SourceViewer } from "../components";
import { useAction, useDb } from "../ui";
import { startProcessing } from "../processing";

const KIND_LABEL: Record<string, string> = {
  gap: "Brak w źródłach",
  rejected_field: "Odrzucone przy analizie",
  rejected_material: "Odrzucony materiał",
};

/** "Topic: „claim” (reason)" as written by the pipeline. */
function parse(text: string): { topic: string; claim: string; reason: string } | null {
  const m = /^([^:]+): „([\s\S]*?)” \(([\s\S]*)\)$/.exec(text);
  return m ? { topic: m[1]!.trim(), claim: m[2]!.trim(), reason: m[3]!.trim() } : null;
}

/** What the AI thought was missing, and what it wrote but could not back with a source. Never turned into cards automatically. */
export function Suggestions({
  onBack,
  onResearch,
  onOwnCard,
}: {
  onBack: () => void;
  onResearch: (query: string, subjectId: string) => void;
  onOwnCard: (subjectId: string, topic: string, text: string) => void;
}) {
  const { db, changed } = useDb();
  const act = useAction();
  const [source, setSource] = useState<SourceRef | null>(null);
  const items = listSuggestions(db);
  const rejectedCount = items.filter((s) => s.kind === "rejected_field").length;
  return (
    <div className="screen">
      <div className="screen-head">
        <button className="btn btn-ghost" onClick={onBack}>
          ← Wróć
        </button>
        <h1>Sugestie AI</h1>
      </div>
      <p className="muted small">
        Tu trafia to, czego AI nie mogło potwierdzić zdaniem ze źródła, i to, czego według niego brakuje. Fiszki powstają tylko z tego, co jest w Twoich
        źródłach, bo AI potrafi napisać przekonującą, ale błędną definicję. Przy każdej pozycji widać, co w źródle było najbliżej.
      </p>
      {items.length > 0 && (
        <div className="row-wrap">
          {rejectedCount > 0 && (
            <button
              className="btn btn-secondary"
              onClick={() =>
                void act(() => {
                  const r = recheckRejected(db);
                  void startProcessing(db, changed);
                  return r;
                }, "Fragmenty z odrzuconymi pozycjami zostaną przeczytane ponownie. To, co się potwierdzi, trafi do zatwierdzenia.")
              }
            >
              Sprawdź ponownie odrzucone ({rejectedCount})
            </button>
          )}
          <button
            className="btn btn-ghost danger"
            onClick={() =>
              confirm(`Odrzucić wszystkie sugestie (${items.length})? Nie wpływa to na zagadnienia ani fiszki.`) &&
              void act(() => dismissAllSuggestions(db), `Odrzucono ${items.length}.`)
            }
          >
            Odrzuć wszystkie ({items.length})
          </button>
        </div>
      )}
      {items.length === 0 && <p className="muted">Brak sugestii.</p>}
      <ul className="list">
        {items.map((s) => {
          const p = s.kind === "rejected_field" ? parse(s.text) : null;
          return (
            <li key={s.id} className="card suggestion">
              <p className="small muted">{KIND_LABEL[s.kind] ?? s.kind}</p>
              {p ? (
                <>
                  <p className="small">
                    <strong>{p.topic}</strong>: {p.claim}
                  </p>
                  <ul className="small muted reasons">
                    {p.reason.split(/; (?=model podał|cytat modelu|najbliżej w źródle|fragment nie zawiera)/).map((r, i) => (
                      <li key={i}>{r.charAt(0).toUpperCase() + r.slice(1)}</li>
                    ))}
                  </ul>
                </>
              ) : (
                <p className="small">{s.text}</p>
              )}
              <div className="review-actions">
                {s.chunkId && (
                  <button className="btn btn-ghost btn-small" onClick={() => setSource({ chunkId: s.chunkId!, quote: "" })}>
                    Fragment źródła
                  </button>
                )}
                <button
                  className="btn btn-ghost btn-small"
                  onClick={() =>
                    onResearch(p ? `${p.topic} ${p.claim}`.slice(0, 120) : `${s.topicName ? `${s.topicName} ` : ""}${s.text.replace(/^[^:]+:\s*/, "").replace(/\(.*?\)/g, "").slice(0, 120)}`.trim(), s.subjectId)
                  }
                >
                  Szukaj w źródłach
                </button>
                {p && (
                  <button className="btn btn-ghost btn-small" onClick={() => onOwnCard(s.subjectId, s.topicName ?? p.topic, p.claim)}>
                    Własna fiszka…
                  </button>
                )}
                <button className="btn btn-ghost btn-small" onClick={() => void act(() => dismissSuggestion(db, s.id))}>
                  Odrzuć
                </button>
              </div>
            </li>
          );
        })}
      </ul>
      {source && <SourceViewer source={source} onClose={() => setSource(null)} />}
    </div>
  );
}
