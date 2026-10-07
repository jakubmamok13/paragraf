import { useEffect, useState } from "react";
import { clientId, clientIdProblem, clientIdSource, createFolder, normalizeClientId, type DriveFile, driveConfig, forgetDrive, hasToken, listFolders, redirectUri, saveDriveConfig, signIn } from "../drive";
import { onSync, startSync, syncConfigured, type SyncState, syncNow, syncState } from "../sync";
import { Card, Field, useAction, useDb, useToast } from "../ui";

const GUIDE = "https://github.com/jakubmamok13/paragraf/blob/main/docs/DYSK-GOOGLE.md";

export function useSync(): SyncState {
  const [s, setS] = useState(syncState());
  useEffect(() => {
    setS(syncState()); // it may have changed between render and here
    return onSync(setS);
  }, []);
  return s;
}

/** Starts automatic synchronisation once the database is open. */
export function SyncStarter() {
  const { db, changed } = useDb();
  useEffect(() => void startSync(db, changed), [db, changed]);
  return null;
}

const time = (iso: string | null) =>
  iso ? new Date(iso).toLocaleString("pl-PL", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }) : "jeszcze nie";

/** Shown on "Dziś" only when synchronisation needs you. */
export function SyncBanner() {
  const s = useSync();
  if (!syncConfigured() || (s.status !== "needs-login" && s.status !== "error")) return null;
  return (
    <Card title="Dysk Google">
      {s.status === "needs-login" ? (
        <p className="small">Zaloguj się ponownie, żeby zsynchronizować fiszki i postęp z innymi urządzeniami. Na tym urządzeniu nic nie ginie.</p>
      ) : (
        <p className="small status-warn">Synchronizacja nie powiodła się: {s.error}</p>
      )}
      <button className="btn btn-secondary" onClick={() => void (s.status === "needs-login" ? signIn(true) : syncNow())}>
        {s.status === "needs-login" ? "Zaloguj do Dysku Google" : "Spróbuj ponownie"}
      </button>
    </Card>
  );
}

/** Settings → "Dysk Google": connect, choose the shared folder, see the devices. */
export function DriveCard() {
  const s = useSync();
  const act = useAction();
  const toast = useToast();
  const [, rerender] = useState(0);
  const cfg = driveConfig();
  const [folders, setFolders] = useState<DriveFile[] | null>(null);
  const [newFolder, setNewFolder] = useState("Paragraf");
  const update = (patch: Parameters<typeof saveDriveConfig>[0]) => {
    saveDriveConfig(patch);
    rerender((n) => n + 1);
  };
  const connected = hasToken();

  useEffect(() => {
    if (connected && !cfg.folderId && clientId()) listFolders().then(setFolders, (e: Error) => toast(e.message, "error"));
  }, [connected, cfg.folderId, toast]);

  const choose = (f: Pick<DriveFile, "id" | "name">) =>
    act(async () => {
      update({ folderId: f.id, folderName: f.name, seen: {}, ownFileId: null, dirty: true });
      await syncNow();
      const st = syncState();
      if (st.status === "error") throw new Error(st.error ?? "Synchronizacja nie powiodła się.");
    }, `Folder „${f.name}” połączony. Dane z innych urządzeń są wczytane, a kopia tego urządzenia jest już na Dysku.`);

  let body;
  if (!clientId()) {
    body = (
      <>
        <p className="muted small">
          Fiszki, postęp, pałace i ustawienia mogą same zapisywać się w folderze na Twoim Dysku Google, a inne urządzenie po wskazaniu tego samego
          folderu wczyta je i będzie dalej synchronizować. Potrzebny jest jednorazowo identyfikator klienta Google (ok. 5 minut,{" "}
          <a href={GUIDE} target="_blank" rel="noreferrer">
            instrukcja
          </a>
          ).
        </p>
        <ClientSetup onChange={() => rerender((n) => n + 1)} />
      </>
    );
  } else if (!cfg.folderId) {
    body = connected ? (
      <>
        <p className="muted small">
          Wybierz folder, którego używa Twoje inne urządzenie, albo utwórz nowy. Aplikacja widzi tylko foldery i pliki, które sama utworzyła, nie resztę
          Twojego Dysku. Folder możesz potem przenieść w dowolne miejsce na Dysku.
        </p>
        {folders === null && <p className="muted small">Szukam folderów…</p>}
        {folders?.length === 0 && <p className="muted small">Nie ma jeszcze folderu Paragrafu na Twoim Dysku.</p>}
        <ul className="list">
          {folders?.map((f) => (
            <li key={f.id} className="list-row">
              <span>📁 {f.name}</span>
              <button className="btn btn-primary btn-small" onClick={() => void choose(f)}>
                Użyj tego folderu
              </button>
            </li>
          ))}
        </ul>
        <div className="row-wrap">
          <input value={newFolder} onChange={(e) => setNewFolder(e.target.value)} aria-label="Nazwa nowego folderu" />
          <button
            className="btn btn-secondary"
            disabled={!newFolder.trim()}
            onClick={() =>
              void act(async () => {
                const f = await createFolder(newFolder.trim());
                await choose(f);
              })
            }
          >
            Utwórz folder
          </button>
        </div>
      </>
    ) : (
      <>
        <p className="muted small">
          Połącz konto Google. Aplikacja dostanie dostęp wyłącznie do plików, które sama utworzy (uprawnienie „drive.file”), i nie zobaczy reszty Dysku.
        </p>
        <button className="btn btn-primary" onClick={() => void act(() => signIn(true))}>
          Połącz z Dyskiem Google
        </button>
        <InvalidClientHint />
        <details>
          <summary className="small">Identyfikator klienta Google</summary>
          <ClientSetup onChange={() => rerender((n) => n + 1)} />
        </details>
      </>
    );
  } else {
    body = (
      <>
        <p className="small">
          Folder: <strong>📁 {cfg.folderName}</strong>
          {cfg.email && <span className="muted"> · {cfg.email}</span>}
        </p>
        <p className={`small ${s.status === "error" ? "status-warn" : "muted"}`} data-sync={`${s.status} ${cfg.lastSyncAt ?? ""}`}>
          {s.status === "syncing"
            ? "Synchronizuję…"
            : s.status === "error"
              ? `Błąd: ${s.error}`
              : s.status === "needs-login"
                ? "Trzeba zalogować się ponownie."
                : `Ostatnia synchronizacja: ${time(cfg.lastSyncAt)}${cfg.dirty ? " · są niewysłane zmiany" : ""}`}
        </p>
        {s.devices.length > 0 && (
          <ul className="list small">
            {s.devices.map((d) => (
              <li key={d.name + d.modifiedTime} className="list-row">
                <span>
                  {"🔄 "}
                  {d.name}
                  {d.own && <span className="muted"> (to urządzenie)</span>}
                </span>
                <span className="muted">{time(d.modifiedTime)}</span>
              </li>
            ))}
          </ul>
        )}
        <Field label="Nazwa tego urządzenia" hint="Tak będzie się nazywał jego plik w folderze.">
          <input
            defaultValue={cfg.deviceName}
            onBlur={(e) => {
              const v = e.target.value.trim();
              if (v && v !== cfg.deviceName) {
                update({ deviceName: v });
                void syncNow();
              }
            }}
          />
        </Field>
        <div className="row-wrap">
          <button className="btn btn-primary" disabled={s.status === "syncing"} onClick={() => void (s.status === "needs-login" || !connected ? signIn(true) : syncNow())}>
            {s.status === "needs-login" || !connected ? "Zaloguj i synchronizuj" : "Synchronizuj teraz"}
          </button>
          <button
            className="btn btn-ghost danger"
            onClick={() => {
              if (!confirm("Odłączyć to urządzenie od Dysku? Dane zostają i tutaj, i w folderze – synchronizacja po prostu przestanie działać.")) return;
              forgetDrive();
              rerender((n) => n + 1);
            }}
          >
            Odłącz
          </button>
        </div>
        <p className="muted small">
          Synchronizacja działa sama: przy otwarciu aplikacji, co kilka minut, po zmianach i przy wyjściu z aplikacji. Każde urządzenie zapisuje swój plik,
          a Dysk pamięta jego wcześniejsze wersje. Ustawienia lokalnego AI zostają na komputerze.
        </p>
        {s.status === "needs-login" && <InvalidClientHint />}
        <details>
          <summary className="small">Identyfikator klienta Google</summary>
          <ClientSetup onChange={() => rerender((n) => n + 1)} />
        </details>
      </>
    );
  }
  return <Card title="Dysk Google – kopia i synchronizacja">{body}</Card>;
}

