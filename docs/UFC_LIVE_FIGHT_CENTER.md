# UFC Live Fight Center

The canonical EdgeDesk UFC data layer: event and fight state, live round-by-round
statistics, an immutable snapshot timeline, and market context joined from the
existing odds engine.

Everything here is **additive**. No existing table, column, function, poller or
behaviour was removed, and the odds capture path was not touched.

---

## Deploy

**1. Run the migration.** Supabase → SQL Editor → paste `sql/ufc_live_v2.sql` →
Run. It is idempotent; running it twice is a no-op. The last statement lists the
seven tables and one view it created — if a row is missing, the statement that
creates it failed and the error is above it in the output.

**2. Deploy the function.**

```
supabase functions deploy ufc_live_stats --no-verify-jwt
```

**3. Set the environment variables** (Edge Functions → ufc_live_stats → Secrets):

| Variable | Required | Default | What it does |
|---|---|---|---|
| `CRON_SECRET` | **yes** | — | Must match the scheduler's `x-cron-secret`. Unset ⇒ every caller is rejected, including the cron. |
| `SUPABASE_URL` / `SUPABASE_SERVICE_ROLE_KEY` | **yes** | — | Writes. The service role bypasses RLS, which is why the tables have no INSERT policy. |
| `UFC_LIVE_PROVIDER` | **yes** | `none` | `sportradar` or `espn`. With `none` the function does nothing and returns `status:"unconfigured"`. |
| `UFC_LIVE_API_KEY` | for sportradar | — | Provider credential. |
| `UFC_LIVE_BASE_URL` | no | per-provider | Override the API base. |
| `UFC_LIVE_SPORTRADAR_ACCESS` | no | `production` | `trial` or `production` in the Sportradar path. |
| `UFC_LIVE_LOOKAHEAD_MIN` | no | `240` | How early before a card to start capturing. |
| `UFC_LIVE_LOOKBEHIND_MIN` | no | `300` | How long after to keep capturing, so finals and results land. |
| `UFC_LIVE_TIMEOUT_MS` | no | `8000` | Per-request timeout. |
| `UFC_LIVE_RETRIES` | no | `2` | Retries per request (429/5xx/network only). |
| `UFC_LIVE_CONCURRENCY` | no | `4` | Simultaneous bout fetches. |
| `UFC_LIVE_MAX_MS` | no | `50000` | Wall-clock budget. |
| `UFC_LIVE_MAX_BOUTS` | no | `16` | Bouts captured per event per run. |
| `UFC_FIGHTERS_TTL_MS` | no | `21600000` | How long the fighter-name index is cached (6h). |

**4. Schedule it.** Every 20–30s during a card is ample. When no event is in the
window the run is one cheap request and an idle telemetry row, so a permanent
short cron is fine.

**5. Check it.** `GET /functions/v1/ufc_live_stats?diag=1` with the
`x-cron-secret` header discovers and normalizes but **writes nothing**.

---

## Architecture

```
                         ┌─────────────────────────────────────────┐
  LIVE PROVIDER  ───────▶│ adapter        (only provider-aware code)│
                         │ flattenStatEntries  (shape-tolerant)     │
                         │ canonicalStatSlot   (name-tolerant)      │
                         └────────────────┬────────────────────────┘
                                          ▼
                              CANONICAL STAT CONTRACT
                                          │
   ┌──────────────────────────────────────┼──────────────────────────────┐
   ▼                     ▼                ▼                              ▼
 live_event_state   live_fight_state  live_fight_round_stats   live_fight_snapshots
 (venue, card)      (referee, clock,  (round 0 = fight total,  (immutable, deduped
                     result, method)   1..N = that round)        by content hash)
   │                     │                │                              │
   └─────────────────────┴────────────────┴──────────────────────────────┘
                                          │
                                          ▼
                                  Research → UFC → Live Fight Center
                                          ▲
                                          │  joined at read time, never copied
                              public.signals + signal_ticks
                        (opening, current, sharp fair, edge, flag)
```

### Three layers

| Layer | Tables | Owner |
|---|---|---|
| Event / fight state | `live_events`, `live_fights` (existing) + `live_event_state`, `live_fight_state` (new) | `ufc_live` poller / `ufc_live_stats` |
| Live statistics | `live_fight_round_stats`, `live_fight_snapshots`, `fight_stats` | `ufc_live_stats` |
| Research + market | `fighters`, `fighter_*` (existing), `public.signals` (existing) | existing pipelines |

### Why extension tables, not new columns

`ufc.live_fights` is written by the existing `ufc_live` poller, whose source is
not in this repository. If it upserts whole row objects — the ordinary way to
write a poller, and the exact pattern `capture` had to split into phase A/B to
defend against — then every one of its runs would send a tuple with no value for
any column added beside it and **null them out**. The statistics would flicker on
that poller's cadence with no visible cause.

A separate table keyed on the same identifier cannot be clobbered by a writer
that does not know it exists.

**Precedence:** `live_events` / `live_fights` remain the source of truth for
every field they already carry; `ufc_live_stats` never writes them. The new
tables own the deep fields. The app prefers the existing tables and falls back to
the new ones, so the Fight Center works with either poller deployed, or both.

### Why a separate Edge Function, not `captureUFC()`

