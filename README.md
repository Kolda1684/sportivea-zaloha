# Sportivea Záloha

Aplikace pro Mac se dvěma režimy:

- **Stáhnout z Drivu**: celou složku z Google Disku stáhne soubor po souboru na externí disk (např. Elements). Každý soubor ověří, umí navázat po přerušení a stejný obsah stáhne jen jednou.
- **Nahrát kartu**: kartu z kamery roztřídí (Claude), klipy pojmenuje a zkopíruje do složky Google Drivu pro počítač. Drive je pak nahraje.

Nahrazuje dřívější aplikace Stahování z Disku a Třídění karet. Umí totéž co ony.

## Instalace

Postup pro firemní Mac (i pro jakýkoli jiný Mac): [docs/company-mac-install.md](docs/company-mac-install.md).

Na Janově Macu aplikace při prvním spuštění jednou zkopíruje nastavení a deník z Třídění karet (originály zůstanou beze změny). Klíč ke Claude a přihlášení ke Googlu se zadají znovu.

## Úvodní obrazovka

Dvě volby, **Stáhnout z Drivu** a **Nahrát kartu**. Když některý režim běží, je u něj vidět stav (např. „Stahuje se – 34 %“). Kliknutím na **Sportivea Záloha** nahoře se vrátíš na úvod, běh se tím nepřeruší. **Nastavení** (nahoře vpravo) obsahuje Google účet a vše pro třídění karet.

Stahování a nahrávání karty můžou běžet zároveň. Když vložíš kartu během stahování, aplikace přepne na „Nová karta“ a stahování běží dál.

## Zavření během běhu

Když běží stahování nebo záloha karty a zavřeš okno nebo aplikaci (Cmd+Q), aplikace se zeptá. **Pokračovat ve stahování** / **Nechat běžet** (výchozí) nechá běh pokračovat. **Zastavit a zavřít** zastaví všechno, co běží, počká (nejvýš 10 s) a zavře. Nic se nesmaže: stahování příště naváže, kartu po dalším vložení dozálohuješ, když vybereš stejnou akci (hotové soubory se znovu nenahrají).

# Stáhnout z Drivu

## Přihlášení

Při prvním vstupu do režimu se přihlas tlačítkem **Přihlásit se přes Google**. Otevře se prohlížeč, přihlas se firemním účtem a potvrď oprávnění ke čtení. Přihlásit se dá jen účtem z organizace Sportivea. Aplikace si přihlášení pamatuje.

## Běžné použití

1. Zkopíruj z Google Disku odkaz na složku (pravé tlačítko → Sdílet → Kopírovat odkaz, nebo adresa z prohlížeče) a vlož ho do aplikace. Zmáčkni **Načíst složku**.
2. Aplikace složku prohledá a ukáže počet souborů, podsložek, celkovou velikost a kolik položek přeskočí. Když jsou ve složce soubory se stejným obsahem (duplikáty), napíše kolik a stáhne je jen jednou.
3. Zmáčkni **Vybrat cíl na externím disku** a vyber složku na disku. V ní se založí složka se stejným názvem jako na Disku. Cestu nelze vepsat, jen vybrat.
4. Aplikace zkontroluje cíl: volné místo, formát disku, jestli v cílové složce už něco je. Pokud je něco špatně, ukáže důvod a Start je vypnutý. Žluté varování Start nevypne (např. „Cíl je na disku Macu, ne na externím disku.“).
5. Zmáčkni **Start**. Soubory se stahují jeden po druhém, je vidět průběh, rychlost a odhad zbývajícího času. Mac se během stahování neuspí — ale nezavírej víko notebooku.
6. **Počkej na zelené „Hotovo — staženo a ověřeno“.** Teprve pak je kompletní. Až do té doby aplikace velkým textem říká „Stahování NENÍ dokončené“.
7. Tlačítkem **Otevřít ve Finderu** otevřeš výsledek. V cílové složce je i CSV se seznamem. Na konci aplikace vypíše přeskočené a selhané položky s důvodem (nejvýš 20 od každého, celý seznam je v CSV).

Zavření okna nebo aplikace během stahování: viz „Zavření během běhu“ níže.

## Co znamená „Hotovo“

Zelené „Hotovo — staženo a ověřeno“ se ukáže jen když je každý soubor z plánu buď:

