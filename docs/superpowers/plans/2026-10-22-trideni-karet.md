# Třídění karet Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Mac app that reads a camera card in place, classifies each clip with Claude Sonnet 5.5, flags TOP shots from black hand-markers, and copies everything (verified, never overwriting or deleting) into an event folder inside the Google Drive for desktop mount.

**Architecture:** All logic lives in pure TypeScript modules under `src/core/` (testable with Vitest, no Electron). `src/core/pipeline.ts` orchestrates scan → probe → markers → classify → copy → verify → CSV. Electron main (`src/main/`) adds volume watching, settings/Keychain, a job queue and IPC; the React renderer (`src/renderer/`) is a thin Czech UI over IPC events.

**Tech Stack:** Electron 45, electron-vite 6, TypeScript 7 (strict), React 19.3, Vite 8, Vitest 5, `@anthropic-ai/sdk` 1.1 (+ `zodOutputFormat`), Zod 4.6, `ffmpeg-static` 5.3 / `ffprobe-static` 3.1, `@electron/packager` 20.3, Node 24.

**Spec:** `docs/superpowers/specs/2026-10-22-trideni-karet-design.md`

## Global Constraints

- The card is read-only: no write, rename, delete or format on the source volume, ever. Open source files with `fs.createReadStream` / read-only `fs.open(path, 'r')` only.
- The destination is add-only: never delete, move or overwrite. Every final write uses flag `'wx'` or `fs.link`/`rename` from a temp file the app itself created in the same run. A temp file that fails verification is left in place and reported, not removed.
- AI failure never blocks backup: a clip whose classification fails goes to `_nezařazeno` under its original file name.
- Black markers are not copied; they are listed in the CSV.
- Naming: `<base>_<description>.<ext>`; TOP: `<base>_TOP_<description>.<ext>`; description 1–4 words, lowercase ASCII, hyphen-joined, max 40 chars, never repeats the category.
- Model default `claude-sonnet-5-5`, switchable to `claude-opus-5-5` / `claude-haiku-5-5`; `output_config.effort: "low"`; structured output via `zodOutputFormat`.
- API key only in macOS Keychain via Electron `safeStorage`; never in code, repo or logs.
- TypeScript strict, no `any` (use `unknown` + Zod). Latest stable dependency versions listed above.
- UI copy is Czech, no technical jargon. Fixed strings: `Zasuň kartu`, `Karta ještě NENÍ zálohovaná`, final `Zapsáno a ověřeno. Kartu můžeš vytáhnout. Drive dokončuje upload, kartu formátuj až po jeho dokončení (ikona Drive v liště).`
- Commits under `jan.kolar@sportivea.cz`; `.env*`, `out/`, `dist/`, `node_modules/` gitignored.
- Price table for cost display (USD / 1M tokens): Sonnet 5.5 in 2.00 / out 10.00 / cache read 0.20; Opus 5.5 4.00 / 20.00 / 0.20; Haiku 5.5 0.10 / 0.50 / 0.01. CZK rate default 23 (setting).

## Review Focus

1. **Card pulled out mid-copy** → run stops with status `card_removed`, nothing on destination is deleted, re-running the same card skips already-verified files via the journal. Test in Task 7.
2. **Destination already holds a different file with the same target name** (second camera with `C0001`) → camera tag appended (`C0001-ILCE7M4_gol.MP4`), then ` (2)`; never overwrite. Test in Task 6 + Task 7.
3. **Same card inserted twice into the same event** → zero new files, summary shows `alreadyUploaded` for all. Test in Task 7.
4. **Destination disk nearly full** (Drive cache) → copy waits instead of failing or partially writing; resumes when space returns. Test in Task 6 (injected `freeBytes`).
5. **Model returns a category not in the template, an empty/garbage description, or `stop_reason: "refusal"`** → clip goes to `_nezařazeno` (garbage category/refusal) or gets description `klip` (empty description); never crashes the run. Test in Task 5.

---

### Task 1: Project scaffold and bundled ffmpeg

**Files:**
- Create: `package.json`, `tsconfig.json`, `tsconfig.node.json`, `electron.vite.config.ts`, `vitest.config.ts`, `.gitignore`, `CLAUDE.md`, `src/core/bin.ts`, `src/main/index.ts` (empty window), `src/preload/index.ts`, `src/renderer/index.html`, `src/renderer/main.tsx`
- Test: `tests/core/bin.test.ts`

