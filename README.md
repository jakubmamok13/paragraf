# Paragraf: nauka prawa

Paragraf zamienia Twoje notatki z wykładów i podręczniki w materiały do aktywnej
nauki, a potem codziennie układa krótką sesję powtórek (FSRS). Wszystko zostaje
na Twoich urządzeniach:

- **Komputer (Pracownia):** lokalne AI (Ollama albo LM Studio) czyta źródła
  i przygotowuje materiały do zatwierdzenia. Nic nie wychodzi poza komputer.
- **Telefon (nauka):** codzienna sesja, działa offline.
- Między nimi przenosisz **paczki** (pliki `.json`), np. przez iCloud Drive albo mail.

Założenia i plan: [`docs/PLAN.md`](docs/PLAN.md).

> Stan: **MVP gotowe (kroki 1–12)**. Następne: wersja 2 (kazusy z oceną AI,
> pytania ustne, tryb „odróżnij”, planer egzaminacyjny, mapa przedmiotu).

---

## Lokalne AI na komputerze z Windows (Ollama)

1. Zainstaluj Ollamę z ollama.com. Karta AMD Radeon RX 6800 XT jest obsługiwana.
2. Pobierz model, np. w PowerShell: `ollama pull <nazwa-modelu>`. Który model
   wybrać, ustalimy w kroku 6, testując kilka na Twojej prawdziwej notatce.
   Z 16 GB pamięci karty najszybciej działają modele do ok. 14B parametrów.
3. Zezwól aplikacji na połączenie z Ollamą:
   **Start → „Edytuj zmienne środowiskowe dla konta”** → Nowa:
   - nazwa: `OLLAMA_ORIGINS`
   - wartość: adres, pod którym otwierasz Paragraf, bez ścieżki, np.
     `https://jakubmamok13.github.io` (podczas programowania: `http://localhost:5173`)
4. Zamknij Ollamę (ikona przy zegarze → Quit) i uruchom ponownie.
5. W Paragrafie: **Pracownia → Lokalne AI → Sprawdź połączenie**, wybierz model.
   Jeśli przeglądarka zapyta o dostęp do urządzeń w sieci lokalnej, zezwól.

LM Studio: włącz serwer (Developer → Start Server) i CORS, w Paragrafie wybierz
„LM Studio / inny”, adres `http://localhost:1234`.

## Pracownia: od notatki do fiszek (komputer)

1. **Przedmioty → Dodaj**: nazwa, forma i data egzaminu.
2. **Pracownia → Wczytaj źródło**: wybierz przedmiot i rodzaj (notatka, podręcznik,
   tekst ustawy, lista zagadnień, sylabus) i pliki: PDF, EPUB, DOCX, ODT, RTF, TXT,
   MD, HTML. Notatki z Pages: Plik → Eksportuj do → Word.
3. Lokalne AI czyta plik fragment po fragmencie. Postęp zapisuje się na bieżąco:
   możesz wstrzymać, zamknąć i wrócić. Podręcznik zostaw na noc.
4. **Do decyzji**:
   - *do zatwierdzenia*: każdy materiał ma cytat ze źródła (kliknij, aby zobaczyć
     cały fragment); Zatwierdź / Edytuj / Za łatwe / Odrzuć, albo wszystko naraz;
   - *sprzeczności źródeł*: gdy np. podręcznik sprzed nowelizacji mówi co innego
     niż wykład, wybierasz właściwą wersję (aplikacja nigdy nie wybiera sama);
   - *sugestie AI*: to, czego model nie umiał potwierdzić cytatem (np. numer
     artykułu spoza notatki) – nigdy nie staje się fiszką samo.
5. **Wyślij treść na telefon** i wczytaj paczkę na telefonie.
6. Co jakiś czas: na telefonie **Wyślij postęp na komputer**, na komputerze
   **Wczytaj postęp z telefonu** – trafią tam też fiszki zgłoszone jako błędne.

**Porównaj modele** (Pracownia → Lokalne AI): uruchamia analizę Twojej notatki
na kilku modelach i pokazuje czas oraz odsetek treści potwierdzonych cytatem.

## Telefon (iPhone)

Otwórz adres aplikacji w Safari → Udostępnij → **Do ekranu początkowego**.
Zawsze używaj ikony: Safari i ikona mają osobne dane.
Paczkę z komputera wczytasz w **Ustawienia → Wczytaj paczkę**.

## Codzienna sesja

1. **Dziś → Zacznij.** Sesja mieści się w Twoim limicie minut.
2. Odpowiedz **w myślach**, potem stuknij, jak pewnie to wiesz: *Zgaduję / Chyba wiem / Pewnie*. To odsłania odpowiedź.
3. Oceń się: *Nie wiedziałem / Trudno / Dobrze / Łatwo*. Pod każdym przyciskiem widać, kiedy fiszka wróci.
4. Pomyłka? **↶** cofa ostatnią odpowiedź.
5. Na koniec widzisz, jak Twoja pewność zgadzała się z wynikiem.

Na komputerze działają klawisze: 1–3 (pewność), 1–4 (ocena), T/N (pozycje wyliczenia).

Własne fiszki: **Przedmioty → (przedmiot) → Dodaj własną fiszkę**.

**Po wykładzie** (ekran Dziś): gdy masz materiały z dzisiejszej notatki, krótki
test z nich tego samego dnia. **Zgłoś błąd** w sesji zawiesza fiszkę do poprawy.
**Postęp**: opanowanie per przedmiot, dział i zagadnienie, czego uczyć się dziś,
gotowość na egzamin, pewność a wynik, najtrudniejsze fiszki.

## Kopia zapasowa

Dane są tylko na urządzeniu. **Ustawienia → Eksportuj pełną kopię** zapisuje
wszystko do pliku; wczytanie kopii zastępuje dane na urządzeniu.

---

## Dla programisty

```bash
npm install
npm test            # testy pakietu core (sql.js w Node)
npm run typecheck
npm run dev         # serwer Vite: http://localhost:5173
npm run build       # pliki statyczne w apps/web/dist
npm run e2e         # po build: pełny scenariusz w przeglądarce (laptop + telefon)
                    # z atrapą modelu zamiast prawdziwej Ollamy
```

Struktura:

- `packages/core`: baza (SQLite przez sql.js) z migracjami, ustawienia,
  przedmioty i egzaminy, paczki, klient lokalnego AI. Bez UI, testowany w Node.
- `apps/web`: PWA w React; baza zapisywana w IndexedDB, service worker do pracy offline.
- `prompts/`: prompty systemowe (ekstrakcja, scalanie, generowanie) – można je też
  edytować w aplikacji (Ustawienia → Pracownia → Prompty AI).
- `packages/core/test/fixtures`: przykładowa notatka (w kilku formatach),
  „stary podręcznik” z nieaktualnym terminem przedawnienia i lista zagadnień;
  `fake-model.ts` udaje lokalny model, łącznie z typowymi błędami (zmyślony
  cytat, zły numer artykułu, pytanie „Omów…”), które aplikacja musi odrzucić.

Każdy push na `main` uruchamia typecheck i testy, buduje aplikację i publikuje
ją w gałęzi `gh-pages` (`.github/workflows/pages.yml`). Raz trzeba ustawić
**Settings → Pages → Source: Deploy from a branch → `gh-pages` / (root)**.
GitHub Pages na darmowym planie działa tylko dla repozytoriów publicznych.
Repozytorium zawiera wyłącznie kod: notatki, podręczniki i dane są w
`.gitignore` i nigdy tu nie trafiają.
