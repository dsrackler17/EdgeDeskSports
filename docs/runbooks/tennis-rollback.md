# Runbook — tennis rollback

What can be undone, what cannot, and why.

---

## What CANNOT be rolled back, by design

| thing | why |
|---|---|
| a written prediction | `tennis.model_predictions` is append-only. A prediction is a claim made at a moment with the information available then; editing one after the result is known is how a public record becomes fiction. |
| a model version's evaluation | it is what that version scored on the window it was measured over. Rewriting it makes every published number unverifiable. |
| a published record row | written before the match, immutable after. Settlement adds the result *beside* it, once. |
| a settled result | re-settling is refused. A correction is published, not applied over history. |

All four are enforced by triggers that raise for **every** role, service role
included. If you find yourself wanting to defeat one, the answer is a new row,
not an edit.

---

## Rolling back the active model

```bash
node tools/tennis/build_model.js --rollback tennis-baseline-1.0.0            # dry run
node tools/tennis/build_model.js --rollback tennis-baseline-1.0.0 --commit
npm run tennis:board:build                                                   # re-price under it
```

Predictions already written stay exactly as they are. The rollback decides
which version the *next* board run uses.

```sql
select model_version, status, activated_at, retired_at, rollback_target,
       eval_results->'test'->>'log_loss' as test_log_loss,
       baseline_comparison->>'beats' as beats_baselines
  from tennis.model_registry
 where family = 'tennis_match_winner'
 order by created_at desc;
```

At most one version per family may be `active` — a unique index enforces it, so
a rollback cannot leave two.

---

## Withdrawing a research opportunity

Opportunities are the **mutable** surface. They are superseded, not deleted, so
a reader can always see what EdgeDesk said an hour ago and why it changed.

```sql
update tennis.research_opportunities
   set status = 'withdrawn', superseded_at = now()
 where match_ref = '<match>' and status = 'open';
```

---

## Undoing an import

An import is idempotent, so the usual answer is **re-import the corrected
file** — the match's identity is its draw slot, so corrections update in place.

To remove a specific run's rows entirely (rare, and only for a run that should
never have happened):

```sql
-- what did it touch?
select rows_read, rows_inserted, rows_rejected, scope, source_file, source_checksum
  from tennis.ingestion_runs where run_id = '<uuid>';

-- staging rows cascade with the run
delete from tennis.ingestion_runs where run_id = '<uuid>';
```

Deleting the run does **not** delete the matches it wrote — those are the record,
and another run may have touched them since. To remove matches, be explicit
about the scope and rebuild afterwards:

```sql
delete from tennis.matches where ingestion_run_id = '<uuid>' and tour = 'ATP' and season = 2026;
```

Then `npm run tennis:features:build && npm run tennis:ratings:build`.

---

## Uninstalling the contract

There is no down-migration, deliberately: the file is additive and every table
it creates is new except the columns it added to `tennis.tournaments`. To remove
it from a project that should never have had it:

```sql
-- the archive's rows out of the shared tournament table
delete from tennis.tournaments where provider = 'archive';

-- then the record layer (order matters: foreign keys)
drop view if exists tennis.match_context, tennis.board_current, tennis.board_research,
  tennis.board_public, tennis.player_profile, tennis.record_health,
  tennis.public_record_calibration, tennis.public_record_summary,
  tennis.h2h, tennis.player_form, tennis.player_surface, tennis.player_season,
  tennis.player_career, tennis.player_match_rows cascade;
drop table if exists tennis.prediction_record, tennis.research_opportunities,
  tennis.model_predictions, tennis.model_registry, tennis.odds_snapshots,
  tennis.weather_observations, tennis.player_ratings_current, tennis.rankings_current,
  tennis.player_match_features, tennis.matches, tennis.players, tennis.venues,
  tennis.stg_archive_matches, tennis.data_quality_issues, tennis.ingestion_runs,
  tennis.source_licenses cascade;

-- the columns added to the shared table
alter table tennis.tournaments
  drop column if exists season, drop column if exists surface_group,
  drop column if exists environment, drop column if exists venue_id,
  drop column if exists latitude, drop column if exists longitude,
  drop column if exists venue_confidence, drop column if exists source_key,
  drop column if exists source_version, drop column if exists ingestion_run_id;
```

The live match centre is untouched by all of it. Re-run
`supabase/tennis_live_center.sql` afterwards and read its report; every row
should still say `ok`.

---

## The website when the contract is gone

It degrades to what it was: the Tennis panel's record tabs render their honest
empty state, the Research board says no fixtures are on file and names the job
that would write them, and `record.html` says the tennis record could not be
read and names the migration. Nothing renders a zero where it means "absent".
