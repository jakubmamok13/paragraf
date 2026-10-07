// Google Drive, straight from the browser (no server of ours in between).
//
// Access: the "drive.file" scope – the app sees only the files and folders it
// created itself, never the rest of your Drive. Sign-in is a full-page redirect
// to Google and back (OAuth 2.0 for client-side apps); it works in an app added
// to the iPhone home screen, where pop-ups do not. The access token lasts an
// hour and is renewed by another redirect, silently once you have agreed.

const AUTH = "https://accounts.google.com/o/oauth2/v2/auth";
const API = "https://www.googleapis.com/drive/v3";
const UPLOAD = "https://www.googleapis.com/upload/drive/v3";
export const DRIVE_SCOPE = "https://www.googleapis.com/auth/drive.file";
const FOLDER_MIME = "application/vnd.google-apps.folder";

// ---------- what this device remembers (not in the database: it is not synchronised) ----------

export interface DriveConfig {
  /** OAuth client ID (from the build, or typed in on the device). */
  clientId: string;
  folderId: string | null;
  folderName: string | null;
  /** This device's own file in the folder. */
  deviceId: string;
  deviceName: string;
  ownFileId: string | null;
  /** Google account, for the silent renewal. */
  email: string | null;
  token: string | null;
  tokenExpires: number;
  /** Other devices' files already merged: file id → modifiedTime. */
  seen: Record<string, string>;
  /** Changes made here and not uploaded yet. */
  dirty: boolean;
  lastSyncAt: string | null;
  /** When a silent renewal was last tried (to never loop). */
  silentAt: number;
  /** Google said a click is needed (signed out, consent withdrawn). */
  needsLogin: boolean;
}

const KEY = "paragraf.drive";
const BUILT_IN_CLIENT_ID: string = (import.meta.env.VITE_GOOGLE_CLIENT_ID as string | undefined) ?? "";

function guessDeviceName(): string {
  const ua = navigator.userAgent;
  if (/iPad|Tablet/i.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1)) return "Tablet";
  if (/iPhone|Android.*Mobile|Mobile/i.test(ua)) return "Telefon";
  return "Komputer";
}

let cache: DriveConfig | null = null;
export function driveConfig(): DriveConfig {
  if (cache) return cache;
  let stored: Partial<DriveConfig> = {};
  try {
    stored = JSON.parse(localStorage.getItem(KEY) ?? "{}") as Partial<DriveConfig>;
  } catch {
    /* private mode or a broken value: start over */
  }
  cache = {
    clientId: "",
    folderId: null,
    folderName: null,
    deviceId: crypto.randomUUID(),
    deviceName: guessDeviceName(),
    ownFileId: null,
    email: null,
    token: null,
    tokenExpires: 0,
    seen: {},
    dirty: false,
    lastSyncAt: null,
    silentAt: 0,
    needsLogin: false,
    ...stored,
  };
  if (!stored.deviceId) saveDriveConfig({});
  return cache;
}
export function saveDriveConfig(patch: Partial<DriveConfig>): DriveConfig {
  cache = { ...driveConfig(), ...patch };
  try {
    localStorage.setItem(KEY, JSON.stringify(cache));
  } catch {
    /* storage full or blocked: keeps working for this visit */
  }
  return cache;
}
export const clientId = (): string => driveConfig().clientId.trim() || BUILT_IN_CLIENT_ID;
export const hasToken = (): boolean => Boolean(driveConfig().token) && driveConfig().tokenExpires > Date.now() + 60_000;

/** The address Google sends you back to; it must be listed in the OAuth client exactly like this. */
export function redirectUri(): string {
  return location.origin + location.pathname.replace(/index\.html$/, "");
}

// ---------- sign-in ----------

