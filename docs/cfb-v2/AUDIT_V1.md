# CFB V1 audit (before the V2 upgrade)

Audited 2026-09-27 from the code, the committed artifacts, and a cold replay of
the shipped V1 engine over 2014–2025 (`football/cfb_p4/research/backtest_engine.js`).
V1 = `edgedesk_cfb_p4_v1.0.0` (feature version `cfb_p4_fv1`, trained through 2025).

## 1. What exists

| Area | Where | What it does today |
|---|---|---|
| Data sources | `football/cfb_p4/research/fetch_data.sh` | `sportsdataverse/cfbfastR-data`: schedules 2001–25, rosters, `player_stats` 2014–25, play-by-play **2004–2022 only**, the multi-book line archive (open + close, 2006–25) |
| Recent play data | `football/fbs_epa/`, `football/data/build_box.js` | 2023+ efficiency rebuilt from the lighter `player_stats` table with EdgeDesk's own EP surface (r = 0.92 vs real EPA on the overlap) |
| Database | `supabase/*.sql` | Write-once pregame tables exist (`desk_prediction_history`, `research_packets`, `stake_recommendations`, `recommendation_ledger`, `editorial_snapshots`, `research_journal`) with immutability / no-delete / no-lookahead triggers. DDL for `signals`, `cfb.*` and `model_predictions` is **not in the repo**. No runner: SQL is pasted into the Supabase editor or applied by `deploy-intelligence.yml` |
| Edge functions | `supabase/functions/edgedesk_ai` | Never projects CFB. Reads `football/fbs/slate.json` over HTTP; the pricing kernel `_pricing.js` (EDPRICE) is market-anchored for CFB (`blend:null`, fair = market) |
| Where V1 runs | browser + node | `app.html` loads `football/cfb_p4/engine.js` (`EDCfbP4.projectGame`); `football/fbs/build_coverage.js` replays state and writes `slate.json` / `reliability.json` (market "NOT JOINED IN THIS BUILD") |
| Crons | `.github/workflows/` | `football-weekly-build` (daily 09:40 + 2-hourly FINAL check, Aug–Jan), `football-enrichment`, `starter-context`, `availability-sync`, `model-health` (daily), `learning-loop` (daily), `football-validation` (monthly), `football-model-record` (hourly) |

## 2. How V1 builds a number

| Component | Implementation | Assessment |
|---|---|---|
| Team rating | Online Elo-style capped-margin recursion `r += k·err` (`engine.js:446`), two tracks (carried vs this-season) blended by a learned prior-weight curve | **Not jointly opponent-adjusted.** Adjustment happens only through sequential error updates; a result's credit depends on the order games were absorbed. Uses final margins, so turnover luck and garbage-time scoring feed the core rating directly |
| Efficiency | EWMAs with a single-pass adjustment `perf = v − league_mean − opponent's current EWMA` (`:494`) | Not converged jointly. **Ships as a 2025 seed**: the browser has no play feed, so in production the matchup layer reads last season's closing snapshot ("TRAINED SEED, not updated since") |
| Home field | One league constant, 4.08 pts | Per-venue HFA was tested and rejected (it absorbed team quality). No team/venue partial pooling, no validated context |
| Opponent strength | Via the recursion only; conference strength term (prior-season cross-conference differential, fades by 6 games) | Reasonable, leak-free, but coarse |
| QB | Coefficient 10.1 pts per EPA/dropback; the college EPA series is "not on the fitted scale" (`fbs_epa/epa_contract.js`), so **the QB term contributes 0 points to every college spread** | QB status is a warning string, not a projection input |
| Injuries | Position weights ship untrained → 0 points | Honest, but no variance widening either (only a warning) |
| Current form | Implicit in the recursion's step size | No separate recent-form horizon, no shrinkage toward the season |
| Market join | `market.gap = model − market`; `orientationFault` drops sign-flipped rows (|gap| > 21 and |model + market| ≤ 7) | Good guard. Two conventions coexist (engine margin vs DB book line); conversions are scattered (`research_core.js`, `app.html`, `_lib.ts`) |
| Fair spread | Sum of nine terms: rating, HFA, QB, matchup, travel (0), schedule stress, injury (0), rivalry (0), conference | Four of nine terms are structurally zero in production |
| Win probability | Normal CDF of fair / sigma | |
| Uncertainty | `sigma = base·(1 + λ·early_season)`: of seven offered drivers the ML fit kept one | Essentially a **fixed sigma**; rank correlation of predicted sigma with realised error 0.044 out of sample. No intervals published for CFB |
| Reliability | `lib/cfb_reliability.js`, 0–100 from six components with caps | Does not include edge size (good) but is **not calibrated** (`validated:false`, 76 backfilled games); 78 of 98 current games are STRONG or better |
| Storage | `football/fbs/slate.json`, `record/football/cfb_2026.json` (frozen JSON), DB write-once tables for desk outputs | No per-row `model_version` in the slate |

