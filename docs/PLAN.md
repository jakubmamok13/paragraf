# Paragraf: założenia i plan

## Zasady naukowe (każda funkcja wynika z co najmniej jednej)

1. **Przywoływanie z pamięci.** Najpierw próba odpowiedzi, potem odpowiedź. Nie ma trybu „przeczytaj fiszkę”.
2. **Powtórki rozłożone w czasie:** FSRS (`ts-fsrs`), docelowa retencja ustawiana (domyślnie 0,9).
3. **Przeplatanie** zagadnień i (opcjonalnie) przedmiotów.
4. **Elaboracja:** pytania „dlaczego?”, „czym różni się X od Y?”.
5. **Transfer:** kazusy (v2).
6. **Metapoznanie:** pewność przed odsłonięciem odpowiedzi, wykres kalibracji.
7. **Minimalna informacja:** jedna fiszka sprawdza jedną rzecz; listy rozbite na pozycje.

## Decyzje

| # | Decyzja | Powód |
|---|---|---|
| D-1 | Osobne repozytorium `paragraf` | Inna aplikacja niż EveryDay; osobny adres i dane. |
| D-2 | PWA (React + Vite, TypeScript), SQLite przez sql.js w IndexedDB | Jedna baza kodu na telefon i komputer, offline; wzorzec sprawdzony w EveryDay. |
| D-3 | **Wariant C:** komputer przetwarza, telefon służy do nauki; paczki `.json` | Bez serwera i kont. |
| D-4 | Paczka z treścią nigdy nie nadpisuje postępu, paczka z postępem nigdy nie nadpisuje treści; scalanie po UUID, nowszy `updated_at` wygrywa; usunięcia przez nagrobki | Bezpieczne wielokrotne przenoszenie w obie strony. |
| D-5 | **Lokalne AI** (Ollama / LM Studio) zamiast API w chmurze | Prywatność, zero kosztów. Sprzęt: i9-13. gen., 32 GB RAM, RX 6800 XT 16 GB. |
| D-6 | Odpowiedzi modelu wymuszone schematem JSON; cytaty i numery przepisów sprawdzane deterministycznie w kodzie | Mniejszy model wymaga twardych zabezpieczeń; bez źródła nie ma materiału. |
| D-7 | Przedmioty i egzaminy w pełni konfigurowalne; przedmiot może mieć kilka zaliczeń (rodzaj, forma, data) | Przedmioty zmieniają się co semestr. |
| D-8 | Fiszki: odpowiedź w myślach; trzy przyciski pewności (zgaduję / chyba / pewny) jednocześnie odsłaniają odpowiedź; potem Again/Hard/Good/Easy | Metapoznanie bez dodatkowego kliknięcia, wygodne jedną ręką. |
| D-9 | Pages: eksport do Worda albo podgląd PDF z pliku `.pages`; obsługiwane PDF, DOCX, TXT, MD, ODT, RTF, HTML, EPUB | Format `.pages` jest zamknięty. |
| D-11 | Wyliczenie („Wymień przesłanki…”) to jedna powtórka: odpowiadasz w myślach całością, potem odsłaniasz pozycje po kolei i zaznaczasz każdą ✓/✗; aplikacja proponuje ocenę (wszystkie → Dobrze, jedna z ≥4 brakująca → Trudno, inaczej → Nie wiedziałem). Długie listy dzieli generator. | Egzamin sprawdza całe wyliczenie; ocena per pozycja zostaje w historii. |
| D-12 | Planer: budżet czasu z mediany Twoich czasów odpowiedzi; zaległe powtórki według priorytetu (waga × szansa zapomnienia × bliskość egzaminu); nowe materiały wstrzymane, dopóki są zaległości; jedna luka z danego tekstu dziennie; sąsiednie fiszki z różnych zagadnień. | Kryteria MVP: limit czasu i poprawny harmonogram po przerwie (test: 300 fiszek, 5 dni przerwy). |
| D-13 | Dzień nauki kończy się o 4:00. Przedmiot w podtrzymaniu: retencja 0,8, bez nowych materiałów. Fiszka nieudana 3 razy w jednej sesji czeka do następnej. | Nauka późnym wieczorem liczy się do „dziś”; brak pętli bez końca. |
| D-14 | Własne fiszki (pytanie, luki, wyliczenie) można dodać ręcznie; nie wymagają źródła, bo są Twoje. | Nauka może ruszyć przed Pracownią. |
| D-10 | sql.js nie ma FTS5. Wyszukiwanie w źródłach: FTS4 z rankingiem BM25 liczonym w JS albo indeks w JS; rozstrzygnięcie w kroku 5 | Sprawdzone w kroku 1. |

