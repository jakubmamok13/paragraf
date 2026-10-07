import { useEffect, useMemo, useRef, useState } from "react";
import {
  CONCRETE_WORDS,
  courseStatus,
  deletePalace,
  drawWords,
  INTRO_QUIZ,
  LEGAL_TERMS,
  listPalaces,
  type Palace,
  placeableLists,
  placeList,
  placementsFor,
  recentWords,
  recordDrill,
  samePhrase,
  savePalace,
  scoreRecall,
  STAGES,
  type StageStatus,
} from "@paragraf/core";
import { Card, Field, useAction, useDb, useToast } from "../ui";

/** The memory palace course: nine stages, each unlocked by passing the previous one. */
export function PalaceTab() {
  const { db } = useDb();
  const [stage, setStage] = useState<number | null>(null);
  const [editing, setEditing] = useState<Palace | "new" | null>(null);
  const status = courseStatus(db);
  const palaces = listPalaces(db);

  // After saving, back to the course overview: it shows the stage passed and the next one unlocked.
  if (editing) return <PalaceEditor palace={editing === "new" ? null : editing} onDone={() => (setEditing(null), setStage(null))} />;
  if (stage !== null) return <StageScreen st={status.find((s) => s.stage === stage)!} onBack={() => setStage(null)} onEditPalace={setEditing} />;

  const current = status.find((s) => s.unlocked && !s.done) ?? status.at(-1)!;
  return (
    <div className="screen">
      <div className="screen-head">
        <h1>Pałac pamięci</h1>
      </div>
      <p className="muted small">
        Metoda miejsc: obrazy rzeczy do zapamiętania „kładziesz” na znanej trasie. Najlepiej służy wyliczeniom w ustalonej kolejności. Uzupełnia fiszki, nie
        zastępuje ich. Kurs prowadzi przez 9 etapów; każdy odblokowuje się po zaliczeniu poprzedniego.
      </p>
      <button className="btn btn-primary btn-xl" onClick={() => setStage(current.stage)}>
        {current.done ? "Podtrzymanie" : `Etap ${current.stage}: ${current.title}`}
      </button>

      <Card title="Etapy kursu">
        <ol className="stages">
          {status.map((s) => (
            <li key={s.stage}>
              <button className={`stage ${s.done ? "done" : s.unlocked ? "open" : "locked"}`} disabled={!s.unlocked} onClick={() => setStage(s.stage)}>
                <span className="stage-mark" aria-hidden>
                  {s.done ? "✓" : s.unlocked ? "▶" : "🔒"}
                </span>
                <span>
                  <strong className="small">
                    {s.stage}. {s.title}
                  </strong>
                  <span className="muted small"> · {s.unlocked ? s.progress : "zablokowany"}</span>
                </span>
              </button>
            </li>
          ))}
        </ol>
      </Card>

      <Card title="Twoje pałace">
        {palaces.length === 0 && <p className="muted small">Jeszcze żadnego. Zbudujesz go w etapie 2.</p>}
        <ul className="list">
          {palaces.map((p) => (
            <li key={p.id} className="list-row">
              <span className="small">
                <strong>{p.name}</strong> <span className="muted">· {p.loci.length} miejsc</span>
              </span>
              <button className="btn btn-ghost btn-small" onClick={() => setEditing(p)}>
                Edytuj
              </button>
            </li>
          ))}
        </ul>
        {status[1]!.unlocked && (
          <button className="btn btn-secondary btn-small" onClick={() => setEditing("new")}>
            + Nowy pałac
          </button>
        )}
      </Card>
    </div>
  );
}

function StageScreen({ st, onBack, onEditPalace }: { st: StageStatus; onBack: () => void; onEditPalace: (p: Palace | "new") => void }) {
  return (
    <div className="screen">
      <div className="screen-head">
        <button className="btn btn-ghost" onClick={onBack}>
          ← Kurs
        </button>
        <h1>
          {st.stage}. {st.title}
        </h1>
      </div>
      <Card>
        {st.body.map((p, i) => (
          <p key={i} className="small">
            {p}
          </p>
        ))}
        <p className="small">
          <strong>Zaliczenie:</strong> {st.criterion} <span className="muted">({st.progress})</span>
        </p>
      </Card>
      {st.stage === 1 && <Quiz onDone={onBack} />}
      {st.stage === 2 && (
        <button className="btn btn-primary btn-xl" onClick={() => onEditPalace("new")}>
          Zbuduj pałac
        </button>
      )}
      {(st.stage === 3 || st.stage === 9) && <RouteWalk />}
      {st.stage === 4 && <ImageDrill />}
      {st.stage === 5 && <RecallDrill key="w10" stage={5} kind="words" size={10} />}
      {st.stage === 6 && <RecallDrill key="w20" stage={6} kind="words" size={20} />}
      {st.stage === 7 && <RecallDrill key="t8" stage={7} kind="terms" size={8} />}
      {st.stage === 8 && <PlacementDrill />}
    </div>
  );
}

