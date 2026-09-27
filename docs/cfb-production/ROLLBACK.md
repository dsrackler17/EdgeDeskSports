# CFB rollback

The previous champion stays available (V1 `edgedesk_cfb_p4_v1.0.0` is pinned
as the FALLBACK entry of compatibility.json and its board is rebuilt by the
Football weekly build), nothing append-only is ever deleted, and every rollback
is itself a recorded, audited act. For every release, the four rollbacks:

## 1. Code rollback

```sh
git revert <release commit>          # never force-push main; the scheduled jobs push to it
git push                             # (or a PR, merged)
node tools/cfb/release_check.js --skip-tests
```

The gate re-checks compatibility on the next scheduled run: reverted code with
the current artifacts either matches the pinned tuple (runs) or fails closed.

## 2. Model rollback

The production pathway serves V2.1 in shadow; V1 is the governance champion.

* **Take V2.1 out of the pathway now (no deploy):**
  ```sql
  select public.cfb_set_feature_flag('cfb_v21_pure_model_enabled', false, '<you>', '<why V2.1 is pulled>');
  select public.cfb_set_feature_flag('cfb_weekly_engine_enabled', false, '<you>', 'stop V2.1 refreshes while it is pulled');
  ```
  The gate skips the weekly engine (the last frozen snapshots stay, labelled);
  consumers fall to level 3 of the hierarchy (V1).
* **If V2.1 had been promoted:** a person restores V1 as champion through
  governance (the old champion is demoted in the same act, both audited):
  `node football/cfb_lab/governance.js promote --model edgedesk_cfb_p4_v1.0.0 --reason "rollback: <why>" --actor <name>`,
  then records it: `select public.cfb_audit('MODEL_ROLLBACK', 'edgedesk_cfb_p4_v1.0.0', '{"champion":"edgedesk_cfb_v2.1.0"}', '{"champion":"edgedesk_cfb_p4_v1.0.0"}', '<why>', '<name>');`
* **A bad artifact:** restore the pinned bytes from git — the manifest records
  each file's git blob: `git cat-file blob <git_blob> > <path>` for every entry
  of `artifact_hashes` that differs (`node football/cfb_production/manifest.js --check` lists them).

## 3. Database rollback, or forward fix

Every CFB table is append-only (or, for flags, changed only through an audited
function), and every migration is additive. There is no down-migration and
none is needed: an additive object that is unused is harmless.

* **A bad row** (provider error): `cfb_record_correction(...)` — the raw row
  stays, readers get the corrected value, the original is kept; undo with
  `cfb_revoke_correction(...)`.
* **A bad model output** (projection, decision): a new version of the output
  (new state_version / new projection with `supersedes`), never an edit.
* **A bad manifest / deployment**: record the previous system again as a new
  row that supersedes the bad one:
  `node football/cfb_production/manifest.js --push --supersedes <bad manifest_id> --reason "rollback to <commit>"`
  (run from a checkout of the previous commit; the table refuses a rollback row
  without a reason; the insert writes `MODEL_ROLLBACK` to the audit log).
* **A bad migration object**: forward-fix with `create or replace` in the file,
  re-applied; never `drop ... cascade` on a live table.

## 4. Feature-flag reversal

Any switch is reversed the same way it was made, with a reason:

```sql
select flag, enabled, updated_by, reason, updated_at from public.cfb_feature_flags order by flag;
select public.cfb_set_feature_flag('<flag>', <true|false>, '<you>', '<why>');
select event_type, subject, before, after, actor, reason, created_at from public.cfb_audit_log
 where event_type in ('FEATURE_FLAG_CHANGE','MODEL_ROLLBACK','MANIFEST_RECORDED') order by chain_seq desc limit 20;
select public.cfb_audit_verify();   -- the chain still verifies
```

Betting (`cfb_bet_actionable_enabled`) can always be switched **off**; it can be
switched on only by a person, with evidence, while the manifest's decision
policy has betting enabled — never as part of a rollback.

## 5. Rollback readiness (checked by the release checklist, item 9)

V1 present and pinned as FALLBACK; this document present; a previous committed
manifest to return to (the first release's rollback target is V1 itself); the
manifest's fallback hierarchy recorded.