`capture` already runs against `BUDGET_MS` with an explicit "finish the sport you
are on, skip the rest, RETURN" rule and `sports_skipped_for_time` telemetry —
machinery that exists because the run was previously being killed mid-flight with
its writes still in memory. UFC polling inside that budget would take clock
directly from the odds board, and the first symptom would be sports silently
dropping off the end of the run.

Two functions on two schedules cannot fail into each other. The isolation is
structural, not a promise in a comment.

---

## The rules this system will not break

**A statistic that was not published is `NULL`, and renders as `—`.** Never `0`.
Zero is a claim about the fight; a claim with no evidence is worse than a blank.
An *explicit* zero from the source is real data and renders as `0`.

**Nothing is invented from an unverified response.** Source keys the alias map
does not recognise are counted in `unmapped_stat_keys` and displayed nowhere.

**Derived numbers say they are derived.** Momentum and pace-vs-baseline carry an
`EdgeDesk-derived` badge. EdgeDesk publishes **no live round score** — the UFC's
official judging is not available live, so none is imitated.

**The market layer recomputes nothing.** Opening price, current price, sharp
fair, edge and the flag are read from `signals` exactly as capture wrote them.

**Freshness is two facts, not one.** `source_timestamp` is when the provider says
its state was true; `updated_at` is when we wrote the row. A poller running
happily against a frozen upstream has a moving `updated_at` and a stationary
`source_timestamp`, and only the pair reveals it.

---

## Snapshots

`live_fight_snapshots` is append-only and is what makes the fight
reconstructable at any earlier point.

Each row carries a `content_hash` over **the statistics and the round —
deliberately not the clock.** Hashing the clock would change the hash every poll
and collect tens of thousands of identical rows per card. Excluding it means a
row is written exactly when a number moves, and `captured_at` is when that new
state was first observed.

Deduplication is enforced by `unique (fight_id, corner, round, content_hash)`, so
two overlapping runs — a retry, a manual invoke racing the cron — cannot both
write the same state.

A high `snapshots_skipped_dup` count during a live fight is **correct**: it means
the numbers have not moved.

---

## Adding a provider

Write one adapter. No migration, no UI change.

```ts
const myAdapter: Adapter = {
  id: "myprovider",
  ready() { return PROVIDER_KEY ? {ok:true,reason:""} : {ok:false,reason:"…"}; },
  async discover(t, nowMs, cfg) {
    const r = await httpGet(url, headers, t, cfg);
    // map the response onto CanonicalEvent[] / CanonicalBout[], and call
    // buildCorner() with the per-corner stat nodes — it runs the shared
    // flattener and alias map so normalization never drifts between providers.
  },
};
ADAPTERS.myprovider = myAdapter;
```

If a stat is not picked up, it will appear in `unmapped_stat_keys`. Add the
spelling to `STAT_ALIASES` — one line, nowhere else.

### On the ESPN adapter

Included, optional, **not the default**, and written from the documented public
shape rather than an observed payload — the host was unreachable from the
environment this was built in. That is why `provider_verified` is **measured each
run** (true only when the adapter parsed usable events out of a real 2xx
response) instead of asserted in config. Prefer a credentialled live feed for
anything a user will read as "live".

---

## Diagnostics

`ufc.live_pipeline_health` (one row) and the collapsible **Live pipeline
diagnostics** panel at the bottom of the Fight Center answer five questions that
look identical on a blank screen and have five different fixes:

| Symptom | Reading |
|---|---|
| `events_discovered = 0`, `api_failures > 0` | The source is failing. Not a quiet night. |
| `provider_verified = false`, no failures | The provider answered; the adapter parsed nothing. Shape changed. |
| `events_active = 0` | No card in the window. Nothing is wrong. |
| `fights_live_now = 0` | There is an event, but no bout is live. |
| `fights_live_with_stats = 0` | A bout is live; the source publishes no statistics for it. |
| All healthy but the screen is empty | The UI is failing to consume valid data. |

---

## Tests

No Deno, no npm install required.

```
node --experimental-strip-types supabase/tests/run_node.mjs   # 60  capture logic
node supabase/tests/run_ui_node.mjs                           # 27  UI renderers
node supabase/tests/run_prefs_node.mjs                        # 14  settings
```

`run_node.mjs` extracts the two marked regions from the real function file and
runs them, so the code under test is the deployed code read off disk. If the
markers are removed the extraction fails loudly rather than silently testing
less. `run_ui_node.mjs` slices the renderers out of `app.html` and asserts on the
produced HTML — including that a null statistic renders as a dash, not a zero.

The canonical Deno runner shares the same assertions:

```
deno test --allow-env --allow-net supabase/tests/ufc_live_stats.test.ts
```

---

## Settings changes shipped alongside

Two **NOT AVAILABLE** gates in Edge Preferences were un-gated by building the
thing they described, not by relabelling them.

**Odds format** — every human-readable price now routes through `GE.fmtPrice`,
which honours American / decimal / fractional. `GE.decToAm` is unchanged and
still returns a *number*: the CLV ledger and the `edgedesk_ai` payloads carry
that number, and a display preference must never reach either.

**Favorite teams** — picked from live board data (never a hardcoded roster),
marks favourite fixtures with a ★, and offers a favourites-only filter. It
deliberately **does not reorder the board**: the Top 10 is ranked by weighted
edge, and letting a favourite jump a stronger number would quietly break the
ranking's central claim. Favourites-only with an empty list is a no-op, so it
cannot blank the board.
