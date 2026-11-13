# Architektura

Spec spojené aplikace: `docs/superpowers/specs/2026-11-05-sportivea-zaloha-design.md`. Chování obou režimů popisují původní návrhy (`../stahovani-z-disku/docs/superpowers/specs/2026-10-26-stahovani-z-disku-design.md`, `../trideni-karet/docs/superpowers/specs/2026-10-22-trideni-karet-design.md`). Tento dokument popisuje, jak je to postavené a kde se pravidla vynucují. Části „Stáhnout z Drivu“ a „Nahrát kartu“ jsou převzaté z architektury obou původních aplikací s novými cestami.

## Spojení

### Rozložení kódu
Každý režim má vlastní podsložku v `src/core/`, `src/main/`, `src/renderer/` a `tests/`: `download/` (dřív Stahování z Disku) a `cards/` (dřív Třídění karet). Moduly se při spojení nepřepisovaly, jen přesunuly (změny viz „Rozhodnutí při spojení“).

### Main (`src/main/index.ts`)
- Jedno okno (900×640, „Sportivea Záloha“), zabezpečení ze Stahování: `sandbox`, `contextIsolation`, `devTools` jen mimo balíček, blokace navigace, `window.open`, přesměrování a oprávnění webu.
- Pořadí při startu: `importTrideniData` → Google `AuthService` + download `Runner` → `checkTools` + cards `Runner` → `CloseGuard` → registrace IPC obou režimů → okno → `watchVolumes` (karty se hlídají celou dobu, v jakémkoli režimu).
- `sendToRenderer` čeká na `did-finish-load` (pro oba režimy).
- Nalezená karta: `registerCard`, okno dopředu, Dock bounce, `cards.card:detected`.
- `close-guard.ts`: dotaz při zavření okna i ukončení aplikace, když běží stahování nebo záloha karty (`download.isRunning() || cards.isBusy()`). Text podle toho, co běží (`closeWhileRunningText`). „Zastavit a zavřít“ zavolá `abort()` u obou a čeká na `idle()` obou (max. 10 s).
- `migrate.ts` (`importTrideniData`): při prvním startu (pak značka `.imported-trideni-karet` v userData) zkopíruje `settings.json` a `journal.jsonl` z `~/Library/Application Support/trideni-karet/`, jen když je nová aplikace ještě nemá a zdroj je běžný soubor (ne symlink); `COPYFILE_EXCL`, zdroj se nikdy nemění, `apikey.bin` se nekopíruje.

### IPC a preload
- Kanály: `src/shared/download-ipc.ts` (všechny s prefixem `download.`) a `src/shared/cards-ipc.ts` (prefix `cards.`). Test `tests/shared/ipc-channels.test.ts` hlídá, že se žádný kanál neopakuje (dvojí `ipcMain.handle` by aplikaci při startu shodil).
- `window.api: AppApi = { download: DownloadApi, cards: CardsApi }` (`src/shared/api.ts`, `src/preload/index.ts`). Renderer každého režimu volá main přes svůj `api()` (`src/renderer/<režim>/api.ts`), čteno líně, aby se moduly daly načíst v testech bez `window`.

### Renderer
- `Shell.tsx`: horní lišta (Sportivea Záloha → úvod, Nastavení) a aktuální pohled. **Oba režimy jsou pořád vykreslené**, neaktivní má atribut `hidden`, takže jejich stav (rozepsaný odkaz, průběh, fronta karet) při přepínání nezmizí. `ShellLayout` je čistě prezentační (testuje se statickým renderem).
- `shell-state.ts`: `reduceShell` (pohledy `home` / `download` / `cards` / `settings`; nová karta přepne na `cards`, kromě Nastavení; Nastavení se vrací tam, odkud se otevřelo), `downloadStatusText`, `cardsStatusText`.
- `Home.tsx`: dvě volby se stavem běhu. `SettingsView.tsx`: sekce Google účet (`GoogleAccount.tsx`) nad nastavením karet (`cards/screens/Settings.tsx`, prop `before`).
- `DownloadMode` (`visible`, `onStatus`): bez vlastní lišty, `AccountBar` nahoře; po zobrazení se znovu zeptá na `authStatus` (odhlášení v Nastavení). `CardsMode` (`visible`, `onStatus`, `onCardArrived`, `onOpenSettings`): bez vlastní lišty a bez vlastního Nastavení; po zobrazení znovu načte nastavení a klíč. Hláška o chybějícím ffprobe/ffmpeg je jen v režimu karet (stahování funguje dál).
- `styles.css`: styly Třídění karet + pravidla, která používá jen stahování; režim stahování má modrý akcent (`.mode-download`), zbytek zelený.

