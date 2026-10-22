# Třídění karet — macOS Electron app

Sorts camera-card footage (read-only source) and copies it, renamed and categorised, to a
Google Drive folder (add-only destination). AI classification via Anthropic API; AI failure
never blocks the backup. UI copy is Czech, code/commits are English.

Docs: `README.md` (Czech, install and daily use, dev commands), `docs/architecture.md` (module map,
data flow, where safety rules are enforced, rulings, known limitations), `docs/eval.md` (classifier eval),
spec (Czech, source of truth for behaviour): `docs/superpowers/specs/2026-10-22-trideni-karet-design.md`.
Task plan/constraints: `.superpowers/sdd/2026-10-22-trideni-karet/` (gitignored).

## Safety rules (summary — see spec and docs/architecture.md)
- Card is read-only: never write/rename/delete/format the source volume.
- Destination is add-only: never delete/move/overwrite; final writes use `wx` or link/rename of own temp file.
- API key only in macOS Keychain via Electron `safeStorage`; never in code, repo or logs.
- No `any`; unknown input goes through Zod.

## Structure
- `src/core/` — pure TypeScript (no Electron), Vitest-tested: card scan, probe/frames, markers, naming, classifier, copy, journal, pipeline, csv
- `src/main/` — Electron main (settings, watcher, queue, runner, IPC, secrets, window)
- `src/shared/ipc-types.ts`, `src/preload/` (built to `out/preload/index.cjs`), `src/renderer/` (React 19, Czech UI)
- `scripts/` — `bundle-ffprobe.mjs` (self-contained arm64 ffprobe), `eval.ts`
- `tests/` mirrors `src/`; `resources/bin/` is generated (gitignored)

## Commands
- `npm run dev` / `npm run build` / `npm test` / `npm run typecheck`
- `TRIDENI_INTEGRATION=1 npm test` — real-card tests (Istanbul card, ~10 min)
- `npm run eval` — classifier eval (needs `ANTHROPIC_API_KEY`, see docs/eval.md)
- `npm run app` — bundle ffprobe, build, package to `dist/Trideni karet-darwin-arm64/Trideni karet.app`
  (may fail once with `fetch failed` while fetching Electron: rerun)

## Bundled ffmpeg / ffprobe
- `ffmpeg-static` (arm64) in `app.asar.unpacked`. `ffprobe-static`'s darwin/arm64 binary is x86_64, so
  `scripts/bundle-ffprobe.mjs` (postinstall + `npm run app`) builds `resources/bin/ffprobe` + `resources/bin/lib/*.dylib`
  from Homebrew ffmpeg (needs `brew install ffmpeg`), rewritten to `@loader_path` and ad-hoc signed. No `/opt/homebrew` references remain.
  postinstall only warns when it cannot bundle; `npm run app` passes `--require` and fails. The app checks both binaries at start (`src/main/tools.ts`).
- `ffprobePath()` prefers `resources/bin` (packaged: `process.resourcesPath/bin`). Env overrides: `TRIDENI_FFMPEG`, `TRIDENI_FFPROBE`.
- First spawn of a binary can take several seconds; tests use a 30 s timeout.

## Runtime files (`app.getPath('userData')`)
`settings.json`, `journal.jsonl`, `apikey.bin` (safeStorage-encrypted). The pipeline never creates the event folder; `run:start` does it once.

## Status
v1 built on branch `feat/v1` (all features, packaging, docs). Pending: classifier eval (needs API key and Jan's budget approval),
GitHub repo (`Kolda1684/trideni-karet`, private) created by the controller. Unverified: native dialogs, link/rename on a real Drive volume.
