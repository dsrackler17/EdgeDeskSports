# CFB Altitude & Travel — rollback

Today the module is SHADOW: it moves no published number, so there is nothing
to roll back in the numbers. This page is for the day it has been enabled, and
for removing it entirely. Fastest first.

## 1. The switch (seconds; reversible; audited)

```sql
select public.cfb_set_feature_flag('cfb_altitude_adjustment_enabled', false,
  '<your name>', 'altitude adjustment rolled back: <why>');
```

The next slate build (`football/fbs/build_coverage.js`, in
`football-enrichment.yml`, `football-weekly-build.yml` and `starter-context.yml`)
reads the flag as off. The engine's altitude term returns to SHADOW, and every
fair spread, win probability, EV and grade returns to V1's own number.

Already-published snapshots keep what they said, and their pregame records in
`cfb_altitude_shadow` keep `applied_points`. History is never rewritten
(`docs/cfb-production/ROLLBACK.md` §2).

To force the change without waiting for a build, run the slate build by hand
(`node football/fbs/build_coverage.js`) or re-run `football-enrichment.yml`.

## 2. The parameters (one commit)

Set the module back to research in code. Either:

- rerun `npm run cfb:altitude:research` on data where the gates fail, or
- revert the commit that last regenerated `football/altitude/params.js`.

`status` other than `VALIDATED`, or `points_applied: false`, is a lock that no
flag can open. The engine re-checks it on every projection.

## 3. The code (revert)

The integration points are all additive:

- the `altitude` term in `football/cfb_p4/engine.js`;
- `altitude_travel` on the slate row (`football/fbs/build_coverage.js`);
- `altitudeBlock` and `altitudeSection` in the snapshot and the page;
- `altitudeSituation` in `supabase/functions/edgedesk_ai/_lib.ts`;
- the `altitude` metric in `_cfb_explain.js`.

Reverting the change removes them. Snapshots built while it was live keep an
`altitude_travel` key that nothing reads. Two follow-ups:

- after reverting the edge-function sources, run `node tools/presentation/inline.js`;
- appending a PATCH row to `football/cfb_validation/versions.jsonl` is automatic
  on the next `football/cfb_validation/build.js` run.

## 4. The database (forward fix; removal only if retired)

CFB tables are append-only and are not rolled back. A bad row is superseded by a
new one (`docs/cfb-production/ROLLBACK.md` §3).

To take the module out entirely, run
[`supabase/altitude_shadow_rollback.sql`](../../supabase/altitude_shadow_rollback.sql).
It does two things:

- switches the flag off through the audited door (a flag is never deleted);
- drops the altitude tables, views and the append-only function.

**The pregame record is dropped with its table.** Export
`cfb_altitude_shadow`, `cfb_venue_elevation` and `cfb_altitude_validation_runs`
first if they matter. `football/altitude/sql.test.js` proves the file applies,
removes everything, leaves the flag off, and that the module re-applies cleanly
afterwards.

## 5. Monitoring after a rollback

`football/altitude/monitor.js` raises CRITICAL if any published game carries
altitude points while `params.js` is not VALIDATED, or if the section and the
engine disagree. After a rollback, its `slate.applied_games` must read 0.
