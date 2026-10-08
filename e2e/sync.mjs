// Browser test of Google Drive synchronisation between two devices. Google's
// sign-in page and the Drive API are stood in for by request interception:
// an in-memory Drive shared by a "laptop" and a "phone".
//   npm run build && node e2e/sync.mjs
import { spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { chromium, devices } from "playwright-core";

const root = fileURLToPath(new URL("..", import.meta.url));
const out = process.argv[2] ?? root + "e2e/out";
mkdirSync(out, { recursive: true });
const base = "http://localhost:4173/";
const server = spawn("npx", ["vite", "preview", "--port", "4173", "--strictPort"], { cwd: root + "apps/web", stdio: "ignore" });
process.on("exit", () => server.kill());
for (let i = 0; i < 60; i++) {
  try {
    if ((await fetch(base)).ok) break;
  } catch {}
  await new Promise((r) => setTimeout(r, 500));
}
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH ?? "/opt/pw-browsers/chromium-1194/chrome-linux/chrome" });
const errors = [];
const watch = (page, who) => {
  page.on("pageerror", (e) => errors.push(`${who}: ${e}`));
  page.on("console", (m) => m.type() === "error" && !/401|Failed to load resource/.test(m.text()) && errors.push(`${who}: ${m.text()}`));
  page.on("dialog", (d) => d.accept());
};
const step = (s) => console.log("•", s);
const check = (ok, what) => {
  if (!ok) throw new Error("FAILED: " + what);
};

// ---------- a tiny Google Drive ----------
const CLIENT_ID = "123-test.apps.googleusercontent.com";
const files = new Map(); // id → { id, name, mimeType, parents, modifiedTime, appProperties, data }
let seq = 0;
const tokens = new Map(); // token → device
const consent = new Set(); // devices that agreed
const authLog = [];
let brokenClient = false; // Google answers with its own error page (invalid_client)
let clock = Date.parse("2026-10-07T08:00:00Z");
const stamp = () => new Date((clock += 1000)).toISOString();
const cors = {
  "access-control-allow-origin": "*",
  "access-control-allow-headers": "authorization, content-type, x-upload-content-type, x-upload-content-length",
  "access-control-allow-methods": "GET, POST, PATCH, PUT, OPTIONS",
  "access-control-expose-headers": "location",
};
const meta = (f) => ({ id: f.id, name: f.name, mimeType: f.mimeType, modifiedTime: f.modifiedTime, appProperties: f.appProperties, size: String(f.data?.length ?? 0), trashed: false });
const json = (route, body, status = 200) => route.fulfill({ status, headers: cors, contentType: "application/json", body: JSON.stringify(body) });

function parseMultipart(buf, contentType) {
  const boundary = Buffer.from("--" + /boundary=(.+)$/.exec(contentType)[1]);
  const parts = [];
  let i = buf.indexOf(boundary);
  while (i >= 0) {
    const next = buf.indexOf(boundary, i + boundary.length);
    if (next < 0) break;
    const part = buf.subarray(i + boundary.length + 2, next - 2);
    const sep = part.indexOf("\r\n\r\n");
    parts.push(part.subarray(sep + 4));
    i = next;
  }
  return { metadata: JSON.parse(parts[0].toString("utf8")), data: Buffer.from(parts[1]) };
}

