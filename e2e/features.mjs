// Browser test of the features added after the MVP: official online sources
// (ISAP, OpenAlex – their servers are stood in for by request interception),
// the short lesson with the topic map, and the memory palace course.
//   npm run build && node e2e/features.mjs
import { spawn } from "node:child_process";
import { mkdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";

const root = fileURLToPath(new URL("..", import.meta.url));
const out = process.argv[2] ?? root + "e2e/out";
mkdirSync(out, { recursive: true });
const FX = root + "packages/core/test/fixtures";
const base = "http://localhost:4173/";
const servers = [
  spawn("npx", ["tsx", "packages/core/test/fake-ollama-server.ts", "http://localhost:4173"], { cwd: root, stdio: "ignore" }),
  spawn("npx", ["vite", "preview", "--port", "4173", "--strictPort"], { cwd: root + "apps/web", stdio: "ignore" }),
];
const stopServers = () => servers.forEach((p) => p.kill());
process.on("exit", stopServers);
for (let i = 0; i < 60; i++) {
  try {
    const [a, b] = await Promise.all([fetch(base), fetch("http://127.0.0.1:11434/api/tags")]);
    if (a.ok && b.ok) break;
  } catch {}
  await new Promise((r) => setTimeout(r, 500));
}
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH ?? "/opt/pw-browsers/chromium-1194/chrome-linux/chrome" });
const errors = [];
const watch = (page, who) => {
  page.on("pageerror", (e) => errors.push(`${who}: ${e}`));
  page.on("console", (m) => m.type() === "error" && errors.push(`${who}: ${m.text()}`));
  page.on("dialog", (d) => d.accept());
};
const step = (s) => console.log("•", s);
/** Marks every list item as recalled; the button disappears when the list ends. */
const yesToAll = async (page) => {
  for (;;) {
    const b = page.getByRole("button", { name: "✓ Tak" });
    if (!(await b.count())) return;
    await b.click({ timeout: 2000 }).catch(() => {});
    await page.waitForTimeout(80);
  }
};
const upload = async (page, trigger, file) => {
  const [fc] = await Promise.all([page.waitForEvent("filechooser"), trigger()]);
  await fc.setFiles(file);
};

// Stand-ins for the public APIs (CORS headers as a browser needs them).
const cors = { "access-control-allow-origin": "*" };
async function mockInternet(context, log) {
  await context.route("https://api.sejm.gov.pl/**", (route) => {
    const url = route.request().url();
    log.push(url);
    if (url.includes("/eli/acts/search")) {
      return route.fulfill({
        headers: cors,
        contentType: "application/json",
        body: JSON.stringify({
          items: [{ ELI: "DU/2025/1071", title: "Obwieszczenie Marszałka Sejmu w sprawie ogłoszenia jednolitego tekstu ustawy - Kodeks cywilny", type: "Obwieszczenie", announcementDate: "2025-08-01", textHTML: true, displayAddress: "Dz.U. 2025 poz. 1071" }],
        }),
      });
    }
    return route.fulfill({ headers: cors, contentType: "text/html", body: readFileSync(FX + "/isap-kodeks-cywilny.html", "utf8") });
  });
  await context.route("https://api.openalex.org/**", (route) => {
    log.push(route.request().url());
    return route.fulfill({
      headers: cors,
      contentType: "application/json",
      body: JSON.stringify({
        results: [
          {
            id: "https://openalex.org/W2",
            display_name: "Przedawnienie roszczeń po nowelizacji z 2018 r.",
            publication_year: 2020,
            doi: "https://doi.org/10.1/pl",
            language: "pl",
            authorships: [{ author: { display_name: "A. Kowalska" } }],
            abstract_inverted_index: Object.fromEntries(
              "Nowelizacja skróciła ogólny termin przedawnienia do sześciu lat, a celem zmiany było dyscyplinowanie wierzycieli i stabilizacja obrotu".split(" ").map((w, i) => [w, [i]]),
            ),
          },
        ],
      }),
    });
  });
}

