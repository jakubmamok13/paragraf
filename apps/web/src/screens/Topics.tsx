import { useState } from "react";
import { subjectTopics } from "@paragraf/core";
import { TopicSheet } from "../components";
import { useDb } from "../ui";

/** Every topic of a subject by section: what the sources say about it and how many cards it has. */
export function SubjectTopics({ subjectId, subjectName, onBack }: { subjectId: string; subjectName: string; onBack: () => void }) {
  const { db } = useDb();
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState<string | null>(null);
  const q = query.trim().toLocaleLowerCase("pl");
  const sections = subjectTopics(db, subjectId)
    .map((s) => ({ ...s, topics: q ? s.topics.filter((t) => t.name.toLocaleLowerCase("pl").includes(q)) : s.topics }))
    .filter((s) => s.topics.length);
  const all = subjectTopics(db, subjectId).flatMap((s) => s.topics);
  const withContent = all.filter((t) => t.fields > 0).length;

  return (
    <div className="screen">
      <div className="screen-head">
        <button className="btn btn-ghost" onClick={onBack}>
          ← Wróć
        </button>
        <h1>Zagadnienia</h1>
      </div>
      <p className="muted small">
        {subjectName}: {all.length} zagadnień, z treścią ze źródeł: {withContent}. Dotknij zagadnienia, żeby zobaczyć jego schemat: co mówią źródła i skąd to
        wiadomo.
      </p>
      {all.length > 8 && <input type="search" placeholder="Szukaj zagadnienia" value={query} onChange={(e) => setQuery(e.target.value)} aria-label="Szukaj zagadnienia" />}
      {all.length === 0 && <p className="muted">Pracownia jeszcze nie wyodrębniła zagadnień z żadnego źródła.</p>}
      {sections.map((s) => (
        <section key={s.id ?? "none"} className="card">
          <h2 className="card-title">{s.title}</h2>
          <ul className="list topic-list">
            {s.topics.map((t) => (
              <li key={t.id}>
                <button className="topic-row" onClick={() => setOpen(t.id)}>
                  <span className="topic-row-name">
                    {t.name}
                    {t.examWeight >= 0.9 && <span className="pill">na egzamin</span>}
                  </span>
                  <span className="small muted">
                    {t.fields === 0 ? (
                      "tylko wspomniane w źródle"
                    ) : (
                      <>
                        <span aria-label={t.slots.map((x) => x.label).join(", ")}>{t.slots.map((x) => x.icon).join(" ")}</span>
                        {" · "}
                        {t.materials ? `fiszki: ${t.materials}` : "bez fiszek"}
                        {t.pending ? ` · do zatwierdzenia: ${t.pending}` : ""}
                      </>
                    )}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </section>
      ))}
      {open && <TopicSheet topicId={open} onClose={() => setOpen(null)} />}
    </div>
  );
}
