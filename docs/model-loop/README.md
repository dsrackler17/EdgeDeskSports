# The model loop

One framework, per-sport adapters, for building, measuring and improving EdgeDesk's prediction models against the closing line.

- **Audit of every model:** [`audit_report.md`](audit_report.md). It is the reason this exists.
- **NFL backtest (Phase 1):** [`nfl/BACKTEST.md`](nfl/BACKTEST.md).
- **NFL this week:** [`nfl/weekly_model_report.md`](nfl/weekly_model_report.md), the version history [`nfl/versions.json`](nfl/versions.json), every candidate ever tried [`nfl/candidates.jsonl`](nfl/candidates.jsonl).
- **CFB backtest and weekly loop:** [`cfb/BACKTEST.md`](cfb/BACKTEST.md); version history [`cfb/versions.json`](cfb/versions.json).

## Layout

```
model_loop/
  core/                      shared, sport-agnostic
    ratings.py               penalized weighted least squares with explicit priors; recency weights;
                             exact prior/data split of every rating; weighted ridge with a prior pull
    distribution.py          key-number margin distribution centred on the projection; win / cover /
                             push / centred range from one table; odds conversion
    calibration.py           Platt and isotonic, fitted on earlier seasons only
    metrics.py               MAE, RMSE, Brier, log loss, calibration bins, ATS vs close, paired tests, CLV
    walkforward.py           windows, evaluate() vs the close, compare(), the promotion rule
    snapshots.py             append-only rating snapshot ledger (-> public.model_rating_snapshots)
    registry_sql.py          research_model_versions / research_model_results SQL, schema-introspecting
    versions.py              a sport's version history: immutable versions, promote, rollback
    data_status.py           the degraded-data flag stamped on every card and slate at each refresh
    head_to_head.py          the board's own number captured beside the loop's and graded on the same games
    db_sync.py               SQL that mirrors the ledgers and versions.json into Supabase (idempotent)
  adapters/
    nfl/                     ingest (nflverse pbp, schedule, rosters, snaps), geo (travel, time zones),
                             ratings (unit ratings + QB + priors + market rating), model (walk-forward
                             margin and total, attribution), cards, backtest, report,
                             weekly (refresh / score / research / report: the loop)
    cfb/                     ingest (sportsdataverse pbp, schedules, talent, returning production; the
                             cfbfastR line archive via cfb_p4's build_market.py), ratings (unit ratings for
                             every FBS and FCS team around fitted division means + QB + priors + market
                             rating), model, cards, backtest (vs a cold replay of football/cfb_p4), report,
                             weekly (Sunday-night loop)
  ledger/nfl/                append-only: cards_<season>.jsonl (every pregame publication),
                             site_<season>.jsonl (the board's number, for the head to head),
                             <season>.jsonl (rating snapshots); ledger/cfb/ the same for CFB
  health.py                  every loop's status -> model_loop/health.json (the app's System health, "Learning loops")
  tests/                     core guarantees and the loop's rules (run: python3 -m unittest discover -s model_loop/tests -t .)
football/{nfl,cfb}/model_loop/  current.json (this week's numbers from the served version), record_<season>.json
supabase/model_loop.sql      append-only snapshot table, RLS, service-role ingest
supabase/model_loop_nfl_registry.sql   generated: NFL-CORE v1.0.0 and the v2 candidate, with results
docs/model-loop/             this folder: audit, preregistration, tuning log, backtest, cards
```

## What the core guarantees

1. **Components sum to the fair line exactly.** A sport's projection is a linear sum of named components grouped as *base strength*, *environment* and *rest & travel*, so the card prints the model itself rather than an explanation of it. Tests hold the residual to 1e-9.
2. **Outcome ranges are centred on the projection.** The distribution is solved so that its mean is the projection, and the 80% range is the symmetric interval holding 80% of it.
3. **One distribution prices everything on the card.** Win probability, fair moneyline, cover and push probabilities and the range all come from the same table.
4. **Prior vs this season, exactly.** Every rating is `from_prior + from_data` (the fit is linear in both), so a card can say how much of a number is last season.
5. **Nothing is evaluated on the games it was fitted on.** Coefficients are refit before each season on earlier seasons only. Hyperparameters are tuned on a declared window. The holdout is read once.

