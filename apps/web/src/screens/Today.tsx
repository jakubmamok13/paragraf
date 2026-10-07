import { daysBetween, EXAM_FORMATS, EXAM_KINDS, lessonCandidates, listSubjects, localToday, planSession, recentLectures, type SessionPlan } from "@paragraf/core";
import { Card, plDays, useDb } from "../ui";
import { SyncBanner } from "./DriveSync";

export function Today({
  goTo,
  onStart,
  onLesson,
}: {
  goTo: (tab: "subjects" | "workshop") => void;
  onStart: (plan: SessionPlan, mode?: string) => void;
  onLesson: (topicId: string) => void;
}) {
  const { db } = useDb();
  const plan = planSession(db);
  const subjects = listSubjects(db);
  const today = localToday();
  const active = db.get<{ n: number }>("SELECT COUNT(*) AS n FROM material WHERE status = 'active'")!.n;
  const upcoming = subjects.filter((s) => s.nextExam).slice(0, 3);
  const minutes = Math.max(1, Math.ceil(plan.estSeconds / 60));
  const hasCards = plan.cards.length > 0;
  const lectures = recentLectures(db);
  const lessons = lessonCandidates(db);

  let note: string;
  if (active === 0) note = "Nie masz jeszcze materiałów do nauki.";
  else if (hasCards) {
    const parts = [plan.dueIncluded && `powtórki: ${plan.dueIncluded}`, plan.newIncluded && `nowe: ${plan.newIncluded}`].filter(Boolean);
    note = parts.join(" · ");
  } else if (plan.budgetSeconds < 30) note = "Dzisiejszy limit czasu wykorzystany. Do jutra!";
  else note = "Na dziś wszystko zrobione.";

  return (
    <div className="screen">
      <section className="hero">
        <p className="hero-label">Dzisiejsza sesja</p>
        <p className="hero-minutes">
          {hasCards ? minutes : 0} <span>min</span>
        </p>
        <button className="btn btn-primary btn-xl" disabled={!hasCards} onClick={() => onStart(plan)}>
          Zacznij
        </button>
        <p className="hero-note">{note}</p>
      </section>

      <SyncBanner />

      {lectures.map((l) => (
        <Card key={l.documentId} title="Po wykładzie">
          <p className="small">
            <strong>{l.title}</strong> <span className="muted">· {l.subjectName}</span>
          </p>
          <p className="muted small">
            Nowe materiały: {l.fresh}. Pierwsze przywołanie tego samego dnia najmocniej utrwala wykład.
          </p>
          <button
            className="btn btn-primary"
            onClick={() => onStart(planSession(db, new Date(), { documentId: l.documentId, budgetSeconds: 10 * 60, newLimit: 50, ignoreStudiedToday: true }), "after_lecture")}
          >
            Krótki test (do 10 min)
          </button>
        </Card>
      ))}

      {lessons.length > 0 && (
        <Card title="Nowe zagadnienia">
          <p className="muted small">Krótka lekcja (2–4 min) przed pierwszymi fiszkami: pytania wstępne, schemat zagadnienia, od razu sprawdzenie.</p>
          <ul className="list">
            {lessons.map((l) => (
              <li key={l.topicId} className="list-row">
                <span className="small">
                  <strong>{l.name}</strong> <span className="muted">· {l.subjectName} · {l.cards} fiszek</span>
                </span>
                <button className="btn btn-secondary btn-small" onClick={() => onLesson(l.topicId)}>
                  Lekcja
                </button>
              </li>
            ))}
          </ul>
        </Card>
      )}

      {plan.deferred > 0 && (
        <Card title="Zaległości">
          <p className="small">
            {plan.deferred} powtórek nie mieści się dziś w limicie. Rozłożę je na ok. {plan.backlogDays}{" "}
            {plan.backlogDays === 1 ? "dzień" : "dni"}, zaczynając od najważniejszych przed egzaminem. Nowe materiały wrócą, gdy zaległości znikną.
          </p>
        </Card>
      )}

      {active === 0 && (
        <Card title="Jak zacząć">
          <ol className="steps">
            <li>
              <button className="link" onClick={() => goTo("subjects")}>
                Dodaj przedmiot
              </button>{" "}
              z datą i formą egzaminu.
            </li>
            <li>
              Na komputerze w{" "}
              <button className="link" onClick={() => goTo("workshop")}>
                Pracowni
              </button>{" "}
              wczytaj notatki i podręcznik. Lokalne AI przygotuje materiały do zatwierdzenia. Możesz też od razu dodać własne fiszki w przedmiocie.
            </li>
            <li>Wyślij paczkę na telefon i ucz się codziennie.</li>
          </ol>
        </Card>
      )}

      {upcoming.length > 0 && (
        <Card title="Najbliższe egzaminy">
          <ul className="list">
            {upcoming.map((s) => {
              const e = s.nextExam!;
              return (
                <li key={s.id} className="list-row">
                  <span>
                    <strong>{s.name}</strong>
                    <span className="muted">
                      {" "}
                      · {EXAM_KINDS[e.kind]} ({EXAM_FORMATS[e.format]})
                    </span>
                  </span>
                  <span className="pill">{plDays(daysBetween(today, e.date!))}</span>
                </li>
              );
            })}
          </ul>
        </Card>
      )}
    </div>
  );
}
