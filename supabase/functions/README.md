# Edge Functions

68 functions are deployed. Until recently **five** of them lived here; the
other 63 existed only as deployed artifacts, which meant they could not be
reviewed, diffed, tested or restored, and nobody could answer "what does this
one do?" without opening the dashboard.

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
app still renders MLB, golf, tennis, UFC and WTA surfaces from tables other
jobs feed, so the football pivot reached capture but not the estate around it.
That gap is the thing worth deciding about deliberately.