### Balíček
`npm run app`: `bundle-ffprobe.mjs --require` → `electron-vite build` → `electron-packager` („Sportivea Záloha“, `cz.sportivea.zaloha`, ffmpeg-static v `app.asar.unpacked`, `resources/bin` vedle `app.asar`) → `scripts/sign-and-zip.sh`: kopie do dočasné složky mimo iCloud, `xattr -cr`, ad-hoc `codesign --deep`, `scripts/check-bundle.mjs` (podpis, žádné `/opt/homebrew`, `/usr/local`, `/Users` v načítaných knihovnách, žádný `.env`, `GOCSPX` jen v `out/main`, žádné `/Users/kolda` v `app.asar`, přibalené runtime závislosti), zip `dist/Sportivea-Zaloha.zip` a kontrola podpisu po rozbalení.

### Uživatelská data (`~/Library/Application Support/sportivea-zaloha/`)
`google-token.bin` (safeStorage), `apikey.bin` (safeStorage), `settings.json`, `journal.jsonl` (deník karet) a standardní data Chromia. Deník stahování je dál na cílovém disku (`<cíl>/<složka>/.stahovani/journal.jsonl`) ve stejném formátu jako ve staré aplikaci. Data starých aplikací (`stahovani-z-disku/`, `trideni-karet/`) aplikace jen čte (`migrate.ts`).

### Rozhodnutí při spojení
- Kanály IPC dostaly prefix podle režimu (obě aplikace měly `run:start` a `run:event`). Download runner posílá přes konstanty `IPC.*`, ne přes doslovné názvy.
- Cards `Runner` má `isBusy()` a `abort()` (jeden `AbortController` pro všechno, co je ve frontě nebo běží; po `abort()` nový). Signál jde až do `copyVerified`: rozepsaná kopie klipu se přeruší hned (ne až po souboru) a svůj nedokončený temp smaže, takže po „Zastavit a zavřít“ nezůstane ve složce Drivu `.partial`. Dřív šla aplikace během zálohy karty zavřít bez dotazu.
- Nadpis přihlášení ve stahování je „Stáhnout z Drivu“ (dřív název aplikace).
- Testy rendereru jsou statické rendery bez DOM knihovny, proto je logika shellu v čisté funkci.
- Podpis a zip mimo složku projektu: Plocha je synchronizovaná přes iCloud a File Provider přidává balíčkům `com.apple.FinderInfo`, se kterým `codesign --verify --strict` neprojde (a Gatekeeper by aplikaci označil za poškozenou).

### Známá omezení spojení
- Aplikace je podepsaná jen ad-hoc (ne u Applu): na novém Macu „Přesto otevřít“ a po každé nové verzi jednou dotaz na Klíčenku.
- Mac nepozná kartu nahranou na jiném Macu (deník karet je lokální).
- Souběhu se starými aplikacemi nebrání (na stejnou kartu by se ozvaly obě, stejné stahování by mohly psát obě).
- Vzhled nové úvodní obrazovky a Nastavení nebyl ověřen okem (jen testy a log startu).

# Stáhnout z Drivu

## Mapa modulů

### `src/core/download/` (čisté TypeScript, bez Electronu, testované Vitestem)
- `types.ts` — `DriveItem`, `PlanEntry`, `DownloadPlan`. Všechny relativní cesty (`localRelPath`, `folders`) jsou relativní k **vybrané složce** a začínají `rootName/` (Ruling 1).
- `names.ts` — `sanitizeName`, `withSuffix`, `assignLocalNames` (deterministické lokální názvy), `classifyMime` (soubor / export / přeskočit).
- `drive.ts` — `DriveClient`: jen GET na Drive v3 (`getItem`, `listChildren`, `download` s Range, `exportFile`), `supportsAllDrives`, opakování s odložením (429, 5xx, 408, výpadek sítě), `DriveError` s druhem (`auth`, `not_found`, `forbidden`, `cannot_download`, `rate_limit`, `server`, `network`) a českou hláškou. `parseFolderLink`. Zrušitelné (AbortSignal) i čekání na token. `TokenProvider` smí vyhodit `DriveError('network')` (opakuje se) nebo `DriveError('auth')` (konec).
- `scan.ts` — `scanFolder`: vlastní průchod do šířky, vrací `DownloadPlan`. Nic na Disku nemění. Složka, která se opakuje (stejné ID), se nezahodí, ale zapíše jako přeskočená položka. Soubor s `canDownload: false` zůstane `file`/`export` s `blocked: true` (počítá se do `fileCount`/`totalBytes`). Po průchodu `markDuplicates` označí každý `file`, jehož obsah (`contentKey` = MD5 malými písmeny + velikost) už má dřívější položka plánu, jako `duplicate: true`; duplikáty nejsou ve `fileCount`/`totalBytes`, ale v `duplicateCount`/`duplicateBytes`.
- `writer.ts` — `writeVerified`: zápis jednoho souboru do `.<fileId>.partial`, MD5 za běhu, ověření, pak přidělení konečného jména bez přepsání (`claimFinalName`: pevný odkaz, záloha: výhradní placeholder + rename na svazcích bez hardlinků jako exFAT). Pokračování z partialu přes Range. Po vyčerpání `maxResumes` se chyba čtení těla vyhodí jako `DriveError('network')` (chyba s `code` ze socketu se nikdy nevydává za chybu disku; chyby zápisu jdou jen ze strany zápisu).
- `journal.ts` — append-only JSONL záznam `.stahovani/journal.jsonl` (viz níže). Nikdy nenásleduje symlink.
- `preflight.ts` — kontrola cíle před Startem: stav (`new` / `resume` / `foreign`), volné místo, typ souborového systému (`/sbin/mount`), FAT32, cloudová složka, poškozený záznam. Varování (`warning`, spojená mezerou): neznámý formát + soubor > 4 GiB; vybraná složka má vlastní `.stahovani/journal.jsonl` nebo se jmenuje jako `rootName` (`caseKey`); vybraná složka je na stejném svazku (`stat.dev`) jako `/` nebo `/System/Volumes/Data` (`systemRoots`, testy předávají `[]`).
- `download-steps.ts` — pomocné kroky downloaderu: zakládání složek (nerekurzivní `mkdir`), `freeName`, `matchingFileMtime` (adopce), identita adresáře, `RunStopped`.
- `downloader.ts` — `runDownload`: sekvenční běh nad plánem, rozhodování `already` / `changed_copy` / stažení, události pro UI, `DownloadSummary`.
- `manifest.ts` — `writeManifest`: CSV se seznamem souborů do cílové složky (`wx`, add-only).

