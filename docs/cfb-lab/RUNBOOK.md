# CFB Live Model Lab — runbook

How to set up, run, read and govern the Model Lab. Architecture: [`ARCHITECTURE.md`](ARCHITECTURE.md).
Definitions: [`METRICS.md`](METRICS.md). Tables: [`SCHEMA.md`](SCHEMA.md).

## One-time setup

1. **Postgres.** In the Supabase SQL editor, paste and run `supabase/cfb_lab.sql`, then
   `supabase/cfb_lab_cron.sql`. Both are idempotent and end in a report. (If the "Deploy intelligence"
   workflow carries an `apply_cfb_lab` input, dispatching it with that input does the same.)
2. **The GitHub token for the hourly poke.** `cfb_lab_cron.sql` uses the same Vault secret as the
   editorial dispatcher, `edgedesk_gh_token` (a fine-grained PAT on this repository with
   *Actions: read and write*). If editorial dispatch already works, nothing to add. Otherwise, once:
   `select vault.create_secret('<token>', 'edgedesk_gh_token', 'dispatches EdgeDesk workflows');`
   Check with `select * from public.cfb_lab_cron_status();`.
3. **Repository secrets** `SB_URL` and `SB_SERVICE_ROLE` (already used by other jobs). Without them the lab
   still runs: it skips the Odds API pull and the mirror, and says so in `last_run.json`.
4. **The capture function.** Redeploy `supabase/functions/capture/index.ts` so it forwards per-book
   college odds to `cfb_lab_ingest_quotes()`. It is on by default; `CAPTURE_CFB_LAB=false` turns it off.
   A missing function is reported under `cfb_lab` in the capture log and changes nothing else.
5. **Seed and backfill** (done once, already committed for 2026):
   ```
   node football/cfb_lab/governance.js seed
   node football/cfb_lab/backfill.js --season 2026
   node football/cfb_lab/run.js --offline
   ```

## The hourly job

`CFB Model Lab` (`.github/workflows/cfb-lab.yml`). It is dispatched at :07 by pg_cron, and GitHub's own
schedule at :37 (August–January) is the backup. Two runs never overlap. Manual dispatch modes:

| mode | what it does |
|---|---|
| `hourly` (default) | everything: market, checkpoints, settlement, reports, verify, publish, mirror |
| `report` | rebuild the reports and the public record from the ledger only |
| `verify` | check the committed ledger; publish nothing |

Locally: `npm run cfb:lab` (add `-- --offline` to skip the network, `-- --now 2026-10-03T18:00:00Z` to
run as of a time, `-- --skip settle,report` to skip steps).

**Health.** `football/cfb_lab/reports/<season>/last_run.json` lists every step with `ok`, its counts and
its duration; the internal page shows it at the top. A step that failed is also a failed workflow run
(the ledger is still published if it verifies, because a captured snapshot must not be lost).

## Reading it

- **Internal:** `/admin/cfb-lab/` (noindex). It computes nothing; it renders `lab.json`.
- **Weekly report:** `football/cfb_lab/reports/<season>/week_NN.md` / `.json`, written once, 48 h after
  the week's last kickoff, and never regenerated (a later correction appears in the next report and the
  season report, not by rewriting the old one).
- **Season report:** `reports/<season>/season.md` / `.json`, rebuilt every run.
- **Public:** the Model Lab section of `record.html` (`record/football/cfb_model_lab.json`): the
  champion's official predictions only, every graded game listed, losses included.

Every metric is shown with its sample size and a sample label; below 30 graded games it says *small
sample*. Do not read a small sample as a verdict.

## Weekly postmortem (§37 of the brief) — the routine

Once `week_NN.md` exists:

1. Read the summary and model-performance table. Compare to the season line, not to last week.
2. Read the miss reviews. Each has a class (MODEL FAILURE, DATA FAILURE, INFORMATION CHANGE,
   HIGH-VARIANCE, UNKNOWN) and the evidence for it. A class is a hypothesis, not a finding.
3. Look at the alerts. An alert is a reason to look, never a reason to change the model.
4. The research queue only adds an item when evidence clears its gate (n ≥ 50 and |z| ≥ 2). A single
   bad week never creates one.
5. Write nothing into the model. If a change is warranted, register an experiment (below).