## Hierarchia źródeł

1. Tekst aktu prawnego: rozstrzyga o treści przepisu.
2. Notatki z wykładu: rozstrzygają o zakresie i akcentach egzaminacyjnych.
3. Podręcznik: pogłębienie.

Sprzeczności nie są rozstrzygane po cichu. Pole dostaje status `conflicted`, powstaje `source_conflict`, a materiał z tego pola nie powstanie, dopóki nie wybierzesz wersji.

## Model danych

Schemat: [`packages/core/src/schema.ts`](../packages/core/src/schema.ts). Najważniejsze tabele:

- `subject`, `exam`: przedmioty i zaliczenia.
- `source_document`, `source_chunk`: źródła podzielone na fragmenty (strona, nagłówki, hash do trybu przyrostowego).
- `topic`, `topic_field`, `provision_ref`, `topic_relation`: mapa wiedzy (instytucja → pola: definicja, przesłanki, skutki…).
- `citation`: każde pole i każdy materiał wskazuje fragment źródła i dosłowny cytat.
- `source_conflict`: sprzeczności do rozstrzygnięcia.
- `material`: materiał do nauki (qa, cloze, list, provision, distinction, why; w v2 case, oral, table).
- `review_item`: stan FSRS jednej jednostki powtórki (luka, pozycja listy); `review_log`: historia odpowiedzi z pewnością.
- `amendment`: nowelizacje; `ai_call`: wywołania lokalnego AI (czas, cache).

## Prompty (od kroku 7, pliki w `prompts/`)

| Prompt | Etap |
|---|---|
| `classify-chunks`: czy fragment jest merytoryczny, do jakiego działu | MVP |
| `extract-topics`: zagadnienia i pola z dosłownymi cytatami, bez wiedzy spoza fragmentu | MVP |
| `merge-topics`: to samo / różne / to samo z konfliktem (nie wybiera wersji) | MVP |
| `generate-materials`: qa, cloze, list, provision, distinction, why; limit, priorytet według wagi | MVP |
| `critic-materials`: minimalna informacja, długość odpowiedzi, źródło | MVP |
| `generate-case`, `grade-case`: problem → podstawa → subsumpcja → wniosek | v2 |
| `grade-oral`: kompletność względem mapy zagadnienia | v2 |
| `feynman` | v3 |

## Plan MVP

1. ✅ Repozytorium i szkielet: baza z migracjami, przedmioty i egzaminy, ustawienia, paczki, klient lokalnego AI i test połączenia.
2. ✅ Przedmioty i egzaminy (dodawanie, edycja, archiwum, podtrzymanie, usuwanie), ustawienia czasu nauki. Zrobione razem z krokiem 1.
3. ✅ FSRS i sesja na telefonie: pewność jako odsłonięcie odpowiedzi, budżet czasu, test kilkudniowej przerwy, cofanie odpowiedzi, kalibracja po sesji, własne fiszki.
4. Import: TXT, MD, DOCX, ODT, RTF, HTML, `.pages` (podgląd PDF); fragmenty z hashami.
5. Import PDF i EPUB z numerami stron; indeks wyszukiwania i indeks przepisów.
6. Porównanie modeli na prawdziwej notatce, wybór domyślnego.
7. Pipeline: ekstrakcja, scalanie, konflikty, walidator cytatów; kolejka przetwarzania z wznawianiem.
8. Generator (qa, cloze, list) z krytykiem.
9. Kolejka zatwierdzania, podgląd źródła, ekran konfliktów.
10. Paczki: przegląd po pierwszym prawdziwym użyciu, kompresja dużych paczek.
11. Sesja po wykładzie i podstawowa analityka.
12. Test end-to-end na jednym prawdziwym przedmiocie.

v2: kazusy z oceną AI, pytania ustne, tryb „odróżnij”, planer egzaminacyjny, mapa przedmiotu.
v3: OCR odręcznych notatek, odpowiedzi głosowe, symulacja egzaminu, ISAP, eksport do Anki.
