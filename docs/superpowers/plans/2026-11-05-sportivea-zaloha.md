# Sportivea Záloha Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Merge the Electron apps `stahovani-z-disku` (Drive → disk download) and `trideni-karet` (card sort → Drive for desktop folder) into one packaged macOS app „Sportivea Záloha“ that installs on a second Mac without the dev setup.

**Architecture:** Move, don't rewrite. Both codebases keep their modules, namespaced under `download/` and `cards/` folders in `src/core`, `src/main`, `src/renderer` and `tests`. A new main `index.ts` wires both runners, one window, one preload exposing `window.api.download` and `window.api.cards`, and a renderer `Shell` that keeps both modes mounted and shows a Home screen with two choices plus a shared Settings view.

**Tech Stack:** Electron 45.0.0, electron-vite 6.0.0, React 19.3.1, TypeScript 7.0.2, Zod 4.6.7, Vitest 5.0.5, @electron/packager 20.3.0, google-auth-library 11.3.1, @anthropic-ai/sdk 1.1.0, ffmpeg-static 5.3.0 (+ bundled Homebrew ffprobe). Exact versions as in the two source `package.json` files (no `^`).

**Spec:** `docs/superpowers/specs/2026-11-05-sportivea-zaloha-design.md`. Behaviour of each mode: the two original specs and `docs/architecture.md` files it references.

**Sources (read-only, never modify):** `/Users/kolda/Desktop/Vibe_coding/stahovani-z-disku` (branch `feat/v1`), `/Users/kolda/Desktop/Vibe_coding/trideni-karet` (branch `main`). Project: `/Users/kolda/Desktop/Vibe_coding/sportivea-zaloha`.

## Global Constraints

- No `git commit`, no `git push`, no GitHub repo: Jan commits only when he asks. Plan steps end with verification, not commits.
- Never modify the source repos, `/Applications/Stahování z Disku.app`, `/Applications/Trideni karet.app`, or `~/Library/Application Support/{stahovani-z-disku,trideni-karet}/`.
- Google scope stays exactly `drive.readonly`, GET only. Card upload = file copy into the Drive for desktop folder; no Drive write API.
- Card read-only; destinations add-only; „Hotovo“/„Zapsáno a ověřeno“ only when complete; texts „NENÍ dokončené“ / „Karta ještě NENÍ zálohovaná“ unchanged.
- Secrets only via `safeStorage`; OAuth client ID/secret only in `.env` (gitignored), injected into `out/main` only; `GOCSPX` must not appear in `out/preload` or `out/renderer`. Never print `.env` contents.
- Window: `sandbox`, `contextIsolation`, no `nodeIntegration`, strict CSP, navigation/`window.open`/permissions blocked, every IPC handler checks the sender and validates with Zod. No `any`.
- App name „Sportivea Záloha“, bundle ID `cz.sportivea.zaloha`, package name `sportivea-zaloha` (= userData folder `~/Library/Application Support/sportivea-zaloha/`). No `productName` in `package.json` (it would rename userData).
- UI copy Czech; code, file names, commits English. arm64 only.
- Download journal format (`<dest>/<root>/.stahovani/journal.jsonl`) unchanged: resumes started in the old app must work.

## Review Focus

1. A card inserted while a download runs or while the download screen is open: the window switches to „Nová karta“, the download keeps running and its screen state is intact when the user goes back. → Task 5 test `card arrival switches to cards and keeps download mounted`.
2. Two IPC sets registered in one process: any equal channel name makes Electron throw at startup (both apps use `run:start`, `run:event`). → Task 1 test `channel names are unique across modes`.
3. Closing/quitting during a card-only backup: today Třídění quits silently; the merged guard must ask and „Zastavit a zavřít“ must abort the card run too. → Task 2 tests on `closeWhileRunningText` and cards `Runner.abort()`.
4. One-time import of Třídění karet data when the target already exists, the source is missing, or the source is a symlink: never overwrite, never modify the source, never follow links. → Task 3 tests.
5. Packaged app on a Mac without Homebrew, `.env` or `/Users/kolda`: no absolute dev paths in Mach-O load commands or bundle files, valid ad-hoc signature (otherwise Gatekeeper says „poškozená“ with no „Přesto otevřít“). → Task 6 `scripts/check-bundle.mjs`.

---

