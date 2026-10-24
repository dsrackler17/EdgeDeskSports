# Signal Center — deployment

**Production state (2026-10-24).** Steps 1 and 3 have been run, at the owner's request:

- the migration was applied by *Deploy Signal Center schema*, and re-applied after the `sha256()` fix
  (run 40044555415: all 12 report rows ok);
- *Signal Center mode* switched to **live for every sport** in the registry at 00:23 UTC (run 40044724761; reason
  kept in `sc_config_log`);
- the first *Signal Center run* (40044823741, 00:25 UTC) stored 371 signals, published 166, drew 144 graphics (48
  versions, three formats) and stored the Model DNA records, in 23 database requests.

To take the backfill (#741), run step 1 **again** after merging, then step 2. Step 1 is idempotent. It replaces the
doors and adds `sc_signals.backfilled` and `signal_at`. It dates the rows already stored by the 180-minute rule and
places them in record time (older active or expired signals about the same subject, outcome and event are
superseded, with an audit event).

The hourly job runs only when the repository variable `SIGNAL_CENTER_WORKER` is `on` (§2). The steps below remain
the runbook. Each is a separate decision, and each can be undone.

## 0. What it depends on (already in production)

| File | Provides | If missing |
| --- | --- | --- |
| `supabase/billing_hardening.sql` | `community_is_entitled(uuid)`, `billing_row_grants_access`, `billing_is_admin()` | Report row 6 says CHECK THIS; **nobody gets Full Access** (fail closed); no operator |
| `supabase/personal_research.sql` | `public.user_alerts` (the bell), `edp_copy_ok` | Report row 10 says *pending*; notices are skipped, nothing else changes |
| `supabase/funnel.sql` | `public.user_event_kinds` | Report row 11 says *pending*; seat taps are not kept |
| `supabase/simulator.sql` | `sim_published`, `sim_runs`, `sim_team_results` | Simulator changes are skipped and recorded as a source note |

## 1. Apply the migration (additive, reversible)

`supabase/signal_center.sql` is byte-identical to `supabase/migrations/20261024120000_signal_center.sql`.
It is idempotent and creates only `sc_` tables and `sc_` functions, plus one funnel event kind
(`primary_nav_signals`, guarded). It alters no existing table, function or policy.

Either:

- **Actions → Deploy Signal Center schema → Run workflow** (`.github/workflows/deploy-signal-center.yml`). It runs the
  SQL and worker suites against a throwaway PostgreSQL, checks the mirror, then applies the file in one transaction
  with `ON_ERROR_STOP`. A report row reading CHECK THIS fails the run. Needs `SB_DB_URL`.
- or paste `supabase/signal_center.sql` into the SQL editor (it is written to run as one raw string).

Expected report:

```
1  tables exist                                          ok
2  row level security on every sc table                  ok
3  no client role can read or write an sc table directly ok
4  the job doors are not callable by clients             ok
5  the feed is not callable without an account           ok
6  the entitlement gate defers to the project rule       ok
7  an anonymous caller is neither entitled nor an operator ok
8  history tables refuse update and delete               ok
9  mode                                                  ok: shadow (nothing is published until an operator switches to live)
10 notices                                               ok
11 the Signal Center seat is counted                     ok
12 the owner's mode door is reachable by no API role     ok
```

After it: the terminal seat reads "Shadow mode". Readers see an empty feed and new readers are handed on to Research.
`/signals/` says shadow mode. Nothing is published. An operator sees the stored, unpublished signals in the terminal
by default, and the pulse says it includes them.

## 2. Shadow evaluation

Run this only after step 1 is green. (The first deploy on 2026-10-24 applied, but every ingest was refused:
the file hashed with pgcrypto's `digest()`, which Supabase keeps in the `extensions` schema outside the doors'
`search_path`. The file now uses PostgreSQL's built-in `sha256()`, and the SQL suites put pgcrypto where
Supabase does, so this cannot pass the tests again. Re-apply the file after updating.) A run against a database without the migration stops at its first call, writes nothing, and fails with *"Signal Center's database is not deployed here … Apply supabase/signal_center.sql first"*.

Set the repository variable **`SIGNAL_CENTER_WORKER` = `on`** (Settings → Secrets and variables → Actions →
Variables). `.github/workflows/signal-center.yml` then runs hourly at :23. A run can also be started by hand, with
*dry run* to write nothing. Secrets: `SB_URL`, `SB_SERVICE_ROLE`, the ones the other jobs use.

**The first run stores the season so far.** It reads every committed record back to the start of each ledger:
about 750 signals on 2026-10-24. Each is placed when it happened and marked *found in the ledger later*, and none
becomes a notice. Graphics catch up at 150 versions a run (Notable and above). Later runs store only what is new.

Review in `/admin/signals/` for at least two NFL and CFB game weeks:

- **Queue → Review** a sample of each category. Check the headline, the values, the evidence class and every
  timestamp against the source records named on the detail page.
- **Open failures** should be source notes only (for example "NBA injury layer not readable"), not repeated run
  failures.
- **Runs** complete hourly, and the request count stays far under the 400 budget.
- Check the queries in §6.

## 3. Go live (NFL and college football first)

Any one of:

- `/admin/signals/` → Mode → **Live**, tick the sports → Save (it asks first);
- **Actions → Signal Center mode** (`.github/workflows/signal-center-mode.yml`): mode, sports (`nfl,cfb` or
  `all`, checked against the registry) and a reason. It calls `public.sc_owner_set_mode` with `SB_DB_URL`, a door
  no API role can reach;
- the SQL editor: `select public.sc_owner_set_mode('live', array['nfl','cfb'], '<why>');`

Each switch is logged in `sc_config_log`, with the reason where one is given.

- **Switching to live publishes what is already stored in shadow** if it clears the publication rule now
  (`sc_place_shadow`: verified, a live sport, label ≥ Routine, not withdrawn, history included). Held and withdrawn
  signals are never touched. The result says how many were published (`promoted`).
- A run publishes under the mode it **began** in, so the next run publishes the new signals. A live run also
  publishes, by the same rule, whatever is still unpublished (`sc_publish_pending`): the backfilled history, and
  what an earlier engine stored before history was publishable. History is published as history (expired or
  superseded) and never notified.
- Published means: VERIFIED, not a fixture, a live sport, label ≥ Routine (`sc_config.publish.min_label`).
  Notices go to Full Access readers who asked, at Notable+ by default: at most 5 per run and 20 per day each.
- Then, as separate decisions:
  - `/signals/`: change `<meta name="robots" content="noindex,follow">` to `index,follow` and add the URL to the
    sitemap.
  - The landing page's Free column (`lib/edgedesk_plans.js` FREE + `index.html`) does not list Signal Center. Add
    it only once the preview has published content.
- Other sports: the review plan adds them only after their own shadow review; the owner switched every sport on
  on 2026-10-24. The registry still marks NBA and NHL divergences experimental, every Simulator shift experimental
  (a T3 research model), and NFL injuries blocked: those labels ride on every signal whatever the mode.

## 4. Switches

| Switch | Where | Effect |
| --- | --- | --- |
| `SIGNAL_CENTER_WORKER` | repository variable | `on` runs the hourly job; anything else stops it (manual runs still allowed) |
| `sc_config.mode` | `/admin/signals/`, *Signal Center mode*, or `sc_owner_set_mode` | `shadow` publishes nothing new; `live` publishes the live sports (and the eligible shadow signals at the switch) |
| `sc_config.live_sports` | same | which sports may publish |
| `sc_config.free` | SQL (operator) | the public preview: feed_limit 3, max_age_hours 72, min_label Notable, categories, example graphics 2 (events ≥ 72 h old) |
| `sc_config.notify` | SQL | min_label Notable, cooldown 6 h per subject, max_per_run 500, max_per_reader_run 5, max_per_reader_day 20, window 24 h |
| `sc_config.graphics` | SQL | auto on, min_label Notable, the three formats |
| `sc_config.allow_fixtures` | SQL | false: a fixture payload is refused at ingest |

Every `sc_config` change made through an operator door is appended to `sc_config_log`.

## 5. Rollback

1. **Soft (keeps everything, publishes nothing new):** Mode → Shadow, or *Signal Center mode* with `shadow`.
   What is already published stays published until an operator holds or withdraws it.
2. **Stop the job:** set `SIGNAL_CENTER_WORKER` to `off`.
3. **One signal:** Hold or Withdraw it (the reason is kept; history stays readable).
4. **Remove the feature:** run `supabase/signal_center_rollback.sql` in the SQL editor. It is **destructive**: it
   drops every `sc_` table and function, deletes the Signal Center notices from `user_alerts`, and removes the
   `primary_nav_signals` kind if no tap was recorded. No workflow runs it. It is tested: apply, roll back, roll back
   again, apply again (`tools/signal_center/sql.test.js`). The terminal then shows "not deployed yet" and hands
   readers to Research. To remove the seat itself, revert the `app.html` change.

## 6. Verification queries (SQL editor)

```sql
select public.sc_status();                                   -- mode, live sports, last run
select status, started_at, finished_at, counts->'requests' from public.sc_runs order by started_at desc limit 10;
select category, sport, publication, count(*) from public.sc_signals group by 1, 2, 3 order by 1, 2, 3;
select backfilled, min(signal_at), max(signal_at), count(*) from public.sc_signals group by 1;  -- history found later vs live
select count(*) from public.sc_signals where publication = 'PUBLISHED' and (verification_state <> 'VERIFIED' or fixture);  -- must be 0
select stage, error, created_at from public.sc_failures where resolved_at is null order by created_at desc limit 20;
select status, external_approval, count(*) from public.sc_graphics group by 1, 2;
select count(*), count(*) filter (where held) from public.sc_notification_log where sent_at > now() - interval '24 hours';
```

## 7. Costs

- **No new vendor and no new recurring vendor cost.** No odds request (the run reads what capture already stored), no
  SMS or email provider, no Stripe change, no new Supabase product.
- **GitHub Actions minutes**, only once `SIGNAL_CENTER_WORKER` is on: about 3–6 minutes per hourly run, mostly
  installing Chromium for the graphics. A dry run is about one minute.
- **Database storage:** a payload is about 7 KB (median 7.1 KB, p95 7.6 KB across 234 payloads in a dry run). A
  graphic's stored content is about 2 KB per format, three formats per eligible version. The first run stores about
  1.5 MB of versions. Later runs store only new versions.
- **Database load:** a run makes on the order of 20–60 requests (budget 400). A reader's feed page is one
  `sc_feed` call: about 40 ms at 5,000 signals, round trip included.

## 8. What was verified, and what was not

Verified, in this repository: the migration on PostgreSQL 16 (applied twice, as the SQL editor sends it, attacked
by role, 5,000-signal latency, rollback). The worker end to end over the committed sources through a PostgREST
stand-in. The graphics in Chromium with real font metrics. The terminal seat, `/signals/` and `/admin/signals/` in
Chromium against the shipped doors.

Not verified, because it needs production: the migration against the production schema; the hourly job with the
real service role; Supabase's own PostgREST (the stand-in implements only what the doors use); a real reader's
entitlement and a real operator account.