// ---------- stage 1: quiz ----------

function Quiz({ onDone }: { onDone: () => void }) {
  const { db } = useDb();
  const act = useAction();
  const [answers, setAnswers] = useState<(number | null)[]>(INTRO_QUIZ.map(() => null));
  const [checked, setChecked] = useState(false);
  const correct = answers.filter((a, i) => a === INTRO_QUIZ[i]!.correct).length;
  return (
    <>
      {INTRO_QUIZ.map((q, i) => (
        <Card key={i} title={`${i + 1}. ${q.q}`}>
          {q.options.map((o, j) => (
            <label key={j} className={`check option ${checked ? (j === q.correct ? "right" : answers[i] === j ? "wrong" : "") : ""}`}>
              <input type="radio" name={`q${i}`} checked={answers[i] === j} disabled={checked} onChange={() => setAnswers((a) => a.map((x, k) => (k === i ? j : x)))} />
              {o}
            </label>
          ))}
          {checked && <p className="small muted">{q.why}</p>}
        </Card>
      ))}
      {!checked ? (
        <button
          className="btn btn-primary btn-xl"
          disabled={answers.some((a) => a === null)}
          onClick={() => void act(() => (recordDrill(db, { stage: 1, kind: "quiz", size: INTRO_QUIZ.length, correct }), setChecked(true)))}
        >
          Sprawdź
        </button>
      ) : (
        <>
          <p className={`status ${correct === INTRO_QUIZ.length ? "status-ok" : "status-warn"}`}>
            {correct} z {INTRO_QUIZ.length} poprawnie.{correct === INTRO_QUIZ.length ? " Etap zaliczony." : " Przeczytaj wyjaśnienia i spróbuj jeszcze raz."}
          </p>
          <button className="btn btn-secondary" onClick={() => (correct === INTRO_QUIZ.length ? onDone() : (setAnswers(INTRO_QUIZ.map(() => null)), setChecked(false)))}>
            {correct === INTRO_QUIZ.length ? "Dalej" : "Jeszcze raz"}
          </button>
        </>
      )}
    </>
  );
}

// ---------- stage 2: building a palace ----------

function PalaceEditor({ palace, onDone }: { palace: Palace | null; onDone: () => void }) {
  const { db } = useDb();
  const act = useAction();
  const [name, setName] = useState(palace?.name ?? "Moje mieszkanie");
  const [desc, setDesc] = useState(palace?.description ?? "");
  const [loci, setLoci] = useState(palace?.loci.map((l) => l.name).join("\n") ?? "");
  const count = loci.split("\n").filter((l) => l.trim()).length;
  return (
    <div className="screen">
      <div className="screen-head">
        <button className="btn btn-ghost" onClick={onDone}>
          ← Wróć
        </button>
        <h1>{palace ? "Edytuj pałac" : "Nowy pałac"}</h1>
      </div>
      <Card>
        <Field label="Nazwa">
          <input value={name} onChange={(e) => setName(e.target.value)} />
        </Field>
        <Field label="Opis trasy (opcjonalnie)" hint="Np. „od drzwi wejściowych zgodnie z ruchem wskazówek zegara”.">
          <input value={desc} onChange={(e) => setDesc(e.target.value)} />
        </Field>
        <Field label={`Miejsca w kolejności (${count})`} hint="Każde w osobnej linii. Wyraźnie różne, stałe, w kolejności, w jakiej je mijasz. Co najmniej 10, a do etapu 6 – 20.">
          <textarea rows={12} value={loci} onChange={(e) => setLoci(e.target.value)} placeholder={"drzwi wejściowe\nwieszak\nlustro\nszafka na buty\n…"} />
        </Field>
      </Card>
      <div className="btn-row">
        {palace && (
          <button
            className="btn btn-secondary btn-big"
            onClick={() => confirm(`Usunąć pałac „${palace.name}” razem z umieszczonymi w nim listami?`) && void act(() => (deletePalace(db, palace.id), onDone()))}
          >
            Usuń
          </button>
        )}
        <button
          className="btn btn-primary btn-big"
          onClick={() =>
            void act(() => {
              savePalace(db, { ...(palace ? { id: palace.id } : {}), name, description: desc, loci: loci.split("\n") });
              onDone();
            }, "Zapisano pałac.")
          }
        >
          Zapisz
        </button>
      </div>
    </div>
  );
}

