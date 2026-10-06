// Full browser test of the MVP, two devices: the laptop (subject, three
// sources, local AI, conflict, approval, model comparison, package) and the
// phone (package, test after the lecture, flag, progress, package back).
// Starts the stand-in Ollama and the built app itself:
//   npm run build && npm run e2e
// Chromium: CHROMIUM_PATH, default /opt/pw-browsers/chromium-1194/chrome-linux/chrome.
import { spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
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
  page.on("pageerror", (e) => errors.push(who + ": " + String(e)));
  page.on("console", (m) => m.type() === "error" && errors.push(who + ": " + m.text()));
  page.on("dialog", (d) => d.accept());
};
const step = (s) => console.log("•", s);
const upload = async (page, trigger, file) => {
  const [fc] = await Promise.all([page.waitForEvent("filechooser"), trigger()]);
  await fc.setFiles(file);
};

// ================= LAPTOP =================
const laptop = await browser.newContext({ viewport: { width: 1200, height: 900 }, acceptDownloads: true });
const L = await laptop.newPage();
watch(L, "laptop");
await L.goto(base);
await L.getByRole("button", { name: "Przedmioty" }).click();
await L.getByRole("button", { name: "+ Dodaj" }).click();
await L.getByPlaceholder("np. Prawo cywilne – część ogólna").fill("Prawo cywilne – część ogólna");
await L.locator('input[type="date"]').first().fill("2027-02-10");
await L.getByRole("button", { name: "Zapisz" }).click();
step("subject added");

await L.getByRole("button", { name: "Pracownia" }).click();
await L.getByText("Połączono. Wybierz model z listy.").waitFor({ timeout: 10000 });
await L.getByLabel("Model").selectOption("bielik-11b:fake");
await L.getByText("Połączono. Model gotowy.").waitFor();
step("AI connected");

const importAs = async (kind, file) => {
  await L.getByLabel("Rodzaj").selectOption({ label: kind });
  await upload(L, () => L.getByRole("button", { name: "Wybierz pliki" }).click(), FX + "/" + file);
  await L.getByText(new RegExp("„" + file.replace(".", "\\.") + "”")).first().waitFor({ timeout: 20000 });
};
await importAs("Lista zagadnień egzaminacyjnych", "zagadnienia.txt");
await importAs("Notatka z wykładu", "wyklad.docx");
await importAs("Podręcznik", "podrecznik-2015.pdf");
step("3 files imported");
await L.screenshot({ path: out + "/L1-processing.png", fullPage: true });

// Wait until the queue is empty: the processing card disappears.
await L.waitForFunction(() => !document.body.innerText.includes("Przetwarzanie\n") && document.body.innerText.includes("do zatwierdzenia"), null, { timeout: 120000 });
await L.waitForTimeout(1500);
await L.screenshot({ path: out + "/L2-todo.png", fullPage: true });
step("processed: " + (await L.locator(".todo").allInnerTexts()).map((t) => t.replace(/\n/g, " ")).join(" | "));

// Conflict: 6 (lecture) vs 10 years (old textbook).
await L.locator(".todo", { hasText: "sprzeczności" }).click();
await L.getByText("Przedawnienie roszczeń · termin").waitFor();
await L.screenshot({ path: out + "/L3-conflict.png", fullPage: true });
await L.locator(".version.hinted").getByRole("button", { name: "Ta wersja jest właściwa" }).click();
await L.getByRole("button", { name: "← Wróć" }).click();
await L.waitForTimeout(3000);
step("conflict resolved");

// Review queue: open a source, then approve all.
await L.locator(".todo", { hasText: "do zatwierdzenia" }).click();
await L.locator(".citation").first().click();
await L.locator(".modal mark").waitFor();
await L.screenshot({ path: out + "/L4-source.png" });
await L.getByLabel("Zamknij").click();
await L.screenshot({ path: out + "/L5-review.png", fullPage: true });
const reviewText = await L.locator(".screen").innerText();
console.log("  review has 999:", reviewText.includes("999"), "| Omów:", /Omów/.test(reviewText), "| 10 lat:", reviewText.includes("10 lat"), "| 6 lat:", reviewText.includes("6 lat"));
await L.getByRole("button", { name: /Zatwierdź wszystkie/ }).click();
await L.getByText("Wszystko przejrzane.").waitFor();
await L.getByRole("button", { name: "← Wróć" }).click();
step("approved all");

await L.locator(".todo", { hasText: "sugestie" }).click();
await L.screenshot({ path: out + "/L6-suggestions.png", fullPage: true });
await L.getByRole("button", { name: "← Wróć" }).click();

