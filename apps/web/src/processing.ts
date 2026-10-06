import { type Db, type JobProgress, retryJobs, runQueue } from "@paragraf/core";
import { currentPrompts } from "./runtime";

// The processing queue runs in the background of the page, so it keeps going
// while you switch tabs. Progress is saved after every fragment.

export interface ProcessingState {
  running: boolean;
  progress: JobProgress | null;
  error: string | null;
}

let state: ProcessingState = { running: false, progress: null, error: null };
let controller: AbortController | null = null;
const listeners = new Set<(s: ProcessingState) => void>();

const set = (patch: Partial<ProcessingState>) => {
  state = { ...state, ...patch };
  for (const l of listeners) l(state);
};

export const processingState = () => state;
export function onProcessing(fn: (s: ProcessingState) => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** Starts the queue (no-op when it already runs). `changed` refreshes the screens after each step. */
export async function startProcessing(db: Db, changed: () => void): Promise<void> {
  if (state.running) return;
  retryJobs(db);
  controller = new AbortController();
  set({ running: true, error: null });
  try {
    const r = await runQueue(db, {
      prompts: currentPrompts(db),
      signal: controller.signal,
      onProgress: (p) => {
        set({ progress: p });
        changed();
      },
    });
    set({ running: false, progress: null, error: r.stoppedBy === "error" ? (r.error ?? "Błąd") : null });
  } catch (e) {
    set({ running: false, progress: null, error: e instanceof Error ? e.message : String(e) });
  }
  changed();
}

export function pauseProcessing(): void {
  controller?.abort();
}
