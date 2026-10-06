import { useState } from "react";
import {
  createSubject,
  daysBetween,
  deleteSubject,
  EXAM_FORMATS,
  EXAM_KINDS,
  type ExamFormat,
  type ExamInput,
  type ExamKind,
  listSubjects,
  localToday,
  setSubjectStatus,
  type Subject,
  subjectStats,
  updateSubject,
} from "@paragraf/core";
import { Card, Field, formatDate, plDays, useAction, useDb } from "../ui";
import { AddCard } from "./AddCard";

const STATUS_LABEL = { active: "nauka", maintenance: "podtrzymanie", archived: "archiwum" } as const;

export function Subjects() {
  const { db } = useDb();
  const [editing, setEditing] = useState<Subject | "new" | null>(null);
  const [showArchived, setShowArchived] = useState(false);
  const subjects = listSubjects(db, { includeArchived: showArchived });
  const today = localToday();

  if (editing) return <SubjectForm subject={editing === "new" ? null : editing} onDone={() => setEditing(null)} />;

  return (
    <div className="screen">
      <div className="screen-head">
        <h1>Przedmioty</h1>
        <button className="btn btn-primary" onClick={() => setEditing("new")}>
          + Dodaj
        </button>
      </div>

      {subjects.length === 0 && (
        <Card>
          <p className="muted">Nie masz jeszcze przedmiotów. Dodaj pierwszy, z datą i formą egzaminu.</p>
        </Card>
      )}

      {subjects.map((s) => {
        const stats = subjectStats(db, s.id);
        return (
          <button key={s.id} className="card card-button" onClick={() => setEditing(s)}>
            <div className="list-row">
              <strong>{s.name}</strong>
              {s.status !== "active" && <span className="pill pill-muted">{STATUS_LABEL[s.status]}</span>}
            </div>
            <p className="muted small">
              {s.nextExam
                ? `${EXAM_KINDS[s.nextExam.kind]} (${EXAM_FORMATS[s.nextExam.format]}) ${formatDate(s.nextExam.date!)}, ${plDays(daysBetween(today, s.nextExam.date!))}`
                : s.exams.length
                  ? "Brak nadchodzącego terminu"
                  : "Bez egzaminu"}
            </p>
            <p className="muted small">
              Źródła: {stats.documents} · zagadnienia: {stats.topics} · materiały: {stats.materials}
            </p>
          </button>
        );
      })}

      <button className="link center" onClick={() => setShowArchived((v) => !v)}>
        {showArchived ? "Ukryj archiwum" : "Pokaż archiwum"}
      </button>
    </div>
  );
}