async function mockGoogle(context, device) {
  await context.route("https://accounts.google.com/**", (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === "/generate_204") return route.fulfill({ status: 204, headers: cors });
    const p = url.searchParams;
    authLog.push({ device, prompt: p.get("prompt"), clientId: p.get("client_id") });
    if (brokenClient) return route.fulfill({ status: 401, contentType: "text/html", body: "<h1>Błąd 401: invalid_client</h1>" });
    let fragment;
    if (p.get("prompt") !== "none") consent.add(device);
    if (consent.has(device)) {
      const token = `tok-${device}-${++seq}`;
      tokens.set(token, device);
      fragment = `access_token=${token}&expires_in=3599&token_type=Bearer&scope=${encodeURIComponent(p.get("scope"))}&state=${p.get("state")}`;
    } else {
      fragment = `error=interaction_required&state=${p.get("state")}`;
    }
    return route.fulfill({ status: 302, headers: { location: `${p.get("redirect_uri")}#${fragment}` } });
  });
  for (const host of ["https://www.googleapis.com/drive/**", "https://www.googleapis.com/upload/**"]) {
    await context.route(host, async (route) => {
      const req = route.request();
      if (req.method() === "OPTIONS") return route.fulfill({ status: 204, headers: cors });
      const auth = (await req.headerValue("authorization")) ?? "";
      if (!tokens.has(auth.replace("Bearer ", ""))) return json(route, { error: { message: "Invalid Credentials" } }, 401);
      const url = new URL(req.url());
      const path = url.pathname.replace(/^\/(upload\/)?drive\/v3/, "");
      if (path === "/about") return json(route, { user: { emailAddress: "student@example.com" } });
      if (path === "/files" && req.method() === "GET") {
        const q = url.searchParams.get("q");
        const parent = /'([^']+)' in parents/.exec(q)?.[1];
        const list = [...files.values()].filter((f) => (parent ? f.parents?.includes(parent) : f.mimeType === "application/vnd.google-apps.folder"));
        return json(route, { files: list.map(meta) });
      }
      if (path === "/files" && req.method() === "POST" && !url.searchParams.get("uploadType")) {
        const body = JSON.parse(req.postData());
        const f = { id: `f${++seq}`, ...body, modifiedTime: stamp() };
        files.set(f.id, f);
        return json(route, meta(f));
      }
      if (url.searchParams.get("uploadType") === "multipart") {
        const { metadata, data } = parseMultipart(req.postDataBuffer(), await req.headerValue("content-type"));
        const id = path.split("/")[2];
        const f = id ? files.get(id) : { id: `f${++seq}` };
        if (!f) return json(route, { error: { message: "File not found" } }, 404);
        Object.assign(f, metadata, { data, modifiedTime: stamp() });
        files.set(f.id, f);
        return json(route, meta(f));
      }
      const id = path.split("/")[2];
      const f = files.get(id);
      if (!f) return json(route, { error: { message: "File not found" } }, 404);
      if (url.searchParams.get("alt") === "media") return route.fulfill({ status: 200, headers: cors, contentType: "application/gzip", body: f.data });
      return json(route, meta(f));
    });
  }
}
const syncFiles = () => [...files.values()].filter((f) => f.name.startsWith("paragraf-sync-"));

async function connect(page) {
  await page.getByRole("button", { name: "Ustawienia" }).click();
  // A secret instead of the ID is refused; an ID pasted with a label and a line break is cleaned up.
  await page.getByLabel("Identyfikator klienta OAuth").fill("GOCSPX-abcdef");
  await page.getByRole("button", { name: "Zapisz identyfikator" }).click();
  await page.getByText(/To jest sekret klienta/).waitFor();
  await page.getByLabel("Identyfikator klienta OAuth").fill(`  Client ID: ${CLIENT_ID}\n`);
  await page.getByRole("button", { name: "Zapisz identyfikator" }).click();
  await page.getByRole("button", { name: "Połącz z Dyskiem Google" }).click();
  await page.waitForURL(base);
  await page.getByRole("button", { name: "Ustawienia" }).click();
}
/** Waits for a sync that finished after `since` (the status line carries its time). */
const waitSynced = async (page, since = "") => {
  await page.getByText(/Ostatnia synchronizacja: \d/).waitFor({ timeout: 10000 });
  await page.waitForFunction((t) => {
    const [status, at] = (document.querySelector("[data-sync]")?.getAttribute("data-sync") ?? "").split(" ");
    return status === "idle" && at > t;
  }, since, { timeout: 10000 });
};