### `src/main/download/` (Electron main)
- Testované bez Electronu: `auth.ts` (`AuthService`: OAuth PKCE s loopbackem na 127.0.0.1, token provider pro Drive klienta, odhlášení + revoke), `token-store.ts` (refresh token přes `safeStorage`), `runner.ts` (`Runner`: plány podle `scanId`, výběr cíle, preflight, jediný aktivní běh, throttling průběhu na 250 ms, `powerSaveBlocker`, CSV po běhu, `retryFailed` s `retryBlocked`, `status()` = snímek průběhu pro `download.run:status`), `close-guard.ts` (`CloseGuard`: dotaz před zavřením okna / ukončením aplikace během běhu; „Zastavit a zavřít“ = abort, čekání na `idle()` max. 10 s, pak zavřít), `ipc.ts` (registrace handlerů: kontrola odesílatele, Zod validace), `guards.ts`, `oauth-config.ts` (`resolveOAuthConfig` je testovaná čistá funkce, `getOAuthConfig` předá konstanty z buildu).
- S Electronem (netestované): `index.ts` (okno, CSP, blokace navigace a oprávnění, `devTools` jen mimo balíček, jedna instance, dialog pro výběr složky, `dialog.showMessageBox` pro `CloseGuard` na `close` a `before-quit`, Keychain).

### `src/shared/download-ipc.ts`, `src/renderer/download/`
`shared/download-ipc.ts` (kanály, `Api`, `RunDone`, typy událostí), preload (contextBridge → `window.api`, CJS `out/preload/index.cjs`), React UI: `DownloadMode.tsx` (dřív `App.tsx`, reducer stavu), `screens/` SignIn, Choose, Progress, Done; `strings.ts` (česká copy, texty „Hotovo“ a „NENÍ dokončené“ se nikdy nepřeformulovávají); `format.ts` (velikosti, rychlost, ETA).

## Tok dat

1. **Přihlášení**: `download.auth:signIn` → prohlížeč → loopback `127.0.0.1:<náhodný port>` (ověřuje `state`, PKCE) → refresh token zašifrovaný do `userData/google-token.bin`. E-mail z `drive/v3/about`. Scope je přesně `drive.readonly`; chybí-li ve výsledku, přihlášení se odmítne.
2. **Sken**: `download.drive:scan(link)` → `parseFolderLink` → `scanFolder` (průběh `download.drive:scanProgress`) → plán zůstává v main pod `scanId`, renderer dostane jen `PlanSummary`.
3. **Cíl**: `download.dest:pick(scanId)` → nativní dialog (cestu renderer neposílá) → `preflight` → `PreflightInfo` (`problem` blokuje Start, `warning` ne).
4. **Běh**: `download.run:start(scanId)` → `Runner.begin` → `runDownload` → události `download.run:event` (`file_start`, `bytes`, `file_done`) → `writeManifest` (selhání CSV není fatální, `manifestPath: null`) → `download.run:done` (`RunDone` vč. seznamů `failed` a `skipped` s důvody). `download.run:retryFailed` spustí poslední plán znovu s `retryBlocked: true`. Okno, které se načte během běhu, se zeptá `download.run:status` a ukáže Progress ze snímku.
5. **Pro každý soubor** (`downloader.ts`): přeskočit (`skip`) → `duplicate`, jehož obsah už je na disku (`run.content`, plní se po `downloaded`/`already`/`changed_copy`): výsledek `duplicate` bez požadavku na Drive, jinak (všechny dřívější kopie selhaly) se stahuje normálně → blokovaná složka → `recordFor` (záznam v deníku) → `blocked` bez `retryBlocked`: `already`, je-li ověřená kopie na disku, jinak `failed` „vlastník zakázal stahování“ bez požadavku na Drive → `already` (stejná verze a na disku souhlasí velikost a mtime) / stáhnout na plánované nebo volné jméno / `changed_copy` (verze na Disku se změnila) → `writeVerified` → záznam do deníku → `file_done`.

