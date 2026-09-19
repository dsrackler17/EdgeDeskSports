# Runbook — EdgeDesk Tennis Lab

Operational procedures for the Lab. Architecture and rationale live in
[`docs/tennis-lab.md`](../tennis-lab.md).

---

## Daily: what runs, and in what order

`.github/workflows/tennis-record.yml`, nightly at 05:35 UTC (`nightly` job):

```
build_features.js   → point-in-time features
build_ratings.js    → Elo, power rating, form windows
incremental.js      → official rankings
build_history.js    → rating snapshots        ← the deltas measure against these
build_lab.js        → derived signals + classifications
build_brief.js      → the daily research brief
```

**The order is load-bearing.** Each step reads what the one before wrote:

- ratings read features — the reverse rates players against yesterday's inputs
  and nothing says so;
- `build_lab` reads `rating_history` for the 30- and 90-day deltas — run it
  first and every delta is null on the first night and silently stale after.

Run one step by hand with **Actions → tennis-record → Run workflow → job:**
`lab` or `brief`. Leave *commit* unchecked for a dry run that prints what it
would do.

---

## First-time setup

```bash
psql "$SUPABASE_DB_URL" -f supabase/tennis_record.sql   # must be first
psql "$SUPABASE_DB_URL" -f supabase/tennis_lab.sql
```

Both end in a report. **Every row must read `ok`.** `tennis_lab.sql` refuses to
apply at all if the record contract is not underneath it, and says so.

Then expose the schema: **Project Settings → API → Exposed schemas** must
include `tennis`, or every RPC returns 404 and the page renders "could not be
reached". The record contract's report row 24 checks this.

---

## Symptom → cause

### The Lab header says "could not be reached"

1. Is `tennis` in the exposed schemas? (above)
2. Is the lab contract applied? `select to_regclass('tennis.lab_flags');`
3. Is the read the right kind? `lab_health` is a **view**, read over REST —
   `/rpc/lab_health` resolves functions only and 404s. Everything else is an RPC.

### A panel is empty but the header shows matches on file

The record is imported but a builder has not run. Check what exists:

```sql
select count(*) from tennis.player_ratings_current where power_rating is not null;  -- build_ratings
select count(*) from tennis.rating_history;                                          -- build_history
select count(*) from tennis.player_ratings_current where lab_version is not null;    -- build_lab
```

| empty panel | missing step |
|---|---|
| leaders, ratings table | `tennis:ratings:build` |
| risers / fallers | `tennis:history:build`, then `tennis:lab:build` |
| surface translator | `tennis:lab:build` (needs `*_win_pct`, `*_elo`) |
| form & trajectory | `tennis:lab:build` (needs `trajectory_class`) |
| schedule & fatigue | `tennis:lab:build` (needs `workload_class`) |
| serve / return columns | the archive carried no serve statistics for that range — this is a **gap, not a bug** |

### "Biggest risers" is empty and everything else works

No `rating_history` rows old enough. The deltas need a snapshot ≥ 30 days back:

```sql
select min(as_of), max(as_of), count(*) from tennis.rating_history;
```

Backfill further:

```bash
node tools/tennis/build_history.js --from 2020-01-01 --every 30 --commit
node tools/tennis/build_lab.js --commit        # re-derive the deltas
```

### The matchup studio fails for signed-out visitors

Check the two functions that cross into the private feature table are
`security definer`:

```sql
select proname, prosecdef from pg_proc p join pg_namespace n on n.oid = p.pronamespace
 where n.nspname = 'tennis' and proname in ('lab_matchup_inputs','lab_comparables');
```

Both must be `t`. As `security invoker` they fail for `anon` **in both modes** —
PostgreSQL checks table permissions when it plans a statement, so the historical
branch poisons the current one even when it returns nothing. Re-apply
`tennis_lab.sql`; report row 16.5 asserts it.

### A rest figure is negative, or a player shows "Unknown (date precision)"

The archive dates matches to the **tournament week**, so an event in progress can
look forward-dated. This is expected and handled: the rest figure is withheld and
named as a `future_dated_match` data-quality issue; the match counts still
classify the workload. No action needed.

### Everyone is classified "returning"