// ================= LAPTOP: has data, creates the folder =================
const laptop = await browser.newContext({ viewport: { width: 1200, height: 900 } });
await mockGoogle(laptop, "laptop");
const L = await laptop.newPage();
watch(L, "laptop");
await L.goto(base);
await L.getByRole("button", { name: "Przedmioty" }).click();
await L.getByRole("button", { name: "+ Dodaj" }).click();
await L.getByPlaceholder("np. Prawo cywilne – część ogólna").fill("Prawo cywilne");
await L.getByRole("button", { name: "Zapisz" }).click();
await L.getByRole("button", { name: "Edytuj" }).click();
await L.getByRole("button", { name: "+ Dodaj własną fiszkę" }).click();
await L.getByLabel("Zagadnienie").fill("Zasiedzenie");
await L.getByLabel("Pytanie").fill("Ile lat trwa zasiedzenie nieruchomości w dobrej wierze?");
await L.getByLabel("Odpowiedź").fill("20 lat");
await L.getByRole("button", { name: "Zapisz", exact: true }).click();
await L.screenshot({ path: out + "/S0-laptop-card.png", fullPage: true });
step("laptop: subject and a card");

await connect(L);
check(authLog.at(-1).prompt === "select_account" && authLog.at(-1).clientId === CLIENT_ID, "interactive sign-in with the client id");
await L.getByText("Nie ma jeszcze folderu Paragrafu").waitFor();
await L.getByRole("button", { name: "Utwórz folder" }).click();
await waitSynced(L);
check(syncFiles().length === 1 && /^paragraf-sync-komputer-/.test(syncFiles()[0].name), "laptop file in the folder: " + syncFiles().map((f) => f.name));
await L.screenshot({ path: out + "/S1-laptop-settings.png", fullPage: true });
step("laptop: folder created, own file uploaded: " + syncFiles()[0].name);

// ================= PHONE: points at the same folder =================
const phone = await browser.newContext({ ...devices["iPhone 13"], defaultBrowserType: undefined });
await mockGoogle(phone, "phone");
const P = await phone.newPage();
watch(P, "phone");
await P.goto(base);
await connect(P);
await P.getByRole("button", { name: "Użyj tego folderu" }).click();
await waitSynced(P);
check(syncFiles().length === 2, "phone file added");
if (process.env.DEBUG_SYNC) {
  const { gunzipSync } = await import("node:zlib");
  for (const f of syncFiles()) {
    const pkg = JSON.parse(gunzipSync(f.data).toString());
    console.log(f.name, pkg.kind, Object.fromEntries(Object.entries(pkg.tables).map(([k, v]) => [k, v.length]).filter(([, n]) => n)));
  }
}
await P.screenshot({ path: out + "/S2-phone-settings.png", fullPage: true });
await P.getByRole("button", { name: "Przedmioty" }).click();
await P.getByText("Prawo cywilne").waitFor();
await P.getByRole("button", { name: "Dziś" }).click();
check(!(await P.getByRole("button", { name: "Zacznij" }).isDisabled()), "phone has a session to start");
step("phone: folder chosen, the laptop's subject and card are here");

// The phone learns and changes a setting; the change goes up by itself.
await P.getByRole("button", { name: "Zacznij" }).click();
for (let i = 0; i < 8 && !(await P.getByRole("button", { name: "Gotowe" }).count()); i++) {
  await P.getByRole("button", { name: "Pewnie" }).click();
  await P.locator(".btn-rate").last().click();
}
await P.getByRole("button", { name: "Gotowe" }).click();
await P.getByRole("button", { name: "Ustawienia" }).click();
await P.getByLabel("Minuty dziennie").fill("35");
await P.getByLabel("Minuty dziennie").blur();
// Leaving the app with unsent changes uploads them right away.
const before = syncFiles().find((f) => f.name.includes("telefon")).modifiedTime;
await P.evaluate(() => {
  Object.defineProperty(document, "visibilityState", { value: "hidden", configurable: true });
  document.dispatchEvent(new Event("visibilitychange"));
});
for (let i = 0; i < 50 && syncFiles().find((f) => f.name.includes("telefon")).modifiedTime === before; i++) await P.waitForTimeout(100);
check(syncFiles().find((f) => f.name.includes("telefon")).modifiedTime !== before, "phone uploaded when leaving the screen");
step("phone: answered a card, set 35 min; uploaded on leaving the app");

