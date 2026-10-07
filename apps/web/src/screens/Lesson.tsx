import { type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { buildLesson, getSettings, lessonScript, parseCloze, planSession, type PlannedCard, type SessionPlan, updateSettings } from "@paragraf/core";
import { TopicMap } from "../components";
import { useDb } from "../ui";

// The short lesson that introduces a new topic, built on the research:
// - pre-questions first (pretesting directs attention and helps retention,
//   also of what was not asked);
// - the content in short, learner-paced parts (segmenting) with key numbers
//   and provisions highlighted (signalling);
// - reading by default: overall reading and listening give similar
//   comprehension, and self-paced reading is better for inference; reading
//   aloud is an option (e.g. on the way to the university);
// - then the first recall of the topic's cards right away.
// The text is only what the sources say (verified fields), no new wording.

type Step = { kind: "pre"; i: number; revealed: boolean } | { kind: "part"; i: number } | { kind: "end" };

/** Numbers and provisions stand out (signalling). */
function Signal({ text }: { text: string }) {
  const parts: ReactNode[] = [];
  const re = /(art\.\s*\d+[a-z]*(?:\s*§\s*\d+[a-z]?)?(?:\s*(?:pkt|ust\.)\s*\d+)?(?:\s*k\.[a-z.]+)?|\b\d+(?:[.,]\d+)?\s*(?:lat|lata|rok|dni|miesięcy|miesiące|tygodni)?\b)/gi;
  let last = 0;
  for (const m of text.matchAll(re)) {
    if (m.index! > last) parts.push(text.slice(last, m.index));
    parts.push(<mark key={m.index}>{m[0]}</mark>);
    last = m.index! + m[0].length;
  }
  parts.push(text.slice(last));
  return <>{parts}</>;
}

function Question({ card, revealed }: { card: PlannedCard; revealed: boolean }) {
  if (card.type === "cloze") {
    return (
      <p className="card-text">
        {parseCloze(card.payload.text, card.subKey).map((s, i) =>
          s.kind === "text" ? <span key={i}>{s.text}</span> : s.active ? (revealed ? <mark key={i} className="gap-answer">{s.answer}</mark> : <span key={i} className="gap">[…]</span>) : <span key={i}>{s.answer}</span>,
        )}
      </p>
    );
  }
  if (card.type === "list") {
    return (
      <>
        <p className="card-text">{card.payload.prompt}</p>
        {revealed && (
          <ol className="list-reveal">
            {(card.payload.items as string[]).map((x, i) => (
              <li key={i}>{x}</li>
            ))}
          </ol>
        )}
      </>
    );
  }
  return (
    <>
      <p className="card-text">{card.payload.q}</p>
      {revealed && <p className="card-answer">{card.payload.a}</p>}
    </>
  );
}

function polishVoice(): SpeechSynthesisVoice | null {
  const voices = typeof speechSynthesis !== "undefined" ? speechSynthesis.getVoices() : [];
  return voices.find((v) => v.lang?.toLowerCase().startsWith("pl")) ?? null;
}

export function Lesson({ topicId, onClose, onStart }: { topicId: string; onClose: () => void; onStart: (plan: SessionPlan, mode: string) => void }) {
  const { db } = useDb();
  const lesson = useMemo(() => buildLesson(db, topicId), [db, topicId]);
  const settings = getSettings(db);
  const [step, setStep] = useState<Step>(() => (lesson && lesson.prequestions.length ? { kind: "pre", i: 0, revealed: false } : { kind: "part", i: 0 }));
  const [audio, setAudio] = useState(settings.lessonAudio);
  const [voiceMissing, setVoiceMissing] = useState(false);
  const started = useRef(Date.now());
  const script = useMemo(() => (lesson ? lessonScript(lesson.schema) : []), [lesson]);
  const parts = lesson?.schema.parts.filter((p) => p.points.length) ?? [];

  // Read the current part aloud when audio is on.
  useEffect(() => {
    if (typeof speechSynthesis === "undefined") return;
    speechSynthesis.cancel();
    if (!audio || step.kind !== "part") return;
    const speak = () => {
      const voice = polishVoice();
      if (!voice) {
        setVoiceMissing(true);
        return;
      }
      const u = new SpeechSynthesisUtterance(script[step.i]?.text ?? "");
      u.voice = voice;
      u.lang = voice.lang;
      u.rate = settings.lessonRate;
      speechSynthesis.speak(u);
    };
    // Voices load asynchronously on some browsers.
    if (speechSynthesis.getVoices().length) speak();
    else speechSynthesis.addEventListener("voiceschanged", speak, { once: true });
    return () => speechSynthesis.cancel();
  }, [audio, step, script, settings.lessonRate]);

  if (!lesson) return null;
  const toggleAudio = () => {
    setAudio((a) => !a);
    updateSettings(db, { lessonAudio: !audio });
  };
  const finish = () => {
    if (typeof speechSynthesis !== "undefined") speechSynthesis.cancel();
    onStart(planSession(db, new Date(), { topicId, newLimit: 100, budgetSeconds: 3600, ignoreStudiedToday: true, slotOrder: true }), "lesson");
  };
  const minutes = Math.max(1, Math.round((Date.now() - started.current) / 60_000));

  return (
    <div className="session">
      <header className="session-head">
        <button className="btn btn-ghost" onClick={onClose} aria-label="Zakończ lekcję">
          ✕
        </button>
        <div className="session-progress">
          <span className="small">
            <strong>{lesson.schema.name}</strong>
          </span>
          <span className="muted small">krótka lekcja · {lesson.schema.subjectName}</span>
        </div>
        <button className={`btn btn-ghost ${audio ? "on" : ""}`} onClick={toggleAudio} aria-pressed={audio} aria-label="Czytaj na głos">
          {audio ? "🔊" : "🔈"}
        </button>
      </header>

      <div className="session-body">
        {step.kind === "pre" && (
          <>
            <p className="session-meta">
              Pytanie wstępne {step.i + 1} z {lesson.prequestions.length} · nie wpływa na powtórki
            </p>
            <p className="muted small">Spróbuj odpowiedzieć, zanim poznasz temat. Nawet błędna próba pomaga potem zapamiętać.</p>
            <Question card={lesson.prequestions[step.i]!} revealed={step.revealed} />
          </>
        )}

        {step.kind === "part" && parts[step.i] && (
          <>
            <TopicMap schema={lesson.schema} current={parts[step.i]!.slot} />
            <h2 className="lesson-part">
              {parts[step.i]!.icon} {parts[step.i]!.label}
            </h2>
            <ul className="lesson-points">
              {parts[step.i]!.points.map((p) => (
                <li key={p.fieldId}>
                  <p>
                    <Signal text={p.text} />
                  </p>
                  {p.source && <p className="muted small">Źródło: {p.source}</p>}
                </li>
              ))}
            </ul>
            {audio && voiceMissing && <p className="status status-warn">To urządzenie nie ma polskiego głosu do czytania. Dodaj go w ustawieniach systemu (mowa / czytanie na głos).</p>}
          </>
        )}

        {step.kind === "end" && (
          <>
            <h1>Teraz sprawdź się</h1>
            <p>
              {lesson.cards.length} {lesson.cards.length === 1 ? "fiszka" : "fiszek"} z tego zagadnienia, w kolejności schematu. Pierwsza próba przypomnienia zaraz
              po lekcji utrwala ją najmocniej; od jutra wrócą w zwykłych powtórkach, wymieszane z innymi zagadnieniami.
            </p>
            <p className="muted small">Lekcja trwała ok. {minutes} min.</p>
          </>
        )}
      </div>

      <footer className="session-actions">
        {step.kind === "pre" && !step.revealed && (
          <button className="btn btn-primary btn-big" onClick={() => setStep({ ...step, revealed: true })}>
            Pokaż odpowiedź
          </button>
        )}
        {step.kind === "pre" && step.revealed && (
          <button
            className="btn btn-primary btn-big"
            onClick={() => setStep(step.i + 1 < lesson.prequestions.length ? { kind: "pre", i: step.i + 1, revealed: false } : { kind: "part", i: 0 })}
          >
            Dalej
          </button>
        )}
        {step.kind === "part" && (
          <div className="btn-row">
            <button className="btn btn-secondary btn-big" disabled={step.i === 0} onClick={() => setStep({ kind: "part", i: step.i - 1 })}>
              Wstecz
            </button>
            <button className="btn btn-primary btn-big" onClick={() => setStep(step.i + 1 < parts.length ? { kind: "part", i: step.i + 1 } : { kind: "end" })}>
              Dalej ({step.i + 1}/{parts.length})
            </button>
          </div>
        )}
        {step.kind === "end" && (
          <button className="btn btn-primary btn-big" onClick={finish} disabled={!lesson.cards.length}>
            Sprawdź się
          </button>
        )}
      </footer>
    </div>
  );
}
