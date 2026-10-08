import { useEffect } from "react";
import { DOCUMENT_KIND_LABEL, getChunk, locateQuote, MATERIAL_LABEL, type MaterialType, parseCloze, slotInfo, type TopicSchema, topicSchema } from "@paragraf/core";
import { useDb } from "./ui";

/** A material as text, for the approval queue (the session has its own, interactive one). */
export function MaterialPreview({ type, payload }: { type: MaterialType; payload: any }) {
  return (
    <div className="preview">
      <span className="pill pill-muted">{MATERIAL_LABEL[type]}</span>
      {type === "cloze" ? (
        <p className="preview-q">
          {parseCloze(payload.text).map((s, i) =>
            s.kind === "text" ? (
              <span key={i}>{s.text}</span>
            ) : (
              <mark key={i} className="gap-answer" title={`luka ${s.key}`}>
                {s.answer}
              </mark>
            ),
          )}
        </p>
      ) : type === "list" ? (
        <>
          <p className="preview-q">{payload.prompt}</p>
          <ol className="preview-list">
            {(payload.items as string[]).map((it, i) => (
              <li key={i}>{it}</li>
            ))}
          </ol>
        </>
      ) : (
        <>
          <p className="preview-q">{payload.q}</p>
          <p className="preview-a">{payload.a}</p>
        </>
      )}
    </div>
  );
}

export interface SourceRef {
  chunkId: string;
  quote: string;
}

/** The whole source fragment with the quote highlighted: one click from any material back to its source. */
export function SourceViewer({ source, onClose }: { source: SourceRef; onClose: () => void }) {
  const { db } = useDb();
  const chunk = getChunk(db, source.chunkId);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  if (!chunk) return null;
  const at = locateQuote(source.quote, chunk.text);
  const where = [
    DOCUMENT_KIND_LABEL[chunk.documentKind],
    chunk.lectureDate ? `wykład ${chunk.lectureDate}` : null,
    chunk.pageFrom ? `s. ${chunk.pageFrom}${chunk.pageTo && chunk.pageTo !== chunk.pageFrom ? `–${chunk.pageTo}` : ""}` : null,
  ].filter(Boolean);
  return (
    <div className="modal-back" onClick={onClose} role="presentation">
      <div className="modal" role="dialog" aria-modal="true" aria-label="Źródło" onClick={(e) => e.stopPropagation()}>
        <header className="modal-head">
          <div>
            <strong>{chunk.documentTitle}</strong>
            <p className="muted small">
              {where.join(" · ")}
              {chunk.headingPath.length ? ` · ${chunk.headingPath.join(" › ")}` : ""}
            </p>
          </div>
          <button className="btn btn-ghost" onClick={onClose} aria-label="Zamknij">
            ✕
          </button>
        </header>
        <div className="source-text">
          {at ? (
            <>
              {chunk.text.slice(0, at.start)}
              <mark ref={(el) => el?.scrollIntoView({ block: "center" })}>{chunk.text.slice(at.start, at.end)}</mark>
              {chunk.text.slice(at.end)}
            </>
          ) : (
            chunk.text
          )}
        </div>
      </div>
    </div>
  );
}

export function Citation({ quote, title, page, lectureDate, onOpen }: { quote: string; title: string; page: number | null; lectureDate: string | null; onOpen: () => void }) {
  return (
    <button className="citation" onClick={onOpen} title="Pokaż cały fragment źródła">
      <span className="citation-quote">„{quote}”</span>
      <span className="muted small">
        {title}
        {page ? `, s. ${page}` : ""}
        {lectureDate ? `, wykład ${lectureDate}` : ""} ↗
      </span>
    </button>
  );
}

// ---------- a topic as one system ----------


/**
 * The parts of a topic as a strip, with the current part marked. Only the
 * part names show, never their content, so it does not give the answer away.
 */
export function TopicMap({ schema, current }: { schema: TopicSchema; current: string | null }) {
  const idx = schema.parts.findIndex((p) => p.slot === current);
  const cur = slotInfo(current);
  return (
    <div className="topic-map" aria-label={`Zagadnienie ${schema.name}${cur ? `, część: ${cur.label} (${idx + 1} z ${schema.parts.length})` : ""}`}>
      <div className="topic-map-strip" aria-hidden>
        {schema.parts.map((p) => (
          <span
            key={p.slot}
            className={`topic-seg ${p.slot === current ? "on" : ""}`}
            title={`${p.label}: opanowanie ${Math.round(p.mastery * 100)}%`}
            style={{ "--m": p.mastery } as React.CSSProperties}
          >
            {p.icon}
          </span>
        ))}
      </div>
      {cur && (
        <span className="small muted">
          {cur.icon} {cur.label} · {idx + 1} z {schema.parts.length}
        </span>
      )}
    </div>
  );
}

/** The whole topic after an answer: every part with its content and how well you know it. */
export function TopicSheet({ topicId, current, onClose }: { topicId: string; current?: string | null; onClose: () => void }) {
  const { db } = useDb();
  const schema = topicSchema(db, topicId);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  if (!schema) return null;
  return (
    <div className="modal-back" onClick={onClose} role="presentation">
      <div className="modal" role="dialog" aria-modal="true" aria-label={`Całe zagadnienie: ${schema.name}`} onClick={(e) => e.stopPropagation()}>
        <header className="modal-head">
          <div>
            <strong>{schema.name}</strong>
            <p className="muted small">{schema.subjectName} · schemat zagadnienia</p>
          </div>
          <button className="btn btn-ghost" onClick={onClose} aria-label="Zamknij">
            ✕
          </button>
        </header>
        <div className="source-text sheet">
          {schema.parts.map((p) => (
            <section key={p.slot} className={`sheet-part ${p.slot === current ? "on" : ""}`}>
              <div className="list-row">
                <strong>
                  {p.icon} {p.label}
                </strong>
                <span className="small muted">
                  {p.items
                    ? `${Math.round(p.mastery * 100)}% · ${p.learned}/${p.items}`
                    : p.materials
                      ? `fiszki: ${p.materials} · jeszcze nie ćwiczone`
                      : "bez fiszki"}
                </span>
              </div>
              <ul>
                {p.points.map((x) => (
                  <li key={x.fieldId}>
                    {x.text}
                    {x.source && (
                      <details className="point-source">
                        <summary className="small muted">{x.source}</summary>
                        {x.quote && <blockquote className="small">„{x.quote}”</blockquote>}
                      </details>
                    )}
                  </li>
                ))}
              </ul>
            </section>
          ))}
          {schema.parts.length === 0 && (
            <p className="muted small">Źródła tylko wspominają to zagadnienie. Treść pojawi się, gdy Pracownia przeczyta fragment, który je omawia.</p>
          )}
        </div>
      </div>
    </div>
  );
}