/** Goes to Google. interactive=false renews silently (no screen, if you agreed before). */
export async function signIn(interactive: boolean): Promise<void> {
  const id = clientId();
  if (!id) throw new Error("Brak identyfikatora klienta Google (Ustawienia → Dysk Google).");
  const state = crypto.randomUUID();
  const cfg = saveDriveConfig({ silentAt: interactive ? driveConfig().silentAt : Date.now() });
  try {
    localStorage.setItem(`${KEY}.state`, state);
  } catch {
    /* without it the answer is still accepted below only if the state matches – so it will not be */
  }
  const params = new URLSearchParams({
    client_id: id,
    redirect_uri: redirectUri(),
    response_type: "token",
    scope: DRIVE_SCOPE,
    include_granted_scopes: "true",
    state,
    prompt: interactive ? "select_account" : "none",
  });
  if (cfg.email) params.set("login_hint", cfg.email);
  // The page unloads: save the database first (it is normally written 300 ms after a change).
  const { runtime } = await import("./runtime");
  await (await runtime()).flush();
  location.assign(`${AUTH}?${params}`);
}

/**
 * Reads Google's answer from the address (#access_token=… or #error=…) when the
 * app opens after a sign-in, and removes it from the address bar.
 */
export function consumeSignIn(): "ok" | "needs-login" | "error" | null {
  const hash = location.hash.startsWith("#") ? location.hash.slice(1) : "";
  if (!/(^|&)(access_token|error)=/.test(hash)) return null;
  const p = new URLSearchParams(hash);
  let expected: string | null = null;
  try {
    expected = localStorage.getItem(`${KEY}.state`);
    localStorage.removeItem(`${KEY}.state`);
  } catch {
    /* ignore */
  }
  history.replaceState(null, "", location.pathname + location.search);
  if (!expected || p.get("state") !== expected) return "error";
  const token = p.get("access_token");
  if (token) {
    const granted = (p.get("scope") ?? DRIVE_SCOPE).split(" ");
    if (!granted.includes(DRIVE_SCOPE)) {
      saveDriveConfig({ needsLogin: true });
      return "needs-login";
    }
    saveDriveConfig({ token, tokenExpires: Date.now() + Number(p.get("expires_in") ?? 3600) * 1000, needsLogin: false });
    return "ok";
  }
  const error = p.get("error") ?? "";
  // interaction_required, login_required, consent_required, account_selection_required…
  saveDriveConfig({ token: null, tokenExpires: 0, needsLogin: true });
  return /required$/.test(error) || error === "access_denied" ? "needs-login" : "error";
}

export function forgetDrive(): void {
  saveDriveConfig({ token: null, tokenExpires: 0, folderId: null, folderName: null, ownFileId: null, seen: {}, lastSyncAt: null, needsLogin: false, email: null });
}

// ---------- Drive REST ----------

export class DriveError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

async function call(url: string, init: RequestInit = {}): Promise<Response> {
  const cfg = driveConfig();
  if (!hasToken()) throw new DriveError("Zaloguj się ponownie do Dysku Google.", 401);
  let res: Response;
  try {
    res = await fetch(url, { ...init, headers: { ...(init.headers as Record<string, string>), Authorization: `Bearer ${cfg.token}` } });
  } catch {
    throw new DriveError("Brak połączenia z Dyskiem Google.", 0);
  }
  if (res.status === 401) {
    saveDriveConfig({ token: null, tokenExpires: 0 });
    throw new DriveError("Zaloguj się ponownie do Dysku Google.", 401);
  }
  if (!res.ok) {
    let detail = "";
    try {
      detail = ((await res.json()) as { error?: { message?: string } }).error?.message ?? "";
    } catch {
      /* not JSON */
    }
    const text =
      res.status === 404
        ? "Nie ma już tego pliku albo folderu na Dysku (usunięty?)."
        : res.status === 403 && /quota|storage/i.test(detail)
          ? "Brak miejsca na Dysku Google."
          : `Dysk Google odpowiedział błędem ${res.status}${detail ? `: ${detail}` : ""}.`;
    throw new DriveError(text, res.status);
  }
  return res;
}

