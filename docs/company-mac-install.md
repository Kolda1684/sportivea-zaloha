# Instalace na firemní Mac

Návod pro Jana. Aplikace **Sportivea Záloha** nahrazuje Stahování z Disku i Třídění karet.

## Co musí firemní Mac splňovat

- Mac s čipem Apple (M1, M2…). Firemní M2 s 8 GB stačí.
- **Google Drive pro počítač** je nainstalovaný a přihlášený účtem **video@sportivea.cz**. Ten účet musí mít právo zápisu do sdíleného disku, kam se karty nahrávají.
- Všichni editoři pracují pod **jedním uživatelem macOS**. Klíčenka, nastavení i paměť nahraných karet patří uživateli macOS, takže se všechno nastavuje jednou.
- Kdo aplikaci instaluje a aktualizuje, potřebuje **heslo správce** toho Macu.

## 1. Přenést aplikaci

1. Na svém Macu spusť v projektu `npm run app`. Vznikne soubor `dist/Sportivea-Zaloha.zip`.
2. Pošli ho na firemní Mac (AirDrop, nebo přes Google Drive).
3. Na firemním Macu ho rozbal dvojklikem a aplikaci **Sportivea Záloha** přetáhni do složky **Aplikace**.

Instaluj vždy ze zipu, ne ze složky `dist/…` na svém Macu.

## 2. První spuštění

Aplikace není podepsaná u Applu, takže ji macOS napoprvé zablokuje:

1. Otevři aplikaci. macOS ohlásí, že ji nejde ověřit. Dej **Hotovo**.
2. **Nastavení systému → Soukromí a zabezpečení**, sjeď dolů a u „Sportivea Záloha“ dej **Přesto otevřít** (zadáš heslo správce).
3. Při práci se macOS zeptá na přístupy: k **vyměnitelným svazkům** (karty, disk Elements), ke složce **Google Drive** a na **oznámení**. Všechno povol.

## 3. Nastavení v aplikaci (jednou)

1. **Nastavení → Klíč ke Claude:** vlož API klíč. Uloží se do Klíčenky tohoto Macu. Třídění se platí z API kreditů, orientačně 0,5–9 Kč za kartu podle modelu.
2. **Nastavení → Složka pro akce:** vyber kořenovou složku na sdíleném disku uvnitř složky Google Drivu.
3. **Stáhnout z Drivu → Přihlásit se přes Google:** přihlas účet **video@sportivea.cz**. Složky, které se mají stahovat, musí být s tímhle účtem sdílené.

### Volitelně: tvoje šablony a soupisky

Chceš, aby firemní Mac začal s tvými šablonami, soupiskami a prahem černé značky? Pak **před prvním spuštěním** zkopíruj soubor `settings.json` ze svého Macu:

- odkud: `~/Library/Application Support/sportivea-zaloha/settings.json` (na tvém Macu)
- kam: na stejné místo na firemním Macu (složku `sportivea-zaloha` případně založ)

Ve Finderu se tam dostaneš přes **Otevřít → Otevřít složku…** (Cmd+Shift+G) a cestu `~/Library/Application Support/`. Pokud soubor nezkopíruješ, aplikace začne s výchozím nastavením.

## 4. Aby se aplikace ozvala na kartu i po restartu

Aplikace pozná kartu, jen když běží. **Nastavení systému → Obecné → Položky při přihlášení → +** a přidej **Sportivea Záloha**.

## Pravidla

- **Jednu kartu nahrávej jen na jednom počítači.** Každý Mac si pamatuje jen svoje nahrané karty. Kdyby se stejná karta nahrála na dvou Macích do stejné akce, nic se nesmaže ani nepřepíše, jen vzniknou kopie s „(2)“.
- Po instalaci **nové verze** se macOS může jednou zeptat na heslo uživatele kvůli Klíčence. Zadej ho a dej **Vždy povolit**. Kdybys dal Zamítnout, aplikace nepřečte klíč ke Claude (karty se pak jen zazálohují bez třídění) a požádá o nové přihlášení ke Googlu.
- Na **tvém Macu**: po instalaci nové aplikace už nespouštěj staré Stahování z Disku a Třídění karet. Hlavně Třídění karet, protože by se na stejnou kartu ozvaly obě. Rozdělané stahování ze staré aplikace dokončíš v nové: vlož stejný odkaz a vyber stejný cíl. Staré aplikace smaž, až budeš spokojený.

## Aktualizace

Stáhni nový zip, starou aplikaci ve složce Aplikace nahraď novou. Nastavení, klíč i přihlášení zůstanou. Jen se může objevit dotaz na Klíčenku, viz výše.

## Google Cloud (už nastavené, jen pro informaci)

Projekt `stahovani-z-disku`, Google Drive API zapnuté, Google Auth Platform typu **Internal** (přihlásí se jen účet `@sportivea.cz`), klient typu Desktop app. ID a tajný klíč klienta jsou v `.env` na tvém Macu a při `npm run app` se vloží do aplikace. Firemní Mac `.env` nepotřebuje.