// ================= LAPTOP opens the app again =================
const t0 = new Date().toISOString();
await L.reload();
await L.getByRole("button", { name: "Ustawienia" }).click();
await waitSynced(L, t0);
check((await L.getByLabel("Minuty dziennie").inputValue()) === "35", "setting from the phone");
await L.getByRole("button", { name: "Postęp", exact: true }).click();
await L.getByText("Opanowane materiały: 1 z 1").waitFor();
await L.screenshot({ path: out + "/S3-laptop-progress.png", fullPage: true });
await L.getByRole("button", { name: "Ustawienia" }).click();
check((await L.locator(".list-row", { hasText: "telefon" }).count()) === 1, "phone listed among devices");
step("laptop: the phone's answer and setting arrived, both devices listed");

// ================= an hour later: silent renewal =================
await L.evaluate(() => {
  const c = JSON.parse(localStorage.getItem("paragraf.drive"));
  localStorage.setItem("paragraf.drive", JSON.stringify({ ...c, tokenExpires: 0, silentAt: 0 }));
});
const n = authLog.length;
const t1 = new Date().toISOString();
await L.reload();
await L.getByRole("button", { name: "Ustawienia" }).click();
await waitSynced(L, t1);
check(authLog.length === n + 1 && authLog.at(-1).prompt === "none", "silent renewal: " + JSON.stringify(authLog.slice(n)));
step("laptop: expired sign-in renewed silently on opening");

// ================= signed out of Google: the phone asks =================
consent.delete("phone");
await P.evaluate(() => {
  const c = JSON.parse(localStorage.getItem("paragraf.drive"));
  localStorage.setItem("paragraf.drive", JSON.stringify({ ...c, tokenExpires: 0, silentAt: 0 }));
});
await P.reload();
await P.getByRole("button", { name: "Zaloguj do Dysku Google" }).waitFor();
await P.screenshot({ path: out + "/S4-phone-login-banner.png", fullPage: true });
await P.getByRole("button", { name: "Zaloguj do Dysku Google" }).click();
await P.waitForURL(base);
await P.getByRole("button", { name: "Ustawienia" }).click();
await waitSynced(P);
step("phone: banner when Google wants a click; after it, synced again");

// ================= Google refuses the client: no redirect loop =================
brokenClient = true;
await L.evaluate(() => {
  const c = JSON.parse(localStorage.getItem("paragraf.drive"));
  localStorage.setItem("paragraf.drive", JSON.stringify({ ...c, tokenExpires: 0, silentAt: 0 }));
});
await L.reload();
await L.getByText("invalid_client").waitFor(); // stuck on Google's page, as on a real phone
await L.goto(base); // you come back to the app
await L.getByRole("button", { name: "Zaloguj do Dysku Google" }).waitFor();
await L.getByRole("button", { name: "Ustawienia" }).click();
await L.getByText(/Google pokazuje „Błąd 401: invalid_client”/).waitFor();
await L.getByText("Identyfikator klienta Google").click();
check((await L.getByLabel("Identyfikator klienta OAuth").inputValue()) === CLIENT_ID, "client ID shown and stored without the label");
await L.screenshot({ path: out + "/S5-invalid-client.png", fullPage: true });
step("invalid client: Google's error page once, then a login button and the ID to check, no loop");

await browser.close();
if (errors.length) {
  console.log("Console errors:\n" + errors.join("\n"));
  process.exit(1);
}
console.log("SYNC E2E OK");
process.exit(0);
