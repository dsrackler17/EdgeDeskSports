# Generated files: what stays on main, what should move, who owns what

Of the 23,165 files tracked on main (2026-10-26), **18,600 (1.27 GB) are written by scheduled jobs**, not by people. That is why main changes every few minutes, and why a pull request that commits one of these files almost always conflicts with the job that owns it.

This page answers three questions:

1. Which files are generated, and which job owns each one? The answer is computed, not maintained by hand.
2. Which generated files must stay tracked on main?
3. Which generated files would be better produced somewhere else?

## How ownership is determined (automatically)

Every job that commits to a branch does it through `tools/ci/push_generated.sh <branch> <message> -- <paths>`, or through a raw `git add <paths>` followed by `git push`. Those paths are the job's outputs. `tools/integrity/ownership.js` reads them straight from `.github/workflows/*.yml`, so a new job's files are owned as soon as its workflow names them. There is no second list to fall out of date.

| Class | Rule | Examples |
|---|---|---|
| **generated** | Inside a job's published paths and not code by extension, or named by the job exactly | `football/cfb_terminal/board.json`, `articles/**`, `CHANGELOG.md` (the Changelog job), `football/rankings/params.js` (named exactly) |
| **source** | Not named by any publishing job, or code (`.js .py .sh .sql .yml .css …`) or a README inside a published directory | `football/cfb_terminal/build.js`, `lib/**`, `changelog.d/*.md` |
| **merge-source** | Named in `PUSH_MERGE_PATHS`: source that a job patches in place | `app.html` |

```sh
node tools/integrity/ownership.js --list                      # every job and the paths it owns
node tools/integrity/ownership.js <path>…                     # classify paths
node tools/integrity/ownership.js --explain <generated path>  # which changes justify editing it
node tools/integrity/inventory.js --markdown                  # the table below
```

## The automated ownership rule

On every pull request, the integrity gate (`tools/integrity/gate.js pr`) applies this rule. **A generated file may change only if the same pull request also changes the code that produces it.** That code is:

- the owning workflow;
- a script the workflow runs;
- a file those scripts load, followed through `require()`, `path.join(ROOT, …)` literals and Python imports beside the script.

Some examples:

- #800 regenerated `football/cfb_validation/slate_audit.json` and changed `football/cfb_validation/build.js`. That is allowed.
- #800 also committed `football/venues/forecasts.json`, which a local test run had rewritten. Nothing that produces that file changed, so it is refused. The fix is `git checkout origin/main -- <file>`.
- #799 changed `lib/edgedesk_quote_ev.js`, which `football/cfb_terminal/build.js` loads. That allows the terminal artifacts it regenerated.
- A hand edit of `CHANGELOG.md` is refused, and the message points to `changelog.d/`.

**Override:** a person adds the `generated-files-ok` label. This is a deliberate, visible decision, for example for a pull request that repairs a corrupted artifact.

**Bot side:** every bot commit to main is checked before it is pushed (`tools/integrity/attest.js`). A job can no longer publish an artifact that does not parse.

## 1. Stays tracked on main, owned by its job (188 paths)

The site is static and served by GitHub Pages from main, and its pages fetch these files by path. Moving them would break the site. They stay tracked, the gate keeps pull requests off them, and their jobs remain the only writers.

## 2. Should be generated elsewhere (21 candidates)

These are not served by any page. Each one is an append-only ledger, a snapshot history or a CSV export, or it is rewritten on most runs. They add churn to main and conflicts to pull requests while serving no reader.

Candidate destinations:

- a `data` branch;
- release assets;
- the Supabase tables the same jobs already sync to.

**This is a recommendation, not a migration.** A reader might build a path at run time, which a text search cannot see. Each candidate needs a person to confirm nothing reads it before it moves. Until then the gate's ownership rule protects it like any other generated file.

## 3. Hand-written source (4,564 files)

Everything else is source. It is reviewed as code, locked per subsystem while a pull request changes it (`tools/integrity/lock.js`), and checked for syntax on every pull request.

## The inventory