function usePalaceWith(min: number): [Palace | undefined, Palace[], (id: string) => void] {
  const { db } = useDb();
  const palaces = listPalaces(db).filter((p) => p.loci.length >= min);
  const [id, setId] = useState(palaces[0]?.id ?? "");
  return [palaces.find((p) => p.id === id) ?? palaces[0], palaces, setId];
}

function PalacePicker({ palaces, value, onChange }: { palaces: Palace[]; value?: string; onChange: (id: string) => void }) {
  if (palaces.length < 2) return null;
  return (
    <Field label="Pałac">
      <select value={value} onChange={(e) => onChange(e.target.value)}>
        {palaces.map((p) => (
          <option key={p.id} value={p.id}>
            {p.name} ({p.loci.length})
          </option>
        ))}
      </select>
    </Field>
  );
}

// ---------- stage 3: walking the route ----------

function RouteWalk() {
  const { db } = useDb();
  const act = useAction();
  const [palace, palaces, setId] = usePalaceWith(5);
  const [dir, setDir] = useState<"forward" | "backward" | null>(null);
  const [i, setI] = useState(0);
  const [shown, setShown] = useState(false);
  const [marks, setMarks] = useState<boolean[]>([]);
  if (!palace) return <p className="muted small">Najpierw zbuduj pałac (etap 2).</p>;
  const order = dir === "backward" ? [...palace.loci].reverse() : palace.loci;

  if (!dir) {
    return (
      <Card title="Przejdź trasę z pamięci">
        <PalacePicker palaces={palaces} value={palace.id} onChange={setId} />
        <div className="btn-row">
          <button className="btn btn-primary btn-big" onClick={() => setDir("forward")}>
            W przód
          </button>
          <button className="btn btn-secondary btn-big" onClick={() => setDir("backward")}>
            Wstecz
          </button>
        </div>
      </Card>
    );
  }
  if (marks.length === order.length) {
    const correct = marks.filter(Boolean).length;
    return (
      <Card title="Wynik">
        <p className={`status ${correct === order.length ? "status-ok" : "status-warn"}`}>
          {correct} z {order.length} miejsc. {correct === order.length ? "Bezbłędnie!" : "Miejsca, które umknęły, przejdź jeszcze raz w wyobraźni."}
        </p>
        <button className="btn btn-secondary" onClick={() => (setDir(null), setI(0), setMarks([]), setShown(false))}>
          Jeszcze raz
        </button>
      </Card>
    );
  }
  const answer = (ok: boolean) => {
    const next = [...marks, ok];
    setMarks(next);
    setShown(false);
    setI(i + 1);
    if (next.length === order.length) {
      void act(() =>
        recordDrill(db, { stage: 3, kind: dir === "forward" ? "route_forward" : "route_backward", size: order.length, correct: next.filter(Boolean).length, palaceId: palace.id }),
      );
    }
  };
  return (
    <Card title={`${dir === "forward" ? "W przód" : "Wstecz"} · miejsce ${i + 1} z ${order.length}`}>
      <p className="muted small">Jakie miejsce jest {dir === "forward" ? "następne" : "poprzednie"} na trasie?</p>
      {shown ? <p className="card-text">{order[i]!.name}</p> : <p className="card-text muted">…</p>}
      {!shown ? (
        <button className="btn btn-primary btn-big" onClick={() => setShown(true)}>
          Pokaż
        </button>
      ) : (
        <div className="btn-row">
          <button className="btn btn-big r-again" onClick={() => answer(false)}>
            ✗ Nie pamiętałem
          </button>
          <button className="btn btn-big r-good" onClick={() => answer(true)}>
            ✓ Pamiętałem
          </button>
        </div>
      )}
    </Card>
  );
}

// ---------- stage 4: vivid images ----------

const FEATURES = ["wchodzi w interakcję z miejscem", "jest przesadzony / absurdalny", "jest w ruchu", "angażuje zmysły (dźwięk, zapach, dotyk)"];

