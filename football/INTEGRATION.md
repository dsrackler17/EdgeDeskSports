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

### Retract cannot work against an append-only store

`collective.projections` is append-only in the **database**, not merely by
convention. A trigger raises

```
P0001  collective.projections is append-only (rule 8.3); use the service maintenance path
```

on any `DELETE`. `collective_ingest`'s `/v1/projections/retract` removes rows
with an ordinary PostgREST `DELETE`, so against that database it can never
succeed. Its dry run is worse than useless: it happily counts rows it will
never be allowed to remove, so it reports `would_remove: 12` and the confirmed
call comes back

```
retract_failed: Removed 0 row(s), then a chunk failed: DELETE projections failed: 400 …
```

Nothing is removed and nothing is half-done — the refusal lands on the first
chunk, before anything is touched.

**What that cost.** Both research boards' *Sync to Collective (API)* treated the
refusal as fatal and returned before posting. The removal had changed nothing
and the post was still valid, but a board whose games already had stored rows
could not reach the Collective **at all**. One server-side rule took the NFL and
Power 4 sync offline.

**What changed instead: the rule.** The Collective now shows and grades each
model's **latest live submission received before the lock**, 30 minutes before
kickoff. A re-upload replaces the model's number on every game that has not
locked; every earlier submission stays stored as movement; a submission
received at or after the lock is stored, flagged late, and excluded — whoever
posts it. Nothing has to be removed for a correction to count, so the retract
route's refusal no longer stands between a board and the wall. The group chose
this after two creators reported the uploader as broken in one week: the
latest upload is the master, and the lock protects the record.

