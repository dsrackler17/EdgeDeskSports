# EdgeDesk CFB V2 — opponent-adjusted ensemble (shadow mode)

A rebuild of the college-football prediction engine around jointly opponent-adjusted
play-by-play efficiency, preseason priors as distributions, matchup features, a QB
value model, a two-model walk-forward ensemble (ridge + gradient boosting, equal
weights), a calibrated heteroskedastic error model, and a **separate** market
decision layer.

**Version:** `edgedesk_cfb_v2.1.0`, the hardened successor of the frozen baseline
`cfb_v2_candidate_001` after an adversarial red team (`docs/cfb-v2/REDTEAM.md`).

**Status:** eligible for promotion on every accuracy gate, running in SHADOW beside
V1. V1 stays the priced number until a person switches it. BET is disabled: no
betting rule survived out-of-sample testing. V2 is more accurate than V1 and still
**less accurate than the betting market**; it is a research and pricing tool.

```
football/cfb_v2/
  engine.js          production inference (browser + node, ES5): pure() / decide() / card()
  params.js          GENERATED: calibration, market rule, gates, declared overlays
  tests.js           100 engine checks (sign scenarios, QB/injury overlays, hindsight guard, stale odds…)
  candidates.test.js re-hashes every frozen candidate against its manifest
  current.json       GENERATED: next 10 days of projections (FROZEN / PROVISIONAL / not priced)
  snapshots/<season> GENERATED: write-once pregame snapshots, one file per Tuesday freeze, each row
                     also carrying candidate 001, V1, the market and the pregame reports at the freeze
  shadow/<season>/   GENERATED: append-only line ledger, derived outcomes and research statuses
  learning/          GENERATED: per-season errors and major-miss classifications
  monitoring.json    GENERATED: in-season accuracy vs V1 / candidate 001 / market, health warnings
  monitor.html       static dashboard for monitoring.json
  shadow_decisions.js engine.decide() over the frozen rows
  artifacts/<ver>/   the exact fitted models (JSON coefficients, LightGBM text model)
  candidates/<id>/   frozen candidates (manifest, predictions, artifacts); never overwritten
  sync_supabase.js   insert-only copy of frozen snapshots into Supabase
  research/          the reproducible pipeline (python), tuning records, feature contract
```

Read next: `docs/cfb-v2/MODEL_CARD.md` (what it is), `docs/cfb-v2/REDTEAM.md` (the
adversarial audit and the production recommendation), `docs/cfb-v2/CHAMPION_CHALLENGER.md`
(V1 vs candidate 001 vs v2.1.0), `docs/cfb-v2/BACKTEST.md` (every number, generated),
`docs/cfb-v2/LEAKAGE_AUDIT.md`, `docs/cfb-v2/HARDENING_PREREG.md`, `docs/cfb-v2/AUDIT_V1.md`
(why), `docs/cfb-v2/FEATURE_COVERAGE.md` (all 140 data-pack fields),
`docs/cfb-v2/RUNBOOK.md` (commands, shadow records, health warnings, rollback).

The two outputs never merge:

```js
const pure = EDCfbV2.pure(snapshotRow, { qb_status: { home: 'questionable' } });   // football only
const decision = EDCfbV2.decide(pure, { current: { home_line: -6.5, ts }, price_home: -110, price_away: -110 },
                                { row: snapshotRow });                                 // market layer
const card = EDCfbV2.card(pure, decision);   // BET / LEAN / REVIEW / PASS, with reasons
```
