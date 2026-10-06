# Paragraf: nauka prawa

Paragraf zamienia Twoje notatki z wykładów i podręczniki w materiały do aktywnej
nauki, a potem codziennie układa krótką sesję powtórek (FSRS). Wszystko zostaje
na Twoich urządzeniach:

- **Komputer (Pracownia):** lokalne AI (Ollama albo LM Studio) czyta źródła
  i przygotowuje materiały do zatwierdzenia. Nic nie wychodzi poza komputer.
- **Telefon (nauka):** codzienna sesja, działa offline.
- Między nimi przenosisz **paczki** (pliki `.json`), np. przez iCloud Drive albo mail.

Założenia i plan: [`docs/PLAN.md`](docs/PLAN.md).

> Stan: **krok 1 z 12**: szkielet aplikacji, przedmioty i egzaminy, ustawienia,
> paczki laptop ↔ telefon, połączenie z lokalnym AI. Import źródeł i sesja nauki
> w kolejnych krokach.

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

## Telefon (iPhone)

Otwórz adres aplikacji w Safari → Udostępnij → **Do ekranu początkowego**.
Zawsze używaj ikony: Safari i ikona mają osobne dane.
Paczkę z komputera wczytasz w **Ustawienia → Wczytaj paczkę**.

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
```

Struktura:

- `packages/core`: baza (SQLite przez sql.js) z migracjami, ustawienia,
  przedmioty i egzaminy, paczki, klient lokalnego AI. Bez UI, testowany w Node.
- `apps/web`: PWA w React; baza zapisywana w IndexedDB, service worker do pracy offline.
- `prompts/` (od kroku 7): prompty systemowe z wersjami.

Każdy push na `main` uruchamia typecheck i testy, buduje aplikację i publikuje
ją w gałęzi `gh-pages` (`.github/workflows/pages.yml`). Raz trzeba ustawić
**Settings → Pages → Source: Deploy from a branch → `gh-pages` / (root)**.
GitHub Pages na darmowym planie działa tylko dla repozytoriów publicznych.
Repozytorium zawiera wyłącznie kod: notatki, podręczniki i dane są w
`.gitignore` i nigdy tu nie trafiają.