export interface DriveFile {
  id: string;
  name: string;
  modifiedTime: string;
  size?: string;
  appProperties?: Record<string, string>;
}

/** Your Google account's e-mail (used to renew the sign-in without asking). */
export async function whoAmI(): Promise<string> {
  const r = (await (await call(`${API}/about?fields=user(emailAddress)`)).json()) as { user?: { emailAddress?: string } };
  return r.user?.emailAddress ?? "";
}

/** Folders the app created (on any of your devices) – the only ones it can see. */
export async function listFolders(): Promise<DriveFile[]> {
  const q = encodeURIComponent(`mimeType = '${FOLDER_MIME}' and trashed = false`);
  const r = (await (await call(`${API}/files?q=${q}&fields=files(id,name,modifiedTime)&orderBy=modifiedTime desc&pageSize=50`)).json()) as { files: DriveFile[] };
  return r.files;
}

export async function createFolder(name: string): Promise<DriveFile> {
  const res = await call(`${API}/files?fields=id,name,modifiedTime`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name, mimeType: FOLDER_MIME }),
  });
  return (await res.json()) as DriveFile;
}

export async function listFolder(folderId: string): Promise<DriveFile[]> {
  // Fails with 404 when the folder was deleted.
  await call(`${API}/files/${folderId}?fields=id,trashed`).then(async (r) => {
    if (((await r.json()) as { trashed?: boolean }).trashed) throw new DriveError("Folder synchronizacji jest w koszu na Dysku.", 404);
  });
  const q = encodeURIComponent(`'${folderId}' in parents and trashed = false`);
  const r = (await (await call(`${API}/files?q=${q}&fields=files(id,name,modifiedTime,size,appProperties)&pageSize=200`)).json()) as { files: DriveFile[] };
  return r.files;
}

export async function download(fileId: string): Promise<Uint8Array> {
  return new Uint8Array(await (await call(`${API}/files/${fileId}?alt=media`)).arrayBuffer());
}

const SIMPLE_LIMIT = 4.5 * 1024 * 1024;

/** Creates the file (fileId null) or replaces its content. Google keeps earlier versions of the file. */
export async function upload(
  file: { fileId: string | null; name: string; folderId: string; appProperties: Record<string, string> },
  bytes: Uint8Array,
): Promise<DriveFile> {
  const meta = file.fileId ? { name: file.name } : { name: file.name, parents: [file.folderId], appProperties: file.appProperties, mimeType: "application/gzip" };
  const target = file.fileId ? `${UPLOAD}/files/${file.fileId}` : `${UPLOAD}/files`;
  const method = file.fileId ? "PATCH" : "POST";
  const fields = "fields=id,name,modifiedTime";
  if (bytes.length <= SIMPLE_LIMIT) {
    const boundary = `paragraf${crypto.randomUUID()}`;
    const body = new Blob([
      `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(meta)}\r\n--${boundary}\r\nContent-Type: application/gzip\r\n\r\n`,
      bytes as BlobPart,
      `\r\n--${boundary}--`,
    ]);
    const res = await call(`${target}?uploadType=multipart&${fields}`, { method, headers: { "Content-Type": `multipart/related; boundary=${boundary}` }, body });
    return (await res.json()) as DriveFile;
  }
  // Large (a whole textbook's text): resumable upload, the content in a second request.
  const init = await call(`${target}?uploadType=resumable&${fields}`, {
    method,
    headers: { "Content-Type": "application/json; charset=UTF-8", "X-Upload-Content-Type": "application/gzip", "X-Upload-Content-Length": String(bytes.length) },
    body: JSON.stringify(meta),
  });
  const session = init.headers.get("location");
  if (!session) throw new DriveError("Dysk Google nie przyjął przesyłania dużego pliku.", 0);
  const res = await call(session, { method: "PUT", headers: { "Content-Type": "application/gzip" }, body: bytes as BlobPart });
  return (await res.json()) as DriveFile;
}
