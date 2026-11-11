# Sportivea Záloha — návrh (spojení Stahování z Disku + Třídění karet)

Jedna aplikace pro Mac, která nahradí dvě dnešní: **Stahování z Disku** (celá složka z Google Disku → externí disk) a **Třídění karet** (karta z kamery → roztřídit, pojmenovat → složka Google Drivu). Umí přesně to, co obě umí dnes. Nic nového se nepřidává, mění se jen to, že je to jedna aplikace a že jde nainstalovat na firemní počítač.

Chování každého režimu se řídí původními návrhy, které platí dál, pokud tento dokument neříká jinak:
- Stahování: `stahovani-z-disku/docs/superpowers/specs/2026-10-26-stahovani-z-disku-design.md` + `docs/architecture.md` (větev `feat/v1`)
- Třídění: `trideni-karet/docs/superpowers/specs/2026-10-22-trideni-karet-design.md` + `docs/architecture.md` (větev `main`)

## Proč

- Jan chce jednu aplikaci místo dvou: „jedna – stahování věcí z disku + nahrávání věcí na disk, třídění + pojmenování“.
- Aplikace se má přenést na firemní počítač, kde ji budou používat **editoři**, ne jen Jan. Dnešní aplikace závisí na Janově vývojovém prostředí (`.env`, Homebrew při buildu, Klíčenka jeho Macu).

**Úspěch:** na firemním Macu se nainstaluje jeden soubor `.app`. Editor vloží kartu a aplikace se sama ozve. Nebo otevře aplikaci a stáhne složku z Drivu na disk Elements. Obojí funguje stejně spolehlivě jako dnes a nic z Janova počítače k tomu není potřeba.

## Cíle

1. Jedna aplikace, dva režimy: **Stáhnout z Drivu** a **Nahrát kartu**. Obojí se chová stejně jako dnešní aplikace.
2. Instalace na firemní Mac (Apple M2, 8 GB RAM, Google Drive pro počítač nainstalovaný, obecný účet `video@sportivea.cz`) bez vývojářských nástrojů: zkopírovat `.app`, při prvním spuštění se přihlásit ke Googlu a vložit klíč ke Claude.
3. Postup instalace sepsaný česky, aby ho Jan zvládl sám.
4. Na Janově Macu poběží vedle dnešních dvou aplikací, dokud je nenahradí.

## Bezpečnostní pravidla (nepřekročitelná, beze změny převzatá z obou aplikací)

- **Na Google Disku aplikace nic nemění.** Přihlášení ke Googlu má jen oprávnění ke čtení (`drive.readonly`), dotazy jsou jen GET. Nahrávání karet nejde přes Google API, ale kopírováním do složky Google Drivu pro počítač, takže aplikace nikdy nepotřebuje právo zápisu na Drive.
- **Karta se jen čte.** Nikdy se do ní nezapisuje, nic se na ní nepřejmenuje, nesmaže ani nenaformátuje.
- **Na cíli se jen přidává** (externí disk i složka Drivu). Nic se nepřepisuje, nemaže ani nepřesouvá. Výjimkou jsou jen vlastní dočasné soubory aplikace, přesně podle pravidel původních aplikací.
- **„Hotovo“ / „Zapsáno a ověřeno“** jen když je ověřený každý soubor. Texty „NENÍ dokončené“ / „Karta ještě NENÍ zálohovaná“ se nepřeformulovávají.
- **Tajné údaje** (Google refresh token, klíč ke Claude) jen v Klíčence daného Macu přes Electron `safeStorage`, nikdy v souboru jako text, v kódu, logu, rendereru ani gitu. OAuth client ID/secret jen v `.env` na Janově Macu, při buildu se vloží jen do main bundlu (jako dnes).
- Zabezpečení okna jako dnes: `sandbox`, `contextIsolation`, žádný `nodeIntegration`, striktní CSP, každý IPC handler kontroluje odesílatele a validuje vstup Zodem. Žádné `any`.

## Co to nebude dělat

- Žádné nové funkce v režimech: žádné nahrávání libovolné složky na Drive, žádné nahrávání přes Google API, žádné AI přejmenování stažených souborů (Jan: „zbytečné“).
- Žádné podepsání u Applu, notarizace ani automatické aktualizace. Nová verze = nový `.app`.
- Jen Mac s čipem Apple (arm64), žádný Intel.

**Selhání, i kdyby to technicky fungovalo:** spojením se cokoli z dnešního chování rozbije nebo zmírní (ověřování, navazování, duplicity, TOP, jistič AI…). Aplikace na firemním Macu nejde spustit bez Janova počítače. Nová aplikace zasáhne do dnešních nainstalovaných aplikací nebo jejich dat.