**Interfaces:**
- Produces: `ffmpegPath(): string`, `ffprobePath(): string` (resolve `ffmpeg-static` / `ffprobe-static`; in a packaged app rewrite `app.asar` → `app.asar.unpacked`; env override `TRIDENI_FFMPEG` / `TRIDENI_FFPROBE`). npm scripts: `dev`, `build`, `test` (`vitest run`), `app` (package).

- [ ] **Step 1:** Init with the versions from Tech Stack; `git config user.email jan.kolar@sportivea.cz` in the repo.
- [ ] **Step 2: Write failing test** `tests/core/bin.test.ts`: `it("bundled ffmpeg and ffprobe run")` — spawn each path with `-version`, expect exit 0 and stdout matching `/ffmpeg version|ffprobe version/`; assert both binaries are arm64 (`file <path>` contains `arm64`).
- [ ] **Step 3:** Run `npm test` → FAIL (module missing).
- [ ] **Step 4:** Implement `src/core/bin.ts`. If `ffprobe-static` ships no darwin-arm64 binary, add a postinstall script that copies `/opt/homebrew/bin/ffprobe` into `resources/bin/`, resolve it from there, and note it in `CLAUDE.md`.
- [ ] **Step 5:** `npm test` → PASS; `npm run dev` opens an empty window.
- [ ] **Step 6:** Write `CLAUDE.md` (what the app is, structure, commands, safety rules link to spec). Commit `chore: scaffold electron app with bundled ffmpeg`.

### Task 2: Card scan and naming

**Files:**
- Create: `src/core/types.ts`, `src/core/card.ts`, `src/core/naming.ts`
- Test: `tests/core/card.test.ts`, `tests/core/naming.test.ts`

**Interfaces:**
- Produces (`types.ts`): `type CardFile = { relPath: string; absPath: string; size: number; kind: "video" | "other" }`.
- Produces (`card.ts`): `scanCard(root: string): Promise<CardFile[]>` — recursive; skips system entries `._*`, `.DS_Store`, `.Spotlight-V100`, `.fseventsd`, `.Trashes`, `.TemporaryItems`; video = extensions `mp4 mov mxf mts m2ts m4v avi` (case-insensitive). `looksLikeCard(root: string): Promise<boolean>` — true if `PRIVATE/M4ROOT/CLIP`, `DCIM`, `PRIVATE/AVCHD`, `CLIP` or `XDROOT` exists.
- Produces (`naming.ts`): `parseOriginalName(fileName: string): { base: string; handLabel?: string; ext: string }`; `slugify(text: string, maxLen?: number): string` (default 40); `buildName(p: { base: string; description: string; top: boolean; ext: string; cameraTag?: string }): string`; `withConflictSuffix(name: string, n: number): string`.

- [ ] **Step 1: Write failing tests** `naming.test.ts`:
  - `parseOriginalName("FX3-A_9347_šance.MP4")` → `{ base: "FX3-A_9347", handLabel: "šance", ext: "MP4" }`
  - `parseOriginalName("A75_0449.MP4")` → `{ base: "A75_0449", ext: "MP4" }`; `"C0012.MP4"` → base `C0012`; `"DSC_5001.MOV"` → base `DSC_5001`
  - `parseOriginalName("Berďa vyhraný gem_C0012.MP4")` → `{ base: "C0012", handLabel: "Berďa vyhraný gem", ext: "MP4" }`
  - `parseOriginalName("Nohy.MP4")` → `{ base: "nohy", ext: "MP4" }` (no camera number: whole name slugified becomes base)
  - `slugify("Gól Kačor!! ")` → `"gol-kacor"`; 60-char input → ≤ 40 chars, no trailing hyphen
  - `buildName({ base: "FX3-A_9347", description: "sance-kacor", top: true, ext: "MP4" })` → `"FX3-A_9347_TOP_sance-kacor.MP4"`
  - `buildName({ base: "C0001", description: "gol", top: false, ext: "MP4", cameraTag: "ILCE7M4" })` → `"C0001-ILCE7M4_gol.MP4"`
  - `withConflictSuffix("C0001_gol.MP4", 2)` → `"C0001_gol (2).MP4"`
  `card.test.ts` (build a temp tree): skips `._C0001.MP4` and `.Spotlight-V100/x`; classifies `.mov` as video and `.XML` / `.JPG` as other; `looksLikeCard` true for a tree with `PRIVATE/M4ROOT/CLIP`, false for a plain folder.