## Záznam `.stahovani/journal.jsonl`

Leží v cílové složce (`<vybraná složka>/<rootName>/.stahovani/journal.jsonl`), JSON Lines, jen se přidává (`O_APPEND`, `fsync`, bez symlinků). Jeden řádek = jeden ověřený soubor:

```
{"fileId","localRelPath","size","md5","modifiedTime","kind":"file"|"export","localMtimeMs","at"}
```

- `localRelPath` je relativní k vybrané složce, začíná `rootName/`, Zod odmítne absolutní cestu, `..`, prázdné a `.` segmenty.
- Při načtení vyhrává poslední záznam pro `fileId`. Poškozený řádek (pád při zápisu) se přeskočí, další zápis začne na novém řádku. `.stahovani`, které není skutečný adresář, nebo záznam, který není běžný soubor → `JournalFormatError` → stav běhu `journal_error`.
- **Navazování (resume)** kontroluje jen velikost a `mtime` souboru z deníku (bez přepočítání MD5, ověřilo se při zápisu); `mtime` posunutý přesně o ±1 h se toleruje (FAT/exFAT a změna času). Verze se pozná podle MD5 a velikosti (soubory s MD5), jinak podle `modifiedTime` (exporty).
- Soubor z deníku chybí nebo je změněný → stáhne se znovu na cestu z deníku (je-li její složka v plánu), jinak na plánovanou.
- **Změněný soubor na Disku** (jiná verze než v deníku) se nepřepíše: nová verze jde na volné jméno ` (n)` a výsledek je `changed_copy`.
- **Adopce (Ruling 10)**: na plánované cestě leží běžný soubor, který **není** v deníku, a má stejnou velikost a stejné MD5 jako na Disku → zapíše se záznam a výsledek je `already` (pád po `claimFinalName`, ručně zkopírované soubory). Jiný obsah → další volné ` (n)`.
- Opakované `fileId` v jednom plánu (obranná cesta skenu) se hlásí jako `already` s odkazem na existující kopii (Ruling 11).

## Pravidla pojmenování

- Lokální jméno z Drive jména: zakázané znaky `/ \ : * ? " < > |` a řídicí `U+0000–001F`, `U+007F–009F` → `-`; Unicode `toWellFormed()` a NFC; koncové mezery a tečky pryč; prázdné → `bez názvu`; max 255 bajtů UTF-8 (řez na hranici znaku, přípona ≤ 32 B se zachová).
- Kolize v jedné složce se řeší bez ohledu na velikost písmen (`toUpperCase().toLowerCase()`): skupina se řadí podle `createdTime`, pak `id`; první drží jméno, další dostanou ` (2)`, ` (3)`… před příponou. Jména podsložek jsou ve stejném jmenném prostoru jako soubory.
- Exporty: Dokument `.docx`, Tabulka `.xlsx`, Prezentace `.pptx`, Kresba `.png`. Přípona se nepřidá dvakrát, když ji název už má.
- Zástupce a ostatní `application/vnd.google-apps.*` → `skip`. Soubor se zakázaným stahováním (`canDownload: false`) **není** `skip`: zůstane `file`/`export` s `blocked: true` a downloader ho hlásí jako `failed` „vlastník zakázal stahování“ (běh je `incomplete`, nikdy „Hotovo“). Na Drive se kvůli němu neptá, jen při opakování (`retryBlocked`); odmítne-li Drive znovu (403 `cannotDownloadFile`), selže se stejným důvodem.
- **Dočasné soubory** se jmenují podle ID souboru na Disku, ne podle jména (Ruling 5, kvůli limitu 255 bajtů): `.<fileId>.partial` (rozepsáno) a `.<fileId>.bad` (neprošlo ověřením; další `.bad.2`, `.bad.3`…). Aplikace maže jen svůj `.partial` a svůj prázdný placeholder při přidělování jména; `.bad` a vše ostatní nikdy.
- CSV: `_seznam_souboru_<RRRR-MM-DD_HH-MM>.csv` (UTF-8 BOM, `;`, CRLF; buňky začínající `= + - @` se označí apostrofem); obsazené jméno → `_2`, `_3`…

## Pravidla stavů

`DownloadSummary.status`:

| status | kdy |
|---|---|
| `complete` | každý plánovaný soubor je ověřený / `already` / exportovaný, nebo výslovně přeskočený; žádný `failed` |
| `incomplete` | doběhlo, ale aspoň jeden soubor `failed` |
| `destination_lost` | cíl (vybraná složka nebo kořen) zmizel nebo je to jiný adresář než na začátku (dev + ino) |
| `auth_lost` | `DriveError('auth')` (zrušený nebo neplatný grant); přechodné chyby tokenu se opakují jako síť |
| `aborted` | uživatel zastavil |
| `journal_error` | záznam nelze bezpečně použít (viz výše), běh se zastaví, navazování by nebylo možné |
| `disk_full` | zápis skončil `ENOSPC` nebo `EDQUOT`; běh se zastaví (další soubory by selhaly taky), partial zůstane, Pokračovat naváže |

