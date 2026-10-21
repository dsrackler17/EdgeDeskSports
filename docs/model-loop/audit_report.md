# EdgeDesk model audit: every sport

**Date:** 2026-10-20. **Repo state:** `beb1ed28`. **Scope:** NFL, CFB, MLB, WNBA, CBB (men's college basketball), UFC and tennis.

## How this audit was done

There were no database credentials in the audit environment. Everything was established from four sources: the code, the SQL DDL, the workflows, and the committed artifacts (slates, records, ledgers, validation files).

Each engine was **re-run read-only on its committed inputs**, and the replay was checked against what that engine actually published:

| Sport | Replay vs published |
|---|---|
| NFL | 71/100 published picks reproduced to the hundredth; the rest differ only by the reconciled starter |
| CFB | 62/62 slate games to ≤0.007 pt; historical picks to ±0.01 |
| WNBA | Live params exactly; ledger cards to 4 dp |
| CBB | Live params exactly |

Where an input the audit needed is **not owned or not committed**, the section says so and does not substitute a guess. Examples are MLB/WNBA/CBB closing lines, UFC odds and the tennis archive. The scripts that produced every number are in `docs/model-loop/audit_scripts/`.

## Executive summary

**NFL is not the only model with the KC@SEA problems.** Every sport has at least one of the NFL failure classes, and four sports have never been measured against a closing line at all.

- **NFL.** KC@SEA is explained.
  - Defensive ratings **never update in season**: the live absorb row carries offensive fields only.
  - So 88–92% of the strength edge in the three biggest 2026 misses was **2025 data**. On KC@SEA the 2025 prior contributes +5.14 pts to SEA while 2026 data alone favours KC by 2.81.
  - Home field is effectively **3.3 pts** on outdoor turf, from two stacked intercepts plus a week-of-season term.
  - The card omits the whole context model, leaving 0.87 pt unattributed.
  - The 80% range is skewed: −8 to +26 around 6.72.
- **CFB.**
  - The preseason prior is personnel-blind and gets 100% weight for 3 games.
  - Home field was over-applied (4.08) for seven weeks.
  - QB changes are structurally unpriced.
  - The range is off-centre by −1.0 pt on every game.
  - It labels its worst-accuracy region (7+ pt gaps) "VERIFIED MAJOR".
  - Components do reconcile exactly.
- **MLB.**
  - The numbers on the card come from a hand-set browser engine that has **never been logged, graded or compared with a close**. The "OUTCOME_VALIDATED" label belongs to a different model that prices nothing.
  - Replayed point-in-time, it is worse than Elo and overconfident.
- **WNBA.** **No WNBA market data is captured at all**, and the Finals are still being priced.
  - Totals are labelled validated while 2026 fails the rule.
  - There is no personnel input, and ratings refit weekly only.
- **CBB.** Home court **refits on every game, including non-D1 buy games**. It swells to ~7 pts in November against ~2.6–3.0 real, and goes live again on 2026-11-02.
  - Non-D1 opponents are rated near D1 average.
  - The card drops the fair spread.
  - Nothing has been tested against a close.
- **UFC.** **There is no UFC model.** Every probability on the card is a market de-vig.
  - The only measured model (an Elo lab) is worse than a constant.
  - Zero UFC closes are committed.
- **Tennis.** Retired from the product, but the pricing code has three critical wiring defects:
  - surface Elo never reaches the model;
  - ratings are frozen at 2026-05-25;
  - CLV is always NULL.

## Which NFL failure classes appear where

| Failure class (from KC @ SEA) | NFL | CFB | MLB | WNBA | CBB | UFC | Tennis |
|---|---|---|---|---|---|---|---|
| Priors dominate mid-season / never update | **Yes** (defense frozen) | Early only (100% for 3 games) | Shadow model yes; live has none | No (8% by Finals) | No | n/a | **Yes** (frozen since May) |
| Component weights wrong | **Yes** (pass D = pass O) | Stress term ÷100 twice | Starter share and shrink | Totals calibrator | Home-court refit | n/a | Surface Elo dropped |
| Personnel ignored in team priors | **Yes** (Walker SEA→KC) | **Yes** | **Yes** | **Yes** | **Yes** | **Yes** | **Yes** |
| Home field too high | **Yes** (~3.3) | **Yes** (4.08 to 10/18) | No (calibrated) | Mild (2.33 vs ~1.95) | **Yes** (~7 in Nov) | n/a | n/a |
| Components don't sum to the line | **Yes** (0.1–1.1 pt) | No (exact) | **Yes** (+1.81 hidden; residual ≤3.8 pp) | No (rounding) | Not shown at all | n/a | WTA score unrelated |
| Off-centre outcome range | **Yes** (≤3.1 pt) | **Yes** (−1.0 pt) | **Yes** (+0.64 runs) | No | Width wrong by month | n/a | n/a |
| Win prob vs pricing distribution disagree | **Yes** (≤4.5 pp) | **Yes** (≤4.2 pp) | Side vs run line | ≤3.4 pp | ≤1.6 pp | n/a | Board vs Lab ≤13 pp |
| Never measured vs close | Partly (consensus only) | No (DK close) | **Yes** | **Yes** | **Yes** | **Yes** | **Yes** |

## Ranked problems across all sports

Severity follows the brief: **Critical** means a wrong number reaches a user, or the model cannot be measured, with no warning. **High** means a material bias or a validation claim that is false. **Medium** means a contained bias or an internal inconsistency. Low and cosmetic items are listed per sport.

| # | Severity | Sport | Problem | Evidence | Impact |
|---|---|---|---|---|---|
| 1 | Critical | NFL | Defensive ratings never update in season: the absorb row is offense-only | `football/engine.js:411-427,439`; `app.html:50688`; training mirrors defense at `football/research/build_features.py:74-80` | Every 2026 defensive input is 0.8 × 2025. SEA pass D +2.39 on KC@SEA; NYJ pass D +2.75 on two of the top-3 misses |
| 2 | Critical | NFL | 2025 priors dominate mid-season (carry 0.8, α 0.10/0.06) | Replay with zeroed seeds | Top misses 88–92% prior. KC@SEA: prior +5.14 vs 2026 data −2.81 |
| 3 | Critical | MLB | The live card engine has no record: never stored, graded or closed. "Validated" belongs to `mlb/history`, which prices nothing | `app.html:17300-17332`; `engine/build_registry.js:104-112`; `engine/projections.json` mlb 0 | Users see fair ML, run line and totals from an unmeasured engine |
| 4 | Critical | WNBA | No market data captured: never compared with an open or close, and CLV is impossible | `supabase/odds_api_gateway.sql:100-105`; `capture/index.ts:2561` | An NFL-style 4-pt miss cannot be detected. Finals priced unanchored |
| 5 | Critical | CBB | Home court refitted on every game incl. non-D1 buy games: ~7.0 pts in November, 5.8 in December | `basketball/model.js:100-103` | D1 campus games over-favour home by 1.2–1.95 pts Nov–Jan. Live again 2026-11-02 |
| 6 | Critical | CBB | Non-D1 opponents rated near D1 average (−11.8 vs a 40.7-pt average loss) | `basketball/ingest.js`; `model.js:91-92` | Inflates D1 teams that beat them; drives the top gaps vs close |
| 7 | Critical | CFB | Preseason prior is last season × 0.75 with no personnel, portal, recruiting or coaching input, at 100% weight for 3 games. FCS teams at one −28 floor | `football/cfb_p4/engine.js:597-599,645-703,587,612` | Top FBS misses 19.9 / 18.1 / 17.0 pts. FBS-vs-FCS MAE 15.5 vs 11.7 |
| 8 | Critical | UFC | No model exists; every "fair" is a market de-vig | `engine/registry.json:1533`; `app.html:13768` | Nothing independent to measure; "edges" are line shopping |
| 9 | Critical | Tennis | Surface Elo never reaches the price; ratings frozen at 2026-05-25; CLV always NULL (`sharp_fair` unit mismatch) | `tools/tennis/price_board.js:74` vs `:103-121`; `incremental.js:136-166`; `settle_record.js:92-96` | Retired product; must not return without fixes |
| 10 | High | NFL | Home field ~3.3 on outdoor turf: intercepts 2.48 + 0.595, plus 0.614·week/18, −1.09 grass, −0.87 dome | `params.js` `w_spread[7]`, `w_ctx` | ~1.5 pt home lean vs the 2021–25 market (1.63) |
| 11 | High | NFL | Card components don't reconcile (context model omitted) | `football/game_research/current.json` `drivers.reconciles:false` | 0.1–1.1 pt unattributed; "Home field" understated |
| 12 | High | NFL | Pass D weighted equal to pass O (one `net_pass` coefficient); QB layer frozen; no player priors | `engine.js:480`; `app.html:50690` | Unstable defense moves the line as much as offense; QB changes ≤0.5 pt; offseason moves invisible |
| 13 | High | NFL | JS validation replay runs defense at zero and drops 542 games (team codes) | `tools/football/validate_pricing.js:116,139` | Published tiers and QB verdict rest on a broken replay |
| 14 | High | CFB | Home field over-applied (4.08 projected vs 3.2 learned) until 2026-10-18; fix not yet better on 2026 | `engine.js:84-101`; record bias +1.46 (n = 337) | 7 weeks of home lean in the graded record and CLV |
| 15 | High | CFB | QB changes not priced (`PRICED_STARTER_STATUSES = []`) | `football/matchup/inputs.js:84` | New-QB teams over-rated +0.5–0.8 vs close |
| 16 | High | CFB | "VERIFIED MAJOR" at 7+ pt gaps, where the model is worst (≥14: MAE 20.6 vs 13.1, ATS 42%) | `football/validation/pricing_cfb.json` | Steers users to the model's failures |
| 17 | High | MLB | Live engine overconfident and no better than Elo; totals strongly overconfident (O8.5 slope 0.39–0.55) | Replay 2023/2025 | Gaps vs market inflated ~25% |
| 18 | High | MLB | Starter silently league-average when the `pitcher_season` row is missing; swingman share uses relief IP | `mlb/engine.js:201,301-304`; `app.html:17247` | "OK" cards with the largest input zeroed; 13-pt gaps from IP/GS |
| 19 | High | WNBA | Totals labelled OUTCOME_VALIDATED while 2026 fails the rule (bias −4.1, cov80 0.72); calibrated totals worse than raw | `basketball/walkforward.js:169,247-259` | Finals totals 160.7 / 159.9 vs 132 / 144 |
| 20 | High | WNBA/CBB | Ratings refit weekly only while slates re-price daily | `lab-validate.yml:47` vs `lab-build.yml:38-40` | WNBA Finals G3 ignores G2; CBB Nov drift 1.6 pts |
| 21 | High | CBB | Card drops the fair spread (key mismatch), guard is EV-only, no close test, better engine not wired | `tools/slate/research.js:170-171`; `lib/edgedesk_card_feed.js:65,269` | Big point gaps show as LEAN |
| 22 | High | UFC | AI desk can mark UFC moneylines QUALIFIED from de-vig alone; Elo lab worse than a constant; zero closes | `edgedesk_ai/_board.js:85,398-401`; `engine/lab/ufc_elo.json` | Unvalidated "picks" |
| 23 | High | All | Paid odds capture paused since 2026-10-10; MMA, MLB and WNBA have no live closes or CLV | `docs/odds-api-incident-2026-10/INCIDENT.md:3-13` | The postseasons and UFC 333 will log nothing |
| 24 | Medium | NFL/CFB/MLB | Outcome range off-centre (NFL up to 3.1 pt; CFB −1.0; MLB +0.64 runs) | per section §6 | Range contradicts the projection |
| 25 | Medium | NFL/CFB/WNBA/CBB | Win prob from a different distribution than spread/cover pricing (≤4.5 / 4.2 / 3.4 / 1.6 pp) | per section §6 | Internally inconsistent cards |
| 26 | Medium | NFL | No travel or time-zone terms; rest double-counted; one wrong-sign flag | `params.js` `w_ctx` | Unmodelled West→East early games |
| 27 | Medium | CFB | Train/serve skew in prior weights; schedule-stress ÷100 twice; regime curve priced below its own promotion bar | `train_p4.py:658` vs `engine.js:681-683`; `engine.js:2654-2657` | 41/337 games moved 1.6 pts for no football reason |
| 28 | Medium | MLB | Handedness splits always discarded; card names a favourite projected to score fewer runs (7.7%) | `app.html:14989` vs `15064`; `:15159-15162` | Contradictory card text |
| 29 | Medium | Tennis | Two probability paths for one matchup (board vs Lab, up to 13 pp); serve/return null at serve time | `price_board.js:70-97` vs `tennis_lab.js:689-711` | Contradictory numbers if re-enabled |

## Proposed disagreement thresholds (model vs close)

| Sport | Watch | Flag ("Model disagrees with market by X") | Treat as data/model fault | Basis |
|---|---|---|---|---|
| NFL | 2.0 pts | **3.0 pts** | 7 pts | 3 is the largest key number (~8–9 pp of cover). A sound model sits 1.0–1.5 from the close on average |
| CFB | 6 pts | **8 pts** (10 if either team has ≤3 games; 7 at 6+) | 14 pts; FBS-vs-FCS suppressed | p90 of the 2026 gap; ≥14 historically MAE 20.6 vs 13.1 |
| MLB | 5 pp | **8 pp** of win prob after shrinking the engine; totals 1.25 runs | 15 pp / 2.0 runs | Two equal-skill models differ by SD 4 pp, p90 6.9 |
| WNBA | 2 pts | **4 pts** (research only until closes exist) | 8 pts | No closes owned; model-vs-Elo spread |
| CBB | 2.5 pts | **4 pts** ("CHECK THE NUMBER") | 8 pts (suppress) | DraftKings open→close p95 < 3 pts; >5-pt gaps carry no information |
| UFC | 5 pp | **8 pp** | 15 pp | No model; applies once one exists, re-derive at 300 bouts |
| Tennis | 5 pp | **8 pp** | 15 pp | Model already strays ~7 pp from plain Elo |

## Measured vs logged

| Sport | Close captured | Results settled | CLV computed | Backtest vs close |
|---|---|---|---|---|
| NFL | nflverse consensus, 77/77, no book or timestamp. **Week 1 never recorded** | Yes (77/77) | Points CLV from EdgeDesk openers since 2026-09-16 (mean +0.50, n = 75); no price CLV | Yes: 2016–25, model 10.20 vs close 9.78 |
| CFB | DraftKings via ESPN, 410/410; single book | Yes, ESPN + cfbfastR must agree | Entry CLV on 61% (+0.34 pts) | Yes: cfbfastR archive; model loses by ~0.8 MAE; α = 0 |
| MLB | Not for the model. Signals only, DB-only; capture paused | Model never graded | No | No (outcome-only, on a different model) |
| WNBA | **None** (not in the capture allowlist) | 2 games graded | No | No |
| CBB | None committed; capture excludes `basketball_ncaab` | Outcome-only | No | No |
| UFC | None committed; capture paused | n/a (no model) | No | No |
| Tennis | Not owned; CLV NULL bug | Walkovers wrongly settled | Always NULL | No |

## What happened next (this branch)

**NFL Phase 1** is built in `model_loop/` (the shared framework and an NFL adapter) and backtested walk-forward. See [`nfl/BACKTEST.md`](nfl/BACKTEST.md).

| 2011–2025, 4,096 games | Margin MAE | Log loss | Mean \|model − close\| |
|---|---|---|---|
| v2 | **10.21** | **0.622** | **2.12** |
| v1 as trained | 10.35 | 0.632 | 2.42 |
| v1 as shipped | 10.55 | 0.647 | 3.45 |
| Close | 10.01 | 0.608 | — |

- **Full backtest.** Both improvements over v1-as-trained are significant: MAE −0.135 [−0.217, −0.050]; log loss −0.0094 [−0.0145, −0.0044].
- **2025 holdout.** v2 beats v1 as shipped on everything. Against v1 as trained, it is better on MAE (10.06 vs 10.17) and 0.003 worse on log loss (CI spans zero).
- **Decision.** The preregistered rule required beating both versions of v1 on both metrics. **v2 is therefore not promoted**, and v1 stays on the card.
- **Card fixes.** v2's cards reconcile exactly to the fair line, centre their ranges, flag 3+ point disagreements with their drivers, and price contested starters both ways.

**Not touched:**
- other sports' code;
- the live cards;
- the frozen CLV ranking protocol.

Phase 2 (the weekly loop) and the rollout to other sports wait for sign-off.

---

## NFL

**Live engine:** `edgedesk_football_v1.0.0` (`football/engine.js` + generated `football/params.js`, trained by `football/research/train_nfl.py`), run inside the app.html football module (`fbLoadNfl`, `app.html:50603`) and headlessly by `tools/football/build_nfl_slate.js` → `football/nfl/slate.json` → `football/game_research/current.json` (the published card) and `football/linemaker/fair_lines.json`.

**Method.** Every number below was reproduced in Node from committed inputs: `football/engine.js`, `football/params.js`, `football/nfl/stats_team_week_2026.csv` and nflverse `games.csv`. The replay mirrors `fbLoadNfl` exactly. It matches the published pick to the hundredth on 71 of 100 recorded games, including all three games decomposed in §5. The other 29 differ only where the board re-ran a reconciled starting QB (`build_nfl_slate.js` starter check). Scripts: `docs/model-loop/audit_scripts/`.

### 1. Inventory

| Layer | What | Status |
|---|---|---|
| Engine | `football/engine.js` (`nfl.absorbGame`, `nfl.gameFeatures`, `nfl.predict`, `dist.*`), `football/params.js` | LIVE |
| Training | `football/research/{fetch_nfl_data.sh,build_features.py,train_nfl.py,make_params.py}` (hyperparameters tuned ≤2015; final ridge fit on all of 2003–2025) | offline, last run 2026-08-21 |
| Browser module | `app.html` `fbLoadNfl` (absorb loop), `fbNflGameReq`, `fbNflReconcileStarters`, `fbNflRegimeFor`, `fbNflDrivers` (card rows) | LIVE |
| Slate build | `tools/football/build_nfl_slate.js` → `football/nfl/slate.json` | LIVE |
| Card | `tools/football/build_game_research.js` → `football/game_research/current.json`; `lib/edgedesk_fairline.js` → `football/linemaker/fair_lines.json` (adds a "calibrated" centre) | LIVE |
| Record | `tools/record/football_record.js` → `record/football/nfl_2026.json`, `record/football/summary.json`, quote ledger `record/football/quotes/` | LIVE |
| Validation | `tools/football/validate_pricing.js` → `football/validation/pricing_nfl.json`; `football/health/daily_check.js` → `football/health.json` | LIVE (report-only) |
| Shadow / display-only | `football/nfl/regime_nfl.js` (`promoted:false`), `football/nfl/coaching_staff.js` (`affects_projection:false`), `football/personnel/` (`points_applied:false`), `football/research/nfl_regime.py` | SHADOW |
| Workflows (cron, UTC) | `football-weekly-build.yml` (`40 9 * 8-12,1 *`, `20 */2 * 8-12,1 *`), `football-model-record.yml` (`47 * * 8-12,1 *`), `model-health.yml` (`30 9 * * *`), `linemaker-build.yml` (`23 */3 * * *`), `linemaker-calibrate.yml` (`17 9 * * 2`), `learning-loop.yml` (`35 9 * * *`, runs `validate_pricing.js`), `injury-sync.yml` (`15 */6 * * *`), `starter-context.yml`, `roster-sync.yml` (`0 10 * * 1`), `nfl-market-structure.yml` | LIVE |
| Supabase | `public.games`, `signals`, `book_quote_ticks`, `nfl_line_snapshots` + pg_cron `nfl_line_snapshot` (`*/15 16-23 * * 4`) and backstop (`supabase/nfl_market_structure_cron.sql`), `capture_*` crons (`supabase/capture_cron.sql`), edge functions `capture`, `close`, `ingest_nfl_features`, `research_cron`; research registry `research_models` / `research_model_versions` / `research_model_results` (DDL not in repo; introspected by `supabase/nfl_market_structure_studies.sql`) | LIVE |

### 2. Priors and how fast they decay

`nfl.seasonBreak` multiplies every carried rating by `carry = 0.8` (`engine.js:382-388`; `params.js` `hyperparams.carry`). In season, each feature is an EWMA toward the opponent-adjusted game value: `α = 0.10` for EPA/explosive/sack features and `α_pts = 0.06` for points (`engine.js:444-445`). The weight still on last season's (already ×0.8) rating after *n* games is `(1-α)^n`:

| Games played | EPA features | Points features | **Defensive features (live)** |
|---|---|---|---|
| 1 | 0.90 | 0.94 | **1.00** |
| 4 | 0.66 | 0.78 | **1.00** |
| 6 (KC/SEA today) | 0.53 | 0.69 | **1.00** |
| 8 | 0.43 | 0.61 | **1.00** |

**Critical defect: defensive ratings never update in season.** Training builds each team's defensive features by mirroring the opponent's offensive row (`football/research/build_features.py:74-80`). The live path builds the absorb row with `nfl.teamGameFromStw` (`engine.js:411-427`), which returns **offensive fields only**. `absorbGame` skips any feature it isn't given (`engine.js:439`), so these six ratings stay at 0.8 × their end-of-2025 value all season: `def_epa_play`, `def_pass_epa_db`, `def_rush_epa_att`, `def_expl_pass`, `def_expl_rush`, `sack_rate_made`. They also feed the spread (`net_epa`, `net_pass`, `net_rush`) and the total (`def_epa_sum`, `pass_matchup`, `rush_matchup`, `expl_sum`, `sack_env`). The same path is used by:
- the browser board (`app.html:50688`);
- the slate build;
- the daily health check (`football/health/daily_check.js:267`);
- the JS "shipped engine" validation replay (`tools/football/validate_pricing.js:139`).

That last one replays cold from 2006, so its defenses sit at **zero** for the whole replay. The 2016–2025 numbers it publishes (raw spread MAE 10.38, the QB-layer "no difference" verdict, the LEAN tier) therefore measure a different model from the one `train_nfl.py` validated (MAE 10.20).

The QB layer is also frozen. `fbLoadNfl` absorbs no QB starts (`app.html:50690-50694`), so `qb_adj_diff` uses end-of-2025 QB values for the whole season.

Hyperparameters were chosen on 2003–2015 from a 3×3 grid. `carry = 0.8` is the top of the grid (`train_nfl.py:297-299`). They were not refit when the coefficients were refit on 2003–2025.

### 3. Personnel and roster changes

- **QB:** the only priced personnel input.
  - The starter comes from nflverse `games.csv`, reconciled with depth charts and the injury report (`build_nfl_slate.js` starter check; `fbNflReconcileStarters`).
  - Value is `qb_adj_diff = (qbEff(starter) − teamQb)_home − (…)_away` × 5.70 points per EPA/dropback.
  - `qbEff` is a shrunk EWMA of the QB's EPA/dropback **as of the end of 2025**; a QB with no history gets `qb_prior = −0.04`.
  - Because no starts are absorbed, a mid-season QB change moves the line by `5.70 × (prior gap)`, typically 0.2–0.5 pt. The board's own "home_qb_out" scenario for KC@SEA moves the line 0.28 pt.
- **Non-QB (RB/WR/OL/defense):** not priced. `football/personnel/` measures availability and freezes it beside the projection with `points_applied: false`. The NFL regime layer computes `adjustment_pts` (SEA −0.73 for its QB change) but `promoted: false`. Coaching: `affects_projection: false`.
- **Offseason moves:** team priors are team-level EWMAs × 0.8 with no player attribution. Kenneth Walker III is on KC's 2026 roster (`football/props/nfl/players.json`, `team: "KC"`) and his 2025 production sits in **SEA's** carried rush-offense rating.

### 4. Home field, rest, travel, environment

The fair margin is the sum of **two** ridge models: spread (`w_spread`, intercept 2.48) plus context (`w_ctx`, fit on the spread model's residual with λ = 200, intercept 0.595) (`engine.js:548-552`; `train_nfl.py:520-521`). The effective home term is:

`2.48 + 0.595 + 0.614·(week/18) − 1.092·[grass] − 0.867·[dome or closed]`

| Venue type | Week 1 | Week 7 | Week 18 |
|---|---|---|---|
| Outdoor turf (SEA) | 3.11 | **3.31** | 3.69 |
| Outdoor grass | 2.02 | 2.22 | 2.60 |
| Dome | 2.24 | 2.44 | 2.82 |

Both intercepts are fitted pooled over 2003–2025 with no era weighting. For comparison:

| Seasons | Mean home margin | Mean home closing spread |
|---|---|---|
| 2003–2015 | 2.58 | 2.51 |
| 2021–2025 | 2.06 | **1.63** |
| 2026 to date | 0.69 | 1.78 |

The `grass` (−1.09) and `dome` (−0.87) coefficients are home-team-identity proxies, not field effects.

**Rest** enters twice: `rest_diff` in the spread model (1.369 per 7 days) and again in the context model (0.094), plus four short-week/bye flags. One flag has the wrong sign: `away_short` −0.421 means an away team on a short week *helps* the away side.

**Travel distance and time zones** are not modeled at all (`research/environment/travel-circadian` is a research page only). **Weather** enters the total only, never the spread.

### 5. The three largest 2026 disagreements with the close, decomposed

From `record/football/nfl_2026.json` (77 graded games). The pick is the last pregame number. Every term is weight × feature value: S = spread model, C = context model.

For each game, the rating-driven points are split between the 2025 carryover prior and 2026 data. The split is exact because ratings are affine in the seeds: replay once with the seeds zeroed and take the difference.

#### 5a. 2026 Week 3, KC @ MIA — model MIA +1.5, close MIA +10, **gap 8.5**, final KC by 14

| Term | Value | Weight | Points (MIA) |
|---|---|---|---|
| S baseline (home field) | — | 2.4807 | +2.48 |
| S net_pts | 2.307 | 0.1678 | +0.39 |
| S net_epa | −0.139 | 10.0999 | −1.41 |
| S net_pass | −0.122 | 12.4996 | −1.53 |
| S net_rush | −0.176 | 7.0453 | −1.24 |
| S qb_adj_diff (Willis vs Mahomes) | 0.033 | 5.6967 | +0.19 |
| C baseline | — | 0.5950 | +0.59 |
| C week_frac | 0.167 | 0.6144 | +0.10 |
| C grass | 1 | −1.0923 | −1.09 |
| **Fair margin** | | | **−1.51** |
| Shown on card (S terms only) | | | −1.12 |
| **Unattributed on card** | | | **−0.39** |

- Rating points −3.79 = 2026 data −1.34 + **2025 prior −2.45**.
- KC's 2025 defense carried 0.0 net and could not register.
- The model never saw Miami's QB downgrade (Willis): the QB layer moved only 0.19 pt.
- Market −10 vs model −1.5: the model was 8.5 short on KC, and KC won by 14.

#### 5b. 2026 Week 4, NYJ @ CHI — model CHI −11.8, close CHI −3.5, **gap 8.3**, final CHI by 11

| Term | Value | Weight | Points (CHI) |
|---|---|---|---|
| S baseline | — | 2.4807 | +2.48 |
| S net_pts | 2.192 | 0.1678 | +0.37 |
| S net_epa | 0.280 | 10.0999 | +2.83 |
| S net_pass | 0.440 | 12.4996 | **+5.50** |
| S net_rush | 0.140 | 7.0453 | +0.99 |
| S qb_adj_diff (Keenum vs Smith) | 0.042 | 5.6967 | +0.24 |
| S rest_diff | −0.143 | 1.3686 | −0.20 |
| C baseline | — | 0.5950 | +0.59 |
| C week_frac | 0.222 | 0.6144 | +0.14 |
| C grass | 1 | −1.0923 | −1.09 |
| **Fair margin** | | | **11.83** |
| Unattributed on card | | | −0.37 |

- Rating points 9.68 = 2026 data **0.82** + 2025 prior **8.87**: 92% of the strength edge was last season.
- By unit, the largest single input is **NYJ pass defense, +2.75**. It comes entirely from 2025 (frozen-defense defect).
- CHI won by 11. The direction was right, but the size of the disagreement was manufactured by stale priors.

#### 5c. 2026 Week 3, NYJ @ DET — model DET −15.2, close DET −7, **gap 8.2**, final DET by 7

| Term | Value | Weight | Points (DET) |
|---|---|---|---|
| S baseline | — | 2.4807 | +2.48 |
| S net_pts | 7.911 | 0.1678 | +1.33 |
| S net_epa | 0.315 | 10.0999 | +3.18 |
| S net_pass | 0.558 | 12.4996 | **+6.98** |
| S net_rush | 0.013 | 7.0453 | +0.09 |
| S qb_adj_diff | 0.122 | 5.6967 | +0.69 |
| S rest_diff | 0.429 | 1.3686 | +0.59 |
| C baseline | — | 0.5950 | +0.59 |
| C week_frac | 0.167 | 0.6144 | +0.10 |
| C dome | 1 | −0.8668 | −0.87 |
| **Fair margin** | | | **15.22** |
| Unattributed on card | | | −0.13 |

- Rating points 11.58 = 2026 data **1.19** + 2025 prior **10.39** (90% prior).
- NYJ pass defense +2.75 (entirely 2025 data).
- The close landed exactly on the result.

#### 5d. The motivating case: 2026 Week 7, KC @ SEA — model SEA −6.72 (73.5%), reference SEA −2.5

Upcoming game, priced with the reconciled starter (Darnold).

| Term | Value | Weight | Points (SEA) |
|---|---|---|---|
| S baseline (card: "Home field") | — | 2.4807 | +2.48 |
| S net_pts | 3.254 | 0.1678 | +0.55 |
| S net_epa | 0.044 | 10.0999 | +0.44 |
| S net_pass | 0.187 | 12.4996 | +2.34 |
| S net_rush | −0.142 | 7.0453 | −1.00 |
| S qb_adj_diff | 0.080 | 5.6967 | +0.45 |
| S rest_diff (10 vs 7 days) | 0.429 | 1.3686 | +0.59 |
| C baseline | — | 0.5950 | +0.59 |
| C rest_diff | 0.429 | 0.0939 | +0.04 |
| C week_frac | 0.389 | 0.6144 | +0.24 |
| **Fair margin** | | | **6.72** |
| Card rows, signed (`football/game_research/current.json` `drivers.rows`, `reconciles: false`) | | | 5.85 |
| **Unattributed on the published card** | | | **0.87** |

By unit, full model vs 2026 data alone:

| Unit | Full model | 2026 data alone |
|---|---|---|
| SEA pass D | **+2.39** | **0.00** (frozen 2025 rating) |
| SEA EPA/play D | +1.43 | 0.00 |
| SEA pass O | +0.44 | −0.30 |
| KC pass O | −0.09 | −0.64 |
| SEA rush O | −0.59 | −0.49 |
| KC rush O | −0.57 | −0.44 |

- Rating points 2.33 = 2026 data **−2.81** + 2025 prior **+5.14**. On 2026 evidence alone the strength terms favour KC.
- **Home field is really 3.31, not the 2.48 shown.** The second intercept (+0.59) and the week-of-season term (+0.24) are what the card leaves out.
- On your "~2.7 pts unattributed": I measure **0.87** on the committed card, so I could not reproduce 2.7 from these artifacts. If you saw it on a different surface, tell me which and I'll trace it.
- **Pass D is weighted the same as pass O by construction.** `net_pass = (O_h − D_h) − (O_a − D_a)` carries one coefficient, so a point of pass-defense EPA counts exactly as much as a point of pass-offense EPA. Defense EPA is far less stable year to year.

### 6. Card consistency (all 23 games on the current slate)

| Check | Result |
|---|---|
| Components sum to fair line | **No.** The slate and research card list spread-model terms only. Unattributed: up to **1.12 pt** (2026_07_LA_LV), 0.87 on KC@SEA. The in-app driver panel (`fbNflDrivers`, `app.html:63475`) merges both models but caps at 9 rows, so terms can still drop. |
| Outcome range centred | **No.** p10/p90 come from `margin_pmf_by_spread`, which is right-skewed for home favourites. The 80% band's midpoint sits up to **3.09 pt** from the projection (2026_08_TEN_CIN: −3 to 30 around 10.41). KC@SEA: −8 to 26 around 6.72 (14.7 below, 19.3 above). |
| Win prob vs fair ML | Agree to 0.001 (fair ML is a restatement of the normal win prob). |
| Win prob vs the distribution that prices spreads | **No.** Win prob uses Normal(fair/10.7); cover/EV use the key-number PMF. They disagree by up to **4.5 pp** (MIA@NYJ: 40.6% vs 45.1%). |
| "Calibrated" centre | `fair_lines.json` publishes a second, calibrated centre (KC@SEA **7.47**) that pushes further from the market. |

### 7. Measured vs logged

| Item | State |
|---|---|
| Closing line | nflverse consensus `spread_line` (no book, no timestamp) → `record/football/nfl_2026.json` `close`. 77/77 finished games have a close. Book-level closes exist only for captured signals (`close` edge function). |
| Results | 77/77 settled (nflverse). **Week 1 (16 games) was never recorded**: the record starts at week 2. |
| Opener / CLV | EdgeDesk's own opener capture starts 2026-09-16 (`football/pricing/openers_nfl.json`, 102 games). No historical openers, so **no historical CLV backtest is possible**. 2026 CLV in points (entry → close): mean **+0.50**, 35 positive / 14 negative / 26 flat (n = 75). Price CLV is not computed for model picks; no entry price was locked before 2026-10-03. |
| 2026 accuracy (n = 77) | Model MAE vs result **9.14**, close **8.90**. Mean \|model − close\| **2.87**. ATS vs close 38-34-5 (≥3 pt gaps: 20-12-2). Brier 0.2384 vs close no-vig 0.2376. |
| Backtest | Python walk-forward 2016–2025: model MAE 10.20 vs close 9.78, Brier 0.2232 vs 0.2106, no ATS threshold p < 0.05 (`params.js validation_summary`). JS replay of the shipped path: MAE 10.38 (defenses at zero). |
| Reproduced baselines (2016–2025 REG, same 2,639 games; `model_loop/adapters/nfl/baselines/`) | as trained (python walk-forward) **10.231**; as shipped (JS, defense frozen) **10.394**; as shipped with the defensive mirror fixed **10.225**; close **9.788**. The defect alone costs ~0.17 pt of MAE over a full replay. |
| Validation replay drops games | `tools/football/validate_pricing.js` joins team-week rows on the raw `games.csv` code. Team-week files use LA/LAC/LV for every season, while `games.csv` uses STL/SD/OAK, so **542 games from 2006–2019 are never absorbed** (`pricing_nfl.json` `without_team_week_rows: 542`). Reproduced exactly. |
| Calibration | `fair_lines.json` reports moneyline mean probability off the observed rate by 0.034 (limit 0.02, PROVISIONAL). |

Fixing only the defensive-mirror defect on the 2026 replay:
- mean |model − close|: 2.91 → **2.59**
- games ≥3 pt from close: 35 → **27**
- MAE vs result: 9.06 → 9.16 (n = 77, noise-level)

So the defect is real and material to the gaps, but it is not the whole story.

### 8. Proposed disagreement threshold

**NFL: 3.0 points** vs the close (flag), 2.0 (watch).
- A model that tracks the market well sits ~1.0–1.5 pt from the close on average; the current model sits at 2.87, and 9 of 21 games on today's slate are 3+ off.
- 3 points is the largest key number. A 3-point disagreement crosses a key and is worth roughly 8–9 pp of cover probability at the spread.

### 9. Data availability

| Status | Inputs |
|---|---|
| Owned / ingestible | nflverse pbp (EPA, WP, passer/rusher/receiver ids; 1999–2026), `games.csv` (closes, ML, rest, roof, surface, QB ids, stadium), weekly rosters with draft data, snap counts (2012+), injury reports (2009+), EdgeDesk's opener capture (2026 only), verified current-stadium coordinates (`football/venues/nfl_stadiums.json`; historical stadiums need a metro table) |
| Not owned (features stay inactive) | Preseason win totals, historical openers or book-level closes before 2026, PFF-style OL grades, player tracking |

### Problems

| Severity | Problem | Evidence | Impact |
|---|---|---|---|
| Critical | Defensive ratings never update in season (absorb row lacks `def_*`) | `engine.js:411-427,439`; `app.html:50688`; `build_features.py:74-80` | All 2026 defensive inputs are 0.8 × 2025. SEA pass D +2.39 pt on KC@SEA, NYJ pass D +2.75 pt on two top-3 misses. Also corrupts every JS validation replay. |
| Critical | Priors dominate mid-season | carry 0.8, α 0.10/0.06; replay split | 88–92% of the strength edge in the top misses came from 2025; KC@SEA: prior +5.14 vs 2026 −2.81 |
| High | Pass D weighted equal to pass O | single `net_pass` coefficient, `engine.js:480` | Unstable defensive EPA moves the line as much as offensive EPA |
| High | Home field ~3.3 on outdoor turf (two intercepts + week term), pooled 2003–2025 | `w_spread[7]`, `w_ctx[9]`, `w_ctx[6]` | ~1.5 pt too much home edge vs the 2021–25 market (1.63) |
| High | Card components don't reconcile (context model omitted) | `slate.json contributions`; `game_research drivers.reconciles:false` | 0.1–1.1 pt unattributed per game; "Home field" row understates home edge |
| High | QB layer frozen; no player-level priors | `app.html:50690`; no RB/WR/OL terms | QB changes move ≤0.5 pt; offseason moves (Walker SEA→KC) invisible |
| High | The JS "shipped engine" validation measures a different model: defenses at zero, 542 games never absorbed (team-code mismatch) | `validate_pricing.js:116,139`; `pricing_nfl.json` `without_team_week_rows: 542` | Every tier, the QB-layer verdict and the LEAN label in `pricing_nfl.json` rest on a broken replay |
| Medium | 80% range off-centre | `dist.marginQuantiles` on skewed `margin_pmf_by_spread` | Midpoint up to 3.1 pt from the projection |
| Medium | Win prob and cover prob from different distributions | `dist.winProb` (normal) vs `coverProbSpread` (PMF) | Up to 4.5 pp internal disagreement |
| Medium | No travel/time-zone terms; rest double-counted, one wrong-sign flag | `w_ctx` | Unmodelled West→East early games; noise terms |
| Medium | Week 1 never recorded; close is a consensus with no timestamp; CLV only from 2026-09-16 | `record/football/nfl_2026.json` | Evaluation blind spots |
| Low | `fair_lines.json` "calibrated" centre pushes away from market (7.47 on KC@SEA) | `fair_lines.json` | Second, inconsistent number in circulation |

---

## CFB

Audited at repo HEAD `beb1ed28` (2026-10-20). I had no database credentials, so this audit works from code, DDL, workflows and committed artifacts.

**Method.** I re-ran the shipped engine (`football/cfb_p4/engine.js`) headlessly on committed inputs plus the public cfbfastR 2026 schedule.
- **Current slate.** The current production configuration reproduces all 62 games of the committed `football/fbs/slate.json` to within **0.007 pts**.
- **Historical picks.** An emulation of v1.0.0 (home field 4.082 projected and 3.2 learned, independents treated as a conference, no efficiency feed) reproduces the published week-2 and week-3 picks **exactly**:
  - UConn −8.40 (reconstructed 8.404)
  - Virginia Tech −0.51 (reconstructed 0.514)
  - Sacramento State +8.39 (reconstructed −8.392, P(home) 0.2886 = recorded 0.2886)
- **Scripts.** The scripts are in `docs/model-loop/audit_scripts/cfb/` (`recon.js`, `prior_decay.js`, `consistency.js`, `season_replay.js`, `season_replay2.js`).

---

### 1. Inventory: what produces the card, and what is live, shadow or dead

**The number on the live CFB card is V1: `football/cfb_p4/engine.js` → `EDCfbP4.projectGame`, model_version `edgedesk_cfb_p4_v1.0.1`.** It was v1.0.0 until the one-home-field file was promoted on 2026-10-19.

How the card gets it:
- **In the browser.** The engine is computed by replaying the trained seeds plus the 2026 cfbfastR schedule.
  - Load chain: `app.html:51986-52060`. `home_field.js` loads at :51994 and `regime_curve.js` at :51999; both gate the board.
  - Call sites include `app.html:52917`, `53867` and `58908`.
- **Offline, the same request.** `football/fbs/build_coverage.js:210-284` (buildState/project) writes `football/fbs/slate.json`.
  - The record grades that file (`record/football/cfb_2026.json` → `"projection_source": "football/fbs/slate.json"`).
  - The linemaker prices from it (`tools/football/build_fair_lines.js:20,42`).

What each card number is:

| Card element | Formula | Where |
|---|---|---|
| fair line | `model.fair_spread`, the plain sum of 10 contributions | `engine.js:2685-2686` |
| win prob | Φ(fair/σ) | `engine.js:2901` |
| fair ML | decToAm(1/p) | `engine.js:2938` |
| outcome range | p10/median/p90 from `marginDistribution` | `engine.js:2902, 2950` |
| drivers | top-5 contributions with \|pts\| > 0.05 | `fbGxDrivers` (`app.html:55799`) → `explain()` (`engine.js:3104-3112`) |
| pricing inputs | the contributions by term | `fbGxPricingInputs` (`app.html:55236`) → `lib/edgedesk_canon.js:690-735` |
| outcome range text | p10 · median · p90 | `app.html:57846` |

The margin calibrator and the live calibrator are computed but **not** applied:
- `engine.js:2877` and `:2894` apply them only if promoted.
- `margin_calibration.js`: `promoted:false`.
- `live_calibration_config.json`: `"promote": false`.

**V2.1 (`football/cfb_v2/engine.js`) is SHADOW on the card.** It is shown only with `?cfbv2=1` or a localStorage flag (`app.html:51927-51930`), and as the `v2_shadow` field in the slate.

But V2.1 is the level-1/2 model of the "canonical production" report:
- `football/cfb_production/reports/projections.json` has `model_version: edgedesk_cfb_v2.1.0`, with V1 only as "FALLBACK_MODEL" level 3.
- The governed `official_decision` (cfb_decision_policy_v1) is computed on V2.1.
- **So the card's number and the governed decision come from different engines.**

The old V1 CFB layer in `football/engine.js` is **dead for pricing**:
- Its card function `fbGameCardCfb` (`app.html:51814`) has no caller.
- It survives only in the smoke check `football/research/live_check.js:116`.

**Code files.**

| Path | Role | Status |
|---|---|---|
| `football/cfb_p4/engine.js` | V1 five-layer engine: rating, HFA, matchup, conference, schedule, QB/injury, travel/altitude/rivalry stubs | **LIVE** (prices the card) |
| `football/cfb_p4/params.js` | trained parameters (trained through 2025, built 2026-08-22) | **LIVE** (its seeds are replaced by `home_field.js`) |
| `football/cfb_p4/home_field.js` | one home field of 2.8, with seeds rebuilt under it | **LIVE** since 2026-10-19 (`promoted:true`) |
| `football/cfb_p4/regime_curve.js` + `football/coaching/{build_regime.js,regime_signal.js,regime.json,continuity.json,returning_production_2026.json}` | coach/turnover prior-weight cut for 30 flagged teams | **LIVE** (moves numbers; regime.json dated 2026-09-30) |
| `football/cfb_p4/regime_magnitude.js` | continuous turnover magnitude (v2) | SHADOW (CANDIDATE, `promoted:false`) |
| `football/cfb_p4/margin_calibration.js`, `live_calibration.js` + `_config.json` | calibrated margins | SHADOW (published beside, not priced) |
| `football/cfb_p4/calibration.js`, `v12_correction.js` | v1.1/v1.2 experiment records | display only |
| `football/cfb_p4/disagreement_params.js`, `lib/cfb_disagreement.js` | INVESTIGATE / VERIFIED MAJOR labels | LIVE labels, no price |
| `football/fbs/{fbs.js,build_coverage.js}` | FBS universe and slate builder | **LIVE** |
| `football/matchup/{contract.js,inputs.js}` | request assembly (`PRICED_STARTER_STATUSES = []` at `inputs.js:84`) | **LIVE** |
| `football/rankings/engine_efficiency.json` (+ `.js`) | play-level efficiency for the matchup term | **LIVE** input |
| `football/rating/current.json` (ETSR) | "canonical" rating (`calibration.measured:false`) | SHADOW_RESEARCH (`app.html:58062-58097`) |
| `football/fbs_epa/*`, `football/starters/*` | QB EPA and starter identity | research, 0 pts |
| `football/availability/*` | injury reports (only a QB absence could price) | live input, 0 pts in practice |
| `football/altitude/*` | altitude/travel residual | SHADOW (0 pts behind a flag) |
| `football/personnel/*`, `football/players/*` | non-QB availability and player quality | research (0 pts) |
| `lib/edgedesk_canon.js`, `lib/cfb_research_view.js`, `lib/cfb_reliability.js`, `lib/edgedesk_explainer.js`, `football/matchup/confidence.js` | card text, labels, reliability, gap explainer | display |
| `tools/record/football_record*.js`, `price_lock.js`, `quote_ledger.js` | close / settle / grade / CLV ledger | **LIVE measurement** |
| `football/cfb_lab/*` | Model Lab (checkpoints T72…T2, results, evaluations) | **LIVE measurement** |
| `football/cfb_v2/*`, `football/cfb_weekly/sync_supabase.js` | V2.1 engine and weekly freeze | SHADOW |
| `football/cfb_production/*` | canonical V2 report, manifest, health, gate | production plumbing for the SHADOW engine |
| `football/cfb_decision/*`, `football/cfb_ev/*`, `football/cfb_market/*` | decision policy (BET disabled), EV calibration, market intel | SHADOW |
| `football/cfb_terminal/*` | research terminal (champion = V1) | LIVE page |
| `football/cfb_validation/*`, `football/validation/*cfb*` | monitoring and validation artifacts | reports |
| `tools/football/build_fair_lines.js`, `football/linemaker/*` | fair-line sheets from the slate | LIVE downstream |
| `football/engine.js` CFB layer, `football/params.js` cfb | v1 CFB constants | **DEAD** for pricing |
| `supabase/functions/edgedesk_ai/_cfb_explain.js` (inlined as `EDCFBEXPLAIN`, `index.ts:31231`) | CFB AI fact boundary (reads V2 projections.json) | **DEAD**: no reference after its definition |

**Supabase (DDL in repo; I could not verify what is actually deployed).**

| File | Objects | Status |
|---|---|---|
| `supabase/cfb_lab.sql` | tables `cfb_lab_predictions`, `_market_quotes`, `_market_lines`, `_results`, `_evaluations`, `_miss_reviews`, `_reports`, `_research_queue`, `_event_map`, `_experiments`, `_model_roles`, `_audit_log`, `_partitions`; views `cfb_lab_official_predictions`, `_public_record`, `_public_summary`, `_consensus_now`, `_major_disagreements`, `_current_*`; functions `cfb_lab_ingest_quotes`, `cfb_lab_derive_lines`, `cfb_lab_median*`, guards | LIVE measurement |
| `supabase/cfb_lab_cron.sql` | pg_cron **`cfb_lab_hourly` `'7 * * * *'`** → `cfb_lab_poke('hourly')`, which dispatches `cfb-lab.yml` via pg_net (`:6, :168-169`) | LIVE (primary clock) |
| `supabase/cfb_weekly.sql` | `cfb_team_week_state`, `cfb_weekly_projections`, `cfb_qb_week_state`, `cfb_pipeline_runs`, …; pg_cron **`cfb_weekly_sunday` `'5 10 * 8-12,1 0'`, `cfb_weekly_monday` `'5 10 * 8-12,1 1'`, `cfb_weekly_freeze` `'7 12 * 8-12,1 2'`, `cfb_weekly_daily` `'47 10 * 8-12,1 3-6'`** (`:493-496`) | SHADOW (V2) |
| `supabase/cfb_v2_model.sql` | `cfb_predictions`, `cfb_team_ratings`, `cfb_game_feature_snapshots`, `cfb_market_snapshots`, `cfb_model_versions`, … | SHADOW |
| `supabase/cfb_production.sql` | manifest, job registry/locks/heartbeats, incidents, feature flags, `cfb_weekly_projections_published` view | ops for V2 |
| `supabase/cfb_decision.sql`, `cfb_market.sql`, `cfb_market_integrity.sql` | decision snapshots/policies, market consensus, quote quarantine | SHADOW |
| `supabase/cfb_matchup.sql`, `cfb_personnel.sql`, `cfb_altitude.sql` (+ `altitude_shadow_rollback.sql`) | research / shadow layers | SHADOW |
| `supabase/cfb_terminal_analytics.sql` | UI events | n/a |
| `supabase/odds_api_gateway.sql:102` (+ edge function `odds_gateway`) | `americanfootball_ncaaf` live quote capture → `signals` | LIVE market input |
| `cfb.lines` (CFBD consensus; read by the board's market join, `app.html:32170-32845`) | **no DDL in repo** | LIVE reference (untimed) |

The browser V1 path reads **no** Supabase model table. It reads the cfbfastR feeds, committed JSON and market quotes only. The `close` edge function has no CFB logic.

**GitHub Actions (cron).**

| Workflow | Cron | What it does for CFB | Status |
|---|---|---|---|
| `football-weekly-build.yml:76-78` | `40 9 * 8-12,1 *`, `20 */2 * 8-12,1 *`, `40 9 * 2-7 2` | rankings/ETSR, coaching/regime, efficiency, starters, `build_coverage.js` → `slate.json`; also patches app.html | **LIVE** |
| `football-enrichment.yml:26-29` | Sat hourly; Sat night hourly; Fri every 2 h; Sun–Thu every 6 h (Sep–Jan) | enrichment + `build_coverage.js` (republishes the slate) | **LIVE** |
| `football-model-record.yml:27-28` | `47 * * 8-12,1 *`, `47 12 * 2-7 1` | close, settle, grade, CLV → `record/football/cfb_2026.json`, quote ledger | **LIVE measurement** |
| `cfb-lab.yml:33` | `37 * * 8-12,1 *` (backup to pg_cron) | Lab ledger, V2 canonical report, decision shadow, market, terminal | LIVE measurement / SHADOW |
| `cfb-v2-shadow.yml:28-30` | `5 10 * 8-12,1 0,1`, `17 12 * 8-12,1 2`, `47 10 * 8-12,1 3-6` | V2 weekly state and Tuesday freeze | SHADOW |
| `model-health.yml:18` | `30 9 * * *` | daily self-check, line guard (21 pts CFB) | LIVE monitoring |
| `rating-sync.yml:30-32` | `0 9 * * 0`, `0 9 * * 3`, `0 13 * * 6` | ETSR rating | SHADOW_RESEARCH |
| `availability-sync.yml:40-46` | game-day hourly / every 3–6 h | injury/availability reads | live input (0 pts in practice) |
| `linemaker-build.yml:17` | `23 */3 * * *` | fair-line sheets from the slate | LIVE downstream |
| `football-validation.yml:39` | `0 6 1 * *` | QB-EPA fit, feature validation | report |
| `settle-finals.yml:62` | `0 * * * *` | collective grading (not the model record) | adjacent |

Test-only workflows have no cron: `cfb-*-tests.yml`, `cfb-terminal.yml`, `cfb-security.yml`, `cfb-home-field-tests.yml`, `cfb-live-calibration-tests.yml`.

---

### 2. Priors: how they are set and how fast they decay

**What the preseason prior contains.**

The prior for each FBS team is just last season's final rating, regressed:

`r_carried(0) = carry × r_end(2025)`, with `carry = 0.75` (`engine.js:597-599`; `params.rating.hyperparams.carry`).

Since 2026-10-19 the seeds come from `home_field.js` (rebuilt under HFA 2.8).

There is **nothing** in the prior for returning production, recruiting/talent, the transfer portal or coaching.

| Prior input | Status | Evidence |
|---|---|---|
| Recruiting / talent | not in the mean | `params.unavailable_by_design.blue_chip_ratio`; `rankings/talent.js` is research |
| Talent / continuity / portal (roster) | feeds the confidence score only | `sideBundle` `engine.js:2300-2330`; no talent term in `terms` at `:2675-2684`; volatility λ_roster_turnover = 0 |
| Coaching tenure | not in the mean | `params.unavailable_by_design.coaching_continuity` |
| Returning production + coach change + transfers out | only as a binary regime flag (30 teams in 2026), see below | `football/coaching/regime.json` (`counts.regime_change = 30`), built 2026-09-30 (week 4) |

**Two exceptions.**

- **Regime flag** (`engine.js:144-166`, `regime_curve.js`).
  - The flag fires when a team has a new head coach AND (low returning share or production, OR ≥ p75 transfers out). In 2026 that is 30 teams.
  - For those teams the weight on the carried track is capped at `min(w_std, 0.75·e^(−0.02g))`.
  - The weight moves onto the this-season track, which starts every team at `init_rating = −12` and sits ~8.6 pts below the carried track's FBS mean (`engine.js:615-633`).
  - So the cut docks a flagged team for a structural reason, not a football one. It also pushes the wrong way for programmes that *improved* through a coach or portal (see the VT example in §5).
  - The data behind the flag (`returning_production_2026.json`, `regime.json`) only exists from **2026-09-30**. Weeks 0–4 of 2026 had no personnel-aware prior at all.
- **New FBS programmes** (2026: North Dakota State, Sacramento State) have no seed. They start at `init_rating −12`. FCS opponents are a single floor of **−28** for every FCS team (`engine.js:587, 612`).

**The conference prior.** The conference term is effectively a prior too:

`0.5002 × (prior-season conference strength_home − _away) × max(0, 1 − g_min/6)`

It applies to cross-conference games only (`engine.js:2660-2672`, `:1231` excludes independents since 2026-09-30).

**Decay formula** (`engine.js:645-703`, `:1808-1818`, `:723-742`).

```
blended_i = w(g_i)·r_carried,i + (1−w(g_i))·r_fresh,i
r_carried ← r_carried + 0.14·(clip(margin,±35) − (r_h − r_a + HFA))     (k = 0.14, cap = 35)
r_fresh starts at −12 and updates with k_fresh = 0.22
w(g): 1.0 for g = 0–3, 0.8 for g = 4–5, 0.6 for g ≥ 6               (params.blend.prior_weight_by_week)
```

The preseason prior's share of the carried track decays as 0.86^g. So the effective weight on the prior is **w(g)·0.86^g**.

I measured this by perturbing each of the 136 seeded teams' preseason rating by +1 and replaying 2026 (`prior_decay.js`):

| Games played | Weight on post-carry prior (measured) | Weight on last season's final rating (×0.75) | Regime-flagged team | Conference prior weight |
|---|---|---|---|---|
| 1 | **0.860** | 0.645 | 0.632 | 0.833 |
| 4 | **0.438** | 0.328 | 0.379 | 0.333 |
| 8 | **0.180** | 0.135 | 0.180 | 0 |

The fresh track gets **zero** weight until a team has played 4 games.

**Fitted or hand-set?** Mostly fitted by coarse grid search, with several warning signs.

- **Grid-edge parameters.** `k`, `cap`, `hfa`, `carry` and `init` were chosen by grid search on 2001–2013 MAE (`research/train_p4.py:304-326`). The chosen values sit at the edge of their grids:

  | Parameter | Chosen | Grid |
  |---|---|---|
  | k | 0.14 | {0.06…0.14} — max |
  | carry | 0.75 | {0.35…0.75} — max |
  | hfa | 3.2 | {2.0…3.2} — max |
  | cap | 35 | {21…35} — max |
  | init | −12 | {−12…−4} — min |

  These are boundary solutions, not interior optima.
- **Blend curve `w(g)`.** It is fitted per games-played bucket on a 0.05 grid over 2014–2019, then forced monotone (`train_p4.py:599-642`). It uses **one weight per game (`gs_min`)** (`train_p4.py:658`). The engine applies a **per-team** weight (`engine.js:681-683`); see Problems.
- **Hand-set.** `k_fresh = 0.22` is never tuned (it sits in the base dict at `train_p4.py:304-307`). The 6-game conference decay is hand-set (`train_layers.py:462`).
- **Walk-forward evidence.** The forensic walk-forward refit (`football/validation/disagreement/forensics_cfb.json` `carryover.walk_forward_refit`) finds the carried-track weight should be:
  - 0.73–0.89 at 3–4 games
  - 0.84–0.96 at 5–7 games
  - 1.0 at 8+ games (shipped 0.6)
  - 0.003–0.090 MAE better in every season 2018–2025.

  **Unlike the NFL case, the problem is not too much prior mid-season.** The prior is a crude, personnel-blind number that gets 100% weight early and decays mechanically.

---

### 3. Personnel and roster changes

- **Quarterback value: NOT priced.**
  - The layer exists: `params.qb.points_per_epa_db = 10.09`, and `engine.js:2642-2648` takes `pts(H.qb.value) − pts(A.qb.value)`.
  - Production passes `teams.<side>.qb = null` because `PRICED_STARTER_STATUSES = []` (`football/matchup/inputs.js:84`). The reason given: the provider's EPA is not on the coefficient's scale (`football/fbs_epa/epa_contract.js`).
  - The QB term is **0 on 62/62 current slate games** and structurally 0 historically (forensics `qb_roster`).
- **Starter identity: resolved, research only.** It is resolved from the last game (PREVIOUS_GAME on 114 sides, COMPETITION on 10) and published as `shadow_home_line`. In the slate, `shadow_delta_vs_model = 0` on every game.
- **QB absence: the only priced QB effect.** It is worth 3.902 × status weight (out 1.0, doubtful 0.75, questionable 0.5; `params.injury`). It needs a *graded* availability read naming the QB.
  - In the current slate availability is `FETCH_FAILED` on 31 of 124 sides and `NOT_DUE_YET` on 93.
  - ESPN depth chart (404) and ESPN participation (403) refuse all 138 programmes.
  - The injury term is **0 on 62/62** games, and its historical replay share is 0 (forensics).
- **Measured cost of ignoring QB changes.** The gap explainer finds the model rates a team with a QB change too high vs the close by **+0.50 to +0.79 pts** (β_qb_change, `football/validation/disagreement_explainer.json`). The prior V2 audit found −1.9 to −3.3 pts bias on first-career starts (`docs/cfb-audit/EXECUTIVE.md` §4).
- **V2 (shadow) QB overlay.** It applies −1.16 pts for an unexpected starter change, and only when a status report exists; otherwise 0 (`football/cfb_v2/params.js` `qb`, `engine.js:127-150`).
- **Transfer portal.**
  - Portal inflow and continuity are measured from athlete_id diffs (talent layer). They feed the confidence score only.
  - Production-weighted portal inflow (`returning_production_2026.json`) is a feature of the unpromoted v2 magnitude.
  - The priced regime flag uses only "transfers out ≥ p75".
- **Non-QB injuries.** Position weights are deliberately untrained, so these are 0 (`personnel/` measures them at 0.0 pts).

---

### 4. Home field, venue, rest, travel, altitude, weather and neutral sites

Each of these is a **separate named contribution** (`engine.js:2675-2684`), not an intercept. There is no intercept in the mean, but there is a hidden one in the outcome distribution (§6).

| Factor | Value used | How estimated | Applied? |
|---|---|---|---|
| **Home field** (to 2026-10-18, v1.0.0) | projection added **4.082**; ratings learned at **3.2** | 4.082 = mean 2001–2013 home residual + 3.2 (`train_p4.py:349-366`) | **Over-applied**: learn and project mismatch (`engine.js:84-101`). 2026 record shows home lean vs close **+1.46 pts** (FBS, n=337); `home_field.js` record shows +1.49 (n=386). Historical model-minus-close +0.93 to +2.47 per season (forensics `hfa`). |
| **Home field** (from 2026-10-19, v1.0.1) | **2.8** (one value for learning and projecting; seeds rebuilt) | grid {2.0…4.082} minimising cold-replay MAE 2022–2025 (`home_field.js`) | Live. 2014–2025 ΔMAE −0.052 [−0.082, −0.021]. On 2026 games ΔMAE **+0.027 [−0.059, +0.091]**, i.e. not better; home lean 1.49 → 0.20. My 2026 replay: the close implies **~2.6** pts (OLS 2.89 − 0.31) and outcomes run +0.45 above the model. |
| Per-venue HFA | — | fitted and rejected (correlation 0.77 with team rating) | `hfa_by_venue` is empty |
| Neutral site | HFA 0, travel 0 | schedule-feed flag | yes (HFA 0 at `engine.js:1055`; travel adds nothing (`engine.js:1101`), and at a neutral site travel counts as fully known in the information score (`:2826`)) |
| Rest / schedule stress | `points_per_stress 0.02266 × Δstress/100` | trainer: mean \|effect\| 1.13 pts, so pps = 1.13/50 per stress point (`train_layers.py:345`) | **Effectively off.** The engine divides by 100 again (`engine.js:2654-2657`) on a 0–100 index (`:1163-1186`), giving ≤0.022 pts (p99 0.013; `disagreement_params.js`). The README's "1.13 points on average" is not what ships. |
| Travel | per 1000 mi 0.68, per TZ 0.69 | walk-forward residual regression | not applied (`points_applied:false`) |
| Altitude | shadow residual | `football/altitude` | 0 pts (flag off) |
| Weather | none | no historical weather series | shown only; moves no point or total |
| Rivalry | `mean_points 0` on 467 pairs | measured, rejected | 0 |
| Volatility (σ) | 14.633–15.684 | MLE kept only `early_season` | missing inputs do **not** widen σ (`engine.js:1320-1336`) |

---

### 5. The three largest 2026 disagreements with the close, decomposed

**Selection.** From `record/football/cfb_2026.json` (410 graded games), the largest \|pick − close\| gaps are FBS-vs-FCS games (32.9, 32.6, 31.7 …), which are priced against a single FCS floor (see the FCS row below). Among FBS-vs-FBS games the top three are:
- Maryland @ UConn: 19.90
- North Dakota State @ Sacramento State: 18.11
- Old Dominion @ Virginia Tech: 16.99

Syracuse @ UConn (14.25, next) is added as a fourth case because its committed slate (`2ea59cf060`) **stores** the components. It checks the reconstruction method against stored values.

**How the components were obtained.** Pre-09-27 slates store no components (verified for `d927ca993a`, `8ffb1bb893` and `03ee940eb0`, fetched from GitHub). I rebuilt the state from 2025 seeds plus every 2026 game completed ≥4 h before the pick's `generated_at`, then ran `projectGame` with v1.0.0 settings (`recon.js`). The sums match the published picks to ±0.01.

Sign convention: + = home favoured (home margin).

**A. Maryland @ UConn** (wk 2, kickoff 2026-09-12). Pick published 2026-09-11 22:25Z, slate `d927ca993a`, v1.0.0.

| Component | Arithmetic | Points |
|---|---|---|
| rating | UConn carried −2.2845 (seed −4.3666×0.75 = −3.2750, +0.14×(35−27.925) after a 56–7 FCS win) − Maryland carried −5.6172 (−9.5337×0.75 = −7.1503, +1.533 after 62–0); w = 1.0 both (1 game) | **+3.333** |
| hfa | league constant (v1.0.0) | **+4.082** |
| conference | 0.5002 × (FBS Independents 15.210 − Big Ten 13.008) × (1 − 1/6) | **+0.918** |
| matchup | no efficiency feed in that build | +0.071 |
| qb, injury, travel, altitude, schedule, rivalry | — | 0 |
| **Sum = fair** | | **+8.404** (published UConn −8.40); residual **0.000** |

| Metric | Value |
|---|---|
| σ | 15.47 |
| P(UConn) | 0.706 |
| fair ML | UConn −241 / Maryland +241 |
| p10/p50/p90 | −15.6 / **+7.4** / +29.4 |
| close | UConn **+11.5** (DraftKings via ESPN) |
| final | 14–38 (−24) |
| gap | **19.9** |
| model error / close error | 32.4 / 12.5 |

**What drove it.**
- The 2025 ratings were carried at 100% weight on the carried track (UConn 9 wins in 2025; Maryland 4–8).
- UConn's regime signals were not in the model on 9/11: new head coach, **returning production 2.3% (2nd percentile)**, 40 transfers out (96th percentile).
- Two later-fixed errors added 2.2 pts: HFA over-applied (+1.28 vs 2.8) and independents read as a conference (+0.92).
- **Counterfactual:** today's engine (HFA 2.8, regime curve, independents excluded, efficiency) gives UConn −4.13, still 15.6 from the close.

**B. North Dakota State @ Sacramento State** (wk 3). Pick 2026-09-19 23:15Z, slate `03ee940eb0`. P(home) reproduced at 0.2886, matching the record.

| Component | Arithmetic | Points |
|---|---|---|
| rating | Sac State carried −13.916 (new FBS, start −12; L 17–28, W 52–0 FCS, L 3–49) − NDSU carried −4.543 (new FBS, start −12; W 33–7, W 38–0 FCS, W 38–32 at Air Force); w = 1.0 both (3 games) | **−9.374** |
| hfa | | **+4.082** |
| conference | 0.5002 × (MAC −16.037 − MWC −3.640) × (1 − 3/6) | **−3.100** |
| matchup and all others | — | 0 |
| **Sum = fair** | | **−8.392** (published Sac St +8.39); residual **0.000** |

| Metric | Value |
|---|---|
| σ | 15.05 |
| P(home) | 0.289 |
| fair ML | +246 / −246 |
| p10/p50/p90 | −31.4 / −9.4 / +12.6 |
| close | Sac St **+26.5** (NDSU ML −5000) |
| final | 10–31 (−21) |
| gap | **18.1** |
| errors (model / close) | 12.6 / 5.5 |

**What drove it.**
- Both programmes moved up from FCS with **no seed**, so both start at the generic −12. NDSU's FCS record carries no information into the prior.
- With k = 0.14, three wins moved NDSU only +7.5.
- HFA was over-applied by ~1.3–1.5. The conference term (+3.1 toward NDSU) went the right way but was too small.
- **Counterfactual today:** −11.33 (gap 15.2).

**C. Old Dominion @ Virginia Tech** (wk 2). Pick 2026-09-11 22:25Z, slate `d927ca993a`.

| Component | Arithmetic | Points |
|---|---|---|
| rating | VT carried −4.672 (seed −8.0677×0.75 = −6.051, +1.379 after 73–3 FCS) − ODU carried +2.783 (seed +6.5279×0.75 = +4.896, −2.113 after a 31–10 FCS win "below expectation"); w = 1.0 | **−7.454** |
| hfa | | **+4.082** |
| conference | 0.5002 × (ACC 0.066 − Sun Belt −10.507) × (1 − 1/6) | **+4.407** |
| matchup | | −0.521 |
| others | — | 0 |
| **Sum = fair** | | **+0.514** (published VT −0.51); residual **0.000** |

| Metric | Value |
|---|---|
| σ | 15.47 |
| P(VT) | 0.513 |
| fair ML | −105 / +105 |
| p10/p50/p90 | −23.5 / **−0.5** / +21.5 (the median favours ODU while the fair line favours VT) |
| close | VT **−17.5** |
| final | 44–21 (+23) |
| gap | **17.0** |
| errors (model / close) | 22.5 / 5.5 |

**What drove it.**
- A personnel-blind prior: VT's 3–9 2025 rating against ODU's strong 2025 rating, carried at 100%.
- VT hired James Franklin (regime override). ODU changed QB and kept only 34th-percentile returning production.
- **The fixes make this game worse.** The current engine gives VT **+1.34 underdog** (gap 18.8): the regime cut (w 0.735) moves VT's weight onto a this-season track centred ~8.6 pts low.

**D. Syracuse @ UConn** (wk 5). Pick 2026-09-30 17:15Z; **components stored** in slate `2ea59cf060` → `disagreement_inputs.projection.components`.

| Component | Stored value / arithmetic | Points |
|---|---|---|
| rating | UConn 0.6923×(−3.0828) + 0.3077×(−8.9341) = −4.8833 (regime-cut w; standard 0.8 at 4 games) − Syracuse 1.0×(−8.7581) (3 games, so 100% carried) | **+3.875** |
| hfa | | +4.082 |
| matchup | | −0.207 |
| schedule | | +0.0014 |
| conference | independents excluded after the 9/30 fix | 0 |
| others | — | 0 |
| **Sum** | 3.8750 + 4.0820 − 0.2069 + 0.0014 = 7.7515 | **= stored fair 7.7515**; residual **0.000** |

| Metric | Value |
|---|---|
| P(UConn) | 0.697 |
| fair ML | ≈ −230 |
| close | UConn **+6.5** |
| final | 41–42 |
| gap | 14.25 |
| errors (model / close) | 8.75 / 5.5 |

**What drove it.**
- UConn's 2025 identity still carried at 69%.
- Syracuse sat at 100% carried weight because it had played one game fewer (per-team weights).
- HFA 4.08.

**FCS example** (largest raw gap class): Montana State @ Nevada (wk 2).

| Component | Value |
|---|---|
| rating | +23.119 (Nevada −4.881 − FCS floor −28.000) |
| hfa | +4.082 |
| **fair** | **+27.20** (Nevada −27.2) |

The close was Montana State −4.5 and the final 7–20. Gap **31.7**, model error 40.2. Every FCS team is priced at −28.

**Bottom line for §5.** None of the four FBS cases has an unattributed residual: the components sum exactly. The failures are **content**:
- personnel-blind or absent priors held at 100% weight early
- an HFA that was 1.3–1.5 pts too high
- a mis-read conference term (since fixed)

---

### 6. Card consistency

Checked on all 62 current-slate games (`consistency.js`; the engine reproduces the slate to ≤0.007 pts).

| Check | Result | Max discrepancy |
|---|---|---|
| Σ contributions vs fair line | exact | 3.6e-15 pts; card drivers omit only schedule terms <0.05 (≤0.022) |
| win prob vs Φ(fair/σ) | exact | 0 |
| fair ML ↔ win prob (no vig) | consistent | 0.0012 (integer ML rounding); overround 0 |
| **Outcome range centred on projection?** | **No** | median − fair = **−1.00 on 62/62**; (p10+p90)/2 − fair = −1.00; distribution mean − fair = **−1.11** |
| Outcome-range width vs win-prob σ | inconsistent | PMF sd 16.48 vs σ 14.63–15.68 |
| P(home > 0) from outcome distribution vs win prob | inconsistent | **−4.19 pp** (UL Monroe @ Troy: 84.6% vs 88.75%, so ML −789 vs ≈ −549); mean −0.64 pp |
| Sign agreement fair vs median | fails near pick'em | Duke @ Virginia: fair UVA +0.55 (shown "UVA −1" by the 1-pt display floor, `engine.js:2486-2510`), median **Duke +0.45** |
| Label vs value | stale | `lib/edgedesk_canon.js:692` prints "league constant, 4.08 pts" while 2.8 is applied |
| Driver text "% inherited from last season" | overstated | uses 0.86^g and ignores w (`engine.js:3282-3289`): at 6 games it says 40%, actual 24% |
| V2 shadow panel drivers vs V2 margin | do **not** sum | mean \|unattributed\| **5.64 pts**, max 14.92 (e.g. Alabama–Texas A&M margin 15.11, drivers sum 3.55) |

**Where the off-centre range comes from.** `margin_resid_pmf` (fitted 2014–2021 on residuals of the old, home-over-applied model) has **mean −1.16, median −1** (params.js `distributions`). `marginDistribution` (`engine.js:500-513`) adds it to the fair line unchanged.

In the 2026 walk-forward replay (FBS-vs-FBS, n=337):
- **57.0% of finals land above the published median** (should be 50%).
- [p10, p90] holds 83.1%, but asymmetrically: 5.6% below, **11.3% above**.

---

### 7. Measured vs logged

**Closing lines.**

| Source | How captured | Coverage | Weakness |
|---|---|---|---|
| Model record (`football-model-record.yml` → `tools/record/football_record.js`) | ESPN scoreboard line frozen at kickoff, falling back to the last pregame capture (`football_record_core.js:321-328`) | **410/410 graded games (100%)** have a close | single named book: DraftKings for all 410 (logged as 252 "DraftKings" + 158 "Draft Kings") |
| Model Lab (pg_cron `cfb_lab_hourly` + `cfb-lab.yml` → `cfb_lab_market_quotes`/`_lines`) | median of each book's last quote in [kickoff−180 min, kickoff) (`football/cfb_lab/lab_core.js:174, 314`) | 177/179 official predictions | `close_books = 1` on **177/177**, so it is never a multi-book consensus |

There is no Pinnacle or multi-book close live. The archive (`football/pricing/lines_cfb.json`) ends at 2025, and `openers_cfb.json` is for season 2025.

**Results.** Settled. A final needs ESPN and cfbfastR to agree; 410/410 graded have one.

**CLV.**

| Measure | Source | n (of 410) | Mean | Beat close | Other |
|---|---|---|---|---|---|
| Entry CLV | `football_record_core.js:448, 532` | 250 (61%) | +0.34 pts | 44.0% | — |
| Pick CLV | same | 241 | +0.13 pts | 34.4% | 34.9% flat |
| Lab CLV (official) | `lab_core.js:402, 540` | 177 | −0.054 pts | 29.4% positive | — |
| Lab research positions | lab | — | −0.135 pts | — | record 58–55–4 |

**2026 live accuracy** (pick vs close vs final, from the record).

| Slice | n | Model MAE | Close MAE | Model − close bias | ATS vs close | Brier model / close-ML | Log loss model / close |
|---|---|---|---|---|---|---|---|
| FBS vs FBS | 337 | 11.96 | **11.01** | **+1.46** (home), sd 4.89 | 159–173–5 (47.9%) | 0.1890 / **0.1732** (n=280) | 0.561 / **0.518** |
| FBS vs FCS | 73 | 15.54 | **11.72** | −6.30, sd 10.39 | 34–39 | — | — |
| FBS wk 2 / wk 7 | 49 / 59 | 13.01 / 11.26 | 10.74 / 10.66 | +0.72 / +1.66 | 19–30 / 26–31–2 | — | — |
| Lab official (T24) | 177 | 12.01 | 11.39 | — | — | 0.1989 (model) | — |
| V2.1 shadow (frozen) | 173 | 12.23 | — | −0.84 | — | — | — |

The record's own summary shows Brier 0.1655 because it includes FCS blowouts (`record/football/summary.json`).

**Backtests vs close.**

| Window | Model | Close | Other | Source |
|---|---|---|---|---|
| 2022–2025 held-out cold replay (n=3,127) | spread MAE 12.77; total MAE 12.91 | 12.02; 12.50 | ATS vs close 49.45% at ≥0.5 pts falling to **46.4% at ≥6**; Brier 0.19016, log loss 0.55878 (in-sample optimum 0.17899 / 0.53123) | `football/cfb_p4/research/report/BACKTEST.md` |
| 2015–2025 walk-forward (n=7,845) | 13.057 | 12.291 | optimal blend weight on the model **α = 0** in every scheme (unclamped −0.047) | `football/validation/pricing_cfb.json`; BACKTEST.md §v1.1 |

BACKTEST.md calibration bins show overconfidence on home favourites: 0.4–0.5 bin predicted 0.449 vs observed 0.397; 0.6–0.7 bin predicted 0.65 vs observed 0.591.

pricing_cfb.json, by size of disagreement:

| \|gap\| | n | Model MAE | Close MAE | ATS |
|---|---|---|---|---|
| 3–7 | 2,943 | 12.97 | 12.27 | — |
| **7–14** | 1,200 | **14.69** | 12.36 | 48.1% |
| **≥14** | 99 | **20.59** | 13.11 | 42.4% |

---

### 8. Proposed disagreement threshold

**Evidence.**
- **The model carries no information beyond the close.** α = 0 walk-forward, ATS is under 50% at every threshold, and it gets worse as the gap grows (§7). Any threshold is therefore a **QA / model-fault trigger, not an edge trigger**.
- **Gap distribution, historical.** 2015–2025 replay, n=7,888: mean +1.35 (home lean), sd **4.92**, p5 −6.6, p95 +9.0, p99 13.1 (forensics `gap_distribution`).
- **Gap distribution, 2026.**
  - Published picks, FBS-vs-FBS: \|gap\| p80 6.45, **p90 8.14**, p95 9.76.
  - My walk-forward replay by games played, gap centred on its mean:

    | Games played | sd | p90 | p95 |
    |---|---|---|---|
    | 0–3 | 5.8 | 9.3 | 10.9 |
    | 4–5 | 4.4 | 7.6 | 8.5 |
    | ≥6 | 3.7 | 6.0 | 7.5 |

- **Share of games with gap ≥ 7** (historical): **24% at 0–2 games, 16% at 3–5, 10.5% at 6+** (`disagreement_params.js` circuit).

**Proposal** (FBS vs FBS; subtract the trailing mean model−close bias first, which was +1.46 in 2026 under the old HFA):

| Situation | Threshold | Rationale |
|---|---|---|
| either team ≤ 3 games | ≥ 10 pts | about p95 early |
| 4–5 games | ≥ 8 pts | — |
| ≥ 6 games | ≥ 7 pts | — |

These levels sit at about 2σ and p95 of the in-season gap, so about 5% of games are flagged.

- **Headline number: 8 pts.** That is ≈1.6σ of the historical gap and ≈ p90 of 2026's.
- **≥ 14 pts:** presume a model or data fault. Never label it "VERIFIED MAJOR". Historically these games had model MAE 20.6 vs 13.1 for the close and 42% ATS; every 2026 FBS case at ≥14 (§5) was a model failure.
- **FBS vs FCS:** suppress disagreement entirely. The model has one FCS rating (sd of gap 10.4; MAE 15.5 vs 11.7).
- **Compared with the current rules.** The current 2-pt "lean" and 7+ "VERIFIED MAJOR" flags fire on 10–24% of games. They treat the region where the model is most wrong as its most interesting output.

---

### 9. Data the model wants but does not have

These are stated from the repo, not assumed.

- **Historical QB starter and availability records:** none exist. QB value is unpriced, and the QB-absence effect cannot be validated (forensics `definitions.unavailable_in_corpus`).
- **QB EPA on the coefficient's scale:** `fbs_epa` exists, but `epa_contract.js` rules it off-scale.
- **Live injury and availability:** ESPN depth (404) and participation (403) fail for 138/138 programmes. Conference reports are only partly ingested (FETCH_FAILED 31/124 sides). Non-QB position weights are untrained.
- **Recruiting star ratings:** recruit_ids are empty in the public roster feed (`params.unavailable_by_design.blue_chip_ratio`).
- **Coaching tenure and returning production historically:** not in the replay corpus (forensics `carryover.limitations`), so a personnel-aware prior cannot be fitted. 2026 files exist only from 2026-09-30.
- **FCS team strength:** a single −28 floor. The FCS bridge was not demonstrated (t = 0.03, n=122; `football/validation/fcs_bridge_cfb.json`). There is no prior for programmes moving up to FBS.
- **Historical weather series:** none, so no weather coefficient.
- **Multi-book / Pinnacle closing lines for 2026:** the live close is one book. The archive stops at 2025, and the 2026 opener ledger is absent (`openers_cfb.json` season 2025).
- **Public-betting / handle data:** a table exists in `cfb_market.sql`; whether it has any data cannot be determined without DB access.
- **What cannot be verified here:** whether the pg_cron jobs are actually scheduled in production; what the `cfb_lab_*`, `cfb.lines` and `signals` tables contain; and the `cfb.lines` DDL, which is not in the repo.

---

### Problems

| Severity | Problem | Evidence (file:line or data) | Impact |
|---|---|---|---|
| **Critical** | The preseason prior is last season's rating ×0.75 with no input for returning production, portal, recruiting or coaching. It gets 100% weight on the carried track for the first 3 games. New-FBS programmes start at a generic −12. | `engine.js:597-599, 645-703`; `params.blend.prior_weight_by_week` (1, 1, 1, 1, 0.8, 0.8, 0.6…); `params.unavailable_by_design`; top-3 2026 FBS misses (19.9 / 18.1 / 17.0 pts, §5) | 2026 wk-2 MAE 13.01 vs close 10.74; weeks 0–2 historical MAE 13.27 vs opener 12.08; largest gaps are all prior-driven |
| **High** | Home field over-applied all season until 2026-10-18 (projected 4.082, learned 3.2; market-implied ≈2.6). The fix (2.8) did not improve 2026 MAE. | `engine.js:84-101, 1053-1080`; `home_field.js` record (lean 1.49 → 0.20; live ΔMAE +0.027 [−0.059, 0.091]); record bias +1.46 (n=337) | ~1.3–1.5 pts home lean on every home game for 7 weeks; graded record and CLV contaminated |
| **High** | QB changes are not priced. QB value is structurally 0; QB absence needs reports that never arrive. | `football/matchup/inputs.js:84` (`PRICED_STARTER_STATUSES = []`); slate QB and injury terms 0/62; ESPN depth 404 / participation 403 for 138 programmes; explainer β_qb_change +0.50 to +0.79 | Systematic over-rating of teams with a new QB; first-career-start bias (−1.9 to −3.3, `docs/cfb-audit/EXECUTIVE.md`) |
| **High** | FCS opponents priced at one floor (−28); no prior for teams moving up | `engine.js:587, 612`; `params.rating.hyperparams.fcs_rating`; FBS-vs-FCS n=73 MAE 15.54 vs 11.72, bias −6.3; Montana State @ Nevada gap 31.7 | 18% of graded games badly priced; dominates the record's worst misses |
| **High** | The outcome range is off-centre by −1.0 pt on every game. It adds a residual PMF with mean −1.16 fitted on the old home-biased model. | `params.distributions.margin_resid_pmf`; `engine.js:500-513, 2902, 2950`; `app.html:57846`; 2026 replay: 57% of finals above the median, 11.3% above p90 vs 5.6% below | Card median and range contradict the fair line; sign flips near pick'em (Duke @ Virginia) |
| **High** | The model adds no information to the close, yet 7+ gaps are labelled "VERIFIED MAJOR DISAGREEMENT" | `pricing_cfb.json` (α = 0; 7–14 gap: model MAE 14.69 vs 12.36; ≥14: 20.59 vs 13.11, ATS 42%); `lib/edgedesk_canon.js` counters | Users steered toward exactly the games where the model is most likely wrong |
| Medium | Win prob uses a normal σ of 14.6–15.7, but the outcome distribution has sd 16.5. P(home) disagrees by up to 4.2 pp, so the fair ML is too long on big favourites. | `engine.js:398-400` vs `500-513`; params sigma vs PMF; `consistency.js` max −0.0419 (Troy: −789 vs ≈ −549) | Moneyline mispricing at the tails; internal contradiction on the card |
| Medium | Train/serve skew: the trainer uses one prior weight per game (`gs_min`); the engine weights each team by its own games played on tracks ~8.6 pts apart | `train_p4.py:658` vs `engine.js:681-683` (comment at `:618-620` claims the offset cancels) | 41/337 2026 FBS games shifted by 1.6 pts on average (max 2.9) for no football reason; ~62% of the shift shows up as gap vs close |
| Medium | The regime curve is priced despite a walk-forward gain of −0.032 [−0.095, +0.033] (below the 0.05 bar that rejected the −0.041 margin calibrator). Its cut moves weight onto the low-centred fresh track. | `regime_curve.js` record; `margin_calibration.js` decision; ODU @ VT counterfactual (gap 17.0 → 18.8) | Penalises improving coach/portal teams; inconsistent promotion governance |
| Medium | Schedule-stress scaling bug: /100 applied twice. The shipped effect is ≤0.022 pts vs the trained 1.13 pts; the README claims 1.13. | `engine.js:2654-2657`, `1163-1186`; `train_layers.py:345`; `disagreement_params.js` schedule p99 0.013 | Rest, bye and travel stretch effectively unpriced; README false |
| Medium | Grid-edge hyperparameters (k, carry, hfa, cap, init); k_fresh and the 6-game conference decay hand-set; blend floor 0.6 below the walk-forward optimum (0.84–1.0) | `train_p4.py:304-326`; `train_layers.py:462`; forensics `carryover.walk_forward_refit` (0.003–0.09 MAE every season) | Decay and learning rates not at optima; leaves accuracy on the table |
| Medium | Conference term under-weighted against the 2026 market | 2026 replay OLS: close loads **1.34 ± 0.10** on the conference term (carried 0.94 ± 0.05, fresh 0.81 ± 0.12); term up to 12 pts in 2026 (18.7 historically) | Early-season cross-conference games mispriced |
| Medium | Two engines: the card shows V1, while the canonical production report and governed decision run on V2.1 | `football/cfb_production/reports/projections.json` (`model_version` v2.1.0, V1 = fallback level 3); `app.html:51927-51936` | The governed decision and the card can disagree; V2 drivers leave mean \|5.64\| pts (max 14.9) unattributed |
| Medium | Closes are single-book (DraftKings via ESPN; lab `close_books = 1` on 177/177); entry CLV covers only 61% of graded games | `record/football/cfb_2026.json` `close.book`; lab evaluations; `football_record_core.js:448` | CLV and close-based grades are noisy; no sharp-book benchmark |
| Medium | σ ignores missing information (only `early_season` survives); the README says a missing input "widens the distribution" | `engine.js:1320-1336`; `params.volatility.lambda`; `football/cfb_p4/README.md` | Unknown QB, injuries or regime do not widen ranges; README overstates |
| Low | Stale or incorrect card text: HFA label says 4.08; "% inherited" uses 0.86^g without w; 1-pt display floor | `lib/edgedesk_canon.js:692`; `engine.js:3111-3121, 3282-3289, 2486-2510` | Misleading explanations |
| Low | Dead code: V1 CFB card in `football/engine.js`; `EDCFBEXPLAIN` in the AI edge function | `app.html:51814` (no caller); `supabase/functions/edgedesk_ai/index.ts:31231` (unused) | Maintenance confusion about which engine is live |

---

## MLB

Audited from the repo at `beb1ed28` (a shallow clone with 119 commits, all from 2026-10-20). There are no DB credentials, and outbound access to statsapi.mlb.com is blocked (proxy 403). Every number below is either read from a committed file or recomputed with the repo's own code. My scripts are in `docs/model-loop/audit_scripts/mlb/` (`replay.js`, `item5.js`); they require `mlb/engine.js`, `mlb/params.js` and `mlb/history/*` read-only.

**Bottom line.** Four different MLB "models" exist. Only one of them makes the numbers users see: the hand-set browser engine `mlb/engine.js`. It has never been logged, graded or compared with a close. The "OUTCOME_VALIDATED" label that `engine/registry.json` attaches to MLB belongs to a different model (`mlb/history`), which prices no live game. I replayed the live engine point-in-time on 2025 using only team inputs. It is worse than a tuned Elo (log loss 0.6838 vs 0.6784) and overconfident (slope 0.71), and its totals are badly overconfident (O8.5 slope 0.55; realised total moves only 0.67 runs per projected run). Home field is calibrated in aggregate, unlike the NFL. The NFL-class failures that do show up are:
- Starter inputs are fragile and can fail silently.
- There are no priors in the live engine. The "validated" offline model has prior-season-dominant priors.
- Card text contradicts itself in about 8% of games.
- Win probability carries an undisplayed +1.8-point home term.

---

### 1. Inventory (live / shadow / dead)

**Which code produces the live card numbers.** The live card numbers are the fair ML, run line, fair total, projected runs, win probability and the p10/p50/p90 band. They come from `mlb/engine.js` `projectMlbGame()` (engine.js:412-575). It is called once per game in the browser by `mlbxRows()` (app.html:17300-17332). The request is built by `mlbxRequest()`/`mlbxSideReq()` (app.html:17229-17296), and the scripts are loaded at app.html:4217-4218. The brief (`fbMlbBriefGame`, app.html:15118-15333) re-uses the same row via `mlbbProjRow`. Nothing server-side computes or stores these numbers.

| Item | What it is | Status |
|---|---|---|
| `mlb/engine.js`, `mlb/params.js` | Browser run model (multiplicative run expectancy → NB(var = 2·mean) → win/total/run line). Constants are hand-set (params.js:11-20, 213-223) | **LIVE**: drives Research → Baseball board, signals, focus panel and brief |
| `mlb/tests.js` (`npm run mlb:model`) | 140 self-consistency asserts; I re-ran it and all passed. Pins home win at league average to 0.532 (tests.js:132) | Test only |
| `mlb/history/{ingest,model,walkforward}.js`, `data/2010-2025.csv`, `params/mlb_live.json`, `params/mlb_tuning.json`, `validation/mlb_walkforward.json` | Fitted log-linear Poisson/NB team + park + SP model. Walk-forward 2012-2025; end-of-2025 ratings | **SHADOW**: only feeds the readiness labels in `engine/registry.json` / `engine/board.json` (engine/build_registry.js:104-112). Prices nothing (engine/projections.json `mlb.projections: 0`; walkforward.js:34 `live: null`) |
| `mlb/pitchers/*`, `mlb/batters/*` (`build_dataset.py`, `dataset/` 2016-2025, `snapshots/` metadata, `validation/next_season_*.json`) | StatsAPI career archive (mlbhist) | **LIVE for display/AI desk only**. "No live price reads this" (mlb_pitcher_features.sql:23-27; next_season_era.json `promotion`) |
| `lib/mlb_pitcher_history.js`, `lib/mlb_offense_history.js` | Archive query layer (`EDMlbPitchers`/`EDMlbBatters`), loaded at app.html:3969-3970 | LIVE display; not in the price |
| `supabase/functions/edgedesk_ai/_mlbhist.js`, `_mlboff.js` (inlined into `index.ts`) and the statsapi/Savant live fallback (index.ts:6660-6910) | AI desk research | LIVE research; prices nothing (index.ts:36929) |
| `tools/mlb/*.js` | Archive import/refresh/validation plus the UI/brief tests | Tooling/tests |
| `datapack/quant_v1/data/mlb/*` | 2024 games (no starters), 30-game pitch sample | Input to `mlb/history` (2024 only) |
| `supabase/mlb_pitcher_history.sql`, `mlb_offense_history.sql`, `mlb_pitcher_features.sql`, `mlb_offense_features.sql`, `fix_promote_deletes_mlb.sql`, `fix_slow_promote_mlb.sql` (+`parts/`) | `mlbhist` schema, staging, promote gates, as-of feature views | LIVE (archive). The feature views are research-only |
| **Tables the live engine reads, not defined anywhere in the repo:** `mlb_game_cards`, `games`, `pitcher_features`, `offense_features`, `team_season`, `pitcher_season`, `mlb_bullpen_taxed`, `mlb_bullpen_team` (app.html:14945-15032, 8029-8033); `venue_weather` (AI desk) | Written by the deployed-only `ingest_mlb`, `mlb_sync`, `bullpen_sync` and `ingest_pitcher_season` (supabase/functions/README.md:146; football/INTEGRATION.md:16) | **LIVE, UNAUDITABLE**: no DDL, writer or schedule in the repo |
| Server-side MLB models `run_slate`/`project_game` → `game_projections`; `model_conf_odds`/`model_predict` → `model_predictions` (`window.MODELP`) | Deployed-only (football/INTEGRATION.md:16-17; app.html:21403-21414, 48969-48989). The brief shows MODELP rows as "a different, unversioned estimate" (app.html:15147-15156) | **UNKNOWN/UNAUDITABLE**: a 3rd and 4th MLB number source |
| Edge fns in repo touching MLB: `capture` (`DEFAULT_SPORTS` includes `baseball_mlb`, "shed first under budget", capture/index.ts:2555-2561); `close` (signal CLV, close/index.ts:44-50); `odds_gateway` (MLB priority 3, INCIDENT.md:183) | Market capture | LIVE but **paid retrieval paused since 2026-10-10** (docs/odds-api-incident-2026-10/INCIDENT.md:3-12). No paid MLB prices for LCS/WS |
| pg_cron in repo: `capture_near` `*/20 * * * *`, `capture_day` `4 * * * *`, `capture_board` `18 */6 * * *` (supabase/capture_cron.sql:65-67) | Market only. No MLB-specific pg_cron is in the repo | Paused by the emergency stop (deployed state can't be verified) |
| GHA `mlb-pitchers.yml` (`20 9 * * 2`, `50 9 * * *`) | Archive refresh (mlbhist) | LIVE (display data) |
| GHA `lab-validate.yml` (`47 11 * * 3`) | Re-ingests Retrosheet, re-runs `mlb/history/walkforward.js`, rebuilds registry/board, commits | LIVE (shadow model + labels) |
| GHA `lab.yml` (push/PR on `mlb/history/**`, runs `walkforward.js --check`) | CI | CI |
| GHA `games-slate.yml` (`7,37 * * * *`) → `today/slate.json`; `games-live.yml` (`*/10 * * * *`) | ESPN schedule/scores incl. MLB and a DraftKings reference line | LIVE (schedule; not the model) |
| GHA `capture.yml` (`26 */3 * * *`, `41 1,7,13,19 * * *`) | Capture backup | Paused with capture |
| GHA `projections-build.yml` (`55 */3 * * *`), `performance.yml` (`19 * * * *`) | Projection ledger / performance record | Run, but **MLB = 0 projections / NO_FORECAST** |
| Dead params | `bullpen_regress_ip` (params.js:79) and `park_weight` (params.js:111) are never read | Dead |

---

### 2. Priors and decay

**Live engine (`mlb/engine.js`): there is no preseason prior at all.** Each rate is shrunk toward the league average (engine.js:198-204):

`used = league + (rate − league) · n/(n+k)`, so the weight on the prior is `k/(n+k)`.

| Input | k (params.js) | Prior weight at n=10 | n=40 | n=100 | n=162 |
|---|---|---|---|---|---|
| Club R/G and RA/G (games; n parsed from the card's "W-L" string, app.html:17273-17283) | 30 games (72-73) | **75%** | **43%** | **23%** | 16% |
| Starter ERA/FIP/xERA blend (n = season IP from `pitcher_season`) | 50 IP (78) | 83% (10 IP) | 50% (50 IP) | 33% (100 IP) | 22% (180 IP) |

- **The prior is the league mean.** It is not a team or pitcher projection. The 2016-2025 career archive is deliberately "never blended" (app.html:14896-14897). Consequences:
  - Opening Day prices every game at home field + park + weather only (≈53.2/46.8).
  - The card is under-dispersed early. In the 2025 replay, March–April predictions had SD 0.062 from 50% vs Elo's 0.076, and log loss 0.6812 vs Elo 0.6602 and history 0.6630.
- **Constants are hand-set, not fitted** (params.js:11-20). `validation.walk_forward: false` (params.js:214).
- **Starter shrinkage is far weaker than the repo's own research supports.** `mlb/pitchers/validation/next_season_era.json` chose K = **800 outs (≈267 IP)** on training seasons for shrinking a pitcher's ERA toward the league. The engine uses 50 IP, justified by an unrelated index (params.js:74-78). At 100 IP the engine trusts the starter's line 67%; K=267 IP would trust it 27%.
- **Season guard.** `calibrated_through_season: 2025` blocks any season above 2026 (engine.js:418-424). Every 2027 projection will return BLOCKED until someone edits params.

**Shadow model (`mlb/history`): fitted, and prior seasons dominate.**
- How the weights work:
  - Exponential decay with a 365-day half-life over an 800-day window, plus a ridge toward 0 (prior_games 40 ≈ 9 game-equivalents) and a 0.7 carry. Tuned on 2012-17 (mlb_tuning.json; model.js:27,49-92).
  - Integrating those weights, the share on **prior seasons** is **88% / 74% / 52%** after 10 / 40 / 100 current-season games (36% at 162). Current-season share is 6% / 21% / 43%.
- **Roster changes: none.** It is a team-level rating with no personnel adjustment, which is exactly the NFL failure class. Example: Buehler still carries a positive starter effect (+0.072 log) from his Dodger years.
- **The tuning grid ended at its edge again.** `prior_starts=64` is the grid maximum (walkforward.js:80-81), so the tuning is not converged.

---

### 3. Personnel

| Element | Source / logic | Applied to price? |
|---|---|---|
| Probable starters | `mlb_game_cards.{home,away}_pitcher_name/throws`, written by deployed `mlb_sync`/`ingest_mlb` from statsapi. **Probable only, no confirmed state** (index.ts:2161; app.html:14893-14894) | **Yes** |
| Starter rate | `pitcher_features` (per game: era, fip, xera) else `pitcher_season` (era, fip). Blend xERA .40 / FIP .35 / ERA .25, renormalised over what is present, × 1.08 ERA→RA9, shrunk by IP/(IP+50) (engine.js:286-305; params.js:85-98). xERA requires Savant via `ingest_mlb`, whose Savant path is reported broken (index.ts:6648-6650, 6858, 6906) | Yes |
| Starter share of the game | `ip_per_start = season IP / GS` from `pitcher_season` (app.html:17247), clamped 3.0-7.5 (engine.js:453-455). **Bug:** season IP includes relief innings, so swingmen and bulk men are over-weighted. In the replay, Montero (90.7 IP / 9 GS) got 7.5 IP = **83% of the game**; Junk 6.9 IP = 76% | Yes |
| Starter missing or "TBD" | `starterRa9` → null, and the whole game is charged at the club's staff rate (engine.js:455-460), with a warning (engine.js:402-404). The card still prints a full price | Yes (fallback) |
| **Starter with no `pitcher_season` row** | `ip` is null, so `regress()` returns the league baseline (engine.js:201, 301-302). The starter is priced at exactly league average while the card text still lists his xERA/FIP. `sp.missing` is never propagated into `data_quality` (engine.js:388-410). `team_season`/`pitcher_season` were observed **empty in production on 2026-09-16** (docs/intelligence-architecture.md:595) | **Silent** |
| Scratches | **No scratch feed** (docs/quant-desk/INVENTORY.md:73; docs/research-intel/INVENTORY.md:43). The card changes only if `mlb_game_cards` is rewritten | — |
| Lineups / platoon | None. `offense_features.vs_lhp/vs_rhp` is fetched (app.html:14987) but **never used**. It is in fact discarded: `MLBB.offense` is filled by `game_id` at app.html:14989, then unconditionally reset and re-keyed by `team_id` at 15064/15073. The engine fallback (app.html:17238, 17260) and the brief's matchup panel (15126, 15693-15694) never see it | **No (and a bug)** |
| Bullpen | Relief share uses the club's **whole-staff** RA/G (engine.js:307-321). It adds +1.8% per flagged arm, capped at 9%, plus +2% for a flagged closer (params.js:104-106; engine.js:322-334). Flags come from `mlb_bullpen_taxed` with **no date filter and severity ignored** (app.html:8029; engine.js:323-325). A failed read yields `{taxed:[]}`, i.e. a silent zero tax (app.html:17249-17253) | Yes (crude) |
| Injuries (position players) | None. Team R/G is not adjusted for who plays | No |
| Career archive (mlbhist) | Displayed as separately labelled panels | Display only |

---

### 4. Home field, park, weather, rest, travel

All of these are **separate multiplicative components** in the run model, not an intercept. The home win terms are added after the distribution.

- **Home field.** Hand-set constants:
  - `home_offense_mult` 1.020 and `away_offense_mult` 0.988, a run ratio of 1.0324 (params.js:50-51).
  - `extra_innings_home_win` 0.52 (params.js:55).
  - `home_last_bat_win_bonus` +0.016 added to P(home) (params.js:65; engine.js:491-492).
- **Engine at league-average inputs:**

  | Step | P(home) | Increment |
  |---|---|---|
  | Neutral | 50.00 | — |
  | + run split | 51.38 | +1.38 |
  | + extra innings 0.52 | 51.59 | +0.21 |
  | + last-bat bonus | **53.19** | +1.60 |

- **Measured from the committed Retrosheet logs, 2021-25:**

  | Quantity | Measured | Engine |
  |---|---|---|
  | Home win rate | **53.15%** | 53.19% (calibrated in aggregate; **not** the NFL's too-high HFA) |
  | Home/away run ratio (observed) | **1.010** (2023-25: 1.001) | 1.032 |
  | Extra-inning home win rate | **0.500** (842 games) | 0.52 (walk-forward's own fitted xi for 2022-25: 0.478-0.501, mlb_walkforward.json `calibration_by_season`) |
  | Home −1.5 cover rate | 35.9% | 36.1% |

  The decomposition is mis-attributed but the sum is right. The +1.81-point structural term (bonus + extra innings) is never shown on the card.
- **Park.** `mlb_game_cards.run_factor`, falling back to `park_factor` (app.html:17287). The source and convention (full-game home/road ratio vs halved index) are not in the repo. It is clamped 0.85-1.18 and applied **in full to both sides** (engine.js:439-446).
  - The comments still say "square root" (params.js:108-110; engine.js:272-273).
  - Team R/G and RA/G are raw, not park-neutral, so the home park's effect is partly counted twice whenever the index is a full-game ratio. I could not detect this in the 2025 replay using the history model's fitted park as a proxy (engine total bias vs park index slope −0.002 runs/point), so the risk depends on the unknown live convention.
- **Weather.** Forecast fields on `mlb_game_cards`:
  - Temperature: 0.10%/°F around 70°F, clamp ±4.5%. Wind out: 0.45%/mph, clamp ±5.5%. Retractable roof: effect halved. Rain: warning only (params.js:119-133; engine.js:228-270).
  - **Risk:** `wind_rel` falls back to `wind_dir` (app.html:17290). If `wind_dir` is a numeric compass bearing, `windOut` reads it as a field-relative angle (engine.js:217-218) and can apply up to ±5.5% with the wrong sign. The column semantics are not in the repo.
- **Rest, travel, day/night, doubleheaders, postseason off-days:** not modelled anywhere. The situation panel is display only.

---

### 5. The three biggest disagreements: decomposed

**What is missing.** The specific question (biggest disagreements with the close in recent games) **cannot be answered from the repo**:
1. **No MLB closing lines are committed.** No licensed archive exists (registry `blockers`; walkforward.js:182). `close` stores closes only for captured `signals` rows, and only in the DB.
2. **No live MLB engine output was ever logged.**
   - `engine/projections_ledger/2026-10.jsonl` has 0 MLB rows.
   - `engine/projections.json` has `mlb.projections: 0`.
   - `performance/data/summary.json` has MLB `NO_FORECAST, games 0`.
3. **No 2026 engine inputs are committed.** `team_season`, `pitcher_season` and `mlb_game_cards` exist only in the DB. The committed archives end in 2025 (`mlb/*/dataset/build_report.json`).

The only committed MLB market prices are four DraftKings quotes:
- three in a test fixture (`tools/collective/fixtures/oddsblaze_mlb_draftkings.json`, 2026-08-20, provenance unverified);
- one in `today/slate.json` (WS G1 TB @ MIL, captured 2026-10-20, three days before first pitch: not a close).

None of these games has a model output or inputs.

**Comparison A (labelled MODEL vs MODEL, not vs market): late 2025, the most recent committed season.**
- I replayed the live engine on 2025 point-in-time:
  - Team R/G, RA/G and games are computed from Retrosheet through D−1.
  - The league mean is the unweighted mean of club R/G, as in `mlbxLeague`.
  - The park index is the history model's fitted park (exp(k)·100).
  - There is no weather and no bullpen flags.
  - Starters use the 2025 full-season ERA, FIP, IP and GS from `mlb/pitchers/dataset`. This is look-ahead, but small in late September; xERA is absent.
- I compared it with the repo's walk-forward model (point-in-time `pass()`, recalibrated with the published 2025 calibration) and Elo.
- Over the 136 games from 2025-09-19 to 09-28, the mean |engine − history| was 3.9 points. The three largest gaps are below.

**Home-structure baseline, identical in all three games:** 50.00 → +1.38 (run split 1.020/0.988) → +0.21 (extras 0.52) → +1.60 (last-bat bonus) = **53.19%**.

#### A1. 2025-09-25 MIA @ PHI (final MIA 0, PHI 1). Engine PHI 50.9%, history 64.2%, Elo 65.2%: gap −13.3 points

| Component | Arithmetic | Factor |
|---|---|---|
| League L | mean of 30 club R/G | 4.459 |
| PHI offense | 4.886 R/G over 158 g → 4.459 + 0.427·(158/188 = 0.840) = 4.818 | ×1.0806 |
| MIA offense | 4.424 over 158 → 4.430 | ×0.9935 |
| MIA staff faced by PHI | Junk: blend(FIP 3.14, ERA 4.17) = 3.573 → ×1.08 = 3.859 → IP 110: w = 0.688 → 4.046. Share 6.875/9 = **0.764** (IP/GS inflated by relief IP). Club RA/G 5.000 → 4.914. Staff = 0.764·4.046 + 0.236·4.914 = 4.251 | ×0.9534 |
| PHI staff faced by MIA | Buehler: blend(FIP 5.66, ERA 4.93) = 5.355 → 5.783 → IP 126: w = 0.716 → 5.407. Share 5.25/9 = 0.583. Club RA/G 4.057 → 4.121. Staff = 0.583·5.407 + 0.417·4.121 = 4.871 | ×1.0925 |
| Park (108), weather (none) | both sides | ×1.08 |
| λ PHI | 4.459 × 1.0806 × 0.9534 × 1.08 × 1.020 | **5.06** |
| λ MIA | 4.459 × 0.9935 × 1.0925 × 1.08 × 0.988 | **5.16** |
| Total / NB | 10.22; P(runs incl. xi) = 0.4926; +0.016 | **50.86% → PHI −103 / MIA +103** |
| Run line | λH < λA, so **PHI +1.5** shown (63.2%, −172) even though PHI is the ML favourite | — |

| Win-prob attribution (points, one at a time from 53.19) | PHI off +3.43 | MIA off +0.28 | MIA staff −2.06 | PHI staff −3.89 | park +0.04 | Σ −2.19 | **residual −0.14** | = 50.86 |
|---|---|---|---|---|---|---|---|---|

- **Why the history model differs.** History: λ 5.70–3.98, PHI 64.2% (−179). It carries Buehler as better than PHI average (+0.072 log) and PHI run prevention at d = +0.105, both from prior seasons. The engine charges Buehler's 2025 FIP at 72% trust over 58% of the game, and gives Junk 76% of the game.
- **Result:** PHI won 1-0 (total 1 vs engine 10.22 and history 9.68).
- The brief would print "PHI by 0.10 runs", although PHI is projected to score fewer runs.

#### A2. 2025-09-20 NYY @ BAL (final NYY 6, BAL 1). Engine BAL 36.5%, history 49.3%, Elo 45.9%: gap −12.8 points

| Component | Arithmetic | Factor |
|---|---|---|
| L | | 4.473 |
| BAL offense | 4.247 over 154 → 4.284 | ×0.9577 |
| NYY offense | 5.214 over 154 → 5.093 | ×1.1388 |
| NYY staff faced by BAL | Rodón: blend(FIP 3.78, ERA 3.09) = 3.491 → 3.771 → IP 195.3: w = 0.796 → 3.914. Share 0.658. Club 4.351 → 4.371. Staff = 4.070 | ×0.9100 |
| BAL staff faced by NYY | Sugano: blend(FIP 5.36, ERA 4.64) = 5.060 → 5.465 → IP 157: w = 0.758 → 5.225. Share 0.581. Club 4.851 → 4.789. Staff = 5.043 | ×1.1274 |
| Park 98 | | ×0.98 |
| λ BAL | 4.473 × 0.9577 × 0.9100 × 0.98 × 1.020 | **3.90** |
| λ NYY | 4.473 × 1.1388 × 1.1274 × 0.98 × 0.988 | **5.56** |
| NB | total 9.46; P = 0.3487 + 0.016 | **36.47% → BAL +174 / NYY −174**; run line BAL +1.5 49.4% (+102) |

| Attribution (points) | BAL off −1.87 | NYY off −5.78 | NYY staff −4.03 | BAL staff −5.32 | park −0.01 | Σ −17.00 | **residual +0.27** | = 36.47 |
|---|---|---|---|---|---|---|---|---|

- **Why the models differ.** The engine multiplies raw season NYY offense (+14%) by raw BAL staff (+13%). The history model shrinks through decay, the ridge and its recalibration (slope 0.862): λ 4.50–4.89, BAL 49.3%.
- **Result:** NYY won 6-1. The engine had the side right; the total was 7 vs 9.46.

#### A3. 2025-09-27 DET @ BOS (final DET 2, BOS 1). Engine BOS 62.9%, history 50.1%, Elo 58.4%: gap +12.8 points

| Component | Arithmetic | Factor |
|---|---|---|
| L | | 4.457 |
| BOS offense | 4.881 over 160 → 4.814 | ×1.0802 |
| DET offense | 4.706 over 160 → 4.667 | ×1.0471 |
| BOS staff faced by DET | C. Early: **19.3 IP**, FIP 0.91 / ERA 2.33 → 1.501 → 1.621 → w = 0.279 → 3.666. Share 0.537. Club 4.194 → 4.235. Staff = 3.930 | ×0.8817 |
| DET staff faced by BOS | Montero: blend(FIP 4.93, ERA 4.37) = 4.697 → 5.073 → IP 90.7: w = 0.645 → 4.854. IP/GS 7.56 clamped to 7.5, share **0.833** (relief IP). Club 4.288 → 4.314. Staff = 4.764 | ×1.0689 |
| λ BOS | 4.457 × 1.0802 × 1.0689 × 1.00 × 1.020 | **5.25** |
| λ DET | 4.457 × 1.0471 × 0.8817 × 1.00 × 0.988 | **4.07** |
| NB | total 9.31; P = 0.6130 + 0.016 | **62.90% → BOS −170 / DET +170**; run line BOS −1.5 46.0% (+117) |

| Attribution (points) | BOS off +3.41 | DET off −2.00 | DET staff +2.94 | BOS staff +5.23 | park 0 | Σ +9.58 | **residual +0.13** | = 62.90 |
|---|---|---|---|---|---|---|---|---|

- **Why the models differ.** A 19-inning sample moves the price by 5.2 points even after shrinkage. History (λ 3.98–4.23) is at a coin flip.
- **Result:** DET won 2-1.

**What A shows.** All three gaps (12.8-13.3 points) would be `RESEARCH_LEAN` (at least 4 points, under the 18-point guard). The run components multiply out exactly (no residual beyond rounding). The win-probability residual is small here, but up to 3.8 points across the season (§6). The drivers are:
- the inflated starter share from IP/GS (A1, A3);
- the weak IP shrinkage (A3);
- raw multiplicative team rates (A2).

On these three games the engine was 1–2 vs outcomes; that is noise, not evidence.

**Comparison B (labelled MARKET, no model output available).** De-vigged with the engine's own `devigTwoWay`:

| Game | Home fair | Total | Gap vs engine fallback |
|---|---|---|---|
| NYY@BAL 2026-08-20 | BAL 49.9% | 7.5 | +3.3 |
| WSH@TEX | TEX 63.3% | 7.5 | −10.1 |
| LAA@HOU | HOU 63.3% | 8.5 | −10.1 |
| TB@MIL WS G1 2026-10-23 (captured three days early) | MIL 59.1% | 6 | −5.9 |

The "fallback" is the price the engine produces when `team_season`/`pitcher_season` are empty, the state observed on 2026-09-16: 53.19% home for every game. In that state every real favourite of −180 or shorter becomes a RESEARCH_LEAN, and anything past about −260 becomes a DATA_FAULT, while `data_quality` reports starters as OK.

---

### 6. Card consistency (2025 replay: 2,430 games with starters; team-only in brackets)

| Check | Result |
|---|---|
| Displayed run multipliers × league = displayed runs | ✔ max abs error **0.006 runs** (rounding). Fair total = sum of runs within **0.010** |
| Win-prob components displayed? | **No.** `contributions` and `components` are never rendered for MLB; only `weather_factor` in a signal note (app.html:17420-17429) |
| Undisplayed win-prob term | **+1.81 points to home in every game** (last-bat +1.60, extras +0.21) |
| Interaction residual (one-at-a-time attribution) | mean 0.29 points, **max 3.80 points** |
| Win prob vs fair ML | Same probability by construction. Max |implied(ML) − p| **0.12 points** (integer American odds). Displayed integer % ≠ % implied by displayed ML in 134/2430 games (5.5%) [121] |
| Favourite/margin text | "X by m runs" (app.html:15159-15162) names the win-prob favourite but uses |λH−λA|. **186/2430 (7.7%)** [214, 8.8%] games name a team projected to score *fewer* runs |
| Run-line side vs ML favourite | Run line side is picked by λ (engine.js:498) while the favourite is picked by p. **195/2430** [228] games show the ML favourite at **+1.5** |
| Outcome range centred? | Board band is p10 / **mean** / p90 (app.html:17519-17524). With integer quantiles it is asymmetric: (p90−mean) − (mean−p10) averages **+0.64 runs**, max 1.54. |mean − p50| up to 1.00 run |
| Band coverage claim | Brief says "One game in five lands outside this band" (app.html:15184). The engine's own NB puts **14.9%** outside (league-average game); empirically 18-20% fell outside (82%/80% coverage in 2025/2023). The NB is too narrow: dispersion 2.0 vs empirical variance/mean 2.26 (2016-25) and fitted r=4 (≈2.1) |
| Stale market | Leans/faults are counted in the snapshot even when the market is stale (app.html:17339-17340); signal lists exclude stale (17359, 17374) |

---

### 7. Measured vs logged

- **Closing lines.**
  - `close` writes `closing_sharp_fair`/CLV onto `signals` rows (market-scan edges), MLB included when captured (close/index.ts:44-50). Coverage is DB-only and unknown.
  - Paid capture has been paused since 2026-10-10, so no LCS/WS captures.
  - This is CLV of market signals, **not of the model**.
- **Model outputs.** Never persisted: browser-only, "writes to no ledger" (docs/model-card-baseball.md, *Consequence in the desk*). There is no model CLV, no settled model record, and Performance shows MLB `NO_FORECAST, 0 games`.
- **Contradictions between surfaces:**

  | Surface | What it says |
  |---|---|
  | README.md:469, 497 | "MLB has no per-game projection" |
  | `engine/board.json` (MLB) | "nothing is priced now" |
  | app (Research → Baseball) | Prices every MLB game with fair ML, run line and total |
  | registry | MLB "OUTCOME_VALIDATED (spread)", borrowed from `mlb/history` |

- **Walk-forward (`mlb/history`, NOT the live engine).** From mlb/history/validation/mlb_walkforward.json, confirmation window 2018-25, n = 17,909, all vs **outcomes only** (`market_status: NOT_TESTED`):
  - **Moneyline:**

    | Model | Log loss | Brier | Calibration |
    |---|---|---|---|
    | team_park_sp | 0.67727 | 0.24214 | slope 0.984, citl −0.0006 |
    | Elo | **0.67565** | 0.24139 | — |
    | team only | 0.67703 | — | — |
    | constant home | 0.69123 | — | — |

    - The chosen model **loses to Elo** by +0.0016 (95% CI 0.0004–0.0028).
    - The starter term adds **nothing**: +0.0002 (CI −0.0010 to +0.0013).
  - **Run line home −1.5:** log loss 0.64397, Brier 0.22606, slope 0.85. This is the only "VALIDATED" market.
  - **Total over 8.5** (a fixed line, not the market's): log loss 0.68956 (a coin flip is 0.6931), slope **0.647**, total bias −0.04 runs.
- **Live engine replay (mine; point-in-time team inputs).**

  | | 2025 team-only | 2025 + look-ahead SP | 2023 team-only | 2023 + SP |
  |---|---|---|---|---|
  | ML log loss (engine / history / Elo) | **0.6838** / 0.6783 / 0.6784 | 0.6714* | **0.6826** / 0.6842 / 0.6809 | 0.6712* |
  | ML calibration slope (engine) | **0.71** | 1.04 | **0.79** | 1.11 |
  | Brier (engine) | 0.2454 | 0.2395 | 0.2448 | 0.2393 |
  | Total RMSE (engine / constant) | 4.557 / 4.593 | 4.487 | 4.596 / 4.583 | 4.502 |
  | Total bias (runs) | −0.11 | −0.03 | −0.03 | +0.06 |
  | O8.5 calibration slope | **0.55** | 0.89 | **0.39** | 0.81 |
  | Actual total ~ fair total slope | **0.67** | 0.95 | — | — |
  | Home −1.5 log loss / slope | 0.6474 / 0.64 | 0.6358 / 0.98 | 0.6383 / 0.96 | 0.6262 / 1.32 |

  \*The SP columns use full-season starter lines, so they include the game being predicted. That is an **upper bound**, not a record.

  With honest point-in-time inputs, the engine is no better than Elo, overconfident on sides and strongly overconfident on totals.

---

### 8. Proposed disagreement thresholds

**Current thresholds:** review 4.0 points / 0.75 runs; guard 18 points / 2.5 runs (params.js:147-151).

**Evidence (2025 replay):**
- Two models with equal skill (history vs Elo, log loss 0.6783 vs 0.6784) disagree with **SD 4.0 points, p90 6.9**.
- Engine vs history: SD 5.6–5.9, p90 9.2–9.7.
- The 4-point review flag fires on **48–49% of all games** vs another model. That is noise, not signal.
- Engine slope 0.71–0.79 means a raw gap overstates real information by roughly 25%.
- For totals: engine-vs-history SD 0.69, p90 1.15. A projected run is worth only 0.67 realised runs, and O8.5 slope is 0.39–0.55.

**Proposal (until a closing archive exists):**
1. **Moneyline.** Shrink the engine first: `p' = sigmoid(0.75·logit p)`. Then flag "disagreement" only at **|p' − market fair| ≥ 8 points**. Near even that is about 38 cents (+100 → −138); at 60% it is about 63 cents (−150 → −213).
2. **Moneyline data fault:** ≥ 15 points.
3. **Totals:** review at **≥ 1.25 runs** raw (about 0.85 realised), data fault at ≥ 2.0 runs.
4. **Hard suppressions** (no flag at all) when:
   - a starter is TBD or has no `pitcher_season` IP;
   - either club has fewer than 30 games;
   - the starter's IP/GS implies more than 6.5 IP while GS is less than 80% of games pitched (swingman);
   - the market is stale or one-sided;
   - it is the postseason (see Problems).
5. Re-derive the thresholds from CLV once closes are logged against stored engine outputs.

---

### 9. Data availability (owned vs not)

| Feature | Model wants | EdgeDesk owns? | Where / status |
|---|---|---|---|
| Probable starters | Yes | Table owned, writer deployed-only | `mlb_game_cards` (probable, no confirmed state, no change history) |
| Confirmed starter / scratch feed | Yes | **No** | Registry blocker; INVENTORY.md:73 |
| Starter ERA/FIP | Yes | Deployed tables | `pitcher_features`, `pitcher_season`; empty on 2026-09-16 per intelligence-architecture.md:595 |
| xERA / xwOBA / barrel% | Yes | Partly | Via `ingest_mlb` Savant path, reported broken (index.ts:6648-6650). The AI-desk fallback reads Savant, but not for the browser engine |
| xFIP / SIERA / Stuff+ / CSW / pitch mix / velocity | — | **No** | Not anywhere. app.html:8302 says "Not in the data yet"; index.ts:6910 `MISSING_STATCAST` |
| Bullpen quality and usage / rest state | Yes | **No** (flags only) | `mlb_bullpen_taxed` (pitches yesterday, severity), `mlb_bullpen_team` (closer flag); no usage archive (registry `gaps`) |
| Lineups / confirmed lineups | Yes | **No** | Registry gaps; model card limitation 1 |
| Handedness / platoon splits | Yes | Table exists, unused | `offense_features.vs_lhp/vs_rhp`, clobbered (app.html:15064); statsapi splits only in the AI fallback (index.ts:6841-6855) |
| Park factors | Yes | Column on deployed table | `mlb_game_cards.run_factor`. Source, convention and handedness split not documented (model card limitation 6) |
| Weather | Yes | Deployed | `mlb_game_cards` forecast and `venue_weather`. Roof state not published |
| Umpire, rest, travel, day/night | — | **No** | — |
| Historical game logs with starters | Training | **Yes, in repo** | Retrosheet 2010-23 and 2025; 2024 has no starters; **2026 absent** |
| Career pitching/batting archive | — | **Yes** | mlbhist 2016-2025 (+2026 provisional in DB). Display only |
| Closing lines (archive) | Market test | **No** | No licensed archive. Paid capture paused 2026-10-10 → 2026-11-01 |
| Stored engine outputs | Grading | **No** | Browser-only |

---

### Problems

| Severity | Problem | Evidence (file:line or data) | Impact |
|---|---|---|---|
| **Critical** | The live card engine has no record: outputs are never stored, graded or compared with a close. The "validated" label comes from a different model that prices nothing | app.html:17300-17332 (browser-only); engine/projections.json `mlb.projections 0`; performance/data/summary.json MLB `NO_FORECAST`; engine/build_registry.js:104-112 uses `mlb/history` for MLB readiness; README.md:497 vs app | Users see fair ML, run line, total and RESEARCH_LEAN flags from an unmeasured engine while the registry shows OUTCOME_VALIDATED |
| **High** | Engine is overconfident and no better than Elo on point-in-time inputs | Replay: 2025 log loss 0.6838 vs Elo 0.6784, slope 0.71; 2023 0.6826 vs 0.6809, slope 0.79 | Win-prob gaps vs market are inflated by about 25% |
| **High** | Totals strongly overconfident | Replay O8.5 slope 0.55 (2025) / 0.39 (2023); actual~fair slope 0.67; history model total slope 0.647 (mlb_walkforward.json) | 0.75-run review flags are mostly noise |
| **High** | Starter silently priced at league average when the `pitcher_season` row is missing; `sp.missing` is never surfaced; tables observed empty in production | engine.js:201, 301-304, 388-410; docs/intelligence-architecture.md:595 | Card says OK while the starter, the largest input, is zeroed. In the fully empty state every game is 53.19% home |
| **High** | Starter share uses season IP/GS including relief IP | app.html:17247; engine.js:453-455; replay: Montero 83% of game, Junk 76% | Swingmen and openers dominate the price (A1, A3: 13-point gaps) |
| **High** | No preseason/team or pitcher prior; league mean with k=30 g / 50 IP; guard blocks 2027 | engine.js:198-204, 418-424; params.js:34, 72-78; replay Mar-Apr 2025 log loss 0.6812 vs Elo 0.6602 | Early-season cards are flat (about 53/47); in-season small samples are over-trusted |
| **Medium** | Starter shrinkage contradicts the repo's own validation (K = 800 outs ≈ 267 IP vs 50 IP) | params.js:74-78; mlb/pitchers/validation/next_season_era.json | A 19-IP sample moves the price 5 points (A3) |
| **Medium** | `offense_features` always discarded (MLBB.offense re-keyed) | app.html:14989 vs 15064/15073; read at 15126, 17238 | Fallback offense and handedness splits never reach the price or the brief |
| **Medium** | Card contradicts itself: favourite named by p, margin and run line by λ | app.html:15159-15162; engine.js:498; replay 186-214 / 2430 games | "PHI by 0.10 runs" when PHI is projected to score fewer runs; ML favourite shown at +1.5 |
| **Medium** | Undisplayed +1.81-point home term; no win-prob attribution rendered; interaction residual up to 3.8 points | params.js:55, 65; engine.js:491-492; no `contributions` render for MLB | Reader can't reconcile the price to its drivers |
| **Medium** | "Validated" shadow model is prior-season dominated with no roster adjustment, loses to Elo, and the SP term adds nothing; tuning grid ends at its edge | model.js:27; mlb_tuning.json (prior_starts 64 = grid max); mlb_walkforward.json comparisons | The NFL failure class lives in the model the registry certifies |
| **Medium** | Park convention unknown and possible double count (raw R/G + full park); stale "square root" comments | engine.js:272-273 vs 439-446; params.js:108-110; app.html:17287 | Coors-type totals could be inflated by about half the park effect |
| **Medium** | Wind fallback to `wind_dir` may be read as a field-relative angle | app.html:17290; engine.js:217-218 | Up to ±5.5% of total with the wrong sign |
| **Medium** | Bullpen is the whole-staff rate; flags have no date filter, severity is ignored, and a failed read means zero tax | engine.js:315-336; app.html:8029, 17249-17254 | Bullpen availability is effectively unmodelled |
| **Medium** | Live inputs and two other MLB models are deployed-only and unauditable | supabase/functions/README.md:146; football/INTEGRATION.md:16-17; app.html:21403-21414, 15335-15348; index.ts:6648-6650 (Savant path broken) | Cannot verify the source, freshness or convention of any live input |
| **Medium** | Postseason: no market (capture paused) and the regression sample comes from the card's W-L string (could be a postseason record) | INCIDENT.md:3-12; app.html:17273-17283 | LCS/WS cards unmeasurable; full-season rates possibly regressed about 75% to league (unverified) |
| **Low** | Home-field split mis-attributed (run ratio 1.032 vs observed 1.010; extras 0.52 vs measured 0.500) although the total is calibrated (53.19 vs 53.15) | params.js:50-65; Retrosheet 2021-25 | Home team total / run line slightly overstated |
| **Low** | Band claim ("one in five") wrong vs the engine's own 14.9%; band centred on the mean, asymmetric by +0.64 runs; NB dispersion 2.0 below empirical 2.26 | app.html:15184, 17519-17524; params.js:141 | Misstated uncertainty |
| **Low** | League baseline comment says games-weighted, code is unweighted; dead params | app.html:17133-17145; params.js:79, 111 | Cosmetic / misleading docs |
| **Low** | Integer-odds rounding: displayed % and ML disagree by 1 point in 5.5% of games | engine.js:58-69 | Cosmetic |

---

## WNBA

Audit date 2026-10-20. Repo `/home/user/EdgeDeskSports` at HEAD `beb1ed28`. The clone is shallow, so git history cannot show how often jobs actually ran. Everything below comes from code, SQL, workflows and committed artifacts. No file in the repo was modified.

**How the numbers were checked.** I re-ran the engine read-only (scripts in `docs/model-loop/audit_scripts/wnba/`): `basketball/walkforward.js` `load`/`pass`/`score`, `basketball/build_slate.js` `priceGame`, and `basketball/model.js`, all on the committed CSVs. With games through 2026-10-17, the replay reproduces `basketball/params/wnba_live.json` exactly: every team o/d, mu = 81.164, h = 2.033, and all calibration coefficients (max |Δ| = 0.000). It also reproduces all three WNBA cards in the projections ledger to 4 dp (p_home, fair line, expected total).

**State of the season in the committed data.** The brief and `docs/sports-calibration/README.md:100` / `CHANGELOG.md:125` say "the season is over". The committed data says otherwise. The Finals (Golden State Valkyries v Atlanta Dream) are tied 1–1. G3 is scheduled for 2026-10-22T00:00Z and G4–G7 run through 2026-11-01 (`basketball/data/wnba/2026.csv`, last 5 rows). The live slate still prices G3 (`basketball/slate.json` → `leagues.wnba.games[0]`). The projections ledger was still freezing it at 2026-10-20T17:35Z (`engine/projections_ledger/2026-10.jsonl`). The WNBA card is therefore live while its known 2026 defects are documented as moot.

### 1. Inventory: what produces the live card numbers

**Chain (all LIVE):**

```
sportsdataverse wehoop parquet (ESPN) ──basketball/ingest.js──► basketball/data/wnba/<season>.csv
        │  daily  lab-build.yml (cron '17 9 * * *', step L38: --season current)
        │  weekly lab-validate.yml (cron '47 11 * * 3', L43: all seasons)
        ▼
basketball/walkforward.js main()  ── ONLY in lab-validate.yml L47 (weekly, Wed 11:47 UTC; + manual dispatch)
        │  writes basketball/params/wnba_live.json (ratings + calibration, walkforward.js:257-262)
        │  writes basketball/validation/wnba_walkforward.json (status labels, :264-281)
        ▼
basketball/build_slate.js priceGame()  (build_slate.js:34-56)  ── lab-build.yml L40 daily, lab-validate.yml L51
        │  ►►► THE CARD NUMBERS: p_home, fair ML, projected margin, fair home line + cover ladder,
        │      projected/fair total + over/under ladder (basketball/slate.json leagues.wnba)
        ▼
lib/edgedesk_projections.js ADAPTERS.lab_basketball (:436-469; sport row :104-108)
        │  adds projected_score = (total ± margin)/2 (:453), default uncertainty (:457), "availability not modelled" (:459)
        ├─► engine/build_projections.js (projections-build.yml cron '55 */3 * * *') → engine/projections.json + engine/projections_ledger/2026-10.jsonl
        │       └─► performance.yml (cron '19 * * * *') → performance/ledger/{forecasts,results,grades,research_grades,grade_outcomes}/wnba-2026.jsonl
        │                                                   → performance/data/games/wnba-2026.json, performance/data/grades/*
        ├─► supabase/functions/edgedesk_ai/index.ts (EDPROJ inlined; WNBA row :36876-36877; reads basketball/slate.json over HTTP :55211, getArtifact :4192)
        │       → writes public.projection_snapshots / public.market_comparisons (supabase/independent_projections.sql:53,116)
        └─► engine/build_board.js basketballCandidates (:136-156) → engine/board.json (status RESEARCH, gate NO_PRICE) → Engine page (lib/edgedesk_engine_ui.js:29)
```

**Code and artifacts**

| Item | Role | Status |
|---|---|---|
| `basketball/config.js:36-41` | League config: wehoop URL; windows burn-in 2008-09, selection 2010-17, confirmation 2018-; 40 min | LIVE |
| `basketball/ingest.js` | Schedules/results → CSV. Exhibition filter :42,:55; data-pack additions :87-115 (no exhibition filter) | LIVE |
| `basketball/model.js` | `PointsRatings` (Massey o/d with decaying weights and a ridge pull to prior) :38-108; `Elo` baseline :110-123 | LIVE (Elo used only as validation baseline) |
| `basketball/walkforward.js` | Tuning grid :183-207; calibration :128-163; candidate choice :230-232; live params :257-262 | LIVE (weekly) |
| `basketball/params/wnba_tuning.json` | half_life 365, prior_games 4, carry 0.8 (+ hand-set k_mu 40, k_h 150); Elo k 28, hfa 60, revert 0.5 | LIVE input |
| `basketball/params/wnba_live.json` | Ratings through 2026-10-17, generated 2026-10-19T00:12Z, model `points`, calibration `bb_cal_v2_home_intercept` | LIVE input to card |
| `basketball/build_slate.js` | `priceGame` = card numbers | LIVE (daily) |
| `basketball/slate.json` (wnba) | Generated 2026-10-20T14:18Z; one game (G3) | LIVE |
| `basketball/validation/wnba_walkforward.json` | Outcome validation; source of the PROVISIONAL / OUTCOME_VALIDATED labels on the card | LIVE |
| `engine/registry.json:985-1100` | Readiness: ML EXPERIMENTAL, spread/total OUTCOME_VALIDATED, market NOT_TESTED; not_modelled: availability, travel | LIVE (labels) |
| `lib/edgedesk_projections.js:436-469` | Contract adapter (copy inlined in edgedesk_ai) | LIVE |
| `lib/edgedesk_research_grade.js:135` | A–F research grade config for WNBA (both graded games scored F 39/100) | LIVE |
| `lib/edgedesk_performance.js:259-273` | Grader: projected margin = −fair line (rounded), projected total = expected | LIVE |
| `lib/edgedesk_card_feed.js:70,76` | Lists `wnba`, but reads `today/slate.json`, which has no WNBA. The ESPN feed list `lib/edgedesk_games.js:73-88` omits WNBA, and `tools/slate/artifacts.js:81,97` maps only nba/ncaam from the basketball slate | DEAD for WNBA |
| `lib/edgedesk_sport_adapters.js:100-105`, `edgedesk_ai/index.ts:35442-35448` | Describe WNBA stats as "points ratings, **rest**". Rest is not in the price | Descriptive only (claim is wrong) |
| `edgedesk_ai/index.ts:2003-2006` | WNBA module `CORE_ONLY`: "No WNBA availability, pace or efficiency tables" | LIVE (AI desk) |
| `app.html:19896` | Says "Capture scope is MLB, **WNBA**, MMA and NCAAF". False (see §7) | Stale UI text |
| `app.html:12718` / `public.model_props` | "model prop projections (MLB/WNBA)". `supabase/props_factory.sql:41` says model_props is "written by deployed functions". No writer source is in the repo | ORPHAN / unauditable |
| `basketball/ncaam_research/*` | NCAAM only | n/a |

**GitHub Actions (cron is UTC)**

| Workflow | Schedule | WNBA effect | Status |
|---|---|---|---|
| `lab-build.yml` | `17 9 * * *` (:10) | Ingest current season, rebuild slate/registry/board. **Ratings are NOT refit.** | LIVE |
| `lab-validate.yml` | `47 11 * * 3` (:10) | Ingest all seasons, run walk-forward, write **wnba_live.json**, run validation | LIVE. The only scheduled refresher of ratings |
| `lab.yml` | PR / push | Tests and `--check` | CI |
| `projections-build.yml` | `55 */3 * * *` (:10) | Freeze projections and append to ledger | LIVE |
| `projections.yml` | PR | Tests | CI |
| `performance.yml` | `19 * * * *` (:43) + after NHL build | Capture forecasts, settle results, grade; optional Supabase mirror (:100-101 → `public.perf_*`, `supabase/model_performance.sql:30-123`) | LIVE |
| `injury-sync.yml`, `availability-sync.yml` | 6-hourly etc. | NFL/CFB only. No WNBA | n/a |

**Supabase**

- `public.odds_api_sports` (`supabase/odds_api_gateway.sql:93-105`) lists NFL, NCAAF, MMA and MLB. There is **no `basketball_wnba` row**, so the gateway refuses WNBA odds.
- `capture` edge function `DEFAULT_SPORTS` (`supabase/functions/capture/index.ts:2561`) excludes WNBA.
- pg_cron `capture_near` / `capture_day` / `capture_board` (`supabase/capture_cron.sql:65-67`) therefore never fetch WNBA. The same holds for the `close` edge function.
- **No pg_cron job, edge function or table produces any WNBA number.** Supabase only receives WNBA projections downstream: `projection_snapshots`, written by `edgedesk_ai` when a user asks, and the optional `perf_*` mirror.

### 2. Priors: carryover, ridge pull, decay

**Mechanics (`basketball/model.js`)**

- Season start (:51-58): each team's prior is `po = carry·o_end_last_season`, `pd = carry·d_end`, with **carry = 0.8** (:53). A new or expansion team gets prior 0, i.e. league average (:48). Last season's games leave the fit entirely (`this.games = []`, :54).
- League level and home court are pulled toward last season's values: `muPrior = mu`, `hPrior = h` (:55-56).
- In-season refit (:75-105) uses game weights `w_i = exp(−ln2/365 · age_days)` (:79; half-life 365 days, so in-season decay is mild) and three ridge pulls:
  - team ratings: `o = (Σ w·resid + P·po)/(Σw + P)` with **P = 4 games** (:91-92);
  - league level: `mu = (Σw·resid + 40·muPrior)/(Σw + 40)` (:102);
  - home court: `h = (Σw·resid + 150·hPrior)/(Σw + 150)` (:103).
- The prior's share of a rating is `P/(Σw + P)`.

**Prior weight after n games** (2026 cadence of about 3.3 days per game, 15 teams, so 7.5n league games):

| Games per team | Σw (team) | Team-rating prior share | mu prior share (k=40) | h prior share (k=150) |
|---|---|---|---|---|
| 5 | 4.92 | **44.8%** | 52.0% | 80.2% |
| 15 | 14.32 | **21.8%** | 27.1% | 58.3% |
| 30 | 27.36 | **12.8%** | 16.3% | 42.2% |
| 50 (Finals) | 42.94 | 8.5% (measured 8.4–8.6%: GSV Σw 43.64, ATL 42.72) | 11.0% | 31.8% |

**Fitted or hand-set**

- half_life, prior_games and carry are **fitted**: grid search on 2010-2017 moneyline log loss (`walkforward.js:183-194`; `wnba_tuning.json`).
- The grid is flat. 365 d/4/0.8 scores 0.61255 against 0.61261 for 365/4/0.6 and 0.61268 for 120/4/0.6. Both 365 and 0.8 sit at the **edge** of the grid.
- The grid was tuned on a 12-team, 34-game league. 2026 has 15 teams and 44 games.
- **k_mu = 40, k_h = 150 and sweeps = 3 are hand-set** (`model.js:34` DEFAULTS; never in the grid).

**Do preseason priors dominate mid-season?** No. By the Finals the carried prior moves the card margin by only about 0.28 pt (§5, row 14). The real damage is **early season, and the carry ignores roster change**:

- 2026 games where either team had played fewer than 5 games (n = 41) scored **log loss 0.7686**. That is worse than a coin flip (0.6931), worse than the constant home-rate baseline (0.7232) and worse than Elo (0.7528).
- 2018-25 for the same bucket was 0.6260. From 5–14 games, 2026 recovers to 0.5837 (my replay, `wnba_work/early.js`).
- Carried priors missed final 2026 net rating (o+d) by up to 7.6 pts:

| Team | Prior net | Final 2026 net | Miss |
|---|---|---|---|
| Toronto (expansion) | 0 | −7.63 | −7.63 |
| Dallas | −4.38 | +2.91 | +7.30 |
| Seattle | +1.28 | −5.77 | −7.05 |
| Golden State | +0.80 | +6.67 | +5.87 |
| Phoenix | +2.04 | −2.65 | −4.68 |
| Portland (expansion) | 0 | −4.00 | −4.00 |

- At 44.8% prior share, a 7-pt miss is still about 3.1 pts of rating error (about 2.7 pts of card margin) after 5 games, and about 0.9 pts after 30 games.

**Side effect of the mu prior.** mu stays anchored near last season (81.16 per team) while 2026 scoring rose about 10 points per game: mean total 173.8 in 2026 against 163–165 in 2023–25. The jump was absorbed into team ratings (mean o = +2.83, mean d = −2.85 across active teams). So "mu = league average" (`model.js:5-6`) is false in 2026. Next season's carried priors will also inherit about +2.3 o / −2.3 d of scoring level.

### 3. Personnel: injuries, rotations, star absences, trades

Personnel is **not handled at all and never applied to the price.**

- The only inputs are team IDs, scores, dates and the neutral flag (`basketball/config.js:56-57` COLUMNS; `ingest.js:40`).
- Caveat text: "No lineup, injury or rest-of-roster input: a star's absence is not in the number" (`walkforward.js:276`).
- The card carries `data_quality.lineup: 'UNKNOWN — no availability feed'` and the invalidator "A star or starter ruled out: availability is not modelled" (`build_slate.js:98-99`).
- The contract hard-codes `availability: {certainty:'UNKNOWN', injuries:'availability is not modelled'}` (`lib/edgedesk_projections.js:459`).
- The board adds `lineup_sd 0.02` only to its "conservative" probability band (`engine/board.json` WNBA rows; `lib/edgedesk_projections.js:457`). **The fair price is unchanged.**
- The registry lists availability and travel as `not_modelled` (`engine/registry.json` WNBA brain); the AI desk module says "availability is the single highest-value missing input" (`edgedesk_ai/index.ts:2005`).
- No WNBA injury, roster, transaction or minutes pipeline exists. `injury-sync.yml` and `availability-sync.yml` cover football only.
- **Trades and roster churn** affect the price only through a uniform carry of 0.8 (see §2).

### 4. Home court, rest, back-to-backs, travel

**Home court is blended, never shown as a component.**

| Parameter | Value | Source |
|---|---|---|
| Ratings h | 2.033 pts (ridge to last season, k_h = 150, so a slow multi-season average) | `model.js:100-103`; `wnba_live.json` `ratings.h` |
| Margin calibration | `mu_card = a·home + b·m`, a = 0.549, b = 0.8738, fitted on 2023-25 out-of-sample rows, home games only | `walkforward.js:98-104, 133, 153` |
| Effective card home edge | a + b·h = 0.549 + 0.8738·2.033 = **2.33 pts** | derived |
| Effective win-prob home edge | logit 0.0105 + 0.1261·2.033 = 0.267, i.e. **56.6%** for equal teams | `walkforward.js:131, 155`; `build_slate.js:48` |

- Observed home margin: 2023 2.07, 2024 1.26, 2025 2.67, 2026 1.92 (regular season 1.77, n = 331; playoffs 4.17, n = 18). The 2023-26 average is about 2.0, so the card is about **0.3–0.4 pt high** (about 1 s.e.). This is not an NFL-sized error.
- In the Finals the teams are rated within 0.17 pts of each other, so **the entire card line (−2 / −2.5) is home court** (§5).
- Data defects in the home-court history:
  - The 2020 bubble season has all 147 games flagged `neutral=0` (`basketball/data/wnba/2020.csv`). Observed home margin that year was 0.47, which dragged h from 3.34 to 1.92 and then 1.16 in 2021 through the chained prior.
  - Playoffs get no separate home-court term.

**Rest and back-to-backs**

- Back-to-back means a start within 30 h (`walkforward.js:77`, `build_slate.js:41-42`).
- The `points_rest` candidate lost at selection (log loss 0.61282 vs 0.61259; `wnba_walkforward.json` selection).
- The live model is `points`, so `rest = false` in `build_slate.js:44`, and `calibration.rest_points = −0.233` is **unused**.
- The card displays `inputs.back_to_back` but the price ignores it. The adapters still advertise "rest" as a stat (`lib/edgedesk_sport_adapters.js:102`).

**Travel and time zones** are not modelled (`engine/registry.json` `not_modelled: ["availability","travel"]`).

### 5. The three biggest disagreements, fully decomposed

**No closing line exists for any WNBA game anywhere in the repo.**

- The gateway allowlist has no `basketball_wnba` row (`supabase/odds_api_gateway.sql:100-105`).
- `capture` `DEFAULT_SPORTS` excludes WNBA (`capture/index.ts:2561`).
- The free ESPN/DraftKings reference in `today/slate.json` has no WNBA feed (`lib/edgedesk_games.js:73-88`; its `sports` block lists nfl/cfb/nba/ncaam/nhl/mlb/ncaabase/mma only).
- All 5 WNBA forecast revisions have `"quote": null` (`performance/ledger/forecasts/wnba-2026.jsonl`).
- Research grades carry `NO_PREGAME_MARKET` / `market_status: NOT_ON_SLATE` (`performance/data/grades/games/wnba-2026.json`).
- The data-pack WNBA raw files (2024 scoreboards and summaries) contain no `odds` or `pickcenter` block.
- The walk-forward says so too: "no licensed archive of timestamped closing prices is on file" (`wnba_walkforward.json` markets.*.market_reason).

**The best labelled comparison available is the walk-forward's own Elo baseline** (FiveThirtyEight form: k = 28, hfa = 60, revert 0.5, tuned 2010-17), plus the actual result.

- Elo is **not a market**. It is the baseline the protocol uses to decide PROVISIONAL vs VALIDATED.
- Elo probability is converted to a margin with the card's own margin sd: `m_elo = 12.516·Φ⁻¹(p_elo)`.
- Two sets are decomposed:
  - **(A)** The only three games with a committed card record. These are all WNBA rows in `engine/projections_ledger/2026-10.jsonl`, which starts 2026-10-15; nothing earlier in 2026 was ever logged. Each is reproduced exactly from the params of its day.
  - **(B)** The three largest model-vs-Elo gaps among the 48 games from 2026-09-01 onward, from the point-in-time walk-forward replay.
- In every table the components sum exactly to the card margin. The only unattributed residual is rounding to the 0.5 fair line (row 16).

#### 5A. The published cards (WNBA Finals)

**Finals G1 401918305 - Atlanta Dream @ Golden State Valkyries, 2026-10-17 (card from params 2026-10-14, data through 10-09, calibration v1)**

| # | Component | Arithmetic | Value |
|---|---|---|---|
| 1 | League intercept mu (fitted; NOT the 2026 league average of 86.9/team) | ratings.mu | 81.160 |
| 2 | Home court in ratings, h | ratings.h (each side gets h/2 = 1.014) | 2.028 |
| 3 | Home offence o_H / home defence d_H | rating (n=50 games, weight sum 43.3) | -2.013 / 8.646 |
| 4 | Away offence o_A / away defence d_A | rating (n=49 games, weight sum 42.3) | 7.017 / -0.131 |
| 5 | Raw home points | mu + h/2 + o_H - d_A = 81.160 + 1.014 + (-2.013) - (-0.131) | 80.292 |
| 6 | Raw away points | mu - h/2 + o_A - d_H = 81.160 - 1.014 + 7.017 - 8.646 | 78.517 |
| 7 | Raw margin m | h + (o_H+d_H) - (o_A+d_A) = 2.028 + 6.633 - 6.886 | 1.776 |
| 8 | Card margin: calibration intercept (home games only) | a | +0.546 |
| 9 | Card margin: home court | b*h = 0.8740*2.028 | +1.772 |
| 10 | Card margin: home team strength | b*(o_H+d_H) = 0.8740*6.633 | +5.797 |
| 11 | Card margin: away team strength | -b*(o_A+d_A) = -0.8740*6.886 | -6.018 |
| 12 | **Card projected margin** (sum 8-11) | 0.546 +1.772 +5.797 -6.018 | **2.098** |
| 13 | of which calibration shrink vs raw | a + (b-1)*m = 0.546 + (-0.1260)*1.776 | +0.322 |
| 14 | of which last-season prior (ridge, carry 0.8) | b*[P*(po+pd)/(sw+P)]_H - same_A; prior share H 8.5%, A 8.6% | -0.278 |
| 15 | Fair home line | -round(2*2.098)/2 | -2.0 |
| 16 | Unattributed residual (line vs margin; rounding only) | -2.0 + 2.098 | +0.098 |
| 17 | Raw total t | 2mu + (o_H-d_A) + (o_A-d_H) | 158.809 |
| 18 | Card total | a_T + b_T*t = 47.952 + 0.7100*158.809 (shrinks toward a_T/(1-b_T) = 165.4) | 160.71 (fair 160.5) |
| 19 | Card projected score | (total +/- margin)/2 | 81.40 - 79.31 |
| 20 | Win prob (logistic, separate fit) | sig(0.0078 + 0.1262*1.776) | 0.5577 (fair -126) |
| 21 | P(margin>0) from the card's own spread distribution | 1-Phi((0-2.098)/12.516) | 0.5666 (gap -0.9 pp) |
| 22 | Comparison: Elo baseline (NOT a market line) | p_elo 0.6024 -> 12.516*Phi^-1(p) | +3.25 pts (model - Elo = -1.15) |
| 23 | Published card (ledger) | p / line / total / exp total | p 0.5577 / -2.0 / 160.5 / 160.7 |
| 24 | Outcome | final 68-64 (home margin +4, total 132) | |

**Finals G2 401918306 - Atlanta Dream @ Golden State Valkyries, 2026-10-19 (card from params 2026-10-19 00:12, data through 10-17, calibration v2)**

| # | Component | Arithmetic | Value |
|---|---|---|---|
| 1 | League intercept mu (fitted; NOT the 2026 league average of 86.9/team) | ratings.mu | 81.164 |
| 2 | Home court in ratings, h | ratings.h (each side gets h/2 = 1.017) | 2.033 |
| 3 | Home offence o_H / home defence d_H | rating (n=51 games, weight sum 43.6) | -2.274 / 8.945 |
| 4 | Away offence o_A / away defence d_A | rating (n=50 games, weight sum 42.7) | 6.698 / 0.140 |
| 5 | Raw home points | mu + h/2 + o_H - d_A = 81.164 + 1.017 + (-2.274) - 0.140 | 79.767 |
| 6 | Raw away points | mu - h/2 + o_A - d_H = 81.164 - 1.017 + 6.698 - 8.945 | 77.901 |
| 7 | Raw margin m | h + (o_H+d_H) - (o_A+d_A) = 2.033 + 6.672 - 6.838 | 1.867 |
| 8 | Card margin: calibration intercept (home games only) | a | +0.549 |
| 9 | Card margin: home court | b*h = 0.8738*2.033 | +1.777 |
| 10 | Card margin: home team strength | b*(o_H+d_H) = 0.8738*6.672 | +5.830 |
| 11 | Card margin: away team strength | -b*(o_A+d_A) = -0.8738*6.838 | -5.976 |
| 12 | **Card projected margin** (sum 8-11) | 0.549 +1.777 +5.830 -5.976 | **2.180** |
| 13 | of which calibration shrink vs raw | a + (b-1)*m = 0.549 + (-0.1262)*1.867 | +0.314 |
| 14 | of which last-season prior (ridge, carry 0.8) | b*[P*(po+pd)/(sw+P)]_H - same_A; prior share H 8.4%, A 8.6% | -0.276 |
| 15 | Fair home line | -round(2*2.180)/2 | -2.0 |
| 16 | Unattributed residual (line vs margin; rounding only) | -2.0 + 2.180 | +0.180 |
| 17 | Raw total t | 2mu + (o_H-d_A) + (o_A-d_H) | 157.668 |
| 18 | Card total | a_T + b_T*t = 47.952 + 0.7100*157.668 (shrinks toward a_T/(1-b_T) = 165.4) | 159.90 (fair 160.0) |
| 19 | Card projected score | (total +/- margin)/2 | 81.04 - 78.86 |
| 20 | Win prob (logistic, separate fit) | sig(0.0105 + 0.1261*1.867) | 0.5612 (fair -128) |
| 21 | P(margin>0) from the card's own spread distribution | 1-Phi((0-2.180)/12.516) | 0.5691 (gap -0.8 pp) |
| 22 | Comparison: Elo baseline (NOT a market line) | p_elo 0.6206 -> 12.516*Phi^-1(p) | +3.84 pts (model - Elo = -1.66) |
| 23 | Published card (ledger) | p / line / total / exp total | p 0.5611 / -2.0 / 160.0 / 159.9 |
| 24 | Outcome | final 65-79 (home margin -14, total 144) | |

**Finals G3 401918307 - Golden State Valkyries @ Atlanta Dream, 2026-10-21 (upcoming; card from the same 10-19 params, G2 NOT absorbed)**

| # | Component | Arithmetic | Value |
|---|---|---|---|
| 1 | League intercept mu (fitted; NOT the 2026 league average of 86.9/team) | ratings.mu | 81.164 |
| 2 | Home court in ratings, h | ratings.h (each side gets h/2 = 1.017) | 2.033 |
| 3 | Home offence o_H / home defence d_H | rating (n=50 games, weight sum 42.7) | 6.698 / 0.140 |
| 4 | Away offence o_A / away defence d_A | rating (n=51 games, weight sum 43.6) | -2.274 / 8.945 |
| 5 | Raw home points | mu + h/2 + o_H - d_A = 81.164 + 1.017 + 6.698 - 8.945 | 79.934 |
| 6 | Raw away points | mu - h/2 + o_A - d_H = 81.164 - 1.017 + (-2.274) - 0.140 | 77.734 |
| 7 | Raw margin m | h + (o_H+d_H) - (o_A+d_A) = 2.033 + 6.838 - 6.672 | 2.199 |
| 8 | Card margin: calibration intercept (home games only) | a | +0.549 |
| 9 | Card margin: home court | b*h = 0.8738*2.033 | +1.777 |
| 10 | Card margin: home team strength | b*(o_H+d_H) = 0.8738*6.838 | +5.976 |
| 11 | Card margin: away team strength | -b*(o_A+d_A) = -0.8738*6.672 | -5.830 |
| 12 | **Card projected margin** (sum 8-11) | 0.549 +1.777 +5.976 -5.830 | **2.471** |
| 13 | of which calibration shrink vs raw | a + (b-1)*m = 0.549 + (-0.1262)*2.199 | +0.272 |
| 14 | of which last-season prior (ridge, carry 0.8) | b*[P*(po+pd)/(sw+P)]_H - same_A; prior share H 8.6%, A 8.4% | +0.276 |
| 15 | Fair home line | -round(2*2.471)/2 | -2.5 |
| 16 | Unattributed residual (line vs margin; rounding only) | -2.5 + 2.471 | -0.029 |
| 17 | Raw total t | 2mu + (o_H-d_A) + (o_A-d_H) | 157.668 |
| 18 | Card total | a_T + b_T*t = 47.952 + 0.7100*157.668 (shrinks toward a_T/(1-b_T) = 165.4) | 159.90 (fair 160.0) |
| 19 | Card projected score | (total +/- margin)/2 | 81.19 - 78.71 |
| 20 | Win prob (logistic, separate fit) | sig(0.0105 + 0.1261*2.199) | 0.5715 (fair -133) |
| 21 | P(margin>0) from the card's own spread distribution | 1-Phi((0-2.471)/12.516) | 0.5783 (gap -0.7 pp) |
| 22 | Comparison: Elo baseline (NOT a market line) | p_elo 0.5495 -> 12.516*Phi^-1(p) | +1.56 pts (model - Elo = +0.91) |
| 23 | Published card (ledger) | p / line / total / exp total | p 0.5715 / -2.5 / 160.0 / 159.9 |
| 24 | Outcome | not played (scheduled 2026-10-22T00:00Z) | |


**G3 if the ratings were refreshed** (all finals through 10-19, so G2 absorbed; same code):

| Component | Value |
|---|---|
| mu | 81.159 |
| h | 2.000 |
| ATL o/d | 6.722 / 0.443 |
| GSV o/d | −2.550 / 8.939 |
| Raw margin m | 2.777 |
| Card margin | 0.549 + 1.748 + 6.261 − 5.582 = **2.975** |
| Fair line | **−3.0** |
| p_home | **0.5892** (fair −143) |
| Total | 159.50 |
| Elo p (refreshed) | 0.6165 |

The live G3 card (−2.5, 0.5715, −133) omits G2, a 14-point Atlanta road win. It is 0.5 pt and 1.8 pp stale and will stay so until the next `lab-validate` run (Wed 2026-10-21 11:47 UTC; the 10-14 run landed 4 h late at 15:59). G4 (10-24) would likewise be priced without G3, and G5 without G4.

**5A results**

| Game | Card | Elo | Result | Model miss |
|---|---|---|---|---|
| G1 | GSV −2 / 55.8% | GSV −3.2 / 60.2% | GSV +4 | Margin 1.9; total **28.7** (160.7 v 132) |
| G2 | GSV −2 / 56.1% | GSV −3.8 / 62.1% | ATL +14 | Margin **16.2**; total 15.9 (159.9 v 144); log loss 0.823 |
| G3 | ATL −2.5 / 57.2% | ATL −1.6 / 54.9% (stale) | pending | — |

- Model-vs-Elo gaps are small (−1.15, −1.66, +0.91 pts).
- The story is the **total**. The ratings say 157.7–158.8 and the frozen calibration pushes the card up to 159.9–160.7 (row 18), while these two defences produced 132 and 144.
- October 2026 games averaged a 160.3 total against a calibrated projection bias of **+6.5** (n = 10). The model has no playoff term.

#### 5B. Largest model-vs-Elo disagreements, Sept–Oct 2026 (walk-forward replay)

These use point-in-time ratings, refit daily. No card was logged for them, so they are the model as validated, not as published. The raw margin in each table matches the replay row exactly (`check_m`).

**Walk-forward 401857200 - Seattle Storm @ Golden State Valkyries, 2026-09-19 (point-in-time replay; no card was logged for this game)**

| # | Component | Arithmetic | Value |
|---|---|---|---|
| 1 | League intercept mu (fitted; NOT the 2026 league average of 86.9/team) | ratings.mu | 81.178 |
| 2 | Home court in ratings, h | ratings.h (each side gets h/2 = 0.926) | 1.852 |
| 3 | Home offence o_H / home defence d_H | rating (n=41 games, weight sum 35.8) | -2.199 / 8.955 |
| 4 | Away offence o_A / away defence d_A | rating (n=41 games, weight sum 35.5) | -1.339 / -4.143 |
| 5 | Raw home points | mu + h/2 + o_H - d_A = 81.178 + 0.926 + (-2.199) - (-4.143) | 84.048 |
| 6 | Raw away points | mu - h/2 + o_A - d_H = 81.178 - 0.926 + (-1.339) - 8.955 | 69.958 |
| 7 | Raw margin m | h + (o_H+d_H) - (o_A+d_A) = 1.852 + 6.756 - (-5.482) | 14.090 |
| 8 | Card margin: calibration intercept (home games only) | a | +0.549 |
| 9 | Card margin: home court | b*h = 0.8738*1.852 | +1.618 |
| 10 | Card margin: home team strength | b*(o_H+d_H) = 0.8738*6.756 | +5.904 |
| 11 | Card margin: away team strength | -b*(o_A+d_A) = -0.8738*(-5.482) | +4.790 |
| 12 | **Card projected margin** (sum 8-11) | 0.549 +1.618 +5.904 +4.790 | **12.861** |
| 13 | of which calibration shrink vs raw | a + (b-1)*m = 0.549 + (-0.1262)*14.090 | -1.228 |
| 14 | of which last-season prior (ridge, carry 0.8) | b*[P*(po+pd)/(sw+P)]_H - same_A; prior share H 10.1%, A 10.1% | -0.043 |
| 15 | Fair home line | -round(2*12.861)/2 | -13.0 |
| 16 | Unattributed residual (line vs margin; rounding only) | -13.0 + 12.861 | -0.139 |
| 17 | Raw total t | 2mu + (o_H-d_A) + (o_A-d_H) | 154.006 |
| 18 | Card total | a_T + b_T*t = 47.952 + 0.7100*154.006 (shrinks toward a_T/(1-b_T) = 165.4) | 157.30 (fair 157.5) |
| 19 | Card projected score | (total +/- margin)/2 | 85.08 - 72.22 |
| 20 | Win prob (logistic, separate fit) | sig(0.0105 + 0.1261*14.090) | 0.8566 (fair -597) |
| 21 | P(margin>0) from the card's own spread distribution | 1-Phi((0-12.861)/12.516) | 0.8479 (gap +0.9 pp) |
| 22 | Comparison: Elo baseline (NOT a market line) | p_elo 0.9260 -> 12.516*Phi^-1(p) | +18.11 pts (model - Elo = -5.25) |
| 24 | Outcome | final home margin +13, total 127 | |

**Walk-forward 401857216 - Chicago Sky @ Washington Mystics, 2026-09-24 (point-in-time replay; no card was logged for this game)**

| # | Component | Arithmetic | Value |
|---|---|---|---|
| 1 | League intercept mu (fitted; NOT the 2026 league average of 86.9/team) | ratings.mu | 81.170 |
| 2 | Home court in ratings, h | ratings.h (each side gets h/2 = 0.932) | 1.865 |
| 3 | Home offence o_H / home defence d_H | rating (n=43 games, weight sum 37.6) | -0.777 / 1.514 |
| 4 | Away offence o_A / away defence d_A | rating (n=43 games, weight sum 37.4) | 2.150 / -6.295 |
| 5 | Raw home points | mu + h/2 + o_H - d_A = 81.170 + 0.932 + (-0.777) - (-6.295) | 87.620 |
| 6 | Raw away points | mu - h/2 + o_A - d_H = 81.170 - 0.932 + 2.150 - 1.514 | 80.874 |
| 7 | Raw margin m | h + (o_H+d_H) - (o_A+d_A) = 1.865 + 0.737 - (-4.144) | 6.746 |
| 8 | Card margin: calibration intercept (home games only) | a | +0.549 |
| 9 | Card margin: home court | b*h = 0.8738*1.865 | +1.629 |
| 10 | Card margin: home team strength | b*(o_H+d_H) = 0.8738*0.737 | +0.644 |
| 11 | Card margin: away team strength | -b*(o_A+d_A) = -0.8738*(-4.144) | +3.622 |
| 12 | **Card projected margin** (sum 8-11) | 0.549 +1.629 +0.644 +3.622 | **6.444** |
| 13 | of which calibration shrink vs raw | a + (b-1)*m = 0.549 + (-0.1262)*6.746 | -0.302 |
| 14 | of which last-season prior (ridge, carry 0.8) | b*[P*(po+pd)/(sw+P)]_H - same_A; prior share H 9.6%, A 9.7% | +0.300 |
| 15 | Fair home line | -round(2*6.444)/2 | -6.5 |
| 16 | Unattributed residual (line vs margin; rounding only) | -6.5 + 6.444 | -0.056 |
| 17 | Raw total t | 2mu + (o_H-d_A) + (o_A-d_H) | 168.493 |
| 18 | Card total | a_T + b_T*t = 47.952 + 0.7100*168.493 (shrinks toward a_T/(1-b_T) = 165.4) | 167.59 (fair 167.5) |
| 19 | Card projected score | (total +/- margin)/2 | 87.02 - 80.57 |
| 20 | Win prob (logistic, separate fit) | sig(0.0105 + 0.1261*6.746) | 0.7029 (fair -237) |
| 21 | P(margin>0) from the card's own spread distribution | 1-Phi((0-6.444)/12.516) | 0.6967 (gap +0.6 pp) |
| 22 | Comparison: Elo baseline (NOT a market line) | p_elo 0.8202 -> 12.516*Phi^-1(p) | +11.47 pts (model - Elo = -5.02) |
| 24 | Outcome | final home margin +8, total 194 | |

**Walk-forward 401857202 - New York Liberty @ Toronto Tempo, 2026-09-20 (point-in-time replay; no card was logged for this game)**

| # | Component | Arithmetic | Value |
|---|---|---|---|
| 1 | League intercept mu (fitted; NOT the 2026 league average of 86.9/team) | ratings.mu | 81.183 |
| 2 | Home court in ratings, h | ratings.h (each side gets h/2 = 0.940) | 1.880 |
| 3 | Home offence o_H / home defence d_H | rating (n=41 games, weight sum 35.7) | 2.359 / -8.874 |
| 4 | Away offence o_A / away defence d_A | rating (n=42 games, weight sum 36.4) | 5.466 / -2.397 |
| 5 | Raw home points | mu + h/2 + o_H - d_A = 81.183 + 0.940 + 2.359 - (-2.397) | 86.879 |
| 6 | Raw away points | mu - h/2 + o_A - d_H = 81.183 - 0.940 + 5.466 - (-8.874) | 94.582 |
| 7 | Raw margin m | h + (o_H+d_H) - (o_A+d_A) = 1.880 + (-6.515) - 3.069 | -7.703 |
| 8 | Card margin: calibration intercept (home games only) | a | +0.549 |
| 9 | Card margin: home court | b*h = 0.8738*1.880 | +1.643 |
| 10 | Card margin: home team strength | b*(o_H+d_H) = 0.8738*(-6.515) | -5.693 |
| 11 | Card margin: away team strength | -b*(o_A+d_A) = -0.8738*3.069 | -2.682 |
| 12 | **Card projected margin** (sum 8-11) | 0.549 +1.643 -5.693 -2.682 | **-6.183** |
| 13 | of which calibration shrink vs raw | a + (b-1)*m = 0.549 + (-0.1262)*(-7.703) | +1.521 |
| 14 | of which last-season prior (ridge, carry 0.8) | b*[P*(po+pd)/(sw+P)]_H - same_A; prior share H 10.1%, A 9.9% | -0.222 |
| 15 | Fair home line | -round(2*-6.183)/2 | 6.0 |
| 16 | Unattributed residual (line vs margin; rounding only) | 6.0 + (-6.183) | -0.183 |
| 17 | Raw total t | 2mu + (o_H-d_A) + (o_A-d_H) | 181.461 |
| 18 | Card total | a_T + b_T*t = 47.952 + 0.7100*181.461 (shrinks toward a_T/(1-b_T) = 165.4) | 176.79 (fair 177.0) |
| 19 | Card projected score | (total +/- margin)/2 | 85.31 - 91.49 |
| 20 | Win prob (logistic, separate fit) | sig(0.0105 + 0.1261*-7.703) | 0.2767 (fair +261) |
| 21 | P(margin>0) from the card's own spread distribution | 1-Phi((0-(-6.183))/12.516) | 0.3107 (gap -3.4 pp) |
| 22 | Comparison: Elo baseline (NOT a market line) | p_elo 0.1914 -> 12.516*Phi^-1(p) | -10.92 pts (model - Elo = +4.74) |
| 24 | Outcome | final home margin -37, total 175 | |

**5B results**

| Game | Model | Elo | Result | Model error | Elo error |
|---|---|---|---|---|---|
| 401857200 | GSV −13 (12.86) | −18.1 | GSV +13 | 0.1 | 5.1 |
| 401857216 | WAS −6.5 (6.44) | −11.5 | WAS +8 | 1.6 | 3.5 |
| 401857202 | TOR +6 (NYL −6.18) | NYL −10.9 | NYL +37 | 30.8 | 26.1 |

- **The model was nearer the result in 2 of 3.**
- All three big gaps share one pattern: Elo is more extreme on mismatches. The model shrinks margins by b = 0.874 (row 13: −1.2 / −0.3 / +1.5 pts), and late-season Elo has had 40+ updates at k = 28.
- In none of the three does the carried prior matter (row 14: ≤ 0.30 pt).
- Across all 349 2026 games:
  - |model − Elo| averages 1.72 pts (median 1.49, p90 3.56, max 5.92).
  - Elo-implied margin MAE is 10.13 against 10.20 for the model.
  - Elo log loss is 0.59795 against 0.60176 (`wnba_walkforward.json` windows.live).
- **In 2026 the WNBA model did not beat its own Elo baseline.**

### 6. Card consistency

The card (`basketball/slate.json` → contract) publishes p_home, fair ML, projected margin, fair line with a ±1 cover ladder, projected and fair total with a ±2 ladder, and the projected score. **It publishes no component breakdown.** The components below are reconstructed from params.

| Check | G1 | G2 | G3 | Worst over 349 replayed 2026 games |
|---|---|---|---|---|
| Components (intercept + home court + home team + away team) sum to card margin | 0.000 | 0.000 | 0.000 | 0.000 (algebraic identity) |
| Fair line vs card margin (rounding to 0.5) | +0.10 | +0.18 | −0.03 | 0.249 |
| Projected score: home−away = margin, home+away = total | exact (81.40−79.31) | exact (81.05/78.85 in ledger) | exact | exact (`lib/edgedesk_projections.js:453`) |
| Projected score vs what the ratings say | card total +1.90 over raw 158.81 | +2.23 over 157.67 | +2.23 | — (calibration shrink toward 165.4, row 18) |
| Win prob vs fair ML (convert back) | −126 → 0.5575 vs 0.5577 | −128 → 0.5614 vs 0.5611 | −133 → 0.5708 vs 0.5715 | 0.0012 (integer-odds rounding) |
| **Win prob (logistic) vs P(margin > 0) from the card's own spread distribution** | −0.9 pp | −0.8 pp | −0.7 pp | **−3.4 pp** (401856985: 0.253 vs 0.287); 1.43 pts in margin terms (road favourites; e.g. 401857049: spread margin −11.16 vs ML-implied −12.59); mean 0.54 pt |
| Spread ladder centred on projection | at −2: home 0.4872 / push 0.0319 / away 0.4810 | at −2: 0.4898 / 0.0319 / 0.4783 | at −2.5: 0.4991 / 0 / 0.5009 | ladder centred on the **rounded** line; distribution N(mu, 12.516) symmetric by construction |
| 80% outcome range | not published | not published | not published | Realised 2026 coverage of the card's own sd: margin 0.776, total **0.724** (target 0.77–0.83): range too narrow, not off-centre |
| Graded "projected margin" | 2.0 (−fair line) vs card 2.1 | 2.0 vs 2.2 | — | Up to 0.25 pt (`lib/edgedesk_performance.js:259-264`). The two graded records also disagree on total: perf uses 159.9, research grade uses 160 |

**Verdict**

- Components sum; there is **no unattributed residual** beyond rounding.
- The outcome distribution is centred on the projection.
- The real inconsistency is internal. The moneyline (a separate logistic fit, `walkforward.js:131`) and the spread ladder (normal on a separate OLS fit, `:133, :136`) **imply different medians**, by up to 3.4 pp or 1.4 pts. The gap is asymmetric: the ML is more bullish on road favourites.

### 7. Measured vs logged

**Closing lines captured: none.** There is no table, no job and 0% coverage (§5 evidence). `performance/data/summary.json` → `wnba.verified.market`: spread n = 0, total n = 0, moneyline n = 0. **CLV is not computed and cannot be computed.**

**Results settled:** 2 games (`performance/ledger/results/wnba-2026.jsonl`).

- The only source is `basketball/data/wnba` (`match: "NOT_ON_SLATE"`). Contrary to `performance.yml:15` "sources must agree", there is no second source because WNBA is not on `today/slate.json`.
- Graded: 2 (`performance/ledger/grades/wnba-2026.jsonl`).

| Game | Brier | Log loss | Margin abs err | Total abs err |
|---|---|---|---|---|
| G1 | 0.1956 | 0.5839 | 2 | 28.7 |
| G2 | 0.3148 | 0.8235 | 16 | 15.9 |

- The public page marks the sample TOO_EARLY (min_n 20).
- README.md:570 says every eligible forecast in every per-game-model sport, WNBA included, is "locked before the start and graded". For WNBA, the whole 2026 regular season and playoffs up to the Finals were never logged; the ledger starts 2026-10-15.

**Walk-forward metrics (retrospective, outcome-only; never vs close)**

Sources: `basketball/validation/wnba_walkforward.json` (windows.*); MAE, RMSE and early-season figures are from my replay (`wnba_work/mae.js`, `early.js`).

| Window | n | ML log loss (Elo) | Brier (Elo) | Cal-in-the-large | Cal slope | Margin MAE / RMSE | Margin CRPS (home-only base) | Margin cov80 | Total MAE | Total CRPS (base) | Total bias | Total cov80 |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| Selection 2010-17 | 1774 | 0.61259 (0.61669) | 0.21268 | +0.0091 | 1.040 | — | 6.8069 (7.4134) | 0.8038 | — | 9.3041 (10.665) | −0.238 | 0.8174 |
| Confirmation 2018-25 | 1873 | **0.61325 (0.6144)** | 0.21217 (0.21289) | −0.0022 | 0.951 | 9.96 / 12.56 | 7.0615 (7.9068) | 0.8089 | 13.12 | 9.3797 (9.9176) | +0.041 | 0.8003 |
| Live 2026 | 348 | **0.60176 (0.59795: Elo better)** | 0.20648 (0.20528) | −0.0003 | 1.083 | 10.20 / 13.03 | 7.2974 (8.1421) | 0.7759 | **15.22** | 10.8713 (12.8424) | **−4.062** | **0.7241** |

- Model vs Elo on confirmation: Δ log loss −0.001157, 95% CI [−0.008065, +0.005525]. Not significant, hence moneyline **PROVISIONAL** (`comparisons.points_vs_elo`).
- Per season (`by_season`): Elo beat the model in 2025 (0.61364 vs 0.62705) and 2026 (0.59795 vs 0.60176).
- **The 2026 total fails the protocol's own rules** (|bias| 4.06 > 1% of 173.9; cov80 0.724 < 0.77; `engine/lab/protocol.js:67-75`). The card still shows `total: OUTCOME_VALIDATED`, because status is computed on the 2018-25 confirmation window only (`walkforward.js:247-253`).
- The **calibration makes 2026 totals worse than the raw ratings**: MAE 15.22 vs 14.96, CRPS 10.867 vs 10.726, bias −4.01 vs −2.19.
  - `cal[2026]` is fitted on 2023-25 (`walkforward.js:169`) and never refit in-season (`:259`). It shrinks every total 29% toward 165.4 (a = 47.95, b = 0.710).
  - By month: May −2.9, Jun −6.8, Jul −6.5, Aug −1.9, Sep −2.9, Oct **+6.5** (Finals over-projected).
- **Validation vs production gap.** The walk-forward refits daily; production refits weekly. Simulating Wednesday-only refits for 2026 gives log loss 0.60366 vs 0.60239 point-in-time (+0.0013) and total MAE 15.30 vs 15.22 (`wnba_work/replay2.js`). The published validation therefore slightly overstates the deployed model, and in a playoff series the staleness is systematic (§5A).

### 8. Proposed disagreement threshold (model vs close)

The threshold cannot be estimated from repo data because no closes exist. The proposal below is derived from measured model error plus one stated assumption, and must be re-derived once closes are captured.

1. **Model error size.**
   - Realised margin residual sd is 12.56 (2018-25 RMSE) and 13.03 (2026).
   - Assumption: the basketball closing spread's residual sd is about 12.0 (typical; not measurable here).
   - Then the model's own error in the expected margin is about √(12.56² − 12²) ≈ **3.7 pts** (2018-25), or √(13.03² − 12²) ≈ **5.1 pts** (2026).
   - The equivalent for totals: √(16.67² − 15.5²) ≈ 6 pts (2023-25 sd) up to √(18.99² − 17²) ≈ 8.5 pts (2026).
2. **What a disagreement means.** A model with no availability input disagreeing with an informed close by less than about 1σ of its own error (≈ 3.5–4 pts) is indistinguishable from model noise. Above that, the most likely cause is information the model does not own: a star out, rest, a rotation change. In a 12-player WNBA rotation one star moves a line 3–8 pts.
3. **Reference point.** Even against Elo, which shares the same inputs, the model differs by ≥ 3.56 pts only 10% of the time. A gap to the market larger than that almost always means missing information.

**Proposal (spread / total):**

| Band | Spread | Total | Treatment |
|---|---|---|---|
| Noise | \|Δ\| < 2 pts | < 3 pts | No signal |
| Research flag | 2–4 pts | 3–6 pts | Show the gap. Allowed as a lean only after (a) availability is confirmed for both teams and (b) the sport passes a CLV test on ≥ 200 captured closes |
| Check the number | ≥ 4 pts | ≥ 6 pts | Treat as missing information. Never "value" |

Once closes exist, replace the bands with 1× and 1.5× the empirical sd(model − close). Also add the Elo/model spread as a sanity bound.

### 9. Data availability: wanted but not owned

| Feature | Owned? | Evidence / what is missing |
|---|---|---|
| Closing / opening lines, any book | **No** | Not in `odds_api_sports`; not in capture `DEFAULT_SPORTS`; not in ESPN today-slate feeds (§5). There is not even an untimestamped archive |
| Injury report / availability / game-time decisions | **No** | No WNBA pipeline (`injury-sync.yml` is NFL). `edgedesk_ai/index.ts:2005` says so |
| Starting lineups, rotations, minutes | **No** | Schedules only (`config.js:56-57`). Data-pack 2024 sample only: `datapack/quant_v1/data/wnba/player_game_stats_sample.csv` (3,206 rows, `starter`/`did_not_play` columns), not wired |
| Possession-level / play-by-play (pace, ORtg/DRtg, four factors, lineup net rating) | **No** (2024 sample only) | `events_sample.csv` has 4,722 rows from 12 games' summaries. `feature_catalog.csv` defines off_rating, pace, lineup_net_rating as `defined_not_necessarily_populated`. wehoop publishes PBP and box parquet, but `ingest.js` reads schedule columns only |
| Rosters, transactions, trades, expansion draft | **No** | The carry of 0.8 is uniform; expansion teams start at 0 (`model.js:48,53`) |
| Travel / time zones / venue coordinates | **No** | `not_modelled: travel` (registry) |
| Rest / back-to-back | Derivable, yes | Computed (`walkforward.js:77`); not in the chosen model |
| Officials, altitude, Commissioner's Cup / playoff context | **No** | Playoff games are treated like regular-season games (`ingest.js` type P is not used by the model) |
| First-publication timestamps (`known_at`) for results | **No** | Blank by design; validation is RETROSPECTIVE (`wnba_walkforward.json` data.temporal) |
| WNBA player-prop model (`public.model_props`) | Unknown | The writer is not in the repo (`supabase/props_factory.sql:41`) |

### Problems

| Severity | Problem | Evidence (file:line or data) | Impact |
|---|---|---|---|
| Critical | No market data of any kind for WNBA. The model has never been compared with an open or close; CLV is impossible. Fair ML, spread and total are still published on the board, the AI desk and /performance | `supabase/odds_api_gateway.sql:100-105` (no `basketball_wnba`); `supabase/functions/capture/index.ts:2561`; `lib/edgedesk_games.js:73-88`; forecasts `quote:null` ×5; `wnba_walkforward.json` markets.*.market_status NOT_TESTED; perf summary market n = 0 | An NFL-style miss (model 4 pts off the close) cannot be detected. Every "fair" number is unanchored |
| High | Card status says total **OUTCOME_VALIDATED** while the 2026 season fails the same rule. The frozen total calibration made totals worse than raw | `walkforward.js:169,247-253,259`; validation windows.live.total bias −4.062, cov80 0.7241; replay: calibrated MAE 15.22 vs raw 14.96; `wnba_live.json` total {a 47.95, b 0.710} | Totals were biased about −4 pts all season and +6.5 in October; Finals cards 160.7 / 159.9 vs 132 / 144. The label misleads |
| High | No personnel input at all, and a uniform carry of 0.8 ignores roster churn. 2026 early-season log loss 0.7686 is worse than a coin flip and than Elo | `build_slate.js:98-99`; `lib/edgedesk_projections.js:459`; `model.js:53`; replay `early.js` (n = 41); prior misses −7.6 (TOR), +7.3 (DAL), −7.1 (SEA) | First ~2 weeks mispriced by up to ~3 pts of margin; star absences are never priced |
| High | Ratings refit only weekly (`lab-validate.yml` Wed). The daily slate re-prices with stale ratings. Docs claim a refit "whenever a result becomes available" | `lab-build.yml:38-40` (no walkforward); `lab-validate.yml:10,47`; `docs/engine/METHODS.md:58-62`; slate `latest_result` 2026-10-19 vs params `last_game_date` 2026-10-17 | Live G3 card ATL −2.5 / 57.2% vs refreshed −3 / 58.9%. In the Finals each game is priced without the previous one. Validation overstates production (2026 log loss +0.0013) |
| Medium | Moneyline does not beat Elo (confirmation CI crosses 0; Elo better in 2025 and 2026), yet the model ML is the "primary" market on the card with no Elo blend | `wnba_walkforward.json` comparisons.points_vs_elo; by_season 2025/2026; `engine/registry.json` primary moneyline | The published win probability is no better than a free baseline |
| Medium | ML and spread on the same card imply different medians: separate logistic and normal fits | `walkforward.js:131,133,155-159`; replay max gap −3.4 pp / 1.43 pts (401856985, 401857049) | A user reading both markets sees contradictory probabilities; asymmetric for road favourites |
| Medium | Card sd is too narrow for 2026 (margin 12.52 vs realised 13.03; total 16.67 vs 18.99) | `wnba_live.json` sd_margin, sd_total; validation live cov80 0.776 / 0.724 | Cover and over/under ladder probabilities are over-confident |
| Medium | False or stale documentation and UI: "season is over" while the Finals are priced; "refitted whenever a result is available"; README says every forecast is locked and graded (WNBA has n = 2, ledger from 10-15); "Capture scope is MLB, WNBA…"; adapters list "rest" | `docs/sports-calibration/README.md:97-100`; `CHANGELOG.md:125`; `docs/engine/METHODS.md:58-62`; `README.md:570`; `app.html:19896`; `lib/edgedesk_sport_adapters.js:102`; `edgedesk_ai/index.ts:35444` | Known defects dismissed while live; misleading product claims |
| Medium | No playoff context (pace, rotation tightening, playoff home court) | Oct 2026 total bias +6.5 (n = 10); 2026 playoff home margin 4.17 vs model; `ingest.js` type P unused by the model | Finals totals systematically high |
| Low | Effective home edge 2.33 pts (a + b·h) vs observed about 1.9–2.0 (2023-26). Blended and never shown as a component | `wnba_live.json` margin a 0.549, b 0.874, h 2.033; observed home margins from CSVs | About 0.3–0.4 pt home lean, about 1 s.e. |
| Low | mu is not the league average (81.16 vs 2026 actual 86.9). The scoring jump was absorbed into team ratings (mean o +2.83, d −2.85) and will be carried into 2027 priors | `model.js:5-6,102`; `wnba_live.json` | Misleading if components are ever displayed; inflates carried priors |
| Low | Data hygiene: the 2024 All-Star game (Team WNBA 117 – Team USA 109, id 401620458) entered through the data-pack path, which lacks the exhibition filter, and sits in the 2026 calibration window. The 2020 bubble is marked non-neutral (147 games) | `ingest.js:42,55` vs `:87-115`; `basketball/data/wnba/2024.csv`; `2020.csv` neutral = 0 ×147; ghost teams 96/97 in `wnba_live.json` | Small calibration and h contamination |
| Low | Rest and back-to-back are computed and shown but not priced; travel is not modelled | `build_slate.js:44,97`; `wnba_live.json` rest_points −0.233 unused; registry not_modelled | Minor in the WNBA (few back-to-backs) |
| Low | k_mu = 40 and k_h = 150 are hand-set; the tuned optimum sits on the grid edge (365 d, carry 0.8) with a flat grid; tuned on a 12-team, 34-game era | `model.js:34`; `walkforward.js:187`; `wnba_tuning.json` grid | Hyperparameters are weakly identified for 2026's league shape |
| Low | Grader inconsistency: margin graded against the rounded fair line, total against the expectation; perf and research-grade records disagree on projected total; settlement is single-source | `lib/edgedesk_performance.js:259-273`; `performance/data/games` vs `grades/games/wnba-2026.json`; results `match: NOT_ON_SLATE` | Up to 0.25 pt margin-error distortion; unverified finals |
| Low | WNBA player props (`public.model_props`) come from deployed code that is not in the repo | `supabase/props_factory.sql:41`; `app.html:12718` | Unauditable |

*Replay scripts: `docs/model-loop/audit_scripts/wnba/` (replay.js, replay2.js, decomp.js, early.js, mae.js, analyze.py, tables.py).*

---

## CBB (men's college basketball)

Audit date 2026-10-20. Repo `/home/user/EdgeDeskSports` (shallow clone, HEAD `beb1ed28`), read-only. No database access. Everything below comes from code, SQL, workflows and committed artifacts. I also re-ran the engines on committed inputs. The one exception is item 5's market comparison, which uses an external, uncommitted source; it is labelled where it is used. The scripts are in `docs/model-loop/audit_scripts/cbb/` (`s1_incumbent.js` … `s14_cardcases.js`); their large intermediate outputs were not committed.

**Bottom line.** The live CBB number comes from the points-ratings engine (`basketball/model.js`, model id `edgedesk_bb_points_v1:points+bb_cal_v2_home_intercept`). It shares two of the NFL failure modes:

- **Home court too high.** This one is worse than in the NFL and is time-varying. The home-advantage parameter is fitted on every game, including D1-vs-non-D1 "buy" games, so it swells from 3.9 to about 8–9.5 points in November. The card's home-court component reaches about 7 points against an end-of-season value of 2.6 and the research engine's 2.7–3.1.
- **Inflated D1 ratings.** Non-D1 opponents are rated close to the D1 average, which inflates the D1 teams that beat them.

The NFL problem of priors dominating does *not* carry over: the prior weight decays fast (k = 2 games). Personnel is ignored. Components are never shown on the card, but they do sum exactly. The CBB card drops the fair spread and prices only moneylines. No closing line exists anywhere in the repo for CBB.

---

### 1. Inventory

**Which system produces the live card numbers?** The **points-ratings engine** (`basketball/`). The chain is:

1. `basketball/params/ncaam_live.json` → `basketball/build_slate.js` → `basketball/slate.json`
2. → EDPROJ `ADAPTERS.lab_basketball` (`lib/edgedesk_projections.js:436-466`; the same code is inlined in `supabase/functions/edgedesk_ai/index.ts:37207-37238`)
3. → `engine/projections.json` / `engine/projections_ledger/` (`engine/build_projections.js`)
4. → the EdgeDesk Card (`tools/slate/research.js:163-174` `modelFromLab` → `lib/edgedesk_card_feed.js`), the Games page, Discord and the AI desk.

`engine/registry.json` (sport `ncaab_m`) says so explicitly. It describes the research engine as "beats the points ratings on held-out 2025-26 … **not wired to the board**".

**"The other CBB system" is mostly not basketball.** `supabase/cbb_view_grants.sql`, `supabase/cbb_service_role_grants.sql`, `supabase/fix_promote_deletes_cbb.sql`, `supabase/fix_slow_promote_cbb.sql`, `supabase/college_baseball.sql` (schema `cbb`) and `tools/cbb/*` are all **college BASEBALL**: `college_baseball.sql:2` says "COLLEGE BASEBALL — the game log", and `tools/cbb/ingest.js:3` and `tools/cbb/espn_clubs.js:26` read `baseball/college-baseball`. They are irrelevant to this model.

| Component | Path (line refs) | What it does | State |
|---|---|---|---|
| League config | `basketball/config.js:42-47` | `ncaam` → `basketball_ncaab`, registry `ncaab_m`; windows burn-in 2010-11, selection 2012-18, confirmation 2019+ | LIVE |
| Ingest | `basketball/ingest.js:48-84` (neutral flag `:72`, availability = start + 4 h `:76`) | sportsdataverse hoopR schedules (ESPN) → `basketball/data/ncaam/<season>.csv`. All games, **including vs non-D1** | LIVE |
| Rating engine | `basketball/model.js:38-108` (`PointsRatings`), Elo `:110-123` | offence/defence least squares, ridge to prior, `h`, `mu` | LIVE (Elo is a baseline only) |
| Walk-forward + live params | `basketball/walkforward.js` (`pass` 57-86, `calibrate` 128-148, `tune` 183-207, live params 256-262) | writes `params/ncaam_live.json`, `validation/ncaam_walkforward.json` | LIVE (weekly) |
| Tuning | `basketball/params/ncaam_tuning.json` (generated 2026-10-13) | hl 365 d, prior_games 2, carry 0.8 | LIVE (frozen) |
| Slate / card prices | `basketball/build_slate.js:34-56` (`priceGame`), `:58-105` | ML, fair spread ±1 ladder, total ±2 ladder; `value_claims: 'DISABLED'` (`:83`) | LIVE |
| Projection contract | `lib/edgedesk_projections.js:111-117`, `:436-466`; `engine/build_projections.js` | the EDPROJ contract and its ledger | LIVE (every 3 h) |
| Card | `tools/slate/research.js:163-174`, `lib/edgedesk_card_feed.js:172-286` | blends model ML 50/50 with DraftKings no-vig, LEAN/WATCH/PASS | LIVE (**spread dropped, see §6**) |
| Games page | `lib/edgedesk_games_ui.js:759` | "Fair line" row (empty for CBB) | LIVE |
| AI desk | `supabase/functions/edgedesk_ai/index.ts:2304-2360` (CBB layers/intents), `:36882-36888` (sport profile), `:37207` (adapter), `:50908` (`cbb_deep`) | reads the slate. Also reads `team_features` / `matchup_context` / `rankings_current`, which are written by the **deployed-only** `ingest_multisport` (no source or DDL in the repo; `docs/intelligence-audit.md:133`) | LIVE / that layer UNKNOWN |
| Discord | `supabase/functions/discord_cron/index.ts:160` (cbb), `:1135-1195` (`modelLines`, gap `:1168`) | daily CBB slate: EdgeDesk vs ESPN/DraftKings line | LIVE if `DISCORD_WEBHOOK_CBB` is set |
| Performance ledger | `tools/performance/sources.js:50`, close = null for basketball `:155-161`; `lib/edgedesk_performance.js:347-352` (CLV needs a close) | will lock CBB forecasts, last DraftKings quote and results | LIVE (no CBB rows yet; epoch 2026-10-16) |
| Registry / board | `engine/build_registry.js:115`, `engine/build_board.js:179,199` | readiness `OUTCOME_VALIDATED` | LIVE |
| Research engine | `basketball/ncaam_research/*`, `lib/ncaam_research.js`, `research/ncaam/*`, `datapack/ncaam_v1` | adjusted efficiency + tempo + RAPM + transfer/continuity; frozen selection `selection_frozen.json` | SHADOW / research pages only. **Frozen on a static 2024-26 pack, so it cannot run in-season 2026-27** |
| Phantom layer | app.html `CONTRACT_SLOT_UNSOURCED.basketball_ncaab` (`app.html:37456-37459`, `:43590`) | says "No basketball data of any kind is ingested" | STALE text |

**Tables, views, functions and edge functions.** There is no CBB-specific table, view, SQL function or edge function in the repo.

- The paid odds path excludes CBB:
  - `capture` `DEFAULT_SPORTS` = NFL, NCAAF, MMA, MLB (`supabase/functions/capture/index.ts:2561`).
  - The gateway allowlist `public.odds_api_sports` has no `basketball_ncaab` row in any repo SQL. Only `nba_odds_sport.sql` adds `basketball_nba`, disabled.
- `signals` / `book_quotes` / `close` / `games` / `team_features` were created by migrations that are not in the repo (`docs/intelligence-audit.md:118-136`).

**pg_cron.** No CBB job. The only one that touches CBB is `discord_slate` `'0,30 15,16 * * *'` (`supabase/discord_cron.sql:94`), which posts the CBB channel. The `capture_*` jobs (`supabase/capture_cron.sql:65-67`) do not request CBB.

**GitHub Actions (cron is UTC):**

| Workflow | Schedule | CBB effect |
|---|---|---|
| `lab-build.yml` | `17 9 * * *` (`:10`) | ingest current season (`:38`); rebuild slate/registry/board from the **existing** live params (`:40`). Does **not** refit ratings |
| `lab-validate.yml` | `47 11 * * 3` (`:10`) | ingest all seasons; `walkforward.js --league all` (`:47`) refits ratings and calibration, then rebuilds the slate (`:51`). **The only ratings refresh: weekly** |
| `projections-build.yml` | `55 */3 * * *` (`:10`) | `engine/build_projections.js` |
| `games-slate.yml` | `7,37 * * * *` (`:26`) | `today/slate.json`: ESPN events plus the DraftKings line for `ncaam` (overwritten each run; no archive) |
| `performance.yml` | `19 * * * *` (`:43`) | ledger: forecasts, quotes, results, grades |
| `ncaam-research.yml` | `41 10 * * 1` (`:26`) | research-engine tests and rebuild checks only (no new data) |
| `lab.yml` | PR/push | `walkforward.js --check`, `build_slate.js --check` (`:70-72`) |

**Women's NCAAW** shares every file above: `config.js:48-53`, the same `model.js`/`walkforward.js`/`build_slate.js`, `params/ncaaw_live.json`, and the identical tuning (hl 365 / pg 2 / carry 0.8). It has no research engine.

**Reproducibility check.** Re-running `pass()` 2010→2026 with the committed tuning reproduces the committed `ncaam_live.json` exactly: mu 77.533, h 3.911, 1,322 teams, max |Δ| 0.0000.

### 2. Priors

- **How they are set.** `startSeason` sets every team's prior to `carry × last season's final rating`, separately for offence and defence (`basketball/model.js:51-58`; `t.po = t.o * carry`, `:53`). A team not seen before starts at 0 (D1 average). `mu` and `h` are pulled toward last season's values (`:56`, `:102-103`).
  - No returning minutes, recruiting, transfers, coaching changes or roster information enter (live engine).
  - `build_slate.js:99` admits it: "Early in a season, ratings lean on last season (carried at 0.8)".
- **Decay formula** (`model.js:91-92`): `o = (Σ wᵢ·residᵢ + k·po) / (Σ wᵢ + k)`, with `k = prior_games = 2` and `wᵢ = 2^(−age/365 d)` (`:79`), which is about 1 inside a season. The prior's share is `k / (Σw + k)`:

| Games played | Prior share (formula) | Measured in the re-run | Total weight on last season's rating (× carry 0.8) |
|---|---|---|---|
| 0 | 100% | — | 80% |
| 3 | 2/5 = **40.0%** | HCU, 4 games: 33.9%; Bellarmine, 6 games: 25.4% | 32% |
| 10 | 2/12 = **16.7%** | Tulsa, 8 games: 20.5% | 13% |
| 25 | 2/27 = **7.4%** | Maryland, Σw 26.7: 7.0% | 6% |

- **Fitted or hand-set?**
  - `carry`, `prior_games` and `half_life` were **grid-fitted** on the 2012-18 moneyline log loss (`walkforward.js:187`, 36 combinations). All three landed on **grid corners**: hl 365 = max, pg 2 = min, carry 0.8 = max (`ncaam_tuning.json`), so the optimum is probably outside the grid. The research engine chose carry 1.0.
  - The objective includes D1-vs-non-D1 games.
  - `k_mu = 40`, `k_h = 150` and `sweeps = 3` are **hand-set** defaults (`model.js:34`) and were never tuned.
  - The margin/win calibration (`a`, `b`, logistic) is fitted on the three prior seasons' out-of-sample rows (`walkforward.js:128-148`).
- **Research engine (not live).**
  - Prior = last season's final rating with **carry 1.0** (no regression), λ = 150 possessions (≈2.2 games), so the prior share ≈ 42% / 18% / 8% after 3 / 10 / 25 games (`team_model.js:180-199`, `selection_frozen.json`).
  - Transfers count only once a transfer has actually played (`team_model.js:124-128`; `transfer_beta` 0.25, "experimental, not confirmed 2026").
  - The ablation shows the preseason prior is essential: −0.347 CRPS against a league-average prior (`docs/ncaam/VALIDATION.md`).
- **Do priors drive the disagreement?** **No, unlike the NFL.**
  - Across 955 games with a DraftKings close, regressing (live − close) on the prior-contribution difference gives a coefficient of −0.20. On the home-court excess the coefficient is +1.45 (§5).
  - The mean |prior contribution difference| is 4.1 pts in November, 1.3 in December and ≤0.6 from January.

### 3. Personnel (injuries, rotations, transfers)

**Not handled and not applied to the price** in the live engine. The engine sees only team final scores.

- `build_slate.js:98` sets `lineup: 'UNKNOWN — no availability feed'`. `:99` lists the invalidator "A star or starter ruled out: availability is not modelled."
- The walk-forward caveat says the same (`walkforward.js:276`).
- EDPROJ sets `availability: {certainty: 'UNKNOWN', injuries: 'availability is not modelled'}` (`lib/edgedesk_projections.js:459`).
- No basketball injury or availability workflow exists. `injury-sync`, `availability-*` and `roster-sync` cover football only.
- The card (`lib/edgedesk_card_feed.js`) has **no availability gate**. It will still LEAN a CBB moneyline, while the desk's `assess()` marks it `RESEARCH_CONDITIONAL` (`lib/edgedesk_projections.js:612`).
- Transfers and roster turnover are absent from the live prior. Example: Maryland 2025-26 had 0% returning-minute continuity according to the research engine, yet still carried a +28.9 net prior (0.8 × 36.1). That was still 2.2 pts of the 8 March number.
- The research engine has continuity, transfer value, RAPM and absence scenarios. Its own test found that pricing known absences "did not improve" game predictions (+0.016 CRPS [−0.026, +0.057], `docs/ncaam/VALIDATION.md`). It is not wired to the card.

### 4. Home court, neutral sites, rest, travel, altitude

| Factor | Live value | How estimated | Separate on the card? |
|---|---|---|---|
| Home court in the ratings, `h` | live params **3.911** (season-end). **In season it is refitted on every game, including buy games vs non-D1** (`model.js:100,103`, prior weight k_h = 150 hand-set). Re-run 2025-26 monthly means: **Nov 7.97 (max 9.49), Dec 6.82, Jan 5.28, Feb 4.11, Mar 3.92**. The same shape appears in 2023-24 and 2024-25, and in **NCAAW** (Nov 7.76, max 9.47 → Mar 3.88) | joint least squares with the team ratings | **No** (blended) |
| Calibration intercept | `a = −1.810`, `b = 1.0945` (live); `a = −1.636`, `b = 1.0876` (2025-26). Intercept on home games only (cal v2, `walkforward.js:106-125`) | OLS on three prior seasons (`walkforward.js:133`) | No |
| **Effective home court on the price** = `(a + b·h)` | season open 2026-27: −1.810 + 1.0945 × 3.911 = **2.47**. 2025-26 by month: **Nov 7.03, Dec 5.78, Jan 4.10, Feb 2.84, Mar 2.62** | derived | No |
| Comparison | research engine (D1-only fit): 3.28 / 3.06 / **2.65** pts (2024/25/26). Outcomes: on D1 campus games, actual − predicted = **−1.21 (Nov, n 965), −1.74 (Dec, n 894), −1.95 (Jan, n 1,547)**, then −0.01 (Feb). Against the DraftKings close, live − close = +3.05 (Nov) / +1.75 (Dec) / +0.87 (Jan) / −0.09 (Feb) on the random sample | | |
| Neutral site | ESPN `neutral_site` (`ingest.js:72`): `h = 0` (`model.js:62`; `build_slate.js:37`) and intercept off (`build_slate.js:47`). Fixed in cal v2 (CHANGELOG 2026-10-19) | flag | implicit |
| Rest | back-to-back only (≤30 h, `walkforward.js:77`; `build_slate.js:41-42`). Fitted `rest_points` = −0.856 (live), but the **live model is `points`, not `points_rest`** (selection LL 0.49669 vs 0.49667, short of the 0.001 challenger bar), so **rest is not priced**. The card still shows `inputs.back_to_back` and a B2B invalidator. The desk profiles list "rest" as a stat (`lib/edgedesk_projections.js:115`; `edgedesk_ai/index.ts:36886`) | residual mean | displayed, not priced |
| Travel, altitude, time zone | none. Registry `not_modelled: [availability, travel, tempo]`; `docs/ncaam/README.md` lists "travel, venue coordinates" as missing | — | — |

The docs claim (`walkforward.js:111-113`; `docs/sports-calibration/README.md:26`) that "h is about 3.9 points" is true **only at season end**. The v2 fix corrected neutral sites. It did not correct the November–January campus over-statement.

### 5. Largest disagreements with the closing line, decomposed

**No closing line for CBB is committed anywhere in the repo.**

- `basketball/build_slate.js:83`: "no book price is captured for basketball".
- The walk-forward markets are `NOT_TESTED` (`validation/ncaam_walkforward.json`, "no licensed archive of timestamped closing prices").
- `today/slate.json` holds only the current DraftKings snapshot. Its git history is unavailable here (shallow clone).
- The performance ledger has no CBB quotes yet.
- The research engine's `market/quotes.json` is not committed.
- Production `signals.closing_*` may hold 2025-26 CBB rows (capture used to auto-discover sports), but that cannot be audited without the database.

**Best labelled comparison used here:**

- **Source:** the DraftKings `pickcenter` **close** (with open) inside ESPN game JSON mirrored by sportsdataverse at `raw.githubusercontent.com/sportsdataverse/hoopR-mbb-raw/main/mbb/json/final/<game_id>.json`. Fetched 2026-10-20. External, not committed, quote time unknown.
- **Sample:** 1,421 games fetched: a random 300, all 105 postseason D1-v-D1 games, all 1,078 games where |live − research engine| ≥ 4, and the top 150 model-vs-model gaps. 967 had a DraftKings close; 955 joined both models.
- **Coverage caveat:** a game with |live − close| > 14 and |live − research| < 4 would need research − close > 10. The research engine's p95 against the close is 3.8, so this is unlikely.
- **Live numbers:** the live engine re-run exactly as production (point in time, 2025-26 calibration).

**Top 3, all from November–December 2025:**

| # | Game (home first) | Live card | DraftKings close (open) | Gap | Research engine | Actual |
|---|---|---|---|---|---|---|
| 1 | 401823217 Bellarmine v Houston Christian, 2025-11-25 | BELL **−15.0** (proj +15.09), p 0.877 (fair −711) | **HCU −2.5** (−3.5); ML +124/−148 (no-vig BELL 0.428) | **17.6** | BELL +1.68, p 0.557 | BELL +5 (74-69) |
| 2 | 401823327 Tulsa v Missouri State, 2025-12-06 | TLSA **−23.0** (+23.09), p 0.952 (fair −2001) | **TLSA −7.5** (−11.5); ML −425/+330 | **15.6** | TLSA +16.51 | TLSA +24 (98-74) |
| 3 | 401818553 New Hampshire v Brown, 2025-11-26 | UNH **−8.5** (+8.74), p 0.758 (fair −313) | **BRWN −5.5** (−4.5); ML +205/−250 | **14.2** | UNH −3.56 | UNH −12 (47-59) |

**Formula.** In the slate's (home-first) orientation, `margin = (a + b·h)·on + b·(net_H − net_A)`, with `net = o + d` (d > 0 is good defence). Each net splits into a prior part `share·(po + pd)` and a 2025-26 results part. State for all three games: `a = −1.6362`, `b = 1.0876`, `sd = 12.561`.

**Game 1: Bellarmine v Houston Christian** (h = 7.871, mu = 78.258)

| Component | Arithmetic | Points |
|---|---|---|
| Home court | (−1.6362 + 1.0876 × 7.871) × 1 | **+6.924** |
| Bellarmine prior | b × 0.254 × (0.8 × 4.134 = 3.308) = 1.0876 × 0.840 | +0.913 |
| Bellarmine 2025-26 results (6 g) | 1.0876 × 7.420 | **+8.069** |
| HCU prior | −1.0876 × 0.339 × (0.8 × 8.892 = 7.114) = −1.0876 × 2.411 | −2.622 |
| HCU 2025-26 results (4 g) | −1.0876 × (−1.660) | +1.805 |
| Rest / B2B | model = `points` | 0.000 |
| Injuries / lineup / transfers | not modelled | 0.000 |
| **Sum = projected margin** | raw m = 7.871 + 8.260 − 0.752 = 15.379; −1.6362 + 1.0876 × 15.379 | **15.089** |
| Unattributed residual | 15.089 − 15.089 | 1.8e-15 (card rounding: proj 15.1, fair −15.0) |

- **What drives Bellarmine's +7.42 results part** (per-game contributions, which sum to 7.420):
  - Hanover (non-D1, 1 game, **rated −9.43**), W by 39: **+2.69**.
  - At Notre Dame, L by 7: **+2.70**. With h = 7.87 a road loss reads as a strong result.
  - At The Citadel, W by 12: +2.65.
- **HCU:** a win by 18 over College of Biblical Studies (non-D1, rated −30.69) counted **−3.46**. Southern Arkansas (non-D1, 1 game) was rated **+1.28**, above the D1 average. Non-D1 ratings are erratic.
- **Gap vs close (17.6):** home-court excess over 2.62 = 4.3. The rest comes mostly from Bellarmine's inflated results.

**Game 2: Tulsa v Missouri State** (h = 7.156)

| Component | Arithmetic | Points |
|---|---|---|
| Home court | (−1.6362 + 1.0876 × 7.156) | **+6.147** |
| Tulsa prior | 1.0876 × 0.205 × (0.8 × 10.729 = 8.583) = 1.0876 × 1.762 | +1.916 |
| Tulsa 2025-26 results (8 g) | 1.0876 × 24.709 | **+26.872** |
| Missouri State prior | −1.0876 × 0.228 × (0.8 × 13.521 = 10.817) = −1.0876 × 2.471 | −2.687 |
| Missouri State results (7 g) | −1.0876 × 8.422 | −9.159 |
| Rest / injuries | not priced / not modelled | 0 / 0 |
| **Sum** | raw m = 7.156 + 26.471 − 10.893 = 22.734 → −1.6362 + 1.0876 × 22.734 | **23.089** |
| Residual | | −3.6e-15 (card 23.1 / fair −23.0) |

- **Tulsa's +24.71 results part:**
  - Two non-D1 home blowouts: Oklahoma Christian (rated −3.78), W by 43, **+3.10**; Manhattan Christian (rated −5.77), W by 51, **+3.89**.
  - Neutral wins over Rhode Island (+17), San José State (+30) and Northern Iowa (+3): +3.76, +4.30, +2.85.
  - A 1-point road loss at Kansas State: +2.81.
- **Missouri State's results** include three non-D1 home wins worth +5.81.
- **Outcome:** the result (+24) landed on the model's side. The market moved 4 pts away from the model (open 11.5 → close 7.5). One game proves nothing (see the threshold study in §8).

**Game 3: New Hampshire v Brown** (h = 7.850)

| Component | Arithmetic | Points |
|---|---|---|
| Home court | (−1.6362 + 1.0876 × 7.850) | **+6.901** |
| UNH prior | 1.0876 × 0.255 × (0.8 × 3.281 = 2.625) = 1.0876 × 0.670 | +0.729 |
| UNH 2025-26 results (6 g) | 1.0876 × 8.723 | **+9.486** |
| Brown prior | −1.0876 × 0.226 × (0.8 × 14.522 = 11.618) = −1.0876 × 2.622 | −2.852 |
| Brown results (7 g) | −1.0876 × 5.079 | −5.524 |
| Rest / injuries | | 0 / 0 |
| **Sum** | raw m = 7.850 + 9.393 − 7.701 = 9.541 → −1.6362 + 1.0876 × 9.541 | **8.740** |
| Residual | | −3.6e-15 (card 8.7 / fair −8.5) |

- **What makes UNH's results +8.72:**
  - **Curry** (Division III, 1 game, rated −30.59), W by 82: **+5.36**.
  - **Emmanuel (MA)** (Division III, 1 game, **rated −4.00**, almost D1 average), W by 28: **+2.01**.
  - Road losses at Harvard (−11) and George Mason (−17) count **positive** (+1.40, +1.85) because h = 7.85.
  - UNH lost all four of its road games, by 11 to 50 points, and those four games still add **+1.35** in total.
- **Outcome:** the model had UNH by 8.7; Brown won by 12.

**Most recent (March 2026) top 3, all within 9.2 pts.** Home court is back to 2.6. These gaps come from the **slope b = 1.0876 stretching large margins**, plus things the market knows that the model does not:

| Game | Home court | Priors (H − A) | Results (H − A) | Live | Close | Gap | Research | Actual |
|---|---|---|---|---|---|---|---|---|
| Saint Louis v Loyola Chicago, 03-04 | +2.647 | +1.211 − 1.255 | +36.999 − 8.897 | **30.70** | SLU −21.5 | 9.2 | 25.44 | +14 |
| East Carolina v Tulsa, 03-05 | +2.622 | +0.952 − 0.671 | +11.460 − 29.851 | **−15.49** | TLSA −8.5 | 7.0 | −11.30 | −27 |
| Maryland v Illinois, 03-08 | +2.607 | +2.188 − 2.080 | +18.956 − 42.126 | **−20.45** | ILL −14.5 | 6.0 | −16.12 | −6 |

Each row sums exactly; the residual is below 1e-14.

**What the live Card would print for these games** (I ran the real `lib/edgedesk_card_feed.js`, ML only):

| Game | Card output | Why |
|---|---|---|
| Bellarmine | WATCH · CHECK THE NUMBER | raw EV 96% ≥ 25% guard |
| UNH | WATCH · CHECK THE NUMBER | raw EV 131% |
| **Tulsa** | **LEAN Tulsa ML −425, EV +6.8%, edge +5.5 pp** | the 15.6-pt spread gap is compressed by the −425 price to raw EV 17.7%, under the 25% guard |

### 6. Card consistency

Measured over all 6,300 games of 2025-26, using the live formulas.

- **Do the components sum to the fair line?**
  - The card **publishes no components** (`basketball/slate.json` has prices only; EDPROJ `matchup.factors: []`, `lib/edgedesk_projections.js:460`). A reader sees 100% of the number unattributed, including a 7-pt home court in November.
  - Reconstructed from the params, the components sum exactly (residual < 1e-14 in all six games decomposed). The only residual is rounding: the fair line rounds to 0.5 (max 0.25 pts) and the projected margin to 0.1.
- **Is the outcome range centred?**
  - No p10/p90 is published for CBB. The spread ladder (fair ±1) is centred: max |P(home covers) − P(away covers)| at the fair line = **0.016**.
  - The width is a **single constant** sd (12.56, 2025-26). On D1 games the 80% interval covers **75.3% in November** and **86.3% in March**: too narrow early, too wide late.
  - EDPROJ's `model_sd` is the board default 0.03 in probability units, not the engine's sd (`lib/edgedesk_projections.js:457`).
- **Is the win probability consistent with the fair moneyline?**
  - The fair ML is exact `decToAm(1 + (1−p)/p)` (`build_slate.js:26,93`), no vig. Example: p 0.8767 → −711.
  - The win probability comes from a **separate logistic** (`build_slate.js:48`), not from the margin distribution the spread ladder uses. Against P(win) from the card's own Normal(margin, 12.56): mean |Δ| 0.52 pp, **max 1.57 pp** (game 401820575: μ −22.37, logistic 0.0532 vs normal 0.0375).
  - The bias is systematic: favourites of 15–30 pts get 1.1–1.4 pp less from the logistic. The margin implied by the ML differs from the projected margin by at most **0.94 pts** for p in 0.1–0.9.
  - The projected score is `(total ± margin)/2`, consistent by construction.
- **Card wiring defect (verified by running `tools/slate/research.js` `join()` and `lib/edgedesk_card_feed.js`):**
  - `modelFromLab` reads `sp.fair_line` / `sp.home_line`, but the slate emits `fair_home_line`. So `spread_home` is **always null** (`tools/slate/research.js:171`).
  - It sets `home_line` to the **fair moneyline** (−529 in the test) (`:170`).
  - Results:
    - The Card shows "Fair Duke −529 · total 148" and never a fair spread.
    - The Games page omits the "Fair line" row (`lib/edgedesk_games_ui.js:759`).
    - The Card prices **only moneylines** (`lib/edgedesk_card_feed.js:172-198`).

### 7. Measured vs logged

**Closing lines captured?** **No, for CBB.**

- Paid capture excludes `basketball_ncaab`: `capture/index.ts:2561`, and the allowlist has no row.
- `close` is deployed-only and unauditable.
- The free path is ESPN/DraftKings in `today/slate.json` every 30 min. It is overwritten, not archived, apart from the ledger.
- The performance ledger will store the **last captured pregame DraftKings quote** per game (`tools/performance/sources.js:8`). It has no CBB rows yet: the ledger epoch is 2026-10-16 and CBB opens 2026-11-02.

**Results settled?** Yes. In `basketball/data/ncaam/<season>.csv`, through 2026-04-06 (6,300 FINAL in 2026, `manifest.json`), plus ledger results (`sources.js:155-161`).

**CLV computed?** **No.**

- CLV needs a "legitimate close" (`lib/edgedesk_performance.js:347-352`), and `sources.js` returns `close: null` for basketball (`:155-161`).
- Only `market_abs_error` against the last captured quote will exist (`edgedesk_performance.js:318,332`).

**Walk-forward metrics (outcomes only).** Every row of this table is scored against game results. None is scored against a closing line.

| Source | Window / n | Log loss | Brier | Margin | Notes |
|---|---|---|---|---|---|
| `basketball/validation/ncaam_walkforward.json` (registry headline) | 2019-26, **47,123** games, **including D1-v-non-D1** | **0.5053** | 0.17006 | CRPS 6.9949, bias +0.083, 80% cover 81.1% | calibration slope 0.984, CITL 0.0033; total CRPS 9.5338; vs Elo Δ −0.0334 [−0.0372, −0.0302]; **market NOT_TESTED** |
| Same file, by season 2026 | 6,300 | 0.49737 | — | — | Elo 0.53805 |
| `docs/ncaam/VALIDATION.md` / `validation_team.json`, D1-v-D1 2026 holdout | 5,752 | incumbent **0.5376** / research **0.5290** | 0.1827 / 0.1802 | MAE **9.40** / 9.24; CRPS 6.694 / 6.547 | incumbent scored with the **research calibrator**, not production |
| **My re-run, production calibration**, D1-v-D1 2026 | 5,752 | **0.5382** | **0.1829** | **MAE 9.559, bias −1.055** (model too home-favourable) | by min games played: 0-2 11.41, 3-9 10.05, 10-24 9.31, 25+ 8.96 |

**Against the DraftKings close** (external labelled comparison, §5 sample; ML n 237 random, 105 postseason):

| Sample | Live − close margin: MAE (mean) | Research − close MAE | LL live / research / DraftKings no-vig | Brier live / research / DraftKings | Margin MAE vs result: live / research / close |
|---|---|---|---|---|---|
| Random D1 (n 245) | **2.44 (+0.78)**, p90 5.31, max 10.0 | 1.54 | 0.5501 / 0.5443 / 0.5461 | 0.1879 / 0.1850 / 0.1852 | 9.39 / 9.42 / 9.34 |
| Random, November | 4.72 (+3.05) | 2.25 | | | |
| Random, February | 1.54 (−0.09) | 1.06 | | | |
| Postseason (n 105) | 1.58 (+0.23) | 1.54 | 0.5079 / 0.5029 / **0.4929** | 0.1723 / 0.1720 / 0.1655 | 9.29 / 9.27 / 9.06 |
| All fetched (n 955, biased toward disagreements) | 4.35 (+3.02) | 1.98 | 0.5398 / 0.5185 / 0.5108 | | 10.18 / 9.40 / 9.20 |

On totals (random sample), live − close total MAE is 2.99 and research − close is 2.58. Total MAE against the result: live 14.13, close 13.54.

**Other effects measured in the re-run:**

- **Weekly-only ratings refresh.** I priced every 2025-26 D1 game with the ratings of the previous Wednesday's `lab-validate` run, which is the production cadence. Mean rating age at tip is 3.3 days. The mean |Δ| against point-in-time ratings is **0.70 pts (1.63 in November), max 17.6**. MAE moves 9.559 → 9.574.
- **No staleness gate.** EDPROJ freshness gates on the slate's build time (`max_age_hours 30`), not on `params_generated_at` (`lib/edgedesk_projections.js:113,462`), so a 6-day-old rating passes.

### 8. Proposed disagreement threshold vs close

**Proposal:**

- **Spread-based, in points, not EV.**
- **|EdgeDesk fair margin − market spread| ≥ 4.0 pts** → no LEAN on any market for that game. Show "CHECK THE NUMBER", list the components, and require a stated reason: injury, roster, or a known model limitation such as November home court.
- **≥ 8 pts** → suppress the EdgeDesk number for that game.
- **2.5–4 pts** → display only.

**Justification:**

1. **Normal disagreement size.** On the random D1 sample, live − close has sd 3.07 and |Δ| p90 = 5.31 overall.
   - January–April: p90 3.85, p95 4.48.
   - November–December: p75 5.61.
   - The research engine's own p95 against the close is 3.4–3.8.
   - DraftKings open→close moves have p90 2.0 and p95 3.0.
   - A 4-pt gap is therefore beyond about 95% of in-market information drift and about the p93 of the model's late-season dispersion.
2. **No information beyond about 5 pts.** Of 364 games with |Δ| ≥ 5 in the fetched set, the result fell on the model's side of the close **180 times against 184**. At ≥ 8 pts it was 69 against 60; at ≥ 10, 27 against 23.
   - The random-only subsample (19 of 27 at ≥ 5) is too small to overturn this.
   - Large gaps are model error, mainly the November home court and non-D1 inflation. They are not edge.
   - The close beats the live model on margin MAE: 9.20 vs 10.18 on the fetched set.
3. **Why EV-based guards fail.** The current guard is raw EV ≥ 25% (`lib/edgedesk_card_feed.js:65,269`). It passes **Tulsa −425 as LEAN** on a 15.6-pt gap, because moneyline EV compresses at heavy prices (§5). A points threshold is price-invariant.
4. **Volume.** About 16% of random games would trip the 4-pt flag, concentrated in November–December while home court is inflated. That is a feature until the home-court bug is fixed.
5. **Re-calibration.** Re-estimate the threshold on the ledger's own CBB quotes after about 300 graded games, because the external DraftKings close here has unknown timestamps.

### 9. Data availability (wanted but not owned)

| Feature | Status in the repo | Exact gap |
|---|---|---|
| Possession / play-by-play | `datapack/ncaam_v1`: possessions, lineups and stints **2026 only**, as a static pack. Team/player box 2024-26. Nothing for 2027; no in-season ingest (`ncaam-research.yml` only re-checks) | 2024-25 possessions (same publisher), plus an in-season feed for 2026-27 |
| Injuries / availability | none (`build_slate.js:98`; `datapack/ncaam_v1/MISSING_DATA_PRIORITY.md` P0) | effective-dated public status and confirmed starting fives with publish times |
| Lineups / starters | 2026 reconstruction only (pack); none live | live projected and confirmed starters |
| Transfer portal / eligibility | none. Rosters are name-only participation tables. The research prior infers transfers from box scores after they play | 2026-27 rosters, transfer/commitment/enrollment dates, eligibility (P0 in `MISSING_DATA_PRIORITY.md`) |
| Recruiting | none | composite rankings (freshman prior) |
| Returning minutes | derivable from the 2024-26 pack; not for 2027 | 2026-27 roster with prior-season minutes |
| Closing / timestamped odds | none committed; paid capture excludes CBB; ESPN/DraftKings single snapshot only | archived timestamped close (ledger quotes from 2026-11 onward), multi-book |
| Venue coordinates, travel, altitude | venue name/city in the ESPN schedule only | coordinates, elevation, time zones, travel itineraries |
| D1 membership per season | research engine has a bridge (`identity/team_overrides.json`); **the live engine has none**, so non-D1 teams are rated like D1 | feed the research engine's D1 flag into `basketball/ingest.js` |
| Officials, coaching changes | none | assignment publish times, coaching tenure |
| `team_features` (adj_o/adj_d/tempo) for the AI desk | written by deployed-only `ingest_multisport`; no source or DDL; population unknown | the function source and a DB check |
| 2025-26 production `signals` / closing rows | unknown (no DB credentials) | read access to `signals` where `sport_key = 'basketball_ncaab'` |

---

### Problems

| Severity | Problem | Evidence (file:line or data) | Impact |
|---|---|---|---|
| **Critical** | Home-court parameter `h` refitted on every game, including D1-vs-non-D1 buy games, so it swells in season. The card's home court reaches ~7 pts in November, 5.8 in December and 4.1 in January (vs 2.6 at season end and 2.65–3.06 in the research engine). Same in NCAAW | `basketball/model.js:100-103` (`k_h` 150 hand-set `:34`); re-run 2025-26 `h` Nov 7.97 / max 9.49; calibrated `(a + b·h)` Nov 7.03; same in 2023-24 and 2024-25 | D1 campus games over-favour home by 1.2–1.95 pts Nov–Jan (n ≈ 3,400, actual − predicted); live − close +3.05 / +1.75 / +0.87 Nov/Dec/Jan; explains about 36% of the top-50 gaps (coefficient 1.45 per point of excess). The 2026-27 season opens 2026-11-02 with this live |
| **Critical** | Non-D1 opponents rated as ordinary teams shrunk toward D1 average (mean −11.8 net at game time vs a 40.7-pt average loss). D1 teams that beat them get inflated ratings | `basketball/ingest.js` keeps all games; `model.js:91-92`; 548 such games in 2025-26 (326 Nov, 212 Dec); Emmanuel (MA) rated −4.0, Southern Arkansas +1.28 | top gaps vs close (Bellarmine 17.6, UNH 14.2, Tulsa 15.6) are driven by these games plus the inflated `h` |
| **High** | CBB Card drops the fair spread (key mismatch) and labels the fair ML as `home_line`, so the Card prices moneylines only | `tools/slate/research.js:170-171` vs `basketball/build_slate.js:94`; `lib/edgedesk_games_ui.js:759`; verified with real `join()` and card-feed run | no fair spread on the Card or Games page; spread disagreements invisible |
| **High** | The only disagreement guard is EV-based (raw EV ≥ 25%), which misses big point gaps at heavy prices | `lib/edgedesk_card_feed.js:65,269`; Tulsa −425: 15.6-pt gap → card **LEAN**, EV +6.8% | false LEANs on large favourites in exactly the games the model gets wrong |
| **High** | No closing-line test anywhere: outcome-only validation, no committed close, no CLV for basketball | `validation/ncaam_walkforward.json` markets NOT_TESTED; `capture/index.ts:2561`; `tools/performance/sources.js:155-161`; `lib/edgedesk_performance.js:347-352` | "OUTCOME_VALIDATED" still allows EV quotes (`lib/edgedesk_projections.js:63,695`) and Card LEANs with no market evidence |
| **High** | The better engine (research: MAE vs close 1.54 vs 2.44; LL 0.5290 vs 0.5376) is not wired, and it is frozen on a static 2024-26 pack, so it cannot run in-season 2026-27 | `engine/registry.json` ("not wired to the board"); `basketball/ncaam_research/config.js:35-36`; `ncaam-research.yml` | the weaker engine is the one the public sees all season |
| **Medium** | No personnel: no injuries, rotations, transfers or returning minutes. Team-level prior is 0.8 × last season with 40% weight at 3 games | `model.js:53,91-92`; `build_slate.js:98-99`; Maryland continuity 0 but +28.9 prior | November numbers ignore roster turnover. Measured effect is smaller than the home-court bug (prior-difference coefficient −0.2) |
| **Medium** | Ratings refreshed weekly only (Wednesday). The daily build re-prices stale ratings, and the freshness gate checks the slate build, not the params age | `lab-build.yml:38-40` vs `lab-validate.yml:47`; `lib/edgedesk_projections.js:113,462` | mean |Δ| 0.70 pts (Nov 1.63, max 17.6) vs point-in-time |
| **Medium** | Calibration slope b ≈ 1.09 stretches every margin ~9% (ratings over-shrunk; tuning hit grid corners) | live `margin.b` 1.0945; `ncaam_tuning.json` chosen hl 365 / pg 2 / carry 0.8 = grid edges (`walkforward.js:187`) | late-season big favourites over-projected (SLU 30.7 vs close 21.5) |
| **Medium** | Constant margin sd (12.56): 80% interval covers 75% in November and 86% in Feb–Mar | `walkforward.js:136,146`; re-run coverage by month | ranges overconfident early, too wide late |
| **Medium** | Components never shown (`factors: []`), so a 7-pt home court or a non-D1 blowout is invisible to readers | `lib/edgedesk_projections.js:460`; `basketball/slate.json` schema | reader cannot audit the number (the NFL "unattributed" problem in full) |
| **Medium** | Validation figures flatter the live card. The registry headline includes non-D1 games; VALIDATION.md scored the incumbent with the research calibrator | registry LL 0.5053 (all games) vs production-calibrated D1 LL 0.5382, MAE 9.559, bias −1.055 vs doc's 9.40 | overstated quality |
| **Low** | Rest (B2B) displayed and claimed as an input but not priced (model = `points`) | `build_slate.js:44,97,99`; `lib/edgedesk_projections.js:115`; `edgedesk_ai/index.ts:36886` | misleading copy; small effect (−0.86 pt per B2B) |
| **Low** | Win probability (separate logistic) vs the spread ladder's normal: up to 1.6 pp apart; favourites of 15–30 pts are 1.1–1.4 pp lower in the ML | `build_slate.js:48` vs `:52`; re-run over 6,300 games | small internal inconsistency between the ML and spread cards |
| **Low** | Stale or misleading text: app.html says no basketball data is ingested; `build_slate.js` says no book price is captured while the Card compares to DraftKings; `cbb_*` SQL and `tools/cbb` are college baseball | `app.html:37456-37459,43590`; `build_slate.js:83`; `college_baseball.sql:2` | confusion for maintainers and auditors |
| **Low** | AI-desk CBB efficiency layer (`team_features`, `matchup_context`) depends on a deployed-only writer with no source or DDL | `edgedesk_ai/index.ts:2336-2350,5095`; `docs/intelligence-audit.md:133` | unknown whether the desk's CBB "adj_o/adj_d" evidence exists |

Could not be determined from the repo:

- whether production `signals` holds 2025-26 CBB closes;
- whether `team_features` holds CBB rows;
- whether `DISCORD_WEBHOOK_CBB` is set;
- 2025-26 card history (shallow clone; `today/slate.json` history unavailable).

The DraftKings "close" in §5–§8 comes from ESPN pickcenter and its quote times are unknown.

---

## UFC

**Bottom line.** The repo has **no UFC/MMA predictive model**: no rating, no fair line of EdgeDesk's own, no win probability, no projection, and no component drivers. The product owner's belief is wrong. Every probability or "fair" price shown for a UFC bout comes from the market:

- **Fight Center card:** a two-way multiplicative de-vig of the best captured prices, plus the odds capture's `sharp_fair` (Pinnacle when it is fresh, otherwise the consensus median).
- **AI desk "best bets" board:** a `MARKET_DEVIG` fair price, which is also market-derived.

The everything-else on the card is descriptive: career baselines, style labels, live rates, flags, and a "statistical round lean".

The only thing that resembles a model is a **research-only Elo lab run on 2024 data**. Its predictions are compressed into the 41–57% range. It does not beat a coin flip, and it loses to a constant base rate. It has never been compared with a closing line, and **zero UFC closing odds are committed** to the repo.

The registry is accurate: `brain.status = "NOT_BUILT"` and readiness is `RESEARCH_ONLY` (engine/registry.json:1533, :1563, :1573-1577).

Audit basis: code, DDL, workflows and committed artifacts only. There is no database access, so nothing about production row counts can be verified. I re-ran the Elo lab from scratch scripts against the committed CSV. Re-running `engine/lab/ufc_elo.js` itself overwrote its JSON output (only `generated_at` changed), and I restored that file with `git checkout`. The tree is clean.

---

### 1. Inventory (live / shadow / dead)

| Component | Location | What it does | Schedule | Status |
|---|---|---|---|---|
| UFC sync job | .github/workflows/ufc-sync.yml:141-143, :181-214 → tools/ufc/sync_events.js, tools/ufc/build_baselines.js | ESPN cards → `ufc.events`/`ufc.bouts`; fighter resolution; links odds fixtures; writes `ufc.market_captures` from `public.signals` and `signal_ticks`; rebuilds descriptive baselines | `17 */6 * * *` (sync + upcoming baselines); `47 8 * * 1` (all baselines) | LIVE (as committed; whether secrets are set in production is not verifiable here) |
| UFC live job | .github/workflows/ufc-live.yml:26-28, :49-119 → tools/ufc/live_gate.js, tools/ufc/live_poll.js | Gate checks every 30 min for a card in the −45m…+9h window (live_gate.js:27-28); poller writes live state, snapshots, round stats, and market captures about once a minute (live_poll.js:318-330) | `*/30 * * * *` + self-dispatch hand-off | LIVE |
| Research engine | lib/ufc_research.js (1,052 lines) | Name resolution, draw rule, PRE/LIVE bell tagging, closing reference, CLV arithmetic, health, baselines, style labels, live rates, flags, round lean. Its header says it produces "no probability of its own" (ufc_research.js:29-31) | — | LIVE (shared by Node jobs and app.html:3965) |
| Live-center DDL | supabase/ufc_live_center.sql | Tables `ufc.meta`, `events`, `bouts`, `fight_live_state`, `fight_round_stats`, `fight_snapshots`, `fighter_aliases`, `fighter_baselines`, `bout_markets`, `market_captures`, `market_rejections`, `pipeline_runs`, `live_locks`; view `pipeline_status` (:559-569); functions `acquire_live_lock`/`release_live_lock` (:585-633). Tested by games-sql.yml:531-538 | — | LIVE |
| Fighter dataset | `ufc.fighters`, `ufc.fighter_fights` (incl. `odds_close`, `closing_probability`), `fighter_career_stats`, `fighter_derived_metrics`, `fighter_style_metrics` (read at app.html:12761-12769, :12798; build_baselines.js:112-119) | Built by deployed-only edge functions `ufc_fighters_sync`/`ufcstats_sync` (supabase/functions/README.md:184-186; tools/supabase/download_functions.sh:46) | Not in repo | LIVE but **UNCOMMITTED**: no DDL, no code, no schedule in the repo |
| Legacy live layer | Edge functions `ufc_live`, `ufc_live_stats`; tables `ufc.live_*` | Replaced. They "are no longer read by anything in app.html" (supabase/functions/README.md:181-184; ufc_live_center.sql:4-12, :42-43) | Unknown (deployed cron) | DEAD (still deployed) |
| Market capture | supabase/functions/capture/index.ts:2561 (`DEFAULT_SPORTS` includes `mma_mixed_martial_arts`); gateway allowlist odds_api_gateway.sql:91-103 (MMA at priority 3, "shed first") | Writes `public.signals` (best_dec, `sharp_fair = fair_probability ?? consensus_fair` at :2617, edge, flagged_*) | pg_cron `capture_near` `*/20 * * * *`, `capture_day` `4 * * * *`, `capture_board` `18 */6 * * *` (capture_cron.sql:65-67) | **PAUSED.** The emergency stop has been in force since 2026-10-10 and is due to lift on 2026-11-01 (docs/odds-api-incident-2026-10/INCIDENT.md:3-13) |
| Close pipeline | supabase/functions/close/index.ts:937, :1292 (`closing_sharp_fair`) | Snapshots the close at the Odds API `commence_time` | Deployed-only cron (not in committed SQL); paused by odds_api_emergency_stop.sql:77 | PAUSED |
| Elo lab | engine/lab/ufc_elo.js → engine/lab/ufc_elo.json | Chronological Elo over the 2024 data pack | `47 11 * * 3` (lab-validate.yml:10, :49), re-run on a **static** CSV | SHADOW / research. Its result can never change |
| Registry / board / projections | engine/registry.json:1521-1640; engine/board.json (mma: candidates 0, "no independent model"); engine/projections.json (mma: `model_executed false, projections 0`); performance/data/summary.json:3526-3535 (`NO_FORECAST`, games 0, graded 0) | Readiness bookkeeping | Rebuilt by lab workflows | LIVE (accurate) |
| Slate / Games strip / Card | tools/slate/research.js:262-266 (`model` stays null for mma); today/slate.json (both upcoming cards: `research.model: null`, `markets: null`); lib/edgedesk_games_ui.js:323 ("No model" chip), :755 (no model section); lib/edgedesk_card_feed.js:232, :245-247 (no model + no price → no row; price only → `PRICE_ONLY` / `NO_MODEL`) | — | slate every 30 min | LIVE. Shows no UFC model numbers |
| AI desk (edgedesk_ai) | index.ts:2007-2009 (mma `CORE_ONLY`: "fighter metrics … not exposed"); index.ts:36937-36942 (projection unsupported); **_board.js:85** (mma methods `['MARKET_DEVIG']`) and :398-401 (a `MARKET_DEVIG` BET CANDIDATE → `QUALIFIED`) | Can rank and qualify UFC moneylines on market de-vig alone | Request-driven | LIVE. This is the only place a UFC "fair price + edge" is produced, and it comes from the market |
| UFC tab UI | app.html:12737-14035 | Fighter research and the Live Fight Center. States "There is no EdgeDesk UFC model" (:12931, :13215, :13832); model tile "not active" (:13768); "Live win probability — Not shown" (:6054) | — | LIVE |
| Dead code | lib/ufc_research.js:998 (`bout.late_replacement`) | No such column (ufc_live_center.sql:117-171) and no writer | — | DEAD |

There is no UFC-specific pg_cron job in the committed SQL. The UFC pipeline is GitHub Actions only.

### 2. Priors (how a fighter's rating is set and how fast it updates)

**No production model exists, so there are no production priors.** What does exist:

- **Elo lab, research only** (engine/lab/ufc_elo.js):
  - **Starting rating:** every fighter starts at **1500** (`r.get(id) || 1500`, :39). That includes debutants, champions and 15-fight UFC veterans. No earlier UFC or regional record is used, because the input is 2024 only (:29).
  - **Update speed:** `K = 32`, not tuned (:49, :61). With both fighters near 1500 (expected score ≈ 0.5), one bout moves a rating by ±16, which is about **2.3 win-probability points**. After a full year, the in-sample predictions span only **0.411–0.568**. The median |p − 0.5| is 0.021 and the maximum is 0.089 (my re-run of `run(32)`).
  - **Scoring rule:** a bout is scored only when both fighters already had a 2024 bout (:41), which leaves 138 of 562 decisive bouts.
  - **What this means:** the problem is the opposite of the NFL's sticky priors. Here the priors carry no information and update too slowly to express a real UFC favourite. A −400 close is about 80%, and this Elo cannot leave 41–57%. Example: Matheus Nicolau, a top-10 flyweight with a long UFC record, was rated 1483.26 after one 2024 loss, below Asu Almabayev, who had two 2024 wins (see §5).
- **Descriptive baselines** (ufc_research.js:507-608, built by build_baselines.js). These are career totals with **no time decay** (wins/losses, finish rates, UFCStats career averages copied as-is at :530-535). The only recency signals are last-3 and last-5 counts (:581-590) and a streak count (:571-580). Opponent quality uses opponents' **current** records (:551-556), which is not point-in-time. Debutants get a `debut_or_no_history` note (:593), and the UI says "nothing is inferred" (ufc_research.js:977; app.html:13807).

### 3. Personnel-equivalent factors

Nothing is modelled. Coverage of each factor, including descriptive coverage:

| Factor | Handled? | Evidence |
|---|---|---|
| Camp change | No | No field anywhere |
| Weight-class move | No. The data is fetched and ignored | `weight_class` is selected (build_baselines.js:118) but never read in `buildBaseline` (ufc_research.js:507-608) |
| Missed weight / catchweight | No | No field, no source |
| Short-notice replacement | No (dead check) | `unknowns()` tests `bout.late_replacement` (ufc_research.js:998), but `ufc.bouts` has no such column (ufc_live_center.sql:117-171) and nothing writes it. A replacement shows up only as the original bout being marked `cancelled` and a new bout appearing (sync_events.js:109-131), with no link between them. edgedesk_ai says "no late-replacement feed" (index.ts:36940) |
| Layoff | Descriptive only | `days_since_last_fight` and a `long_layoff` note at >365 days (ufc_research.js:568, :591, :981); a matchup row (:962). Not used in any probability |
| Age | Descriptive only | `ufc.fighters.age`, which is current age rather than age at fight time (matchup row, ufc_research.js:947). The Elo lab has no age |

### 4. Venue / environment

None of these is modelled.

- **Venue fields:** `ufc.events` stores venue, city, state, country and timezone (ufc_live_center.sql:86-90; espn.js:175-192). No computation reads them.
- **Altitude:** not modelled anywhere for UFC. The committed 2024 raw scoreboards include 36 bouts at elevation: Mexico City Arena (12, about 2,240 m), Ball Arena, Denver (12, about 1,600 m) and Delta Center, Salt Lake City (12, about 1,290 m).
- **Cage size:** not modelled. 250 of the 566 bouts in 2024 were at Meta APEX, which has the small cage, against 30-ft arena cages elsewhere.
- **Five vs three rounds:**
  - `scheduled_rounds` is stored (ufc_live_center.sql:127) and used only for "no five-round history" text (ufc_research.js:983) and the LATE_ROUND_PROFILE flag (:866-869).
  - Bug: `five_round_scheduled` is incremented only for title fights (ufc_research.js:547), so non-title five-round main events are missed. The 2024 pack has 55 five-round bouts.
  - The Elo ignores format entirely.
- **Home country:** not modelled.
- **Corner / order effect** (the nearest analogue to home field): the corner is the provider's order (`corner_source: 'provider_order'`, espn.js:126, :150), not the official red corner. In the 2024 pack, the ESPN `order: 1` fighter won 310 of 566 bouts (**54.8%**), and `fighter_a` won only 252 of 562 decisive bouts (44.8%). The Elo lab ignores this asymmetry and benchmarks against p = 0.5 (ufc_elo.js:51-52), which flatters it (see §7).

### 5. Three largest model-vs-close disagreements

**This analysis cannot be done. There is no production model, and the project has no committed UFC closing line.**

- `bouts_2024.csv` has no price columns (columns listed at datapack/quant_v1/data/ufc/bouts_2024.csv:1).
- The 12 raw ESPN scoreboards contain no odds or probability fields (scanned: the only matching keys are `linescores`).
- The Elo lab's market test is `NOT_TESTED`: "no licensed archive of timestamped closing prices is on file" (engine/lab/ufc_elo.json:53-54).
- Production `ufc.market_captures` and `signals.closing_sharp_fair` are not in git.

Instead, here are the three **most confident** predictions of the only model-like artifact (Elo, K = 32, re-run from committed inputs), fully decomposed. They show the structure that would face a close. Formula: p_a = 1 / (1 + 10^(−(R_a − R_b)/400)); update ΔR = 32 × (y − e).

**(1) UFC 310, 2024-12-08 — Vicente Luque (a) vs Themba Gorimbo (b). Luque won.**

- **Prior:** both 1500 → p = 0.5000.
- **Luque:** 1500 − 16.00 (loss to Buckley, e = 0.500) = **1484.00**. With only this update, p_Luque = 1/(1 + 10^(16/400)) = 0.4770 (−2.30 pp).
- **Gorimbo:** 1500 + 16.00 (e = 0.500) + 15.26 (e = 0.523) + 15.33 (e = 0.521) = **1546.59**. This moves p_Luque by a further −6.61 pp.
- **Difference:** −62.59 → p_Luque = 1/(1 + 10^0.1565) = **0.4109**. Check: 0.5 − 0.0230 − 0.0661 = 0.4109.
- **Outcome:** y = 1, residual **+0.589**, log loss 0.890.
- **Close:** none on file, so the disagreement is not computable.

**(2) UFC Fight Night, 2024-08-03 — Michał Oleksiejczuk (a) vs Shara Magomedov (b). Magomedov won.**

- **Oleksiejczuk:** 1500 − 16 − 16 = **1468**. p moves to 0.4540 (−4.60 pp).
- **Magomedov:** 1500 + 16 = **1516**. p moves a further −2.26 pp.
- **Difference:** −48 → p_a = **0.4314**.
- **Outcome:** y = 0, residual **−0.431**, log loss 0.565.
- **Close:** none.

**(3) UFC Fight Night, 2024-10-19 — Matheus Nicolau (a) vs Asu Almabayev (b). Almabayev won.**

- **Nicolau:** 1500 − 16.74 (loss to Perez, e = 0.523) = **1483.26**.
- **Almabayev:** 1500 + 16 + 15.26 = **1531.26**.
- **Difference:** −48.00 → p_a = **0.4314**.
- **Outcome:** residual **−0.431**.
- **Close:** none.

Takeaway: even this model's most confident call is 58.9%. Every disagreement with a real UFC close on a lopsided bout would come from the model's compression (flat 1500 priors, K = 32, one season), not from information. That is the same failure class as the NFL priors problem, in the opposite direction.

### 6. Card consistency

There are no model components, so nothing sums to a fair price, there is no projected outcome range to centre, and there is no model-probability-to-moneyline mapping to check. What the card does show, and how consistent it is:

- **Pre-fight "Market" line:** `devig2(best_dec_red, best_dec_blue)`, a two-way multiplicative de-vig of the **best price across books**, labelled "de-vigged from the best captured prices" (app.html:13520-13527; ufc_research.js:169-174, :1026-1034).
- **"Sharp anchor" or "Consensus fair" row:** the capture's per-side `sharp_fair` (app.html:13735). This is computed per book with draw outcomes kept in three-way moneylines (capture/index.ts:1474, :1902-1924, :2617).

These two "fair" numbers sit on the same card and are **not guaranteed to agree**:

- The best-price de-vig mixes books and understates the margin; it can even be negative when prices cross books.
- The two-way de-vig drops any draw share, while `sharp_fair` keeps it, so red + blue `sharp_fair` can be below 1.
- The opening de-vig pairs each side's own first-seen best price, which can come from different times (ufc_research.js:1029).

Probability-to-price conversions are internally consistent (`1/sharp_fair` at app.html:13011, :13059).

Other card elements:

- **"Statistical round lean":** a component-weighted points score (knockdowns 3, significant strikes 2, takedowns, control and submission attempts 1 each; ufc_research.js:768-787). It is arbitrary and never validated against judges, but it is labelled "not a scorecard" and does not feed any price.
- **"Pre-fight CLV" box:** this is market-vs-market. It compares the opening or flagged price with a pre-bell capture (app.html:13761-13789), not a model with the close.

### 7. Measured vs logged

**Closing lines**

- **Mechanism:** `ufc.market_captures` (ufc_live_center.sql:479-501), written by sync_events.js:189-219 (every 6 h; ticks only for cards within 3 days, :355-372) and live_poll.js:318-330 (about once a minute on fight night). Each capture is tagged PRE or LIVE against the bout's observed first bell (ufc_research.js:307-329).
- **Close rule:** the last PRE capture with a usable `sharp_fair` taken at most **6 h** before the bound (ufc_research.js:331-355). When the bell was not observed, the bound falls back to **card start** (:310-312). For a main event, the "close" can then be roughly 4–11 h before the walkout.
- **Fallback:** the signals close pipeline's `closing_sharp_fair` at the Odds API `commence_time` (app.html:13778; close/index.ts:1292).
- **Coverage:** unknown from the repo. **Capture has been paused since 2026-10-10** (INCIDENT.md:3-13), and both upcoming cards (UFC 333 on 2026-10-24 and the 2026-10-31 Fight Night) have `markets: null` in today/slate.json, so **no close will be logged for UFC 333**. The documentation also contradicts itself: supabase/functions/README.md:172-173 says capture covers NFL/NCAAF only, while capture/index.ts:2561 includes MMA.

**Results settled:** yes, descriptively. `ufc.bouts.winner_corner`, `method`, `end_round` and `end_time` come from ESPN (sync_events.js:97-100). Nothing grades any forecast, because none exists (performance/data/summary.json:3526-3535: `NO_FORECAST`, games 0, verified_graded 0).

**CLV:** computed only in the browser per bout, from the opening or flagged market price against the close (ufc_research.js:357-361; app.html:13766-13789). There is no persisted UFC CLV ledger and no model CLV. Any flagged MMA signals carry the Edges board's market-vs-market CLV from the close function, but none of that is committed.

**Backtest metrics:** the only ones are in engine/lab/ufc_elo.json:6-55.

- **Sample:** 566 bouts, 4 with no winner, **138 scored**.
- **Elo:** log loss **0.68886**, Brier **0.24786**, calibration slope **0.923**.
- **Coin flip:** log loss 0.69315; difference −0.004289 with 95% CI [−0.012204, +0.003885], so `a_better: false` and the result is INSUFFICIENT.
- **Market test:** NOT_TESTED.
- **My re-run on the same 138 bouts:**
  - The output reproduces exactly.
  - A **point-in-time running base rate** scores log loss **0.68080**, and a constant 252/562 scores 0.68049. **Both beat the Elo**, which is worse by about 0.008.
  - Elo hit rate is 53.6%, while always picking `fighter_b` hits 58.7%.
  - K values of 16, 24, 48 and 64 all land at log loss 0.688–0.691, so no tuning rescues it.
- **Benchmark flaw:** the lab's coin-flip baseline is mis-specified because of the corner/order asymmetry (§4).

### 8. Proposed disagreement threshold

**Flag at 8 win-probability points.** If |p_model − p_close,no-vig| ≥ **8 pp**, treat it as a DATA CHECK that is never promoted. At **≥ 15 pp**, suppress the model number entirely (that is the size of the NFL SEA gap: 74% against about 58%). Apply this to any future UFC model until walk-forward evidence supports a different value. Reasons:

1. **The reference itself is noisy by about 1–3 pp** on this card: best-price vs consensus de-vig, two-way vs three-way draw share, and a 4–6% margin.
2. **Realistic model edges against a UFC close are small.** The registry's own design citation (Holmes et al. 2023, registry.json:1535-1536) reports in-fight-statistic models only *matching* bookmaker accuracy, so true edges are plausibly 1–4 pp. A gap of 8 pp or more is far more likely to be a model error than an edge.
3. **UFC has the largest late-information shocks:** replacements, weight misses and injuries, flagged "variance: very high" at app.html:36844-36846. EdgeDesk has no feed for any of them (index.ts:36940).
4. **It matches the repo's existing rule** that a projection far from the market is a data check, never a pick (_board.js:102, :382, :395), and the card feed's "CHECK THE NUMBER" gate (lib/edgedesk_card_feed.js:65, :269).
5. **Once data exists, re-derive it.** Set the threshold at the 90th percentile of |model − close| on at least 300 walk-forward bouts with timestamped closes.

### 9. Historical data availability

| Source | Bouts with results | Bouts with closing odds | Point in time? | Notes |
|---|---|---|---|---|
| Committed: datapack/quant_v1/data/ufc/bouts_2024.csv | 566 (562 decisive; 52 events; 720 fighters; 341 with ≥2 bouts) | **0** | No (`known_at` blank on all 566; "RETROSPECTIVE" at ufc_elo.json:16-19) | One season only. Includes 6 bouts with a "4-period" format (data error) |
| Committed: raw ESPN scoreboards 2024 (12 files) | Same bouts | **0** (no odds fields) | — | — |
| Production `ufc.fighter_fights` (`odds_close`, `closing_probability`) | Unknown. UI text claims a "2010–2026 dataset" (app.html:14022) | Unknown | No. Described as an untimestamped **consensus** close, "not Pinnacle", from a "UFCStats/Kaggle backfill" (app.html:6039-6041, :12837) | Not in git and not auditable. The registry rules out untimestamped archives as a market test (ufc_elo.json:54) |
| Production `ufc.market_captures` / `signals` | Only since the live-center contract went in | Unknown, and nothing new since 2026-10-10 | Yes (timestamped, bell-tagged) | Not in git |
| Career microstats (`fighter_career_stats`) | — | — | **No.** One current-career row per fighter | Any backtest that uses them leaks future information |

**Verdict: the project does not own enough data for a real walk-forward backtest.** The committed data is one season (138 scorable bouts) with no prices. The project's own protocol needs n ≥ 1000 and at least 2 seasons (ufc_elo.js:15-17; ufc_elo.json:49-51). **UFC must stay RESEARCH_ONLY / Experimental, with no fair lines or win probabilities claimed**, until two things are in place:

1. A multi-year, point-in-time results archive with timestamped closes, which could be the production `fighter_fights` table if it can be exported with provenance.
2. An authorised per-round statistics feed.

---

### Problems

| Severity | Problem | Evidence (file:line or data) | Impact |
|---|---|---|---|
| Critical | The product owner believes UFC produces model fair lines, win probabilities, projections and drivers. **None exist.** Every UFC probability or "fair" is market-derived | engine/registry.json:1533 (NOT_BUILT), :1563-1577 (RESEARCH_ONLY, NOT_TESTED); lib/ufc_research.js:29-31; app.html:13768, :13071, :6054; lib/edgedesk_canon.js:673-674; today/slate.json (mma `research.model: null`) | Any UFC "edge" carries no independent predictive information. Marketing it as model output would misrepresent the product |
| High | The AI desk board can mark UFC moneylines **QUALIFIED** from `MARKET_DEVIG` alone (best book against a de-vigged reference), with a fixed tier weight of 0.8 that outranks unvalidated models. This contradicts the doc's claim that MARKET_DEVIG no longer stands in for UFC | supabase/functions/edgedesk_ai/_board.js:85, :398-401, :421; index.ts:21899 (inlined); docs/quant-desk/MULTISPORT.md:39 | UFC "picks" can be published with a fair price and an edge that are pure line-shopping. The de-vig assumes an even margin, which the strong MMA favourite-longshot bias violates |
| High | Zero UFC closing odds committed; the market test has never been run | bouts_2024.csv:1 (no price columns); raw scoreboards (no odds keys); engine/lab/ufc_elo.json:53-54 | Nothing can be validated against the close; CLV claims are impossible |
| High | The only measured model (Elo) is worse than a constant | My re-run: Elo log loss 0.68886 vs point-in-time base rate 0.68080 on the same 138 bouts; hit rate 53.6% vs 58.7% always picking fighter_b; ufc_elo.js:51-52 uses a p = 0.5 baseline | The lab overstates the Elo ("indistinguishable from a coin flip" when it is actually *worse than a base rate*). It must never be promoted |
| High | Elo priors carry no information: everyone starts at 1500 regardless of pre-2024 career; K = 32 untuned; outputs confined to 0.41–0.57 | ufc_elo.js:39, :49, :61; re-run p range [0.411, 0.568] | Cannot represent real favourites (a −400 close is about 80%). Disagreements of 20–40 pp with the close would be systematic |
| High | Market capture is paused and MMA is shed first. Upcoming cards have no prices, so UFC 333 (10-24) will log no close or CLV | INCIDENT.md:3-13; odds_api_gateway.sql:91-103 (priority 3); capture_cron.sql:65-67; today/slate.json `markets: null` | A gap in the timestamped-close archive, which is the one resource needed to ever validate a model |
| Medium | The fighter dataset (fighters, fight history with consensus closes, career/derived/style metrics) is built by **uncommitted** deployed functions; career stats are current aggregates | supabase/functions/README.md:184-186; download_functions.sh:46; app.html:6039-6041; build_baselines.js:112-119 | Not reproducible or auditable. Any backtest that uses these tables leaks future information |
| Medium | Personnel-equivalent inputs absent; `late_replacement` is dead code; `weight_class` fetched but unused; age is current age | ufc_research.js:998 vs ufc_live_center.sql:117-171; build_baselines.js:118; ufc_research.js:947 | Short-notice and weight-miss bouts (the biggest UFC line movers) would get no adjustment in any future model |
| Medium | Venue and environment ignored: 36 bouts at altitude venues and 250 in the small APEX cage in 2024; venue fields stored but unused | ufc_live_center.sql:86-90; 2024 raw scoreboards | Structural effects are left out of any future model |
| Medium | The closing-reference fallback is weak: an unobserved bell falls back to card start, with a 6 h lead allowed, so a main-event "close" can be hours old. The signals close is taken at the Odds API commence time | ufc_research.js:307-315, :331-354; close/index.ts:1292 | CLV, when shown, can be measured against stale prices |
| Medium | "Sharp" is often just consensus: when no fresh Pinnacle quote exists, `sharp_fair` is the median of the same books the edge is measured against | capture/index.ts:15-26, :1902-1924, :2617 | UFC "edges" on the Edges board and the overview ("Widest gap to sharp fair", app.html:13007-13012) are best-vs-median line shopping |
| Medium | Corner/order effect unmodelled and the benchmark mis-specified: the order-1 fighter wins 54.8% (310/566); fighter_a wins 44.8% | espn.js:126, :150; 2024 raw scoreboards; ufc_elo.js:51-52 | Inflates or deflates apparent skill. The "corner" shown in the UI is not the official red corner |
| Low | Two different fair probabilities on one card (best-price two-way de-vig vs per-book `sharp_fair` that keeps the draw) | app.html:13520-13527, :13735; ufc_research.js:169-174, :1026-1034; capture/index.ts:1474 | Reader confusion; the numbers can differ by the draw share or cross-book vig |
| Low | `five_round_scheduled` counts only title fights | lib/ufc_research.js:547 | "No five-round history" notes can be wrong for non-title headliners |
| Low | Opponent quality uses opponents' current records | lib/ufc_research.js:551-556 | Fine for description; leaks if reused as a model feature |
| Low | `resultFor` treats any non-matching winner value as a loss | lib/ufc_research.js:485-494 | Possible miscounted losses on malformed rows |
| Low | The weekly lab-validate run recomputes the Elo on a static 2024 CSV | .github/workflows/lab-validate.yml:10, :49 | Looks like ongoing validation, but the result can never change |
| Low | The round-lean weights (3/2/1/1/1) are arbitrary and unvalidated | lib/ufc_research.js:768-787 | Labelled "not a scorecard"; minor, but a hand-weighted component of the kind this audit is looking for |
| Low | Docs contradict each other on capture scope | supabase/functions/README.md:172-173 vs capture/index.ts:2561 | Operators may wrongly believe MMA prices are not captured, or the reverse |

---

## Tennis

**Audit date:** 2026-10-20. **Repo:** /home/user/EdgeDeskSports @ beb1ed28 (shallow clone, 119 commits). There are no production DB credentials. **The repo commits no tennis production rows: no predictions, no closes, no settlements, no registry coefficients.**

**Method.** I read the code, SQL and workflows. I then re-ran the pipeline end to end on a throwaway local PostgreSQL 16:

- Applied `supabase/tennis_live_center.sql`, `tennis_record.sql`, `tennis_lab.sql` and `wta_board.sql`.
- Generated a 60,015-match archive with `tools/tennis/fixtures/make_archive.js`.
- Ran `import_archive.js`, `build_features.js`, `build_ratings.js`, `build_model.js`, `build_lab.js`, `fixtures/make_board.js` and `price_board.js`.

Every "synthetic" number below comes from that run and is labelled. I modified no repo file.

**Bottom line**

- **Product state.** Tennis is **RETIRED**. No user-facing card computes or shows a tennis model number today.
- **Live card path.** The code that *did* produce card numbers is `tools/tennis/price_board.js`, which calls `lib/tennis_model.js` → `predict()`. It has a wiring bug: **surface Elo never reaches the model**, and nothing tests it.
- **Frozen ratings.** Nothing ever adds a match to `tennis.matches` after the archive ends (2026-05-25). Ratings, form, rest and workload are therefore frozen at that date. Nightly rebuilds stamp them as fresh.
- **Closing-line measurement.** It is structurally broken by a unit mismatch on `sharp_fair` (probability vs decimal), so CLV is always NULL.
- **Market test.** The model has never been compared with a closing line, and the project owns no historical tennis odds.

---

### 1. Inventory

#### 1a. Status and what "RETIRED" means

**Where it is declared.**

- `lib/edgedesk_sports.js:55-63`: `RETIRED = [{id:'tennis', retired_on:'2026-09-27', key_prefixes:['tennis_'], modules:['tennis','wta']}]`.
- Inlined into `app.html:4278`, `record.html:4443`, `supabase/functions/capture/index.ts:230`, `close/index.ts:186` and `edgedesk_ai/index.ts:22712`.
- `engine/registry.json:1419-1518`: `"product": "RETIRED"`, readiness `RETIRED`, `value_claims:false`, `market: NOT_TESTED`. Blockers: "Retired as a product on 2026-09-27", "Archive licence is non-commercial", "Never tested against a market".
- `engine/board.json` (tennis: `state RETIRED, priced 0`) and `engine/projections.json` (`model_executed:false, projections:0`).

**What retirement actually does.**

- **Capture and close stop buying tennis odds.**
  - `capture/index.ts:3409-3411` applies `keepCurrentKeys`.
  - `close/index.ts:1232`: "retired sport: no live close requested".
- **The board drops tennis rows.** `app.html:7291, 7361, 7377, 7383` use `dropRetiredSports`. Record views drop them unless the user picks the archive view (`app.html:9363-9367`).
- **Research routes are redirected.** `app.html:5658-5662` (`RS_RETIRED`). No Tennis or WTA panel remains in `app.html`: no read of `wta.daily_research`, `tennis.board_current` or `EDTennis*`.
- **The AI answers with a support boundary.** `edgedesk_ai/index.ts:56185-56200` (`retiredSportTurn`) is called at lines 56490 and 56673, *before* the inlined tennis retrieval layer (`index.ts:19926-20346`). A question phrased as "historical" passes the boundary (`HISTORY_ASK`, `edgedesk_sports.js:122`).
- **Workflows lost their cron triggers** and are `workflow_dispatch` only (see 1d).
- **Nothing is deleted.** Tables, history and the `wta` views remain in the database (`edgedesk_sports.js:24-27`).

**Do cards still show numbers?** No *live* tennis model numbers are shown.

- Residual: `app.html:37557-37722` (`ensureTennisCore`, `tennisEvidenceItems`) still reads `tennis.player_career`, `player_surface`, `player_form` and `rankings_current` as evidence chips. It only runs for tennis board rows, which are now dropped upstream.
- Historical tennis *market-engine* signals (`public.signals`, not this model) are still visible in the record's archive view.

**Did production ever publish model numbers?** Probably not, or only for a few days.

- `.github/workflows/tennis-record.yml:173-180`: on 2026-09-20, applying the contract to production failed part-way.
- `tennis-record.yml:290-300`: "On 2026-09-21 none was" — zero archive matches were loaded in production, so `build_model` exited 1 and `price_board` refused ("no ACTIVE tennis model").
- The registry's active model `tennis-baseline-2026.09.19.874` was trained "on the real archive" (`docs/tennis-lab-implementation-report.md:151-175`). That run appears to be a non-production database, and its coefficients are committed nowhere.
- Retirement followed on 2026-09-27.

#### 1b. Code — which file produces which number

| File | Role | State |
|---|---|---|
| `lib/tennis_model.js` | Shared engine. `featureVector` (:740-797), `predict` (:832-846), price conversions (:850-890), `powerRating` (:899-916), `GATES`/`gradeResearch` (:932-973), metrics, `fitLogistic` (:1103-1146), `SEED_MODEL` (:811-823, hand-set) | Retired; loaded by Node only now |
| `tools/tennis/price_board.js` | **The card-number producer.** Builds features from the current rating layer (`ratingSide` :70-97). Runs the active registry coefficients (:236). Writes `model_predictions`, `research_opportunities` and immutable `prediction_record` rows (:347-404) | Retired (was cron `15 */2 * * *`) |
| `tools/tennis/build_model.js` | Logistic fit; split = first 70% / next 15% / last 15% in time (:52, :184-186); promotion gate (:275-299) | Retired |
| `tools/tennis/build_ratings.js` | Current rating = archive pre-match Elo + one K=32 step (:45, :189-196). Power rating 0-100 | Retired |
| `tools/tennis/build_features.js` | Rolling serve/return strength and strength of schedule (window `1 preceding`, :108-123) | Retired |
| `tools/tennis/settle_record.js` | Outcome, Brier, log loss and CLV onto `prediction_record` | Retired; CLV broken (§7) |
| `tools/tennis/incremental.js` | "Results" mode only compares ESPN winners with `prediction_record`; **never inserts matches** (:136-166) | Retired |
| `tools/tennis/build_lab.js`, `build_history.js`, `build_brief.js`, `lib/tennis_lab.js` | Lab signals. Matchup Studio `projectMatchup` (:467-628) is a **second probability path** | Retired; UI removed |
| `lib/tennis_research.js`, `espn.js`, `sync_events.js`, `live_poll.js`, `live_gate.js`, `build_baselines.js`, `sync_players.js` | Live match centre, ESPN parsing, market linking, PRE/LIVE price tagging, observed serve baselines | Retired |
| `tools/tennis/providers/*` | `edgedesk_odds.js` (prices from `market_captures`/`signals`), `espn_results.js`, `historical_archive.js`, `licensed_feed.js` (stub), `open_meteo_weather.js` | Retired |
| `tools/tennis/import_archive.js` | One-off import of the CC BY-NC-SA archive (manual; not on any schedule, `tennis-record.yml:25-29`) | Manual |
| `supabase/functions/edgedesk_ai/_tennis.js` | AI retrieval over `tennis.ai_*` SQL functions; does no maths itself | Behind the retired-sport boundary |

#### 1c. Database objects

- **`tennis_live_center.sql`** (live centre)
  - Tables: `tennis.tournaments`, `live_matches`, `match_live_state`, `match_set_stats`, `match_snapshots`, `player_aliases`, `player_baselines`, `player_directory`, `match_markets`, **`market_captures`** (:561-583, PRE/LIVE price ticks), `market_rejections`, `pipeline_runs`, `live_locks`.
  - Functions: `acquire_live_lock`, `release_live_lock`.
- **`tennis_record.sql`** (record)
  - Tables: `meta`, `source_licenses`, `ingestion_runs`, `data_quality_issues`, `stg_archive_matches`, `players`, `venues`, `matches` (:619), `player_match_features` (:753), `player_ratings_current` (:825), `rankings_current`, `weather_observations`, **`odds_snapshots`** (:1068), **`model_registry`** (:1120), **`model_predictions`** (:1195, append-only), `research_opportunities` (:1286), **`prediction_record`** (:1431-1475, immutable via `freeze_published_record` :1485-1518).
  - Views: `player_match_rows`, `player_career`, `player_season`, `player_surface`, `player_form`, `h2h`, **`public_record_summary`** (:1523), **`public_record_calibration`** (:1546), `board_research` (:1780), `board_public` (:1714/1756), **`board_current`** (:1810), `match_context` (:1835), `player_profile`, `record_health`.
  - Functions: `license_allows`, `viewer_is_entitled`, `ops_health`, `ai_surface_leaders`, `ai_market_disagreement`, `ai_player_context`, `ai_match_context`, `ai_data_health`, `record_quality_issue`, plus freeze triggers.
- **`tennis_lab.sql`**
  - Tables: `rating_history`, `research_briefs`, `lab_flags`; 20 new columns on `player_ratings_current`.
  - 17 `lab_*` functions and 4 `ai_lab_*` functions; views `lab_player_row`, `lab_health`.
- **`wta_board.sql`**: views `wta.meta`, **`wta.daily_research`** (the old research card), `wta.watchlist` (per-player CLV), all over the `tennis` tables.
- **Other files:** `tennis_player_directory.sql` and `tennis_record_reconcile.sql` (a pre-contract cleanup).

#### 1d. Edge functions, pg_cron and workflows

- **Edge functions.** No tennis edge function exists in the repo (`tools/tennis/README.md:3-7`).
  - `supabase/odds_api_emergency_stop.sql:80,90` lists *deployed but not exported* functions `/functions/v1/wta_odds`, `wta_close` and `tennis_ingest`. Their state in production is unknown.
  - `capture` and `close` exclude tennis (1a).
- **pg_cron.** No `cron.schedule` touches tennis in any `supabase/*.sql`.
- **GitHub Actions.** All three workflows are now `workflow_dispatch` only. The former schedules come from in-file evidence:

| Workflow | Former trigger (evidence) | Jobs | Now |
|---|---|---|---|
| `tennis-record.yml` | `35 5 * * *` nightly (features → ratings → rankings → history → lab → brief); `15 */2 * * *` board (incremental results → settle → `price_board`); `20 7 * * 1` weekly (weather, model "review"); `50 * * * *` monitor (:117-120; `docs/tennis-implementation-report.md:107-110`) | :379-485 | `workflow_dispatch` (:37-42, "RETIRED 2026-09-27") |
| `tennis-sync.yml` | `53 8 * * 1` weekly full baselines (:201); README says sync ran "every few hours" (`tools/tennis/README.md:14`) | `sync_events`, `sync_players`, `build_baselines` | `workflow_dispatch` + `pull_request` probe (:24-47) |
| `tennis-live.yml` | Gate "every half hour" (:4); poller loops about every 20 s per tour-day | `live_gate`, `live_poll` | `workflow_dispatch` (:34-39) |
| `deploy-intelligence.yml` | Manual inputs `apply_tennis_live_center` / `reconcile_tennis_record` / `apply_tennis_record` / `apply_tennis_lab` (:91-104) | SQL apply | Manual |
| `games-sql.yml` | Pull-request CI of the tennis SQL suites | Tests | Active on PRs |

**Live vs shadow vs retired.** Everything is **retired**. No shadow model runs. The only "live" tennis code paths left are pull-request CI and the AI boundary.

---

### 2. Priors: Elo initialisation, K, decay, surface blending, speed

**EdgeDesk does not compute Elo.** The base ratings are the archive's own pre-match columns.

- `winner_elo_pre`, `winner_surface_elo_pre`, … are imported by `import_archive.js:161-171` and read in `tennis_model.js:657-658`.
- The archive also carries `elo_prob_winner_pre`; EdgeDesk ignores it.
- **Not in the repo:** the archive's starting rating, K-factor or schedule, surface-Elo method, inactivity decay and match-weighting. The only Elo arithmetic in the repo is the *synthetic* generator (`fixtures/make_archive.js:259`: start at 1500, fixed K).
- The archive Elo is therefore an opaque third-party prior. `tools/tennis/leakage.test.js` can only verify EdgeDesk's own rolling features. That suite passes: **86 assertions** on my local Postgres.

**EdgeDesk's own rating step (`build_ratings.js`).**

- **Current rating.**
  - Formula: current Elo = last pre-match Elo + **one** step, `elo + 32·(result − expected)` (:10-21, :45, :189-196).
  - K=32 is "a constant of this build, not a tuned parameter" (:186-188). It is not matched to the archive's own K.
  - So one rating can move at most ±32.
- **Surface Elo.** Only the surface the player *last* played on is advanced. Every other surface keeps its last pre-match value, however old (:266-274). No decay.
- **Ratings never move again after the archive ends.**
  - `incremental.js` results mode reads ESPN winners and compares them only with `prediction_record` (:136-146).
  - Its downstream "blast radius" joins `tennis.matches` on ESPN match ids, which never exist there (:154-166).
  - No code path inserts into `tennis.matches` except the archive importer; a grep finds only test SQL.
  - The archive ends **2026-05-25** (`docs/tennis-lab-implementation-report.md:83`). Every later price uses May ratings.
  - This is the NFL "sticky prior" class taken to its limit: the prior is the posterior forever.
- **Freshness is mis-measured.**
  - Form windows, rest and 14-day workload are anchored to `max(match_date)` on file, not to the match being priced (`build_ratings.js:81-98, 299-304`).
  - The research gate's `features_stale` check uses the rating row's `computed_at`, i.e. the nightly rebuild time (`price_board.js:248`; `GATES.maxFeatureAgeHours = 48`, `tennis_model.js:932-941`).
  - So four-month-old inputs pass as fresh.
- **New or thin players.**
  - A player missing from the archive has no rating row, so `d_elo` etc. become "missing → 0". Completeness falls and the match is usually excluded below 0.55.
  - `thin_rating_sample` (<10 matches) is only a *soft* reason, not in the hard list at `tennis_model.js:969-971`. Thin players are still priced as `provisional`.
  - Shrinkage toward the median (`powerRating`, `tennis_model.js:899-916`, trust = n/40) applies only to the **display** power rating. **The probability uses raw Elo differences, unshrunk.**

**Surface blending.** Overall Elo and surface Elo enter as two separate differences: `d_elo` and `d_surface_elo`, each ÷100 (`tennis_model.js:774`). The logistic fit chooses the blend.

- **The blend is lost on the live board.** `price_board.js:74` reads `r.a_surface_elo` / `r.b_surface_elo`, but `boardSql` never selects those aliases. It selects only `ra.hard_elo, ra.clay_elo, …` for side A and nothing for side B (:110-121).
- So `d_surface_elo` is **always missing → 0** at serve time.
- Confirmed by the synthetic run: all 12 priced fixtures list `d_surface_elo` in `missing_inputs`.
- No test covers `ratingSide` or `boardSql`; a grep of `tools/tennis/*.test.js` finds none.

**Fitted or hand-set?**

- **Fitted:**
  - The 16 logistic coefficients: L2 = 1e-3, gradient descent, 600 epochs, not necessarily converged (`build_model.js:202`). My synthetic fit: "stopped after 600 epochs".
- **Fitted on old tennis only:**
  - The fit uses the first 70% of matches chronologically (`build_model.js:52, 184-186`). On the full archive that is 1968 → about 2008. The production-cardinality run shows "train 1968-01-01..2008-05-06" (`docs/tennis-implementation-report.md:220-224`).
  - The validation window is computed but never used for selection.
  - Serve statistics are absent before 1991 (`docs/tennis-lab-implementation-report.md`, §6). So roughly half the training rows carry serve/return as "missing → 0", which biases those coefficients toward 0.
- **Hand-set:**
  - K=32 (EdgeDesk step).
  - Rest cap 14 days (`tennis_model.js:753-757`).
  - Surface-experience prior k=30 (:766).
  - `LEVELS` weights (:212-225).
  - `rankProb` slope 0.55 (:1181).
  - Every `GATES` threshold (:932-941).
  - `SEED_MODEL` (:811-823, "fitted offline", unverifiable).
- **Structurally inert:** `best_of_5` and `level_weight`.
  - Every match is trained twice with only differences flipping sign. Any non-difference feature therefore receives a zero gradient for ever.
  - The synthetic fit returned exactly `best_of_5: 0, level_weight: 0, intercept: 0`.
  - The model card still lists both as inputs (`docs/model-card-tennis.md:29-49`). Only the `elo_x_bo5` interaction carries format.
- **Production coefficients are not committed.** The registry row lives only in the database, so no production probability can be reproduced from the repo.

**Synthetic fitted coefficients** (60k matches; illustrative only): `d_surface_elo 0.486`, `d_surface_experience 1.026`, `d_return_strength −0.807`, `d_serve_strength 0.315`, `d_rank_points_log 0.116`, `d_rank_log 0.059`, `d_elo −0.018`, `d_rest −0.039`, `d_workload_14d −0.045`, `elo_x_bo5 0.017`, others ≈0, intercept 0.

On that data surface Elo carries the model, which is exactly the term the live board drops. The fitted model also *failed* the repo's own promotion gate (log loss 0.6542 vs surface-Elo baseline 0.6510). I force-activated it (via `--rollback`) only to drive the board.

---

### 3. "Personnel"-equivalent: fitness, injuries, retirements, load, surface changes

| Factor | Handled? | Evidence |
|---|---|---|
| Injury / withdrawal / fitness feed | **No** | `docs/model-card-tennis.md:132` "No injury, withdrawal or fitness input exists. None."; registry `not_modelled: ["injuries, retirements"]` |
| Return from layoff | **No.** Rest is capped at 14 days, so a 9-month absence equals 2 weeks. No rating decay. | `tennis_model.js:753-757`. Synthetic ATP:1: player A's last match was 281 days earlier (`rest_days 281`), opponent 122 → `d_rest = 0` |
| Mid-match retirement risk | **No** feature. Retirements stay in the training record as results. | Model card :138; `parseScore` flags them (:259-281) but no feature uses the flag |
| Retirement / walkover settlement | **Inconsistent.** Training excludes walkovers (`build_model.js:105-108`), but settlement includes `status in ('final','walkover')` and scores them with Brier and log loss (`settle_record.js:71`). Retirements settle as full results regardless of book rules. | `settle_record.js:71, 77-86` |
| Match load / fatigue | `matches_14d` (÷5) and `rest_days` exist **as at the archive end**, not the match date | `build_ratings.js:158-172, 299-304`; `price_board.js:78-80` |
| Surface change (e.g. clay → grass) | Only through surface Elo and surface experience. Surface Elo is **not wired on the live board** (§2). Surface is usually **unknown** live (§4). | `price_board.js:74, 124-130` |
| Age | `d_age` (latest age from the archive, stale) | `price_board.js:122` |

**Verdict.** None of the personnel-equivalent channels is handled at prediction time. The fatigue inputs that do exist are months stale in production.

---

### 4. Environment: surface, indoor/outdoor, altitude, best-of-3 vs best-of-5

- **Surface.** Not its own component. It selects which surface Elo and which career surface win rate are used. In practice it is broken in two ways:
  1. **Surface Elo is never wired** (price_board bug, §2).
  2. **ESPN does not publish surface.**
     - `espn.js:265` reads `ev.surface || ev.tournament.surface || groupings[0].surface`.
     - The committed real ESPN scoreboards (`datapack/quant_v1/data/tennis_{atp,wta}/raw/scoreboard_2024*.json.gz`, 8 files, including Roland Garros and Wimbledon 2024) contain **no surface field anywhere**: the string "clay" appears 0 times in the RG file.
     - `tennis.tournaments.surface` is only written by that sync, so live surface resolves to `'unknown'`.
     - `price_board.js:124-130` then computes "surface experience" from the player's **unknown-surface** archive matches (mostly pre-1990) rather than treating it as missing.
     - The gate flags `surface_unknown` only softly. `app.html:38070` admits "The match surface is not carried on the signal row".
- **Indoor/outdoor.** Not in the model; it is carried in `inputs` JSON only (`price_board.js:287`). Weather is stored (`weather_observations`) but never used.
- **Altitude.** None.
- **Best-of-3 vs best-of-5.** Only `elo_x_bo5` = `d_elo × bo5` (`tennis_model.js:749, 792`). The main effect `best_of_5` is inert (§2).
  - The live `best_of` comes from `espn.js:173-177` (`c.format.sets.count`).
  - The real 2024 ESPN documents carry `format: {"regulation":{"periods":5}}` on **every** competition: women's singles, doubles and ATP 250s alike. There is no `format.sets`.
  - So the parser returns `null` and `bo5 = 0` even at Slams. The datapack's own `best_of` column shows 5 for all 1,233 ATP rows, including best-of-3 events (Hamburg, Gstaad, Newport, Båstad, Montpellier …).
  - The parser is tested only against the synthetic `fixtures/make_day.js` shape (`{"sets":{"count":5}}`).
- **Tournament level.** `level_weight` is inert, and live `level` arrives as an ESPN `season.slug` string that does not map to `LEVELS` (`espn.js:264`).

**Verdict.** Environment is a single blended logistic. At serve time surface and format are likely `unknown`/`null`, so the model runs **surface-blind and format-blind** in production, unlike training.

---

### 5. The three largest model-vs-close disagreements

**Production closes and results are not committed.**

- No `prediction_record`, `market_captures`, `odds_snapshots` or settled ledger exists in the repo.
- `datapack/quant_v1/COVERAGE.md:3`: "No bookmaker quote dataset is included."
- Even in production the closing line could never have been recorded (§7: `closing_prob_a`/`clv` are always NULL), and production may never have priced a match (§1a).

**Best labelled comparison available.** I used the repo's own synthetic slate (`tools/tennis/fixtures/make_board.js`) over the synthetic archive, priced by the real `price_board.js` with the fitted (synthetic) model. Its "market" is a fixture, not a real close:

- formula: `marketA = 1/(1+10^((powerB−powerA)/22))` plus a deliberate offset of +7 / −5 / 0 points by match index (`make_board.js:94-100`);
- margin 4.5%, de-vigged exactly.

**Results: none.** These fixtures are never played, so nothing can be settled. All 12 fixtures were graded `research` (the top grade), and all 12 became "opportunities" because the edge gate is ≥ 2 points.

Each gap below (model − market) is split into:

- **(a)** the surface-Elo wiring bug: published p minus p with `d_surface_elo` wired from `clay_elo`;
- **(b)** serve/return/SOS not supplied on the board: p_fix minus the Lab path, which does supply them;
- **(c)** **the unattributed residual**: Lab p minus the fixture's base market;
- **(d)** the fixture's injected offset.

Intercept = 0 for every model below.

#### Match 1: `fixture:ATP:1`, ATP Player 512 vs ATP Player 889 (clay, best of 3)

Board model as published (`model_predictions.inputs.features`):

| Feature | x (A−B) | Coef | Contribution (logit) |
|---|---:|---:|---:|
| d_elo (1732.372 − 1642.431)/100 | 0.89941 | −0.018360 | −0.01651 |
| d_surface_elo | **missing → 0** (clay 1583.147 vs 1479.901 on file) | 0.485786 | **0.00000** |
| d_rank_log | 0.25447 | 0.059214 | 0.01507 |
| d_rank_points_log | 0.12723 | 0.116236 | 0.01479 |
| d_surface_experience | 0.12384 | 1.025564 | 0.12701 |
| d_age | 0.60000 | 0.006528 | 0.00392 |
| d_form_90, d_serve, d_return, d_sos | missing → 0 | — | 0 |
| d_rest (A 281 d, B 122 d, both capped at 14) | 0 | −0.038617 | 0 |
| **z** | | | **0.14427** → p = 1/(1+e^−0.14427) = **0.53600** |

- **Fair price.** 1/0.536 = 1.8657 → **−116 / +116**.
- **Market.** Power 90.62 vs 74.44 → base = 1/(1+10^(−16.18/22)) = 0.84468; offset −0.05 → **0.79468**.

| Gap component | Points |
|---|---:|
| **Model − market** | **−25.87** |
| (a) Surface-Elo bug: x = 1.03246 → +0.50155 logit → z = 0.64582 → p = 0.65607; 53.60 − 65.61 | −12.01 |
| (b) Serve/return/SOS unwired: 65.61 − 66.80 (Lab) | −1.19 |
| (c) **Unattributed residual**: 66.80 − 84.47 | **−17.67** |
| (d) Fixture offset (−(−0.05)) | +5.00 |
| Check: −12.01 − 1.19 − 17.67 + 5.00 | **−25.87** |

**Explaining the residual.** The fixture's slope is arbitrary: 16.18 power points ≈ 1.62 tour-Elo SD ≈ 93.5 Elo, which Elo-400 prices at 63%, yet the fixture prices it at 84%. Separately, player A had a **281-day layoff** that the model cannot see.

#### Match 2: `fixture:ATP:0`, ATP Player 360 vs ATP Player 463 (clay, best of 3)

| Feature | x | Coef | Contribution |
|---|---:|---:|---:|
| d_elo (1752.806 − 1732.493) | 0.20313 | −0.018360 | −0.00373 |
| d_surface_elo | **missing → 0** (clay 1694.390 vs 1665.082) | 0.485786 | 0 |
| d_rank_log | 0.09585 | 0.059214 | 0.00568 |
| d_rank_points_log | 0.04735 | 0.116236 | 0.00550 |
| d_form_365 | 0.11110 | 0.000487 | 0.00005 |
| d_rest (A 0 d, B 28 d → (0 − 14)/14) | −1.00000 | −0.038617 | +0.03862 |
| d_workload_14d | 0.20000 | −0.044522 | −0.00890 |
| d_surface_experience | −0.01418 | 1.025564 | −0.01454 |
| d_age | 1.50000 | 0.006528 | 0.00979 |
| **z** | | | **0.03246** → **p = 0.50812** (fair 1.9681, −103/+103) |

- **Market.** Power 94.15 vs 90.64 → base 0.59082; offset +0.07 → **0.66082**.

| Gap component | Points |
|---|---:|
| **Model − market** | **−15.27** |
| (a) Surface-Elo bug: x = 0.29308 → +0.14237 → p = 0.54360 | −3.55 |
| (b) Serve/return/SOS: 54.36 − 53.31 | +1.05 |
| (c) **Unattributed residual**: 53.31 − 59.08 | **−5.77** |
| (d) Fixture offset | −7.00 |
| Check | **−15.27** |

#### Match 3: `fixture:ATP:3`, ATP Player 631 vs ATP Player 808 (clay, best of 3)

| Feature | x | Coef | Contribution |
|---|---:|---:|---:|
| d_elo (1585.416 − 1568.198) | 0.17218 | −0.018360 | −0.00316 |
| d_surface_elo | **missing → 0** (clay 1619.199 vs 1620.707) | 0.485786 | 0 |
| d_rank_log | −0.06878 | 0.059214 | −0.00407 |
| d_rank_points_log | −0.03377 | 0.116236 | −0.00392 |
| d_form_90 | 0.50000 | −0.016750 | −0.00838 |
| d_form_365 | 0.01430 | 0.000487 | 0.00001 |
| d_rest | −1.00000 | −0.038617 | +0.03862 |
| d_workload_14d | 0.20000 | −0.044522 | −0.00890 |
| d_surface_experience | 0.05797 | 1.025564 | 0.05946 |
| **z** | | | **0.06964** → **p = 0.51740** (fair 1.9327, −107/+107) |

- **Market.** Power 65.21 vs 62.23 → base 0.57735; offset +0.07 → **0.64735**.

| Gap component | Points |
|---|---:|
| **Model − market** | **−13.00** |
| (a) Surface-Elo bug: x = −0.01508 → −0.00733 → p = 0.51557 | +0.18 |
| (b) Serve/return/SOS: 51.56 − 49.59 | +1.97 |
| (c) **Unattributed residual**: 49.59 − 57.74 | **−8.14** |
| (d) Fixture offset | −7.00 |
| Check | **−13.00** |

**Takeaways.**

1. The wiring bug alone moved the published number by up to 12 points.
2. Even after every model-side fix, residuals of 6-18 points remain against a market built from the same ratings. The model's probabilities are far flatter (0.46-0.54 on the board for all 12 fixtures) than any rating-based market.
3. The repo cannot repeat this exercise on real closes.

---

### 6. Card consistency

| Check | Result | Max discrepancy |
|---|---|---|
| Board win prob ↔ fair decimal ↔ fair American (`price_board.js:266-274`) | Consistent: `1/p`, then American rounding. The B side is exactly `1−p` (zero vig). | **0.104 pts** (implied prob of the rounded American vs `prob_a`, 12 synthetic rows) |
| Lab "drivers" (`tennis_lab.js:550-604`) vs the Lab probability | Contributions are logit-scale `coef × diff`. Sum of the top-8 drivers vs `logit(p)`: residual ≤ 0.0071 logit (≈0.18 pt). Breaks when more than 8 non-zero drivers exist (truncation at :604) or p hits the 0.02/0.98 clamp (:547). | 0.0071 logit |
| **Board vs Lab, same matchup** | **Two different probability paths.** The board leaves surface Elo, serve, return and SOS null (`price_board.js:74, 91-93`). The Lab fills them from the rating row (`tennis_lab.js:689-711`), and when no surface is specified it substitutes **overall Elo for surface Elo**, double-counting Elo (:696). Clamps differ: 0.005/0.995 (`tennis_model.js:844`) vs 0.02/0.98. | **13.2 pts** (ATP:1: board 53.6% vs Lab 66.8%) |
| **WTA research card** (`wta.daily_research`, the old Tennis panel) | Components `gap`, `dominance`, `upset`, `surface`, `form` (`wta_board.sql:177-187`) sum to a 0-100 `research_score` (:191-193). They have **no arithmetic relation to the win probability or fair price**. `upset` duplicates `gap` whenever the model prefers the lower-ranked player (both 0.1 × rank gap). `fav_price`/`fav_dec` are `1/de-vigged market prob` labelled as a price (:220-226). | Replicated on synthetic ATP (same SQL with `'ATP'`): ATP:1 components 5.1 + 8.1 = **score 13** beside **model 53.6% / fair 1.866** and **"fav_price" 1.26**. ATP:3: gap 2.2 **and** upset 2.2 (double count). ATP:4: model favourite at 51.2% shown with "price" 2.19 (the market's underdog). |
| Board "market prob" | Labelled de-vigged, but in production it is **raw best-price implied probability**: `no_vig_prob` is always NULL (§7 unit bug) and the code falls back to `implied_prob` (`price_board.js:243`). Each side's best price can come from a different book, so overround can be about 0 or negative. | Demonstrated: true fair 0.62 → card shows 0.645 (+2.5 pts) |

---

### 7. Measured vs logged

**Closing-line capture.**

- **Tables and writers.**
  - `tennis.market_captures` (`tennis_live_center.sql:561-583`) holds PRE/LIVE-tagged ticks copied from `public.signals` by `sync_events.js:194-226` and `live_poll.js:484`.
  - `tennis.odds_snapshots` is appended by `price_board.js:172-198`.
  - `prediction_record.closing_prob_a`, `closing_odds_a_decimal`, `clv` and `beat_close` are written by `settle_record.js`.
  - `public.signals.closing_sharp_fair` is written by the shared `close` function for market-engine rows (not this model).
- **Coverage.** Unknowable without the database. Signs point to it being small:
  - capture stopped for tennis at retirement (`capture/index.ts:3409-3411`; `close/index.ts:1232`);
  - the live poller failed every poll from 2026-09-11 to 09-16 (`tennis-live.yml:20-24`);
  - the record contract was not installed or loaded on 2026-09-20/21 (§1a).

**The unit bug: CLV is always NULL.**

- `public.signals.sharp_fair` is a **fair probability**: `capture/index.ts:2612-2617`, `sharp_fair: v.fair_probability ?? v.consensus_fair`. `sync_events.js:209` copies it into `market_captures.sharp_fair` unchanged.
- `settle_record.js:64-67, 92-93` treats it as a **decimal**: `closingProbA = probFromDecimal(closeFair)`. `probFromDecimal` returns NULL for any value ≤ 1 (`tennis_model.js:862-866`), so `closing_prob_a`, `clv` and `beat_close` are **always NULL**.
- The odds provider makes the same assumption (`providers/edgedesk_odds.js:64-67, 82, 192`), so `no_vig_prob` is always NULL.
- `lib/tennis_research.js:413-414, 423-427` correctly treats `sharp_fair` as a probability, so the two halves of the codebase disagree.
- The synthetic fixture writes `sharp_fair` as a **decimal** (`make_board.js:103-104`). The tests therefore pass while production cannot work.
- Reproduced: `docs/model-loop/audit_scripts/tennis/units.js` → `probFromDecimal(0.62) → null`.

**The CLV definition is also wrong.**

- `clv = closing_prob_a − market_prob_a`, always from side A, which is ESPN "home". It ignores which side the model favoured (`settle_record.js:95-96`), so `beat_close` measures line drift, not model skill.
- `wta.watchlist` mirrors it per player (`wta_board.sql:311`).
- `lib/tennis_research.js:423` defines CLV as `fairClose × entryDec − 1`: a **different** formula in the same codebase.
- `settle_record` takes the latest PRE capture with no 6-hour lead cap; `tennis_research.closingReference` (:402-420) has one.

**Results settled.** `settle_record.js` writes `outcome_a`, Brier and log loss per row. The views `public_record_summary` (`tennis_record.sql:1523-1544`) and `public_record_calibration` (:1546-1557) aggregate them. There is no committed count, and production volume was likely about zero (§1a).

**Backtest against the close: none.** `build_model.js:242-246` prints "no historical market prices are captured, so no market comparison is possible". The model card (:22-25) and the registry (`market: NOT_TESTED`) say the same.

**Backtest against outcomes (no market):**

| Source | Test n | Log loss | Brier | Accuracy | ECE | vs baselines |
|---|---:|---:|---:|---:|---:|---|
| Real archive, `tennis-baseline-2026.09.19.874` (`docs/tennis-lab-implementation-report.md:151-175`) | 53,850 | **0.6144** | **0.2134** | 65.7% | 0.0177 (worst bin gap 3.5 pts) | Elo 0.6261 / 0.2185; surface Elo 0.6346 / 0.2223; ranking 0.6310 / 0.2207 |
| Production-cardinality synthetic (`docs/tennis-implementation-report.md:219-236`) | 43,131 | 0.6047 | 0.2094 | 66.7% | 0.0093 | Elo 0.6182 |
| **My synthetic re-run** (60,015 matches; test window 2006-08-02 → 2026-10-17) | 9,003 | 0.6542 | 0.2315 | 59.7% | 0.0089 | Surface Elo **0.6510 beats the model** → gate fails |

These are unverifiable from the repo: the archive is not committed and the registry row is not committed. **None of them is measured against the close.** Separately, the promotion gate compares a candidate's test log loss with the active model's stored log loss from a *different* window (`build_model.js:285-289`). The weekly "calibration review" refits a new model in dry-run rather than evaluating the active one (`tennis-record.yml:466-475`).

---

### 8. Proposed disagreement threshold

**Proposal.** Flag at **8 win-probability points**. Suppress, or treat as a data error, above **15 points**. Generate **no "opportunities" at all** until a closing-line backtest exists. The current `GATES.minEdge = 0.02` (`tennis_model.js:939`) should be replaced.

**Justification.**

1. **Noise floor.** For calibrated forecasts where the market's information contains the model's, E[(p_market − p_model)²] = Brier_model − Brier_market.
   - The only measured analogue is model vs Elo: √(0.2185 − 0.2134) = √0.0051 = **7.1 pts RMS**. The model already wanders about 7 points from plain Elo to gain just 0.005 Brier.
   - A tennis closing line is at least as informed as Elo plus form. Kovalchik (2016), cited in `engine/registry.json:1672`, found bookmaker-implied probabilities more accurate than every rating model. So model-vs-close disagreement noise is **at least ~7 pts RMS**.
2. **What each threshold implies under that noise** (σ ≈ 7, market efficient):
   - |gap| > 2 pts occurs about **78%** of the time. That is why 12 of 12 synthetic fixtures became opportunities.
   - |gap| > 8 pts occurs about 25% of the time, so worth a human look.
   - |gap| > 15 pts occurs about 3% of the time. At that size the likely cause is the model's own blind spots: a layoff (ATP:1), injury, stale May-2026 ratings, a missing surface, or the wiring bug.
3. **Consistency with existing code.** 8 points matches the code's own `large_model_market_gap` label (`price_board.js:440`).
4. **Raising the threshold later.** It should only drop below 8 once settled, model-oriented CLV on several hundred matches shows the gaps predict closing-line movement.

---

### 9. Data availability

**Match history (in the database only; the repo does not include it).**

- 361,567 stored matches: ATP 199,386 / WTA 162,181.
- 1967-12-25 → **2026-05-25**; 15,515 players; 723,134 feature rows (`docs/tennis-lab-implementation-report.md:82-83`). The other report says 1967-12-28 (`docs/tennis-implementation-report.md:185`).
- Licence: **CC BY-NC-SA 4.0, non-commercial** (`docs/runbooks/tennis-licensing.md:45`).
- Dates are tournament-week precision. Surface is known for 98.5% (ATP) and 96.98% (WTA).

**Closing odds owned: zero historical.** The model card (:22-25) and the registry ("No closing archive", "no licensed closing archive") confirm it. Live `market_captures` cover at most a few weeks of Aug-Sep 2026, with an unknown count and broken CLV.

**Committed in the repo.**

- `datapack/quant_v1/data/tennis_atp/matches_sample.csv`: 1,233 singles rows. `tennis_wta/…`: 1,609. Both cover four 2024 query dates (`COVERAGE.md:47-48`).
- Eight raw ESPN 2024 scoreboards.
- One synthetic scoreboard fixture.
- **No odds of any kind.**

**Serve/return data.**

- The archive has **match-level** serve totals from 1991 onward (`w_svpt`, `w_1stIn`, `w_1stWon`, `w_2ndWon`, `w_SvGms`, `bp*`, `matches` columns). `build_features.js:84-97` turns them into rolling serve and return strength. About 18% of players have a rolling rate.
- **No point-by-point data.** Model card :133; `datapack/.../points_EMPTY_TEMPLATE.csv` is an empty template.
- Live ESPN set stats exist only for matches the poller watched (`match_set_stats`, `player_baselines.obs_*`).
- `tools/tennis/README.md:33-36` ("the licensed record carries … no point-level serve numbers") and `app.html:37444/43354` ("Serve/return splits … are not ingested") **understate** what the archive holds.

**Enough for a real walk-forward?**

- **Against outcomes: yes.** About 35 seasons with serve data (1991-2026) allow yearly re-fits, and the code supports it apart from the `--since` truncation bug (Problems).
- **Against the close: no.** The project owns no closes. A real walk-forward needs an external historical odds source with timestamped closes, with licensing settled. tennis-data.co.uk, for example, publishes bookmaker and Pinnacle closing odds for ATP and WTA main-tour matches from the 2000s onward; this is unverified here and needs a licence check.
- A fixed CLV computation and a model-oriented CLV definition are also prerequisites.

---

### Problems

| Severity | Problem | Evidence (file:line or data) | Impact |
|---|---|---|---|
| **Critical** | Surface Elo never reaches the live model: `ratingSide` reads `a_surface_elo`/`b_surface_elo`, which `boardSql` never selects; no test covers it | `tools/tennis/price_board.js:74` vs `:103-121`. Synthetic run: 12/12 predictions list `d_surface_elo` missing; ATP:1 53.6% vs 65.6% when wired | Drops one of the two Elo terms. Probabilities collapse toward 50% (all 12 fixtures 0.46-0.54) and surface specialists are mispriced. The same failure class as NFL's "wrong component weights". |
| **Critical** | Ratings frozen at archive end (2026-05-25); no new result ever enters `tennis.matches`; form/rest/workload anchored to the archive end; freshness gate reads `computed_at` | `incremental.js:136-166`; `build_ratings.js:81-98, 189-196, 299-304`; `price_board.js:248`; no non-test `insert into tennis.matches` | Every post-May price uses 4+-month-old strength and fatigue presented as fresh. An extreme "sticky prior". |
| **Critical** | CLV and closing prob always NULL: `sharp_fair` is a probability in production but treated as a decimal; the fixture uses decimals and hides it | `capture/index.ts:2617`; `sync_events.js:209`; `settle_record.js:92-96`; `edgedesk_odds.js:64-82, 192`; `make_board.js:103-104`; reproduced in `docs/model-loop/audit_scripts/tennis/units.js` | The model can never be measured against the close; `public_record_summary.mean_clv` and `wta.watchlist` are empty. |
| **Critical** | Never tested against any market; no historical closes owned | `build_model.js:242-246`; `docs/model-card-tennis.md:22-25`; `engine/registry.json` `market: NOT_TESTED` | No evidence any disagreement is an edge. |
| High | Live surface and format are likely unknown: ESPN carries no surface; `best_of` is parsed from `format.sets`, which the real feed lacks (`regulation.periods = 5` everywhere) | `espn.js:173-177, 265`; `datapack/.../raw/scoreboard_2024*.json.gz` (0 surface fields); datapack shows `best_of = 5` for ATP 250s | Model runs surface-blind and format-blind (`elo_x_bo5 = 0` at Slams); surface experience comes from the "unknown" bucket. |
| High | Serve, return and SOS are hard-coded null on the board but used in training (train/serve skew); still graded "research" | `price_board.js:91-93`; `tennis_model.js:932-973` | Completeness capped at 0.75; the trained weight structure is not what is served. |
| High | `market_prob` on cards is raw best-price implied probability, not de-vigged (no_vig always NULL → fallback) | `price_board.js:243`; `edgedesk_odds.js:82, 127-143` | Edges and EV are biased; the label is false. |
| High | CLV definition ignores the model's side (always side A) | `settle_record.js:95-96`; `wta_board.sql:311` | `beat_close` measures line drift, not skill. |
| High | Coefficients fitted on about 1968-2008 only; validation unused; active production coefficients not committed | `build_model.js:52, 184-186, 202`; `docs/tennis-implementation-report.md:220-224` | Era mismatch; production numbers are irreproducible. |
| High | No injury, withdrawal or layoff handling; rest capped at 14 days; no rating decay | `tennis_model.js:753-757`; `build_ratings.js:266-274`; synthetic ATP:1 (281-day layoff → `d_rest = 0`) | The NFL "personnel changes ignored" class. |
| High | Edge gate of 2 points | `tennis_model.js:939`; `price_board.js:294-317`; 12/12 synthetic fixtures became opportunities | About 78% of matches clear it on noise alone. |
| High | Two probability paths for the same matchup (board vs Lab) | `price_board.js:70-97` vs `tennis_lab.js:689-711`; ATP:1 53.6% vs 66.8% | Users see contradictory numbers. |
| Medium | WTA research card components sum to a 0-100 score unrelated to prob or price; `upset` double-counts `gap`; "price" is 1/no-vig market | `wta_board.sql:177-193, 220-226`; replicated: ATP:1 score 13 vs 53.6% / 1.866 / "price" 1.26 | The card does not reconcile to the fair line. |
| Medium | Walkovers settled and scored; retirements settled as full results | `settle_record.js:71` vs `build_model.js:105-108` | Contaminates public Brier and log loss; differs from book void rules. |
| Medium | Board prices matches already `live` and publishes the "pre-match" record; no first-point or DB check | `price_board.js:137, 320-322`; `tennis_record.sql:1431-1518` | The record's pre-match integrity is not enforced. |
| Medium | `build_features --since` truncates rolling history (window restarts at `since`) | `build_features.js:71-75`; called by `incremental.js:199`. Synthetic: 2026 rows with serve rate 663 → 188 of 736; mean sample 43.3 → 2.8 matches | Silently corrupts features on any incremental rebuild. |
| Medium | `best_of_5` and `level_weight` are mathematically inert under symmetric training but documented as inputs | Synthetic fit: both 0, intercept 0; `docs/model-card-tennis.md:47-48` | The model card overstates format and level modelling. |
| Medium | Archive Elo is opaque (initialisation, K, surface method unknown); EdgeDesk adds a fixed K=32 step; thin samples not shrunk in the probability | `import_archive.js:161-171`; `build_ratings.js:45, 186-196`; `tennis_model.js:899-916` | Priors cannot be audited or tuned. |
| Medium | Promotion gate compares different windows; weekly "review" refits instead of evaluating the active model | `build_model.js:285-289`; `tennis-record.yml:466-475` | Promotion and drift checks are unreliable. |
| Medium | Lab substitutes overall Elo for surface Elo when surface is unknown (double count) | `tennis_lab.js:696` | Inflated confidence on surface-unknown projections. |
| Low | Docs claim no serve data is ingested, but match-level serve totals are imported and used | `tools/tennis/README.md:33-36`; `app.html:37444, 43354` vs `build_features.js:84-97` | Misleading documentation. |
| Low | `match_context` joins opportunities on `prediction_id`, which `price_board` never writes | `tennis_record.sql:1835-1855` vs `price_board.js:375-387` | Opportunity fields always NULL on the match page. |
| Low | Lab band symmetric on the probability scale (can exceed [0,1]); clamps differ (0.005-0.995 vs 0.02-0.98) | `tennis_lab.js:140, 547, 593-600`; `tennis_model.js:844` | Cosmetic range issues. |
| Low | Archive is tournament-week dated (negative `rest_days`); the archive's own `_pre` columns cannot be leak-tested | `docs/tennis-lab-implementation-report.md` §6 | Possible within-week leakage in training. |
| Low | Deployed-but-unexported legacy functions (`tennis_ingest`, `wta_odds`, `wta_close`) | `supabase/odds_api_emergency_stop.sql:80, 90` | Unknown production behaviour. |
| Info (OK) | No home or first-listed bias: intercept fits to 0 and the model is antisymmetric | Synthetic fit intercept 0; `build_model.js:193-200` | The NFL "home field too high" class does not apply. |
| Info (OK) | Own rolling features are leak-free | `node tools/tennis/leakage.test.js` → PASS, 86 assertions (local PG16); `model.test.js` 200, `lab.test.js` 153, `tennis.test.js` 283, `providers.test.js` 101 all pass | — |

**Reproduction scripts:** `docs/model-loop/audit_scripts/tennis/` (`decompose.js`, `units.js`, `atp_daily_research.sql`). The synthetic-archive pipeline run used a throwaway local PostgreSQL that was deleted afterwards.

---