Method: "Commits" counts first-parent commits on main that touched the path, in the history available when this was generated: about six hours on 2026-10-26, because sessions clone shallow. "Served" means a tracked `.html` file, or a `.js` file outside `tools/`, names the path, or the file sits at the site root. Regenerate with `node tools/integrity/inventory.js --since "7 days ago" --markdown` on a full clone.

| Path | Files | MB | Commits (24 hours ago) | Served | Recommendation | Owning jobs |
|---|---:|---:|---:|---|---|---|
| `football/players/snapshots/` | 8 | 3.5 | 2 | no | move | football-weekly-build |
| `football/rankings/snapshots/` | 9 | 1.9 | 2 | no | move | football-weekly-build |
| `research/clv/live/` | 4 | 0.3 | 2 | no | move | clv-live |
| `football/cfb_v2/learning/` | 2 | 0.2 | 2 | no | move | cfb-v2-shadow |
| `football/venues/nfl_stadiums.verification.json` | 1 | 0.0 | 2 | no | move | football-weekly-build |
| `football/validation/movement_nfl.json` | 1 | 0.0 | 2 | no | move | football-weekly-build |
| `model_loop/ledger/cfb/` | 3 | 5.7 | 1 | no | move | model-loop-cfb |
| `mlb/batters/dataset/` | 15 | 2.5 | 1 | no | move | mlb-pitchers |
| `model_loop/data/ufc/` | 5 | 1.9 | 1 | no | move | model-loop-ufc |
| `model_loop/ledger/nfl/` | 3 | 1.0 | 1 | no | move | model-loop-nfl |
| `research/clv/openers/*/20[0-9][0-9]-[0-9][0-9].jsonl` | 4 | 0.1 | 1 | no | move | clv-openers |
| `mlb/batters/snapshots/` | 17 | 0.1 | 1 | no | move | mlb-pitchers |
| `docs/model-loop/nba/` | 5 | 0.0 | 1 | no | move | model-loop-basketball |
| `mlb/pitchers/snapshots/` | 17 | 0.0 | 1 | no | move | mlb-pitchers |
| `docs/model-loop/wnba/` | 5 | 0.0 | 1 | no | move | model-loop-basketball |
| `data/refs/ref_assignments.csv` | 1 | 0.0 | 1 | no | move | ref-sync |
| `data/refs/cfb/backfill/` | 3 | 0.0 | 1 | no | move | cfb-ref-sync |
| `docs/model-loop/nfl/candidates.jsonl` | 1 | 0.0 | 1 | no | move | model-loop-nfl |
| `docs/model-loop/cfb/candidates.jsonl` | 1 | 0.0 | 1 | no | move | model-loop-cfb |
| `college_baseball/research/audit_log.jsonl` | 1 | 0.0 | 1 | no | move | college-baseball-research-build |
| `research/clv/openers/*/backfill_*.jsonl` | 0 | 0.0 | 0 | no | move | clv-openers |
| `articles/` | 1644 | 150.9 | 38 | yes | keep | cfb-lab, editorial, newsletter, publish-articles |
| `sitemap-articles.xml` | 1 | 0.0 | 37 | yes | keep | cfb-lab, editorial, newsletter, publish-articles |
| `sitemap.xml` | 1 | 0.0 | 37 | yes | keep | cfb-lab, editorial, newsletter, publish-articles |
| `football/cfb_validation/` | 25 | 1.3 | 10 | yes | keep | cfb-lab |
| `record/football/` | 22 | 31.6 | 9 | yes | keep | football-model-record |
| `CHANGELOG.md` | 1 | 0.5 | 9 | yes | keep | changelog |
| `football/cfb_terminal/` | 18 | 117.3 | 8 | yes | keep | cfb-lab |
| `football/cfb_lab/ledger/` | 22 | 64.9 | 7 | yes | keep | cfb-lab |
| `football/cfb_market/ledger/` | 3 | 14.7 | 7 | yes | keep | cfb-lab |
| `football/evidence/packets.json` | 1 | 3.4 | 7 | yes | keep | cfb-lab |
| `football/content/packets.json` | 1 | 2.2 | 7 | yes | keep | cfb-lab |
| `football/cfb_lab/reports/` | 13 | 1.8 | 7 | yes | keep | cfb-lab |
| `football/cfb_production/reports/projections.json` | 1 | 0.4 | 7 | yes | keep | cfb-lab |
| `football/cfb_production/reports/traces.json` | 1 | 0.3 | 7 | yes | keep | cfb-lab |
| `record/football/cfb_model_lab.json` | 1 | 0.1 | 7 | yes | keep | cfb-lab |
| `football/cfb_production/reports/ops.json` | 1 | 0.0 | 7 | yes | keep | cfb-lab |
| `football/broadcasts/current.json` | 1 | 0.0 | 7 | yes | keep | cfb-lab |
| `football/cfb_production/reports/auto_promotion.json` | 1 | 0.0 | 7 | yes | keep | cfb-lab |
| `football/cfb_production/reports/champion.json` | 1 | 0.0 | 7 | yes | keep | cfb-lab |
| `football/game_research/` | 6 | 40.2 | 6 | yes | keep | cfb-lab, nfl-weekly-loop |
| `app-version.json` | 1 | 0.0 | 5 | yes | keep | app-version |
| `basketball/` | 548 | 52.8 | 4 | yes | keep | lab-validate |
| `football/props/cfb/` | 13 | 30.5 | 4 | yes | keep | player-props |
| `football/props/nfl/` | 16 | 30.3 | 4 | yes | keep | player-props |
| `football/validation/` | 38 | 3.0 | 4 | yes | keep | learning-loop, linemaker-calibrate |
| `football/home/` | 2 | 0.1 | 4 | yes | keep | player-props |
| `app.html` | 0 | 0.0 | 4 | yes | keep | football-weekly-build, starter-context |
| `collegiate/data/` | 13982 | 239.9 | 3 | yes | keep | collegiate-backfill, collegiate-rosters |
| `record/pnl/` | 4 | 23.6 | 3 | yes | keep | record-pnl |
| `football/validation/model_health.json` | 1 | 0.5 | 3 | yes | keep | cfb-lab |
| `football/cfb_weekly/` | 60 | 121.1 | 2 | yes | keep | cfb-v2-shadow |
| `football/pricing/` | 6 | 14.2 | 2 | yes | keep | football-weekly-build, injury-sync, learning-loop, starter-context |
| `football/rankings/current.json` | 1 | 6.4 | 2 | yes | keep | football-weekly-build |
| `football/fbs/` | 3 | 6.2 | 2 | yes | keep | starter-context |
| `football/enrichment/` | 5 | 6.1 | 2 | yes | keep | football-enrichment, football-weekly-build |
| `football/fbs/slate.json` | 1 | 5.9 | 2 | yes | keep | football-enrichment, football-weekly-build |
| `basketball/ncaam_forecast/data/` | 21 | 4.8 | 2 | yes | keep | ncaam-forecast, ncaam-weekly |
| `football/data/box/` | 6 | 4.2 | 2 | yes | keep | football-weekly-build |
| `basketball/ncaaw_forecast/data/` | 21 | 4.2 | 2 | yes | keep | ncaaw-forecast, ncaaw-weekly |
| `football/availability/` | 568 | 3.4 | 2 | yes | keep | availability-sync |
| `football/matchup/` | 2 | 3.3 | 2 | yes | keep | football-weekly-build, starter-context |
| `football/starters/` | 4 | 1.4 | 2 | yes | keep | football-weekly-build, starter-context |
| `football/matchup/metrics.json` | 1 | 1.3 | 2 | yes | keep | football-weekly-build, injury-sync |
| `football/venues/` | 5 | 0.8 | 2 | yes | keep | football-weekly-build, starter-context |
| `hockey/validation/` | 11 | 0.8 | 2 | yes | keep | nhl-validate |
| `football/players/current.json` | 1 | 0.7 | 2 | yes | keep | football-weekly-build |
| `football/rating/` | 2 | 0.7 | 2 | yes | keep | rating-sync |
| `football/cfb_v2/shadow/` | 3 | 0.4 | 2 | yes | keep | cfb-v2-shadow |
| `football/coaching/` | 4 | 0.4 | 2 | yes | keep | football-weekly-build, starter-context |
| `football/rating/current.json` | 1 | 0.4 | 2 | yes | keep | football-weekly-build |
| `today/slate.json` | 1 | 0.4 | 2 | yes | keep | games-slate |
| `football/fbs/reliability.json` | 1 | 0.3 | 2 | yes | keep | football-enrichment, football-weekly-build |
| `football/personnel/current.full.json` | 1 | 0.3 | 2 | yes | keep | football-model-record |
| `collective/settled/` | 2 | 0.2 | 2 | yes | keep | settle-finals |
| `football/personnel/current.json` | 1 | 0.2 | 2 | yes | keep | football-model-record |
| `football/cfb_v2/current.json` | 1 | 0.2 | 2 | yes | keep | cfb-v2-shadow |
| `football/venues/forecasts.json` | 1 | 0.1 | 2 | yes | keep | football-enrichment, injury-sync, nfl-weekly-loop |
| `football/cfb_v2/monitoring.json` | 1 | 0.0 | 2 | yes | keep | cfb-v2-shadow |
| `hockey/validation/nhl_diagnostics.json` | 1 | 0.0 | 2 | yes | keep | nhl-build |
| `football/validation/fcs_bridge_cfb.json` | 1 | 0.0 | 2 | yes | keep | football-weekly-build |
| `football/rankings/health.json` | 1 | 0.0 | 2 | yes | keep | football-weekly-build |
| `model_loop/health.json` | 1 | 0.0 | 2 | yes | keep | model-loop-health |
| `football/fbs/coverage.json` | 1 | 0.0 | 2 | yes | keep | football-enrichment, football-weekly-build |
| `college_baseball/data/` | 81 | 56.8 | 1 | yes | keep | college-baseball-research-build, college-baseball-research-validate |
| `performance/ledger/` | 29 | 38.5 | 1 | yes | keep | performance |
| `basketball/data/` | 83 | 23.6 | 1 | yes | keep | lab-build, model-loop-basketball |
| `college_baseball/board/` | 238 | 20.7 | 1 | yes | keep | college-baseball-research-build, college-baseball-research-validate |
| `nba/data/` | 56 | 19.2 | 1 | yes | keep | nba-build, nba-validate |
| `football/rosters/` | 4 | 18.1 | 1 | yes | keep | roster-sync |
| `football/players/teams/` | 138 | 14.6 | 1 | yes | keep | football-weekly-build |
| `collegiate/probe/fixtures/` | 159 | 13.5 | 1 | yes | keep | collegiate-probe |
| `hockey/data/` | 164 | 13.4 | 1 | yes | keep | nhl-build, nhl-validate |
| `football/cfb_decision/` | 2 | 9.1 | 1 | yes | keep | cfb-lab |
| `college_baseball/validation/` | 14 | 7.2 | 1 | yes | keep | college-baseball-research-build, college-baseball-research-validate |
| `simulator/data/feeds/` | 14 | 5.9 | 1 | no | keep | simulator-sports-data |
| `engine/projections_ledger/` | 1 | 5.0 | 1 | yes | keep | projections-build |
| `football/linemaker/` | 3 | 4.9 | 1 | yes | keep | linemaker-build, linemaker-calibrate |
| `mlb/history/` | 21 | 4.2 | 1 | yes | keep | lab-validate |
| `football/rankings/history.json` | 1 | 3.7 | 1 | yes | keep | football-weekly-build |
| `football/identity/` | 171 | 3.1 | 1 | yes | keep | injury-sync, starter-context |
| `football/fbs_epa/` | 4 | 2.8 | 1 | yes | keep | starter-context |
| `mlb/pitchers/dataset/` | 13 | 2.5 | 1 | yes | keep | mlb-pitchers |
| `performance/data/` | 16 | 2.4 | 1 | yes | keep | performance |
| `football/cfb_v2/snapshots/` | 5 | 1.9 | 1 | yes | keep | cfb-v2-shadow |
| `football/nfl/` | 10 | 1.6 | 1 | yes | keep | nfl-weekly-loop, starter-context |
| `football/props/factory/cfb/` | 1 | 1.5 | 1 | no | keep | props-factory |
| `engine/projections.json` | 1 | 1.4 | 1 | yes | keep | projections-build |
| `football/props/factory/models/` | 93 | 1.3 | 1 | no | keep | props-factory |
| `nba/props_slate.json` | 1 | 1.2 | 1 | yes | keep | nba-build, nba-validate |
| `football/players/index.json` | 1 | 1.1 | 1 | yes | keep | football-weekly-build |
| `nba/recent.json` | 1 | 1.1 | 1 | yes | keep | nba-build, nba-validate |
| `football/rankings/engine_efficiency.json` | 1 | 1.0 | 1 | yes | keep | football-weekly-build |
| `nba/slate.json` | 1 | 0.9 | 1 | yes | keep | nba-build, nba-validate |
| `hockey/slate.json` | 1 | 0.9 | 1 | yes | keep | nhl-build, nhl-validate |
| `football/props/factory/validation/` | 2 | 0.9 | 1 | no | keep | props-factory |
| `football/nfl/slate.json` | 1 | 0.8 | 1 | yes | keep | injury-sync |
| `football/props/factory/nfl/` | 1 | 0.7 | 1 | no | keep | props-factory |
| `football/research/nfl_v2/results/` | 11 | 0.6 | 1 | yes | keep | nfl-weekly-loop |
| `hockey/recent.json` | 1 | 0.5 | 1 | yes | keep | nhl-build |
| `nba/validation/` | 5 | 0.5 | 1 | yes | keep | nba-validate |
| `football/players/candidates/` | 1 | 0.4 | 1 | no | keep | football-weekly-build |
| `football/props/factory/identity/` | 4 | 0.4 | 1 | no | keep | props-factory |
| `nba/params/` | 3 | 0.3 | 1 | yes | keep | nba-validate |
| `hockey/props/slate.json` | 1 | 0.3 | 1 | yes | keep | nhl-build, nhl-validate |
| `docs/model-loop/ufc/` | 19 | 0.3 | 1 | yes | keep | model-loop-ufc |
| `football/cfb/model_loop/` | 2 | 0.3 | 1 | yes | keep | model-loop-cfb |
| `nba/roster_inputs.json` | 1 | 0.3 | 1 | yes | keep | nba-build, nba-validate |
| `college_baseball/research/` | 22 | 0.2 | 1 | yes | keep | college-baseball-research-validate |
| `football/injuries/` | 3 | 0.2 | 1 | yes | keep | injury-sync |
| `engine/board.json` | 1 | 0.2 | 1 | yes | keep | lab-build, lab-validate, nhl-build, nhl-validate |
| `basketball/params/` | 8 | 0.2 | 1 | yes | keep | lab-build, model-loop-basketball |
| `games/data/challenges.json` | 1 | 0.1 | 1 | yes | keep | games-challenges |
| `nba/ledger/` | 2 | 0.1 | 1 | yes | keep | nba-build, nba-validate |
| `hockey/xg/` | 18 | 0.1 | 1 | yes | keep | nhl-validate |
| `football/validation/nfl_coaching_staff.json` | 1 | 0.1 | 1 | no | keep | nfl-coaching-staff-validation |
| `football/market_structure/` | 2 | 0.1 | 1 | yes | keep | nfl-market-structure |
| `football/nfl/model_loop/` | 2 | 0.1 | 1 | no | keep | model-loop-nfl |
| `football/nfl_params_v2.js` | 1 | 0.1 | 1 | yes | keep | nfl-weekly-loop |
| `football/market_structure/nfl.json` | 1 | 0.1 | 1 | yes | keep | injury-sync |
| `hockey/model/params/` | 17 | 0.1 | 1 | yes | keep | nhl-validate |
| `basketball/validation/` | 8 | 0.1 | 1 | yes | keep | lab-build, model-loop-basketball |
| `record/football/weekly/` | 2 | 0.1 | 1 | yes | keep | nfl-weekly-loop |
| `data/refs/ref_game_penalties.csv` | 1 | 0.1 | 1 | yes | keep | ref-sync |
| `docs/model-loop/college_baseball/` | 7 | 0.1 | 1 | yes | keep | model-loop-college-baseball |
| `basketball/slate.json` | 1 | 0.1 | 1 | yes | keep | lab-build, model-loop-basketball |
| `hockey/ledger/` | 2 | 0.1 | 1 | yes | keep | nhl-build, nhl-validate |
| `engine/registry.json` | 1 | 0.1 | 1 | yes | keep | lab-build, lab-validate, nhl-build, nhl-validate |
| `hockey/goalie_inputs.json` | 1 | 0.1 | 1 | yes | keep | nhl-build, nhl-validate |
| `docs/model-loop/mlb/` | 5 | 0.1 | 1 | yes | keep | model-loop-mlb |
| `supabase/nfl_model_registry.sql` | 1 | 0.1 | 1 | no | keep | nfl-weekly-loop |
| `docs/model-loop/ncaaw/` | 5 | 0.0 | 1 | yes | keep | model-loop-basketball |
| `docs/model-loop/ncaam/` | 5 | 0.0 | 1 | yes | keep | model-loop-basketball |
| `football/research/nfl_v2/registry.json` | 1 | 0.0 | 1 | no | keep | nfl-weekly-loop |
| `performance/articles/` | 1 | 0.0 | 1 | no | keep | performance |
| `football/cfb_p4/research/qb_epa.json` | 1 | 0.0 | 1 | yes | keep | football-validation |
| `football/validation/feature-status-nfl.json` | 1 | 0.0 | 1 | no | keep | football-weekly-build |
| `model_loop/published/ufc/` | 3 | 0.0 | 1 | yes | keep | model-loop-ufc |
| `football/validation/feature-status.json` | 1 | 0.0 | 1 | yes | keep | football-validation |
| `docs/college-baseball/REPORT.md` | 1 | 0.0 | 1 | yes | keep | college-baseball-research-build, college-baseball-research-validate |
| `football/cfb_lab/governance/` | 5 | 0.0 | 1 | yes | keep | cfb-lab |
| `collective/reports/` | 2 | 0.0 | 1 | no | keep | football-regrade |
| `football/validation/pricing_nfl.json` | 1 | 0.0 | 1 | yes | keep | football-weekly-build |
| `docs/model-loop/nfl/weekly/` | 2 | 0.0 | 1 | no | keep | model-loop-nfl |
| `model_loop/ledger/ufc/` | 1 | 0.0 | 1 | yes | keep | model-loop-ufc |
| `docs/model-loop/cfb/weekly/` | 2 | 0.0 | 1 | no | keep | model-loop-cfb |
| `football/players/params.js` | 1 | 0.0 | 1 | yes | keep | football-weekly-build |
| `engine/missingness.json` | 1 | 0.0 | 1 | yes | keep | lab-build, lab-validate |
| `football/nfl/coaching_staff_seed.json` | 1 | 0.0 | 1 | no | keep | nfl-coaching-staff-validation |
| `hockey/sources/registry.json` | 1 | 0.0 | 1 | yes | keep | nhl-build, nhl-validate |
| `collegiate/probe/index.json` | 1 | 0.0 | 1 | yes | keep | collegiate-probe |
| `basketball/ncaam_forecast/reports/` | 2 | 0.0 | 1 | no | keep | ncaam-weekly |
| `weekly_model_report.md` | 1 | 0.0 | 1 | yes | keep | nfl-weekly-loop |
| `docs/model-loop/cfb/versions.json` | 1 | 0.0 | 1 | no | keep | model-loop-cfb |
| `football/health.json` | 1 | 0.0 | 1 | yes | keep | model-health |
| `football/validation/key_numbers.json` | 1 | 0.0 | 1 | yes | keep | football-weekly-build, injury-sync, starter-context |
| `football/validation/movement_cfb.json` | 1 | 0.0 | 1 | yes | keep | football-weekly-build |
| `docs/model-loop/cfb/weekly_model_report.md` | 1 | 0.0 | 1 | no | keep | model-loop-cfb |
| `docs/model-loop/nfl/weekly_model_report.md` | 1 | 0.0 | 1 | no | keep | model-loop-nfl |
| `docs/model-loop/nhl/` | 2 | 0.0 | 1 | no | keep | model-loop-engines |
| `docs/model-loop/nfl/versions.json` | 1 | 0.0 | 1 | no | keep | model-loop-nfl |
| `college_baseball/research/COVERAGE.md` | 1 | 0.0 | 1 | no | keep | college-baseball-research-build |
| `basketball/ncaaw_forecast/reports/` | 1 | 0.0 | 1 | no | keep | ncaaw-weekly |
| `football/props/factory/coverage.json` | 1 | 0.0 | 1 | no | keep | props-factory |
| `tools/football/patch_nfl_live_paths.js` | 1 | 0.0 | 1 | no | keep | starter-context |
| `datapack/quant_v1/EDGEDESK_CROSSCHECK.json` | 1 | 0.0 | 1 | no | keep | lab-validate |
| `docs/model-loop/nba_engine/` | 2 | 0.0 | 1 | no | keep | model-loop-engines |
| `football/validation/pricing_cfb.json` | 1 | 0.0 | 1 | yes | keep | football-weekly-build |
| `basketball/ncaam_forecast/registry/` | 4 | 0.0 | 1 | yes | keep | ncaam-weekly |
| `performance/social/` | 1 | 0.0 | 1 | no | keep | performance |
| `basketball/ncaaw_forecast/registry/` | 4 | 0.0 | 1 | yes | keep | ncaaw-weekly |
| `college_baseball/params/` | 2 | 0.0 | 1 | no | keep | college-baseball-research-validate |
| `data/refs/manual_assignments.json` | 1 | 0.0 | 1 | no | keep | nfl-ref-assignments |
| `football/altitude/monitoring.json` | 1 | 0.0 | 1 | yes | keep | football-enrichment |
| `football/rankings/params.js` | 1 | 0.0 | 1 | no | keep | football-weekly-build |
| `research/clv/openers/summary.json` | 1 | 0.0 | 1 | no | keep | clv-openers |
| `engine/lab/ufc_elo.json` | 1 | 0.0 | 1 | yes | keep | lab-validate |
| `record/grades.json` | 1 | 0.0 | 1 | yes | keep | grade-briefs |
| `football/props/factory/status.json` | 1 | 0.0 | 1 | no | keep | props-factory |
| `nba/market/quotes.json` | 1 | 0.0 | 1 | yes | keep | nba-build |
| `hockey/market/quotes.json` | 1 | 0.0 | 1 | yes | keep | nhl-build, nhl-validate |
| `football/research/nfl_v2/versions/` | 0 | 0.0 | 1 | yes | keep | nfl-weekly-loop |
| `football/markets/` | 0 | 0.0 | 0 | yes | keep | cfb-lab |
| `college_baseball/data/market/` | 0 | 0.0 | 0 | yes | keep | college-baseball-prices |
| `college_baseball/params/production.json` | 0 | 0.0 | 0 | no | keep | college-baseball-research-build |
| `features/` | 0 | 0.0 | 0 | yes | keep | edgedesk-features-run |
| `football/rankings/coaching_program_validation.json` | 0 | 0.0 | 0 | no | keep | football-validation |
| `football/nfl/starter_sync/` | 0 | 0.0 | 0 | yes | keep | injury-sync |
| `2/` | 0 | 0.0 | 0 | yes | keep | mlb-pitchers |