Výsledek jednoho souboru (`EntryOutcome`): `downloaded`, `exported`, `already`, `changed_copy`, `duplicate`, `skipped`, `failed`. `duplicate` neblokuje `complete`, nepočítá se do souborů v průběhu ani do `CELKEM`; jeho `localRelPath` je plánovaná cesta (soubor tam není), důvod „stejný obsah jako <cesta k uložené kopii>“. Na `complete` se UI zeleným „Hotovo“ dívá i na nulový počet `failed`. Součet `CELKEM` v CSV = bajty všech souborů, které na disku jsou (`downloaded` + `exported` + `already` + `changed_copy`), ne jen z tohoto běhu (Ruling 14).

Hlášky selhání jednoho souboru: `soubor se stáhl poškozený` (MD5 nesouhlasí i po druhém pokusu), `výpadek spojení, zkus znovu`, `chyba při zápisu na disk (<kód>)`, `vlastník zakázal stahování` (`blocked`), hlášky `DriveError` (Google omezil stahování, nelze stáhnout, nenalezeno, bez přístupu). Stažený soubor bez MD5 od Googlu (ověřena jen velikost) má v CSV důvod `ověřena jen velikost (Google neuvádí MD5)`, výsledek zůstává `downloaded`. Důvod `disk_full` v CSV: `na disku došlo místo`.

CSV po zastaveném běhu (`destination_lost`, `auth_lost`, `aborted`, `journal_error`, `disk_full`) obsahuje jen položky, ke kterým se běh dostal.

## Bezpečnostní pravidla a kde se vynucují

| Pravidlo | Kde |
|---|---|
| Na Disku se nic nemění | scope `drive.readonly` (`auth.ts`), `DriveClient` posílá jen GET (`drive.ts`) |
| Na disku se jen přidává | `writer.ts` (`wx`, hardlink, `claimFinalName`), `download-steps.ts` (nerekurzivní `mkdir`), `manifest.ts` (`wx`), `journal.ts` (`O_APPEND`), žádný symlink se nenásleduje |
| Soubor „stažený“ až po ověření | `writeVerified` (velikost + MD5), záznam do deníku až po konečném jménu |
| „Hotovo“ jen při úplnosti | `downloader.ts` (status), `Done.tsx` (zelená jen při `complete` a nule `failed`) |
| Konec při ztrátě disku nebo přihlášení | `destinationLost` (dev + ino), `classify` → `RunStopped` |
| Odhlášení nejde během běhu | `ipc.ts` → `runner.isRunning()` → `{ ok: false, error }` |
| Zavření/ukončení během běhu se ptá | `close-guard.ts` (`CloseGuard`), napojeno v `index.ts` na `window.on('close')` a `app.on('before-quit')`; běh zastavený před začátkem se nespustí (`Runner.begin`) |
| FAT32 a cloudová složka se odmítnou | `preflight.ts` (`problem`); neznámý formát + soubor > 4 GiB → `warning` |
| Refresh token jen v Keychainu | `token-store.ts` (`safeStorage`, žádný plaintext fallback, zápis přes temp + rename) |
| OAuth hodnoty jen v main | `electron.vite.config.ts` (`define` jen pro main), build selže při prázdných |
| Cíl jen z nativního dialogu | `index.ts` (`dialog.showOpenDialog`) → `Runner` (renderer posílá jen `scanId`) |
| Okno | `sandbox`, `contextIsolation`, žádný `nodeIntegration`, striktní CSP, blokace navigace, `window.open` a oprávnění, každý IPC handler kontroluje odesílatele a validuje Zodem |

## Uživatelská data (`app.getPath('userData')`, tj. `~/Library/Application Support/sportivea-zaloha/`)
Jen `google-token.bin` (zašifrovaný refresh token) a standardní data Chromia. Záznam o stahování a CSV jsou v cílové složce, ne tady.

## Rozhodnutí, která změnila původní plán

- Dočasné soubory pojmenované jen ID souboru (`.<fileId>.partial`), původní `.<name>.<fileId>.partial` přesahoval 255 bajtů.
- Stav `journal_error` navíc (poškozený záznam = žádné navazování = žádné poctivé „Hotovo“).
- Resume bez přepočtu MD5: velikost + `mtime`, tolerance ±1 h.
- CELKEM v CSV je součet všech souborů na disku, ne jen z posledního běhu.
- `download.run:done` nese typ `RunDone` (Ruling 2). Soubory v plánu jsou vždy relativní k vybrané složce a začínají `rootName/`.
- Resume pomocí Range jen když je známé MD5 (jinak by šel slepit poškozený soubor); partial s více hardlinky se nikdy nedoplňuje.
- Hlášky přihlášení jsou jen česky; progress se před každou jinou událostí vyprázdní.
- Soubor se zakázaným stahováním je `failed`, ne `skip` (jinak by složka s ním mohla být „Hotovo“).
- Nový stav `disk_full` (ENOSPC/EDQUOT zastaví běh místo stovek selhaných souborů).
- Dotaz při zavření/ukončení během běhu a `download.run:status` pro okno načtené během běhu.
- Duplikáty podle obsahu (Jan, 3. 11. 2026): stejný obsah se stahuje jen jednou; když první kopie selže, stáhne se další (pojistka, aby obsah nechyběl).

