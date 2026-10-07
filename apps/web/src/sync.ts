import { type Db, decodePackage, encodePackage, exportPackage, importPackage } from "@paragraf/core";
import { download, DriveError, type DriveFile, driveConfig, hasToken, listFolder, saveDriveConfig, signIn, upload, clientId, whoAmI } from "./drive";

// Synchronisation through one Google Drive folder. Every device keeps its own
// file there (paragraf-sync-<device>.json.gz) and only ever writes that one;
// it reads the other devices' files and merges them (newer change wins,
// deletions travel). No two devices write the same file, so nothing is lost
// when both were used offline. Google keeps earlier versions of every file.
//
// When: on opening the app, when it comes back to the screen, every few
// minutes while open, 30 s after a change here, and right away when it leaves
// the screen with unsent changes.

export type SyncStatus = "off" | "idle" | "syncing" | "needs-login" | "error";

export interface SyncState {
  status: SyncStatus;
  error: string | null;
  /** Other devices' files seen in the folder at the last sync. */
  devices: { name: string; modifiedTime: string; own: boolean }[];
}

let state: SyncState = { status: "off", error: null, devices: [] };
const listeners = new Set<(s: SyncState) => void>();
const set = (patch: Partial<SyncState>) => {
  state = { ...state, ...patch };
  for (const l of listeners) l(state);
};
export const syncState = () => state;
export function onSync(fn: (s: SyncState) => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export const syncConfigured = () => Boolean(clientId() && driveConfig().folderId);

const FILE_PREFIX = "paragraf-sync-";
const slug = (s: string) =>
  s
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/ł/g, "l")
    .replace(/Ł/g, "L")
    .replace(/[^A-Za-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .toLowerCase() || "urzadzenie";
const ownFileName = () => `${FILE_PREFIX}${slug(driveConfig().deviceName)}-${driveConfig().deviceId.slice(0, 8)}.json.gz`;
export const deviceLabel = (f: Pick<DriveFile, "name">) =>
  f.name.replace(FILE_PREFIX, "").replace(/-[0-9a-f]{8}\.json\.gz$/, "").replace(/-/g, " ") || f.name;

let db: Db | null = null;
let refresh: () => void = () => undefined;
let importing = false;
let running: Promise<void> | null = null;
let again = false;
let timer: ReturnType<typeof setTimeout> | undefined;

/** Called for every write to the local database. */
export function noteLocalWrite(): void {
  if (importing) return;
  if (!driveConfig().dirty) saveDriveConfig({ dirty: true });
  // At most every 30 s while you keep changing things (e.g. during AI processing).
  if (!syncConfigured() || timer) return;
  timer = setTimeout(() => {
    timer = undefined;
    void syncNow();
  }, 30_000);
}

/** One round: merge the other devices' files, then upload ours if something changed here. */
export function syncNow(): Promise<void> {
  if (!db || !syncConfigured()) {
    set({ status: "off" });
    return Promise.resolve();
  }
  if (!hasToken()) {
    set({ status: "needs-login" });
    return Promise.resolve();
  }
  if (running) {
    again = true;
    return running;
  }
  clearTimeout(timer);
  timer = undefined;
  running = round(db).finally(() => {
    running = null;
    if (again) {
      again = false;
      void syncNow();
    }
  });
  return running;
}

async function round(db: Db): Promise<void> {
  set({ status: "syncing", error: null });
  let merged = false;
  try {
    const cfg = driveConfig();
    const files = (await listFolder(cfg.folderId!)).filter((f) => f.name.startsWith(FILE_PREFIX) && f.name.endsWith(".json.gz"));
    const own = files.find((f) => f.id === cfg.ownFileId || f.appProperties?.paragrafDevice === cfg.deviceId);
    const seen = { ...cfg.seen };
    for (const f of files) {
      if (f === own || seen[f.id] === f.modifiedTime) continue;
      const pkg = decodePackage(await download(f.id));
      if (pkg.kind !== "sync") continue;
      importing = true;
      try {
        importPackage(db, pkg);
      } finally {
        importing = false;
      }
      seen[f.id] = f.modifiedTime;
      merged = true;
    }
    // Files of devices no longer in the folder are forgotten.
    for (const id of Object.keys(seen)) if (!files.some((f) => f.id === id)) delete seen[id];
    saveDriveConfig({ seen, ownFileId: own?.id ?? null });

    let ownFile = own;
    if (driveConfig().dirty || !own || own.name !== ownFileName()) {
      saveDriveConfig({ dirty: false }); // changes made during the upload set it again
      try {
        ownFile = await upload(
          { fileId: own?.id ?? null, name: ownFileName(), folderId: cfg.folderId!, appProperties: { paragrafDevice: cfg.deviceId } },
          encodePackage(exportPackage(db, "sync")),
        );
      } catch (e) {
        saveDriveConfig({ dirty: true });
        throw e;
      }
      saveDriveConfig({ ownFileId: ownFile.id });
    }
    saveDriveConfig({ lastSyncAt: new Date().toISOString() });
    const all = ownFile ? [...files.filter((f) => f.id !== ownFile.id), ownFile] : files;
    set({ status: "idle", devices: all.map((f) => ({ name: deviceLabel(f), modifiedTime: f.modifiedTime, own: f.id === ownFile?.id })) });
  } catch (e) {
    const login = e instanceof DriveError && e.status === 401;
    set({ status: login ? "needs-login" : "error", error: e instanceof Error ? e.message : String(e) });
  } finally {
    if (merged) refresh();
  }
}

/** Is Google reachable? A redirect while offline would leave you on an error page. */
async function online(): Promise<boolean> {
  if (!navigator.onLine) return false;
  try {
    await fetch("https://accounts.google.com/generate_204", { mode: "no-cors", cache: "no-store", signal: AbortSignal.timeout(3000) });
    return true;
  } catch {
    return false;
  }
}

/**
 * Starts automatic synchronisation (once, when the app opens). With an expired
 * sign-in it renews it with a quick silent trip to Google, at most every few minutes.
 */
export async function startSync(database: Db, onMerged: () => void): Promise<void> {
  if (db) return;
  db = database;
  refresh = onMerged;
  // Set up even before a folder is chosen: choosing one does not reopen the app.
  document.addEventListener("visibilitychange", () => {
    if (!syncConfigured() || !hasToken()) return;
    if (document.visibilityState === "hidden") {
      if (driveConfig().dirty) void syncNow();
    } else if (Date.now() - Date.parse(driveConfig().lastSyncAt ?? "1970-01-01") > 60_000) {
      void syncNow();
    }
  });
  setInterval(() => document.visibilityState === "visible" && hasToken() && void syncNow(), 5 * 60_000);
  if (!syncConfigured()) return;
  const cfg = driveConfig();
  if (!hasToken()) {
    if (!cfg.needsLogin && Date.now() - cfg.silentAt > 3 * 60_000 && (await online())) {
      await signIn(false);
      return;
    }
    set({ status: "needs-login" });
    return;
  }
  if (!cfg.email) void whoAmI().then((email) => email && saveDriveConfig({ email }), () => undefined);
  void syncNow();
}
