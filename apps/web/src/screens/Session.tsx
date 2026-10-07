import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  calibration,
  type CalibrationRow,
  type Confidence,
  CONFIDENCE_LABEL,
  flagMaterial,
  type Grade,
  listRating,
  MATERIAL_LABEL,
  materialSources,
  parseCloze,
  type PlannedCard,
  previewIntervals,
  Rating,
  recordAnswer,
  type SessionPlan,
  undoAnswer,
  placementsFor,
  topicSchema,
} from "@paragraf/core";
import { useAction, useDb, useToast } from "../ui";
import { type SourceRef, SourceViewer, TopicMap, TopicSheet } from "../components";

type Phase = "question" | "list" | "answer";

const RATINGS: { grade: Grade; label: string; cls: string }[] = [
  { grade: Rating.Again, label: "Nie wiedziałem", cls: "r-again" },
  { grade: Rating.Hard, label: "Trudno", cls: "r-hard" },
  { grade: Rating.Good, label: "Dobrze", cls: "r-good" },
  { grade: Rating.Easy, label: "Łatwo", cls: "r-easy" },
];

interface Last {
  logId: string;
  card: PlannedCard;
  index: number;
  requeuedAt: number | null;
}

export function Session({ plan, mode = "daily", onClose }: { plan: SessionPlan; mode?: string; onClose: () => void }) {
  const { db } = useDb();
  const act = useAction();
  const toast = useToast();
  const [viewer, setViewer] = useState<SourceRef | null>(null);
  const [sheet, setSheet] = useState(false);
  const [queue, setQueue] = useState<PlannedCard[]>(plan.cards);
  const [index, setIndex] = useState(0);
  const [phase, setPhase] = useState<Phase>("question");
  const [confidence, setConfidence] = useState<Confidence | null>(null);
  const [recalled, setRecalled] = useState<boolean[]>([]);
  const [showSource, setShowSource] = useState(false);
  const [logIds, setLogIds] = useState<string[]>([]);
  const [last, setLast] = useState<Last | null>(null);
  const [finished, setFinished] = useState<null | "done" | "time">(null);
  const requeues = useRef(new Map<string, number>());
  const sessionStart = useRef(Date.now());
  const cardStart = useRef(Date.now());

  const card = queue[index];

  useEffect(() => {
    cardStart.current = Date.now();
    setPhase("question");
    setConfidence(null);
    setRecalled([]);
    setShowSource(false);
  }, [index, queue]);

  const reveal = useCallback(
    (c: Confidence) => {
      setConfidence(c);
      setPhase(card?.type === "list" ? "list" : "answer");
    },
    [card],
  );

  const intervals = useMemo(() => (card && phase === "answer" ? previewIntervals(db, card.itemId) : null), [db, card, phase]);
  const suggested: Grade | null = card?.type === "list" && phase === "answer" ? listRating(recalled) : null;

  const rate = useCallback(
    (grade: Grade) => {
      if (!card) return;
      void act(() => {
        const res = recordAnswer(db, {
          itemId: card.itemId,
          rating: grade,
          confidence,
          durationMs: Date.now() - cardStart.current,
          mode,
          ...(card.type === "list" ? { answer: { recalled } } : {}),
        });
        setLogIds((ids) => [...ids, res.logId]);
        let next = queue;
        let requeuedAt: number | null = null;
        const times = requeues.current.get(card.itemId) ?? 0;
        // A card that keeps failing stops coming back after 3 times; it waits for the next session.
        if (res.requeue && times < 3) {
          requeues.current.set(card.itemId, times + 1);
          // Show it again a few cards later, while it is still fresh enough to be a real test.
          requeuedAt = Math.min(index + 4, queue.length);
          next = [...queue.slice(0, requeuedAt), card, ...queue.slice(requeuedAt)];
          setQueue(next);
        }
        setLast({ logId: res.logId, card, index, requeuedAt });
        const timeUp = (Date.now() - sessionStart.current) / 1000 >= plan.budgetSeconds;
        if (index + 1 >= next.length) setFinished("done");
        else if (timeUp) setFinished("time");
        else setIndex(index + 1);
      });
    },
    [act, card, confidence, db, index, plan.budgetSeconds, queue, recalled],
  );

  /** Wrong or outdated card: it stops coming up and waits on the laptop for a fix. */
  const flag = () => {
    if (!card) return;
    void act(() => {
      flagMaterial(db, card.materialId);
      const next = queue.filter((c, i) => i <= index || c.materialId !== card.materialId);
      next.splice(index, 1);
      setQueue(next);
      if (index >= next.length) setFinished("done");
      toast("Zgłoszono. Popraw albo odrzuć ją w Pracowni po przesłaniu postępu.");
    });
  };

  const undo = () => {
    if (!last) return;
    void act(() => {
      undoAnswer(db, last.logId);
      if (last.requeuedAt !== null) requeues.current.set(last.card.itemId, (requeues.current.get(last.card.itemId) ?? 1) - 1);
      setLogIds((ids) => ids.filter((id) => id !== last.logId));
      if (last.requeuedAt !== null) setQueue((q) => [...q.slice(0, last.requeuedAt!), ...q.slice(last.requeuedAt! + 1)]);
      setFinished(null);
      setIndex(last.index);
      setLast(null);
    });
  };

  // Laptop keyboard: 1–3 confidence, 1–4 rating, Y/N for list items.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (finished || !card) return;
      const n = Number(e.key);
      if (phase === "question" && n >= 1 && n <= 3) reveal(n as Confidence);
      else if (phase === "answer" && n >= 1 && n <= 4) rate(n as Grade);
      else if (phase === "list" && (e.key === "y" || e.key === "t")) setRecalled((r) => [...r, true]);
      else if (phase === "list" && e.key === "n") setRecalled((r) => [...r, false]);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [card, finished, phase, rate, reveal]);

  useEffect(() => {
    if (phase === "list" && card?.type === "list" && recalled.length >= card.payload.items.length) setPhase("answer");
  }, [card, phase, recalled]);

  if (finished || !card) {
    return <Summary logIds={logIds} reason={finished ?? "done"} seconds={(Date.now() - sessionStart.current) / 1000} onClose={onClose} onUndo={last ? undo : null} />;
  }

  const elapsedMin = Math.floor((Date.now() - sessionStart.current) / 60_000);
  const sources = showSource ? materialSources(db, card.materialId) : [];
  // Recomputed per card; cheap (one topic).
  const schema = topicSchema(db, card.topicId);
  // Your palace images for a list: shown only after you tried to recall it yourself.
  const palace = card.type === "list" ? placementsFor(db, card.materialId) : null;

  return (
    <div className="session">
      <header className="session-head">
        <button className="btn btn-ghost" onClick={onClose} aria-label="Zakończ sesję">
          ✕
        </button>
        <div className="session-progress">
          <div className="bar">
            <span style={{ width: `${(index / queue.length) * 100}%` }} />
          </div>
          <span className="muted small">
            {index + 1} / {queue.length} · {elapsedMin} z {Math.round(plan.budgetSeconds / 60)} min
          </span>
        </div>
        <button className="btn btn-ghost" onClick={undo} disabled={!last} aria-label="Cofnij ostatnią odpowiedź">
          ↶
        </button>
      </header>

      <div className="session-body">
        <p className="session-meta">
          {card.subjectName} · {card.topicName} · {MATERIAL_LABEL[card.type]}
          {card.isNew && !requeues.current.has(card.itemId) && <span className="pill">nowe</span>}
        </p>
        {schema && schema.parts.length > 1 && <TopicMap schema={schema} current={card.slot} />}
        <CardFront card={card} revealed={phase === "answer"} />

        {phase === "list" && (
          <ol className="list-reveal">
            {(card.payload.items as string[]).slice(0, recalled.length + 1).map((item, i) => (
              <li key={i} className={i < recalled.length ? (recalled[i] ? "ok" : "miss") : "current"}>
                {item}
                {i < recalled.length && <span aria-hidden>{recalled[i] ? " ✓" : " ✗"}</span>}
              </li>
            ))}
          </ol>
        )}
        {phase === "answer" && card.type === "list" && (
          <ol className="list-reveal">
            {(card.payload.items as string[]).map((item, i) => (
              <li key={i} className={recalled[i] ? "ok" : "miss"}>
                {item} <span aria-hidden>{recalled[i] ? "✓" : "✗"}</span>
              </li>
            ))}
          </ol>
        )}

        {phase === "answer" && palace && (
          <div className="palace-hint">
            <p className="small">
              🏛 <strong>{palace.palaceName}</strong> – Twoje obrazy:
            </p>
            <ol className="small">
              {palace.placements.map((p) => (
                <li key={p.locusId}>
                  <strong>{p.locusName}:</strong> {p.image || "(bez opisu)"}
                </li>
              ))}
            </ol>
          </div>
        )}

        {phase === "answer" && (
          <div className="source">
            <div className="source-links">
              <button className="link small" onClick={() => setShowSource((v) => !v)}>
                {showSource ? "Ukryj źródło" : "Pokaż źródło"}
              </button>
              {schema && schema.parts.length > 1 && (
                <button className="link small" onClick={() => setSheet(true)}>
                  Całe zagadnienie
                </button>
              )}
              <button className="link small flag" onClick={flag}>
                ⚑ Zgłoś błąd
              </button>
            </div>
            {showSource &&
              (sources.length ? (
                sources.map((s, i) => (
                  <blockquote key={i}>
                    „{s.quote}”
                    <footer className="muted small">
                      {s.documentTitle}
                      {s.page ? `, s. ${s.page}` : ""}
                      {s.lectureDate ? `, wykład ${s.lectureDate}` : ""} ·{" "}
                      <button className="link small" onClick={() => setViewer({ chunkId: s.chunkId, quote: s.quote })}>
                        cały fragment
                      </button>
                    </footer>
                  </blockquote>
                ))
              ) : (
                <p className="muted small">Twoja fiszka, dodana ręcznie.</p>
              ))}
          </div>
        )}
      </div>

      {viewer && <SourceViewer source={viewer} onClose={() => setViewer(null)} />}
      {sheet && <TopicSheet topicId={card.topicId} current={card.slot} onClose={() => setSheet(false)} />}
      <footer className="session-actions">
        {phase === "question" && (
          <>
            <p className="muted small center">Odpowiedz w myślach. Jak pewnie to wiesz?</p>
            <div className="btn-row">
              {([1, 2, 3] as Confidence[]).map((c) => (
                <button key={c} className="btn btn-secondary btn-big" onClick={() => reveal(c)}>
                  {CONFIDENCE_LABEL[c]}
                </button>
              ))}
            </div>
          </>
        )}
        {phase === "list" && (
          <>
            <p className="muted small center">Czy ta pozycja była w Twojej odpowiedzi?</p>
            <div className="btn-row">
              <button className="btn btn-big r-again" onClick={() => setRecalled((r) => [...r, false])}>
                ✗ Nie
              </button>
              <button className="btn btn-big r-good" onClick={() => setRecalled((r) => [...r, true])}>
                ✓ Tak
              </button>
            </div>
          </>
        )}
        {phase === "answer" && (
          <div className="btn-row">
            {RATINGS.map((r) => (
              <button key={r.grade} className={`btn btn-big btn-rate ${r.cls} ${suggested === r.grade ? "suggested" : ""}`} onClick={() => rate(r.grade)}>
                {r.label}
                <span className="small">{intervals?.[r.grade]}</span>
              </button>
            ))}
          </div>
        )}
      </footer>
    </div>
  );
}