## Governance

All of these append to `football/cfb_lab/governance/` and write an audit event. Commit the result.

```
# who is champion / challenger / candidate now
node football/cfb_lab/governance.js roles

# register an experiment: one change against a named baseline
node football/cfb_lab/governance.js experiment --id EXP-005 --name "..." \
  --baseline edgedesk_cfb_v2.1.0 --challenger <new model_version> \
  --hypothesis "..." --change "the one change" --metrics mae,brier,coverage_80 --actor <you>
#   --scope BUNDLE or ARCHITECTURE only when one change is genuinely impossible; the report marks it

# move an experiment: PLANNED -> RUNNING -> EVALUATED / ABANDONED
node football/cfb_lab/governance.js experiment-status --id EXP-005 --status EVALUATED --actor <you>

# promote a challenger (only after reports/<season>/promotion.json says ELIGIBLE — reviewed by a person)
node football/cfb_lab/governance.js promote --model edgedesk_cfb_v2.1.0 \
  --reason "promotion.json 2026: all gates passed on 163 common games" --actor <you> \
  --evidence football/cfb_lab/reports/2026/promotion.json

# retire a model (the champion cannot be retired; promote another first)
node football/cfb_lab/governance.js retire --model edgedesk_cfb_v2.0.0 --reason "..." --actor <you>

# release a live season to the development pool (refused until its promotion report exists)
node football/cfb_lab/governance.js release-partition --season 2026 --reason "..." --actor <you>
```

In Postgres, `select public.cfb_lab_set_role(model, label, role, reason, actor);` does the same for the
mirror's role table. The repository is the source of truth, so change the role there first.

**Promotion** (`cfb_lab_promotion_v1`): evaluated only on the common set of LIVE official games (≥ 150)
where both models have an official snapshot. Every gate must pass: the MAE difference's 95% CI is entirely
below zero; Brier ≤ the champion's; ECE ≤ champion + 0.01; 80% coverage in [0.75, 0.85]; P95 absolute
error ≤ champion + 1; weekly win share ≥ 60%. ROI and CLV are reported, never gating. ELIGIBLE never
changes the champion by itself.

**Contamination.** 2026 LIVE data is `live_observation_pool`: it may not be used to fit or tune until the
season is released. 2027 is the `future_holdout_pool`. `lab_core.canUseForTuning` answers the question in
code.

## When something goes wrong

| symptom | where to look | what to do |
|---|---|---|
| the job did not run this hour | Actions → CFB Model Lab; `select * from cfb_lab_cron_status()` | the :37 backup covers one miss; a missed window stays missed, and the report counts it (`checkpoint_missed`) |
| `ledger.js verify` failed | the failing step's output | something rewrote a committed line. Never "fix" the ledger by editing it: find the code that wrote it, revert that change, and let the next run append |
| quotes stale / data quality YELLOW or RED | `lab.json` → health → data_quality | a feed is down. RED games are forced to PASS and their confidence capped; nothing to do in the lab |
| Odds API events unmapped | `last_run.json` → market → supabase → `refusal_reasons`, `unresolved_names` | a team spelling the resolver does not know: add the alias to `football/fbs/fbs.js` TEAM_ALIASES (its tests guard the prefix trap) |
| a result disagreement | `last_run.json` → settle → `result_disagreements` | the game stays unsettled until the sources agree. Check both; a correction settles on the next run |
| a correction to a final score | nothing | the next run writes a new result that supersedes the old one; evaluations re-grade as new rows |
| the capture log shows `cfb_lab.errors` | the capture function's run log | `cfb_lab.sql` not applied, or the service key cannot call it; the board itself is unaffected |

## Tests

```
npm run cfb:lab:test          # all five suites
node football/cfb_lab/tests.js            # rules, ledger, market, grading, governance, end to end
node football/cfb_lab/capture_feed.test.js # the feed inside the capture function
node football/cfb_lab/sql.test.js          # the Postgres functions agree with the JavaScript
node football/cfb_lab/ui.test.js           # the internal page
node football/cfb_lab/record_section.test.js # the public record section
npm run cfb:lab:verify        # the committed ledger is intact
```

They run on every PR that touches the lab (`.github/workflows/cfb-lab-tests.yml`) and before every hourly
write.