- stažený a ověřený (velikost + MD5 souhlasí s Googlem), nebo
- exportovaný z Google Dokumentů, nebo
- už dřív stažený a stále na disku, nebo
- výslovně přeskočený (zástupce, formulář a jiné typy, které nejde stáhnout) a uvedený v CSV, nebo
- duplikát souboru, který už na disku je.

Jakýkoli selhaný soubor znamená „Stahování NENÍ dokončené“ s výpisem, co selhalo a proč. **Soubor, u kterého vlastník zakázal stahování, je selhaný, ne přeskočený** („vlastník zakázal stahování“), takže složka s ním nikdy není „Hotovo“. Tlačítkem **Zkusit selhané znovu** se zkusí znovu (hotové soubory se nestahují znovu; u souborů se zakázaným stahováním se aplikace zeptá Googlu znovu).

**Duplikáty:** soubory se stejným obsahem (stejné MD5 a velikost podle Googlu) se stáhnou jen jednou, první výskyt v pořadí složek (nejdřív horní složka, pak podsložky, uvnitř podle abecedy). Ostatní kopie se nestáhnou; v CSV mají stav `duplikát (nestaženo)` a důvod „stejný obsah jako <cesta>“. Když se první výskyt nepodaří stáhnout, stáhne se místo něj další kopie. Google Dokumenty a soubory bez MD5 se za duplikáty nikdy nepovažují.

Soubor, ke kterému Google neuvádí MD5, se ověří jen podle velikosti; v CSV má důvod „ověřena jen velikost (Google neuvádí MD5)“ a počítá se jako stažený.

CSV (`_seznam_souboru_<datum-čas>.csv` v cílové složce, sloupce `cesta_na_disku;cesta_na_google_disku;velikost_B;md5;stav;duvod`) po doběhnutí obsahuje každou položku plánu. Po zastavení (Zastavit, odpojený disk, vypršené přihlášení, plný disk) obsahuje jen položky, ke kterým se běh dostal. Poslední řádek `CELKEM` je součet bytů všech souborů z tohoto seznamu, které jsou na disku, i těch z dřívějších běhů. Stav je `kompletní`, nebo `NEKOMPLETNÍ` s důvodem. CSV se nikdy nepřepisuje, další běh vytvoří nový soubor.

## Google Dokumenty, Tabulky, Prezentace

Nejdou stáhnout tak jak jsou, aplikace je exportuje: Dokument → `.docx`, Tabulka → `.xlsx`, Prezentace → `.pptx`, Kresba → `.png`. Zástupci (shortcuty) a ostatní typy Google souborů (formuláře, mapy…) se přeskočí a uvedou se v CSV.

## Pokračování po přerušení

Stahování lze kdykoli zastavit (**Zastavit**, nebo zavřením aplikace přes **Zastavit a zavřít**), nebo se přeruší samo (odpojený disk, výpadek přihlášení, plný disk, vypnutý Mac). Nic se nesmaže a rozepsaný soubor zůstane na disku. Vyber stejnou složku z Disku a stejný cíl, aplikace napíše „Navazuji na stahování z…“ a pokračuje:

- Hotové soubory se poznají podle záznamu `.stahovani/journal.jsonl` v cílové složce a **nestahují se znovu**. Kontroluje se jen velikost a datum změny souboru na disku (MD5 se znovu nepočítá, ověřilo se při zápisu; posun času přesně o 1 hodinu se toleruje kvůli FAT/exFAT a změně času).
- Rozepsaný velký soubor pokračuje od místa, kde skončil (HTTP Range), a MD5 se přesto ověří z celého souboru.
- Soubor, který už v cíli leží se stejnou velikostí a MD5 jako na Disku (např. po pádu nebo ručně zkopírovaný), se přebere jako „už staženo“ a nestahuje se znovu.
- **Soubor, který se mezitím na Disku změnil**, se nepřepíše: nová verze se stáhne vedle staré s příponou ` (2)`, ` (3)` a v CSV je „změněno na Disku (nová kopie)“.

Hlášky při zastavení: „Externí disk se odpojil. Připoj ho a dej Pokračovat.“, „Přihlášení vypršelo. Přihlas se znovu a dej Pokračovat.“, „Na disku došlo místo. Uvolni místo nebo připoj jiný disk a dej Pokračovat.“ (v CSV „na disku došlo místo“; rozepsaný soubor zůstane).

