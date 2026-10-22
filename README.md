# Třídění karet

Mac aplikace pro kancelářský počítač Sportivea. Kameraman zasune paměťovou kartu z natáčení, vybere akci a zmáčkne Start. Aplikace klipy přímo z karty roztřídí do kategorií (podle šablony akce), pojmenuje je podle obsahu, označí TOP záběry a zkopíruje je do složky na sdíleném Google Drivu. Každý zapsaný soubor porovná s originálem na kartě. Na konci uloží CSV s mapováním (původní název → nový název → složka).

**Aplikace nikdy nic nemaže.** Karta je jen pro čtení a na disk se jen přidává.

## Instalace na kancelářském Macu

Aplikace je interní a nepodepsaná, jen pro Apple Silicon (M1 a novější).

1. Zkopíruj `Trideni karet.app` (z `dist/Trideni karet-darwin-arm64/`, ~370 MB) do složky Aplikace.
2. První spuštění: klikni pravým tlačítkem na aplikaci a zvol **Otevřít**, potvrď **Otevřít**. Při dvojkliku macOS nepodepsanou aplikaci zablokuje.
3. Když se objeví dotaz na přístup, povol **Přístup k vyměnitelným svazkům** (jinak aplikace kartu neuvidí). Pokud ses překlikl: Nastavení systému → Soukromí a zabezpečení → Soubory a složky.

## Předpoklady

- **Google Drive pro počítač** je nainstalovaný, přihlášený účtem s právem zápisu na sdílený disk a běží (ikona v liště).
- Drive je v režimu **Streamovat soubory** (Nastavení Drivu → Google Drive). Soubory se pak po uploadu uvolní z lokálního disku a Mac se nezaplní.
- Anthropic API klíč (zadá se jednou, viz níže).

## První nastavení

Otevři **Nastavení** v aplikaci:

1. **Kořenová složka**: tlačítkem vyber složku na sdíleném disku (v `~/Library/CloudStorage/GoogleDrive-…/Sdílené disky/…`). Pod ní aplikace nabízí složky akcí a zakládá nové. Cestu nelze vepsat, jen vybrat.
2. **API klíč**: vlož klíč od Anthropic. Uloží se do Klíčenky macOS, nikam jinam.
3. **Model**: výchozí Claude Sonnet 5.5 (nejlepší poměr cena/kvalita). Jde přepnout na Opus 5.5 (dražší) nebo Haiku 5.5 (levnější).
4. **Šablony kategorií**: výchozí jsou Fotbal a Tenis. Kategorie lze přidat, přejmenovat, smazat a upravit jejich popis pro model.

## Běžné použití

1. **Zasuň kartu.** Aplikace ji pozná a otevře okno „Nová karta“.
2. Vyber **složku akce** (existující, nebo založ novou, např. `2026-10-20 Fenerbahçe – Slavia`) a **šablonu**. Volitelně vlož soupisku (číslo a jméno hráče).
3. Zmáčkni **Start**. Průběh je vidět v okně, kameraman může odejít.
4. **Počkej na zelené potvrzení**: „Zapsáno a ověřeno. Kartu můžeš vytáhnout. Drive dokončuje upload, kartu formátuj až po jeho dokončení (ikona Drive v liště).“
5. **Kartu neformátuj, dokud Drive nedokončí upload.** Potvrzení znamená, že soubory jsou správně zapsané ve složce Drivu, ne že už jsou v cloudu. Upload dělá Drive na pozadí. Karta se formátuje vždy až ve fotoaparátu.

Do zeleného potvrzení aplikace velkým textem říká „Karta ještě NENÍ zálohovaná“.

## Bezpečnostní pravidla

- **Nic se nesmaže.** Aplikace nemá žádné tlačítko pro mazání ani formátování.
- **Karta je jen pro čtení.** Na kartu se nezapisuje, nic se nepřejmenovává ani nepřesouvá.
- **Na disk se jen přidává.** Existující soubory se nepřepisují. Když název už existuje, přidá se ` (2)`, ` (3)`. Soubor se stejným obsahem z dřívějšího běhu se nenahrává znovu („už nahráno dřív“).
- **Selhání AI nezablokuje zálohu.** Klip, který se nepodařilo zařadit, jde do složky `_nezařazeno` pod původním názvem.
- Ostatní soubory z karty (fotky, zvuk, XML) jdou beze změny do složky `_ostatni`.

## Co znamená TOP a černé značky

- Kameraman po povedeném záběru dá ruku před objektiv a vznikne krátký (méně než 2 s) skoro černý klip: **černá značka**.
- Klip těsně před značkou (ze stejné kamery, nejvýš 60 s předtím) je **TOP záběr**. V názvu je `_TOP_`, např. `FX3-A_9347_TOP_sance-kacor.MP4`, a zůstává ve své kategorii.
- **Černé značky se nenahrávají**, na kartě zůstanou, v CSV jsou uvedené. Značka bez předchozího klipu je v přehledu „osiřelá“.

## Když něco nejde

- **Karta byla odpojena během běhu**: běh se zastaví, nic se nesmaže. Zasuň kartu znovu a spusť stejnou akci. Hotové soubory se poznají podle obsahu a nenahrávají se znovu.
- **Nedostatek místa**: aplikace kopírování pozastaví a čeká, až Drive uvolní místo (ukáže hlášku). Zkontroluj, že Drive je ve „Streamovat soubory“, je přihlášený a nahrává.
- **Složka akce zmizela / Drive neběží**: spusť Google Drive pro počítač, počkej na přihlášení a začni znovu. Běh skončí hláškou, nic se neztratí.
- **Klipy ve složce `_nezařazeno`**: AI selhala (síť, klíč, chyba API) nebo si nebyla jistá. Klipy jsou zálohované, jen je ručně přesuň. Zkontroluj API klíč v Nastavení.
- **Karta se neobjevila**: ověř přístup k vyměnitelným svazkům (viz Instalace) a že je karta vidět ve Finderu.
- **CSV**: v cílové složce je `_trideni_<datum-čas>.csv` se sloupci `puvodni_nazev;novy_nazev;slozka;poznamka`.

## Pro vývojáře

Stack: Electron 45, electron-vite, TypeScript (strict), React 19, Vitest, Anthropic SDK + Zod. Rozcestník viz [`CLAUDE.md`](CLAUDE.md), architektura [`docs/architecture.md`](docs/architecture.md), specifikace v `docs/superpowers/specs/`.

```
npm install                      # na čerstvém klonu případně: node node_modules/electron/install.js (stažení Electronu)
npm run dev                      # okno s HMR
npm test                         # jednotkové testy (bez skutečné karty a bez API)
TRIDENI_INTEGRATION=1 npm test   # testy se skutečnou kartou (~10 min, vyžaduje kartu Istanbul)
npm run typecheck                # tsc pro renderer i node část
npm run eval                     # přesnost klasifikátoru na referenční sadě, viz docs/eval.md (potřebuje ANTHROPIC_API_KEY)
npm run app                      # build + balíček dist/Trideni karet-darwin-arm64/Trideni karet.app
```

`npm install` (postinstall) a `npm run app` spouštějí `scripts/bundle-ffprobe.mjs`, který z Homebrew ffmpeg (`brew install ffmpeg`) složí samostatný arm64 ffprobe i s knihovnami do `resources/bin/` (viz architektura). Balíček tak funguje i na Macu bez Homebrew. Pokud `npm run app` skončí na „fetch failed“ (stažení Electronu), spusť ho znovu.