function ImageDrill() {
  const { db } = useDb();
  const act = useAction();
  const [palace] = usePalaceWith(5);
  const [round, setRound] = useState(0);
  const [image, setImage] = useState("");
  const [feat, setFeat] = useState<boolean[]>(FEATURES.map(() => false));
  const seed = useMemo(() => Date.now() % 100000, []);
  const words = useMemo(() => drawWords(CONCRETE_WORDS, 5, seed), [seed]);
  if (!palace) return <p className="muted small">Najpierw zbuduj pałac (etap 2).</p>;
  if (round >= 5) return <p className="status status-ok">Pięć obrazów opisanych. Wróć do kursu, żeby zobaczyć postęp.</p>;
  const locus = palace.loci[round % palace.loci.length]!;
  return (
    <Card title={`Obraz ${round + 1} z 5`}>
      <p className="card-text">
        <strong>{words[round]}</strong> na miejscu <strong>{locus.name}</strong>
      </p>
      <Field label="Twój obraz">
        <textarea rows={3} value={image} onChange={(e) => setImage(e.target.value)} placeholder="Opisz scenę: co się dzieje, jak to wygląda, brzmi, pachnie…" />
      </Field>
      <p className="small">Twój obraz:</p>
      {FEATURES.map((f, i) => (
        <label key={f} className="check">
          <input type="checkbox" checked={feat[i]} onChange={(e) => setFeat((x) => x.map((v, k) => (k === i ? e.target.checked : v)))} />
          {f}
        </label>
      ))}
      <button
        className="btn btn-primary btn-big"
        disabled={image.trim().length < 10}
        onClick={() =>
          void act(() => {
            const correct = feat.filter(Boolean).length;
            recordDrill(db, { stage: 4, kind: "images", size: 4, correct, palaceId: palace.id, detail: { word: words[round], locus: locus.name, image } });
            setRound(round + 1);
            setImage("");
            setFeat(FEATURES.map(() => false));
          }, feat.filter(Boolean).length >= 3 ? "Mocny obraz." : "Spróbuj dodać ruch, przesadę albo zmysły.")
        }
      >
        Zapisz obraz
      </button>
    </Card>
  );
}

// ---------- stages 5–7: encode, pause, recall ----------