function CardFront({ card, revealed }: { card: PlannedCard; revealed: boolean }) {
  if (card.type === "cloze") {
    return (
      <p className="card-text">
        {parseCloze(card.payload.text, card.subKey).map((s, i) =>
          s.kind === "text" ? (
            <span key={i}>{s.text}</span>
          ) : s.active ? (
            revealed ? (
              <mark key={i} className="gap-answer">
                {s.answer}
              </mark>
            ) : (
              <span key={i} className="gap">
                [{s.hint ?? "…"}]
              </span>
            )
          ) : (
            <span key={i}>{s.answer}</span>
          ),
        )}
      </p>
    );
  }
  if (card.type === "list") {
    return (
      <p className="card-text">
        {card.payload.prompt} <span className="muted">({card.payload.items.length})</span>
      </p>
    );
  }
  return (
    <>
      <p className="card-text">{card.payload.q}</p>
      {revealed && <p className="card-answer">{card.payload.a}</p>}
    </>
  );
}

function Summary({
  logIds,
  reason,
  seconds,
  onClose,
  onUndo,
}: {
  logIds: string[];
  reason: "done" | "time";
  seconds: number;
  onClose: () => void;
  onUndo: (() => void) | null;
}) {
  const { db } = useDb();
  const rows = calibration(db, { logIds });
  const sure = rows.find((r) => r.confidence === 3);
  const overconfident = sure && sure.answers >= 5 && sure.correct / sure.answers < 0.8;
  return (
    <div className="session">
      <div className="session-body summary">
        <h1>{reason === "time" ? "Limit czasu na dziś" : "Sesja zakończona"}</h1>
        <p className="muted">
          Odpowiedzi: {logIds.length} · czas: {Math.max(1, Math.round(seconds / 60))} min
        </p>
        {rows.length > 0 && (
          <section className="card">
            <h2 className="card-title">Pewność a wynik</h2>
            {rows.map((r) => (
              <CalibrationBar key={r.confidence} row={r} />
            ))}
            {overconfident && (
              <p className="small">
                Gdy deklarujesz „pewnie”, mylisz się w {Math.round((1 - sure.correct / sure.answers) * 100)}% przypadków. To złudzenie kompetencji: te
                fiszki wrócą szybciej.
              </p>
            )}
          </section>
        )}
        {reason === "time" && <p className="muted small">Pozostałe fiszki poczekają do jutra. Harmonogram uwzględnia to automatycznie.</p>}
      </div>
      <footer className="session-actions">
        <div className="btn-row">
          {onUndo && (
            <button className="btn btn-secondary btn-big" onClick={onUndo}>
              Cofnij ostatnią
            </button>
          )}
          <button className="btn btn-primary btn-big" onClick={onClose}>
            Gotowe
          </button>
        </div>
      </footer>
    </div>
  );
}

function CalibrationBar({ row }: { row: CalibrationRow }) {
  const pct = Math.round((row.correct / row.answers) * 100);
  return (
    <div className="calib">
      <span className="calib-label">{CONFIDENCE_LABEL[row.confidence]}</span>
      <div className="bar">
        <span style={{ width: `${pct}%` }} />
      </div>
      <span className="small">
        {row.correct}/{row.answers} dobrze
      </span>
    </div>
  );
}