**What app.html does now.** *Sync to Collective (API)* is a dry run, one
confirmation that says exactly what the post replaces and when games lock,
and a post. It never asks the store for a delete. The standalone retract
button keeps its guard against the append-only refusal (`fbRetractBlockedBy` /
`fbRetractBlockedWhy`, recognised by the database's own words) and says that
nothing is lost by it. `tools/collective/app_sync.test.js` drives both flows
out of `app.html` itself.

**What the client does** (`collective/index.html`): every `/v1/games` response
is collapsed on arrival to one row per model per game — the latest live row
received before the lock — so the wall, the model page, the record and the
coverage agree whether or not the server has adopted the predicate yet; a row
received after the lock that the server did not flag is flagged late on the
page; the lock length is read from `/v1/meta` `lock_minutes` (30 when
absent); the dashboard says before a post which games it will replace numbers
on and which have already locked, the receipt says the same from the server's
own counts, and the rules page, the legend, the game header (`LOCKS IN 2H` /
`LOCKED`) and the `+n` beside a pick all state the lock rule.

**What the server still needs** — none of it is in this repository, all of it
is written down in `supabase/` (`lock_rule.sql`, one paste with no placeholders,
`functions/collective_ingest/index.ts`):

1. `board_models` (what `/v1/games` reads), the grader, consensus and the
   coverage counts pick *the latest live row per model per game with
   `received_at < lock_at(kickoff)`* instead of the first pre-kickoff one.
   **This is the change that makes a re-upload reach the wall**: until the
   view returns the later row, the page never sees it and cannot show it.
2. `ingest_submission` sets `late` by the lock rather than by kickoff, and
   counts `first` / `movement` against the new rule.
3. `/v1/meta` publishes `lock_minutes`.

Until 1 lands, the wall keeps showing each model's first submission and the
page can only say so. That is the honest degradation; it is not the fix.

### The Collective tab is locked because it asks anonymously

`collective/embed.js` fetched `collective_embed /v1/embed/bootstrap` with no
credential at all. An anonymous reader is entitled to nothing, so the payload
came back with `entitled: false` and every pre-kickoff row carrying no numbers
to show — for **everyone**, including a reader signed in to the very site the
embed is running on. In the app's Collective tab that is the whole board greyed
out for somebody who is paying for EdgeDesk, with no way from that screen to
say so. Client-side unlocking is not an option and never was: the values are
simply absent from the payload.

**What app.html does now.** EdgeDesk and the Collective run on the same
Supabase project, so the reader signed in to the app is already an identity the
Collective can recognise. The tab sets `window.MCEmbedToken`, the embed calls it
and sends `Authorization: Bearer <access token>` on the bootstrap. Two rules,
because the embed also runs on other people's sites, and both are covered by
`tools/collective/embed_auth.test.js`:

* the token travels through a **function**, never a `data-` attribute — a
  credential in the DOM is readable by anything else on the page;
* it is sent **only** when the API base is the Collective's own. `data-api` is
  there for testing and a credential must never follow it.

The publishable anon key is itself a JWT, so it is rejected explicitly: the
token is decoded and must carry `role: "authenticated"` and a subject. A `401`
falls back to the anonymous request, and the locked panel now distinguishes
"you are not signed in" from "you are signed in and the Collective does not
have this account as a subscriber" instead of pitching a subscription at
somebody who already has one.

**What the server was doing.** Nothing. `collective_embed`'s bootstrap had the
entitlement hardcoded:

```ts
const board = sport ? await buildGames(sport.code, sport.season, null, false) : ...
...
upcoming: { entitled: false, games: upcoming },
```

Two literals. It never read the Authorization header, never resolved a user,
and never called `isEntitled()` — which already existed in `_shared/reads.ts`
and already did the right thing. Every pre-kickoff row was locked for
everyone, permanently, subscribers and creators included.

Its `corsFor()` compounded it by allowing only `content-type`, so a
cross-origin GET carrying `Authorization` was refused at the preflight and
blocked by the browser before it left. (The shared `corsHeaders()` in
`_shared/http.ts` allows it; the embed function was overriding that with a
narrower set.)

**The fix, applied to the deployed bundle:** resolve the caller with
`GET /auth/v1/user` — verified by the auth server, never decoded in the
function, and with the publishable anon key rejected explicitly since it is
itself a JWT — then pass the result of `isEntitled()` into `buildGames()` and
the `upcoming` envelope. `isEntitled()` gained EdgeDesk's own `subscriptions`
table, read from the **public** schema (no `Accept-Profile`) and best-effort,
so a rename there costs that one check rather than the whole board. A
response built for one reader is `private, no-store`; the shared cache window
applies only to the anonymous board. `Vary` carries `Authorization` as well as
`Origin`.

Two more defects came out of the same file once it was read properly:

* **Only one sport ever reached the board.** `const sport = meta.sports[0]` —
  the first sport in the list and only that one — so a Collective running
  college football alongside the NFL put *no* college slate on the embed at
  all. Four models on its own wall had nothing to show for themselves there,
  which is the whole reason they are on it. Every active sport is built now,
  capped **per sport** and then merged by kickoff: one shared cap is the same
  bug wearing a hat, because an NFL Sunday is sixteen games and fills any
  total limit on its own. Each game carries its `sport`, and the embed shows
  it as a chip — a mixed list sorted by kickoff is unreadable otherwise.
  `embed.upcoming_per_sport` (16) and `embed.settled_per_sport` (6) tune it.

* **A free account counted as paid.** `isEntitled()` short-circuited on
  `billing.enabled !== true` and returned true for anybody holding a session.
  With identity resolution fixed, that would have handed the paid board to
  every signed-in free account the moment it started working. The branch is
  gone: the ways in are an active EdgeDesk subscription, an active Collective
  subscription, or being a creator.

The payload now carries `entitlement: { identified, entitled, via }`, so a
locked reader can be told which check failed rather than left to guess — the
app's Collective tab turns it into one line naming the case.

**Client side, the anonymous board is the floor and is never gambled.** The
first attempt at this sent the token *instead* of asking anonymously and
recovered afterwards if that failed — and against a deployment that does not
accept the header, which is every deployment until the API above ships, it
turned a locked board into **no board at all**: *"The Model Collective is
temporarily unreachable from this page."* A recovery path is not good enough
there. It only runs after something has already gone wrong, and anything it
does not anticipate still costs the whole panel.

So `embed.js` always makes the anonymous request, exactly as it did before
there was an identity to send, and that request alone decides whether the
panel renders or falls back. The identified request rides alongside as an
upgrade: its answer replaces what is on screen if it arrives, and if anything
goes wrong with it nobody hears about it. Two requests for a signed-in reader
is the price; the anonymous one is the cacheable one.

"Unreachable" is only reported once there is nothing on screen **and** nothing
still coming, so a slow identity cannot flash an outage over a board that is
about to arrive.

The state event carries `handoff`: `none` (signed out here), `pending`, `ok`,
or `refused` — three different causes for `refused` (header not read, token
rejected, preflight blocked), one consequence, and none of them the reader's
doing. That is the case the product is in until the function above is
deployed, and the Collective tab now says so by name rather than reporting the
reader as signed out.

### Deploying an edge function is not the same as calling one

Worth writing down because it cost a day. This:

```sql
select net.http_post(
  url := 'https://<project>.supabase.co/functions/v1/collective_embed',
  headers := jsonb_build_object('Content-Type','application/json'),
  body := '{}'::jsonb);
```

does **not** deploy anything. `pg_net`'s `http_post` makes an HTTP request
*to* a function — it is how a scheduled job invokes one — and the code
answering that URL stays whatever was last uploaded. Against
`collective_embed` it is not even a useful invocation: the router answers
`GET /v1/embed/bootstrap` and `POST /v1/embed/events`, so a POST to the
function root falls through to `not_found` and returns 404.

Deploying is one of:

* **Dashboard** → Edge Functions → the function → Code → paste `index.ts` →
  Deploy. Then, in that function's settings, turn **"Enforce JWT
  verification" OFF** — it resolves the token itself and anonymous callers
  have to keep working.
* **CLI** — `supabase functions deploy collective_embed --no-verify-jwt`.

One more trap, for the dashboard route specifically: **paste from the file,
not from a chat message or anything else that renders markdown.** A hostname
written next to the `www` prefix gets auto-linked in transit, and the bundle
has arrived corrupted that way twice. The current source builds that
comparison by concatenation so there is no literal for a renderer to eat.

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