function RecallDrill({ stage, kind, size }: { stage: number; kind: "words" | "terms"; size: number }) {
  const { db } = useDb();
  const act = useAction();
  const [palace, palaces, setId] = usePalaceWith(size);
  const seed = useMemo(() => Date.now() % 100000, []);
  const items = useMemo(
    () => (kind === "words" ? drawWords(CONCRETE_WORDS, size, seed, recentWords(db)) : drawWords(LEGAL_TERMS.filter((t) => !t.example).map((t) => t.term), size, seed)),
    [db, kind, size, seed],
  );
  const [phase, setPhase] = useState<"intro" | "encode" | "pause" | "recall" | "result">("intro");
  const [i, setI] = useState(0);
  const [images, setImages] = useState<string[]>(items.map(() => ""));
  const [answers, setAnswers] = useState<string[]>(items.map(() => ""));
  const [pause, setPause] = useState({ start: 0, number: 0, guess: "" });
  const [now, setNow] = useState(Date.now());
  const started = useRef(0);
  useEffect(() => {
    if (phase !== "encode" && phase !== "pause") return;
    const t = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(t);
  }, [phase]);

  if (!palace) {
    return (
      <p className="status status-warn">
        To ćwiczenie potrzebuje pałacu z co najmniej {size} miejscami. Rozbuduj trasę w „Twoje pałace” na ekranie kursu.
      </p>
    );
  }
  const loci = palace.loci.slice(0, size);

  if (phase === "intro") {
    return (
      <Card title={kind === "words" ? `Lista ${size} słów` : `${size} pojęć prawniczych`}>
        <PalacePicker palaces={palaces} value={palace.id} onChange={setId} />
        {kind === "terms" && (
          <div className="examples">
            <p className="small">Przykłady obrazów-zastępników:</p>
            {LEGAL_TERMS.filter((t) => t.example).map((t) => (
              <p key={t.term} className="small">
                <strong>{t.term}</strong> → {t.example}
              </p>
            ))}
          </div>
        )}
        <p className="small muted">
          Na każdym miejscu połóż żywy obraz{kind === "terms" ? " – najpierw zamień pojęcie na konkretny zastępnik i krótko go opisz" : ""}. Około 20 sekund na pozycję.
        </p>
        <button className="btn btn-primary btn-big" onClick={() => ((started.current = Date.now()), setPhase("encode"), setNow(Date.now()))}>
          Zaczynam
        </button>
      </Card>
    );
  }
  if (phase === "encode") {
    const elapsed = Math.floor((now - started.current) / 1000);
    const target = (i + 1) * 20;
    return (
      <Card title={`Miejsce ${i + 1} z ${size}: ${loci[i]!.name}`}>
        <p className="card-text">
          <strong>{items[i]}</strong>
        </p>
        <div className="bar" title="Sugerowany czas: 20 sekund na pozycję">
          <span style={{ width: `${Math.min(100, ((elapsed - i * 20) / 20) * 100)}%` }} />
        </div>
        {kind === "terms" && (
          <Field label="Twój obraz-zastępnik">
            <textarea rows={2} value={images[i]} onChange={(e) => setImages((x) => x.map((v, k) => (k === i ? e.target.value : v)))} />
          </Field>
        )}
        <button
          className="btn btn-primary btn-big"
          disabled={kind === "terms" && images[i]!.trim().length < 5}
          onClick={() => {
            if (i + 1 < size) setI(i + 1);
            else {
              setPause({ start: Date.now(), number: 300 + Math.floor(Math.random() * 600), guess: "" });
              setPhase("pause");
            }
          }}
        >
          {i + 1 < size ? `Dalej${elapsed < target ? ` (${target - elapsed} s)` : ""}` : "Gotowe"}
        </button>
      </Card>
    );
  }
  if (phase === "pause") {
    const left = Math.max(0, 30 - Math.floor((now - pause.start) / 1000));
    return (
      <Card title="Przerwa: 30 sekund liczenia">
        <p className="small">
          Odejmuj w pamięci po 7 od liczby <strong>{pause.number}</strong>. To czyści pamięć krótkotrwałą, żeby przywołanie sprawdziło pałac, a nie świeże echo.
        </p>
        <Field label="Gdzie doszedłeś?">
          <input inputMode="numeric" value={pause.guess} onChange={(e) => setPause({ ...pause, guess: e.target.value })} />
        </Field>
        <button className="btn btn-primary btn-big" disabled={left > 0} onClick={() => setPhase("recall")}>
          {left > 0 ? `Jeszcze ${left} s` : "Przejdź trasę"}
        </button>
      </Card>
    );
  }
  if (phase === "recall") {
    return (
      <Card title="Idź trasą i wpisz, co leży na każdym miejscu">
        {loci.map((l, k) => (
          <Field key={l.id} label={`${k + 1}. ${l.name}`}>
            <input value={answers[k]} onChange={(e) => setAnswers((x) => x.map((v, j) => (j === k ? e.target.value : v)))} autoComplete="off" />
          </Field>
        ))}
        <button
          className="btn btn-primary btn-big"
          onClick={() =>
            void act(() => {
              const r = scoreRecall(items, answers);
              recordDrill(db, { stage, kind, size, correct: r.correct, palaceId: palace.id, durationMs: Date.now() - started.current, detail: { words: items, answers, images } });
              setPhase("result");
            })
          }
        >
          Sprawdź
        </button>
      </Card>
    );
  }
  const r = scoreRecall(items, answers);
  return (
    <Card title={`Wynik: ${r.correct} z ${size}`}>
      <ol className="small">
        {items.map((w, k) => (
          <li key={k} className={r.perItem[k] ? "ok-text" : "miss-text"}>
            {loci[k]!.name}: <strong>{w}</strong>
            {!r.perItem[k] && <span className="muted"> (wpisano: {answers[k] || "—"})</span>}
          </li>
        ))}
      </ol>
      <p className="muted small">Pozycje, które umknęły, zwykle miały za słaby obraz albo leżały na zbyt podobnych miejscach.</p>
    </Card>
  );
}

// ---------- stage 8: your own lists ----------

