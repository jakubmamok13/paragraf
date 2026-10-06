# Mnemotechniki, zagadnienia jako całość i uzupełnianie braków – research i propozycja

Stan: propozycja do akceptacji (październik 2026). Nic z tego nie jest jeszcze zaimplementowane.

## 1. Co mówią badania o mnemotechnikach

| Ustalenie | Źródło | Wniosek dla Paragrafu |
|---|---|---|
| W przeglądzie 10 technik uczenia się testowanie (retrieval practice) dostało najwyższą ocenę użyteczności, mnemotechnika słowa-klucza – niską: działa dla wąskiego typu materiału i przy krótkich odstępach. | Dunlosky i in. 2013, *Psychological Science in the Public Interest* ([opis](https://www.scotthyoung.com/blog/?p=15181), [DOI 10.1177/1529100612453266](https://www.citedrive.com/en/discovery/improving-students-learning-with-effective-learning-techniques)) | Mnemotechnika nie może zastąpić przywoływania z pamięci. Tylko je uzupełnia. |
| Generowanie mnemotechnik daje podobną pamięć jak przywoływanie, ale **zajmuje dwa razy więcej czasu**, słabiej wspiera **transfer** (zastosowanie wiedzy) i **zawyża poczucie, że się umie**. | Zhang, praca doktorska, Univ. of Arizona 2023 ([repozytorium](https://repository.arizona.edu/handle/10150/669657)) | Mnemotechniki tylko tam, gdzie zwykłe powtórki zawodzą. Utrzymać deklarowanie pewności i kalibrację. Nie dla kazusów. |
| **Własne** mnemotechniki dają lepsze zapamiętanie niż cudze (5 eksperymentów); korzyść bierze się z głębszego przetworzenia treści. Wskazówki wybrane samodzielnie działają lepiej niż wybrane przez innych. | Tullis i współpr., *J. Exp. Psychology: Applied* ([opis](https://experts.arizona.edu/en/publications/generating-mnemonics-boosts-recall-of-chemistry-information/)); przegląd [Using Self-Generated Cues to Facilitate Recall](https://www.ncbi.nlm.nih.gov/pmc/articles/PMC5664228/) | Najpierw zachęta do własnego skojarzenia; propozycje AI jako zapas, z **wyborem** przez Ciebie. |
| W klasycznym badaniu przewaga mnemotechnik w teście odroczonym znikała u osób bez testu natychmiastowego; mogła wynikać z samego przywoływania. | Condus i in. 1975, omówione w [Mnemonics and their limitations](https://www.goodreads.com/author_blog_posts/9163879-mnemonics-and-their-limitations-in-studying-vocabulary?tab=book) | Mnemotechnika zawsze razem z powtórkami FSRS, nigdy zamiast. |
| Mnemotechniki pierwszych liter (akronimy, zdania) najlepiej pomagają odtworzyć **kolejność i komplet** elementów, które już się rozumie; pomagają przy „pustce w głowie” na egzaminie. | [Memory-key: first-letter mnemonics](https://www.mempowered.memory-key.com/node/58), [Frontiers in Psychology 2019](https://www.frontiersin.org/journals/psychology/articles/10.3389/fpsyg.2019.02522/epub) | Najlepsze zastosowanie w prawie: **wyliczenia** (przesłanki, znamiona, katalogi). |
| Metoda loci (pałac pamięci): 6 tygodni treningu dało trwałą poprawę widoczną po 4 miesiącach, ale wymaga nauki samej techniki. | Wagner, Dresler i in. 2021, *Science Advances* ([bioRxiv](https://www.biorxiv.org/content/10.1101/2020.04.29.067561v1.abstract)) | Opcja na później, dla kilku długich list. Nie domyślna. |
| Modele językowe potrafią tworzyć mnemotechniki porównywalne z ludzkimi, najlepiej w schemacie „wygeneruj wiele, wybierz najlepsze”. | Lee, McNichols, Lan, EMNLP 2024 ([arXiv 2409.13952](https://arxiv.org/abs/2409.13952v1)) | Lokalny model generuje kilka propozycji, aplikacja sprawdza je w kodzie (np. czy litery akronimu pasują do pozycji), Ty wybierasz. |
| Słowo + obraz zapamiętuje się lepiej niż samo słowo, o ile obraz pasuje do treści; obraz nieistotny przeszkadza. | Paivio (kodowanie podwójne), Mayer (zasada multimedialna) – [opis](https://u.osu.edu/multimedialearning/?p=102), [kiedy obrazy szkodzą](https://www.structural-learning.com/post/dual-coding) | Stałe ikony i kolory dla **rodzajów elementów** zagadnienia (przesłanka, skutek, termin…), bez ozdobników. |
| Przeplatanie zagadnień daje gorsze wyniki w trakcie nauki, ale wyraźnie lepsze później; nauka blokami daje złudzenie opanowania. | Kornell i Bjork 2008; Rohrer i Taylor 2007 – [przegląd](https://www.frontiersin.org/journals/psychology/articles/10.3389/fpsyg.2014.00936/pdf), [Learning Scientists](https://learningscientists.org/blog/2023/11/2-1) | Powtórki zostają przeplatane. Blok w obrębie zagadnienia tylko przy **pierwszym** kontakcie (hipoteza – patrz pyt. 2). |
| Przywoływanie z pamięci dało o 50% lepszą retencję po tygodniu niż tworzenie map pojęć, także w teście polegającym na rysowaniu mapy. | Karpicke i Blunt 2011, *Science* ([Purdue](https://www.purdue.edu/newsroom/research/2011/110120KarpickeScience.html)) | Mapę zagadnienia trzeba **odtwarzać z pamięci**, a nie tylko oglądać. |

## 2. Propozycja: mnemotechniki w Paragrafie

1. **Gdzie**: tylko dla
   - wyliczeń (przesłanki, znamiona, katalogi) – akronim lub zdanie z pierwszych liter,
   - liczb i terminów (20/30 lat, 6/3 lata) – skojarzenie,
   - mylonych par (zasiedzenie / przemilczenie) – jedna cecha wyróżniająca,
   - fiszek-pijawek (≥3 razy „Nie wiedziałem”).
2. **Kiedy**: mnemotechnika jest na **stronie odpowiedzi**, nie pytania (nie podpowiada przy przywoływaniu). Propozycja jej utworzenia pojawia się po porażce, nie przy każdej fiszce.
3. **Kto tworzy**: najpierw Ty („Wymyśl własne skojarzenie”); przycisk „Podpowiedz” daje 3 propozycje lokalnego modelu, sprawdzone w kodzie (litery akronimu = pierwsze litery pozycji, kolejność zachowana). Wybierasz jedną albo żadnej.
4. **Pomiar**: aplikacja porównuje odsetek „Nie wiedziałem” przed i po dodaniu mnemotechniki i pokazuje, czy pomaga.
5. **Później (opcja)**: pałac pamięci dla kilku najdłuższych list – z instrukcją budowy, wyłącznie na życzenie.

## 3. Propozycja: zagadnienie jako spójny system fiszek

Fiszki zostają małe (jedna rzecz na fiszkę – to warunek skutecznych powtórek), ale stają się **częściami jednego schematu**:

1. **Schemat zagadnienia** w stałej kolejności: definicja → podstawa prawna → przesłanki → skutki → wyjątki → terminy → orzecznictwo → doktryna → cel regulacji. Każda fiszka zna swoje miejsce w schemacie.
2. **Mini-mapa w sesji**: nad pytaniem pasek segmentów schematu z zaznaczonym bieżącym miejscem (np. „Zasiedzenie nieruchomości · przesłanki 2/7”). Pokazuje tylko nazwy części, nie ich treść, więc nie podpowiada.
3. **Po odpowiedzi „Całe zagadnienie”**: arkusz z całym schematem i stopniem opanowania każdej części – informacja zwrotna po próbie przywołania, nie zamiast niej.
4. **Spójny język wizualny**: każdy rodzaj części ma stałą ikonę i kolor (np. ⚖ podstawa, ☰ przesłanki, → skutek, ⚠ wyjątek, ⏱ termin, 🏛 orzecznictwo), a zawsze także nazwę, nigdy sam kolor.
5. **Fiszka-synteza „Odtwórz schemat”**: gdy wszystkie części są opanowane, jedna fiszka typu wyliczenie: „Zasiedzenie nieruchomości – odtwórz schemat”. To przywoływanie struktury, które według Karpicke i Blunt działa lepiej niż oglądanie mapy.
6. **Pokrycie**: przy zatwierdzaniu widać części zagadnienia bez fiszki („Skutki – brak fiszki”) z przyciskiem „Uzupełnij”.
7. **Kolejność**: pierwsze wejście w zagadnienie to krótka „lekcja” w kolejności schematu; kolejne powtórki są przeplatane z innymi zagadnieniami.

## 4. Propozycja: uzupełnianie braków z internetu

Pierwotna zasada brzmiała: żadnej wiedzy spoza źródeł. Proponuję ją zachować, ale rozszerzyć listę źródeł o **oficjalne, cytowalne bazy**. To, co przyjdzie z internetu, staje się nowym źródłem z cytatem i datą, a nie „wiedzą modelu”:

| Brak | Źródło | Co dalej |
|---|---|---|
| Brzmienie przepisu, numer artykułu, nowelizacja | **ELI API Sejmu** (`api.sejm.gov.pl/eli`), aktualne teksty jednolite, np. k.c. w HTML ([dokumentacja](https://api.sejm.gov.pl/eli.html)) | Import jako „Tekst aktu prawnego” – najwyżej w hierarchii źródeł; sprzeczności z podręcznikiem sprzed nowelizacji wykrywają się same. |
| Teza orzeczenia o znanej sygnaturze | **SAOS** – otwarta baza orzeczeń, bez klucza API ([dokumentacja](https://saos.org.pl/help/index.php/dokumentacja-api)); bez sądów administracyjnych | Import tezy jako źródła „Orzecznictwo”. |
| Wyjaśnienia doktrynalne, „dlaczego” | Ogólny internet – bez gwarancji poprawności | Nie automatycznie. Najwyżej przycisk otwierający wyszukiwarkę z treścią braku. |

**Prywatność:** do internetu wychodzą wyłącznie identyfikatory (np. „k.c., art. 118”, sygnatura), nigdy treść notatek. Funkcja byłaby domyślnie wyłączona.

**Ryzyko do sprawdzenia:** nie mogłem połączyć się z tymi serwerami ze środowiska, w którym pracuję, więc nie wiem, czy pozwalają na zapytania prosto z przeglądarki (CORS). Jeśli nie, potrzebny będzie mały pośrednik uruchamiany na Twoim komputerze obok Ollamy.

## 5. Decyzje do podjęcia

1. Uzupełnianie z internetu: tylko ISAP + SAOS (opcjonalnie, domyślnie wyłączone), a ogólna sieć jako link? Czy inaczej?
2. Pierwszy kontakt z zagadnieniem jako krótka „lekcja” w kolejności schematu, czy od początku pełne przeplatanie?
3. Mnemotechniki: własne + propozycje AI do wyboru, czy wyłącznie własne?