/** Google's "Błąd 401: invalid_client" means it does not know the ID that was sent. */
function InvalidClientHint() {
  return (
    <p className="muted small">
      Google pokazuje „Błąd 401: invalid_client”? Google nie zna wysłanego identyfikatora. Porównaj go niżej z Google Cloud → Google Auth Platform →
      Klienci. Musi to być <strong>identyfikator klienta</strong>, nie sekret (sekret zaczyna się od „GOCSPX-”). Klient typu „Aplikacja internetowa”
      utworzony przed chwilą może zacząć działać dopiero po kilku minutach.
    </p>
  );
}

/** The OAuth client ID: shown, checked and changeable on the device (also when it comes with the published app). */
function ClientSetup({ onChange }: { onChange: () => void }) {
  const toast = useToast();
  const source = clientIdSource();
  const [value, setValue] = useState(driveConfig().clientId || clientId());
  const save = () => {
    const problem = clientIdProblem(value);
    if (problem) {
      toast(problem, "error");
      return;
    }
    const id = normalizeClientId(value);
    setValue(id);
    saveDriveConfig({ clientId: id, token: null, tokenExpires: 0 });
    toast(id ? "Zapisano identyfikator klienta." : "Usunięto identyfikator wpisany na tym urządzeniu.");
    onChange();
  };
  return (
    <>
      <Field label="Adres powrotu do wpisania w Google Cloud" hint="„Autoryzowane identyfikatory URI przekierowania” – dokładnie tak, z ukośnikiem na końcu.">
        <input readOnly value={redirectUri()} onFocus={(e) => e.target.select()} />
      </Field>
      <Field label="Źródło JavaScript do wpisania w Google Cloud" hint="„Autoryzowane źródła JavaScript” – bez ukośnika na końcu.">
        <input readOnly value={location.origin} onFocus={(e) => e.target.select()} />
      </Field>
      <Field
        label="Identyfikator klienta OAuth"
        hint={
          source === "build"
            ? "Wbudowany w opublikowaną aplikację (zmienna GOOGLE_CLIENT_ID). Wpisz inny, żeby go zastąpić na tym urządzeniu."
            : "Kończy się na .apps.googleusercontent.com. Wklej z Google Cloud → Klienci."
        }
      >
        <input value={value} placeholder="1234567890-abc123.apps.googleusercontent.com" onChange={(e) => setValue(e.target.value)} spellCheck={false} autoCapitalize="off" autoCorrect="off" />
      </Field>
      <button className="btn btn-secondary btn-small" onClick={save}>
        Zapisz identyfikator
      </button>
    </>
  );
}
