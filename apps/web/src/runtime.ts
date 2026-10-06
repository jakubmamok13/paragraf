import initSqlJs from "sql.js";
import wasmUrl from "sql.js/dist/sql-wasm-browser.wasm?url";
import { Db, loadPrompts, type PromptSet, recoverJobs, withOverrides, getSettings, type ParseDeps, type PdfJs } from "@paragraf/core";

// Everything stays on this device: SQLite (sql.js) in memory, saved to
// IndexedDB shortly after every change and when the app leaves the screen.

function idb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const r = indexedDB.open("paragraf", 1);
    r.onupgradeneeded = () => r.result.createObjectStore("files");
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}
async function idbDo<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest): Promise<T> {
  const db = await idb();
  return new Promise<T>((resolve, reject) => {
    const tx = db.transaction("files", mode);
    const req = fn(tx.objectStore("files"));
    tx.oncomplete = () => resolve(req.result as T);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  }).finally(() => db.close());
}
const idbGet = <T>(key: string) => idbDo<T | undefined>("readonly", (s) => s.get(key));
const idbPut = (key: string, value: unknown) => idbDo<IDBValidKey>("readwrite", (s) => s.put(value, key));

export interface Runtime {
  db: Db;
  /** Write the database to IndexedDB now (normally 300 ms after a change). */
  flush: () => Promise<void>;
}

let started: Promise<Runtime> | null = null;
export const runtime = (): Promise<Runtime> => (started ??= start());

async function start(): Promise<Runtime> {
  const SQL = await initSqlJs({ locateFile: () => wasmUrl });
  const bytes = await idbGet<Uint8Array>("db");

  let timer: ReturnType<typeof setTimeout> | undefined;
  let saving = Promise.resolve();
  const flush = (): Promise<void> => {
    clearTimeout(timer);
    timer = undefined;
    const data = db.export();
    saving = saving.then(() => idbPut("db", data)).then(
      () => undefined,
      (e) => console.error("[save]", e),
    );
    return saving;
  };
  const db: Db = new Db(bytes ? new SQL.Database(bytes) : new SQL.Database(), () => {
    clearTimeout(timer);
    timer = setTimeout(() => void flush(), 300);
  });
  // iOS may stop the app any time after it leaves the screen: save right away.
  const saveNow = () => {
    if (timer) void flush();
  };
  document.addEventListener("visibilitychange", () => document.visibilityState === "hidden" && saveNow());
  window.addEventListener("pagehide", saveNow);
  void navigator.storage?.persist?.().catch(() => false);
  // A run cut off by closing the app goes back to the queue.
  recoverJobs(db);
  return { db, flush };
}

// ---------- prompts (prompts/*.md, bundled) ----------

const PROMPT_FILES = import.meta.glob("../../../prompts/*.md", { query: "?raw", import: "default", eager: true }) as Record<string, string>;
export const BUNDLED_PROMPTS: PromptSet = loadPrompts(Object.values(PROMPT_FILES));
export const currentPrompts = (db: Db): PromptSet => withOverrides(BUNDLED_PROMPTS, getSettings(db).promptOverrides);

// ---------- file parsing: pdf.js loaded only when a PDF or Pages file comes in ----------

let pdfjsPromise: Promise<PdfJs> | null = null;
export async function parseDeps(fileName: string): Promise<ParseDeps> {
  if (!/\.(pdf|pages)$/i.test(fileName)) return {};
  pdfjsPromise ??= (async () => {
    const [lib, worker] = await Promise.all([import("pdfjs-dist"), import("pdfjs-dist/build/pdf.worker.min.mjs?url")]);
    lib.GlobalWorkerOptions.workerSrc = worker.default;
    return lib as unknown as PdfJs;
  })();
  return { pdfjs: await pdfjsPromise };
}

/** Saves a file: the share sheet on phones (Files, AirDrop, mail), a download elsewhere. */
export async function saveFile(name: string, data: string | Uint8Array): Promise<void> {
  const file = new File([data as BlobPart], name, { type: typeof data === "string" ? "application/json" : "application/gzip" });
  if (navigator.canShare?.({ files: [file] }) && matchMedia("(pointer: coarse)").matches) {
    try {
      await navigator.share({ files: [file], title: name });
      return;
    } catch (e) {
      if ((e as Error).name === "AbortError") return;
    }
  }
  const url = URL.createObjectURL(file);
  const a = Object.assign(document.createElement("a"), { href: url, download: name });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** Opens a file picker and returns the chosen files' bytes (empty when cancelled). */
export function pickFiles(accept: string, multiple = false): Promise<{ name: string; bytes: Uint8Array }[]> {
  return new Promise((resolve) => {
    const input = Object.assign(document.createElement("input"), { type: "file", accept, multiple });
    input.onchange = async () => {
      const files = [...(input.files ?? [])];
      resolve(await Promise.all(files.map(async (f) => ({ name: f.name, bytes: new Uint8Array(await f.arrayBuffer()) }))));
    };
    input.oncancel = () => resolve([]);
    input.click();
  });
}