// ================= LAPTOP =================
const laptop = await browser.newContext({ viewport: { width: 1200, height: 900 }, acceptDownloads: true });
const netLog = [];
await mockInternet(laptop, netLog);
const L = await laptop.newPage();
watch(L, "laptop");
await L.goto(base);
await L.getByRole("button", { name: "Przedmioty" }).click();
await L.getByRole("button", { name: "+ Dodaj" }).click();
await L.getByPlaceholder("np. Prawo cywilne – część ogólna").fill("Prawo cywilne");
await L.getByRole("button", { name: "Zapisz" }).click();
await L.getByRole("button", { name: "Pracownia" }).click();
await L.getByText("Połączono. Wybierz model z listy.").waitFor({ timeout: 10000 });
await L.getByLabel("Model").selectOption("bielik-11b:fake");
await upload(L, () => L.getByRole("button", { name: "Wybierz pliki" }).click(), FX + "/wyklad-2026-10-06.md");
await L.waitForFunction(() => document.body.innerText.includes("do zatwierdzenia"), null, { timeout: 60000 });
await L.waitForTimeout(2500);
await L.locator(".todo", { hasText: "do zatwierdzenia" }).click();
await L.locator(".coverage").first().waitFor();
await L.screenshot({ path: `${out}/F1-review-coverage.png`, fullPage: true });
await L.getByRole("button", { name: /Zatwierdź wszystkie/ }).click();
await L.getByRole("button", { name: "← Wróć" }).click();
step("note processed and approved; topic coverage shown");

// Online sources: off until enabled; ISAP fills the articles the note cites.
await L.getByRole("button", { name: "Uzupełnij braki" }).click();
await L.getByText("Ta funkcja jest wyłączona.").waitFor();
console.log("  requests before enabling:", netLog.length);
await L.getByRole("button", { name: "Włącz" }).click();
await L.getByText(/k\.c\.: art\. 117, 118, 172, 174/).waitFor();
await L.getByRole("button", { name: /Szukaj tekstu jednolitego/ }).click();
await L.getByText("Dz.U. 2025 poz. 1071", { exact: false }).waitFor();
await L.getByRole("button", { name: "Pobierz wybrane artykuły" }).click();
await L.getByText(/Pobrano art\. 117, 118, 172; nie znaleziono: 174/).waitFor();
await L.getByPlaceholder("np. przedawnienie roszczeń nowelizacja 2018").fill("przedawnienie roszczeń nowelizacja 2018");
await L.getByRole("button", { name: "Szukaj w OpenAlex" }).click();
await L.getByText("Przedawnienie roszczeń po nowelizacji z 2018 r.").waitFor();
await L.screenshot({ path: `${out}/F2-external.png`, fullPage: true });
await L.getByRole("button", { name: "Dodaj jako źródło" }).click();
await L.getByText("Dodano publikację jako źródło.").waitFor();
step(`ISAP articles and an OpenAlex abstract imported (${netLog.length} requests, all to stand-ins)`);
await L.getByRole("button", { name: "← Wróć" }).click();
await L.waitForFunction(() => !document.body.innerText.includes("w toku"), null, { timeout: 60000 });
const docs = await L.locator(".doc").allInnerTexts();
console.log("  sources:", docs.map((d) => d.split("\n")[0]).join(" | "));

const [dl] = await Promise.all([L.waitForEvent("download"), L.getByRole("button", { name: "Wyślij treść na telefon" }).click()]);
const pkg = `${out}/${dl.suggestedFilename()}`;
await dl.saveAs(pkg);

// ================= PHONE =================
const phone = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, hasTouch: true, isMobile: true });
const P = await phone.newPage();
watch(P, "phone");
await P.goto(base);
await P.getByRole("button", { name: "Ustawienia" }).click();
await upload(P, () => P.getByRole("button", { name: "Wczytaj paczkę" }).click(), pkg);
await P.getByText(/Wczytano paczkę/).waitFor();
await P.getByRole("button", { name: "Dziś" }).click();
await P.getByText("Nowe zagadnienia").waitFor();
await P.screenshot({ path: `${out}/F3-today.png`, fullPage: true });

