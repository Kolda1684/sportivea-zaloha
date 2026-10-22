# Třídění karet — návrh

Mac aplikace pro kancelářský počítač Sportivea. Kameraman zasune paměťovou kartu z natáčení, aplikace klipy přímo z karty roztřídí do kategorií, pojmenuje je podle obsahu, označí TOP záběry a nahraje je na sdílený Google Drive. Kameraman na nic nečeká a karta zůstane nedotčená.

## Proč

- Dnes kluci kartu ručně zkopírují do složky a nahrají na Drive. Třídění a pojmenování pak dělá někdo jiný ručně, nebo se nedělá vůbec. U Davis Cupu i Istanbulu to znamenalo stovky klipů `C0xxx.MP4`, ve kterých se střihač musel prohrabovat.
- Tým už při natáčení označuje dobré záběry: po povedeném záběru dá kameraman ruku před objektiv a vznikne krátký černý klip. Tahle informace se dnes nikde nevyužije.
- Ověřený postup už existuje. Ruční třídění Davis Cupu (258 klipů) a Istanbulu (184 klipů) v Claude Code ukázalo, že klip jde spolehlivě zařadit a popsat ze 3–4 snímků. Aplikace tenhle postup automatizuje.

**Úspěch:** kameraman zasune kartu, vybere akci, zmáčkne Start a odejde. Za pár minut (podle rychlosti uploadu) jsou na disku klipy v podsložkách, s popisnými názvy, TOP záběry nahoře a záznamem o tom, co se nahrálo. Nic se nesmazalo a nic se neztratilo.

## Cíle

1. Číst klipy přímo z připojené karty bez kopírování do počítače.
2. Každý klip zařadit do kategorie podle šablony akce a dát mu krátký popis (Claude Sonnet 5.5 nad zmenšenými snímky).
3. Rozpoznat černé značky („ruka před objektivem“) a klip těsně před každou z nich označit jako TOP.
4. Nahrát klipy do zvolené složky na sdíleném disku, rovnou pod novými názvy a do podsložek kategorií.
5. Ověřit, že každý nahraný soubor odpovídá originálu na kartě, a teprve potom říct, že je karta zálohovaná.
6. Na konci ukázat přehled a uložit CSV s mapováním (původní název → nový název → složka) i na disk.

## Bezpečnostní pravidla (nepřekročitelná)

Jan to výslovně chtěl: **aplikace nikdy nic nesmaže.**

- **Karta je jen pro čtení.** Aplikace na kartě nic nemaže, nepřejmenovává, nezapisuje ani neformátuje. Karta se formátuje až ve fotoaparátu.
- **Na disk se jen přidává.** Žádné mazání, přesouvání ani přepisování existujících souborů. Když cílový název už existuje, aplikace nahraje soubor s dovětkem ` (2)`, ` (3)`… Výjimka: pokud stejnojmenný soubor má stejnou velikost i kontrolní součet, jde o duplikát z dřívějšího běhu. Nenahrává se znovu a v přehledu je uvedený jako „už na disku“.
- **„Zapsáno a ověřeno“** se ukáže teprve po ověření všech souborů (viz Ověření). Do té doby UI výslovně říká „karta ještě NENÍ zálohovaná“. Aplikace nikdy netvrdí, že je hotový upload do cloudu (varianta A).
- **Černé značky se na disk nenahrávají**, ale na kartě zůstanou. V CSV jsou uvedené.
- **Selhání AI nikdy neblokuje zálohu.** Když třídění klipu selže (síť, chyba API, nečitelný soubor), klip se nahraje do podsložky `_nezařazeno` pod původním názvem. Záloha má vždy přednost před tříděním.

## Proč ne / co to nebude dělat

- Nestříhá, neexportuje ani neupravuje video. Soubory se nahrávají bit po bitu tak, jak jsou na kartě.
- Není to správce médií ani katalog. Po nahrání aplikace práci končí.
- Nesmaže kartu, i kdyby to někdo chtěl. Tlačítko „zformátovat kartu“ nebude.
- Nehraje si se sdílením ani oprávněními na Drivu.
- Ve v1 neposílá zprávy do Slacku (možné rozšíření později).

**Selhání, i kdyby to technicky fungovalo:** kameraman musí čekat u počítače. Nebo se z karty něco tiše nenahraje. Nebo aplikace hlásí „hotovo“ a soubory na disku chybí či jsou poškozené.

