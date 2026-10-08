import { useRef, useState } from "react";
import { addManualMaterial, clozeKeys, type MaterialType, topicNames } from "@paragraf/core";
import { Card, Field, useAction, useDb, useToast } from "../ui";

type Kind = Extract<MaterialType, "qa" | "cloze" | "list">;
const KINDS: { id: Kind; label: string }[] = [
  { id: "qa", label: "Pytanie" },
  { id: "cloze", label: "Luki" },
  { id: "list", label: "Wyliczenie" },
];

/** A card written by hand, so learning can start before the Workshop processes any source. */
export function AddCard({
  subjectId,
  subjectName,
  onDone,
  initial,
}: {
  subjectId: string;
  subjectName: string;
  onDone: () => void;
  /** Prefilled from an AI suggestion that no source confirmed: you check and own it. */
  initial?: { topic: string; q: string; a: string; note: string };
}) {
  const { db } = useDb();
  const act = useAction();
  const toast = useToast();
  const [kind, setKind] = useState<Kind>("qa");
  const [topic, setTopic] = useState(initial?.topic ?? "");
  const [q, setQ] = useState(initial?.q ?? "");
  const [a, setA] = useState(initial?.a ?? "");
  const [text, setText] = useState("");
  const [prompt, setPrompt] = useState("");
  const [items, setItems] = useState("");
  const clozeRef = useRef<HTMLTextAreaElement>(null);

  const makeGap = () => {
    const el = clozeRef.current;
    if (!el || el.selectionStart === el.selectionEnd) {
      toast("Zaznacz w tekście fragment, który ma zniknąć.", "error");
      return;
    }
    const n = Math.max(0, ...clozeKeys(text).map((k) => Number(k.slice(1)))) + 1;
    const { selectionStart: s, selectionEnd: e } = el;
    setText(`${text.slice(0, s)}{{c${n}::${text.slice(s, e)}}}${text.slice(e)}`);
  };

  const save = (again: boolean) =>
    act(() => {
      const payload = kind === "qa" ? { q, a } : kind === "cloze" ? { text } : { prompt, items: items.split("\n") };
      const { warnings } = addManualMaterial(db, { subjectId, topicName: topic, type: kind, payload });
      toast(warnings.length ? `Dodano. Uwaga: ${warnings.join(" ")}` : "Dodano fiszkę.");
      setQ("");
      setA("");
      setText("");
      setPrompt("");
      setItems("");
      if (!again) onDone();
    });

  return (
    <div className="screen">
      <div className="screen-head">
        <button className="btn btn-ghost" onClick={onDone}>
          ← Wróć
        </button>
        <h1>Nowa fiszka</h1>
      </div>
      <p className="muted small">{subjectName}. Jedna fiszka sprawdza jedną rzecz.</p>
      {initial && <p className="status status-warn small">{initial.note}</p>}

      <div className="segmented">
        {KINDS.map((k) => (
          <button key={k.id} className={kind === k.id ? "on" : ""} onClick={() => setKind(k.id)}>
            {k.label}
          </button>
        ))}
      </div>

      <Card>
        <Field label="Zagadnienie" hint="np. Zasiedzenie. Fiszki jednego zagadnienia nie pojawią się jedna po drugiej.">
          <input value={topic} onChange={(e) => setTopic(e.target.value)} list="topics" />
          <datalist id="topics">
            {topicNames(db, subjectId).map((n) => (
              <option key={n} value={n} />
            ))}
          </datalist>
        </Field>

        {kind === "qa" && (
          <>
            <Field label="Pytanie">
              <textarea rows={3} value={q} onChange={(e) => setQ(e.target.value)} placeholder="Ile wynosi termin zasiedzenia nieruchomości w złej wierze?" />
            </Field>
            <Field label="Odpowiedź" hint="Krótko, do ok. 20 słów.">
              <textarea rows={2} value={a} onChange={(e) => setA(e.target.value)} placeholder="30 lat (art. 172 § 2 k.c.)" />
            </Field>
          </>
        )}

        {kind === "cloze" && (
          <>
            <Field label="Tekst" hint="Zaznacz słowo lub frazę i naciśnij „Zrób lukę”. Każda luka to osobna powtórka.">
              <textarea ref={clozeRef} rows={5} value={text} onChange={(e) => setText(e.target.value)} placeholder="Wpisz definicję albo brzmienie przepisu." />
            </Field>
            <button className="btn btn-secondary btn-small" onClick={makeGap}>
              Zrób lukę z zaznaczenia
            </button>
            {clozeKeys(text).length > 0 && <p className="muted small">Luki: {clozeKeys(text).length}</p>}
          </>
        )}

        {kind === "list" && (
          <>
            <Field label="Polecenie">
              <input value={prompt} onChange={(e) => setPrompt(e.target.value)} placeholder="Wymień przesłanki zasiedzenia nieruchomości" />
            </Field>
            <Field label="Pozycje" hint="Każda w osobnej linii. Najlepiej do 7.">
              <textarea rows={5} value={items} onChange={(e) => setItems(e.target.value)} />
            </Field>
          </>
        )}
      </Card>

      <div className="btn-row">
        <button className="btn btn-secondary btn-big" onClick={() => void save(true)}>
          Zapisz i dodaj kolejną
        </button>
        <button className="btn btn-primary btn-big" onClick={() => void save(false)}>
          Zapisz
        </button>
      </div>
    </div>
  );
}