// The short lesson.
await P.locator(".list-row", { hasText: "Zasiedzenie nieruchomości" }).getByRole("button", { name: "Lekcja" }).click();
await P.getByText(/Pytanie wstępne 1 z 2/).waitFor();
await P.screenshot({ path: `${out}/F4-prequestion.png` });
for (let i = 0; i < 2; i++) {
  await P.getByRole("button", { name: "Pokaż odpowiedź" }).click();
  await P.getByRole("button", { name: "Dalej", exact: true }).click();
}
await P.locator(".lesson-part").waitFor();
await P.screenshot({ path: `${out}/F5-lesson-part.png` });
let parts = 0;
while (await P.getByRole("button", { name: /^Dalej \(/ }).count()) {
  parts++;
  await P.getByRole("button", { name: /^Dalej \(/ }).click();
}
await P.getByRole("button", { name: "Sprawdź się" }).click();
await P.locator(".topic-map").first().waitFor();
await P.screenshot({ path: `${out}/F6-session-map.png` });
await P.getByRole("button", { name: "Pewnie" }).click();
await yesToAll(P);
await P.getByRole("button", { name: "Całe zagadnienie" }).click();
await P.locator(".sheet").waitFor();
await P.screenshot({ path: `${out}/F7-topic-sheet.png` });
await P.getByLabel("Zamknij").click();
let answered = 0;
for (; answered < 30; answered++) {
  if (await P.getByText(/Sesja zakończona|Limit czasu/).count()) break;
  if (answered > 0) {
    await P.getByRole("button", { name: "Pewnie" }).click();
    await yesToAll(P);
  }
  await P.locator(".btn-rate").nth(3).click();
  await P.waitForTimeout(100);
}
step(`lesson: 2 pre-questions, ${parts + 1} parts, then ${answered} cards with the topic map`);
await P.getByRole("button", { name: "Gotowe" }).click();

// The memory palace course: stages 1–5.
await P.getByRole("button", { name: "Pałac" }).click();
await P.screenshot({ path: `${out}/F8-palace.png`, fullPage: true });
await P.getByRole("button", { name: /Etap 1:/ }).click();
for (let q = 0; q < 3; q++) await P.locator(`input[name="q${q}"]`).nth(1).check();
await P.getByRole("button", { name: "Sprawdź" }).click();
await P.getByText("3 z 3 poprawnie").waitFor();
await P.getByRole("button", { name: "Dalej" }).click();
await P.getByRole("button", { name: /Etap 2:/ }).click();
await P.getByRole("button", { name: "Zbuduj pałac" }).click();
const route = ["drzwi wejściowe", "wieszak", "lustro", "szafka na buty", "kuchenka", "lodówka", "zlew", "okno", "kanapa", "telewizor"];
await P.locator("textarea").fill(route.join("\n"));
await P.getByRole("button", { name: "Zapisz" }).click();
await P.getByRole("button", { name: /Etap 3:/ }).click();
for (const dir of ["W przód", "W przód", "Wstecz"]) {
  await P.getByRole("button", { name: dir, exact: true }).click();
  for (let i = 0; i < route.length; i++) {
    await P.getByRole("button", { name: "Pokaż", exact: true }).click();
    await P.getByRole("button", { name: "✓ Pamiętałem" }).click();
  }
  await P.getByText(/10 z 10 miejsc/).waitFor();
  await P.getByRole("button", { name: "Jeszcze raz" }).click();
}
await P.getByRole("button", { name: "← Kurs" }).click();
await P.getByRole("button", { name: /Etap 4:/ }).click();
for (let i = 0; i < 5; i++) {
  await P.getByPlaceholder(/Opisz scenę/).fill("Ogromny przedmiot z hukiem wbija się w to miejsce, pachnie i brzęczy");
  for (const box of await P.locator(".card input[type=checkbox]").all()) await box.check();
  await P.getByRole("button", { name: "Zapisz obraz" }).click();
}
await P.getByRole("button", { name: "← Kurs" }).click();
await P.getByRole("button", { name: /Etap 5:/ }).click();
await P.getByRole("button", { name: "Zaczynam" }).click();
const words = [];
for (let i = 0; i < 10; i++) {
  words.push((await P.locator(".card-text strong").innerText()).trim());
  await P.getByRole("button", { name: /^(Dalej|Gotowe)/ }).click();
}
await P.getByText("Przerwa: 30 sekund liczenia").waitFor();
await P.screenshot({ path: `${out}/F9-palace-pause.png` });
await P.getByRole("button", { name: "Przejdź trasę" }).click({ timeout: 40000 });
const inputs = P.locator(".card input");
for (let i = 0; i < 10; i++) await inputs.nth(i).fill(i === 3 ? words[i].normalize("NFD").replace(/[̀-ͯ]/g, "") : words[i]);
await P.getByRole("button", { name: "Sprawdź" }).click();
await P.getByText("Wynik: 10 z 10").waitFor();
await P.screenshot({ path: `${out}/F10-palace-result.png`, fullPage: true });
await P.getByRole("button", { name: "← Kurs" }).click();
const stages = await P.locator(".stage").allInnerTexts();
step(`palace course: ${stages.filter((s) => s.startsWith("✓")).length} stages passed`);
await P.screenshot({ path: `${out}/F11-palace-progress.png`, fullPage: true });

console.log("errors:", errors);
await browser.close();
stopServers();
if (errors.length) process.exit(1);
console.log("FEATURES E2E OK");