## Tok práce

1. **Zasunutí karty.** Aplikace běží na pozadí (ikona v Docku nebo v liště) a sleduje připojené svazky (`/Volumes`). Pozná paměťovou kartu podle typické struktury (Sony `PRIVATE/M4ROOT/CLIP`, `DCIM` atd.) a otevře okno „Nová karta: SONY_A75, 184 klipů, 64 GB, natočeno 19.–20. 10.“.
2. **Nastavení akce.** Kameraman vyplní:
   - **Kam:** vybere existující složku akce pod kořenovou složkou, nebo založí novou. Název nové složky aplikace předvyplní jako `RRRR-MM-DD ` (datum nejstaršího klipu) a kameraman dopíše název, třeba `2026-10-20 Fenerbahçe – Slavia`.
   - **Šablona:** fotbal / tenis / další, viz Šablony. Předvybraná je poslední použitá.
   - **Start.**
3. **Rozbor (bez AI).** Pro každý klip aplikace z karty načte metadata (délka, rozlišení, fps, čas natočení, kamera) a jas několika snímků. Z toho určí černé značky a TOP záběry a seřadí klipy podle času natočení.
4. **Třídění (AI).** Pro každý klip, který není černou značkou, vytáhne 4 snímky (15 / 40 / 65 / 90 % délky), složí je do jednoho obrázku 2×2 a pošle Claudovi spolu se šablonou kategorií a krátkým kontextem (čas natočení, délka, popis sousedních klipů, pokud už je k dispozici). Claude vrátí kategorii, popis a jistotu.
5. **Nahrávání.** Souběžně s tříděním (klip se nahrává hned, jak je zařazený) kopíruje aplikace soubory z karty do cílové složky na Drivu pod novými názvy. Pořadí: nejdřív TOP záběry, pak ostatní podle času.
6. **Ověření.** Každý zapsaný soubor porovná s originálem (viz Ověření).
7. **Konec.** Systémová notifikace a obrazovka s přehledem: kolik klipů v které složce, kolik TOP záběrů, kolik je nezařazených, co se přeskočilo jako duplikát, cena za AI. Do cílové složky zapíše `_trideni_<datum-čas>.csv`. Pak zelené „Zapsáno a ověřeno. Kartu můžeš vytáhnout. Drive dokončuje upload, kartu formátuj až po jeho dokončení (ikona Drive v liště).“

Kameraman může po kroku 2 odejít. Zbytek běží sám a průběh je vidět v okně.

## Šablony kategorií

Šablona je seznam podsložek. Každá kategorie má název (stejný jako název složky na disku) a krátký popis pro model. Šablony jsou v nastavení aplikace a dají se upravovat bez programování (přidat, přejmenovat, smazat kategorii, upravit popis).

Výchozí šablony v1, převzaté z ručního třídění:

- **Fotbal** (podle Istanbulu): `Trénink`, `předzápas`, `rozcvička`, `nástup`, `Zápas`, `děkovačka`. Popisy pro model: trénink a tisková konference den před zápasem, příchod a procházka v oblecích, rozcvička na hřišti před zápasem, tunel a hymna a týmová fotka, samotná hra, poděkování fanouškům a rozhovory po zápase.
- **Tenis** (podle Davis Cupu): `Hra`, `Fanoušci`, `Lavička`, `Nástup`, `Sponzoři`.

Vždy navíc existuje podsložka `_nezařazeno` pro klipy, které model nezvládl nebo je zařadil s nízkou jistotou.

Jan říká, že kategorie se ještě budou ladit, ale většinou budou podobné. Šablony proto nejsou natvrdo v kódu.

## Pojmenování

Jan chce, aby klipy ve složce zůstaly **chronologicky**. Formát proto začíná původním názvem z kamery, protože kamery číslují klipy vzestupně podle času:

- Formát: `<původní název>_<popis>.<přípona>`, například `FX3-A_9347_gol-kacor.MP4` nebo `A75_0449_brankar-zakrok.MP4`. Řazení podle názvu ve Finderu i na Drivu tak odpovídá pořadí natáčení.
- `<popis>`: 1–4 slova, malými písmeny, bez diakritiky, slova spojená pomlčkou, maximálně 40 znaků. Kategorie je už v názvu složky, takže ji popis neopakuje (`gol-kacor`, ne `zapas-gol-kacor`). Vrací ho model, aplikace ho vyčistí (diakritika, nepovolené znaky, délka).
- TOP záběr: `<původní název>_TOP_<popis>`, například `FX3-A_9347_TOP_sance-kacor.MP4`. Pořadí zůstává chronologické a TOP je vidět hned v názvu.
- Když už je v původním názvu ruční popis od kameramana (např. `FX3-A_9347_šance.MP4`), převezme se do popisu a model ho jen doplní (`FX3-A_9347_TOP_sance-kacor.MP4`).
- `<původní název>` = název souboru na kartě bez přípony a bez ručního dovětku. Doprovodné soubory se nenahrávají, pokud to šablona výslovně nechce (viz Otevřené otázky).
- Pozn.: dřívější ruční třídění (Davis Cup, Istanbul) používalo formát `_popis_původní`. Nový formát je podle Janova pozdějšího přání a platí pro aplikaci.

### Jména hráčů v popisu

Jan chce popisy typu `gol-kacor`. Model nepozná člověka podle obličeje, umí ale přečíst číslo nebo jméno na dresu. Proto:

- U akce lze volitelně zadat **soupisku** (číslo a jméno, třeba `9 Kačor`, `10 Provod`), vložením textu nebo výběrem uložené soupisky týmu.
- Když je číslo na dresu čitelné a je na soupisce, model dá do popisu příjmení bez diakritiky. Když jisté není, jméno vynechá a popíše jen akci (`gol`, `sance-hlavicka`). Hádat se nesmí.
- Soupisky se ukládají v nastavení podle týmu, aby se nemusely zadávat znovu.

## Černé značky a TOP záběry

Ověřeno na Istanbulu: značky jsou klipy dlouhé 0,5–1 s, které jsou skoro celé černé.

- Klip je **černá značka**, když je kratší než 2 s a jeho průměrný jas je pod prahem. Práh se určuje podle profilu kamery: logové profily (S-Log3, N-Log) mají černou výš. Naměřené hodnoty (10bit Y): FX3 v S-Logu 100–160, A75 30–50, normální záběry 260 a víc. Práh se nastaví s rezervou a je v nastavení.
- **TOP záběr** = klip, který na stejné kartě a ze stejné kamery časově předchází černé značce. Pokud je mezi nimi víc než 60 s, nebo je předchozí klip sám značkou, TOP se nepřiřadí a značka se v přehledu uvede jako osiřelá.
- Černé značky se netřídí přes AI (žádný náklad) a nenahrávají se.

## Třídění přes AI

- **Model:** `claude-sonnet-5-5` (Jan ho schválil kvůli poměru cena/kvalita). Model půjde v nastavení přepnout na `claude-opus-5-5` nebo `claude-haiku-5-5`.
- **Vstup na klip:** jeden JPEG 2×2 (4 snímky z log materiálu převedené na kontrastní náhled, celkem asi 1 024 × 576 px), metadata klipu, šablona kategorií s popisy a krátký kontext sousedních klipů. Systémový prompt a šablona se cachují (prompt caching).
- **Výstup:** strukturovaný (structured outputs): `{ category: <jedna z kategorií šablony nebo "_nezařazeno">, description: string, confidence: "high" | "medium" | "low" }`.
- **Nízká jistota:** klip s `low` jde do své kategorie, ale v přehledu se zvýrazní k ruční kontrole. Do `_nezařazeno` jde jen při chybě nebo když model sám zvolí `_nezařazeno`.
- **Souběžnost:** několik požadavků najednou s ohledem na rate limity API, opakování při 429/5xx podle SDK.
- **Cena:** odhad pro Sonnet asi 15–25 Kč za kartu se 180–250 klipy. Aplikace po každém běhu ukáže skutečnou cenu podle `usage`. Před ostrým nasazením se cena a přesnost ověří testem (viz Test).
- **API klíč:** zadá se jednou v nastavení a uloží se do macOS Keychain. Nikdy v kódu ani v repozitáři.

## Nahrávání na Drive