function SubjectForm({ subject, onDone }: { subject: Subject | null; onDone: () => void }) {
  const { db } = useDb();
  const act = useAction();
  const [name, setName] = useState(subject?.name ?? "");
  const [exams, setExams] = useState<ExamInput[]>(
    subject?.exams.map((e) => ({ id: e.id, kind: e.kind, format: e.format, date: e.date, note: e.note })) ?? [
      { kind: "egzamin", format: "ustny", date: null },
    ],
  );
  const [retention, setRetention] = useState(subject?.targetRetention != null ? String(subject.targetRetention) : "");
  const [adding, setAdding] = useState(false);

  const setExam = (i: number, patch: Partial<ExamInput>) => setExams((xs) => xs.map((x, j) => (j === i ? { ...x, ...patch } : x)));

  const save = () =>
    act(() => {
      const input = {
        name,
        exams,
        targetRetention: retention ? Number(retention.replace(",", ".")) : null,
      };
      if (subject) updateSubject(db, subject.id, input);
      else createSubject(db, input);
      onDone();
    }, subject ? "Zapisano zmiany." : "Dodano przedmiot.");

  const remove = () => {
    if (!subject) return;
    const st = subjectStats(db, subject.id);
    const ok = confirm(
      `Usunąć „${subject.name}” razem ze źródłami (${st.documents}), zagadnieniami (${st.topics}), materiałami (${st.materials}) i historią nauki?\n\nTego nie da się cofnąć. Jeśli chcesz tylko ukryć przedmiot, wybierz „Archiwizuj”.`,
    );
    if (ok) void act(() => (deleteSubject(db, subject.id), onDone()), "Usunięto przedmiot.");
  };

  if (adding && subject) return <AddCard subjectId={subject.id} subjectName={subject.name} onDone={() => setAdding(false)} />;

  return (
    <div className="screen">
      <div className="screen-head">
        <button className="btn btn-ghost" onClick={onDone}>
          ← Wróć
        </button>
        <h1>{subject ? "Edytuj przedmiot" : "Nowy przedmiot"}</h1>
      </div>

      {subject && (
        <Card title="Fiszki">
          <p className="muted small">
            Aktywne: {subjectStats(db, subject.id).materials}. Materiały z notatek i podręcznika przygotuje Pracownia; własne fiszki możesz dodać od razu.
          </p>
          <button className="btn btn-secondary" onClick={() => setAdding(true)}>
            + Dodaj własną fiszkę
          </button>
        </Card>
      )}

      <Card>
        <Field label="Nazwa">
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="np. Prawo cywilne – część ogólna" autoFocus={!subject} />
        </Field>
      </Card>

      {exams.map((e, i) => (
        <Card
          key={e.id ?? `new-${i}`}
          title={`Zaliczenie ${exams.length > 1 ? i + 1 : ""}`}
          actions={
            <button className="btn btn-ghost btn-small" onClick={() => setExams((xs) => xs.filter((_, j) => j !== i))}>
              Usuń
            </button>
          }
        >
          <div className="grid2">
            <Field label="Rodzaj">
              <select value={e.kind} onChange={(ev) => setExam(i, { kind: ev.target.value as ExamKind })}>
                {Object.entries(EXAM_KINDS).map(([k, v]) => (
                  <option key={k} value={k}>
                    {v}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Forma">
              <select value={e.format} onChange={(ev) => setExam(i, { format: ev.target.value as ExamFormat })}>
                {Object.entries(EXAM_FORMATS).map(([k, v]) => (
                  <option key={k} value={k}>
                    {v}
                  </option>
                ))}
              </select>
            </Field>
          </div>
          <Field label="Data" hint="Zostaw puste, jeśli termin nie jest jeszcze znany.">
            <input type="date" value={e.date ?? ""} onChange={(ev) => setExam(i, { date: ev.target.value || null })} />
          </Field>
          <Field label="Uwagi (opcjonalnie)">
            <input value={e.note ?? ""} onChange={(ev) => setExam(i, { note: ev.target.value })} placeholder="np. sala 101, prof. X" />
          </Field>
        </Card>
      ))}

      <button className="btn btn-secondary" onClick={() => setExams((xs) => [...xs, { kind: "kolokwium", format: "test", date: null }])}>
        + Dodaj zaliczenie
      </button>

      <Card title="Zaawansowane">
        <Field label="Docelowa retencja" hint="Puste = ustawienie globalne. Wyżej = więcej powtórek, lepsza pamięć.">
          <input inputMode="decimal" value={retention} onChange={(e) => setRetention(e.target.value)} placeholder="np. 0,9" />
        </Field>
      </Card>

      <button className="btn btn-primary btn-xl" onClick={() => void save()}>
        Zapisz
      </button>

      {subject && (
        <Card title="Stan przedmiotu">
          <p className="muted small">
            Po egzaminie przełącz na <strong>podtrzymanie</strong>: rzadkie powtórki, żeby wiedza została na kolejne lata.
          </p>
          <div className="row-wrap">
            {(["active", "maintenance", "archived"] as const).map((st) => (
              <button
                key={st}
                className={`btn btn-small ${subject.status === st ? "btn-primary" : "btn-secondary"}`}
                onClick={() => void act(() => (setSubjectStatus(db, subject.id, st), onDone()), "Zmieniono stan.")}
              >
                {st === "archived" ? "Archiwizuj" : STATUS_LABEL[st][0]!.toUpperCase() + STATUS_LABEL[st].slice(1)}
              </button>
            ))}
          </div>
          <button className="btn btn-danger btn-small" onClick={remove}>
            Usuń przedmiot
          </button>
        </Card>
      )}
    </div>
  );
}
