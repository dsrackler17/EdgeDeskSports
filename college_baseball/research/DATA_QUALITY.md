# Data quality — what was wrong, how it was found, what was done

Counts by season and source are generated in `research/COVERAGE.md` and
`validation/data_quality.json` (`node college_baseball/coverage.js`). This page
is the narrative: every problem found while building the warehouse, in the
order found, and the rule that now handles it. Nothing here was fixed by
editing data by hand.

| # | Problem | How it was found | Rule now |
|---|---|---|---|
| DQ-01 | Three different team id systems (org id; per-season team id; per-contest box team id) | joins failed until mapped | org id is canonical; season ids are lookups; box teams are tied to programs through the team total row's name (ingest/box.js) |
| DQ-02 | Seed prefixes in names ("#3 UMES") with the team id left blank | 2022 conference-tournament contests disagreed on `away_id` | strip the seed; fill a blank id from the canonical name and count it (`ID_FILLED_FROM_NAME`) |
| DQ-03 | Mirror copies: each school's page lists a tournament game as its own home game | duplicate contest rows with swapped sides and consistent scores | not a score conflict: kept as `VERIFIED_MIRROR`, treated as neutral; play-by-play decides who batted last |
| DQ-04 | NCAA-tournament hosts that did not bat last | the 2024 linescore and play-by-play both batted the "road" team last at the host's park (64 games) | `bats_last = A` when two independent sources agree; one source alone is a CONFLICT |
| DQ-05 | Play-by-play home/away contradicting the schedule at non-neutral games (2019, 2021, 2022) | the pbp orientation check | quarantined (no third source to break the tie): 67, 56 and 73 games |
| DQ-06 | 2023 season file incomplete (stops 05/27, ~3.6k D-I contests) | coverage by season | per-team files unioned in; results still end on 2023-03-28 for most programs (6,515 contests listed without results) — a SOURCE gap, recorded, not filled |
| DQ-07 | Unplayed listings double-counted when both teams' files list them | 2023 contests 12,675 > plausible | ordinals per source FILE, not per source |
| DQ-08 | Per-play `runs_scored` unreliable in play-by-play (0.2% of 2017 games add up; 66% in 2024) | inning lines rejected against official finals | half-inning runs from SCORE CHANGES (99% reconcile) |
| DQ-09 | Legacy play-by-play posts a half's last run on the next half's first row | home runs vanished from 2021–22 lines | each side's score change goes to that side's most recent batting half |
| DQ-10 | Unplayed bottom halves written as 0 (as often as x) | rule R02 check | treated as a convention in rule checks; excluded from half-inning shapes |
| DQ-11 | Result markers relative to the scheduled length ("(8)" on a seven-inning game) and only extra innings marked before 2024 | marker vs innings-played cross-tab | innings come from reconciled lines only; scheduled length is inferred with an explicit basis |
| DQ-12 | Team earned runs ≠ sum of pitchers' earned runs | a box check failed on 113 correct boxes | removed: the scoring rules allow it (reliever-inherited errors) |
| DQ-13 | Box players not adding up to their own team total (AB, R, H) | total-row reconciliation | flagged `CHECK_FAILED` per team-game (44, 36, 64 in 2024–26); kept, never silently corrected |
| DQ-14 | Pitching outs that cannot fit the innings the opponent batted | outs vs half-innings | flagged (1, 3, 16 in 2024–26) |
| DQ-15 | Roster player ids re-issued every season (0 ids shared 2024→2025) | id join | cross-season identity by exact name + hometown + high school; else by program + name |
| DQ-16 | A 2025 contest dated in August | coverage "no result" range | listed as NO_RESULT; not rated |
| DQ-17 | Division disagreement between the schedule row and the lookup (Rust, 2017) | the lookup-vs-schedule check | the lookup is authoritative for division and conference; disagreement recorded |
| DQ-18 | Season-team ids for some D-II/D-III programs missing from the lookup | `SEASON_TEAM_UNMAPPED` | their games keep the opponent's name; D-I games are unaffected |

Quarantine: `data/quarantine/<season>.csv` lists every excluded contest and
why. Provenance: `data/provenance/<season>.csv.gz` keeps every observation of
every critical field with its source and agreement status.

Historical revisions: each build records the sha256 of every source file in
`data/reports/<season>.json`; a later build with a different hash for the same
URL is a revision of history, visible in git.