- **Cesta v1:** přes Google Drive pro počítač (Google Drive for desktop), který zpřístupní sdílený disk jako složku v `~/Library/CloudStorage/GoogleDrive-…/Sdílené disky/…`. Aplikace do ní jen kopíruje soubory. Odpadá OAuth i práce s Drive API a z dřívějška víme, že Drive konektor neumí soubory na sdíleném disku přesouvat.
- **Kořenová složka** se zadá jednou v nastavení (výběr složky v Finderu uvnitř připojeného Drivu). Strukturu pod ní Sportivea teprve nastaví. Aplikace pod kořenem jen vypisuje existující složky akcí a umí založit novou.
- Google Drive pro počítač musí běžet a být přihlášený účtem s právem zápisu do sdíleného disku. Aplikace to při startu zkontroluje a když složka chybí, ukáže srozumitelnou chybu.

## Ověření

- Po zápisu každého souboru aplikace spočítá kontrolní součet (např. SHA-256 nebo xxHash) originálu na kartě i zapsané kopie a porovná je spolu s velikostí.
- **Omezení cesty přes Drive pro počítač:** aplikace ověří, že soubor je správně zapsaný do složky Drivu. Samotný upload do cloudu dělá Drive pro počítač na pozadí a jeho dokončení aplikace spolehlivě nezjistí. Hláška na konci proto zní „Vše zapsáno do Google Drive a ověřeno. Drive dokončuje upload na pozadí (sleduj ikonu Drive v liště). Kartu formátuj až po dokončení uploadu.“ (Viz Otevřené otázky.)

## Rozhraní

Jedno okno, česky, bez technických výrazů.

- **Klidový stav:** „Zasuň kartu“ a seznam posledních běhů.
- **Nová karta:** souhrn karty (kamera, počet klipů, velikost, data natočení), výběr nebo založení složky akce, šablona, Start.
- **Průběh:** dvě lišty (Třídění / Nahrávání) a pod nimi seznam klipů v reálném čase: náhled, nový název, složka, stav. Velký text „Karta ještě NENÍ zálohovaná“, dokud se neověří všechno.
- **Hotovo:** přehled podle složek, TOP záběry, klipy k ruční kontrole, duplikáty, cena, odkaz „Otevřít složku na disku“, zelené potvrzení.
- **Nastavení:** kořenová složka, API klíč, model, šablony kategorií, práh černé značky.
- Když se karta během běhu odpojí: běh se zastaví, nic se nesmaže a po opětovném připojení jde pokračovat. Hotové soubory se poznají podle kontrolního součtu a nenahrávají se znovu.

## Technické rozhodnutí

- **Platforma:** macOS, kancelářský Mac (Jan potvrdil Mac).
- **Stack:** stejný jako u Janovy existující appky `email-styl`: Electron + TypeScript (strict, bez `any`), UI v Reactu, Anthropic TypeScript SDK (`@anthropic-ai/sdk`), validace přes Zod. Nejnovější stabilní verze závislostí.
- **Video nástroje:** ffmpeg/ffprobe přibalené k aplikaci, aby nebylo nutné nic instalovat. Na snímky, metadata a jas. Dekódování 4K long-GOP je pomalé, proto se snímky berou přes rychlé vyhledávání (`-ss` před vstupem) a počítá se jas jen několika snímků.
- **Repozitář:** `github.com/Kolda1684/trideni-karet` (soukromý), commity pod `jan.kolar@sportivea.cz`. `.env` a klíče mimo git.
- **Dokumentace:** `CLAUDE.md` (stručný rozcestník) a `docs/` podle Janových pravidel.

## Test před nasazením

Ruční třídění z této session slouží jako referenční sada:

- **Istanbul** (184 klipů, fotbalová šablona): klipy jsou na disku i se správnými složkami a popisy (`~/Desktop/Istanbul`, mapování v `_trideni_mapovani.csv`).
- **Davis Cup** (258 klipů, tenisová šablona): mapování v `~/Desktop/Střih videí/drive_centralni_vyber_trideni.csv`.

Test pustí klasifikaci (bez nahrávání) přes Haiku 5.5 a Sonnet 5.5 a změří shodu kategorií s referencí a skutečnou cenu za kartu. Cíl: alespoň 90 % shody kategorií u Sonnetu. Rozdílné případy se projdou ručně, protože referenční třídění taky není neomylné. Cena testu pod 50 Kč, a než se pustí, Jan ji odsouhlasí.

## Upřesnění po recenzi (rozhodl Claude)

