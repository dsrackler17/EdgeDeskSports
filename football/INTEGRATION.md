# Integrating the Football Engine into the existing EdgeDesk stack

This repository is the EdgeDesk **frontend**; the Supabase Edge Functions and
SQL live in the Supabase project (`iattxbkbufslbauoumga`) and are not checked
in here. This document maps the engine onto the EXISTING architecture — the
audit below was read from the client code, which documents every contract it
consumes — and specifies the smallest safe server-side adoption path. Nothing
in this repo modifies a deployed function; the app integration is read-only
and honestly gated until the server side is deployed.

## The existing pipeline (as evidenced in app.html)

```
capture (cron)        -> signals            odds scan, flags, entry freeze
close / settle        -> signals            closing_sharp_fair, result, clv, beat_close
ingest_mlb (cron)     -> games, *_features  MLB model inputs
run_slate / project_game -> game_projections  MLB projection engine
model_conf_odds       -> model_predictions  sport-keyed model-vs-market rows
cfb_ingest (cron)     -> cfb.* schema       CFBD games/records/SP+/lines/roster
venue_weather (cron)  -> venue_weather      per-event weather (league-generic)
frontend MODEL engine <- model_predictions  renders ANY sport's rows
                                            ("MLB today; CFB, golf and props
                                             when their models exist")
```

## Existing function selected: the `model_predictions` path (`model_conf_odds`)

`model_predictions` is already sport-keyed (`sport_key`, `event_id`,
`market`, `selection`, `point`, `model_prob`, `model_fair_american`,
`model_edge`, `model_version`, `commence_time`) and the client MODEL engine
renders it for any sport, joins it to `signals` by `event_id`, resolves
two-sided conflicts, and keeps it quarantined from MARKET edges and CLV.
That is precisely the designed extension point — football becomes a
first-class model by WRITING ROWS, not by new infrastructure.

`run_slate`/`project_game` were NOT selected: they are the MLB projection
engine with MLB feature tables (`pitcher_features`, `offense_features`) and
an MLB-shaped output contract; extending them would entangle two sports'
logic inside one function for no benefit.

## Server-side adoption (shadow mode) — when you choose to deploy

1. Copy `football/engine.js` + `football/params.js` into the function that
   populates `model_predictions` (`model_conf_odds`). Both run under Deno
   unchanged (`globalThis` export; no DOM, no deps).
2. For each NFL/NCAAF event already returned by the existing `odds` proxy:
   build the game object (home/away, week, rest, roof where known), call
   `EDFootball.predictGame(...)`, and on `status:'PREDICTED'` write one row
   per market side with `model_version: 'edgedesk_football_v1.0.0'`.
   On `INSUFFICIENT_DATA`/`BLOCKED`: write nothing (the engine already
   refuses to guess).
3. **Database changes: none.** `model_predictions`, `signals`, grading,
   CLV, and `research_model_current` are reused as-is. (Optional: add NFL to
   the capture scanner's sport scope so `signals` carries NFL quotes and the
   MODEL engine can join prices; NCAAF is already captured.)
4. **Shadow mode is the existing doctrine**: MODEL rows render as UNPROVEN,
   are counted nowhere, and graduate only via their own graded CLV — that IS
   EdgeDesk's shadow mode, already built. No new gating needed.
5. Rollback: delete/stop writing rows with this `model_version`. Historical
   rows keep their frozen `model_version` — never overwritten.

## Frontend integration (this change, live now)

* New **Football** research module (research shell, `#research/football`):
  NFL + CFB + **CFB Power 4** boards computed client-side by
  `football/engine.js` and `football/cfb_p4/engine.js` from the
  same public sources the training pipeline uses (nflverse / cfbfastR-data,
  both CORS-open), matched to live `signals` quotes where capture covers the
  sport (NCAAF today; NFL when added to capture scope) — all labeled
  research, UNPROVEN, with the backtest's honesty summary shown in-module.
* `model_predictions` overlay: the Edges board's MODEL-fair read now also
  loads `americanfootball_nfl` / `americanfootball_ncaaf` rows (it loaded
  only `baseball_mlb`). No visible change until server rows exist.
* Narration layer: the NFL "not ingested" declarations are updated to state
  the new truth precisely (client-side football engine exists; narration
  evidence path still not wired), keeping credibility scoring conservative.
* Nothing else changes: MLB, UFC, WTA, tennis, golf, Collective, odds,
  grading, settlement and AI behavior are untouched.

## The CFB Power 4 model (`football/cfb_p4/`)

The Power 4 engine is a SEPARATE bundle — its own `engine.js`, `params.js`,
`goldens.json` and `tests.js` — and it plugs in the same way, with two
differences worth knowing before deploying it server-side:

* **It has its own global** (`window.EDCfbP4` / `EDCfbP4Params`) and its own
  `model_version` (`edgedesk_cfb_p4_v1.0.0`). Rows written to
  `model_predictions` under that version are independently gradeable and can be
  rolled back without touching the v1 football rows.
* **Its input contract is much wider** — roster bundles, a starting QB record,
  injuries, weather, schedule context, off-field signals — and every one of
  those is OPTIONAL. Anything not supplied is declared missing and widens the
  distribution instead of moving the mean, so a server-side caller that has
  only schedules and results still gets a valid, correctly-hedged projection.

Two things the ingest could add that would switch dark layers on, in order of
value: per-player recruiting star ratings (turns on the blue-chip layer), and
coaching / coordinator continuity (turns on the staff half of the roster-
stability score). Both have declared injection points in the engine; neither is
faked in their absence.

`cfb.lines` is used for book context in the app. The historical backtest does
NOT use it — it uses the public cfbfastR-data line archive, which carries
opening numbers as well as closing ones.

## Environment variables / secrets

None. All runtime sources are public and keyless; Supabase reads reuse the
app's existing token path.