Correct on an archive that spans sixty years — most players in it are retired.
`returning` means no match for 120+ days. Check against live players only:

```sql
select trajectory_class, count(*) from tennis.lab_player_row
 where tour = 'ATP' and days_since_last_match < 120 group by 1 order by 2 desc;
```

### Three players tied at exactly 100.00

The rating clamps. Expected on a deep record, and handled: leaderboards break
the tie on Elo and the rank-gap board excludes clamped players. If *many*
players are clamped, the tour reference is mis-set — check the spread:

```sql
select tour, count(*) filter (where power_rating >= 99.99) as at_ceiling,
       count(*) filter (where power_rating <= 0.01) as at_floor, count(*)
  from tennis.player_ratings_current group by tour;
```

More than a percent or two at either clamp means `build_ratings.js` computed its
reference over too narrow a population.

---

## The market module

It ships **off** and should stay off. To check why:

```sql
select * from tennis.lab_market_available();
```

`available` is true only when all three of `flag_enabled`, `provider_ok` and
`freshness_ok` are true — and `provider_ok` means *a commercially cleared source
has actually delivered*, not merely that one is registered.

**To enable it** (only with a licensed provider connected):

```sql
-- 1. register the provider with its clearance, named and dated
insert into tennis.source_licenses (source_key, title, licence, commercial_use, research_use, cleared_by, cleared_at)
values ('your_provider', 'Your Provider', 'commercial', true, true, 'who cleared it', now());

-- 2. ingest snapshots under that source_key
-- 3. only then:
update tennis.lab_flags set enabled = true, updated_by = 'you', updated_at = now()
 where flag_key = 'market_comparison';
```

The flag alone does nothing. **Do not** mark the historical archive
commercially cleared — it is CC BY-NC-SA and the licence gate exists to refuse
exactly that.

**To turn it off again:** set `enabled = false`. The Lab is unaffected; nothing
in it depends on the market module.

---

## Rollback

The Lab is additive. To disable it without touching the record:

```sql
-- hide the reads; the record contract, the board and the live centre are untouched
revoke execute on all functions in schema tennis from anon, authenticated;
-- then re-grant the record contract's own functions per supabase/tennis_record.sql
```

To remove it entirely:

```sql
drop table if exists tennis.rating_history, tennis.research_briefs, tennis.lab_flags cascade;
drop function if exists tennis.lab_leaders(text,text,integer,integer);
-- ...and the other lab_* / ai_lab_* functions; \df tennis.lab_* lists them
drop view if exists tennis.lab_health, tennis.lab_player_row;
alter table tennis.player_ratings_current
  drop column if exists serve_strength, drop column if exists return_strength,
  drop column if exists trajectory_class, drop column if exists workload_class;
  -- ...etc; the full list is in the alter statement at the top of tennis_lab.sql
```

The record contract keeps working throughout — the board, the live centre and
the public record read none of the above.

---

## Rebuilding after a model retrain

A new model version changes the projection but **not** the ratings:

```bash
npm run tennis:model:build      # trains, evaluates, registers, promotes on the gate
```

The studio reads the active model at page load, so nothing else needs rebuilding.
If the retrain changed the **feature vector**, `tools/tennis/lab.test.js` fails
first — `FEATURE_META` and `FEATURE_NAMES` must agree, so a retrain cannot
silently render `d_sos` to a reader.

If the retrain materially improved the estimator, `MODEL_FLOOR_BAND` in
`lib/tennis_lab.js` should move with it. It is derived from the evaluation, not
chosen: see the comment there and `docs/model-card-tennis.md`.

---

## Verifying a deployment

```bash
npm run tennis:lab:test                       # engine + UI, no database
EDGD_PG="..." npm run tennis:lab:sql          # 90 assertions against real PostgreSQL
psql "$SUPABASE_DB_URL" -f supabase/tennis_lab.sql | grep -v '| ok'   # must print only headers
```

Then, as a signed-out visitor, open the Lab and check:

- the header shows a match count and a rating version
- the overview renders eight panels
- a player search returns results and opens a card
- the matchup studio projects, **and** shows an uncertainty and a band
- the Market Comparison tab says it is off and gives a reason
