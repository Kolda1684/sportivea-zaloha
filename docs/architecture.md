# Architektura

Spec (chování, bezpečnostní pravidla): `docs/superpowers/specs/2026-10-22-trideni-karet-design.md`. Tento dokument popisuje, jak je to postavené a kde se pravidla vynucují.

## Mapa modulů

### `src/core/` (čisté TypeScript, bez Electronu, testované Vitestem)
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

### `src/main/` (Electron main)
- Bez Electronu (testované): `settings.ts`, `watcher.ts` (sleduje `/Volumes`; `retryLater` = zkusit svazek při dalším pollu), `queue.ts` (jedna karta najednou), `runner.ts` (`run:start`, založení složky akce, job, notifikace), `cardinfo.ts` (`describeCard`, `cardListener` — nečitelná karta → `retryLater`), `guards.ts` (cesta uvnitř kořene), `tools.ts` (`ffprobe -version` + `ffmpeg -version` při startu).
- S Electronem (netestované): `index.ts` (okno, watcher, notifikace), `ipc.ts` (`ipcMain.handle`, Zod validace, jen vlastní okno), `secrets.ts` (safeStorage).

### `src/shared/`, `src/preload/`, `src/renderer/`
`shared/ipc-types.ts` (kanály, `Api`, `Settings`), preload (contextBridge → `window.api`, build do `out/preload/index.cjs`), React UI (`App.tsx`, `screens/` Idle, NewCard, Progress, Done, Settings; `strings.ts` česká copy).

### `scripts/`
`bundle-ffprobe.mjs` (samostatný ffprobe), `eval.ts` + `eval-lib.ts` (viz `docs/eval.md`).

## Tok dat

0. Při startu `index.ts` jednou spustí `checkTools`; výsledek čte renderer přes IPC `tools:ok` (při `false` česká chyba, tlačítka neaktivní) a `runner` při `false` odmítne `run:start`.
1. `watcher` zjistí kartu v `/Volumes` → `queue` → okno „Nová karta“ (`cardinfo`).
2. Start → IPC `run:start` (`sort: true`, nebo `sort: false` = „Zálohovat bez třídění“ bez API klíče) → `runner` zvaliduje vstup (Zod), jednou založí složku akce (neřekurzivní `mkdir` pod existujícím kořenem) a spustí `pipeline` (při `sort: false` s `classifier: null`).
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

## Uživatelská data (`app.getPath('userData')`, tj. `~/Library/Application Support/trideni-karet/`)
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
- **Zálohovat bez třídění**: bez API klíče běží pipeline s `classifier: null` (záloha má přednost před tříděním; značky a TOP se pořád poznají, poznámka v CSV „zálohováno bez třídění“).
- **Jistič AI**: 5 chyb API za sebou (ne odmítnutí ani nízká jistota) → klasifikátor se v běhu už nevolá, zbytek do `_nezařazeno` („AI nedostupná“). Při paralelní klasifikaci (4) může doběhnout nejvýš 3 rozběhnutá volání navíc.
- **Sony proxy a náhledy** (`M4ROOT/SUB`, `M4ROOT/THMBNL`) jsou ostatní soubory (`_ostatni`), aby se neanalyzovaly ani nepletly do TOP.

## Známá omezení
- Výsledky evalu klasifikátoru zatím nejsou (čeká na API klíč a schválení rozpočtu, `docs/eval.md`).
- Nativní dialogy (výběr kořene, notifikace, Keychain) se automaticky netestují; balíček je ověřen jen spuštěním (okno se načte, preload bridge OK).
- Chování `link`/`rename` na skutečném svazku Google Drive pro počítač nebylo ověřeno.
- Aplikace je nepodepsaná (bez notarizace a auto-update), jen Apple Silicon.
- Dokončení uploadu Drive aplikace nezjistí (varianta A ze specifikace).
- Přerušený nebo neúspěšný běh může v podsložkách akce nechat skryté `.<název>.partial` (temp, který neprošel ověřením, nebo rozepsaná kopie při pádu). Aplikace je nikdy nemaže; dají se smazat ručně (README).
