import { useState } from "react";
import { dismissSuggestion, listSuggestions } from "@paragraf/core";
import { type SourceRef, SourceViewer } from "../components";
import { useAction, useDb } from "../ui";

const KIND_LABEL: Record<string, string> = {
  gap: "Brak w źródłach",
  rejected_field: "Odrzucone przy analizie",
  rejected_material: "Odrzucony materiał",
};

/** What the AI thought was missing, and what it wrote but could not back with a source. Never turned into cards automatically. */
export function Suggestions({ onBack }: { onBack: () => void }) {
  const { db } = useDb();
  const act = useAction();
  const [source, setSource] = useState<SourceRef | null>(null);
  const items = listSuggestions(db);
  return (
    <div className="screen">
      <div className="screen-head">
        <button className="btn btn-ghost" onClick={onBack}>
          ← Wróć
        </button>
        <h1>Sugestie AI</h1>
      </div>
      <p className="muted small">
        Tu trafia to, czego AI nie mogło potwierdzić cytatem ze źródła (np. numer artykułu spoza notatki), i to, czego według niego brakuje. Jeśli coś jest
        ważne, dodaj własną fiszkę w przedmiocie albo uzupełnij notatkę.
      </p>
      {items.length === 0 && <p className="muted">Brak sugestii.</p>}
      <ul className="list">
        {items.map((s) => (
          <li key={s.id} className="card suggestion">
            <p className="small muted">{KIND_LABEL[s.kind] ?? s.kind}</p>
            <p className="small">{s.text}</p>
            <div className="review-actions">
              {s.chunkId && (
                <button className="btn btn-ghost btn-small" onClick={() => setSource({ chunkId: s.chunkId!, quote: "" })}>
                  Fragment źródła
                </button>
              )}
              <button className="btn btn-ghost btn-small" onClick={() => void act(() => dismissSuggestion(db, s.id))}>
                Odrzuć
              </button>
            </div>
          </li>
        ))}
      </ul>
      {source && <SourceViewer source={source} onClose={() => setSource(null)} />}
    </div>
  );
}