- [ ] **Step 2:** `npm test` → FAIL.
- [ ] **Step 3:** Implement. Camera-number pattern: `/(?:[A-Za-z0-9]+-?[A-Za-z]?_)?\d{3,5}$|^C\d{4}$|^DSC_\d{4}$/` style — the tests define the accepted shapes; hand label = remainder before/after the matched base, trimmed of `_ -`.
- [ ] **Step 4:** `npm test` → PASS. Commit `feat: card scan and naming rules`.

### Task 3: Probe, frames and luma

**Files:**
- Create: `src/core/probe.ts`, `src/core/frames.ts`
- Test: `tests/core/probe-frames.test.ts`, `tests/fixtures/make-clips.ts` (generates test clips with ffmpeg `lavfi`: `black_0_6s.mp4` 0.6 s `color=black`, `bright_5s.mp4` 5 s `testsrc2`, `half_dark_1s.mp4` 1 s first 0.6 s black then testsrc2)

**Interfaces:**
- Produces: `type ClipMeta = { durationS: number; width: number; height: number; fps: number; createdAt: Date | null; cameraModel: string | null }`; `probeClip(absPath: string): Promise<ClipMeta>` (createdAt from `format.tags.creation_time`; cameraModel from embedded Sony XML `modelName="…"` found in the file tail, else `null`).
- Produces: `frameLumas(absPath: string, durationS: number, samples?: number): Promise<number[]>` — default 6 samples evenly over the clip, each the mean luma 0..1 of a 64×36 8-bit gray frame. `contactSheet(absPath: string, durationS: number): Promise<Buffer>` — JPEG 1024×576, 2×2 tiles of frames at 15/40/65/90 %, each frame lifted for log footage (`curves`/`eq` contrast+saturation boost) so the model sees a normal-looking image.
- All ffmpeg calls: `-ss` before `-i`, `stdin` ignored, 60 s timeout.

- [ ] **Step 1: Write failing tests:** `probeClip(bright_5s)` → duration ≈ 5 (±0.1), width 1280 (fixture size); `frameLumas(black_0_6s)` → every value < 0.05; `frameLumas(bright_5s)` → mean > 0.3; `contactSheet(bright_5s)` → Buffer starting `FF D8`, decoded size 1024×576 (check with ffprobe on a temp file).
- [ ] **Step 2:** FAIL. **Step 3:** Implement. **Step 4:** PASS. **Step 5:** Commit `feat: ffprobe metadata, frame luma and contact sheets`.

### Task 4: Black markers and TOP detection

**Files:**
- Create: `src/core/markers.ts`
- Test: `tests/core/markers.test.ts`, `tests/core/markers.istanbul.test.ts`

**Interfaces:**
- Consumes: `ClipMeta`, `frameLumas` (Task 3).
- Produces: `type MarkerInput = { id: string; durationS: number; createdAt: Date | null; cameraKey: string; lumas: number[] }`; `type MarkerResult = { markers: Set<string>; top: Set<string>; orphanMarkers: Set<string> }`; `detectMarkers(clips: MarkerInput[], opts?: { maxDurationS?: number; lumaThreshold?: number; maxGapS?: number }): MarkerResult`. Defaults `maxDurationS 2.0`, `lumaThreshold 0.20`, `maxGapS 60`.

Rules (spec): marker ⇔ `durationS < maxDurationS` and at least half of `lumas` are `< lumaThreshold`. Clips sorted by `createdAt` (then id) per `cameraKey`; TOP = the clip immediately before a marker in the same camera, if it is not itself a marker and the gap between its end (`createdAt + durationS`) and the marker's `createdAt` ≤ `maxGapS`; otherwise the marker is orphaned.

