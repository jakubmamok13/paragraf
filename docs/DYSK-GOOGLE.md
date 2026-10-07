# Synchronizacja przez Dysk Google

Fiszki, postęp nauki, pałace pamięci i ustawienia same zapisują się w folderze na
Twoim Dysku Google. Inne urządzenie po wskazaniu tego samego folderu wczytuje
wszystko i dalej synchronizuje się samo.

## Jak to działa

- Każde urządzenie ma w folderze **własny plik**
  (`paragraf-sync-<urządzenie>-….json.gz`) i zapisuje tylko ten plik. Pliki
  pozostałych urządzeń czyta i scala ze swoimi danymi: nowsza zmiana wygrywa, a
  usunięcia też się przenoszą. Dwa urządzenia nigdy nie nadpisują tego samego
  pliku, więc nic nie ginie, nawet gdy oba były używane bez internetu.
- Synchronizacja odbywa się sama:
  - przy otwarciu aplikacji;
  - po powrocie do aplikacji;
  - co 5 minut, gdy aplikacja jest otwarta;
  - do 30 s po zmianie;
  - od razu przy wyjściu z aplikacji, jeśli coś zostało niewysłane.
- Dysk Google pamięta wcześniejsze wersje każdego pliku (Dysk → plik →
  „Zarządzaj wersjami”).
- Co trafia na Dysk: przedmioty, źródła (z pełnym tekstem), zagadnienia,
  fiszki, postęp, pałace i wspólne ustawienia.
- Co zostaje na urządzeniu: ustawienia lokalnego AI (adres serwera, model) i
  pamięć podręczna odpowiedzi AI.
- Uprawnienie to `drive.file`: aplikacja widzi **tylko pliki i foldery, które
  sama utworzyła**, nie resztę Twojego Dysku. Dane idą prosto z urządzenia na
  Twój Dysk, bez żadnego serwera pośredniego.

## Jednorazowa konfiguracja (ok. 5 minut)

Google wymaga, żeby aplikacja miała własny „identyfikator klienta”. Tworzysz go
raz, za darmo, na swoim koncie Google.

1. Otwórz <https://console.cloud.google.com/projectcreate> i utwórz projekt,
   np. „Paragraf”.
2. Włącz Drive API: <https://console.cloud.google.com/apis/library/drive.googleapis.com>
   → **Włącz**.
3. Otwórz <https://console.cloud.google.com/auth/overview> → **Rozpocznij**:
   - Nazwa aplikacji: Paragraf. E-mail pomocy: Twój.
   - Odbiorcy: **Zewnętrzni**. E-mail kontaktowy: Twój. Zaakceptuj zasady.
4. **Odbiorcy** (Audience) → **Użytkownicy testowi** → dodaj swój adres Gmail.
   Możesz też kliknąć „Opublikuj aplikację”: zakres `drive.file` nie wymaga
   weryfikacji przez Google.
5. **Klienci** (Clients) → **Utwórz klienta**:
   - Typ: **Aplikacja internetowa**.
   - Autoryzowane źródła JavaScript: `https://jakubmamok13.github.io`
   - Autoryzowane identyfikatory URI przekierowania:
     `https://jakubmamok13.github.io/paragraf/`. Wpisz z ukośnikiem na końcu;
     dokładny adres pokazuje też aplikacja w Ustawieniach.
   - Do pracy lokalnej możesz dodać `http://localhost:5173` oraz
     `http://localhost:5173/`.
6. Skopiuj **identyfikator klienta** (kończy się na
   `.apps.googleusercontent.com`) i wybierz jedno z dwóch:
   - **Raz dla wszystkich urządzeń.** W repozytorium na GitHubie wejdź w
     Settings → Secrets and variables → Actions → **Variables** → New repository
     variable. Nazwa: `GOOGLE_CLIENT_ID`, wartość: identyfikator. Potem uruchom
     ponownie akcję „Publish to GitHub Pages” (Actions → Run workflow).
   - **Na każdym urządzeniu osobno.** Wklej identyfikator w aplikacji:
     Ustawienia → Dysk Google.

Przy pierwszym logowaniu Google może pokazać ekran „Google nie zweryfikował tej
aplikacji”. To Twoja własna aplikacja, więc wybierz „Kontynuuj”.

## Pierwsze urządzenie

Ustawienia → **Dysk Google** → **Połącz z Dyskiem Google** → zaloguj się →
wpisz nazwę folderu (domyślnie „Paragraf”) → **Utwórz folder**. Kopia tego
urządzenia od razu trafia do folderu. Folder możesz potem przenieść w dowolne
miejsce na Dysku.

## Kolejne urządzenie (np. iPhone)

1. Otwórz aplikację i dodaj ją do ekranu początkowego.
2. Wejdź w Ustawienia → **Dysk Google** → **Połącz z Dyskiem Google**.
3. Przy folderze Paragrafu wybierz **Użyj tego folderu**.

Fiszki, postęp i ustawienia z pozostałych urządzeń wczytają się od razu. Jeśli
na tym urządzeniu też były dane, zostaną scalone, a nie zastąpione.

## Logowanie

Dostęp od Google ważny jest godzinę. Po tym czasie aplikacja przy otwarciu na
moment przechodzi do Google i wraca z nowym dostępem, bez żadnego klikania. Jeśli
Google chce potwierdzenia (np. wylogowałeś się z konta), na ekranie „Dziś”
pojawia się przycisk **Zaloguj do Dysku Google**. Do tego czasu wszystko działa
normalnie na urządzeniu, a zmiany wyślą się po zalogowaniu.

## Odłączenie

Ustawienia → Dysk Google → **Odłącz**. Dane zostają i na urządzeniu, i w
folderze. Synchronizacja po prostu przestaje działać.