function PlacementDrill() {
  const { db } = useDb();
  const act = useAction();
  const toast = useToast();
  const lists = placeableLists(db);
  const [palace, palaces, setPalaceId] = usePalaceWith(3);
  const [materialId, setMaterialId] = useState(lists[0]?.materialId ?? "");
  const list = lists.find((l) => l.materialId === materialId);
  const existing = list ? placementsFor(db, list.materialId) : null;
  const [loci, setLoci] = useState<string[]>([]);
  const [images, setImages] = useState<string[]>([]);
  const [recall, setRecall] = useState<string[] | null>(null);
  const [result, setResult] = useState<boolean[] | null>(null);

  useEffect(() => {
    if (!list || !palace) return;
    const p = placementsFor(db, list.materialId);
    setLoci(list.items.map((_, i) => p?.placements.find((x) => x.itemIndex === i)?.locusId ?? palace.loci[i]?.id ?? ""));
    setImages(list.items.map((_, i) => p?.placements.find((x) => x.itemIndex === i)?.image ?? ""));
    setRecall(null);
    setResult(null);
  }, [db, list?.materialId, palace?.id]);

  if (!lists.length) return <p className="muted small">Nie masz jeszcze zatwierdzonych wyliczeń (np. przesłanek). Pojawią się po przetworzeniu notatek albo dodaj własne w Przedmiotach.</p>;
  if (!palace || !list) return <p className="muted small">Najpierw zbuduj pałac (etap 2).</p>;
  if (palace.loci.length < list.items.length) return <p className="status status-warn">Ten pałac ma za mało miejsc na tę listę ({list.items.length}).</p>;

  if (recall) {
    const order = list.items.map((item, i) => ({ item, locus: palace.loci.find((l) => l.id === loci[i]) })).sort((a, b) => (a.locus?.ord ?? 0) - (b.locus?.ord ?? 0));
    return (
      <Card title="Przywołaj z trasy">
        {order.map((o, k) => (
          <Field key={k} label={`${o.locus?.name ?? "?"}`}>
            <input value={recall[k]} onChange={(e) => setRecall((x) => x!.map((v, j) => (j === k ? e.target.value : v)))} autoComplete="off" />
          </Field>
        ))}
        {result && (
          <ol className="small">
            {order.map((o, k) => (
              <li key={k} className={result[k] ? "ok-text" : "miss-text"}>
                {o.item}
              </li>
            ))}
          </ol>
        )}
        {!result ? (
          <button
            className="btn btn-primary btn-big"
            onClick={() =>
              void act(() => {
                const per = order.map((o, k) => samePhrase(o.item, recall[k] ?? ""));
                recordDrill(db, { stage: 8, kind: "material", size: per.length, correct: per.filter(Boolean).length, palaceId: palace.id, detail: { materialId: list.materialId } });
                setResult(per);
              })
            }
          >
            Sprawdź
          </button>
        ) : (
          <button className="btn btn-secondary" onClick={() => (setRecall(null), setResult(null))}>
            Wróć do obrazów
          </button>
        )}
      </Card>
    );
  }

  return (
    <Card title="Umieść wyliczenie w pałacu">
      <Field label="Wyliczenie">
        <select value={materialId} onChange={(e) => setMaterialId(e.target.value)}>
          {lists.map((l) => (
            <option key={l.materialId} value={l.materialId}>
              {l.placed ? "✓ " : ""}
              {l.topicName}: {l.prompt}
            </option>
          ))}
        </select>
      </Field>
      <PalacePicker palaces={palaces} value={palace.id} onChange={setPalaceId} />
      {list.items.map((item, i) => (
        <div key={i} className="placement">
          <p className="small">
            <strong>{i + 1}. {item}</strong>
          </p>
          <div className="grid2">
            <select value={loci[i]} onChange={(e) => setLoci((x) => x.map((v, k) => (k === i ? e.target.value : v)))} aria-label={`Miejsce dla: ${item}`}>
              {palace.loci.map((l) => (
                <option key={l.id} value={l.id}>
                  {l.ord + 1}. {l.name}
                </option>
              ))}
            </select>
            <input value={images[i]} onChange={(e) => setImages((x) => x.map((v, k) => (k === i ? e.target.value : v)))} placeholder="Twój obraz" aria-label={`Obraz dla: ${item}`} />
          </div>
        </div>
      ))}
      <div className="btn-row">
        <button
          className="btn btn-primary btn-big"
          disabled={images.some((x) => x.trim().length < 3)}
          onClick={() =>
            void act(() => {
              placeList(db, { materialId: list.materialId, palaceId: palace.id, items: list.items.map((_, i) => ({ itemIndex: i, locusId: loci[i]!, image: images[i]! })) });
              toast("Zapisano. Teraz przejdź trasę i przywołaj listę.");
              setRecall(list.items.map(() => ""));
            })
          }
        >
          {existing ? "Zapisz zmiany i przywołaj" : "Zapisz i przywołaj"}
        </button>
      </div>
    </Card>
  );
}

export { STAGES };
