# ESPN referee backfill — the evidence

Written by `python3 tools/refs/cfb_refs.py backfill` (run by `.github/workflows/cfb-ref-sync.yml`
on the pull request that changes the dataset or the tool, and on `workflow_dispatch` with
mode `backfill`). Nothing here is edited by hand.

| File | What it is |
|---|---|
| `espn_validation.csv` | The check that runs first. Games that already have an NCAA referee, nearest the gap (2026 Week 7) first, one per referee. ESPN must list an official whose position is **Referee** (no Referee listed, or ESPN unreachable, is inconclusive and another game is read), and that referee must be the same person after normalization. Five matches pass; any mismatch stops the backfill. |
| `STOPPED.md` | Only when the check failed: why. Then nothing is filled and the two files below are absent. |
| `espn_backfill.csv` | The fills: game, `referee_id` (an existing id whenever the name is one of the dataset's referees, spelled any way), the dataset's display name and conference, ESPN's own spelling, how the name matched (`exact`, `alias` from `cfb_enrich.py`, `spelling_variant`, `new_referee`), the crew. `referee_source = espn`, `referee_identity = espn_referee_role`. |
| `espn_backfill_log.csv` | Every one of the 124 games: `filled`, `no_referee_listed`, `fetch_failed`, `assignment_conflict_left_alone` (the 13 same-day double listings), `same_day_conflict` (ESPN's referee already worked another game that day), `ambiguous_name`. |
| `coverage_by_season.csv` | Games with a referee per season, before and after. |

The database gets the fills with the seed (`.github/workflows/deploy-cfb-refs.yml`), through
`cfb_ref_merge_games(rows, 'espn_referee')`, which only fills games with no referee and never an
`assignment_conflict` game.