## Známá omezení

- Na discích bez pevných odkazů (exFAT): pokud aplikace spadne přesně mezi založením prázdného zástupného souboru a přejmenováním, zůstane pod konečným jménem prázdný soubor. Příští běh ho nepřevezme (jiná velikost) a stáhne soubor jako ` (2)`; nic se nepřepíše.
- Blokované soubory (vlastník zakázal stahování) se počítají do potřebného místa, i když se nestáhnou. Kontrola místa je tak opatrnější, než je nutné.
- Cmd+Q během otevřeného dialogu pro zavření okna se zahodí: po „Zastavit a zavřít“ se zavře jen okno, aplikace zůstane v Docku.

- Okno načtené během běhu ukáže průběh ze snímku (`download.run:status`); rychlost a ETA se změří až z dalších událostí.
- Varování „disk Macu“ porovnává `stat.dev` s `/` a `/System/Volumes/Data`; jiné interní svazky nepozná.
- Svazky s nestabilními čísly inode (např. některé SMB) mohou vyvolat falešné `destination_lost`; selže bezpečně.
- Svazky FUSE s `nlink` ≠ 1 selžou bezpečně (soubor `failed` s důvodem).
- Pád mezi vytvořením pevného odkazu a smazáním partialu: příští běh soubor stáhne znovu (nebo ho adoptuje, je-li shodný).
- Exporty z Google Dokumentů nemají MD5 ani známou velikost; ověřuje se jen neprázdný výsledek a nepokračují se Range.
- Příliš velký Google Dokument Google neexportuje (hláška „soubor je příliš velký na export z Google Dokumentů“); soubor skončí jako `failed`.
- Aplikace je nepodepsaná a nenotarizovaná, jen arm64.

## Ověřeno (ve staré aplikaci Stahování z Disku)

Automaticky: `npm test` a `npm run typecheck` (viz `CLAUDE.md`). Balíček `npm run app`: spuštění, `did-finish-load`, `GOCSPX` jen v `out/main`, `.env` není v balíčku (2026-10-27).

Živě na skutečném Disku a externím disku WD Elements (exFAT, 1,8 TB):
- 2026-10-27 a 2026-11-02 (Jan sám): 144 souborů / 61 GB a 35 souborů / 5,5 GB staženo a ověřeno MD5, oba běhy zastaveny tlačítkem, 0 selhaných; CSV `NEKOMPLETNÍ;zastaveno`.
- 2026-11-03, složka „Kamera 1“ (24 souborů, 32,3 GB): sken našel 2 duplikáty (1,54 GB), počet sedí s tím, co Jan na Disku má. Zastaveno uprostřed 3. souboru (partial 269 MB), aplikace ukončena a znovu spuštěna, stejný odkaz + stejný cíl → „Navazuji na stahování z 3. 11. 2026“; první dva soubory se nestahovaly znovu, partial pokračoval od 269 MB (Range) a dotažený soubor prošel kontrolou MD5 (žádný `.bad`).
- Výběr cíle ve skutečném okně macOS, přihlášení přežije restart aplikace, dotaz „Opravdu zastavit?“ funguje.

Neověřeno živě: Google Dokument (export), sdílený disk, dialog při Cmd+Q během běhu, odpojení disku za běhu.

# Nahrát kartu

## Mapa modulů

### `src/core/cards/` (čisté TypeScript, bez Electronu, testované Vitestem)
- `types.ts`, `templates.ts` (šablony, `_nezařazeno`, `_ostatni`), `roster.ts` (soupiska)
- `card.ts` — sken karty (videa, ostatní soubory, ignorované systémové soubory macOS); vše pod `M4ROOT/SUB/` a `M4ROOT/THMBNL/` (Sony proxy a náhledy, bez ohledu na velikost písmen) je ostatní soubor, nikdy klip
- `probe.ts`, `frames.ts`, `exec.ts` — ffprobe metadata, jas snímků, contact sheet 2×2 (ffmpeg/ffprobe, 60 s timeout; timeout nebo selhání spuštění se jednou zopakuje, nenulový exit nikdy)
- `markers.ts` — černé značky a TOP záběry
- `naming.ts` — `<základ>_<popis>.<přípona>`, `_TOP_`, čištění popisu, značka kamery při kolizi
- `classifier.ts`, `pricing.ts` — Claude klasifikátor (`zodOutputFormat`, `effort: low`, klient `timeout: 60 s`, `maxRetries: 2`; chyba volání = `apiFailure`), cena v USD/Kč
- `copy.ts` — ověřený add-only zápis (temp soubor → SHA-256 → finalizace)
- `journal.ts` — append-only JSONL deník nahraných souborů
- `diskspace.ts` — čekání na volné místo
- `csv.ts` — mapovací CSV (UTF-8 BOM, `;`, add-only)
- `pipeline.ts` — celý běh: rozbor → třídění → kopie → ověření → CSV, vrací `RunSummary`
- `bin.ts` — cesty k ffmpeg/ffprobe (dev, balíček, přepsání `TRIDENI_FFMPEG` / `TRIDENI_FFPROBE`); v balíčku (běh z `app.asar`) jen `resources/bin/ffprobe`, jinak chyba (žádný fallback na vyřazený `ffprobe-static`)

