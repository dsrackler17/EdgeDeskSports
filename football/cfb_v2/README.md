# EdgeDesk CFB V2 — opponent-adjusted ensemble (shadow mode)

A rebuild of the college-football prediction engine around jointly opponent-adjusted
play-by-play efficiency, preseason priors as distributions, matchup features, a QB
value model, a five-model walk-forward ensemble, a calibrated heteroskedastic error
model, and a **separate** market decision layer.

**Status:** eligible for promotion on every accuracy gate, running in SHADOW beside
V1. V1 stays the priced number until a person switches it. BET is disabled: no
betting rule survived out-of-sample testing. V2 is more accurate than V1 and still
**less accurate than the betting market**.

```
football/cfb_v2/
  engine.js          production inference (browser + node, ES5): pure() / decide() / card()
  params.js          GENERATED: calibration, market rule, gates, declared overlays
  tests.js           55 engine checks (sign conventions, QB/injury overlays, stale odds, immutability…)
  current.json       GENERATED: next 10 days of projections (FROZEN / PROVISIONAL / not priced)
  snapshots/<season> GENERATED: write-once pregame snapshots, one file per Tuesday freeze
  learning/          GENERATED: per-season errors and major-miss classifications
  monitoring.json    GENERATED: in-season accuracy, bias, miss classes
  artifacts/<ver>/   the exact fitted models (JSON coefficients, LightGBM text model)
  sync_supabase.js   insert-only copy of frozen snapshots into Supabase
  research/          the reproducible pipeline (python), tuning records, feature contract
```

Read next: `docs/cfb-v2/MODEL_CARD.md` (what it is), `docs/cfb-v2/BACKTEST.md` (every
number, generated), `docs/cfb-v2/AUDIT_V1.md` (why), `docs/cfb-v2/FEATURE_COVERAGE.md`
(all 140 data-pack fields), `docs/cfb-v2/RUNBOOK.md` (commands, rollback).

The two outputs never merge:

```js
const pure = EDCfbV2.pure(snapshotRow, { qb_status: { home: 'questionable' } });   // football only
const decision = EDCfbV2.decide(pure, { current: { home_line: -6.5, ts }, price_home: -110, price_away: -110 },
                                { row: snapshotRow });                                 // market layer
const card = EDCfbV2.card(pure, decision);   // BET / LEAN / REVIEW / PASS, with reasons
```
