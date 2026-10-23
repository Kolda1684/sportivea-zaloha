# Classifier eval

`scripts/eval.ts` runs the real `ClaudeClassifier` on clips of a reference set and compares the predicted category with the folder Jan chose by hand.

## Status

First live run 2026-10-23 on the Istanbul card (170 clips, default `fotbal` template, no roster). Target (spec): ≥ 90 % for `claude-sonnet-5-5` — **not met yet**.

| Set | Model | Clips | Accuracy | Cost USD | Cost CZK |
| --- | --- | --- | --- | --- | --- |
| istanbul | claude-sonnet-5-5 | 170 | 135/170 = 79.4 % | 0.381 | 8.76 |
| istanbul | claude-haiku-5-5 | 170 | 121/170 = 71.2 % | 0.020 | 0.46 |

Sonnet per category: Trénink 72.1 % (80/111), předzápas 100 % (6/6), rozcvička 90 % (9/10), nástup 83 % (5/6), Zápas 96.8 % (30/31), děkovačka 83 % (5/6).

Findings:
- 29 of 35 Sonnet errors are one confusion: Trénink → rozcvička. Training drills the day before the match (19. 10.) look like the pre-match warm-up (20. 10.) on a 4-frame contact sheet; the model cannot tell which day is match day. Without this confusion Sonnet would be 164/170 = 96.5 %.
- Remaining errors: 4 low-confidence clips sent to `_nezařazeno` (flags, blurred pan, fans behind a fence, walk along the goal) — the intended safe fallback; 2 borderline (corner flag → předzápas, Champions League logo before the line-up → předzápas).
- Haiku is worse across all categories, not only Trénink; keep Sonnet as default.
- Actual cost was about half the pre-run estimate (prompt caching).

Next: give the classifier the match day (or tighten the Trénink/rozcvička hints) and re-run.

## How to run

```
export ANTHROPIC_API_KEY=...        # never commit; the script exits before any work without it
npm run eval -- --set istanbul --model claude-haiku-5-5 --limit 3        # prints estimate only
npm run eval -- --set istanbul --model claude-haiku-5-5 --limit 3 --yes  # wiring check, under 1 Kč
npm run eval -- --set istanbul --model claude-sonnet-5-5 --yes           # full run
```

Options: `--set` (only `istanbul`), `--model` (`claude-sonnet-5-5` default, `claude-opus-5-5`, `claude-haiku-5-5`), `--limit N` (first N matched clips in CSV order), `--czk` (rate, default 23), `--yes` (without it nothing is sent to the API, only the estimate is printed).

Order of checks: arguments, API key, clip folder, reference CSV and matching, cost estimate, `--yes`.

## Reference data (istanbul)

- Ground truth: `/Users/kolda/Desktop/Istanbul/_trideni_mapovani.csv` (UTF-8 BOM, `;`, `puvodni_nazev;novy_nazev;slozka;poznamka`), 184 rows. 14 rows with `slozka` = `(kořen)` (black markers) are skipped, which leaves 170 clips.
- Expected category = `slozka`, one of the `fotbal` template names (Trénink, předzápas, rozcvička, nástup, Zápas, děkovačka). Rows with another folder are skipped and reported.
- Clips with their ORIGINAL names must be readable in the folder `TRIDENI_ISTANBUL_DIR` (default `/Volumes/Untitled/PRIVATE/M4ROOT/CLIP`; `DAY 1/` and `DAY 2/` subfolders are searched recursively). Matching is by basename, case-insensitive. The card is only read.
- Rows whose file is not found, or whose basename occurs more than once on the card, are skipped with a warning.

## Output

- Console: accuracy, confusion matrix (rows expected, columns predicted incl. `_nezařazeno`), per-category accuracy, total USD and CZK. Failed classifications (API/probe error) count as wrong and are reported separately.
- `eval-results/<set>-<model>.csv` (gitignored, overwritten on re-run): `original;expected;predicted;description;confidence;ok;usd;error`.

## Adding a set

Add an entry to `EVAL_SETS` in `scripts/eval-lib.ts`.

TODO `davis-cup`: CSV `/Users/kolda/Desktop/Střih videí/drive_centralni_vyber_trideni.csv` (extra columns `file_id;odkaz`), clips are on Google Drive and not local, so a download step is needed first. Not implemented.

## Tests

Pure parts (CSV parsing, matching, accuracy/confusion, cost aggregation, argument parsing, report writing, run loop with a fake `Classifier`) are covered by `tests/scripts/eval-lib.test.ts`.