Když se okno aplikace otevře znovu, zatímco stahování běží, ukáže rovnou průběh.

Rozdělané stahování ze staré aplikace Stahování z Disku dokončíš tady stejně: stejný odkaz, stejný cíl.

## Disk a názvy souborů

- **FAT32 aplikace odmítne**, pokud je v plánu soubor větší než 4 GB (FAT32 takový soubor neunese). Použij disk ve formátu exFAT nebo APFS. Když se formát disku nepodaří zjistit, ukáže se varování „Nepodařilo se zjistit formát disku. Pokud je to FAT32, soubory nad 4 GB se nestáhnou.“ (Start zůstane zapnutý).
- Cíl nesmí být složka Google Disku pro počítač (`~/Library/CloudStorage/…`): „Vyber externí disk, ne složku Google Disku.“
- Musí být dost volného místa, jinak „Na disku chybí X GB.“
- Varování (Start zůstane zapnutý): „Cíl je na disku Macu, ne na externím disku.“ (vybraná složka je na stejném svazku jako systém). „Vybraná složka vypadá jako cíl dřívějšího stahování. Pro navázání vyber složku o úroveň výš.“ (ve vybrané složce už je `.stahovani/journal.jsonl`, nebo se jmenuje stejně jako složka z Disku).
- Názvy se upraví jen tam, kde to disk vyžaduje: zakázané znaky (`/ \ : * ? " < > |` a řídicí znaky) se nahradí `-`, koncové mezery a tečky se odříznou, název se zkrátí na 255 bajtů (přípona se zachová). Dva soubory se stejným názvem v jedné složce (i když se liší jen velikostí písmen, což disk exFAT/APFS nerozliší) dostanou ` (2)`, ` (3)` podle data vytvoření.
- Skryté soubory `.<id>.partial` jsou rozepsané soubory (`<id>` je ID souboru na Disku). Aplikace maže nebo zakládá znovu jen tyto svoje dočasné soubory (např. když rozepsaný soubor nejde navázat). Soubor `.<id>.bad` je stažení, které neprošlo ověřením (ponechá se jako důkaz); ten aplikace nikdy nemaže. Obojí klidně smaž ručně, až stahování skončí a nepotřebuješ je.

## Bezpečnostní pravidla

- **Na Google Disku se nic nemění.** Oprávnění je jen `drive.readonly`, aplikace posílá jen čtecí požadavky (GET).
- **Na disk se jen přidává.** Existující soubor se nikdy nepřepíše, nesmaže ani nepřesune. Aplikace maže jen vlastní dočasné soubory.
- **Soubor je „stažený“ až po ověření** (velikost a MD5) a zapsání do záznamu.
- **„Hotovo“ jen když je vše ověřené nebo výslovně přeskočené.**
- Stahuje se po jednom souboru.
- Když je záznam `.stahovani/journal.jsonl` v cíli poškozený (není to běžný soubor), běh se zastaví s hláškou „Záznam o stahování v cílové složce je poškozený. Vyber jiné místo.“, protože by nešlo bezpečně navázat.
- Aplikace běží v izolovaném okně (sandbox, striktní CSP, žádný přístup z webu k disku). Cíl jde vybrat jen přes systémový dialog.

## Kde je přihlášení a jak se odhlásit

Přihlašovací token (refresh token) je uložený šifrovaně v Klíčence macOS (Electron `safeStorage`) v souboru `~/Library/Application Support/sportivea-zaloha/google-token.bin`. Nikdy není v čistém textu, v logu ani v gitu.

**Odhlásit** (nahoře v režimu Stáhnout z Drivu, nebo v Nastavení → Google účet): smaže token a zruší ho u Googlu. Během stahování se odhlásit nejde (tlačítko je vypnuté: „Během stahování se odhlásit nejde.“). Přístup můžeš zrušit i na https://myaccount.google.com/permissions.

## Když něco nejde

