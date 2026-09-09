# Edge Functions

68 functions are deployed. **Eight** of them live here now; the other 60 exist
only as deployed artifacts, which means they cannot be reviewed, diffed, tested
or restored, and nobody can answer "what does this one do?" without opening the
dashboard.

The three that arrived most recently — `collective_join`, `collective_public`
and `collective_admin` — were **pasted in, not exported**, like `close` and
`learn` before them. **Diff each against the deployed function before treating
it as authoritative:** a transcription error would be indistinguishable from a
real difference. Their headers say what changed on the way in and what did not.

They also arrived with a caveat worth stating once. Each names
`supabase/functions/_shared/` and `tools/collective/bundle_functions.py` in its
header, and **neither is in this repository** — so these bundles are not
generated from anything here. Until the sources and the bundler land, the
bundle IS the source and editing it is how the function changes. That is why
the shared blocks are duplicated across the three files rather than imported:
the dashboard bundles one folder, so an import that cannot resolve fails the
deploy silently.

`tools/supabase/download_functions.sh` pulls all of them into this directory.

```bash
npm i -g supabase                                   # or brew install supabase/tap/supabase
supabase login
supabase link --project-ref iattxbkbufslbauoumga
bash tools/supabase/download_functions.sh           # add --force to overwrite
```

The script skips anything already committed, and **scans everything it pulled
for secrets before you commit** — a service-role JWT or a live Stripe key
reaching git history is a rotate-now event, not a cleanup task.

---

## What calls what

Evidence from the shipped front end, not from the naming.

**Called directly by `app.html`**

| function | what for |
|---|---|
| `collective_ingest` | the Model Collective submission API — see its `SECURITY.md` |
| `edgedesk_ai` | the AI presentation layer |
| `odds` | odds reads |
| `team_brief` | team briefs |

**Called directly by `collective/index.html`** (the Collective's own site)

| function | what for |
|---|---|
| `collective_public` | the wall, the board, the rules, and every dashboard route — including `/v1/dashboard/submit`, which is what the uploader posts a slate to |
| `collective_join` | the invite flow, and `POST /v1/models` to cover another sport |
| `collective_admin` | the founder console (`collective/admin.html`) |
| `collective_odds` | the market panel |

`collective/index.html` also calls two SECURITY DEFINER routines over PostgREST
directly rather than through any function: `public.collective_model_ensure` and
`public.collective_my_models`, installed by
`../collective_model_autocreate.sql`. That is deliberate — a capability every
one of these functions needs is defined once, in the database, instead of three
times in three bundles that cannot import from each other.

**Everything else is a scheduled job or a webhook.** A cron job is load-bearing
if the app reads a table it writes:

| the app reads | fed by |
|---|---|
| `signals`, `signal_ticks`, `book_quotes` | `capture`, `odds`, `close`, `close_backfill`, `settle` |
| `model_predictions`, `model_weights`, `model_calibration`, `model_brier` | `model_predict`, `recalibrate`, `model_grade`, `model_conf_grade` |
| `mlb_bullpen_team`, `mlb_bullpen_taxed`, `pitcher_features` | `bullpen_sync`, `ingest_mlb`, `mlb_sync`, `ingest_pitcher_season` |
| `golf_stats`, `model_golf` | `capture_golf`, `model_golf`, `grade_model_golf` |
| `stats_players`, `player_stats` | `capture_players`, `capture_players_espn`, `capture_stats` |
| `venue_weather` | `venue_weather`, `weather_sync` |
| `offense_features` | `ingest_nfl_features` |
| `news` | `capture_news` |
| `rankings_current` | `cfbd_rankings`, `rankings_standings` |
| `model_props` | `model_props`, `grade_props` |
| `subscriptions` | `stripe_webhook` — billing |

**`park_bearings_sync` is referenced nowhere in `app.html`** — the only one of
the 68 with no footprint in the shipped front end. That is a lead, not a
verdict: it may feed another job. Check before retiring it.

## Before retiring anything

A function is safe to retire only when all four are true, and the fourth is
the one people skip:

1. no front-end call site;
2. no cron schedule (`select jobname, schedule, command from cron.job;`);
3. nothing reads the tables it writes;
4. **its last invocation is old** — check the dashboard, not your memory.

## The shape of the estate

`capture` covers `americanfootball_ncaaf` and `americanfootball_nfl` only. The
app still renders MLB, golf, tennis and WTA surfaces from tables other jobs
feed, so the football pivot reached capture but not the estate around it.
That gap is the thing worth deciding about deliberately.

**UFC no longer depends on any Edge Function.** The Live Fight Center reads the
contract in `../ufc_live_center.sql`, which GitHub Actions fill directly over
PostgREST with the service role (`.github/workflows/ufc-sync.yml`,
`.github/workflows/ufc-live.yml`, scripts in `tools/ufc/`). The deployed
`ufc_live` and `ufc_live_stats` functions — never committed here — are no
longer read by anything in `app.html` and can be retired once their cron
schedules are removed; the fighter dataset itself is still built by the
deployed `ufc_fighters_sync` / `ufcstats_sync` jobs, which this change does not
touch.
