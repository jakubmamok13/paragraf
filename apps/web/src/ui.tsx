import { createContext, type ReactNode, useCallback, useContext, useState } from "react";
import type { Db } from "@paragraf/core";

// ---------- database context: screens re-read after every change ----------

interface DbCtx {
  db: Db;
  /** Bumped after each change; screens read from the database on render. */
  version: number;
  changed: () => void;
}
const Ctx = createContext<DbCtx | null>(null);

export function DbProvider({ db, children }: { db: Db; children: ReactNode }) {
  const [version, setVersion] = useState(0);
  const changed = useCallback(() => setVersion((v) => v + 1), []);
  return <Ctx.Provider value={{ db, version, changed }}>{children}</Ctx.Provider>;
}
export function useDb(): DbCtx {
  const c = useContext(Ctx);
  if (!c) throw new Error("DbProvider missing");
  return c;
}

// ---------- toasts ----------

type Toast = { id: number; text: string; kind: "ok" | "error" };
const ToastCtx = createContext<(text: string, kind?: Toast["kind"]) => void>(() => undefined);
export const useToast = () => useContext(ToastCtx);

export function ToastHost({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const show = useCallback((text: string, kind: Toast["kind"] = "ok") => {
    const id = Date.now() + Math.random();
    setToasts((t) => [...t, { id, text, kind }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), kind === "error" ? 7000 : 3500);
  }, []);
  return (
    <ToastCtx.Provider value={show}>
      {children}
      <div className="toasts" role="status" aria-live="polite">
        {toasts.map((t) => (
          <div key={t.id} className={`toast toast-${t.kind}`}>
            {t.text}
          </div>
        ))}
      </div>
    </ToastCtx.Provider>
  );
}

/** Runs an action, shows its error as a toast, and refreshes the screens. */
export function useAction() {
  const toast = useToast();
  const { changed } = useDb();
  return useCallback(
    async (fn: () => unknown | Promise<unknown>, okText?: string) => {
      try {
        await fn();
        changed();
        if (okText) toast(okText);
        return true;
      } catch (e) {
        toast(e instanceof Error ? e.message : String(e), "error");
        return false;
      }
    },
    [changed, toast],
  );
}

// ---------- small building blocks ----------

export function Card({ title, children, actions }: { title?: ReactNode; children: ReactNode; actions?: ReactNode }) {
  return (
    <section className="card">
      {title && <h2 className="card-title">{title}</h2>}
      {children}
      {actions && <div className="card-actions">{actions}</div>}
    </section>
  );
}

export function Field({ label, hint, children }: { label: string; hint?: ReactNode; children: ReactNode }) {
  return (
    <label className="field">
      <span className="field-label">{label}</span>
      {children}
      {hint && <span className="field-hint">{hint}</span>}
    </label>
  );
}

export function plDays(n: number): string {
  if (n === 0) return "dziś";
  if (n === 1) return "jutro";
  return `za ${n} dni`;
}

export function formatDate(iso: string): string {
  return new Date(`${iso}T12:00:00`).toLocaleDateString("pl-PL", { day: "numeric", month: "long", year: "numeric" });
}