- **„Složku se nepodařilo najít“ / „K téhle složce nemáš přístup“**: zkontroluj odkaz a že máš ke složce přístup ve svém účtu.
- **Přihlášení vypršelo**: přihlas se znovu a dej Pokračovat.
- **Soubor selhal s důvodem „vlastník zakázal stahování“**: vlastník souboru zakázal jeho stažení (aplikace se kvůli tomu Googlu ani neptá). Stahování proto NENÍ dokončené. Požádej vlastníka o povolení a dej **Zkusit selhané znovu**: aplikace se zeptá Googlu znovu a soubor stáhne, pokud už to jde.
- **„Na disku došlo místo“**: uvolni místo nebo připoj jiný disk a dej Pokračovat.
- **„výpadek spojení, zkus znovu“**: spojení se opakovaně přerušilo. Zkontroluj internet a dej Zkusit selhané znovu (rozepsaný soubor se naváže).
- **„Google dočasně omezil stahování tohoto souboru, zkus to později“**: denní limit Googlu pro soubor. Zkus **Zkusit selhané znovu** za několik hodin.
- **„soubor se stáhl poškozený“**: MD5 nesouhlasí ani po druhém pokusu. Poškozená data zůstala jako `.<id>.bad`. Zkus selhané znovu.
- **Záznam o stahování je poškozený**: viz bezpečnostní pravidla, vyber jiné místo.

# Nahrát kartu

## Předpoklady

- **Google Drive pro počítač** je nainstalovaný, přihlášený účtem s právem zápisu na sdílený disk a běží (ikona v liště).
- Drive je v režimu **Streamovat soubory** (Nastavení Drivu → Google Drive). Soubory se pak po uploadu uvolní z lokálního disku a Mac se nezaplní.
- Anthropic API klíč (zadá se jednou, viz níže). Bez klíče jde kartu aspoň **jen nahrát** (beze změny).

## První nastavení

Otevři **Nastavení** v aplikaci:

1. **Kořenová složka** (výchozí cíl): tlačítkem vyber složku na sdíleném disku (v `~/Library/CloudStorage/GoogleDrive-…/Sdílené disky/…`). Pod ní aplikace nabízí složky akcí a zakládá nové. Cestu nelze vepsat, jen vybrat. Jde ji změnit i přímo na obrazovce „Nová karta“.
2. **API klíč**: vlož klíč od Anthropic. Uloží se do Klíčenky macOS, nikam jinam.
3. **Model**: výchozí Claude Sonnet 5.5 (nejlepší poměr cena/kvalita). Jde přepnout na Opus 5.5 (dražší) nebo Haiku 5.5 (levnější).
4. **Šablony kategorií**: výchozí jsou Fotbal a Tenis. Kategorie lze přidat, přejmenovat, smazat a upravit jejich popis pro model.

## Běžné použití

1. **Zasuň kartu.** Aplikace ji pozná a otevře okno „Nová karta“.
2. Zkontroluj **Kam nahrát**: nahoře je vidět cílová složka na Disku (naposledy použitá), tlačítkem **Změnit složku** vybereš jinou.
3. Vyber **složku akce** (existující, nebo založ novou, např. `2026-10-20 Fenerbahçe – Slavia`) a **šablonu**. Volitelně vlož soupisku (číslo a jméno hráče).
4. Zmáčkni **Start**. Průběh je vidět v okně, kameraman může odejít.
   **Co s kartou** (nahoře na obrazovce):
   - **Roztřídit a pojmenovat** (výchozí): klipy do složek podle šablony, názvy s popisem.
   - **Jen pojmenovat**: Claude klipy pojmenuje, ale všechny jdou rovnou do složky akce, bez podsložek kategorií. Šablona se nevybírá, soupiska funguje. Černé značky se nenahrávají, TOP se pozná, ostatní soubory jdou do `_ostatni`. Klip, který se nepodaří popsat, zůstane pod původním názvem.
   - **Jen nahrát**: bez Clauda a bez klíče. Všechny soubory z karty (i černé značky) s původními názvy rovnou do složky akce, bez podsložek. Stejný název s jiným obsahem dostane ` (2)`.
   Bez uloženého API klíče jde jen **Jen nahrát**. Ověření, „už nahráno dřív“ a CSV fungují ve všech třech stejně.
5. **Počkej na zelené potvrzení**: „Zapsáno a ověřeno. Kartu můžeš vytáhnout. Drive dokončuje upload, kartu formátuj až po jeho dokončení (ikona Drive v liště).“
6. **Kartu neformátuj, dokud Drive nedokončí upload.** Potvrzení znamená, že soubory jsou správně zapsané ve složce Drivu, ne že už jsou v cloudu. Upload dělá Drive na pozadí. Karta se formátuje vždy až ve fotoaparátu.