## Jak se to používá

### Úvodní obrazovka
Dvě velké volby: **Stáhnout z Drivu** a **Nahrát kartu**, a odkaz **Nastavení**. Když některý režim právě běží, je u jeho volby vidět stav (např. „Stahuje se – 34 %“, „Karta SONY_A75 – třídí se“) a klik vede rovnou na jeho průběh. Z obrazovek obou režimů vede tlačítko zpět na úvod; běh se tím nepřeruší.

### Stáhnout z Drivu
Stejné obrazovky a chování jako dnešní Stahování z Disku (přihlášení → odkaz → cíl → průběh → hotovo, navazování, duplicity, CSV). Přihlášení ke Googlu se objeví až při vstupu do tohoto režimu, ne při spuštění aplikace. Odhlášení je v Nastavení a během stahování nejde (jako dnes).

### Nahrát kartu
Stejné obrazovky a chování jako dnešní Třídění karet (klidový stav „Zasuň kartu“ → nová karta → průběh → hotovo, Zálohovat bez třídění bez klíče). Aplikace sleduje `/Volumes` celou dobu, kdy běží, v kterémkoli režimu. Když se objeví karta, okno se vytáhne dopředu a ukáže „Nová karta“ jako dnes, i když jsi zrovna ve stahování.

### Souběh
Stahování z Drivu a nahrávání karty smějí běžet **zároveň**: každé zapisuje jinam a obě mají vlastní deník. Uvnitř režimu platí dnešní limity (jedno stahování najednou, jedna karta najednou ve frontě).

### Zavření a ukončení
Když běží stahování nebo nahrávání karty, zavření okna i ukončení aplikace se zeptá (dnešní dialog ze Stahování, rozšířený o běh karty). „Zastavit a zavřít“ zastaví všechno, co běží.

### Nastavení
Jedna obrazovka se dvěma částmi:
- **Google účet:** přihlášený účet, odhlásit.
- **Třídění karet:** vše, co je v dnešním Nastavení Třídění karet (kořenová složka „Kam nahrát“, klíč ke Claude, model, šablony, práh, kurz).

### První spuštění na novém Macu
Aplikace nic nevyžaduje předem. Bez přihlášení ke Googlu nejde jen stahování. Bez klíče ke Claude se karta jen zazálohuje bez třídění. Bez nastavené kořenové složky se aplikace o ni řekne u první karty (jako dnes).

## Data aplikace a soužití se starými aplikacemi

- Nová aplikace má vlastní jméno, vlastní bundle ID a vlastní složku dat `~/Library/Application Support/sportivea-zaloha/`. Do dat dnešních aplikací (`stahovani-z-disku/`, `trideni-karet/`) nikdy nezapisuje a jejich `.app` v `/Applications` nemění.
- **Deník stahování** leží na cílovém disku (`<cíl>/<složka>/.stahovani/journal.jsonl`) a nová aplikace ho čte a zapisuje ve stejném formátu. Stahování rozdělané ve staré aplikaci se v nové dá dokončit.
- **Převzetí z Třídění karet (jednorázově, jen čtení):** při prvním spuštění, pokud na Macu existuje `~/Library/Application Support/trideni-karet/settings.json` a `journal.jsonl`, nová aplikace si je zkopíruje do svých dat (originály zůstanou beze změny). Klíč ke Claude a přihlášení ke Googlu se nepřebírají, protože Klíčenka je vázaná na aplikaci, a zadají se znovu.

### Dva Macy (rozhodl Jan)
Karty se budou nahrávat hlavně na firemním Macu, občas i na Janově. Jan: „udělej to jako lokální apku“. Každý Mac je tedy samostatný: vlastní nastavení, vlastní deník nahraných karet, nic se mezi nimi nesynchronizuje. Důsledek: Mac nepozná kartu nahranou na druhém Macu. Kdyby se stejná karta nahrála na obou do stejné složky akce, nic se nesmaže ani nepřepíše, ale vzniknou kopie ` (2)`. Návod to řekne jednou větou („jednu kartu nahrávej jen na jednom počítači“).

### Soužití se starými aplikacemi na Janově Macu
Nová aplikace nebrání souběhu se starými (to by znamenalo do nich zasahovat). Návod řekne: po instalaci nové aplikace staré nespouštěj. Hlavně Třídění karet, protože by se na stejnou kartu ozvaly obě. Staré aplikace z `/Applications` odstraní Jan sám, až bude spokojený.

