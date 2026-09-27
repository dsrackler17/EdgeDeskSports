# Example weekly run: 2026, source week 4 → target week 5

A real `--mode weekly` run of the weekly engine on live 2026 data, executed in an isolated copy so it touched
no production state:

```
CFB_V2_DATA=<copy>/data CFB_V2_OUT=<copy>/out \
  python3 -m v2.weekly.run --mode weekly --state-root <copy>/state
```

| | |
|---|---|
| run | `cfbw_ca7901274dbe2351a2604217` |
| status | **PUBLISHED**, gate PASS, 0 errors, 29 warnings |
| model | `edgedesk_cfb_v2.1.0`, features `cfb_v2_fv2` |
| freeze instant | 2026-09-29T12:00Z (Tuesday noon UTC of the target week) |
| games processed | 331 finals (318 FINAL_VALIDATED, 13 FINAL_PARTIAL_DATA), PBP coverage 1.0 |
| projected | 59 week-5 games, none withheld |
| stages | 25 of 25 OK or WARN |

The 29 warnings are the intended output, not faults:
- 28 ambiguous-starter flags (QB rotations and benchings; see the report's QB changes section);
- one availability warning: official reports cover 14 of 118 teams, and UNKNOWN is never read as healthy. That is
  why every game runs in `DEGRADED_AVAILABILITY` mode.

Files:
- `run_manifest.json`: the PipelineRun record (stages, versions, gate checks, warnings);
- `week_05.md` / `week_05.json`: the weekly report.

The report was re-rendered after one fix found by this run. The record-vs-performance table had ranked one-game
FCS opponents by numeric id; it now ranks FBS teams by name (`report._perf_table`, test in `tests_weekly.py`). The
rest of the run is unchanged.

Two things are empty because this is the first run in a fresh state root, not because anything failed:
- there are no rating changes to compare;
- there are no frozen source-week projections to grade misses against.

The replay proof covers those paths: [REPLAY.md](../REPLAY.md).
