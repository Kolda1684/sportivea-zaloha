# Classifier eval

`scripts/eval.ts` runs the real `ClaudeClassifier` on clips of a reference set and compares the predicted category with the folder Jan chose by hand.

## Status

**Results pending.** No live run has been made: there is no Anthropic API key on the dev machine and the run budget has not been approved by Jan. Target (spec): at least 90 % category accuracy for `claude-sonnet-5-5`. Fill the table below after the first approved run.

| Set | Model | Clips | Accuracy | Cost USD | Cost CZK |
| --- | --- | --- | --- | --- | --- |
| istanbul | claude-haiku-5-5 | 170 | pending | pending | pending |
| istanbul | claude-sonnet-5-5 | 170 | pending | pending | pending |

Rough pre-run estimate: the script prints its own (`estimateRun` in `scripts/eval-lib.ts`, ~1500 input + ~120 output tokens per clip, no cache credit). Planned budget for both models on Istanbul: under 30 Kč.

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
