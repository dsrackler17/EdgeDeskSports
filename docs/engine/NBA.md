# NBA — model card and build report (`edgedesk_nba_v1`)

> Status: **⟨STATUS⟩.** Fair lines are published; value claims are off.
> Research, not picks.

This is the NBA engine the brief asked for (sections 1–12). It sits beside the
other sports and changes none of them. The football, MLB, NHL and lab code is
untouched. The shared files gained one NBA entry each, and the tests that pin
those files were updated (§13). The research review behind the method choices
is [`NBA_RESEARCH.md`](NBA_RESEARCH.md).

Every number below comes from a committed artifact:

- `nba/validation/nba_walkforward.json`: the game record.
- `nba/validation/summary.json`: the slice of that record the panel reads.
- `nba/validation/nba_props_walkforward.json`: the props record.
- `nba/validation/holdout_log.json`: every time the test window was opened.
- `nba/params/`: the tuning and the live parameters.

Running `npm run nba:check` re-verifies the committed record, the props record and the slate.

---

## 1. Datasets and coverage

| Table | Source | Coverage | Where |
|---|---|---|---|
| Games (one row per game) | sportsdataverse `hoopR-nba-data` schedules (public parquet on raw.githubusercontent.com, compiled from ESPN's NBA feeds) | 2002-03 → 2026-27: ⟨GAMES⟩ final games (regular season, play-in, playoffs); 1,206 scheduled 2026-27 games | `nba/data/games/<season>.csv` |
| Team games (two per game) | hoopR team box + play-by-play | 61,862 rows: box score, possessions (BBRef estimator), five shot zones, transition proxy, rest, back-to-back, games in 7 days, travel km, time-zone shift, altitude, road trip / home stand | `nba/data/team_games/<season>.csv` |
| Player games | hoopR player box | 640,738 appearances; starter flag; DNP reason category from 2012-13 | `.cache/nba_work` (rebuilt by `npm run nba:backfill`), `nbahist.player_games` |
| Lineup stints | reconstructed from play-by-play substitutions | 935,757 stints in 30,582 games; every on-court five with seconds, possessions and points | `.cache/nba_work`; five-man units per team-season in `nba/data/lineups/<season>.json` |
| Shots | play-by-play | 5,130,866 field-goal attempts with zone and distance | `.cache/nba_work` |
| ESPN displayed spread | play-by-play `game_spread` | 18,080 games, 2012-13 on | `games.ref_line_home`: **a diagnostic only** (no timestamp, no book, no price) |
| Rosters | hoopR rosters | 2025-26 and 2026-27 snapshots | used only for the labelled preseason roster scenario |

**Integrity, measured per season** (`nba/data/manifest.json`):

- **Period scores.** From 2019-20 they come from the schedule's linescores. Before that they come from the play-by-play, and a game is dropped from half and quarter scoring when its periods do not sum to the final. That happened in about 25% of games from 2002-03 to 2005-06 (burn-in only) and in fewer than 30 games a season after 2006-07.
- **Minutes from the stints.** The reconstructed stints reproduce the box-score minutes with a mean absolute error of 0.25 minutes per player-game.
- **Team box points** match the final in every game kept.

**Time.** The NHL rule is used unchanged.

- `known_at` is blank on every row, because first publication was never recorded and nothing is backdated.
- `assumed_available_at` is the scheduled start plus 4 hours.
- `pit` is `RETRO`.
- Every game is predicted at tip − 30 minutes from the games available by then. The leakage audit over ⟨LEAK_N⟩ predictions found ⟨LEAK_V⟩ violations.

## 2. Authorisation and limits

**Licensing.**

- **The data is public but not licensed for commercial use.** The `hoopR-nba-data` repository is MIT-licensed, but its game data is ESPN's and the NBA's, and the repository's licence grants no rights to it. ESPN's and NBA.com's terms restrict commercial use. **The owner must review before NBA output is sold in a paid tier.** The licence notice is printed on every NBA artifact (`nba/config.js` LICENSE).
- **NBA Stats (stats.nba.com) and `swar/nba_api` are not used.** NBA Stats was unreachable from this build, and its terms restrict automated and commercial use. `nba_api`'s MIT licence covers the client only.
- **No proprietary model was copied.** Rithmm's posts could not be fetched (DNS refused). Nothing of theirs is used.

**Spending.**

- **No paid feed was activated.** NBA prices are captured only when **both** of these are set: the repository variable `NBA_PRICES=on`, and the gateway row `basketball_nba` (inserted **disabled** by `supabase/nba_odds_sport.sql`). Until then `nba/market/quotes.json` reads DISABLED and every market block says so.
- **The Supabase copy is not written** unless `NBA_SUPABASE=on`.
- **Nothing is deployed.** No migration was applied, no function was redeployed and nothing was merged (§14).

## 3. Models trained

Seventeen candidates are scored on the same games, in seven families plus two baselines. All are point-in-time.

| Id | Family | What it is |
|---|---|---|
| `home_only` | baseline | home court only |
| `lab_points` | baseline | **the existing NBA model** (basketball lab points ratings) |
| `A_elo`, `A_glicko` | A | Elo in FiveThirtyEight's NBA form, and Glicko with rating deviation. Both tuned on the selection window (K, home court and carry; c, summer RD inflation, scale and home court) |
| `B_eff` | B | opponent-adjusted offence, defence and pace, plus the four factors and shooting luck (actual minus location-expected eFG), by recency-weighted least squares |
| `F_kalman` | F | Bayesian dynamic linear model: each team's offence and defence as a random walk with full covariance, between-season carry, and the posterior sd as uncertainty |
| `C_players_P` / `_C` | C | RAPM: ridge on every lineup stint (preconditioned conjugate gradient), weighted by recency. Team strength is impact × expected minutes, scaled to 240 minutes. P = projected availability (the previous game's rotation), C = confirmed (who played) |
| `C_team_avail_P` / `_C` | C | Kalman team rating plus the change in player strength from the team's usual rotation |
| `D_sim` | D | possession simulation: four-factor rates, pace, end-game fouling and overtime, with the level anchored to B's points per possession |
| `E_ridge`, `E_logit`, `E_gbdt` (× P, C) | E | ridge regression, ridge logistic, and gradient-boosted trees (own histogram implementation, early stopping on the season before) on 50+ point-in-time features. Calibrated by the shared rule below |
| `G_stack_P` / `_C` | G | ridge stack of Elo, B, Kalman, availability, ridge and GBDT, fitted only on out-of-sample predictions |

**Hyperparameters** (`nba/params/tuning.json`, with each family's full grid) were chosen on the **selection window only**, each family by its own signal's walk-forward log loss:

- **Elo:** K 16, home court 60, carry 0.6.
- **Glicko:** c 6, summer 80, scale 0.7, home court 90.
- **Adjusted ratings:** half-life 120 days, 16 prior games, carry 0.7.
- **Kalman:** q 0.02, summer 4, carry 0.7.
- **RAPM:** λ 1500, half-life 365 days.
- **ML:** ⟨ML_TUNING⟩.

## 4. Methodology

**Windows.** These were written into `nba/config.js` before any candidate was scored, and never moved.

- **Burn-in, 2003–2007:** used to train ratings, never scored.
- **Selection, 2008–2017:** every choice is made here.
- **Test, 2018–2026:** SEALED. It is scored once, by the frozen specification, and every unsealing is logged with the specification's hash.
- **Live, 2027.**

**Nesting.** For each scored season S:

- Each candidate's calibration is fitted on the out-of-sample rows of S−3…S−1. That covers location and slope on the margin, with a stage interaction for early-season games, plus the total and the halves.
- The end-game shape and the overtime parameters are fitted on the same rows.
- The ML models are trained on the seasons before S.
- GBDT early stopping uses S−1 and then refits.

There is no random split anywhere. There is one row per game (no mirrored team rows), so a game's mirror can never leak its label.

**One distribution per game** (`nba/model/distribution.js`). Every market is read from the same probability mass function: moneyline, spread and alternates, total and alternates, team totals, first half, first quarter, overtime, and the score ranges.

- **Regulation margin.** A discretised normal with σ = s0 + s1·min(|μ|, 10). It is reshaped by fitted end-game weights oriented to the favourite: the tie mass, and the favourite's and the underdog's margins of 1–10.
- **Overtime.** Entered from a regulation tie. The overtime margin is N(κμ, sd), with κ fitted (the favourite's measured edge).
- **Total.** A normal mixture over the number of overtimes.
- **Team totals.** From the joint margin–total pmf.
- **Halves and quarters.** Scaled from the full-game mean with fitted fractions.
- **Pushes.** Whole-number lines carry their push probability. Ladders step in half points.

**Choice.** Per track, the lowest selection moneyline log loss wins. A challenger must beat the simpler incumbent by ≥ 0.001 (`engine/lab/protocol`), so the ensemble is kept only if it earns its complexity.

**Scoring.**

- Moneyline: log loss, Brier, calibration slope and calibration-in-the-large, with bins.
- Margin and total: CRPS, PIT and 80% coverage.
- Threshold calibration for the alternate lines.
- First half and first quarter: CRPS.
- Comparisons: a date-blocked paired bootstrap with 95% intervals.

**Market.** No licensed archive of timestamped NBA prices exists here, so:

- Every market is **NOT_TESTED**.
- There is no ROI and no CLV.
- ESPN's displayed spread is reported only as the labelled diagnostic it is.
- No "no-vig consensus" baseline is computed, because there are no timestamped quotes to build one from.

## 5. Model comparison

⟨COMPARISON⟩

## 6. Selected model and justification

⟨SELECTED⟩

## 7. Ensemble contribution

⟨ENSEMBLE⟩

## 8. Moneyline, spread and total calibration

⟨CALIBRATION⟩

## 9. Prop validation

**Model** (`nba/props/model.js`): expected minutes × per-minute rate × context, never a fixed bump for an absent star.

- **Minutes.** A ridge regression of minutes on:
  - recent and season minutes, and start rate;
  - blowout risk (|expected margin| × role);
  - teammates missing (their usual usage);
  - whether he played the last game;
  - rest, back-to-back and foul rate.
- **Production.** A Poisson GLM per stat, with a log(expected minutes) offset, on:
  - shrunk recent, season and long-run rates;
  - the opponent's allowed factor and pace;
  - teammates' missing usage × own usage;
  - home, back-to-back and blowout risk.
- **Distribution.** Negative binomial, with dispersion fitted by method of moments on the training seasons.
- **Dependence.**
  - Residual correlations between the seven stats.
  - P+R+A, P+R, P+A and R+A are priced from the correlated variance (a moment-matched negative binomial), never from independent marginals.
  - Double-doubles and triple-doubles come from a Gaussian copula.
- **Training.** Season S is trained on S−4…S−1.

**Validation** (`nba/props/walkforward.js`):

- **Rows:** every player-game with at least 3 earlier games and at least 12 recent minutes.
- **Distribution scores:** CRPS, PIT and 80% coverage.
- **Over/under calibration** at three synthetic lines: the half-point nearest the mean, and ±1 sd. No historical prop prices are licensed, so these are calibration probes, not a market test.
- **Baselines:** the season average and the last-10 average, each with its own fitted dispersion.

⟨PROPS⟩

## 10. Frontend tests

The panel is Research → Other → **NBA** (`lib/edgedesk_nba_ui.js`, `lib/edgedesk_nba.css`, registered in `app.html`). It has four tabs.

- **Games.** For every upcoming game:
  - **Price:** win probability, fair moneyline, spread, total, team scores, team totals, alternates, first half and first quarter.
  - **Model comparison:** every model's number side by side, and how far they disagree.
  - **Matchup and context:** pace, the four factors, rest, travel and altitude.
  - **Availability:** each player's impact, "if he sits / returns" scenarios priced by the same model, and the labelled roster-adjusted scenario at a season's start.
  - **Explanation:** the features that moved the number.
  - **Uncertainty.**
  - **Reasons to pass.**
  - **The market:** shown beside the model, never inside it, with a price check.
- **Props.** Fair lines per player and stat, with each stat's walk-forward status.
- **Record.** Every candidate, the comparisons with their intervals, the calibration bins, the seal and the leakage audit.
- **Methods.** Data, licences, protocol and limits.

⟨FRONTEND⟩

## 11. Costs

| Item | Cost |
|---|---|
| Data (sportsdataverse parquet) | $0. About 545 MB the first time, cached between CI runs |
| Odds | **$0 by default.** If authorised: one `featured` request per 3-hourly run, ≈3 credits, served from the gateway's stored snapshot inside its cadence window. At most ≈24 credits a day, about 720 a month |
| GitHub Actions | ⟨CI_COST⟩ |
| Supabase | $0 until `NBA_SUPABASE=on`. Then about one season of rows (≈1,300 games, ≈28,000 player-games) per sync, well inside the free tier's storage |
| AI desk | $0: NBA answers are deterministic from the slate, with no model call |

## 12. Missing data and limitations

**Blocked.** Each of these needs a decision or a resource from the owner.

1. **The market test.** No licensed archive of timestamped NBA closing prices exists here. Until there is one:
   - every market is NOT_TESTED;
   - value claims are DISABLED;
   - there is no ROI and no CLV.

   ESPN's displayed spread (2012-13 on) has no timestamp, no book and no price, so it is used only as an accuracy diagnostic.
2. **Live prices.** These need the owner to authorise spend: run `supabase/nba_odds_sport.sql`, enable the gateway row, and set `NBA_PRICES=on` (§11).
3. **Commercial data rights.** ESPN- and NBA-derived data must be reviewed before NBA output is sold (§2).
4. **The Rithmm posts and the NBA.com glossary and terms.** Both are unreachable from this build. `NBA_RESEARCH.md` §7 lists what to verify from an open network.

**Provisional.** These limit how far the numbers can be trusted.

- **No injury report or confirmed lineup feed.** The published price uses the **projected** track: each team's previous-game rotation, or last season's closing rotation for its first game. The confirmed track (who played) is scored in the walk-forward as the upper bound a lineup feed could reach. It is never used for a published price.
- **Retrospective data.** When a result was first published is unknown. Every game is assumed known four hours after tip, and `pit = RETRO`.
- **Rosters at a season's start.** The opening price carries last season's closing rotation. The roster-adjusted scenario (the 2026-27 preseason roster) is shown beside it, labelled. Its timing cannot be reproduced historically, so it is never scored.
- **The possession simulation (D)** omits and-ones and bonus free throws. Its level is anchored to B, and its spread of outcomes is wider than the data. It stays a candidate and is not the published price.
- **Older data.** Play-by-play before 2006-07 has period-score mismatches. These seasons are burn-in only, and half and quarter scoring drops those games. DNP reasons start in 2012-13.
- **Props** are validated on synthetic lines; no historical prop prices are licensed. Minutes carry most of the uncertainty, and the minutes model has no injury feed.
- **The cross-sport registry** (`engine/registry.json`) still reads the basketball lab's NBA record. Switching it to this engine is a separate, reviewable change; this build leaves the registry and the board untouched.

## 13. Files changed and tests executed

**New: the engine (`nba/`).**

| Path | What it does |
|---|---|
| `nba/config.js` | Windows, sources, licences, paths, schemas |
| `nba/ingest/season.js`, `nba/ingest/pbp.js` | Schedule, team and player box, play-by-play: period scores, lineup stints, shots, possessions, the transition proxy; rest, travel, altitude and time zone |
| `nba/lib/io.js`, `nba/lib/data.js`, `nba/lib/venues.js` | Cached fetch, the parquet bridge, tables, arenas |
| `nba/tools/parquet_select.py` | pyarrow column selection; CR/LF inside strings is flattened |
| `nba/tools/fetch_all.js` | Download every season's parquet into the cache |
| `nba/tools/lineups.js` | Five-man units per team-season |
| `nba/tools/sync_supabase.js` | The `nbahist` copy (service role, off by default) |
| `nba/model/ratings.js` | Elo, Glicko, adjusted ratings, Kalman |
| `nba/model/players.js` | RAPM and availability |
| `nba/model/simulate.js` | The possession simulation |
| `nba/model/learn.js` | Ridge, logistic, GBDT, Platt |
| `nba/model/ml.js` | The E models per track |
| `nba/model/pass.js` | The point-in-time pass |
| `nba/model/distribution.js`, `nba/model/dist_fit.js` | One distribution for every market, and its fitting |
| `nba/model/walkforward.js` | The record, the seal, the choice |
| `nba/model/tune.js` | Selection-window tuning, with parallel parts |
| `nba/model/live.js` | The live parameters |
| `nba/props/state.js`, `nba/props/model.js`, `nba/props/walkforward.js`, `nba/props/build_props.js` | Props: features, model, record, slate |
| `nba/build_slate.js` | The slate, scenarios and the ledger |
| `nba/grade_ledger.js` | Grades the ledger |
| `nba/market/quotes.js`, `nba/market/fetch_quotes.js` | Gated price capture |
| `nba/desk.js` | The desk module |

**New: committed data and artifacts.** `nba/data/**`, `nba/params/**`, `nba/validation/**`, `nba/slate.json`, `nba/props_slate.json`, `nba/ledger/**`, `nba/market/quotes.json`.

**New: everything else.**

- **App:** `lib/edgedesk_nba_ui.js`, `lib/edgedesk_nba.css`.
- **SQL:** `supabase/nba_engine.sql`, `supabase/nba_engine_rollback.sql`, `supabase/nba_odds_sport.sql`, `supabase/migrations/20261014120000_nba_odds_sport_row.sql`.
- **CI:** `.github/workflows/nba.yml`.
- **Tests:** `tools/nba/nba.test.js`, `nba_desk.test.js`, `nba_sql.test.js`, `nba_ui.e2e.js`.
- **Docs:** `docs/engine/NBA.md`, `docs/engine/NBA_RESEARCH.md`.

**Changed shared files.** Each has one NBA entry added.

| File | Change |
|---|---|
| `app.html` | The NBA button, panel host, stylesheet and registration |
| `lib/edgedesk_sports.js` | NBA in `RESEARCH_COVERAGE` |
| Inlined copies: `record.html`, `supabase/functions/{edgedesk_ai,capture,close}/index.ts` | Synced with `tools/presentation/inline.js` |
| `supabase/functions/edgedesk_ai/index.ts` | The `nbaTurn` after the NHL turn |
| `tools/presentation/inline.js` | The `EDNBADESK` entry |
| `supabase/expose_schemas.sql` | `nbahist` listed |
| `package.json` | `nba:*` scripts |
| `README.md`, `docs/engine/README.md` | NBA sections |

**Tests updated** because they pin the coverage list or the Other row. These are dated changes, not loosened checks: `tools/app/navigation.test.js`, `tools/app/sports_config.test.js`, `tools/intelligence/support_boundary.test.js`.

**Untouched:** football, MLB, NHL, the basketball lab, the registry and the board, the odds gateway code, and every other workflow.

⟨TESTS⟩

## 14. Deployment and rollback status

**Nothing is deployed.** The work is on branch `claude/vibrant-einstein-sz8a25` as a draft pull request.

**What merging does.**

- **The panel goes live.** GitHub Pages serves `app.html`, so the panel ships on merge. It reads only committed files.
- **The SQL does not run.** `supabase/nba_engine.sql` (the `nbahist` schema) and `supabase/nba_odds_sport.sql` (the disabled gateway row) are applied by hand in the SQL editor. The odds-row migration in `supabase/migrations/` mirrors the NHL's and inserts the row **disabled**. The schema is deliberately not a migration.
- **The desk does not change yet.** The NBA desk turn is in `supabase/functions/edgedesk_ai/index.ts`. It reaches readers only when the function is redeployed (`Deploy intelligence`, manual). Its `BUILD` tag is unchanged, so the Intelligence doctor does not redeploy it on its own. `EDGEDESK_NBA=0` switches the turn off without a code change.
- **Scheduled jobs start.** `.github/workflows/nba.yml` runs on `main` after merge: the build every 3 hours, the sealed validation weekly. They spend nothing (`NBA_PRICES` and `NBA_SUPABASE` are unset), and they commit through `tools/ci/push_generated.sh` only when the checks pass.

**Rollback.** Each layer can be withdrawn on its own.

- **The panel:** remove the NBA button and `researchRegister({id:'nba'…})` from `app.html`, or revert the merge. The panel holds no state.
- **The coverage list:** remove `{ id: 'nba' }` from `EDSPORTS.RESEARCH_COVERAGE` and run `node tools/presentation/inline.js`. That restores the previous coverage sentence everywhere it is inlined.
- **The desk:** set `EDGEDESK_NBA=0` in the function's secrets, or redeploy the previous build.
- **The database:** `supabase/nba_engine_rollback.sql` drops `nbahist` (nothing outside it depends on it). `select public.odds_api_set_sport('basketball_nba', false);` withdraws price capture.
- **The jobs:** disable the `NBA engine` workflow.
