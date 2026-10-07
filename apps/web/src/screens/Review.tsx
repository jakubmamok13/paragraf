import { useState } from "react";
import { approveMaterials, editMaterial, enqueueGeneration, rejectMaterial, type ReviewMaterial, reviewQueue, topicSchema } from "@paragraf/core";
import { Citation, MaterialPreview, type SourceRef, SourceViewer } from "../components";
import { useAction, useDb } from "../ui";
import { startProcessing } from "../processing";

/** The approval queue: accept / edit / reject / too easy, one gesture each; whole topics or the whole batch at once. */
export function Review({ onBack }: { onBack: () => void }) {
  const { db, changed } = useDb();
  const act = useAction();
  const [editing, setEditing] = useState<string | null>(null);
  const [source, setSource] = useState<SourceRef | null>(null);
  const queue = reviewQueue(db);

  const groups = new Map<string, ReviewMaterial[]>();
  for (const m of queue) {
    const key = `${m.subjectName} › ${m.topicName}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(m);
  }

  return (
    <div className="screen">
      <div className="screen-head">
        <button className="btn btn-ghost" onClick={onBack}>
          ← Wróć
        </button>
        <h1>Do zatwierdzenia</h1>
      </div>
      {queue.length === 0 ? (
        <p className="muted">Wszystko przejrzane.</p>
      ) : (
        <div className="row-wrap">
          <button
            className="btn btn-primary"
            onClick={() =>
              confirm(`Zatwierdzić wszystkie ${queue.length} materiały? Każdy ma źródło – możesz je potem poprawić na telefonie przez „Zgłoś błąd”.`) &&
              void act(() => approveMaterials(db, queue.map((m) => m.id)), `Zatwierdzono ${queue.length}.`)
            }
          >
            Zatwierdź wszystkie ({queue.length})
          </button>
        </div>
      )}

      {[...groups.entries()].map(([key, items]) => (
        <section key={key} className="group">
          <div className="list-row group-head">
            <h2 className="card-title">
              {key}
              {items[0]!.examWeight >= 0.9 && <span className="pill">na egzamin</span>}
            </h2>
            {items.length > 1 && (
              <button className="btn btn-ghost btn-small" onClick={() => void act(() => approveMaterials(db, items.map((m) => m.id)))}>
                Zatwierdź zagadnienie
              </button>
            )}
          </div>
          <Coverage topicId={items[0]!.topicId} subjectId={items[0]!.subjectId} onFill={() => void startProcessing(db, changed)} />
          {items.map((m) => (
            <article key={m.id} className="card review-card">
              {m.flagged && <p className="status status-warn">Zgłoszone z telefonu jako błędne lub nieaktualne.</p>}
              {m.status === "needs_review" && <p className="status status-warn">Do sprawdzenia: źródło się zmieniło albo wybrano inną wersję w sprzeczności.</p>}
              {editing === m.id ? (
                <EditForm material={m} onDone={() => setEditing(null)} />
              ) : (
                <>
                  <MaterialPreview type={m.type} payload={m.payload} />
                  {m.citations.map((c, i) => (
                    <Citation key={i} quote={c.quote} title={c.documentTitle} page={c.page} lectureDate={c.lectureDate} onOpen={() => setSource({ chunkId: c.chunkId, quote: c.quote })} />
                  ))}
                  {!m.citations.length && <p className="muted small">Bez źródła (fiszka dodana ręcznie albo źródło usunięte).</p>}
                  <div className="review-actions">
                    <button className="btn btn-primary btn-small" onClick={() => void act(() => approveMaterials(db, [m.id]))}>
                      Zatwierdź
                    </button>
                    <button className="btn btn-secondary btn-small" onClick={() => setEditing(m.id)}>
                      Edytuj
                    </button>
                    <button className="btn btn-secondary btn-small" onClick={() => void act(() => rejectMaterial(db, m.id, { tooEasy: true }))}>
                      Za łatwe
                    </button>
                    <button className="btn btn-ghost btn-small danger" onClick={() => void act(() => rejectMaterial(db, m.id))}>
                      Odrzuć
                    </button>
                  </div>
                </>
              )}
            </article>
          ))}
        </section>
      ))}
      {source && <SourceViewer source={source} onClose={() => setSource(null)} />}
    </div>
  );
}

function EditForm({ material, onDone }: { material: ReviewMaterial; onDone: () => void }) {
  const { db } = useDb();
  const act = useAction();
  const p = material.payload;
  const [a, setA] = useState<string>(material.type === "cloze" ? p.text : material.type === "list" ? p.prompt : p.q);
  const [b, setB] = useState<string>(material.type === "cloze" ? "" : material.type === "list" ? (p.items as string[]).join("\n") : p.a);
  const save = () =>
    act(() => {
      const payload = material.type === "cloze" ? { text: a } : material.type === "list" ? { prompt: a, items: b.split("\n").map((s) => s.trim()).filter(Boolean) } : { q: a, a: b };
      editMaterial(db, material.id, payload);
      onDone();
    }, "Zapisano i zatwierdzono.");
  return (
    <div className="edit">
      <label className="field">
        <span className="field-label">{material.type === "cloze" ? "Tekst z lukami {{c1::…}}" : material.type === "list" ? "Polecenie" : "Pytanie"}</span>
        <textarea rows={material.type === "cloze" ? 4 : 2} value={a} onChange={(e) => setA(e.target.value)} />
      </label>
      {material.type !== "cloze" && (
        <label className="field">
          <span className="field-label">{material.type === "list" ? "Pozycje (każda w linii)" : "Odpowiedź"}</span>
          <textarea rows={material.type === "list" ? 5 : 2} value={b} onChange={(e) => setB(e.target.value)} />
        </label>
      )}
      <div className="review-actions">
        <button className="btn btn-primary btn-small" onClick={() => void save()}>
          Zapisz i zatwierdź
        </button>
        <button className="btn btn-ghost btn-small" onClick={onDone}>
          Anuluj
        </button>
      </div>
    </div>
  );
}

/** Parts of the topic that the sources describe but no card covers yet. */
function Coverage({ topicId, subjectId, onFill }: { topicId: string; subjectId: string; onFill: () => void }) {
  const { db } = useDb();
  const act = useAction();
  const schema = topicSchema(db, topicId);
  if (!schema) return null;
  return (
    <div className="coverage small">
      <span className="muted">Schemat:</span>
      {schema.parts.map((p) => (
        <span key={p.slot} className={`pill ${p.materials ? "" : "pill-muted"}`} title={p.materials ? `${p.materials} fiszek` : "bez fiszki"}>
          {p.icon} {p.label}
          {p.materials ? "" : " – brak"}
        </span>
      ))}
      {schema.uncovered.length > 0 && (
        <button className="btn btn-ghost btn-small" onClick={() => void act(() => (enqueueGeneration(db, subjectId, [topicId]), onFill()), "Zlecono fiszki dla brakujących części.")}>
          Uzupełnij
        </button>
      )}
    </div>
  );
}
