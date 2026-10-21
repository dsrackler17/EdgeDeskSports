# The model loop

One framework, per-sport adapters, for building, measuring and improving EdgeDesk's prediction models against the closing line.

- **Audit of every model:** [`audit_report.md`](audit_report.md). It is the reason this exists.
- **NFL backtest (Phase 1):** [`nfl/BACKTEST.md`](nfl/BACKTEST.md).

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
  adapters/
    nfl/                     ingest (nflverse pbp, schedule, rosters, snaps), geo (travel, time zones),
                             ratings (unit ratings + QB + priors + market rating), model (walk-forward
                             margin and total, attribution), cards, backtest, report
  tests/                     core guarantees (run: python3 -m unittest discover -s model_loop/tests -t .)
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
| NFL | Tuesday | **Phase 1 built and backtested.** Weekly loop not yet switched on |
| CFB | Sunday night | Not started. Audit §CFB lists what the adapter must fix (personnel prior, FCS, QB) |
| MLB | daily in season | Not started. No closing archive owned: the loop can only grade against outcomes until closes are captured |
| WNBA | daily in season | Not started. No market data captured at all |
| CBB | daily in season | Not started. Home-court refit and non-D1 opponents fixed first |
| UFC | per event | No model exists. Experimental; no real backtest possible (566 bouts, 0 closes) |
| Tennis | per event | Retired. Experimental; no closes owned |

## The weekly loop (Phase 2): designed, not switched on

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

**Nothing in Phase 2 runs on a schedule until the NFL Phase 1 backtest has been reviewed.** The frozen CLV ranking protocol is not touched by any of this.

## Reproduce the NFL Phase 1 numbers

```
pip install pandas numpy pyarrow
python3 -m model_loop.adapters.nfl.ingest --fetch            # nflverse 2006-2026 -> .cache/model_loop/nfl (gitignored)
python3 -m model_loop.adapters.nfl.backtest prereg           # (already committed; hash checked by report)
python3 -m model_loop.adapters.nfl.backtest tune             # 2011-2019 only; appends docs/model-loop/nfl/tuning_log.jsonl
python3 -m model_loop.adapters.nfl.backtest report           # ablations on 2020-2024, then holdout 2025 and live 2026
python3 -m model_loop.adapters.nfl.cards                     # upcoming games -> docs/model-loop/nfl/cards_current.json
python3 -m model_loop.adapters.nfl.report                    # -> docs/model-loop/nfl/BACKTEST.md
python3 -m model_loop.adapters.nfl.backtest registry         # -> supabase/model_loop_nfl_registry.sql
python3 -m unittest discover -s model_loop/tests -t .
```