## 3. V1's own record (confirmed by the cold replay)

* Holdout 2022–25 spread MAE **12.77 vs closing market 12.02**; totals 12.91 vs 12.50.
* ATS vs the close 46–50% at every disagreement threshold and **worse as disagreement grows** — the signature of a projection noisier than the market.
* v1.1: the walk-forward weight on the model against the close clamps to **zero** in every scheme.
* Weeks 0–2 MAE 13.40 vs market 12.02 (the preseason gap is missing information).
* Home-dog bias +3.7 pts (market-defined).

## 4. Where V1 is statistically weak

1. **No joint opponent adjustment.** Sequential Elo-type updates are order-dependent and slow to correct early-season misreads; efficiency is adjusted in one pass against the opponent's *current* EWMA, which is itself unadjusted.
2. **Box-score/score-margin core.** The rating learns from capped final margins, so turnovers (lag-1 persistence r = 0.077), return scores and garbage-time points move it as much as snap-to-snap play.
3. **Stale efficiency in production.** The browser never updates the efficiency EWMAs; the matchup layer reads a 2025 seed all of 2026.
4. **Single time horizon.** No separation of season strength vs recent form, so no way to test (or refuse) recency.
5. **Uncertainty is not heteroskedastic.** One surviving driver; intervals are not published because they would not be honest.
6. **Structural zeros.** QB, injuries, travel, rivalry contribute 0; the QB layer in particular cannot move a line even after a starter change is known.
7. **No ensemble.** One specification; no disagreement signal.
8. **Market layer is anchored to the market.** EDPRICE sets fair = market for CFB, so the "movement" read compares the opener with the current market — a momentum call, not a rating comparison. Validation tiers disagree between EDINTEL and EDPRICE for CFB totals and moneyline.

## 5. Redundancy and weighting problems

* Three different garbage-time rules are in use (`players/build_players.js` 38/28/22/16 by quarter; `matchup/profiles.js` Q2>38/Q3>28/Q4>22; rankings discount at a declared 0.35 weight).
* Staleness thresholds differ by layer (6 h, 12 h, 72 h, a TTL ladder, reliability bands 1/3/6/24 h).
* `daily_check.js` uses a reconcile tolerance of 10 for the orientation guard; everywhere else uses 7.
* `pricing_cfb.json` mixes windows (MAE from 2015–25, ATS from 2022–25).

## 6. Leakage review

V1 is careful: cold replays, strictly lagged league centres, a completion buffer in the QB experiment, the roster `class` column refused because it carries a player's eventual class. Residual exposures found:

* The provider EP model behind `fbs_epa` was trained on 2004–2025, so historical EPA values embed a model that "saw" later seasons (a definition-level look-ahead, flagged by V1 itself). **V2 carries the same caveat** — it uses the provider's EP values — and reports it.
* The provider's win-probability columns read the pregame spread; any WP-based garbage-time filter would leak market information. V1 does not use them; V2 forbids them at load time.
* Historical QB fields in `cfb_matchup_line` (`qb_name`, `returning_qb`, …) are the season's realised usage leader — leaky. Neither version uses them.

## 7. Safeguards worth keeping (V2 keeps all of them)

Orientation-fault guard; `trained_through + 1` season gate; sanity bounds on spread/total/sigma; write-once DB triggers with no-lookahead checks; "missing input widens the distribution, never moves the mean"; `unproven` / tier ceilings driven by the validation record; `points_applied:false` for layers that failed validation.

## 8. Data finding that changed the plan

V1 states play-by-play stops at 2022. It does not: the successor release
`sportsdataverse/sportsdataverse-data` (tag `espn_cfb_pbp`) publishes full
enriched play-by-play for **2004–2026** under one EP model. V2 is built on it.
That feed has its own drift, found and handled by execution:

* 2013 does not tag sacks (32 of ~3,000) → 2013 pass/rush splits and sack/havoc rates are MISSING, never zero;
* the provider's stuffed-run / line-yard / opportunity / havoc flags drift (stuff rate 0.18 → 0.08, pass break-ups 754 → 3,418 per season) → V2 recomputes those from raw rushing yardage and builds front havoc from sacks + run TFLs only.
