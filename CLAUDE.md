# Třídění karet — macOS Electron app

Sorts camera-card footage (read-only source) and copies it, renamed and categorised, to a
Google Drive folder (add-only destination). AI classification via Anthropic API; AI failure
never blocks the backup. UI copy is Czech, code/commits are English.

Spec (Czech, source of truth for behaviour and safety rules):
`docs/superpowers/specs/2026-10-22-trideni-karet-design.md`. Task plan/constraints:
`.superpowers/sdd/2026-10-22-trideni-karet/` (gitignored).

## Safety rules (summary — see spec)
- Card is read-only: never write/rename/delete/format the source volume.
- Destination is add-only: never delete/move/overwrite; final writes use `wx` or link/rename of own temp file.
- API key only in macOS Keychain via Electron `safeStorage`; never in code, repo or logs.
- No `any`; unknown input goes through Zod.

## Structure
- `src/core/` — pure TypeScript modules (no Electron imports), tested with Vitest
  - `bin.ts` — `ffmpegPath()` / `ffprobePath()`
- `src/main/` — Electron main process. Electron-free (unit-tested): `settings.ts`, `watcher.ts` (/Volumes card detection),
  `queue.ts` (one job at a time), `runner.ts` (`run:start` validation, event folder, pipeline job, notices), `cardinfo.ts`.
  Electron-dependent (not tested): `index.ts` (window, watcher, notifications), `ipc.ts` (`ipcMain.handle`, Zod-validated), `secrets.ts` (safeStorage)
- `src/shared/ipc-types.ts` — IPC channel names, payload types, `Api` (`window.api`), `Settings`
- `src/preload/` — contextBridge preload exposing `window.api` (`index.ts`, built to `out/preload/index.cjs`)
- `src/renderer/` — React 19 UI (`index.html`, `main.tsx`)
- `src/types/` — ambient type declarations (`ffprobe-static`)
- `tests/` — Vitest tests mirroring `src/`
- `scripts/postinstall.mjs` — copies arm64 ffprobe into `resources/bin/` (gitignored)

## Commands
- `npm run dev` — electron-vite dev (window + HMR)
- `npm run build` — build main/preload/renderer into `out/`
- `npm test` — `vitest run`
- `npm run typecheck` — `tsc` for renderer (`tsconfig.json`) and node side (`tsconfig.node.json`)
- `npm run app` — build + package to `dist/` with `@electron/packager` (darwin arm64)

## Bundled ffmpeg / ffprobe
- `ffmpeg-static` 5.3 ships a genuine arm64 ffmpeg.
- `ffprobe-static` 3.1: its `bin/darwin/arm64/ffprobe` is actually an **x86_64** binary (runs
  only via Rosetta). `scripts/postinstall.mjs` therefore copies `/opt/homebrew/bin/ffprobe`
  (arm64) to `resources/bin/ffprobe`; `ffprobePath()` prefers it (packaged app: `process.resourcesPath/bin`,
  added via `--extra-resource=resources/bin`). Needs Homebrew ffmpeg installed when running `npm install`.
- Caveat: the Homebrew ffprobe is dynamically linked to `/opt/homebrew/Cellar/ffmpeg/...` dylibs,
  so it runs only on a Mac with that Homebrew ffmpeg installed.
- In a packaged app `app.asar` paths are rewritten to `app.asar.unpacked` (`--asar.unpackDir` in `npm run app`).
- Env overrides: `TRIDENI_FFMPEG`, `TRIDENI_FFPROBE`.
- First spawn of a binary can take several seconds (macOS scan); tests use a 30 s timeout.

## Runtime files (`app.getPath('userData')`)
`settings.json`, `journal.jsonl`, `apikey.bin` (safeStorage-encrypted; refused if encryption is unavailable).
The pipeline never creates the event folder: `run:start` does it once (non-recursive `mkdir` under an existing `rootDir`).

## Status
Core modules and main process (settings, Keychain, card watcher, queue, IPC) done. UI follows in later tasks.
