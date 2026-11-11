# Sportivea Záloha — macOS Electron app

One app with two modes, merged from two earlier apps (their repos stay untouched and are the history of each mode):
- **Stáhnout z Drivu** — whole Google Drive folder → external disk, file by file, MD5-verified, resumable, duplicates by content. From `../stahovani-z-disku` (branch `feat/v1`).
- **Nahrát kartu** — camera card → classify with Claude, rename `<cameraID>[_TOP][_popis].ext`, copy into a Google Drive for desktop folder. From `../trideni-karet` (branch `main`, GitHub `Kolda1684/trideni-karet`; this repo was started from its history).

UI copy Czech; code, file names, commits English. Docs: `README.md` (Czech, daily use), `docs/company-mac-install.md` (Czech, install on the company Mac), `docs/architecture.md` (module map, data flow, where rules are enforced, rulings, limitations), `docs/eval.md` (classifier eval). Spec: `docs/superpowers/specs/2026-11-05-sportivea-zaloha-design.md` (the two original specs it references are in the source repos). Plan: `docs/superpowers/plans/2026-11-05-sportivea-zaloha.md`; ledger `.superpowers/sdd/` (gitignored).

## Safety rules (summary — see spec and docs/architecture.md)
- Google Drive is never changed: scope exactly `drive.readonly`, GET only. Card upload is a file copy into the Drive for desktop folder, never the Drive API.
- Card read-only. Destinations (external disk, Drive folder) add-only: no overwrite, delete or move; only the app's own temp files.
- „Hotovo“ / „Zapsáno a ověřeno“ only when every file is verified; „NENÍ dokončené“ / „Karta ještě NENÍ zálohovaná“ texts are never reworded.
- Secrets only via `safeStorage` (Keychain): `google-token.bin`, `apikey.bin` in userData. OAuth client ID/secret only in `.env` (gitignored, never print it), injected into `out/main` only.
- Window: `sandbox`, `contextIsolation`, no `nodeIntegration`, strict CSP, navigation/`window.open`/permissions blocked, every IPC handler checks the sender and validates with Zod. No `any`.

## Structure
- `src/core/download/`, `src/core/cards/` — pure TypeScript per mode (Vitest)
- `src/main/index.ts` (one window, both runners, watcher, close guard), `src/main/close-guard.ts` (asks before close/quit when either mode runs), `src/main/migrate.ts` (one-time read-only import of Třídění karet `settings.json` + `journal.jsonl`), `src/main/download/*`, `src/main/cards/*`
- `src/shared/download-ipc.ts`, `src/shared/cards-ipc.ts` (channels prefixed `download.` / `cards.`), `src/shared/api.ts` (`AppApi = { download, cards }` = `window.api`)
- `src/preload/index.ts` (CJS `out/preload/index.cjs`)
- `src/renderer/Shell.tsx` (top bar, Home, Settings; both modes always mounted, inactive one `hidden`), `shell-state.ts` (pure view reducer + home status texts), `Home.tsx`, `SettingsView.tsx`, `GoogleAccount.tsx`, `download/DownloadMode.tsx` + screens, `cards/CardsMode.tsx` + screens. Each subtree calls main via its `api()` helper.
- `tests/` mirrors `src/` (`tests/helpers/fake-drive.ts` = local fake Drive; `tests/fixtures/` = generated clips)
- `scripts/`: `bundle-ffprobe.mjs`, `eval.ts`, `check-bundle.mjs`, `sign-and-zip.sh`

## Commands
- `npm run dev` (log: `did-finish-load`, `preload bridge ready=true`, `tools ok=true`; needs `.env`)
- `npm test` / `npm run typecheck` / `npm run build`
- `TRIDENI_INTEGRATION=1 npm test` — real-card tests (Istanbul card, ~10 min)
- `npm run eval` — classifier eval (needs `ANTHROPIC_API_KEY`, see `docs/eval.md`)
- `npm run app` — bundle ffprobe, build, package, ad-hoc sign + check + zip → **`dist/Sportivea-Zaloha.zip`** (the install artifact). May fail once with `fetch failed` while fetching Electron: rerun.

## Settings and gotchas
- `.env`: `GOOGLE_OAUTH_CLIENT_ID`, `GOOGLE_OAUTH_CLIENT_SECRET` (Google Cloud project `stahovani-z-disku`, Internal, Desktop client). Build fails when empty. `check-bundle.mjs` verifies `GOCSPX` is only in `out/main`.
- userData = `~/Library/Application Support/sportivea-zaloha/` (from `package.json` `name`; do not add `productName`, it would rename the folder). Bundle ID `cz.sportivea.zaloha`. Old apps' data folders are only read by `migrate.ts`.
- The project sits in iCloud-synced Desktop: File Provider puts `com.apple.FinderInfo` on bundles and breaks `codesign --verify --strict`. That is why `sign-and-zip.sh` signs in a temp dir. Install from the zip, not from `dist/…/*.app`.
- `npm run app` checks: valid signature, no `/opt/homebrew`//usr/local//Users in Mach-O load commands of `Resources/bin` and `ffmpeg-static`, no `.env`, `GOCSPX` only in main, no `/Users/kolda` in `app.asar`, runtime deps present.
- ffprobe: `ffprobe-static`'s arm64 binary is x86_64, so `scripts/bundle-ffprobe.mjs` (postinstall + `npm run app`) builds `resources/bin/ffprobe` + dylibs from Homebrew ffmpeg (`brew install ffmpeg`), rewritten to `@loader_path`. Env overrides `TRIDENI_FFMPEG` / `TRIDENI_FFPROBE`. First spawn can take seconds; tests use a 30 s timeout.
- Electron 45 does not download its binary on `npm install`; run `node node_modules/electron/install.js` when `npm run dev` says "Electron uninstall".
- Dependencies pinned to exact versions (no `^`). `google-auth-library` and `@anthropic-ai/sdk` are runtime dependencies shipped in `app.asar/node_modules`.
- Renderer tests are static renders in Node (no DOM library): put logic in pure functions (`shell-state.ts`, `runState.ts`) and test those.
- Card runner: `abort()` aborts the running and queued cards (status `aborted`); the signal reaches `copyVerified`, so an in-flight clip copy stops at once and removes its own temp. Used by the close guard only.
- `migrate.ts` runs once per Mac: after the first attempt it writes `.imported-trideni-karet` into userData.

## Status (2026-11-11)
Merged app built on branch `feat/merge`: all tests of both apps + new ones pass, package checks pass, packaged app starts without PATH/Homebrew/.env. Final review (opus) done and all its findings fixed (ledger: `.superpowers/sdd/2026-11-05-sportivea-zaloha/progress.md`). Not yet verified live: a real download and a real card run in the merged app, the company Mac itself (Gatekeeper „Přesto otevřít“, permission prompts), the visual look of the new Home/Settings screens.