### Task 1: Project from both codebases (moved, namespaced, green)

**Files:**
- Create in `/Users/kolda/Desktop/Vibe_coding/sportivea-zaloha/`: everything below. The spec and this plan already exist there (untracked); keep them.
- Git: `git init -b main`, `git fetch ../trideni-karet main`, `git reset --hard FETCH_HEAD` (puts Třídění's tree at the root with its history; the untracked spec and plan survive), `git checkout -b feat/merge`. Then rearrange Třídění's files with `git mv` and add Stahování's with `cp` from its working tree (branch `feat/v1`).
- Move map (source → target). `S` = stahovani-z-disku, `T` = trideni-karet:
  - `S/src/core/*` → `src/core/download/*`; `T/src/core/*` → `src/core/cards/*`
  - `S/src/main/{auth,token-store,runner,ipc,guards,oauth-config}.ts`, `S/src/main/env.d.ts` → `src/main/download/`
  - `S/src/main/close-guard.ts` → `src/main/close-guard.ts`
  - `T/src/main/{cardinfo,guards,ipc,queue,runner,secrets,settings,tools,watcher}.ts` → `src/main/cards/`
  - `S/src/shared/ipc-types.ts` → `src/shared/download-ipc.ts`; `T/src/shared/ipc-types.ts` → `src/shared/cards-ipc.ts`
  - `S/src/renderer/{App.tsx→DownloadMode.tsx,screens/*,strings.ts,format.ts}` → `src/renderer/download/`
  - `T/src/renderer/{App.tsx→CardsMode.tsx,screens/*,strings.ts,format.ts,runState.ts,recent.ts,eventChoice.ts,templates.ts}` → `src/renderer/cards/`
  - `T/src/renderer/{index.html,css.d.ts,styles.css}` → `src/renderer/` (CSS merged in Task 5); `T/src/types/` → `src/types/`; `T/scripts/` → `scripts/`; `T/docs/eval.md` → `docs/eval.md`
  - Tests mirror: `S/tests/{core,main,renderer}/*` → `tests/{core,main,renderer}/download/*` (close-guard test → `tests/main/close-guard.test.ts`), `S/tests/helpers/` → `tests/helpers/`; `T/tests/{core,main,renderer,scripts}/*` → `tests/{core,main,renderer}/cards/*`, `tests/scripts/*`; `T/tests/fixtures/` → `tests/fixtures/`
  - Not copied: `src/main/index.ts`, `src/preload/index.ts`, `src/renderer/{main.tsx,api.d.ts}` of either app (rewritten in Tasks 4–5), `out/`, `dist/`, `node_modules/`, `eval-results/`, `.superpowers/`, old `CLAUDE.md`/`README.md`/`docs/architecture.md`/old specs and plans (Třídění's tracked ones: `git rm` them; they stay in the source repo and are referenced by the spec).
- Create: `src/shared/api.ts`, `src/renderer/download/api.ts`, `src/renderer/cards/api.ts`, `src/renderer/api.d.ts`
- Create/merge configs: `package.json`, `electron.vite.config.ts`, `vitest.config.ts`, `tsconfig.json`, `tsconfig.node.json`, `.gitignore`
- Copy `S/.env` → `.env` with `cp` (do not print it); confirm `.gitignore` contains `.env*` before.
- Test: `tests/shared/ipc-channels.test.ts`

**Interfaces:**
- Produces:
  - `src/shared/download-ipc.ts`: same exports as the old file; every `IPC` value prefixed `download.` (e.g. `runStart: 'download.run:start'`); `MainEvents` keys updated to match; `Api` renamed `DownloadApi`.
  - `src/shared/cards-ipc.ts`: same exports; every `IPC` value prefixed `cards.`; `Api` renamed `CardsApi`; imports `../core/cards/pipeline`, `../core/cards/templates`.
  - `src/shared/api.ts`: `export type AppApi = { download: DownloadApi; cards: CardsApi }`
  - `src/renderer/api.d.ts`: `interface Window { api: AppApi }`
  - `src/renderer/download/api.ts`: `export function api(): DownloadApi { return window.api.download }`; `src/renderer/cards/api.ts`: `export function api(): CardsApi { return window.api.cards }`. In both renderer subtrees replace every `window.api.` with `api().` (lazy: tests import these modules without `window`).
  - `package.json`: `"name": "sportivea-zaloha"`, version `0.1.0`, `"type": "module"`, `"main": "./out/main/index.js"` (as sources), union of dependencies/devDependencies at the exact source versions, scripts `dev`, `build`, `test`, `typecheck`, `eval`, `postinstall` from Třídění; `app` comes in Task 6.
  - `electron.vite.config.ts` = Stahování's (OAuth `define` for main only, build fails on empty values, its stricter CSP, plugin name `zaloha-csp`); `vitest.config.ts` = Stahování's (`define` empty OAuth constants) with Třídění's include list; `tsconfig.node.json` = Stahování's `lib` (`ES2024.String`) + union of both `include` lists (`src/types/**/*`, `scripts/**/*.ts`); `.gitignore` = union.

- [ ] **Step 1: Write the failing test** `tests/shared/ipc-channels.test.ts`

```ts
import { expect, it } from 'vitest'
import { IPC as DOWNLOAD } from '../../src/shared/download-ipc'
import { IPC as CARDS } from '../../src/shared/cards-ipc'
it('channel names are unique across modes', () => {
  const all = [...Object.values(DOWNLOAD), ...Object.values(CARDS)]
  expect(new Set(all).size).toBe(all.length)
  expect(Object.values(DOWNLOAD).every((c) => c.startsWith('download.'))).toBe(true)
  expect(Object.values(CARDS).every((c) => c.startsWith('cards.'))).toBe(true)
})
```

- [ ] **Step 2: Move files, merge configs, `npm install`** (runs Třídění's postinstall: builds `resources/bin/ffprobe` from Homebrew; needs `brew` ffmpeg present). If Electron's binary is missing afterwards: `node node_modules/electron/install.js`.
- [ ] **Step 3: Fix relative imports** in moved src and tests (one level deeper: `../core/x` → `../../core/download/x` etc.; tests `../../src/core/x` → `../../../src/core/download/x`). Tests that assert exact channel strings (e.g. Stahování `tests/main/download/ipc.test.ts`) use the `IPC` constants or the new prefixed values.
- [ ] **Step 4: Verify**

Run: `npm test && npm run typecheck`
Expected: all tests of both apps plus the new channel test pass; typecheck clean (`src/main/index.ts` and preload do not exist yet, so nothing references them).

---

### Task 2: Cards runner can stop; one close guard for both modes

**Files:**
- Modify: `src/main/cards/runner.ts`, `src/main/close-guard.ts`
- Test: `tests/main/cards/runner.test.ts`, `tests/main/close-guard.test.ts`

**Interfaces:**
- Produces:
  - cards `Runner`: `isBusy(): boolean` (a job is queued or running), `abort(): void` (aborts the running job and every job already queued; jobs queued later run normally). Pass an `AbortSignal` to `runCard(opts, onEvent, signal)` — the pipeline already supports it and reports status `aborted`. Implementation: one `AbortController` per Runner "generation"; `abort()` aborts it and replaces it with a fresh one; each job captures the controller current at enqueue time. A queued job whose signal is already aborted still calls `runCard` (it returns `aborted` without copying) so the UI gets a summary.
  - `close-guard.ts`: keep `CloseGuard`, `KEEP_RUNNING_BUTTON`, `STOP_AND_CLOSE_BUTTON`, `CLOSE_WHILE_RUNNING_TEXT` (existing tests keep passing). Add:

```ts
export const CARD_RUNNING_TEXT =
  'Záloha karty běží. Když aplikaci zavřeš, záloha se zastaví a karta NENÍ zálohovaná. Po dalším vložení karty můžeš pokračovat, hotové soubory se znovu nenahrají.'
export const BOTH_RUNNING_TEXT =
  'Běží stahování i záloha karty. Když aplikaci zavřeš, obojí se zastaví a karta NENÍ zálohovaná. Obojí pak můžeš dokončit tam, kde skončilo.'
export const KEEP_BOTH_RUNNING_BUTTON = 'Nechat běžet'
export function closeWhileRunningText(download: boolean, cards: boolean): { message: string; keepButton: string } | null
```
  (download only → `CLOSE_WHILE_RUNNING_TEXT` + `KEEP_RUNNING_BUTTON`; cards only → `CARD_RUNNING_TEXT` + `KEEP_BOTH_RUNNING_BUTTON`; both → `BOTH_RUNNING_TEXT` + `KEEP_BOTH_RUNNING_BUTTON`; neither → `null`).

- [ ] **Step 1: Write the failing tests**
  - `tests/main/cards/runner.test.ts` `abort stops the running card and queued cards`: fake `run` (dep `run`) that resolves `{ status: 'aborted', ... }` once its `signal` aborts; start two registered cards; `isBusy()` is `true`; `runner.abort()`; `await runner.idle()`; both fake calls received an aborted signal; `isBusy()` is `false`. Second test `a card queued after abort runs normally`: after the above, a third start gets a non-aborted signal.
  - `tests/main/close-guard.test.ts` `closeWhileRunningText`: the four cases above, exact strings.
- [ ] **Step 2: Run** `npx vitest run tests/main/cards/runner.test.ts tests/main/close-guard.test.ts` — Expected: FAIL (`isBusy`/`abort`/`closeWhileRunningText` missing).
- [ ] **Step 3: Implement** as described in Interfaces.
- [ ] **Step 4: Run** `npm test && npm run typecheck` — Expected: PASS.

---

### Task 3: One-time read-only import of Třídění karet data

**Files:**
- Create: `src/main/migrate.ts`
- Test: `tests/main/migrate.test.ts`

**Interfaces:**
- Produces: `export async function importTrideniData(opts: { fromDir: string; toDir: string; log: (m: string) => void }): Promise<{ imported: string[] }>` — for each of `settings.json`, `journal.jsonl`: when `toDir/<name>` does not exist (`lstat` ENOENT) and `fromDir/<name>` is a regular file (`lstat`, not a symlink), copy with `fs.copyFile(src, dst, fs.constants.COPYFILE_EXCL)`; `EEXIST` → skip silently; any other error → log the error name (never paths with content), skip. Never writes to `fromDir`. `toDir` is created by Electron already; do not `mkdir`. Returns the names copied. Called in Task 4 with `fromDir = join(app.getPath('appData'), 'trideni-karet')`, `toDir = app.getPath('userData')`, before the cards settings/journal are first read. `apikey.bin` is never copied (Keychain item belongs to the old app).

- [ ] **Step 1: Write the failing tests** (temp dirs):
  - `copies settings and journal when the target has none` → `imported` = both, contents equal, source mtime/content unchanged.
  - `never overwrites an existing target file` → target with other content stays byte-identical, `imported` excludes it.
  - `missing source is fine` → `imported: []`, no throw.
  - `does not follow a symlinked source` → source `settings.json` is a symlink to a file → not copied.
  - `never copies apikey.bin` → source has `apikey.bin` → target does not.
- [ ] **Step 2: Run** `npx vitest run tests/main/migrate.test.ts` — Expected: FAIL (module missing).
- [ ] **Step 3: Implement** `importTrideniData`.
- [ ] **Step 4: Run** `npm test` — Expected: PASS.

---

### Task 4: Main process and preload for both modes

**Files:**
- Create: `src/main/index.ts`, `src/preload/index.ts`
- Modify: `src/main/cards/ipc.ts` only if needed to accept the window getter used here (keep its sender check)

**Interfaces:**
- Consumes: download `AuthService`, `Runner` (`isRunning`, `abort`, `idle`), `registerIpc` (download, injected `ipcMain`), `createTokenStore`, `getOAuthConfig`; cards `Runner` (`isBusy`, `abort`, `idle`, `registerCard`), `registerIpc` (cards), `loadSettings`, `loadApiKey`, `checkTools`, `watchVolumes`, `cardListener`; `CloseGuard`, `closeWhileRunningText` (Task 2); `importTrideniData` (Task 3).
- Produces: preload exposes `window.api: AppApi` = `{ download: {...Stahování preload functions on DOWNLOAD IPC}, cards: {...Třídění preload functions on CARDS IPC} }`, built to `out/preload/index.cjs`.

- [ ] **Step 1: Write `src/main/index.ts`** by merging both old `index.ts` files (in the source repos):
  - Window from Stahování's `createWindow` (900×640, title „Sportivea Záloha“, `devTools: !app.isPackaged`, all navigation blocks, `preload-error`/`did-finish-load` logs); Třídění's `did-finish-load` bridge check becomes `typeof window.api?.cards?.getSettings === "function" && typeof window.api?.download?.authStatus === "function"` → log `preload bridge ready=true`.
  - Permission request handler denies everything (Stahování). Notifications stay main-process `Notification` (Třídění).
  - One `requestSingleInstanceLock`; `second-instance` → bring to front.
  - Order in `whenReady`: `await importTrideniData(...)` → build both services/runners → `registerIpc` for both → `CloseGuard({ isRunning: () => download.isRunning() || cards.isBusy(), abort: () => { download.abort(); cards.abort() }, idle: () => Promise.all([download.idle(), cards.idle()]).then(() => undefined), confirm })` where `confirm` builds the dialog from `closeWhileRunningText(download.isRunning(), cards.isBusy())` (buttons `[keepButton, STOP_AND_CLOSE_BUTTON]`, default/cancel 0) → window `close` and `before-quit` handled as in Stahování → `createWindow()` → `watchVolumes(cardListener(...))` as in Třídění (`registerCard`, bring to front, dock bounce, send `CARDS_IPC.cardDetected` once loaded).
  - Download `send` and cards `send` both use one `sendToRenderer` that waits for `did-finish-load` (Třídění's version).
  - `will-quit` stops the watcher; `window-all-closed` does not quit on macOS (both apps).
- [ ] **Step 2: Write `src/preload/index.ts`**: the two old preloads combined under `download` / `cards`, typed `AppApi`, only `contextBridge.exposeInMainWorld('api', api)`.
- [ ] **Step 3: Verify**

Run: `npm run typecheck && npm test && npm run build && ! grep -rl GOCSPX out/preload out/renderer`
Expected: clean typecheck, tests pass, build succeeds, grep finds nothing (exit 0 from `!`).

---

### Task 5: Renderer shell — Home, both modes, Settings

**Files:**
- Create: `src/renderer/Shell.tsx`, `src/renderer/Home.tsx`, `src/renderer/SettingsView.tsx`, `src/renderer/GoogleAccount.tsx`, `src/renderer/main.tsx`, `src/renderer/strings.ts`
- Modify: `src/renderer/download/DownloadMode.tsx`, `src/renderer/cards/CardsMode.tsx`, `src/renderer/styles.css`
- Test: `tests/renderer/shell.test.tsx` (same render setup as the existing `tests/renderer/*/screens.test.tsx`)

**Interfaces:**
- Produces:
  - `Shell()`: view state `'home' | 'download' | 'cards' | 'settings'` (+ the view to return to from settings). Renders a topbar (brand button „Sportivea Záloha“ → home; link „Nastavení“ → settings) and keeps `DownloadMode` and `CardsMode` **always mounted**, hiding the inactive one with the `hidden` attribute.
  - `DownloadMode(props: { visible: boolean; onStatus: (text: string | null) => void })` — old Stahování `App` without its `<header className="topbar">`; keeps `AccountBar` at the top of its own content; re-fetches `authStatus()` when `visible` turns true; reports `onStatus(\`Stahuje se – ${pct} %\`)` while running (pct = rounded done/total bytes), `onStatus(null)` otherwise.
  - `CardsMode(props: { visible: boolean; onStatus: (text: string | null) => void; onCardArrived: () => void; onOpenSettings: () => void })` — old Třídění `App` without its topbar and without its `settings` view (`onOpenSettings` replaces every `setView({ name: 'settings' })`); reloads settings + `hasApiKey` when `visible` turns true; calls `onCardArrived()` on `onCardDetected`; reports `onStatus(\`Karta ${volumeName} – zálohuje se\`)` for the first active run (+ ` (další ve frontě: N)` when more), `'Čeká nová karta'` when a card is pending, else `null`. The ffprobe/ffmpeg `TOOLS_MISSING_MESSAGE` callout lives inside `CardsMode` only (downloads still work).
  - `Home(props: { downloadStatus: string | null; cardsStatus: string | null; onDownload: () => void; onCards: () => void })` — two big buttons „Stáhnout z Drivu“ (sub „Celá složka z Google Disku na externí disk“) and „Nahrát kartu“ (sub „Roztřídit, pojmenovat a nahrát na Drive“), each showing its status line when not null.
  - `SettingsView(props: { onBack: () => void })` — section „Google účet“ (`GoogleAccount`) above section „Třídění karet“ (the existing cards `SettingsScreen`, fed by its own `getSettings`/`hasApiKey` load).
  - `GoogleAccount()` — shows the signed-in e-mail or „Nepřihlášeno“; button „Odhlásit“ calls `api().signOut()` and shows its Czech error (e.g. during a download) in a `callout bad`.
  - Shell rules: `onCardArrived` switches to `cards` unless the view is `settings`. Leaving a mode never stops a run.
  - `styles.css`: union of both stylesheets; for selectors in both, keep Třídění's rule; Stahování-only selectors appended; Stahování's accent kept for the download mode via `.mode-download { --accent: #2a5bd7; --accent-hover: #1f47ad; }` (plus its dark-mode values from its stylesheet) on the `DownloadMode` wrapper.

- [ ] **Step 1: Write the failing tests** `tests/renderer/shell.test.tsx` with a stubbed `window.api` (fake `download` and `cards` objects; `onCardDetected` captures its listener):
  - `home shows both choices` → buttons „Stáhnout z Drivu“, „Nahrát kartu“.
  - `card arrival switches to cards and keeps download mounted` → open download, type a link into its input, fire the captured card listener → cards view visible, download container still in the DOM (hidden) with the typed link.
  - `card arrival does not leave settings` → in settings, fire listener → settings still shown.
  - `home shows a running download` → download `runStatus` resolves running 50 % → after going home, text „Stahuje se – 50 %“.
  - `sign-out error is shown` → `signOut` resolves `{ ok: false, error: 'Během stahování se nejde odhlásit.' }` → text shown.
- [ ] **Step 2: Run** `npx vitest run tests/renderer/shell.test.tsx` — Expected: FAIL (`Shell` missing).
- [ ] **Step 3: Implement** the components and CSS above; `main.tsx` renders `<Shell />` in `StrictMode`.
- [ ] **Step 4: Run** `npm test && npm run typecheck && npm run build` — Expected: PASS.
- [ ] **Step 5: Live check in dev**: `npm run dev` (log shows `did-finish-load` and `preload bridge ready=true`, `tools ok=true`); in the window: Home → Stáhnout z Drivu shows the Google sign-in or the folder form; Nahrát kartu shows „Zasuň kartu“; Nastavení shows both sections. Do not start a download or card run.

---

### Task 6: Package that runs without the dev setup

**Files:**
- Modify: `package.json` (script `app`)
- Create: `scripts/check-bundle.mjs`

**Interfaces:**
- Produces: `npm run app` = `node scripts/bundle-ffprobe.mjs --require && electron-vite build && electron-packager . "Sportivea Záloha" --platform=darwin --arch=arm64 --out=dist --overwrite --app-bundle-id=cz.sportivea.zaloha --asar.unpackDir="node_modules/ffmpeg-static" --extra-resource=resources/bin --ignore=<union of both ignore lists> && codesign --force --deep --sign - "dist/Sportivea Záloha-darwin-arm64/Sportivea Záloha.app" && node scripts/check-bundle.mjs "dist/Sportivea Záloha-darwin-arm64/Sportivea Záloha.app"`. If the diacritic name breaks packager, use `Sportivea Zaloha` for the bundle and keep the window title with diacritics; record the choice in `CLAUDE.md`.
- `scripts/check-bundle.mjs <app>` exits 1 with a message on any failure:
  1. `codesign --verify --deep --strict <app>` succeeds.
  2. For every Mach-O file under `Contents/Resources/bin/` and `app.asar.unpacked/node_modules/ffmpeg-static/`: `otool -L` lists no `/opt/homebrew`, `/usr/local`, or `/Users/`.
  3. No file named `.env*` anywhere in the bundle (`npx asar list` for `app.asar` plus a walk of unpacked files).
  4. In `app.asar`, `out/preload` and `out/renderer` contain no `GOCSPX`; `out/main` does (OAuth constants were injected).
  5. No file in `app.asar` contains the string `/Users/kolda` (source maps included).
  6. `app.asar` contains `node_modules/google-auth-library` and `node_modules/@anthropic-ai/sdk`.

- [ ] **Step 1: Write `scripts/check-bundle.mjs`**; run it against a deliberately wrong path → Expected: exit 1 with a Czech or English message naming the failed check.
- [ ] **Step 2: Run** `npm run app` (may fail once with `fetch failed` while fetching Electron: rerun) — Expected: all six checks print OK.
- [ ] **Step 3: Smoke-run the package without the dev environment**:

```bash
TMPHOME="$(mktemp -d)"
env -i HOME="$TMPHOME" PATH=/usr/bin:/bin "dist/Sportivea Záloha-darwin-arm64/Sportivea Záloha.app/Contents/MacOS/Sportivea Záloha" --user-data-dir="$TMPHOME/ud" 2>&1 | tee "$TMPHOME/log.txt" &
```
Expected within ~20 s in the log: `did-finish-load`, `preload bridge ready=true`, `tools ok=true`. Then quit the process (`kill` the PID; no run is active). If `--user-data-dir` is ignored by this Electron version, note it and instead check that the run used `~/Library/Application Support/sportivea-zaloha/` (allowed: it is the new app's own folder).
- [ ] **Step 4: Zip for transfer**: `ditto -c -k --keepParent "dist/…/Sportivea Záloha.app" "dist/Sportivea-Zaloha.zip"`; unzip to a temp dir with `ditto -x -k`, run `codesign --verify --deep --strict` on the unzipped app → Expected: valid.

---

### Task 7: Docs for the next session and for the company Mac

**Files:**
- Create: `CLAUDE.md`, `README.md` (Czech), `docs/architecture.md`, `docs/company-mac-install.md` (Czech)

- [ ] **Step 1: `CLAUDE.md`** (lean, English, like the two source `CLAUDE.md` files): what the app is, the two modes, safety rules summary, structure (`download/` vs `cards/` in core/main/renderer/tests, `Shell`), commands (`dev`, `test`, `typecheck`, `build`, `app`, `eval`, `TRIDENI_INTEGRATION=1 npm test`), settings and gotchas carried over from both source `CLAUDE.md` files (OAuth `.env`, ffprobe bundling, Electron install script, pinned versions, channel prefixes `download.` / `cards.`, userData `sportivea-zaloha`, one-time Třídění import), status, and a pointer that the source repos stay untouched.
- [ ] **Step 2: `docs/architecture.md`**: the two source architecture docs merged under „Stahování z Drivu“ and „Nahrát kartu“ headings with updated paths, plus a „Spojení“ section: Shell/Home/Settings, IPC prefixes, combined close guard, cards abort, import, data locations, packaging and `check-bundle.mjs`. Keep rulings and known limitations of both.
- [ ] **Step 3: `docs/company-mac-install.md`** (Czech, for Jan): requirements (macOS on Apple Silicon; Google Drive pro počítač signed in as `video@sportivea.cz` with write access to the shared drive; folders to download shared with that account; one macOS user for all editors; admin password). Steps: copy `Sportivea-Zaloha.zip` (AirDrop/Drive), unzip, move app to `/Applications`, first open → blocked → Nastavení systému → Soukromí a zabezpečení → „Přesto otevřít“; allow access to removable volumes, the Google Drive folder and notifications; optional: copy Jan's `~/Library/Application Support/sportivea-zaloha/settings.json` to the same path on the company Mac before first start (templates, rosters, threshold); in the app: Nastavení → Claude klíč, kořenová složka „Kam nahrát“ inside the Drive folder; Stáhnout z Drivu → Přihlásit se přes Google (`video@sportivea.cz`); add the app to Nastavení systému → Obecné → Položky při přihlášení. Rules: one card only on one computer; after each new version macOS may ask for the user password for the Keychain → „Vždy povolit“; on Jan's Mac don't start the old apps once the new one is in use, remove them when satisfied. Updating: replace the app in `/Applications` (data and settings stay).
- [ ] **Step 4: `README.md`** (Czech): short daily use of both modes, link to the install guide, dev commands.
- [ ] **Step 5: Verify** every command and path named in the docs exists (`npm run` lists the scripts; paths resolve).

---

### Final verification (whole project)

- [ ] `npm test && npm run typecheck && npm run build` — all pass.
- [ ] `npm run app` — six bundle checks OK, smoke run log OK.
- [ ] `git -C ../stahovani-z-disku status --short` and `git -C ../trideni-karet status --short` unchanged from before the work; `/Applications` apps untouched.
- [ ] Note for Jan what was not verified live (real card run and real download in the merged app, the company Mac itself, Gatekeeper „Přesto otevřít“ flow).