- [ ] **Step 1: Write failing unit tests:** a 0.5 s clip with lumas `[0.02,0.03,0.4,0.02,0.02,0.5]` is a marker and makes the previous 15 s clip TOP; a 1.4 s clip with all lumas 0.6 is not a marker; a marker whose previous clip ended 90 s earlier is orphaned; two markers in a row → second is orphaned; markers never cross `cameraKey`.
- [ ] **Step 2: Write integration test** `markers.istanbul.test.ts` (`describe.skipIf(!existsSync("/Users/kolda/Desktop/Istanbul"))`): run probe + `frameLumas` + `detectMarkers` over the root `*.MP4` files plus all files in subfolders, mapping current names back to original names via `_trideni_mapovani.csv`; expect `markers` = the 14 files the CSV marks `černá značka` and `top` = the 14 files whose new name contains `_TOP_`.
- [ ] **Step 3:** FAIL. **Step 4:** Implement. **Step 5:** PASS (integration may take minutes; mark `{ timeout: 600_000 }`). **Step 6:** Commit `feat: black marker and TOP detection`.

### Task 5: Templates, roster and Claude classifier

**Files:**
- Create: `src/core/templates.ts`, `src/core/roster.ts`, `src/core/classifier.ts`, `src/core/pricing.ts`
- Test: `tests/core/templates-roster.test.ts`, `tests/core/classifier.test.ts`

**Interfaces:**
- Produces (`templates.ts`): `type Category = { name: string; hint: string }`; `type Template = { id: string; name: string; categories: Category[] }`; `UNCLASSIFIED = "_nezařazeno"`, `OTHER_FILES = "_ostatni"`; `DEFAULT_TEMPLATES: Template[]` with exactly:
  - `fotbal` / „Fotbal": `Trénink` (trénink a tisková konference den před zápasem, detaily prázdného stadionu), `předzápas` (příchod a procházka hráčů v oblecích po hřišti), `rozcvička` (rozcvička týmů a brankářů na hřišti před zápasem), `nástup` (tunel, nástup s dětmi, hymna, týmová fotka, funkcionáři před nástupem), `Zápas` (samotná hra, akce, šance, fanoušci během zápasu), `děkovačka` (poděkování fanouškům po zápase, odchod ze hřiště, rozhovory po zápase).
  - `tenis` / „Tenis": `Hra`, `Fanoušci`, `Lavička`, `Nástup`, `Sponzoři` with hints: hra a hráči na kurtu včetně oslav po bodu / tribuny, kotel, vlajky, reakce diváků / kapitán a tým na lavičce / nástup, hymna, los, světelná show / reklamní plochy a sponzorské prvky.
- Produces (`roster.ts`): `type RosterEntry = { number: number; surname: string }`; `parseRoster(text: string): RosterEntry[]` (lines like `9 Kačor`, `#10 Provod`, `10 - Provod`; ignore junk lines).
- Produces (`classifier.ts`): `type ClassifyInput = { sheetJpeg: Buffer; meta: ClipMeta; fileName: string; handLabel?: string; template: Template; roster: RosterEntry[] }`; `type ClassifyResult = { category: string; description: string; confidence: "high" | "medium" | "low"; ok: boolean; error?: string; usage?: TokenUsage }`; `interface Classifier { classify(input: ClassifyInput): Promise<ClassifyResult> }`; `class ClaudeClassifier implements Classifier { constructor(opts: { apiKey: string; model: string; client?: Anthropic }) }`; `buildSystemPrompt(template: Template, roster: RosterEntry[]): string`; `sanitizeResult(raw: unknown, template: Template, handLabel?: string): ClassifyResult`.
- Produces (`pricing.ts`): `type TokenUsage = { input: number; output: number; cacheRead: number; cacheWrite: number; model: string }`; `costUsd(u: TokenUsage): number` (table in Global Constraints; cache write = 1.25 × input price).

Prompt (Czech, stable across clips so it caches — put template + roster in `system` with `cache_control: { type: "ephemeral" }`): you sort footage from a sports shoot; pick exactly one category from the list (name + hint) or `_nezařazeno` if unsure; description 1–4 words in Czech, lowercase, no diacritics, hyphen-joined, describing what happens (e.g. `gol-kacor`, `brankar-zakrok`, `fanousci-vlajky`), never repeating the category; if a shirt number is clearly readable and in the roster, add that surname, never guess; if a hand label is given, keep its meaning in the description. User message per clip: the image + `Soubor: <name>, délka <s> s, natočeno <ISO time>, ruční popisek: <label|–>`.