### `src/main/cards/` (Electron main)
- Bez Electronu (testované): `settings.ts`, `watcher.ts` (sleduje `/Volumes`; `retryLater` = zkusit svazek při dalším pollu), `queue.ts` (jedna karta najednou), `runner.ts` (`cards.run:start`, založení složky akce, job, notifikace), `cardinfo.ts` (`describeCard`, `cardListener` — nečitelná karta → `retryLater`), `guards.ts` (cesta uvnitř kořene), `tools.ts` (`ffprobe -version` + `ffmpeg -version` při startu).
- S Electronem (netestované): `index.ts` (okno, watcher, notifikace), `ipc.ts` (`ipcMain.handle`, Zod validace, jen vlastní okno), `secrets.ts` (safeStorage).

### `src/shared/cards-ipc.ts`, `src/renderer/cards/`
`shared/cards-ipc.ts` (kanály, `Api`, `Settings`), preload (contextBridge → `window.api`, build do `out/preload/index.cjs`), React UI (`CardsMode.tsx`, dřív `App.tsx`; `screens/` Idle, NewCard, Progress, Done, Settings — Settings se zobrazuje přes shell; `strings.ts` česká copy).

### `scripts/`
`bundle-ffprobe.mjs` (samostatný ffprobe), `eval.ts` + `eval-lib.ts` (viz `docs/eval.md`).

## Tok dat

0. Při startu `index.ts` jednou spustí `checkTools`; výsledek čte renderer přes IPC `cards.tools:ok` (při `false` česká chyba, tlačítka neaktivní) a `runner` při `false` odmítne `cards.run:start`.
1. `watcher` zjistí kartu v `/Volumes` → `queue` → okno „Nová karta“ (`cardinfo`).
2. Start → IPC `cards.run:start` (`mode`: `sort` / `name` / `copy`) → `runner` zvaliduje vstup (Zod; klíč jen pro `sort` a `name`, šablona jen pro `sort`, ffprobe/ffmpeg jen mimo `copy`), jednou založí složku akce (neřekurzivní `mkdir` pod existujícím kořenem) a spustí `pipeline` s `mode` (`name` s `NAME_ONLY_TEMPLATE`, `copy` s `classifier: null`).
3. `pipeline`: sken → probe + jas → značky/TOP → klasifikace (Claude; bez klasifikátoru vše `_nezařazeno`; po 5 `apiFailure` za sebou se už neptá a zbytek jde do `_nezařazeno`) → `copy` do složky akce (TOP první, pak chronologicky; před každým souborem `stat` zdroje — jiná velikost nebo chybí = `card_removed`) → ověření → CSV → `RunSummary` (`ai`: `used` / `unavailable` / `off`).
4. Události (`RunEvent`) jdou přes IPC do rendereru (Progress/Done) a do notifikací.

## Bezpečnostní pravidla a kde se vynucují

| Pravidlo | Místo |
| --- | --- |
| Karta jen pro čtení | zdroj se otevírá jen `createReadStream` / `open(path,'r')`; nikde se nepíše do `cardRoot` |
| Cíl jen přidává | `copy.ts`: temp soubor vznikne s `wx`, finalizace hard linkem (`EEXIST` = jméno obsazené → ` (2)`), nikdy rename přes existující soubor |
| Temp, který neprošel ověřením, se nemaže | `copy.ts` ho nechá na místě a nahlásí |
| „Zapsáno a ověřeno“ jen při úspěchu | `pipeline.ts`: stavy `ok` / `card_removed` / `verify_failed` / `aborted`; nezpracovaný soubor mimo odpojení karty a ruční přerušení = `verify_failed` |
| Složku akce pipeline nezakládá | `pipeline.ts` `eventDirExists` (`lstat`) před každým souborem; zmizelý mount se nezmění na lokální složku; jediný `mkdir` je v `runner.ts` |
| Klíč jen v Keychainu | `secrets.ts` (safeStorage, bez plaintext fallbacku) |
| Cesty z rendereru | `guards.ts`; kořen jen z dialogu; symlinkované složky akcí se odmítají; `reveal` jen uvnitř kořene |
| Selhání AI neblokuje zálohu | `pipeline.ts`: chyba klasifikace → `_nezařazeno` pod původním názvem; jistič po 5 chybách API za sebou; běh bez klasifikátoru (bez klíče) |
| Vyměněná karta se nezálohuje jako původní | `pipeline.ts`: před kopií `stat` zdroje, velikost ≠ sken nebo chybí → `card_removed` |
| Balíček bez ffprobe nevznikne / nespustí běh | `bundle-ffprobe.mjs --require` (v `npm run app`) končí chybou; `bin.ts` v balíčku bez fallbacku; `tools.ts` + `runner.ts` |
| CSV add-only | `csv.ts`: `wx`, při konfliktu nový název |