## Adapters

An adapter supplies five things:

- ingestion;
- the rating dimensions (NFL: pass offense, pass defense, rush offense, rush defense, quarterback, market rating);
- personnel adjustments;
- environment factors;
- its schedule cadence.

| Sport | Cadence (weekly refresh) | Status |
|---|---|---|
| NFL | Tuesday (full cycle); refresh daily | **Loop on** (`.github/workflows/model-loop-nfl.yml`). v2.0.0 served by the loop as a challenger to the board's number, graded head to head |
| CFB | Sunday night (full cycle, `.github/workflows/model-loop-cfb.yml`); refresh daily Aug–Jan | **Loop on.** v2.0.0 cleared the preregistered rule against a cold replay of the board's engine (cfb_p4 v1.0.1): better MAE and log loss over 2014–2025 and on the 2025 holdout (all games); FBS and FCS teams rated team by team. Served by the loop as a challenger; the board still prices from cfb_p4. Does not beat the close. [`cfb/BACKTEST.md`](cfb/BACKTEST.md) |
| MLB | daily in season | Not started. No closing archive owned: the loop can only grade against outcomes until closes are captured |
| WNBA | daily refresh; weekly research | **Loop on** (`basketball/loop.js`, `.github/workflows/model-loop-basketball.yml`). Outcome-graded only: no market data captured |
| CBB (men's, women's) | daily refresh; weekly research | **Loop on**, same as WNBA. The D1 fix is built behind `d1_fix` and evaluated (`basketball/eval_d1_fix.js`, `basketball/validation/ncaa?_d1_fix*.json`); off until a decision |
| NBA | daily refresh; weekly research | **Loop on**, same as WNBA (not in the original brief; the same engine) |
| UFC | per event: full cycle Sunday, refresh Thursday–Saturday (`.github/workflows/model-loop-ufc.yml`) | **Loop on, EXPERIMENTAL, nothing served yet.** Multi-year bouts from ESPN's scoreboard (`adapters/ufc/ingest.py`; the parser reproduces the data pack's 2024 bouts exactly). Walk-forward Elo, symmetric in the feed's fighter order. Preregistered (`docs/model-loop/ufc/prereg.json`, written before the multi-year data existed): served only if 2021–2024 beats the coin flip with its 95% interval below zero and 2025 is below it too. Outcome-graded only: no closes |
| Tennis | per event | Retired. Experimental; no closes owned |

## The weekly loop (Phase 2)

The weekly update has **two separate jobs**, so a rating refresh can never quietly change the model.

1. **Refresh (every slate).** Re-fit ratings with the *current version's* formula on the new results, write append-only snapshots, regenerate the cards, and score the settled slate:
   - line error vs the close, Brier, log loss, calibration, CLV;
   - every game beyond the sport's threshold, with its driving components.

   It never changes a weight, a decay rate or the structure.
2. **Research (every slate, after scoring).**
   - Attribute the week's largest misses to components and look for patterns.
   - Generate candidate changes.
   - Walk-forward test each candidate on every prior season plus the current season to date.
   - Log every candidate, pass or fail.

   A candidate is **promoted only if it lowers both margin MAE and log loss on the full backtest AND is no worse on the untouched holdout** (`core/walkforward.py promotion_decision`). Sports with thin history need a larger margin. A promoted change is a new version in `research_model_versions` with its result in `research_model_results`, and the previous version stays registered for rollback. One week's games never decide anything.

### NFL, as switched on

- **v2.0.0 is served by owner decision** (2026-10-21). It did not clear the preregistered holdout rule against v1 as trained: 2025 log loss was 0.6390 vs 0.6362, and the interval spans zero. It beats v1 on the full 2011–2025 backtest. `versions.json` records this.
- **The rule from here on is fixed.** A candidate is promoted only if both conditions hold:
  - over the full walk-forward backtest (2011 through the current season to date), it lowers margin MAE by at least 0.003 **and** log loss by at least 0.0002;
  - it is no worse on the most recent full season.