Call: `client.messages.parse({ model, max_tokens: 1024, output_config: { effort: "low", format: zodOutputFormat(ResultSchema) }, system, messages })` where `ResultSchema = z.object({ category: z.string(), description: z.string(), confidence: z.enum(["high","medium","low"]) })`. If the SDK exposes `fallbacks` on `client.beta.messages.parse`, add `betas: ["server-side-fallback-2026-07-01"], fallbacks: "default"`; otherwise skip it.

- [ ] **Step 1: Write failing tests** (`classifier.test.ts` uses a fake `client` object whose `messages.parse` returns canned responses):
  - valid response `{category:"Zápas",description:"Gól Kačor",confidence:"high"}` → `{ ok: true, category: "Zápas", description: "gol-kacor" }`
  - category `"Zapas"` not in template → `category: "_nezařazeno"`, `ok: true`
  - description `""` → `description: "klip"`
  - description `"zapas-sance"` with template category `Zápas` → `"sance"` (category prefix stripped)
  - handLabel `"šance"`, description `"strela"` → `"sance-strela"`
  - `stop_reason: "refusal"` → `{ ok: false, category: "_nezařazeno" }`
  - `parse` throws `Anthropic.APIConnectionError` → `{ ok: false, category: "_nezařazeno", error: <message> }`
  - `buildSystemPrompt(fotbal, [{number:9,surname:"Kačor"}])` contains every category name, `9 Kačor` and is byte-identical across two calls.
  `templates-roster.test.ts`: `parseRoster("9 Kačor\n#10 Provod\nblabla\n7 - Doudera")` → 3 entries; `DEFAULT_TEMPLATES` ids `["fotbal","tenis"]` with the category names above in order.
- [ ] **Step 2:** FAIL. **Step 3:** Implement. **Step 4:** PASS. **Step 5:** Commit `feat: category templates and Claude classifier`.

### Task 6: Hashing, verified copy, journal, disk space

**Files:**
- Create: `src/core/copy.ts`, `src/core/journal.ts`, `src/core/diskspace.ts`
- Test: `tests/core/copy.test.ts`, `tests/core/journal.test.ts`

