# Research engine — deployment and rollback

**Status (12 Oct 2026, late evening).**
- PRs #553, #554 and #555 are merged. Deploy intelligence run #20 (from `main`) deployed `edgedesk_ai-2026-10-12-r24-chain-findings` and applied `research_packets.sql`, `research_intel.sql` and `research_engine.sql`, every report row `ok`. The deploy doctor reads DEPLOYED and CURRENT; its only open item is the paused odds capture.
- Run #19, before it, had stopped in `research_intel.sql` on an older desk table named `research_findings` (`rememberSession()` in `edgedesk_ai`). PR #555 renamed the findings table `research_chain_findings`, added a preflight to both migrations that refuses before writing anything when a name they own is taken, and put a true description back on the older table.
- The follow-up after that (build `r25-stale-price-labels`) changes no table. It corrects what a research answer calls a price older than its limit: the first production answers showed a 55-hour-old quote as the "Verified market price" with a green EV beside it. See §3 for what a correct answer shows.

Every step below needs the owner's explicit go-ahead.

This document assumes nothing about production. Each step says how to check where production stands first, and works whether or not earlier phases (`supabase/research_intel.sql`, PR #551) were applied.

## 1. What ships, and how each part reaches production

| Part | How it reaches production | When |
|---|---|---|
| **Site:** `app.html`, `lib/edgedesk_intel_ui.js`, `lib/edgedesk_intel.css` and the other `lib/*` files | GitHub Pages serves the repository | **At merge to `main`.** The research script loads as `edgedesk_intel_ui.js?v=20261012ia9`, so browsers fetch the new file. |
| **Edge function** `edgedesk_ai`, build `edgedesk_ai-2026-10-12-r25-stale-price-labels` | `Deploy intelligence` workflow (`deploy_function`) | **Within about 6 h of merge, automatically.** The Intelligence doctor (`intelligence-doctor.yml`, 4× a day) deploys `edgedesk_ai` whenever production serves a build other than `main`'s. **Merging is therefore the decision to deploy the function.** |
| **Migration** `supabase/research_engine.sql` | `Deploy intelligence` workflow, `apply_research_engine` (needs the `SB_DB_URL` secret), or `psql` by hand | **Only when a person runs it.** The doctor never applies a migration. |
| **Migration** `supabase/research_intel.sql` (prerequisite, Phase 2) | the same workflow, `apply_research_intel` | only if it is not applied already (§2, step 1) |

**Nothing here turns on a paid service:**
- Paid search stays off: `EDGEDESK_RESEARCH_PAID_OK` unset, `EDGEDESK_SEARCH_PROVIDERS` empty, and the provider rows seeded `enabled = false`.
- Odds capture stays paused (`ODDS_RECOVERY.md`).

## 2. Deploying, in order

On a first release, apply the migrations **before** merging, so the function finds its tables the moment the doctor deploys it. (For this follow-up the order no longer matters; see step 4.)

The function still works without them:
- run-record writes fail quietly and the answer is served;
- the dollar-budget claim fails closed, which refuses paid search, already off by default.

Without the tables, though, nothing is recorded for grading.

### 1. Check production first

- `GET https://<project>.supabase.co/functions/v1/edgedesk_ai?probe=1` returns the serving build.
- In the SQL editor:
  ```sql
  select to_regclass('public.research_chain_findings') is not null as research_intel_applied,
         to_regclass('public.research_runs')           is not null as research_engine_applied,
         to_regclass('public.research_findings')       is not null as older_desk_findings_table;
  ```
  The last column is expected to be true in production. That table belongs to the matchup desk; leave it alone.

### 2. Apply `research_intel.sql`, if `research_intel_applied` is false

Run `Deploy intelligence` with only `apply_research_intel` ticked (untick `deploy_function`). It is:
- idempotent;
- additive;
- seeded with paid providers disabled.

Its last statement is a report: read any row that says `CHECK THIS`.

If it stops with `stopped before changing anything`, another table holds one of its names. Nothing was written. The message names the table and the columns it lacks; bring that to the owner rather than dropping anything.

`apply_research_intel` and `apply_research_engine` can be ticked in the same run: the workflow applies them in this order and stops at the first failure.

### 3. Apply `research_engine.sql`

Run `Deploy intelligence` with only `apply_research_engine` ticked. It:
- refuses to run before step 2;
- is idempotent and additive;
- creates `research_runs`, `research_run_outcomes`, `research_budget_policy`, `research_cost_ledger`, the claim/settle functions, the grading function and the calibration view;
- leaves every provider disabled.

Read the report rows at the end.

### 4. Merge this PR (the owner's decision)

Within about 6 h the doctor deploys the function (r24). To deploy it now instead, run `Deploy intelligence` with only `deploy_function`, from `main`.

Either order works now that r23 is live: until the tables exist, r23 and r24 both serve every answer and their memory writes fail quietly. The simplest path is one run of `Deploy intelligence` from `main` after the merge, with `deploy_function`, `apply_research_intel` and `apply_research_engine` ticked.

### 5. Verify (§3)

## 3. Verifying a deploy

| Check | Expected |
|---|---|
| `?probe=1` | `build` is `edgedesk_ai-2026-10-12-r25-stale-price-labels` |
| `node tools/intelligence/deploy_doctor.js` (with `SB_URL`, `SB_ANON`) | no `STALE` for `edgedesk_ai` |
| Ask, signed in: "What's the best bet this weekend across all sports?" | a plan, then streamed steps, then a result with `quant_verification.verdict = VERIFIED` |
| While odds capture is paused, the same answer's candidate card | "Verified market price: none current — last captured … min old against a … min limit"; "Estimated net EV: unavailable — no current price"; research freshness by publication time ("newest published … ago"), never "0 min ago" from a re-read |
| Ask: "Is <a starting QB this week> playing Sunday?" | an **Availability** card naming each source and its time; no model call (the answer's source line says no model wrote it) |
| Ask: "Best Premier League bet this weekend?" | "Soccer is not covered …", no pick |
| Ask: "When do <team> play <team>?" | the kickoff from the card |
| Function logs | `research_turn` events with `run_written: true` (after step 3), no `threw` lines |
| SQL | `select count(*) from research_runs where created_at > now() - interval '1 hour';` grows as research questions are asked |

## 4. Operator switches (no redeploy)

Set or unset these as function secrets (Supabase dashboard → Edge Functions → Secrets). They apply to new invocations.

| Switch | Default | Effect |
|---|---|---|
| `EDGEDESK_AVAILABILITY=0` | on | player-status questions go back to the routes that answered them before (the desk or the model) |
| `EDGEDESK_OUT_OF_SCOPE=0` | on | uncovered-sport, season-outcome and guarantee questions go back to the desk or the model |
| `EDGEDESK_RESEARCH_PAID_OK` | unset (off) | paid research is authorised only when `1` |
| `EDGEDESK_SEARCH_PROVIDERS` | empty | `claude_web_search` and/or `perplexity_search` |
| `EDGEDESK_PERPLEXITY_SCHEMA_VERIFIED` | unset | Perplexity is never called until `1`, after a live schema check |
| `EDGEDESK_RESEARCH_BUDGET_REQUEST_USD` / `_USER_DAY_USD` / `_DAY_USD` | 0.25 / 1 / 20 | local guards. The database's `research_budget_policy` is authoritative |
| `EDGEDESK_SEARCH_CONCURRENCY` · `EDGEDESK_RESEARCH_MAX_INFLIGHT` | 2 · 2 | search slots per isolate · research runs per subscriber |
| `EDGEDESK_RESEARCH_LOG=0` | on | mutes the structured `research_*` logs |

**Turning paid search on** takes all of the following:
1. a live verification run (`EDGEDESK_LIVE_PROVIDERS=1 node tools/research/providers_live.js`, with keys), approved first;
2. `EDGEDESK_SEARCH_PROVIDERS` and `EDGEDESK_RESEARCH_PAID_OK=1`;
3. `update research_provider_quota set enabled = true where provider = 'claude_web_search';`
4. room in `research_budget_policy`.

**Turning it off again** takes any one of: unset `EDGEDESK_RESEARCH_PAID_OK`; `update research_provider_quota set enabled = false …`; or `update research_budget_policy set global_daily_usd = 0;`.

## 5. Rollback

**The function and the site.** Revert the merge on `main` (`git revert -m 1 <merge commit>`, through a PR). Then:
1. Pages serves the previous site;
2. the doctor redeploys the previous function build within about 6 h. To do it at once, run `Deploy intelligence` (`deploy_function`) from `main`.

Check `?probe=1` shows the previous build (`edgedesk_ai-2026-10-12-r24-chain-findings`, or whatever `main` carries).

Do not redeploy an old build by hand while `main` still carries a newer one: the doctor would put it back within hours.

**Faster, partial rollback.** The switches in §4 turn the new routes off without a deploy.

**The migrations.** Nothing needs rolling back:
- They are additive. The previous function build never reads the new tables.
- Leaving them costs nothing.
- The run history is write-once by design and is the grading record.

**Only if the owner wants the tables gone.** This destroys the research run history, cannot be undone, and should be backed up first:

```sql
begin;
drop view if exists public.research_run_calibration;
drop table if exists public.research_cost_ledger, public.research_run_outcomes, public.research_runs, public.research_budget_policy cascade;
drop function if exists public.research_cost_claim(text, numeric), public.research_cost_settle(bigint, numeric, text), public.research_cost_committed(uuid),
  public.research_runs_grade(integer), public.research_engine_prune(integer), public.research_engine_immutable(), public.research_engine_no_delete(),
  public.research_runs_pregame(), public.research_outcome_after_start();
commit;
```

Check the function signatures with `\df public.research_*` before running it. Leave the two provider rows in `research_provider_quota` (disabled): `research_usage` rows reference them.

## 6. What not to do

- Do not merge expecting only the site to change: merging deploys the function (§1).
- Do not enable paid search or a provider row without the live verification run and the owner's approval.
- Do not re-enable odds capture as part of this release. It has its own runbook (`docs/odds-api-incident-2026-10/INCIDENT.md` §9) and proposal (`ODDS_RECOVERY.md`).
- Do not apply `research_engine.sql` before `research_intel.sql`. It refuses, and says why.
- Do not drop, rename or alter the older `research_findings` table. The matchup desk writes to it (`rememberSession()`), and nothing in this release needs it changed.