## Firemní počítač (Apple M2, 8 GB, `video@sportivea.cz`)

Co musí platit (sepsat do instalačního návodu):
- Jeden uživatel macOS pro všechny editory. Klíčenka, nastavení, deník karet i přihlášení Drivu pro počítač patří uživateli macOS, takže se nastavují jednou.
- Výchozí nastavení třídění: aby firemní Mac začal s Janovými šablonami, soupiskami a prahem, návod popíše, jak před prvním spuštěním zkopírovat Janův `settings.json` do `~/Library/Application Support/sportivea-zaloha/` na firemním Macu. Bez toho začne s výchozím nastavením. Deník karet se nekopíruje.
- Aby se aplikace ozvala na kartu i po restartu Macu, musí běžet. Návod popíše, jak ji přidat do Nastavení systému → Obecné → Položky při přihlášení. Aplikace sama nic takového nenastavuje.
- Po instalaci nové verze se macOS může jednou zeptat na heslo uživatele kvůli přístupu do Klíčenky („Vždy povolit“). Je to kvůli tomu, že aplikace není podepsaná u Applu. Kdo aktualizuje, musí znát heslo uživatele a mít práva správce (potřebná i pro „Přesto otevřít“).
- macOS na Apple Silicon. Google Drive pro počítač přihlášený účtem s právem zápisu do sdíleného disku, kam se karty nahrávají.
- Přihlášení ke Googlu v aplikaci: OAuth klient v Google Cloud projektu `stahovani-z-disku` je typu Internal, takže funguje pro každý účet `@sportivea.cz`, tedy i `video@sportivea.cz`. Složky, které se mají stahovat, musí být sdílené s účtem, kterým se v aplikaci přihlásí.
- Klíč ke Claude: Jan ho vloží v Nastavení na firemním Macu. Uloží se do Klíčenky toho Macu. Platí se z Janových API kreditů (orientačně 0,5–9 Kč za kartu podle modelu).
- Instalace: zkopírovat `Sportivea Záloha.app` do `/Applications`. Aplikace není podepsaná u Applu, takže první spuštění zablokuje macOS. Návod popíše, jak ji povolit (Nastavení systému → Soukromí a zabezpečení → Přesto otevřít) a jaká oprávnění macOS ještě vyžádá (přístup k vyměnitelným svazkům, ke složce Google Drivu, notifikace).
- Balíček nesmí ničím odkazovat na Janův Mac: žádné čtení `.env` za běhu, žádné cesty do `/opt/homebrew` (ffprobe je přibalený jako dnes), žádné cesty do `/Users/kolda`.

## Technické rozhodnutí

- Obě aplikace mají stejný základ (Electron 45, electron-vite 6, React 19, TypeScript 7, Zod 4, Vitest 5, @electron/packager 20, stejné verze). Spojení = přesunout kód obou do jednoho projektu, ne psát znovu.
- Nový projekt `sportivea-zaloha/` vedle obou původních. Původní repozitáře se nemění. Do GitHubu jen když Jan řekne.
- Všechny testy obou aplikací musí v novém projektu projít.

## Co je na staviteli

Rozdělení kódu do složek, sloučení IPC kanálů a typů, jak se sloučí dvě `Runner` třídy a dva `index.ts`, podoba úvodní obrazovky a stavu běhu, jak se ověří „běží na druhém Macu bez vývojového prostředí“, ikona aplikace.

## Rozhodnutí, která udělal Claude (ke kontrole)

- Jméno aplikace **Sportivea Záloha** a složka projektu `sportivea-zaloha/`.
- Přihlášení ke Googlu až při vstupu do stahování, ne při spuštění.
- Stahování a nahrávání karty smějí běžet zároveň; karta se ohlásí i během stahování.
- Jednorázové převzetí nastavení a deníku z Třídění karet (jen čtení) na Janově Macu.
- Žádné podepsání ani notarizace u Applu (stejně jako dnes); instalační návod místo toho popíše povolení v Nastavení systému. Po každé nové verzi se tak může jednou objevit dotaz na Klíčenku.
- Na firemním Macu jeden uživatel macOS pro všechny editory.
- Janovo nastavení třídění se na firemní Mac přenese ručním zkopírováním `settings.json` podle návodu, ne funkcí v aplikaci.
- Spouštění po přihlášení se nastaví ručně v Nastavení systému podle návodu.
- Souběh se starými aplikacemi se neblokuje, jen se v návodu doporučí je nespouštět.