**Interfaces:**
- Produces (`copy.ts`): `type CopyOutcome = { status: "copied"; destPath: string; bytes: number; sha256: string } | { status: "duplicate"; destPath: string; sha256: string } | { status: "verify_failed"; tempPath: string }`; `copyVerified(srcPath: string, destDir: string, desiredName: string, opts?: { cameraTag?: string; waitForSpace?: (bytes: number) => Promise<void> }): Promise<CopyOutcome>`.
  Algorithm: stream src once through SHA-256 into `<destDir>/.<desiredName>.partial` opened with `'wx'`; fsync; re-read the temp file, hash, compare hash and size; on match pick the final name — `desiredName`; if taken by a file with the same sha256 → `duplicate`; if taken by different content → insert `cameraTag` into the base (via `buildName` rules), then ` (2)`, ` (3)`…; finalise with `fs.link(temp, final)` (fails if exists, never overwrites) then `fs.unlink(temp)` (the app's own temp from this call is the only thing it may remove). On mismatch return `verify_failed`, leave temp in place.
- Produces (`journal.ts`): `type JournalEntry = { sha256: string; size: number; originalRelPath: string; eventDir: string; destPath: string; at: string }`; `class Journal { static load(file: string): Promise<Journal>; find(eventDir: string, sha256: string, size: number): JournalEntry | undefined; findByOriginal(eventDir: string, originalRelPath: string, size: number): JournalEntry | undefined; append(e: JournalEntry): Promise<void> }` — JSON Lines, append-only, tolerant of a truncated last line.
- Produces (`diskspace.ts`): `freeBytes(dir: string): Promise<number>` (`fs.statfs`); `makeSpaceWaiter(dir: string, opts?: { reserveBytes?: number; pollMs?: number; free?: (d: string) => Promise<number>; onWaiting?: (needed: number, free: number) => void }): (bytes: number) => Promise<void>` — default reserve 5 GB, poll 30 s.

- [ ] **Step 1: Write failing tests:** copy to empty dir → `copied`, dest bytes equal src, no `.partial` left; copy same src again → `duplicate`, still one file; dest already holds different content under the same name with `cameraTag:"ILCE7M4"` → final name `C0001-ILCE7M4_gol.MP4`, original untouched (hash unchanged); same again without tag → ` (2)`; simulate corruption by injecting a `hashFile` stub that returns a different hash for the temp → `verify_failed` and the `.partial` still exists; `makeSpaceWaiter` with a fake `free` returning 1 GB then 100 GB resolves only after the second poll and calls `onWaiting` once. `journal.test.ts`: append two entries, reload, `find` returns them; a file whose last line is `{"sha256":"ab` loads the complete lines and ignores the tail.
- [ ] **Step 2:** FAIL. **Step 3:** Implement. **Step 4:** PASS. **Step 5:** Commit `feat: verified add-only copy, journal and disk-space wait`.

### Task 7: Pipeline orchestrator and CSV

**Files:**
- Create: `src/core/pipeline.ts`, `src/core/csv.ts`
- Test: `tests/core/pipeline.test.ts` (fake card built from Task 3 fixtures: `PRIVATE/M4ROOT/CLIP/C0001.MP4` bright 5 s, `C0002.MP4` black 0.6 s (marker → C0001 TOP), `C0003.MP4` bright, `C0001M01.XML`, `DCIM/100MSDCF/DSC00001.JPG`, `._C0001.MP4`; fake `Classifier`)

**Interfaces:**
- Consumes: everything from Tasks 2–6.
- Produces: `type RunOptions = { cardRoot: string; eventDir: string; template: Template; roster: RosterEntry[]; classifier: Classifier; journal: Journal; concurrency?: number; markerOpts?: Parameters<typeof detectMarkers>[1]; waitForSpace?: (bytes: number) => Promise<void> }`;
  `type RunEvent = { type: "scanned"; videos: number; others: number; bytes: number } | { type: "classified"; relPath: string; result: ClassifyResult; top: boolean; marker: boolean } | { type: "copied"; relPath: string; outcome: CopyOutcome } | { type: "waiting_space"; needed: number; free: number } | { type: "card_removed" } | { type: "done"; summary: RunSummary }`;
  `type RunSummary = { perFolder: Record<string, number>; top: number; markers: number; orphanMarkers: number; unclassified: number; lowConfidence: string[]; alreadyUploaded: number; verifyFailed: string[]; others: number; costUsd: number; csvPath: string; status: "ok" | "card_removed" | "verify_failed" }`;
  `runCard(opts: RunOptions, onEvent: (e: RunEvent) => void, signal?: AbortSignal): Promise<RunSummary>`.
- Produces (`csv.ts`): `writeMappingCsv(file: string, rows: MappingRow[]): Promise<void>`; `type MappingRow = { original: string; newName: string; folder: string; note: string }` — `;`-separated, UTF-8 with BOM, header `puvodni_nazev;novy_nazev;slozka;poznamka`; file name `_trideni_<YYYY-MM-DD_HH-mm>.csv` in `eventDir`.

Order: scan → probe all videos → `frameLumas` → `detectMarkers` (`cameraKey` = `cameraModel ?? card volume name`) → classify non-marker videos with `concurrency` (default 4) → copy videos sequentially, TOP first, then by `createdAt` → copy `other` files to `_ostatni/<relPath>` unchanged → write CSV → `done`. Before each copy check the journal (`find` by sha256 is only possible after reading; use `findByOriginal` first and skip if present with same size, else copy and append). Source read errors with code `ENOENT`/`EIO`/`ENXIO` → emit `card_removed`, stop, write CSV of what was done, status `card_removed`.

- [ ] **Step 1: Write failing tests:**
  - happy path: event dir gets `Zápas/C0001_TOP_gol.MP4`, `Zápas/C0003_sance.MP4` (fake classifier returns `Zápas` + `gol`/`sance`), `_ostatni/PRIVATE/M4ROOT/CLIP/C0001M01.XML`, `_ostatni/DCIM/100MSDCF/DSC00001.JPG`; no file for `C0002` or `._C0001.MP4`; CSV has 5 rows incl. `C0002.MP4` with note containing `černá značka`; summary `top 1, markers 1, others 2, status "ok"`.
  - classifier returns `ok:false` for C0003 → file lands as `_nezařazeno/C0003.MP4`.
  - second `runCard` on the same card + same eventDir + same journal → no new files, `alreadyUploaded` = 4 (2 videos + 2 others).
  - card removed: a fake fs layer (inject `openRead` option) throws `ENOENT` on the second video → status `card_removed`, first file present and verified, nothing deleted; re-run with working fs completes and copies only the missing ones.
  - destination already has a different `Zápas/C0001_TOP_gol.MP4` → new one lands as `C0001-<camera>_TOP_gol.MP4`, the existing file is unchanged.
- [ ] **Step 2:** FAIL. **Step 3:** Implement (add an injectable `openRead` to `RunOptions` defaulting to `fs.createReadStream`; thread it into `copyVerified`). **Step 4:** PASS. **Step 5:** Commit `feat: card pipeline with CSV report`.

### Task 8: Electron main — settings, Keychain, card watcher, queue, IPC

**Files:**
- Create: `src/main/settings.ts`, `src/main/secrets.ts`, `src/main/watcher.ts`, `src/main/queue.ts`, `src/main/ipc.ts`; modify `src/main/index.ts`, `src/preload/index.ts`
- Create: `src/shared/ipc-types.ts`
- Test: `tests/main/settings.test.ts`, `tests/main/watcher.test.ts`, `tests/main/queue.test.ts`

**Interfaces:**
- Produces (`settings.ts`): `type Settings = { rootDir: string | null; model: "claude-sonnet-5-5" | "claude-opus-5-5" | "claude-haiku-5-5"; templates: Template[]; lastTemplateId: string; rosters: Record<string, string>; // saved roster text by team name lumaThreshold: number; czkPerUsd: number }`; `loadSettings(file: string): Promise<Settings>` (defaults: `rootDir null`, model sonnet, `DEFAULT_TEMPLATES`, `lastTemplateId "fotbal"`, `lumaThreshold 0.20`, `czkPerUsd 23`; Zod-validated, unknown/invalid → defaults per field); `saveSettings(file: string, s: Settings): Promise<void>`.
- Produces (`secrets.ts`): `saveApiKey(key: string): Promise<void>`, `loadApiKey(): Promise<string | null>` — Electron `safeStorage.encryptString` → file in `userData`; never log the key.
- Produces (`watcher.ts`): `watchVolumes(onCard: (root: string) => void, opts?: { volumesDir?: string; isCard?: (root: string) => Promise<boolean> }): () => void` — watches `/Volumes`, debounces 2 s, ignores the boot volume and volumes already seen this session.
- Produces (`queue.ts`): `class JobQueue { enqueue(job: () => Promise<void>): void; get pending(): number }` — strictly one job at a time.
- Produces (`ipc-types.ts`): channels `card:detected` (main→renderer `{ root, volumeName, videos, bytes, firstDate, lastDate }`), `card:pickFolder` (renderer→main, manual folder pick for testing/cards without signature), `events:list` (list subfolders of `rootDir`), `run:start` (`{ cardRoot, eventName, isNew, templateId, rosterText }`), `run:event` (main→renderer `RunEvent`), `settings:get|set`, `apikey:set|has`, `shell:openFolder`.
- The preload exposes exactly these via `contextBridge` as `window.api` with typed signatures; `contextIsolation: true`, `nodeIntegration: false`.

- [ ] **Step 1: Write failing tests:** settings with a corrupted JSON field `lumaThreshold: "x"` loads default 0.20 while keeping a valid `rootDir`; watcher with a temp `volumesDir`: creating `CARD1/PRIVATE/M4ROOT/CLIP` calls `onCard` once after debounce, creating `NOTCARD/` with an `isCard` returning false does not; queue runs three jobs strictly sequentially (record start/end order).
- [ ] **Step 2:** FAIL. **Step 3:** Implement and wire `index.ts`: on `card:detected` show/focus window; `run:start` creates the event dir (new: `rootDir/<eventName>`, refuse if it already exists unless `isNew` false), builds `ClaudeClassifier` from Keychain key + settings model, loads journal from `userData/journal.jsonl`, enqueues `runCard`, forwards `RunEvent`s; on `done` fire a macOS `Notification`. Refuse to start if `rootDir` is null, not existing, or the API key is missing (send a Czech error to the renderer).
- [ ] **Step 4:** PASS. **Step 5:** Commit `feat: electron main with settings, keychain, card watcher and queue`.

### Task 9: Renderer UI

**Files:**
- Create: `src/renderer/App.tsx`, `src/renderer/screens/Idle.tsx`, `NewCard.tsx`, `Progress.tsx`, `Done.tsx`, `Settings.tsx`, `src/renderer/styles.css`
- Test: `tests/renderer/format.test.ts` (pure helpers only: `formatBytes`, `formatCzk`, `defaultEventName(firstDate: Date): string` → `"2026-10-20 "`)

**Interfaces:**
- Consumes: `window.api` from Task 8, `RunEvent`/`RunSummary` from Task 7.

Screens (copy from spec §Rozhraní): Idle — `Zasuň kartu`, recent runs, button „Vybrat složku ručně“. NewCard — card summary (kamera, počet klipů, velikost, data natočení), radio „Existující akce“ (list from `events:list`) / „Nová akce“ (text input prefilled `defaultEventName`), template select (last used preselected), optional roster: select a saved team roster (`settings.rosters`, keyed by team name) or paste a new one with a team name to save it, Start. Progress — two bars „Třídění“ / „Nahrávání“, live list (new name, folder, state), big red `Karta ještě NENÍ zálohovaná`, a yellow note on `waiting_space` „Čekám, až Google Drive uvolní místo na disku…“. Done — per-folder counts, TOP count, list „Zkontroluj ručně“ (low confidence + unclassified), „Už nahráno dřív“ count, cost in Kč, „Otevřít složku“, and the fixed green string from Global Constraints; for status `card_removed` show „Karta byla odpojena. Nic se nesmazalo — zasuň ji znovu a spusť znovu, nahraje se jen zbytek.“; for `verify_failed` list files and „Tyto soubory se nepodařilo ověřit. Karta NENÍ zálohovaná.“ Settings — root folder picker, API key field (write-only, shows „uloženo“), model select, template editor (add/rename/remove categories, edit hints), luma threshold, CZK rate.

- [ ] **Step 1:** Write failing `format.test.ts`. **Step 2:** FAIL. **Step 3:** Implement helpers and screens. **Step 4:** PASS.
- [ ] **Step 5: Manual verification:** `npm run dev`; Settings → root = a new temp folder, key set; Idle → „Vybrat složku ručně“ → a copy of 10 Istanbul clips including `A75_0413`, `A75_0414`; template Fotbal; Start. Expect `Trénink/A75_0413_TOP_….MP4`, no file for `A75_0414`, CSV present, green final string. Commit `feat: czech UI`.

### Task 10: Classification eval on reference sets

**Files:**
- Create: `scripts/eval.ts`, `docs/eval.md`

**Interfaces:**
- Consumes: `probeClip`, `contactSheet`, `ClaudeClassifier`, `DEFAULT_TEMPLATES`, `costUsd`.
- Produces: `npm run eval -- --set istanbul --model claude-sonnet-5-5 --limit 184` printing category accuracy vs reference, per-category confusion, total cost USD/CZK; writes `eval-results/<set>-<model>.csv`. Reference = Istanbul `_trideni_mapovani.csv` (folder column; skip `černá značka` rows). API key from `ANTHROPIC_API_KEY` or `ant` profile.

- [ ] **Step 1:** Implement; dry-run with `--limit 3` on Haiku to validate wiring (cost < 1 Kč).
- [ ] **Step 2:** STOP — ask Jan to approve the full run budget (both models on Istanbul, estimated < 30 Kč) before running it.
- [ ] **Step 3:** After approval run Haiku and Sonnet on all 170 classified Istanbul clips; record accuracy and real cost in `docs/eval.md`. Target ≥ 90 % for Sonnet. Commit `docs: classifier eval results`.

### Task 11: Packaging, docs, GitHub

**Files:**
- Create: `scripts/package-app.mjs`, `README.md`, `docs/architecture.md`; update `CLAUDE.md`

- [ ] **Step 1:** `npm run app` builds `out/Třídění karet-darwin-arm64/Třídění karet.app` with ffmpeg/ffprobe under `app.asar.unpacked`; launch it, run Task 9 manual check against the packaged app.
- [ ] **Step 2:** Write `README.md` (Czech: install, first-run Gatekeeper + removable-volume permission, Drive for desktop in „Streamovat soubory“ mode, settings) and `docs/architecture.md` (module map, safety rules, journal location).
- [ ] **Step 3:** `npm test` all green; `npx tsc --noEmit` clean.
- [ ] **Step 4:** `gh repo create Kolda1684/trideni-karet --private --source . --push` (Jan asked to put it on GitHub); verify `git log --format='%ae' | sort -u` shows only `jan.kolar@sportivea.cz`. Commit `docs: readme and architecture` before pushing.