- **Co se nahrává:** všechno z karty, aby „zálohovaná“ znamenalo opravdu celá karta. Videa se třídí do kategorií. Ostatní soubory (fotky, zvuk, proxy, XML ze Sony a podobně) jdou beze změny do podsložky `_ostatni` se zachovanou cestou z karty. Do zálohy nepatří jen systémové soubory macOS (`._*`, `.Spotlight-V100`, `.fseventsd`, `.Trashes`, `.DS_Store`). Přehled ukáže počty obou skupin.
- **Názvy z karty:** na kartě jsou výchozí názvy kamery (`C0001`, `A75_0449`, `FX3-A_9347`, `DSC_5001`). Ruční popisky typu `FX3-A_9347_šance` se převezmou, když jsou za číslem. Když jsou před ním nebo číslo chybí, převezme se celý původní název (bez diakritiky) a popis se k němu připojí. Chronologie podle názvu platí v rámci jedné kamery. Když se v cílové složce potká stejný původní název z jiné kamery s jiným obsahem, přidá se za původní název krátká značka kamery (model z metadat, třeba `C0001-A7IV_gol.MP4`). Dovětek ` (2)` je až poslední záchrana.
- **Duplikáty a opakované vložení karty:** aplikace si vede deník (lokální databáze) všech nahraných souborů podle kontrolního součtu obsahu a původního názvu. Když se stejný klip objeví znovu (stejná karta podruhé, pokračování po pádu), v rámci stejné složky akce se nenahraje znovu, bez ohledu na to, jaký popis by mu AI dala teď. V přehledu je uvedený jako „už nahráno dřív“.
- **Místo na disku:** před startem aplikace zkontroluje volné místo na Macu (Drive pro počítač drží soubory lokálně, dokud je nenahraje). Když místo dochází, kopírování pozastaví a počká, až Drive uvolní cache. Doporučené nastavení Drive: „Streamovat soubory“.
- **Víc karet najednou:** fronta. Karty se zpracovávají jedna po druhé, další čeká. Víc karet může jít do stejné složky akce.
- **Karta jen pro čtení:** aplikace na kartu nic nezapisuje. Systémové soubory, které na připojenou kartu zapisuje samotný macOS, aplikace neovlivňuje a kartu nepřipojuje znovu v režimu jen pro čtení.
- **Instalace:** interní nepodepsaná aplikace pro Apple Silicon. Při prvním spuštění je potřeba povolit otevření v Nastavení systému a přístup k vyměnitelným svazkům. Podepisování, notarizace a automatické aktualizace nejsou ve v1.

## Rozhodnutí, která udělal Claude (ke kontrole)

- Karta se nepřejmenovává ani nemění, třídí se jen při nahrávání (Jan původně popsal přejmenování na kartě a s úpravou souhlasil).
- Nahrávání přes Google Drive pro počítač místo Drive API.
- Electron + TypeScript podle appky `email-styl`.
- Klip s chybou AI jde do `_nezařazeno` pod původním názvem. Záloha má přednost.
- Černé značky se nenahrávají.
- TOP záběry jsou označené v názvu (`_TOP_` za původním názvem) a zůstávají ve své kategorii (ne ve zvláštní složce TOP). Jan dřív zmínil složku TOP, u Istanbulu ale složky určil sám a TOP mezi nimi nebyla.
- Soupiska je volitelná a jména se do popisu dávají jen podle čitelného čísla nebo jména na dresu.
- Doprovodné soubory (XML ze Sony a podobně) se nenahrávají.

## Otevřené otázky

1. ~~Potvrzení uploadu do cloudu~~ **Rozhodnuto (Jan, 22. 10.): varianta A.** Aplikace potvrzuje ověřený zápis do složky Google Drive pro počítač. Upload do cloudu dokončí Drive na pozadí. Závěrečná hláška zní „Zapsáno a ověřeno. Drive dokončuje upload, kartu formátuj až po dokončení (ikona Drive v liště).“ Ověření v cloudu přes Drive API je možné rozšíření pro další verzi.
2. **Struktura na sdíleném disku:** Sportivea ji teprve nastaví. V1 počítá s kořenovou složkou a pod ní složkami akcí.
3. **Složka TOP:** stačí označení `_TOP_` v názvu, nebo mají TOP záběry jít navíc i do vlastní složky?
4. **Lokální model místo API:** Jan zvažuje, jestli by třídění zvládl lokální model na Mac mini. Návrh proto drží třídění za jedním rozhraním (`Classifier`), aby šlo později přidat lokální variantu (MLX / Ollama) bez přepisu zbytku. V1 jede přes Claude API. Lokální varianta se rozhodne podle výsledku testu na referenčních datech.
