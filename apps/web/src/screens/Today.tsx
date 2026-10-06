import { daysBetween, EXAM_FORMATS, EXAM_KINDS, getSettings, listSubjects, localToday } from "@paragraf/core";
import { Card, plDays, useDb } from "../ui";

export function Today({ goTo }: { goTo: (tab: "subjects" | "workshop") => void }) {
  const { db } = useDb();
  const settings = getSettings(db);
  const subjects = listSubjects(db);
  const today = localToday();
  const nowIso = new Date().toISOString();
  const active = db.get<{ n: number }>("SELECT COUNT(*) AS n FROM material WHERE status = 'active'")!.n;
  const due = db.get<{ n: number }>(
    "SELECT COUNT(*) AS n FROM review_item WHERE suspended = 0 AND due <= ? AND (buried_until IS NULL OR buried_until <= ?)",
    nowIso,
    nowIso,
  )!.n;
  const upcoming = subjects.filter((s) => s.nextExam).slice(0, 3);

  return (
    <div className="screen">
      <section className="hero">
        <p className="hero-label">Dzisiejsza sesja</p>
        <p className="hero-minutes">
          {settings.dailyMinutes} <span>min</span>
        </p>
        <button className="btn btn-primary btn-xl" disabled={active === 0}>
          Zacznij
        </button>
        <p className="hero-note">
          {active === 0
            ? "Nie masz jeszcze materiałów do nauki."
            : due > 0
              ? `Do powtórki: ${due}`
              : "Powtórki na dziś zrobione. Mogą dojść nowe materiały."}
        </p>
      </section>

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
              wczytaj notatki i podręcznik. Lokalne AI przygotuje materiały do zatwierdzenia.
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
