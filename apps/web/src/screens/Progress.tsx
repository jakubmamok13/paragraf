import { useState } from "react";
import { CONFIDENCE_LABEL, daysBetween, hardestCards, localToday, planSession, type SessionPlan, studyStats, subjectProgress, todayFocus } from "@paragraf/core";
import { Card, plDays, useDb } from "../ui";
import { TopicSheet } from "../components";

const pct = (x: number) => `${Math.round(x * 100)}%`;

/** A thin meter: one hue for magnitude, value as text beside it (never color alone). */
function Meter({ value, label }: { value: number; label: string }) {
  return (
    <div className="meter" role="meter" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(value * 100)} aria-label={label} title={`${label}: ${pct(value)}`}>
      <span style={{ width: `${Math.max(0, Math.min(1, value)) * 100}%` }} />
    </div>
  );
}

export function Progress({ onStart }: { onStart: (plan: SessionPlan, mode: string) => void }) {
  const { db } = useDb();
  const [open, setOpen] = useState<string | null>(null);
  const [sheet, setSheet] = useState<string | null>(null);
  const progress = subjectProgress(db);
  const stats = studyStats(db);
  const focus = todayFocus(progress);
  const hard = hardestCards(db);
  const today = localToday();
  const maxDay = Math.max(1, ...stats.last14.map((d) => d.answers));

  return (
    <div className="screen">
      <div className="screen-head">
        <h1>Postęp</h1>
      </div>

      <div className="tiles">
        <div className="tile">
          <strong>{stats.streak}</strong>
          <span>{stats.streak === 1 ? "dzień nauki z rzędu" : "dni nauki z rzędu"}</span>
        </div>
        <div className="tile">
          <strong>{stats.answersToday}</strong>
          <span>odpowiedzi dziś</span>
        </div>
      </div>

      <Card title="Ostatnie 14 dni">
        <div className="days" role="img" aria-label={`Odpowiedzi dziennie: ${stats.last14.map((d) => `${d.day}: ${d.answers}`).join(", ")}`}>
          {stats.last14.map((d) => (
            <div key={d.day} className="day" title={`${d.day}: ${d.answers} odpowiedzi`}>
              <span style={{ height: `${(d.answers / maxDay) * 100}%` }} className={d.answers ? "" : "zero"} />
            </div>
          ))}
        </div>
        <p className="muted small">Najwięcej: {maxDay} odpowiedzi dziennie.</p>
      </Card>

      {focus.length > 0 && (
        <Card title="Czego uczyć się dziś">
          <ul className="list">
            {focus.map((f) => (
              <li key={f.topic.id} className="list-row">
                <span className="small">
                  <strong>{f.topic.name}</strong> <span className="muted">· {f.subjectName}</span>
                </span>
                <span className="muted small">{f.reason}</span>
              </li>
            ))}
          </ul>
        </Card>
      )}

      {progress.length === 0 && <p className="muted">Dodaj przedmiot i materiały, a tu zobaczysz, co już umiesz.</p>}
      {progress.map((s) => (
        <section key={s.id} className="card">
          <div className="list-row">
            <h2 className="card-title">{s.name}</h2>
            <span className="small">{pct(s.mastery)}</span>
          </div>
          <Meter value={s.mastery} label={`Opanowanie: ${s.name}`} />
          <p className="muted small">
            Opanowane materiały: {s.learned} z {s.items}
            {s.examDate && (
              <>
                {" "}
                · egzamin {plDays(daysBetween(today, s.examDate))}
                {s.readiness !== null && <>, gotowość dziś: ok. {pct(s.readiness)} materiału zapamiętanego na ten dzień</>}
              </>
            )}
          </p>
          <div className="row-wrap">
            <button className="btn btn-secondary btn-small" onClick={() => setOpen(open === s.id ? null : s.id)}>
              {open === s.id ? "Ukryj działy" : "Działy i zagadnienia"}
            </button>
            <button
              className="btn btn-secondary btn-small"
              disabled={!s.items}
              onClick={() => onStart(planSession(db, new Date(), { subjectId: s.id, ignoreStudiedToday: true }), "subject")}
            >
              Ucz się tego przedmiotu
            </button>
          </div>
          {open === s.id &&
            s.sections.map((sec) => (
              <div key={sec.id ?? "none"} className="section">
                <div className="list-row">
                  <strong className="small">{sec.title}</strong>
                  <span className="small">{pct(sec.mastery)}</span>
                </div>
                <ul className="topics">
                  {sec.topics.map((t) => (
                    <li key={t.id}>
                      <div className="list-row">
                        <button className="link small topic-link" onClick={() => setSheet(t.id)}>
                          {t.name}
                          {t.examWeight >= 0.9 && <span className="pill">egzamin</span>}
                        </button>
                        <span className="muted small">{t.empty ? "brak materiałów" : `${pct(t.mastery)} · ${t.learned}/${t.items}`}</span>
                      </div>
                      {!t.empty && <Meter value={t.mastery} label={t.name} />}
                    </li>
                  ))}
                </ul>
              </div>
            ))}
        </section>
      ))}

      {stats.calibration30.length > 0 && (
        <Card title="Pewność a wynik (30 dni)">
          {stats.calibration30.map((r) => (
            <div key={r.confidence} className="calib">
              <span className="calib-label">{CONFIDENCE_LABEL[r.confidence]}</span>
              <Meter value={r.correct / r.answers} label={CONFIDENCE_LABEL[r.confidence]} />
              <span className="small">
                {r.correct}/{r.answers} dobrze
              </span>
            </div>
          ))}
          <p className="muted small">Gdy deklarujesz „Pewnie”, wynik powinien być bliski 100%. Jeśli jest niższy, to sygnał złudzenia kompetencji.</p>
        </Card>
      )}

      {hard.length > 0 && (
        <Card title="Najtrudniejsze fiszki">
          <ul className="list">
            {hard.map((h) => (
              <li key={h.materialId} className="small">
                {h.text} <span className="muted">· {h.topicName} · „Nie wiedziałem” w {pct(h.againShare)} odpowiedzi</span>
              </li>
            ))}
          </ul>
        </Card>
      )}
      {sheet && <TopicSheet topicId={sheet} onClose={() => setSheet(null)} />}
    </div>
  );
}
