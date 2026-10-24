# NCAAW_MODEL_NOTES — EdgeDesk women's college basketball (NCAA Division I) pregame forecasts

Written 2026-10-24 for the build on branch `claude/ncaaw-forecast`. The women's counterpart of
[`CBB_MODEL_NOTES.md`](CBB_MODEL_NOTES.md) (men's). Every number here was produced by the
committed code over the committed data, and the file holding it is named. Where something is
not built, not validated, or waits on a person, this document says so.

**Runbook** (set up, run, verify, deploy, disable, roll back):
[`docs/ncaaw-forecast/README.md`](docs/ncaaw-forecast/README.md).

**Naming.** Everything is `ncaaw` / `ncaaw_fc_*` (`cbb` is college baseball in this repository).
**Women's only.** No men's source is read: a test greps the package for hoopR, `mbb` and the men's
paths (`basketball/ncaaw_forecast/tests/model.test.js`, "scope"). The one men's directory it
reaches is the research engine both systems call, `basketball/ncaam_research/team_model.js`,
which is league-neutral: it reads possessions, points and minutes.

---

## 1. Status, component by component

*Deployed* = in production. **2026-10-24:** the build is on `main`, and the database layer and research
registration are applied in production (*Deploy NCAAW forecast SQL*, run 40098150410: every report row `ok`).
**Nothing is published yet:** `NCAAW_FC_PUBLISH` is not set.

| Component | Built | Tested | Deployed | Waits on |
|---|---|---|---|---|
| Data: wehoop women's schedules + box scores 2010-2027, quality, quarantine, D-I membership, hashes (§3) | yes | yes | yes (daily job) | — |
| Pregame model: ratings, coherent win probability, margin and total distributions (§4) | yes | yes (98 checks) | yes | — |
| Development selection, frozen (§5) | yes | `select.js --check` | — | — |
| Validation record (§6) | yes | `validate.js --check` (leakage 0) | — | — |
| Champion `ncaaw_adjeff@1.0.0`, promoted by the weekly gates (§7) | yes | yes; failure injection 37 checks | yes | — |
| Daily refresh and atomic publication (`ncaaw-forecast.yml`, 13:47 UTC) | yes | yes | builds daily; **publishes only with `NCAAW_FC_PUBLISH = on`** | the variable (a person) |
| Weekly challengers (`ncaaw-weekly.yml`, Monday 11:37 UTC) | yes | yes | yes | — |
| Upset Watch (three separate signals, frozen thresholds) (§8) | yes | yes | with publication | as above |
| Database `supabase/ncaaw_forecast.sql` + migration, RLS, premium gate | yes | yes (67 checks on PostgreSQL, the men's layer beside it) | **yes** (2026-10-24, run 40098150410) | — |
| Research registration NCAAW-FORECAST 1.0.0 (EXPERIMENTAL, T3), written before validation | yes | yes | yes (same run) | — |
| Reader: the Simulator's **Women's College Basketball** seat (Games, Upset Watch, Tournament, Model Health) | yes | unit 49 + Chromium 41 checks | yes ("no forecast published yet" until the first publication) | publication |
| Signal Center: women's forecast shifts | wired, tested | yes | coming soon | publication |
| Market-assisted forecast, market-disagreement signal | interfaces only | the "unavailable" state | **no** | no women's college basketball price is captured anywhere |
| NCAA tournament simulation | **not built** | — | — | a host-site-aware women's bracket (§9) |
| In-game (live) forecasts | **not built** | — | — | a women's live feed and writer |

## 2. How the women's game differs, and where each difference is handled

| Difference | Measured / sourced | Handled in |
|---|---|---|
| Two 20-minute halves through 2014-15, four 10-minute quarters from 2015-16 | the source's `format_regulation_periods`: 2 for every 2015 game, 4 for every 2016+ game | `ingest.js`: `regulation_periods` per game, `n_ot = periods - regulation_periods`; `quality.js` quarantines a quarters-era final with fewer than 4 periods. Regulation is 40 minutes and an overtime 5 minutes in both eras, so `dist.js` is unchanged |
| No one-and-one since 2015-16: the bonus is two shots on the fifth team foul of each quarter | NCAA women's rules | the possession estimate's free-throw-trip constant is **0.44** (Dean Oliver's two-shot-bonus constant, as in the NBA), not the men's college 0.475. An external constant, never fitted on an outcome |
| Box scores sparse before 2017 | team box lines for 13-33% of finals 2010-2016, 93-100% from 2017 (`data/manifest.json`) | the possession engine starts at 2017 (`MODEL_FIRST_SEASON`, a burn-in season). The scores-only incumbent reads every season from 2010 |
| NCAA tournament first two rounds on the top 16 seeds' campuses | 32 non-neutral NCAA games a season from 2022 (16 hosts x 2) and 31 in 2019; 0-3 a season in 2012-2018 and 11-14 in 2010-2011, so the earlier flags undercount host games | taken as the source flags it (home-court applies where it says not neutral). `validate.js` reports host-campus and neutral tournament games separately |
| Postseason events | tournament ids measured 2010-2026: 22 NCAA Women's Championship, 37 Women's NIT, 38 WBI, 62 WBIT | `quality.js` |
| NCAA region names | "Albany Region" to 2022; "Regional 1 in Spokane" (two sites, two regions each) from 2023 | `quality.js ncaaRegion` ("Albany", "Spokane 1") |
| Seeds | the source carries ranks in NCAA games from 2024 only | seeds verified 2024-2026 by the men's rule (every first-round pair sums to 17); none earlier |
| Possessions per game | 69.9 per D-I game in the 2017 burn-in season | `model.js` keeps the 70-possession constant of the stabilised parameter variance (measured, not borrowed) |

## 3. Data

`basketball/ncaaw_forecast/data/`: one hashed `games_<season>.csv.gz` per season (2010-2027), the
manifest with each source's sha256, `teams.json`, and `quarantine.json` (per season: the games
whose only issue is a missing box score, by id, and every other quarantined row with its
reasons). Every final agrees with the incumbent's own women's dataset (`basketball/data/ncaaw`):
0 mismatches in every season. Division I membership comes out at 343-363 teams a season. The
NCAA bracket rebuilds from the games' structure with no issue in any season (63 games to 2021,
67 with the First Four from 2022; none in 2020). 2027 (2026-27) holds 2,283 scheduled games, the
first on 2026-11-02.

## 4. Model

The men's system's model, unchanged in method: the research engine's opponent-adjusted offense,
defense and tempo, one coherent integer regulation-margin distribution with a fitted endgame tie
factor and an overtime model, a total correlated with the margin, a calibrator refitted weekly on
earlier games only (`model.js`, `dist.js`). Two engineering corrections were needed for the
women's champion, whose recency half-life (365 days) makes the engine's fit depend on the moment
it refits (the men's champion has no half-life, so neither case arises there):

- an artifact as of T now includes the games whose prediction time precedes T but whose results
  are not yet available (results withheld), so it refits at exactly the moments the walk-forward
  did;
- an explicit stop marker at T, so a replay of a finished season (no scheduled game after T)
  stops at T instead of running on to its end-of-season refit.

With both, the production artifact reproduces the walk-forward forecast to 1e-9
(`tests/model.test.js`).

## 5. Windows and the frozen selection

Fixed 2026-10-24 before any women's model number was computed, and set by the data:
burn-in **2017**; development **2018-2022** (every choice made here); confirmation **2023-2026**
(scored once); tournament holdout: the NCAA tournament games of **2024-2026**, never used to
choose anything.

`config/selection_v1.json` (hash `48e6afca2753bd73`): the research engine's coordinate-descent
rule rerun from the engine's defaults on the women's development games only (39 configurations;
a value is taken only if it improves development margin CRPS by >= 0.002). Nothing chosen on men's
data is carried over.

| Parameter | Women's (chosen) | Men's champion | Reading |
|---|---|---|---|
| `carry` (last season's rating kept) | **1.0** | 0.9 | women's programmes are more stable year to year |
| `lambda` (prior weight) | **150** | 300 | ratings move faster off the prior |
| `half_life` (days) | **365** | none | older games count less |
| tempo `lambda_tempo` / `carry_tempo` | 2 / 0.9 | 2 / 0.9 | same |

The variance law was compared on the same window with the chosen parameters: margin v1 with the
stabilised parameter variance, total v2 (the men's law) was kept; no variant improved development
CRPS by 0.002 (margin v2 6.8798 vs 6.8804; engine variance 6.8835; total v1 9.3253 vs 9.3237).

## 6. Validation (`validation/ncaaw_fc_validation.json`, `validation/VALIDATION.md`)

Retrospective: results retrieved after the fact, a game assumed known 4 hours after tip,
predictions 30 minutes before tip; leakage audit 0 violations. D-I v D-I games; intervals are
95%, bootstrap clustered on game day; differences are the candidate minus the other (negative =
the candidate is better).

| Window | n | Log loss | vs incumbent as served | Margin CRPS | vs incumbent | 80% margin cov. | 80% total cov. | Slope |
|---|---|---|---|---|---|---|---|---|
| Development 2018-2022 | 24,648 | 0.47611 | −0.00699 [−0.00923, −0.00500] | 6.880 | −0.141 [−0.169, −0.118] | 0.818 | 0.806 | 1.047 |
| **Confirmation 2023-2026** | **21,695** | **0.46582** | **−0.00455 [−0.00661, −0.00276]** | **6.873** | **−0.190 [−0.218, −0.162]** | 0.802 | 0.802 | 1.055 |
| Tournament holdout 2024-2026 | 201 | 0.34865 | −0.00925 [−0.01883, −0.00081] | 6.827 | −0.097 [−0.270, +0.104] | 0.781 | 0.821 | 1.309 |

- Confirmation calibration: calibration-in-the-large −0.0002, slope 1.055 (probabilities a little
  timid, as for the men's, 1.04-1.07), overtime 4.38% forecast vs 4.41% observed.
- The tournament holdout is too timid (slope 1.31, the home side winning 6.6 points more often
  than forecast): consistent with top seeds at home on their own campuses in the first two rounds
  (host-campus tournament games score log loss 0.284 against 0.513 at neutral sites in the
  non-holdout tournaments). 201 games are little evidence; reported, not tuned.
- Ablations on confirmation: removing the preseason prior costs 0.024 log loss; constant width
  costs 0.0006; the engine's raw parameter variance costs 0.0005. **Removing the endgame tie
  factor is very slightly better** on log loss (+0.00015 [+0.00003, +0.00027] for the candidate)
  in both windows; it is a catalogue challenger (`no_endgame_tie_factor`) that only the frozen
  weekly gates may promote, and a gain this size is below their 0.0002 threshold.
- Baselines: Elo 0.51086, home rate 0.67285 (confirmation log loss).

## 7. Promotion (`reports/weekly/2026-10-24-selection_v1.json`, `registry/history.jsonl`)

`config/promotion_v1.json` is the men's policy, adopted unchanged before any women's candidate
was scored; only its window differs (2023 to the season in progress). INIT `ncaaw_points@1.1.0`
(the served scores-only model, `docs/model-loop/ncaaw/versions.json`), then the weekly pipeline's
bootstrap run evaluated the frozen selection and every gate passed:

| Gate | Result |
|---|---|
| G1 sample | 21,695 shared games over 4 seasons (need 15,000 and 3) |
| G2 log loss | −0.00455 [−0.00661, −0.00276] (need <= −0.0002, interval below 0) |
| G3 Brier | −0.00133 [−0.00211, −0.00063] |
| G4 margin CRPS | −0.190 [−0.218, −0.162] (limit +0.002) |
| G5 calibration | citl −0.0002, slope 1.055, coverage 0.802 / 0.802, overtime 0.0438 vs 0.0441 |
| G6 cohorts | no gated cohort regressed |
| G7 integrity | hashes, leakage audit, snapshot recorded, artifact rebuilt identically |
| G8 operations | 0.7 minutes, every output finite |

**Champion: `ncaaw_adjeff@1.0.0`** (PROMOTE, 2026-10-24). The research registration stays
EXPERIMENTAL: the weekly pointer is an operational decision, not a research result.

## 8. Upset Watch (`config/upset_policy.json`, chosen on development rows, frozen)

theta **0.36** (the development 80th percentile of the underdog's probability among clear
favourites), high-uncertainty margin sd **13.3**, or fewer than 5 games for either team (so every
opening-week game carries the high-uncertainty signal). Confirmation: 3,753 of 21,695 games
flagged; the underdog won 41.4% [39.9%, 43.0%] against a mean forecast of 40.5%. Tournament
holdout, seed basis: the lower seed won 28 of 184 (15.2%) against a mean forecast of 21.5%.
The market-disagreement signal is UNAVAILABLE: no women's college basketball price is captured.

## 9. Not built, each with its reason

- **NCAA tournament simulation.** The men's slot engine treats every game as neutral; the women's
  first two rounds are home games for the top 16 seeds. A host-site-aware bracket and a verified
  2027 format and bracket (after Selection Sunday 2027) come first. The Simulator shows the
  Tournament tab as blocked, with these reasons. Nothing is registered for it.
- **In-game forecasts.** No women's live feed (the games slate carries no women's games) and no
  live writer. The database refuses live rows while `ncaaw_fc_config.live_enabled` is not
  `'true'`.
- **Market comparison.** No women's college basketball price is captured (the odds gateway does
  not carry it; the source's game files carry no pickcenter).
- **Player availability.** No owned women's injury or lineup feed.

## 10. Before the season (2026-11-02)

- [x] Merge the branch (#755). The daily refresh and the weekly challengers run on `main`.
- [x] Actions → *Deploy NCAAW forecast SQL* (run 40098150410, every report row `ok`).
- [ ] Set `NCAAW_FC_PUBLISH = on`. The next daily run publishes; the reader and Signal Center
  then show the forecasts.
- [ ] Owner review of the wehoop/ESPN data terms before women's output is sold.

## 11. Files

| Where | What |
|---|---|
| `basketball/ncaaw_forecast/` | config, ingest, quality, dataset, model, dist, metrics, select, validate, evaluate, registry, weekly, refresh, publish, upset, factors, db; `tests/` (model, sql, ops) |
| `basketball/ncaaw_forecast/config/` | `selection_v1.json`, `promotion_v1.json`, `upset_policy.json` (frozen) |
| `basketball/ncaaw_forecast/registry/`, `reports/weekly/`, `validation/`, `research/` | champion pointer and history, weekly reports, the validation record, the research registration |
| `supabase/ncaaw_forecast.sql` (+ `migrations/20261024180000_ncaaw_forecast.sql`), `supabase/ncaaw_forecast_registry.sql` | the database layer and the registration (generated by `simulator/src/research/build_ncaaw_registry_sql.ts`) |
| `lib/edgedesk_simulator_ncaaw.js`, `simulator/src/sports/registry.ts`, `simulator/tests/ncaaw_ui*.ts` | the reader, its Simulator entry, its tests |
| `tools/signal_center/db.js` (`ncaawGames`), `lib/edgedesk_signal_registry.js` | Signal Center wiring |
| `.github/workflows/` | `ncaaw-forecast.yml`, `ncaaw-weekly.yml`, `ncaaw-forecast-tests.yml`, `deploy-ncaaw-forecast.yml` |