- **Candidates** come from a fixed catalogue (`weekly.py CATALOGUE`). The strongest significant pattern in this season's and last season's misses (|t| ≥ 2) gets the first two candidates that answer it, then the next pattern; the rest of the catalogue rotates through the remaining slots.
- **Every candidate is logged.** A second run in the same week (`research --only ...`) adds to that week's record rather than replacing it.
- **Roll back** by pointing `current` in `versions.json` at an earlier version (`Versions.rollback`). The next refresh serves it.
- **Head to head.** Each refresh also records the board's own pregame number (`football/nfl/slate.json`, read only) so the report grades the two on the same games. One season is not enough to rank them; the full backtest decides promotions.

```
python3 -m model_loop.adapters.nfl.weekly all            # what Tuesday runs
python3 -m model_loop.adapters.nfl.weekly refresh        # what the other days run
python3 -m model_loop.adapters.nfl.weekly research --only hfa_recent_era,division_on
```

### Basketball, as switched on

- `basketball/loop.js` keeps the NFL contract for the NBA, WNBA and men's and women's college.
- **Refresh (daily, `lab-build.yml`):** `basketball/walkforward.js` re-fits the ratings with the served version. Before the loop's first run that is the tuned configuration; from then on it is `docs/model-loop/<league>/versions.json` `current`.
- **Research (Monday, `model-loop-basketball.yml`):** candidates from a fixed catalogue, each walked forward over every scored season exactly as production prices.
- **Promotion rule:** over the full window (selection start to date), both conditions hold, and the candidate is no worse on the most recent full season:
  - moneyline log loss falls by ≥ 0.0002, with its paired 95% interval below zero;
  - margin MAE falls by ≥ 0.005.
- **Scoring-level changes** (`k_mu`) cancel in every margin, so they are judged on total MAE instead, and moneyline and margin must not get worse.
- **Outcome-graded only:** no closing prices are archived for basketball, so every version stays EXPERIMENTAL.

```
node basketball/loop.js all --league nba,wnba,ncaam,ncaaw
node basketball/loop.js research --league ncaam --only home_edge_tighter
```

### Health, and the degraded-data flag

- **On every card.** Each NFL and CFB refresh stamps `data_status` on every game and on the slate.
  - A game is flagged when its starter is unresolved, it has no reference line, or its components do not sum to the fair line.
  - The slate is DEGRADED when games already played have no result in the data yet (the ratings are behind by those games), or when a card does not reconcile.
  - The flag labels the number; it never changes it.
- **Across loops.** `python3 -m model_loop.health` (every three hours, `.github/workflows/model-loop-health.yml`) writes `model_loop/health.json`. Each loop is OK, STALE, DEGRADED or OFF_SEASON, with its reasons:
  - STALE: no refresh within 36 hours; no weekly research within 8 days; the newest result in the ratings over 4 days old while games are played.
  - DEGRADED: the cards say so, or the version history is missing.
- **In the app.** The System health panel shows a "Learning loops" row.
- **Head to head.** NFL and CFB both capture the board's own number (`football/nfl/slate.json`, `football/fbs/slate.json`) at each refresh and grade it beside the loop's on the same games (`core/head_to_head.py`).

The frozen CLV ranking protocol is not touched by any of this.

## Reproduce the NFL Phase 1 numbers

```
pip install -r model_loop/requirements.txt          # Python >= 3.12
python3 -m model_loop.adapters.nfl.ingest --fetch            # nflverse 2006-2026 -> .cache/model_loop/nfl (gitignored)
python3 -m model_loop.adapters.nfl.backtest prereg           # (already committed; hash checked by report)
python3 -m model_loop.adapters.nfl.backtest tune             # 2011-2019 only; appends docs/model-loop/nfl/tuning_log.jsonl
python3 -m model_loop.adapters.nfl.backtest report           # ablations on 2020-2024, then holdout 2025 and live 2026
python3 -m model_loop.adapters.nfl.cards                     # upcoming games -> docs/model-loop/nfl/cards_current.json
python3 -m model_loop.adapters.nfl.report                    # -> docs/model-loop/nfl/BACKTEST.md
python3 -m model_loop.adapters.nfl.backtest registry         # -> supabase/model_loop_nfl_registry.sql
python3 -m unittest discover -s model_loop/tests -t .
```
