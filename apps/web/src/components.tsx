import { useEffect } from "react";
import { DOCUMENT_KIND_LABEL, getChunk, locateQuote, MATERIAL_LABEL, type MaterialType, parseCloze } from "@paragraf/core";
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
