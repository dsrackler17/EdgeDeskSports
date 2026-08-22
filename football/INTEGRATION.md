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

## Posting Power 4 slates to the Model Collective

The Power 4 board's **Post to Collective** button downloads the slate and opens
`collective/#dashboard`. It deliberately does NOT post on the reader's behalf:
posting is an account action against their own creator profile, and the model,
week and data-origin choices belong to them.

No column mapping is needed. The Collective's uploader (`SLATE_FIELDS` in
`collective/index.html`) maps by header name, and this export's headers are
already in its synonym table:

| export column | maps to |
|---|---|
| `home_team` / `away_team` | home / away team |
| `kickoff_local` | game date |
| `week`, `game_id` | week, game ref |
| `model_home_line` | your spread (home side) |
| `model_fair_total` | your total |
| `ref_home_line` | market line you saw |
| `home_win_prob_pct` | home win % |
| `p_spread_pick_pct` | cover % |
| `spread_pick` | pick side |
| `confidence` | confidence |

Columns the uploader does not recognise are ignored, so the Power 4 extras ride
along harmlessly.

### Two doors, and they are not the same function

* The **browser upload** (Dashboard → Post a slate) posts to
  `collective_public` → `/v1/dashboard/submit`.
* The **API-key path** (a creator's script sending `x-collective-key`) posts to
  `collective_ingest` → `/v1/projections`.

Both hand the envelope to the same `ingest_submission` RPC, but they are
different deployments: editing one does not change the other.

### Edits `collective_ingest` needs for a non-NFL sport

Neither blocks a submission — `marketSnapshot` is explicitly additive and
returns null on any failure — but without them a college-football creator gets
`market: null` on every receipt and an `available:false` market endpoint.

1. `marketSnapshot()` hard-codes NFL:

   ```ts
   if (String(sport).toUpperCase() !== "NFL") return null;
   ...
   p_league: "nfl",
   ```

   Replace with a sport→league map, so a sport with no stored market returns
   null and every other sport is looked up properly:

   ```ts
   // The league key the Collective's own odds feed stores. A sport missing
   // here has no stored market: the snapshot is null and the submission still
   // stands. The values must match what collective_odds_ingest writes —
   // adding a sport here without adding it there yields an empty board.
   const ODDS_LEAGUE: Record<string, string> = { NFL: "nfl", CFB: "ncaaf", NCAAF: "ncaaf" };

   async function marketSnapshot(sport: string) {
     const league = ODDS_LEAGUE[String(sport).toUpperCase()];
     if (!league) return null;
     ...
     p_league: league,
   ```

2. `/v1/market` reads `auth.models[0]?.sport_code ?? "NFL"` — the FIRST model on
   the account. A creator with an NFL model and a CFB model always gets the NFL
   market back. It should take the model from the query
   (`?model=<slug>`) and fall back to the first only when none is given.

### A model per creator per sport, provisioned automatically

The browser can pick the right model for a slate, and now does — the uploader
reads the sport out of the file and selects the creator's model for it. What it
cannot do is CREATE that model: no endpoint in the whole API exposes model
creation, so a creator whose account predates a sport has nowhere for that
sport's slates to land, and every row quarantines against the wrong schedule.

This is the failure that produced "0 matched, 90 quarantined,
unknown_team_home" on a college slate whose team names were, by then, byte-
identical to the backend's own. `TCU` failed against `TCU`, because the lookup
was never in the college schedule at all — the submission was attached to the
account's only model, which was tagged NFL.

The fix is one row per creator per sport, and it should not be the creator's
job. Two places to do it, in order of preference:

1. **When a sport is added.** Backfill every existing creator at the same time
   the sport row is inserted:

   ```sql
   insert into models (creator_id, model_slug, model_name, sport_code)
   select c.id,
          c.slug || '-' || lower(:sport_code),
          c.display_name || ' ' || :sport_name,
          :sport_code
     from creators c
    where not exists (
      select 1 from models m
       where m.creator_id = c.id and m.sport_code = :sport_code);
   ```

2. **On first submission for a sport**, inside `ingest_submission`: if the
   creator has no model for the envelope's `sport`, create one rather than
   resolving the slate against another sport's schedule. This is the one that
   makes it self-healing — a creator who joins after a sport is added, or a
   sport added while a creator is mid-season, both work with nobody doing
   anything.

Either way the creator adds nothing. Until one of them exists, the dashboard
refuses the post and names the missing model instead of letting the slate
quarantine, which is the honest degradation but not the fix.

**Do not** solve this by letting a submission carry its own sport independent
of its model. The model is what the record belongs to; a model whose slates are
half NFL and half college has no meaningful win percentage.

### The one thing that is NOT in this repo

**The Collective's sport vocabulary is server-side.** `meta().sports` comes from
the `collective_public` function, and `collective_ingest` validates a
submission's sport against the same list. Until a college-football sport code
exists there, a CFB slate has no model to attach to and the ingest will reject
it — nothing in this repository can change that.

What the server needs, once:

1. A college-football sport row in the Collective's sports table (code, current
   season) so it appears in `meta().sports`.
2. That code added to `collective_ingest`'s accepted sports.
3. Schedule/closing-line capture for the sport, so submissions have games to
   grade against — the Collective grades against its OWN captured closing
   lines, never self-reported numbers.

The frontend is already ready for it: the sport selector, the per-sport week
calendar (college football's regular season ends at 15 and its postseason is
conference championships, bowls and the playoff — not Wild Card through Super
Bowl), and the creator profile's per-model sport pills all key off whatever
`meta().sports` returns. The moment the server lists the code, CFB appears
beside NFL with no further frontend change.

## Environment variables / secrets

None. All runtime sources are public and keyless; Supabase reads reuse the
app's existing token path.