Do zeleného potvrzení aplikace velkým textem říká „Karta ještě NENÍ zálohovaná“.

## Bezpečnostní pravidla

- **Nic se nesmaže.** Aplikace nemá žádné tlačítko pro mazání ani formátování.
- **Karta je jen pro čtení.** Na kartu se nezapisuje, nic se nepřejmenovává ani nepřesouvá.
- **Na disk se jen přidává.** Existující soubory se nepřepisují. Když název už existuje, přidá se ` (2)`, ` (3)`. Soubor se stejným obsahem z dřívějšího běhu se nenahrává znovu („už nahráno dřív“).
- **Selhání AI nezablokuje zálohu.** Klip, který se nepodařilo zařadit, jde do složky `_nezařazeno` pod původním názvem. Když AI selže 5× po sobě (síť, výpadek), aplikace se jí přestane ptát a zbytek zálohuje do `_nezařazeno`; na konci napíše „AI nedostupná — zbytek zálohován bez třídění.“
- Ostatní soubory z karty (fotky, zvuk, XML) jdou beze změny do složky `_ostatni`. Patří sem i proxy a náhledy ze Sony (`M4ROOT/SUB/`, `M4ROOT/THMBNL/`): netřídí se, neposílají se AI a nepočítají se jako klipy ani pro TOP.
- Když se karta během zálohy vymění (stejné názvy, jiná velikost souboru), běh se zastaví jako při odpojení karty.

## Co znamená TOP a černé značky

- Kameraman po povedeném záběru dá ruku před objektiv a vznikne krátký (méně než 2 s) skoro černý klip: **černá značka**.
- Klip těsně před značkou (ze stejné kamery, nejvýš 60 s předtím) je **TOP záběr**. V názvu je `_TOP_`, např. `FX3-A_9347_TOP_sance-kacor.MP4`, a zůstává ve své kategorii.
- **Černé značky se nenahrávají**, na kartě zůstanou, v CSV jsou uvedené. Značka bez předchozího klipu je v přehledu „osiřelá“.

## Když něco nejde

- **Karta byla odpojena během běhu**: běh se zastaví, nic se nesmaže. Zasuň kartu znovu a spusť stejnou akci. Hotové soubory se poznají podle obsahu a nenahrávají se znovu.
- **Nedostatek místa**: aplikace kopírování pozastaví a čeká, až Drive uvolní místo (ukáže hlášku). Zkontroluj, že Drive je ve „Streamovat soubory“, je přihlášený a nahrává.
- **Složka akce zmizela / Drive neběží**: spusť Google Drive pro počítač, počkej na přihlášení a začni znovu. Běh skončí hláškou, nic se neztratí.
- **Klipy ve složce `_nezařazeno`**: AI selhala (síť, klíč, chyba API) nebo si nebyla jistá. Klipy jsou zálohované, jen je ručně přesuň. Zkontroluj API klíč v Nastavení.
- **Karta se neobjevila**: ověř přístup k vyměnitelným svazkům (viz Instalace) a že je karta vidět ve Finderu. Kartu, kterou ještě nejde přečíst, aplikace zkouší znovu každých pár sekund.
- **„Chybí nástroj ffprobe/ffmpeg — aplikace je poškozená, kontaktuj Jana.“**: balíček aplikace je neúplný, zálohu nejde spustit. Je potřeba nový balíček (`npm run app`).
- **Skryté soubory `.<název>.partial`** ve složce akce (v podsložkách): dočasné soubory z přerušeného nebo neúspěšného běhu (soubor, který neprošel ověřením, nebo kopie rozepsaná při pádu aplikace). Klidně je smaž ručně; aplikace je sama nikdy nemaže. Při dalším běhu se soubor zkopíruje znovu.
- **CSV**: v cílové složce je `_trideni_<datum-čas>.csv` se sloupci `puvodni_nazev;novy_nazev;slozka;poznamka`.

# Pro vývojáře

```bash
npm install          # stáhne závislosti a sestaví přibalený ffprobe (potřebuje brew install ffmpeg)
npm run dev          # vývojové okno (potřebuje .env s OAuth klientem)
npm test             # testy obou režimů
npm run typecheck
npm run app          # balíček + kontroly + dist/Sportivea-Zaloha.zip
```

Podrobnosti: `CLAUDE.md` a `docs/architecture.md`.