// Model comparison.
await L.getByText("Porównaj modele na swojej notatce").click();
await L.locator(".checks input").nth(0).check();
await L.locator(".checks input").nth(1).check();
await L.getByRole("button", { name: "Porównaj", exact: true }).click();
await L.locator(".table").waitFor({ timeout: 30000 });
await L.locator(".bench").screenshot({ path: out + "/L7-bench.png" });
step("models compared: " + (await L.locator(".table tbody tr").allInnerTexts()).map((t) => t.replace(/\t/g, " ")).join(" | "));

const [dl] = await Promise.all([L.waitForEvent("download"), L.getByRole("button", { name: "Wyślij treść na telefon" }).click()]);
const pkgPath = out + "/" + dl.suggestedFilename();
await dl.saveAs(pkgPath);
step("content package: " + dl.suggestedFilename());

// ================= PHONE =================
const phone = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, hasTouch: true, isMobile: true });
const P = await phone.newPage();
watch(P, "phone");
await P.goto(base);
await P.getByRole("button", { name: "Ustawienia" }).click();
await upload(P, () => P.getByRole("button", { name: "Wczytaj paczkę" }).click(), pkgPath);
await P.getByText(/Wczytano paczkę \(treść\)/).waitFor();
await P.getByRole("button", { name: "Dziś" }).click();
await P.getByText("Po wykładzie").waitFor();
await P.screenshot({ path: out + "/P1-today.png", fullPage: true });
step("phone: package loaded, after-lecture card shown");

await P.getByRole("button", { name: "Krótki test (do 10 min)" }).click();
let n = 0, flagged = false;
for (; n < 40; n++) {
  if (await P.getByText(/Sesja zakończona|Limit czasu/).count()) break;
  const meta = await P.locator(".session-meta").innerText();
  if (n === 0) await P.screenshot({ path: out + "/P2-question.png" });
  await P.getByRole("button", { name: ["Pewnie", "Chyba wiem", "Zgaduję"][n % 3] }).click();
  if (meta.includes("Wyliczenie")) {
    while (await P.getByRole("button", { name: "✓ Tak" }).count()) await P.getByRole("button", { name: "✓ Tak" }).click();
  }
  await P.locator(".btn-rate").first().waitFor();
  if (n === 1) {
    await P.getByRole("button", { name: "Pokaż źródło" }).click();
    await P.screenshot({ path: out + "/P3-answer-source.png" });
  }
  if (n === 2 && !flagged) {
    await P.getByRole("button", { name: "⚑ Zgłoś błąd" }).click();
    flagged = true;
    continue;
  }
  await P.locator(".btn-rate").nth(n % 5 === 0 ? 0 : 2).click();
}
await P.screenshot({ path: out + "/P4-summary.png" });
step("after-lecture session: " + n + " steps, summary: " + (await P.locator(".session-body").innerText()).split("\n").slice(0, 2).join(" "));
await P.getByRole("button", { name: "Gotowe" }).click();

await P.getByRole("button", { name: "Postęp" }).click();
await P.getByRole("button", { name: "Działy i zagadnienia" }).click();
await P.screenshot({ path: out + "/P5-progress.png", fullPage: true });
step("progress: " + (await P.locator(".tile").allInnerTexts()).map((t) => t.replace(/\n/g, " ")).join(" | "));

await P.getByRole("button", { name: "Ustawienia" }).click();
const [dl2] = await Promise.all([P.waitForEvent("download"), P.getByRole("button", { name: "Wyślij postęp na komputer" }).click()]);
const progPath = out + "/" + dl2.suggestedFilename();
await dl2.saveAs(progPath);

// ================= back on the LAPTOP =================
await L.reload();
await L.getByRole("button", { name: "Pracownia" }).click();
await upload(L, () => L.getByRole("button", { name: "Wczytaj postęp z telefonu" }).click(), progPath);
await L.getByText(/Wczytano paczkę \(postęp nauki\)/).waitFor();
await L.getByText("zgłoszone z telefonu").waitFor();
await L.screenshot({ path: out + "/L8-flagged.png", fullPage: true });
step("laptop: flagged card from the phone shown");

// Dark mode check of the review screen.
await L.emulateMedia({ colorScheme: "dark" });
await L.locator(".todo", { hasText: "do zatwierdzenia" }).click();
await L.screenshot({ path: out + "/L9-review-dark.png" });

console.log("errors:", errors);
await browser.close();
stopServers();
if (errors.length) process.exit(1);
console.log("E2E OK");