## Uživatelská data (`app.getPath('userData')`, tj. `~/Library/Application Support/sportivea-zaloha/`)
`settings.json` (kořen, model, šablony, práh, kurz), `journal.jsonl` (deník: sha256, velikost, původní cesta, složka akce, cílová cesta, čas), `apikey.bin` (safeStorage). Nic z toho není v repozitáři.

## Samostatný ffprobe
`ffmpeg-static` je arm64. `ffprobe-static` má v `darwin/arm64` binárku x86_64, proto `scripts/bundle-ffprobe.mjs` vezme Homebrew arm64 ffprobe a rekurzivně (`otool -L`, mimo `/usr/lib` a `/System`) zkopíruje všechny dylib do `resources/bin/lib/`, přepíše reference přes `install_name_tool` na `@loader_path/lib/<jméno>` (ffprobe) resp. `@loader_path/<jméno>` (dylib a jejich id) a ad-hoc podepíše (`codesign --force --sign -`). Na konci ověří, že `otool -L` neobsahuje `/opt/homebrew`. `npm run app` skript spouští před buildem a přibalí `resources/bin` přes `--extra-resource` (leží vedle `app.asar`). `ffprobe-static/bin` se do balíčku nedává (335 MB, nepoužívá se); `ffmpeg-static` je v `app.asar.unpacked`.

## Rozhodnutí, která změnila původní plán
- **Deník se potvrzuje obsahem**: „už nahráno“ platí jen po shodě sha256 (+ velikost) zdroje; shoda cesty a velikosti slouží jen jako rychlý kandidát.
- **Stav `aborted`**: ruční přerušení s nezpracovanými soubory není `ok` ani `verify_failed`.
- **TOP při selhání klasifikace**: název zůstává `<základ>_TOP`, klip jde do `_nezařazeno`.
- **Integrační testy** jen s `TRIDENI_INTEGRATION=1` (skutečná karta Istanbul, ~10 min).
- **Fallback bez hard linků**: svazek Drivu nemusí `link` podporovat; `copy.ts` si pak jméno zabere exkluzivním `open(final,'wx')` placeholderem a pak `rename` z vlastního temp; placeholder se maže jen když je to vlastní prázdný soubor (stejný inode, velikost 0).
- Výstup balíčku je `dist/` (`out/` je build electron-vite).
- **Co s kartou (2026-11-13)**: `RunOptions.mode` — `sort` (dřívější chování), `name` (klasifikátor jen pro popis s `NAME_ONLY_TEMPLATE`, klipy do `EVENT_ROOT` = přímo do složky akce; nepopsaný klip pod původním názvem tamtéž a počítá se do `unclassified`), `copy` (žádný probe, značky, TOP ani klasifikace; všechny soubory podle `relPath` s původními názvy do `EVENT_ROOT`, bez značky kamery — obsazené jméno ` (2)`). `RunSummary.mode`. Dřívější „Zálohovat bez třídění“ (bez klíče, vše do `_nezařazeno`) v UI nahradila volba `copy`; pipeline cestu `classifier: null` v režimu `sort` pořád umí.
- **Jistič AI**: 5 chyb API za sebou (ne odmítnutí ani nízká jistota) → klasifikátor se v běhu už nevolá, zbytek do `_nezařazeno` („AI nedostupná“). Při paralelní klasifikaci (4) může doběhnout nejvýš 3 rozběhnutá volání navíc.
- **Sony proxy a náhledy** (`M4ROOT/SUB`, `M4ROOT/THMBNL`) jsou ostatní soubory (`_ostatni`), aby se neanalyzovaly ani nepletly do TOP.

## Známá omezení
- Výsledky evalu klasifikátoru zatím nejsou (čeká na API klíč a schválení rozpočtu, `docs/eval.md`).
- Nativní dialogy (výběr kořene, notifikace, Keychain) se automaticky netestují; balíček je ověřen jen spuštěním (okno se načte, preload bridge OK).
- Chování `link`/`rename` na skutečném svazku Google Drive pro počítač nebylo ověřeno.
- Aplikace je nepodepsaná (bez notarizace a auto-update), jen Apple Silicon.
- Dokončení uploadu Drive aplikace nezjistí (varianta A ze specifikace).
- Neúspěšný běh může v podsložkách akce nechat skryté `.<název>.partial` (temp, který neprošel ověřením, nebo rozepsaná kopie při pádu aplikace). Ty aplikace nikdy nemaže; dají se smazat ručně (README). Zastavení uživatelem („Zastavit a zavřít“) přeruší i rozepsanou kopii a ten vlastní nedokončený temp smaže (`copyVerified` se `signal`).
